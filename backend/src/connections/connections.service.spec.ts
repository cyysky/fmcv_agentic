import { NotFoundException } from '@nestjs/common';
import { ConnectionsService, ConnectionTestResult } from './connections.service';

/** Minimal Prisma double with just the rows this service touches. */
function prismaDouble(conn: unknown) {
  return {
    connection: {
      findUnique: jest.fn().mockResolvedValue(conn),
      create: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      delete: jest.fn(),
      update: jest.fn(),
    },
  } as never;
}

const ROW = {
  id: 'conn-1',
  displayName: 'Test provider',
  baseUrl: 'http://127.0.0.1:9876/v1',
  modelName: 'probe-model',
  contextLength: 128000,
  concurrentConnections: 10,
  apiKey: 'sk-probe-secret',
  defaultParameters: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('ConnectionsService.test()', () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.CONNECTION_TEST_TIMEOUT_MS;

  beforeAll(() => {
    process.env.CONNECTION_TEST_TIMEOUT_MS = '2000';
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalTimeout === undefined) delete process.env.CONNECTION_TEST_TIMEOUT_MS;
    else process.env.CONNECTION_TEST_TIMEOUT_MS = originalTimeout;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('reports a reachable endpoint as OK with status and latency', async () => {
    let sent: RequestInit | undefined;
    let sentUrl = '';
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      sent = init;
      return new Response('{"choices":[{"message":{"content":"pong"}}]}', {
        status: 200,
      });
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result: ConnectionTestResult = await service.test('conn-1');

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.model).toBe('probe-model');
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(sentUrl).toBe('http://127.0.0.1:9876/v1/chat/completions');
    const body = JSON.parse(String(sent?.body));
    expect(body.model).toBe('probe-model');
    expect(body.max_tokens).toBe(1);
    expect((sent?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-probe-secret',
    );
  });

  it('reports non-2xx upstream responses as a failed probe', async () => {
    global.fetch = jest.fn(async () => {
      return new Response('{"error":"bad key"}', { status: 401 });
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result = await service.test('conn-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain('HTTP 401');
    expect(result.message).toContain('bad key');
  });

  it('converts network errors into a friendly failed result', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('fetch failed');
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result = await service.test('conn-1');

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.message).toContain('Connection failed');
    expect(result.message).toContain('fetch failed');
  });

  it('reports abort as a timeout instead of a raw error', async () => {
    global.fetch = jest.fn(async () => {
      const err = new Error('This operation was aborted') as Error & { name: string };
      err.name = 'AbortError';
      throw err;
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result = await service.test('conn-1');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('throws NotFoundException for an unknown connection', async () => {
    const service = new ConnectionsService(prismaDouble(null));
    await expect(service.test('missing')).rejects.toThrow(NotFoundException);
  });
});
