import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

describe('Connections API (e2e, real Postgres)', () => {
  let app: INestApplication<App>;
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
  });

  afterAll(async () => {
    if (createdId) {
      await http().delete(`/api/connections/${createdId}`).ok((r) => r.status === 200);
    }
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

  it('rejects updates with no fields', async () => {
    const created = await http().post('/api/connections').send(payload).expect(201);
    const invalid = await http()
      .patch(`/api/connections/${created.body.id}`)
      .send({})
      .expect(400);
    expect(JSON.stringify(invalid.body.message)).toContain('fields');
    await http().delete(`/api/connections/${created.body.id}`).expect(200);
  });
});
