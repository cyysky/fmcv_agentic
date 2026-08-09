import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Result of one web fetch/search attempt (DIRECTION items 1 + 4). */
export interface FetchResult {
  ok: boolean;
  /** How the result was produced: local CDP browser first, native HTTP fallback. */
  via: 'cdp' | 'http';
  url: string;
  /** HTTP status when known (CDP navigation reports 200 on success). */
  status: number | null;
  title?: string;
  /** Page text (CDP innerText / stripped-HTML fallback), capped. */
  text: string;
  error?: string;
}

const DEFAULT_CDP_HOST = '127.0.0.1';
const DEFAULT_CDP_PORT = 9222;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Minimal CDP session over the page's WebSocket debugger URL. Uses the
 * global WebSocket available since Node 22 — no puppeteer dependency.
 */
class CdpSession {
  private ws: WebSocket | null = null;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly wsUrl: string,
    private readonly timeoutMs: number,
  ) {}

  private onMessage(e: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(e.data)) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = msg.id;
    if (id !== undefined && id !== null && this.pending.has(Number(id))) {
      const { resolve, reject } = this.pending.get(Number(id)) as NonNullable<
        ReturnType<CdpSession['pending']['get']>
      >;
      this.pending.delete(Number(id));
      if (msg.error) {
        reject(new Error(String((msg.error as { message?: string }).message ?? 'CDP error')));
      } else {
        resolve((msg.result as Record<string, unknown>) ?? msg);
      }
    }
  }

  async open(): Promise<void> {
    if (this.ws) return;
    await new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (err) {
        reject(new Error(`CDP websocket connect failed: ${(err as Error).message}`));
        return;
      }
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('CDP websocket open timed out'));
      }, this.timeoutMs);
      ws.addEventListener('message', (e) => this.onMessage(e as MessageEvent));
      ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          this.ws = ws;
          resolve();
        },
        { once: true },
      );
      ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('CDP websocket error'));
        },
        { once: true },
      );
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    if (!this.ws) return Promise.reject(new Error('CDP session not open'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.ws!.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`CDP ${method} send failed: ${(err as Error).message}`));
      }
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }
}

/**
 * Web access for agent turns (DIRECTION items 1 + 4).
 *
 * Strategy: try the local CDP Chrome on port 9222 first (open the URL in a
 * fresh tab, read the rendered `innerText`), then fall back to the native
 * Node fetch. Both paths share a timeout and a text cap so agent turns never
 * hang on a page or ship megabytes of markup into the model context.
 */
@Injectable()
export class WebService {
  private readonly logger = new Logger(WebService.name);
  private readonly cdpHost: string;
  private readonly cdpPort: number;
  private readonly timeoutMs: number;
  private readonly textCap: number;

  constructor(config: ConfigService) {
    this.cdpHost =
      config.get<string>('WEB_CDP_HOST', DEFAULT_CDP_HOST) ?? DEFAULT_CDP_HOST;
    this.cdpPort =
      Number(config.get<string>('WEB_CDP_PORT', String(DEFAULT_CDP_PORT))) ||
      DEFAULT_CDP_PORT;
    this.timeoutMs =
      Number(config.get<string>('WEB_FETCH_TIMEOUT_MS', '30000')) || 30000;
    this.textCap = Number(config.get<string>('WEB_TEXT_CAP', '8000')) || 8000;
  }

  get cdpBase(): string {
    return `http://${this.cdpHost}:${this.cdpPort}`;
  }

  /** Fetch one http(s) URL, CDP-first with a native-fetch fallback. */
  async fetchUrl(rawUrl: string): Promise<FetchResult> {
    const url = this.parseHttpUrl(rawUrl);
    if (!url) {
      return {
        ok: false,
        via: 'http',
        url: typeof rawUrl === 'string' ? rawUrl : '',
        status: null,
        text: '',
        error: 'Only absolute http(s) URLs are supported',
      };
    }
    try {
      return await this.fetchViaCdp(url.href);
    } catch (err) {
      this.logger.warn(
        `CDP fetch failed (${(err as Error).message}); falling back to native fetch`,
      );
    }
    try {
      return await this.fetchViaHttp(url.href);
    } catch (err) {
      return {
        ok: false,
        via: 'http',
        url: url.href,
        status: null,
        text: '',
        error: `HTTP fetch failed: ${(err as Error).message}`,
      };
    }
  }

  /** Web search: DuckDuckGo HTML results rendered through the same pipeline. */
  async webSearch(query: string): Promise<FetchResult> {
    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) {
      return {
        ok: false,
        via: 'http',
        url: '',
        status: null,
        text: '',
        error: 'Search query must be a non-empty string',
      };
    }
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
    return this.fetchUrl(url);
  }

  /* ------------------------------ internals ------------------------------ */

  private parseHttpUrl(raw: string): URL | null {
    try {
      const url = new URL(raw);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
    } catch {
      return null;
    }
  }

  private async cdpJson(
    path: string,
    method = 'GET',
  ): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.cdpBase}${path}`, { method });
    if (!res.ok) {
      throw new Error(`CDP ${method} ${path} -> HTTP ${res.status}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  /** Render a URL in a fresh CDP tab and read its body text. */
  private async fetchViaCdp(url: string): Promise<FetchResult> {
    await this.cdpJson('/json/version');
    const target = (await this.cdpJson(
      `/json/new?${encodeURIComponent(url)}`,
      'PUT',
    )) as { id: string; url: string; webSocketDebuggerUrl: string };
    let session: CdpSession | null = null;
    try {
      session = new CdpSession(target.webSocketDebuggerUrl, this.timeoutMs);
      await session.open();
      await session.send('Page.enable');
      const deadline = Date.now() + this.timeoutMs;
      let last: Record<string, unknown> | null = null;
      while (Date.now() < deadline) {
        await delay(250);
        const res = await session.send('Runtime.evaluate', {
          expression: `(() => ({ title: document.title, href: location.href, ready: document.readyState, text: (document.body ? document.body.innerText : '').slice(0, ${this.textCap}) }))()`,
          returnByValue: true,
        });
        const value = res.value;
        if (value && typeof value === 'object') {
          last = value as Record<string, unknown>;
          const text = String(last.text ?? '');
          const ready = String(last.ready ?? '');
          if (ready === 'complete' && (text.trim() !== '' || last.title)) break;
        }
      }
      if (!last) {
        throw new Error('CDP page never produced readable content');
      }
      return {
        ok: true,
        status: 200,
        via: 'cdp',
        url: String(last.href || url),
        title: last.title ? String(last.title) : undefined,
        text: String(last.text ?? ''),
      };
    } finally {
      if (session) session.close();
      await this.cdpJson(
        `/json/close/${encodeURIComponent(target.id)}`,
        'GET',
      ).catch(() => undefined);
    }
  }

  /** Native-fetch fallback (used only when CDP is unavailable/fails). */
  private async fetchViaHttp(url: string): Promise<FetchResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
        headers: {
          'user-agent':
            'Mozilla/5.0 (compatible; fmcv-agent-web/1.0; +agent web tool)',
        },
      });
      const raw = await res.text();
      return {
        ok: res.ok,
        status: res.status,
        via: 'http',
        url: res.url || url,
        text: this.stripHtml(raw).slice(0, this.textCap),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
