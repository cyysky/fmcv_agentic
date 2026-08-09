import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { WebService } from './web.service';

function configService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

/** Minimal fake WebSocket that auto-opens and answers CDP messages. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static pageStates: Record<string, unknown>[] = [];
  url: string;
  readyState = 0;
  private listeners = new Map<string, Set<(e?: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.emit('open', {});
    }, 0);
  }

  addEventListener(type: string, fn: (e?: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  send(raw: string): void {
    const msg = JSON.parse(raw) as {
      id: number;
      method: string;
      params: Record<string, unknown>;
    };
    if (msg.method === 'Page.enable') {
      this.respond(msg.id, {});
      return;
    }
    if (msg.method === 'Runtime.evaluate') {
      const state = FakeWebSocket.pageStates.shift() ?? {
        title: 'Example',
        href: 'https://example.com/',
        ready: 'complete',
        text: 'Hello from CDP page',
      };
      // Real Chrome wraps the evaluated value in `result.value`; keep the
      // fake honest so the real CDP path cannot silently diverge from tests.
      this.respond(msg.id, { result: { type: 'object', value: state } });
      return;
    }
    this.respond(msg.id, {});
  }

  close(): void {
    this.readyState = 3;
    this.emit('close', {});
  }

  private respond(id: number, result: Record<string, unknown>): void {
    setTimeout(() => {
      this.emit('message', { data: JSON.stringify({ id, result }) });
    }, 0);
  }

  private emit(type: string, e: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }
}

describe('WebService', () => {
  let realFetch: typeof fetch;
  let realWebSocket: typeof WebSocket;

  beforeEach(() => {
    realFetch = global.fetch;
    realWebSocket = global.WebSocket;
    global.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    FakeWebSocket.instances = [];
    FakeWebSocket.pageStates = [];
  });

  afterEach(() => {
    global.fetch = realFetch;
    global.WebSocket = realWebSocket;
  });

  it('rejects non-http(s) and empty web-search requests', async () => {
    const svc = new WebService(configService());
    const bad = await svc.fetchUrl('ftp://example.com/file');
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Only absolute http(s)');

    const noQuery = await svc.webSearch('   ');
    expect(noQuery.ok).toBe(false);
    expect(noQuery.error).toContain('non-empty string');
  });

  it('falls back to native fetch when local CDP is unreachable and strips markup', async () => {
    // An unused port: bind, note the port, release it — CDP connect must fail.
    const cdp = createServer();
    await new Promise<void>((r) => cdp.listen(0, '127.0.0.1', () => r()));
    const cdpPort = (cdp.address() as AddressInfo).port;
    await new Promise<void>((r) => cdp.close(() => r()));

    const html =
      '<html><body><h1>Native page</h1><p>Hello &amp; goodbye</p></body></html>';
    let target: Server | null = null;
    try {
      target = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(html);
      });
      await new Promise<void>((r) => target!.listen(0, '127.0.0.1', () => r()));
      const targetPort = (target.address() as AddressInfo).port;
      const svc = new WebService(
        configService({
          WEB_CDP_HOST: '127.0.0.1',
          WEB_CDP_PORT: String(cdpPort),
        }),
      );
      const result = await svc.fetchUrl(`http://127.0.0.1:${targetPort}/page`);
      expect(result.ok).toBe(true);
      expect(result.via).toBe('http');
      expect(result.status).toBe(200);
      expect(result.text).toContain('Native page');
      expect(result.text).toContain('Hello & goodbye');
    } finally {
      await new Promise<void>((r) => target?.close(() => r()));
    }
  });

  it('uses the local CDP browser first when /json endpoints respond', async () => {
    FakeWebSocket.pageStates = [
      { title: '', href: 'https://example.com', ready: 'loading', text: '' },
      {
        title: 'Example Domain',
        href: 'https://example.com/',
        ready: 'complete',
        text: 'Hello from CDP page',
      },
    ];
    global.fetch = jest.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/json/version')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.includes('/json/new?')) {
        return {
          ok: true,
          json: async () => ({
            id: 'tab-round121',
            url: 'https://example.com',
            // Chrome advertises the loopback URL it actually bound; the service
            // must rewrite it to the configured CDP endpoint so containers can
            // reach it through the relay / host-gateway.
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/round121',
          }),
        } as unknown as Response;
      }
      if (url.includes('/json/close/')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const svc = new WebService(
      configService({
        WEB_CDP_HOST: 'host.docker.internal',
        WEB_CDP_PORT: '9222',
      }),
    );
    const result = await svc.fetchUrl('https://example.com');
    expect(result.ok).toBe(true);
    expect(result.via).toBe('cdp');
    expect(result.url).toBe('https://example.com/');
    expect(result.text).toBe('Hello from CDP page');
    expect(result.title).toBe('Example Domain');
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0].url).toBe(
      'ws://host.docker.internal:9222/devtools/page/round121',
    );
    expect(FakeWebSocket.instances[0].readyState).toBe(3); // closed after use
  });

  it('webSearch falls back to Bing RSS when DuckDuckGo bot-blocks', async () => {
    FakeWebSocket.pageStates = [
      {
        title: 'DuckDuckGo',
        href: 'https://html.duckduckgo.com/html/?q=OpenAI',
        ready: 'complete',
        text:
          '\nDuckDuckGo\n\n\nUnfortunately, bots use DuckDuckGo too.\n' +
          'Please complete the following challenge to confirm this search ' +
          'was made by a human.\nSelect all squares containing a duck:\nSubmit\n',
      },
      {
        title: 'OpenAI - Search',
        href: 'https://www.bing.com/search?q=OpenAI&format=rss',
        ready: 'complete',
        text:
          '<rss><channel><title>Bing: OpenAI</title>' +
          '<item><title>OpenAI | Research &amp; Deployment</title>' +
          '<link>https://openai.com/</link></item></channel></rss>',
      },
    ];
    const newTabUrls: string[] = [];
    global.fetch = jest.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/json/version') || url.includes('/json/close/')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.includes('/json/new?')) {
        newTabUrls.push(decodeURIComponent(url));
        return {
          ok: true,
          json: async () => ({
            id: 'tab-search',
            url: 'about:blank',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/search',
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const svc = new WebService(
      configService({
        WEB_CDP_HOST: 'host.docker.internal',
        WEB_CDP_PORT: '9222',
      }),
    );
    const result = await svc.webSearch('OpenAI');
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('bing');
    expect(result.via).toBe('cdp');
    expect(result.text).toContain('Bing: OpenAI');
    expect(result.text).toContain('OpenAI | Research &amp; Deployment');
    expect(FakeWebSocket.instances.length).toBe(2); // DDG attempt + Bing retry
    expect(newTabUrls[0]).toContain('html.duckduckgo.com');
    expect(newTabUrls[1]).toContain('www.bing.com/search?q=OpenAI&format=rss');
  });

  it('webSearch keeps the DuckDuckGo result when it is not bot-blocked', async () => {
    FakeWebSocket.pageStates = [
      {
        title: 'DuckDuckGo',
        href: 'https://html.duckduckgo.com/html/?q=NestJS',
        ready: 'complete',
        text: 'NestJS - A progressive Node.js framework\n\nOfficial docs result',
      },
    ];
    const newTabUrls: string[] = [];
    global.fetch = jest.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/json/version') || url.includes('/json/close/')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      if (url.includes('/json/new?')) {
        newTabUrls.push(decodeURIComponent(url));
        return {
          ok: true,
          json: async () => ({
            id: 'tab-search',
            url: 'about:blank',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9223/devtools/page/search',
          }),
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const svc = new WebService(
      configService({
        WEB_CDP_HOST: 'host.docker.internal',
        WEB_CDP_PORT: '9222',
      }),
    );
    const result = await svc.webSearch('NestJS');
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('duckduckgo');
    expect(result.text).toContain('NestJS - A progressive Node.js framework');
    expect(FakeWebSocket.instances.length).toBe(1); // no Bing retry
    expect(newTabUrls).toHaveLength(1);
    expect(newTabUrls[0]).toContain('html.duckduckgo.com');
  });

  it('reports the failure when CDP and native fetch both fail', async () => {
    const cdp = createServer();
    await new Promise<void>((r) => cdp.listen(0, '127.0.0.1', () => r()));
    const cdpPort = (cdp.address() as AddressInfo).port;
    await new Promise<void>((r) => cdp.close(() => r()));

    global.fetch = jest.fn(async () => {
      throw new Error('network down');
    });
    const svc = new WebService(
      configService({
        WEB_CDP_HOST: '127.0.0.1',
        WEB_CDP_PORT: String(cdpPort),
      }),
    );
    const result = await svc.fetchUrl('https://example.com');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP fetch failed');
  });
});
