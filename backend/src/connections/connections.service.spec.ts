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
    // Latency/status are structured fields; the UI composes them after the
    // message so nothing is duplicated in the rendered probe result.
    expect(result.message).toBe('Connected — probe-model responded.');
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

describe('ConnectionsService.testDraft()', () => {
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

  it('probes entered values with the entered key without touching the DB', async () => {
    let sentUrl = '';
    let sent: RequestInit | undefined;
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      sent = init;
      return new Response('{"choices":[{"message":{"content":"pong"}}]}', {
        status: 200,
      });
    }) as never;

    // A null prisma double proves testDraft never reads the database.
    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.testDraft({
      baseUrl: 'http://127.0.0.1:4567/v1/',
      modelName: 'draft-model',
      apiKey: 'sk-draft-secret',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.model).toBe('draft-model');
    expect(sentUrl).toBe('http://127.0.0.1:4567/v1/chat/completions'); // trailing slash normalized
    const body = JSON.parse(String(sent?.body));
    expect(body.model).toBe('draft-model');
    expect(body.max_tokens).toBe(1);
    expect((sent?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-draft-secret',
    );
  });

  it('omits the authorization header when no key is entered', async () => {
    let sent: RequestInit | undefined;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = init;
      return new Response('{"choices":[]}', { status: 200 });
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.testDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
      modelName: 'draft-model',
    });

    expect(result.ok).toBe(true);
    expect(
      (sent?.headers as Record<string, string>).authorization ?? null,
    ).toBeNull();
  });

  it('reports non-2xx upstream responses for draft values', async () => {
    global.fetch = jest.fn(async () => {
      return new Response('{"error":"bad key"}', { status: 401 });
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.testDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
      modelName: 'draft-model',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toContain('HTTP 401');
  });

  it('converts network errors into a friendly failed result', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('fetch failed');
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.testDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
      modelName: 'draft-model',
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBeUndefined();
    expect(result.message).toContain('Connection failed');
    expect(result.message).toContain('fetch failed');
  });
});

describe('ConnectionsService apiKey normalization', () => {
  function updateDouble() {
    return {
      connection: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ ...ROW, apiKey: null }),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...ROW, apiKey: null }),
      },
    } as never;
  }

  it('stores null instead of an empty string when the key is cleared on update', async () => {
    const prisma = updateDouble() as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.update('conn-1', { apiKey: '' });

    const data = prisma.connection.update.mock.calls[0][0].data;
    expect(data.apiKey).toBeNull();
  });

  it('stores a non-empty key when one is provided on update', async () => {
    const prisma = updateDouble() as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.update('conn-1', { apiKey: 'sk-new-key' });

    const data = prisma.connection.update.mock.calls[0][0].data;
    expect(data.apiKey).toBe('sk-new-key');
  });

  it('stores null when an empty key is entered on create', async () => {
    const prisma = updateDouble() as unknown as {
      connection: { create: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.create({
      displayName: 'no-key',
      baseUrl: 'http://127.0.0.1:1/v1',
      modelName: 'probe-model',
      contextLength: 128000,
      apiKey: '',
    });

    const data = prisma.connection.create.mock.calls[0][0].data;
    expect(data.apiKey).toBeNull();
  });
});

describe('ConnectionsService models normalization', () => {
  function modelsDouble() {
    return {
      connection: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ ...ROW, models: [] }),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        delete: jest.fn(),
        update: jest.fn().mockResolvedValue({ ...ROW, models: [] }),
      },
    } as never;
  }

  it('trims, drops blanks, and de-dupes the model list on create', async () => {
    const prisma = modelsDouble() as unknown as {
      connection: { create: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.create({
      displayName: 'list-provider',
      baseUrl: 'http://127.0.0.1:1/v1',
      modelName: 'default-model',
      contextLength: 128000,
      models: ['  llama-3.1-70b ', '', 'llama-3.1-70b', ' mixtral-8x7b '],
    });

    const data = prisma.connection.create.mock.calls[0][0].data;
    expect(data.models).toEqual(['llama-3.1-70b', 'mixtral-8x7b']);
  });

  it('clears the stored list when update receives an empty array', async () => {
    const prisma = modelsDouble() as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.update('conn-1', { models: [] });

    const data = prisma.connection.update.mock.calls[0][0].data;
    expect(data.models).toEqual([]);
  });

  it('omits the models key entirely when the field is not provided', async () => {
    const prisma = modelsDouble() as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.update('conn-1', { displayName: 'renamed' });

    const data = prisma.connection.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('models');
  });
});
