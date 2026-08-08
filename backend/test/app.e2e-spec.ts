import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';

describe('App API (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api — app root responds', () => {
    return request(app.getHttpServer())
      .get('/api')
      .expect(200)
      .expect('Hello World!');
  });

  it('GET /api/agent/models — catalog of known models', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agent/models')
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = (res.body as { id: string }[]).map((m) => m.id);
    expect(ids).toContain('ds4-flash');
  });

  it('GET /api/agent/workspaces — lists projects and named agents', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/agent/workspaces')
      .expect(200);
    expect(Array.isArray((res.body as { projects: unknown[] }).projects)).toBe(
      true,
    );
    const agentNames = (res.body as { agents: { name: string }[] }).agents.map(
      (a) => a.name,
    );
    expect(agentNames).toEqual(expect.arrayContaining(['coder', 'researcher']));
  });

  it('rejects unknown body properties at the API boundary', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agent/workspaces/projects')
      .send({ name: 'valid-project', whatever: true })
      .expect(400);
    expect(
      JSON.stringify((res.body as { message: unknown }).message),
    ).toContain('whatever');
  });

  it('validates workspace project names (alphanumeric, dash, underscore)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/agent/workspaces/projects')
      .send({ name: 'bad name!' })
      .expect(400);
    expect(
      JSON.stringify((res.body as { message: unknown }).message),
    ).toContain('alphanumeric');
  });
});
