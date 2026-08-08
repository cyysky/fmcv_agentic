import { INestApplication } from '@nestjs/common';
import { AddressInfo } from 'net';
import { createServer, Server } from 'http';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

describe('Connections API (e2e, real Postgres)', () => {
  let app: INestApplication<App>;
  let upstream: Server;
  let upstreamUrl = '';
  let lastAuth: string | null = null;
  const http = () => request(app.getHttpServer());
  const payload = {
    displayName: `e2e-${Date.now().toString(36)}`,
    baseUrl: 'http://127.0.0.1:9/v1/',
    modelName: 'ds4-flash',
    contextLength: 131000,
  };
  const keyedPayload = { ...payload, displayName: payload.displayName + '-keyed', apiKey: 'sk-e2esupersecret123' };
  let createdId = '';

  beforeAll(async () => {
    app = await bootstrapApp();

    // Hermetic fake OpenAI-compatible upstream: verifies the probe sends the
    // stored bearer key and answers one-token completions.
    upstream = createServer((req, res) => {
      lastAuth = req.headers.authorization ?? null;
      let body = '';
      req.on('data', (c: Buffer) => (body += c.toString()));
      req.on('end', () => {
        if (lastAuth !== 'Bearer sk-e2e-supersecret123') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end('{"error":"invalid api key"}');
          return;
        }
        const parsed = JSON.parse(body || '{}');
        const valid =
          parsed.model === 'probe-model' && parsed.max_tokens === 1;
        if (!valid) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end('{"error":"bad probe payload"}');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"choices":[{"message":{"content":"pong"}}]}');
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  });

  afterAll(async () => {
    if (createdId) {
      await http().delete(`/api/connections/${createdId}`).ok((r) => r.status === 200);
    }
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await app.close();
  });

  it('rejects incomplete connection payloads', async () => {
    const res = await http().post('/api/connections').send({ displayName: 'x' }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('baseUrl');
  });

  it('rejects non-http(s) base URLs', async () => {
    const res = await http()
      .post('/api/connections')
      .send({ ...payload, baseUrl: 'ftp://example.com' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('baseUrl');
  });

  it('creates, lists (masked), reads, updates, and deletes a connection', async () => {
    const created = await http().post('/api/connections').send(payload).expect(201);
    createdId = created.body.id;
    expect(created.body.baseUrl).toBe('http://127.0.0.1:9/v1'); // trailing slash normalized
    expect(created.body.apiKey).toBeNull(); // never exposed when none set

    const list = await http().get('/api/connections').expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(createdId);

    const one = await http().get(`/api/connections/${createdId}`).expect(200);
    expect(one.body.displayName).toBe(payload.displayName);

    const patched = await http()
      .patch(`/api/connections/${createdId}`)
      .send({ contextLength: 200000 })
      .expect(200);
    expect(patched.body.contextLength).toBe(200000);

    // A stored API key is returned masked, never in the clear.
    const keyed = await http().post('/api/connections').send(keyedPayload).expect(201);
    expect(keyed.body.apiKey).toContain('***');
    expect(keyed.body.apiKey).not.toContain('sk-e2esupersecret123');
    await http().delete(`/api/connections/${keyed.body.id}`).expect(200);

    const del = await http().delete(`/api/connections/${createdId}`).expect(200);
    expect(del.body).toEqual({ deleted: true });
    createdId = '';
    await http().get(`/api/connections/${one.body.id}`).expect(404);
  });

  it('clears a stored API key when the edit explicitly sends an empty string', async () => {
    const created = await http()
      .post('/api/connections')
      .send({ ...keyedPayload, displayName: `e2e-clear-${Date.now().toString(36)}` })
      .expect(201);
    expect(created.body.apiKey).toContain('***');

    try {
      const cleared = await http()
        .patch(`/api/connections/${created.body.id}`)
        .send({ apiKey: '' })
        .expect(200);
      expect(cleared.body.apiKey).toBeNull();

      const fetched = await http().get(`/api/connections/${created.body.id}`).expect(200);
      expect(fetched.body.apiKey).toBeNull();
    } finally {
      await http().delete(`/api/connections/${created.body.id}`).ok((r) => r.status === 200);
    }
  });

  it('rejects updates with no fields', async () => {
    const created = await http().post('/api/connections').send(payload).expect(201);
    const invalid = await http()
      .patch(`/api/connections/${created.body.id}`)
      .send({})
      .expect(400);
    expect(JSON.stringify(invalid.body.message)).toContain('fields');
    await http().delete(`/api/connections/${created.body.id}`).expect(200);
  });

  it('stores a normalized per-connection model list and lets edits replace or clear it', async () => {
    const created = await http()
      .post('/api/connections')
      .send({
        ...payload,
        displayName: `e2e-models-${Date.now().toString(36)}`,
        models: [' llama-3.1-70b ', '', 'llama-3.1-70b', 'mixtral-8x7b'],
      })
      .expect(201);
    try {
      // Normalization: whitespace trimmed, blanks dropped, duplicates removed.
      expect(created.body.models).toEqual(['llama-3.1-70b', 'mixtral-8x7b']);

      const listed = await http().get('/api/connections').expect(200);
      const row = listed.body.find((c: { id: string }) => c.id === created.body.id);
      expect(row.models).toEqual(['llama-3.1-70b', 'mixtral-8x7b']);

      // PATCH replaces the whole list.
      const replaced = await http()
        .patch(`/api/connections/${created.body.id}`)
        .send({ models: ['gpt-4o'] })
        .expect(200);
      expect(replaced.body.models).toEqual(['gpt-4o']);

      // An empty array clears it (the Settings textarea sends [] when blank).
      const cleared = await http()
        .patch(`/api/connections/${created.body.id}`)
        .send({ models: [] })
        .expect(200);
      expect(cleared.body.models).toEqual([]);
    } finally {
      await http().delete(`/api/connections/${created.body.id}`).ok((r) => r.status === 200);
    }
  });

  it('rejects malformed model lists', async () => {
    const created = await http().post('/api/connections').send(payload).expect(201);
    try {
      const notArray = await http()
        .patch(`/api/connections/${created.body.id}`)
        .send({ models: 'llama-3' })
        .expect(400);
      expect(JSON.stringify(notArray.body.message)).toContain('models');

      const notStrings = await http()
        .patch(`/api/connections/${created.body.id}`)
        .send({ models: ['ok', 42] })
        .expect(400);
      expect(JSON.stringify(notStrings.body.message)).toContain('models');
    } finally {
      await http().delete(`/api/connections/${created.body.id}`).ok((r) => r.status === 200);
    }
  });

  describe('connection test endpoint', () => {
    async function cleanup(id?: string) {
      if (id) {
        await http().delete(`/api/connections/${id}`).ok((r) => r.status === 200);
      }
    }

    it('POST /:id/test probes a reachable endpoint with the stored key', async () => {
      const created = await http()
        .post('/api/connections')
        .send({
          displayName: `probe-ok-${Date.now().toString(36)}`,
          baseUrl: upstreamUrl,
          modelName: 'probe-model',
          contextLength: 128000,
          apiKey: 'sk-e2e-supersecret123',
        })
        .expect(201);

      try {
        const res = await http()
          .post(`/api/connections/${created.body.id}/test`)
          .expect(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.status).toBe(200);
        expect(res.body.model).toBe('probe-model');
        expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
        expect(String(res.body.message)).toContain('responded');
        expect(lastAuth).toBe('Bearer sk-e2e-supersecret123');
      } finally {
        await cleanup(created.body.id);
      }
    });

    it('reports auth failures with the upstream HTTP status', async () => {
      const created = await http()
        .post('/api/connections')
        .send({
          displayName: `probe-401-${Date.now().toString(36)}`,
          baseUrl: upstreamUrl,
          modelName: 'probe-model',
          contextLength: 128000,
          apiKey: 'sk-wrong-key',
        })
        .expect(201);

      try {
        const res = await http()
          .post(`/api/connections/${created.body.id}/test`)
          .expect(200);
        expect(res.body.ok).toBe(false);
        expect(res.body.status).toBe(401);
        expect(String(res.body.message)).toContain('401');
      } finally {
        await cleanup(created.body.id);
      }
    });

    it('reports unreachable endpoints gracefully without an exception', async () => {
      // Bind + close a throwaway server to get a port that is almost surely
      // closed by the time the probe runs.
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const closedPort = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const created = await http()
        .post('/api/connections')
        .send({
          displayName: `probe-down-${Date.now().toString(36)}`,
          baseUrl: `http://127.0.0.1:${closedPort}/v1`,
          modelName: 'probe-model',
          contextLength: 128000,
        })
        .expect(201);

      try {
        const res = await http()
          .post(`/api/connections/${created.body.id}/test`)
          .expect(200);
        expect(res.body.ok).toBe(false);
        expect(res.body.status).toBeUndefined();
        expect(String(res.body.message)).toContain('Connection failed');
      } finally {
        await cleanup(created.body.id);
      }
    });

    it('404 for an unknown connection id', async () => {
      await http()
        .post('/api/connections/00000000-0000-0000-0000-000000000000/test')
        .expect(404);
    });
  });

  describe('connection draft test endpoint (test before save)', () => {
    it('probes entered values with the entered key, without persisting anything', async () => {
      const before = await http().get('/api/connections').expect(200);

      const res = await http()
        .post('/api/connections/test')
        .send({
          baseUrl: upstreamUrl,
          modelName: 'probe-model',
          apiKey: 'sk-e2e-supersecret123',
        })
        .expect(200);

      expect(res.body.ok).toBe(true);
      expect(res.body.status).toBe(200);
      expect(res.body.model).toBe('probe-model');
      expect(String(res.body.message)).toContain('responded');
      expect(lastAuth).toBe('Bearer sk-e2e-supersecret123');

      const after = await http().get('/api/connections').expect(200);
      expect(after.body).toEqual(before.body); // no row created
    });

    it('reports auth failures for unauthenticated draft requests', async () => {
      const res = await http()
        .post('/api/connections/test')
        .send({
          baseUrl: upstreamUrl,
          modelName: 'probe-model',
          apiKey: 'sk-wrong-key',
        })
        .expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBe(401);
      expect(String(res.body.message)).toContain('401');
    });

    it('reports unreachable draft endpoints gracefully', async () => {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const closedPort = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));

      const res = await http()
        .post('/api/connections/test')
        .send({
          baseUrl: `http://127.0.0.1:${closedPort}/v1`,
          modelName: 'probe-model',
        })
        .expect(200);

      expect(res.body.ok).toBe(false);
      expect(res.body.status).toBeUndefined();
      expect(String(res.body.message)).toContain('Connection failed');
    });

    it('rejects non-http(s) draft base URLs', async () => {
      const res = await http()
        .post('/api/connections/test')
        .send({ baseUrl: 'ftp://example.com', modelName: 'probe-model' })
        .expect(400);
      expect(JSON.stringify(res.body.message)).toContain('baseUrl');
    });
  });
});
