import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import { ConfigService } from '@nestjs/config';
import { FetchResult, WebService } from './web.service';

function configService(values: Record<string, string> = {}): ConfigService {
  return {
    get: (key: string, def?: string) => values[key] ?? def,
  } as unknown as ConfigService;
}

type WsEvent = { data?: string };

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

  addEventListener(
    type: string,
    fn: (e?: unknown) => void,
    _opts?: { once?: boolean },
  ): void {
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
      this.respond(msg.id, { value: state });
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
    const bad = (await svc.fetchUrl('ftp://example.com/file')) as FetchResult;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('Only absolute http(s)');

    const noQuery = (await svc.webSearch('   ')) as FetchResult;
    expect(noQuery.ok).toBe(false);
    expect(noQuery.error).toContain('non-empty string');
  });

  it('falls back to native fetch when local CDP is unreachable and strips markup', async () => {
    // An unused port: bind, note the port, release it — CDP connect must fail.
    const cdp = createServer();
    await new Promise<void>((r) => cdp.listen(0, '127.0.0.1', () => r()));
    const cdpPort = (cdp.address() as AddressInfo).port;
    await new Promise<void>((r) => cdp.close(() => r()));

    const html = '<html><body><h1>Native page</h1><p>Hello &amp; goodbye</p></body></html>';
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
      const result = (await svc.fetchUrl(
        `http://127.0.0.1:${targetPort}/page`,
      )) as FetchResult;
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
    global.fetch = jest.fn(async (input: RequestInfo | URL) => {
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
            webSocketDebuggerUrl: 'ws://fake-cdp/round121',
          }),
        } as unknown as Response;
      }
      if (url.includes('/json/close/')) {
        return { ok: true, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const svc = new WebService(
      configService({ WEB_CDP_HOST: '127.0.0.1', WEB_CDP_PORT: '9222' }),
    );
    const result = (await svc.fetchUrl('https://example.com')) as FetchResult;
    expect(result.ok).toBe(true);
    expect(result.via).toBe('cdp');
    expect(result.url).toBe('https://example.com/');
    expect(result.text).toBe('Hello from CDP page');
    expect(result.title).toBe('Example Domain');
    expect(FakeWebSocket.instances.length).toBe(1);
    expect(FakeWebSocket.instances[0]!.readyState).toBe(3); // closed after use
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
    const result = (await svc.fetchUrl('https://example.com')) as FetchResult;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP fetch failed');
  });
});
