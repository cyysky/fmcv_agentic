import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './app.e2e-spec';

describe('Agent API (e2e, real Postgres + workspace)', () => {
  let app: INestApplication<App>;
  const http = () => request(app.getHttpServer());
  const project = `proj-${Date.now().toString(36)}`;
  const agentFolder = `folder-${Date.now().toString(36)}`;
  let sessionId = '';

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/agent/defaults — exposes the default model and LLM endpoint', async () => {
    const res = await http().get('/api/agent/defaults').expect(200);
    expect(res.body.baseUrl).toMatch(/^http/);
    expect(typeof res.body.defaultModel).toBe('string');
  });

  it('creates and lists sessions', async () => {
    const created = await http()
      .post('/api/agent/sessions')
      .send({ title: 'e2e session' })
      .expect(201);
    sessionId = created.body.id;
    expect(created.body.model).toBe('ds4-flash');
    const list = await http().get('/api/agent/sessions').expect(200);
    expect(list.body.map((s: { id: string }) => s.id)).toContain(sessionId);
  });

  it('converse validates maxSteps and unknown props without calling the LLM', async () => {
    const tooBig = await http()
      .post(`/api/agent/sessions/${sessionId}/converse`)
      .send({ message: 'hi', maxSteps: 21 })
      .expect(400);
    expect(JSON.stringify(tooBig.body.message)).toContain('maxSteps');

    const extra = await http()
      .post(`/api/agent/sessions/${sessionId}/converse`)
      .send({ message: 'hi', maxSteps: 5, bogus: 1 })
      .expect(400);
    expect(JSON.stringify(extra.body.message)).toContain('bogus');

    const empty = await http()
      .post(`/api/agent/sessions/${sessionId}/converse`)
      .send({ message: '' })
      .expect(400);
    expect(JSON.stringify(empty.body.message)).toContain('message');
  });

  it('rejects unknown session ids with 404', async () => {
    const res = await http()
      .post('/api/agent/sessions/00000000-0000-0000-0000-000000000001/converse')
      .send({ message: 'hi' })
      .expect(404);
    expect(res.body.message).toContain('not found');
  });

  it('deletes a session', async () => {
    const del = await http().delete(`/api/agent/sessions/${sessionId}`).expect(200);
    expect(del.body).toEqual({ deleted: true });
    sessionId = '';
    await http().get(`/api/agent/sessions/${del.body.id || '00000000-0000-0000-0000-000000000001'}`).expect(404);
  });

  it('manages workspace projects and agent folders', async () => {
    const proj = await http()
      .post('/api/agent/workspaces/projects')
      .send({ name: project })
      .expect(201);
    expect(proj.body.name).toBe(project);
    const tree = await http().get(`/api/agent/workspaces/projects/${project}`).expect(200);
    expect(tree.body).toBeDefined();

    // The agent-folder endpoint only manages the named agents (coder /
    // researcher); ensure one exists and is listable.
    const folder = await http()
      .post('/api/agent/workspaces/agents')
      .send({ name: 'researcher' })
      .expect(201);
    expect(folder.body.name).toBe('researcher');
    const agentTree = await http().get('/api/agent/workspaces/agents/researcher').expect(200);
    expect(agentTree.body).toBeDefined();

    // Arbitrary folder names are rejected — the system is closed to named
    // agents only, so the endpoint cannot be used to create loose dirs.
    const nonNamed = await http()
      .post('/api/agent/workspaces/agents')
      .send({ name: agentFolder })
      .expect(400);
    expect(JSON.stringify(nonNamed.body.message)).toContain('Unknown agent');
  });

  it('rejects reserved system names for agent folders', async () => {
    const res = await http()
      .post('/api/agent/workspaces/agents')
      .send({ name: '...' })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('alphanumeric');
  });
});
