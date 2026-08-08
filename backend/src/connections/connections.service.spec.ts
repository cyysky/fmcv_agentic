import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  ConnectionsService,
  ConnectionTestResult,
} from './connections.service';

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
    if (originalTimeout === undefined)
      delete process.env.CONNECTION_TEST_TIMEOUT_MS;
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
    expect(typeof sent?.body).toBe('string');
    const body = JSON.parse(sent?.body as string) as {
      model: string;
      max_tokens: number;
    };
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
      const err = new Error('This operation was aborted') as Error & {
        name: string;
      };
      err.name = 'AbortError';
      throw err;
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result = await service.test('conn-1');

    expect(result.ok).toBe(false);
    expect(result.message).toContain('timed out');
  });

  it('persists the last-known probe on success so reloads keep health', async () => {
    global.fetch = jest.fn(async () => {
      return new Response('{"choices":[{"message":{"content":"pong"}}]}', {
        status: 200,
      });
    }) as never;

    const prisma = prismaDouble(ROW) as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    const result = await service.test('conn-1');

    expect(result.ok).toBe(true);
    expect(prisma.connection.update).toHaveBeenCalledTimes(1);
    const call = prisma.connection.update.mock.calls[0][0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: 'conn-1' });
    expect(call.data.lastProbeOk).toBe(true);
    expect(call.data.lastProbeStatus).toBe(200);
    expect(call.data.lastProbeLatencyMs).toBeGreaterThanOrEqual(0);
    expect(call.data.lastProbeModel).toBe('probe-model');
    expect(call.data.lastProbeMessage).toContain('responded');
    expect(call.data.lastProbeAt).toBeInstanceOf(Date);
  });

  it('persists failed probes (status included) as the last-known result', async () => {
    global.fetch = jest.fn(async () => {
      return new Response('{"error":"bad key"}', { status: 401 });
    }) as never;

    const prisma = prismaDouble(ROW) as unknown as {
      connection: { update: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    const result = await service.test('conn-1');

    expect(result.ok).toBe(false);
    const call = prisma.connection.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(call.data.lastProbeOk).toBe(false);
    expect(call.data.lastProbeStatus).toBe(401);
    expect(String(call.data.lastProbeMessage)).toContain('401');
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
    if (originalTimeout === undefined)
      delete process.env.CONNECTION_TEST_TIMEOUT_MS;
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
    expect(typeof sent?.body).toBe('string');
    const body = JSON.parse(sent?.body as string) as {
      model: string;
      max_tokens: number;
    };
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

describe('ConnectionsService model discovery (GET /models)', () => {
  const originalFetch = global.fetch;
  const originalTimeout = process.env.CONNECTION_TEST_TIMEOUT_MS;

  beforeAll(() => {
    process.env.CONNECTION_TEST_TIMEOUT_MS = '2000';
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalTimeout === undefined)
      delete process.env.CONNECTION_TEST_TIMEOUT_MS;
    else process.env.CONNECTION_TEST_TIMEOUT_MS = originalTimeout;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function modelsResponse(ids: string[]) {
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('fetchModelsDraft GETs {baseUrl}/models and returns deduped ids', async () => {
    let sentUrl = '';
    let sent: RequestInit | undefined;
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      sent = init;
      return modelsResponse(['llama-3.1-70b', 'mixtral-8x7b', 'LLAMA-3.1-70B']);
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1/',
      apiKey: 'sk-draft-secret',
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    // Case-insensitive dedupe keeps the first-seen casing.
    expect(result.models).toEqual(['llama-3.1-70b', 'mixtral-8x7b']);
    expect(sentUrl).toBe('http://127.0.0.1:4567/v1/models');
    expect((sent?.headers as Record<string, string>).authorization).toBe(
      'Bearer sk-draft-secret',
    );
  });

  it('omits the authorization header when no key is entered', async () => {
    let sent: RequestInit | undefined;
    global.fetch = jest.fn(async (_url: unknown, init?: RequestInit) => {
      sent = init;
      return modelsResponse(['gpt-4o']);
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
    });

    expect(result.ok).toBe(true);
    expect(
      (sent?.headers as Record<string, string>).authorization ?? null,
    ).toBeNull();
  });

  it('caps the list at 50 ids and flags truncation', async () => {
    // 60 raw ids: 55 unique + 5 case-duplicates; normalized to 55, capped to 50.
    const raw: string[] = [];
    for (let i = 0; i < 55; i++) raw.push(`model-${i}`);
    for (let i = 0; i < 5; i++) raw.push(`MODEL-${i}`);
    global.fetch = jest.fn(async () => modelsResponse(raw)) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
    });

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.models).toHaveLength(50);
    expect(result.message).toContain('Fetched 50 models');
  });

  it('reports non-2xx model-list responses with the upstream status', async () => {
    global.fetch = jest.fn(async () => {
      return new Response('{"error":"no models endpoint"}', { status: 404 });
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const result = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
    });

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.status).toBe(404);
    expect(result.message).toContain('HTTP 404');
    expect(result.message).toContain('no models endpoint');
  });

  it('handles network errors and unreadable bodies gracefully', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('fetch failed');
    }) as never;

    const service = new ConnectionsService(prismaDouble(null));
    const net = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
    });
    expect(net.ok).toBe(false);
    expect(net.message).toContain('Connection failed');
    expect(net.message).toContain('fetch failed');

    global.fetch = jest.fn(async () => {
      return new Response('<html>not json</html>', { status: 200 });
    }) as never;
    const bad = await service.fetchModelsDraft({
      baseUrl: 'http://127.0.0.1:4567/v1',
    });
    expect(bad.ok).toBe(false);
    expect(bad.models).toEqual([]);
    expect(bad.message).toContain('not a JSON model list');
  });

  it('fetchModels(id) uses the stored connection + stored key', async () => {
    let sentUrl = '';
    let auth: string | undefined;
    global.fetch = jest.fn(async (url: unknown, init?: RequestInit) => {
      sentUrl = String(url);
      auth = (init?.headers as Record<string, string>)?.authorization;
      return modelsResponse(['stored-model']);
    }) as never;

    const service = new ConnectionsService(prismaDouble(ROW));
    const result = await service.fetchModels('conn-1');

    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['stored-model']);
    expect(sentUrl).toBe('http://127.0.0.1:9876/v1/models');
    expect(auth).toBe('Bearer sk-probe-secret');
  });

  it('throws NotFoundException when fetching models for an unknown connection', async () => {
    const service = new ConnectionsService(prismaDouble(null));
    await expect(service.fetchModels('missing')).rejects.toThrow(
      NotFoundException,
    );
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

  it('de-dupes model ids case-insensitively (first-seen casing wins)', async () => {
    const prisma = modelsDouble() as unknown as {
      connection: { create: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);
    await service.create({
      displayName: 'list-provider',
      baseUrl: 'http://127.0.0.1:1/v1',
      modelName: 'default-model',
      contextLength: 128000,
      models: [
        'Llama-3.1-70B',
        'llama-3.1-70b',
        'MIXTRAL-8x7B',
        'mixtral-8x7b',
      ],
    });

    const data = prisma.connection.create.mock.calls[0][0].data;
    expect(data.models).toEqual(['Llama-3.1-70B', 'MIXTRAL-8x7B']);
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

describe('ConnectionsService CRUD', () => {
  function crudDouble() {
    return {
      connection: {
        findUnique: jest.fn(),
        create: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
        delete: jest.fn(),
        update: jest.fn(),
      },
    } as never;
  }

  it('findAll returns masked rows ordered by creation', async () => {
    const prisma = crudDouble() as unknown as {
      connection: { findMany: jest.Mock };
    };
    prisma.connection.findMany.mockResolvedValue([ROW]);
    const service = new ConnectionsService(prisma as never);

    const rows = await service.findAll();

    expect(prisma.connection.findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'asc' },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].apiKey).toBe('sk-***ret');
  });

  it('findOne returns the masked row and 404s for unknown ids', async () => {
    const prisma = crudDouble() as unknown as {
      connection: { findUnique: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);

    prisma.connection.findUnique.mockResolvedValue(ROW);
    const found = await service.findOne('conn-1');
    expect(found.apiKey).toBe('sk-***ret');
    expect(prisma.connection.findUnique).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
    });

    prisma.connection.findUnique.mockResolvedValue(null);
    await expect(service.findOne('conn-1')).rejects.toThrow(NotFoundException);
  });

  it('update normalizes present fields and rejects empty payloads', async () => {
    const prisma = crudDouble() as unknown as {
      connection: { update: jest.Mock };
    };
    prisma.connection.update.mockResolvedValue(ROW);
    const service = new ConnectionsService(prisma as never);

    await expect(service.update('conn-1', {})).rejects.toThrow(
      BadRequestException,
    );

    await service.update('conn-1', {
      baseUrl: 'http://127.0.0.1:9876/v1///',
      concurrentConnections: 4,
      defaultParameters: { temperature: 0.2 },
    });
    const data = prisma.connection.update.mock.calls[0][0].data;
    expect(data.baseUrl).toBe('http://127.0.0.1:9876/v1');
    expect(data.concurrentConnections).toBe(4);
    expect(data.defaultParameters).toEqual({ temperature: 0.2 });
  });

  it('remove deletes existing connections and 404s otherwise', async () => {
    const prisma = crudDouble() as unknown as {
      connection: { delete: jest.Mock; count: jest.Mock };
    };
    const service = new ConnectionsService(prisma as never);

    prisma.connection.delete.mockResolvedValue(ROW);
    await expect(service.remove('conn-1')).resolves.toEqual({ deleted: true });
    expect(prisma.connection.delete).toHaveBeenCalledWith({
      where: { id: 'conn-1' },
    });

    prisma.connection.count.mockResolvedValue(0);
    await expect(service.remove('conn-1')).rejects.toThrow(NotFoundException);
    expect(prisma.connection.delete).toHaveBeenCalledTimes(1);
  });
});
