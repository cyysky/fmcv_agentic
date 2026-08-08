import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './test-app';
import { PrismaService } from '../src/prisma/prisma.service';

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

  it('persists conversation history to Postgres (restart resilience)', async () => {
    const prisma = app.get(PrismaService);
    const rowBefore = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    expect(rowBefore).not.toBeNull();
    expect(rowBefore!.messages).toBeDefined();

    // Real converse: messages make it into the DB row after the turn.
    const res = await http()
      .post(`/api/agent/sessions/${sessionId}/converse`)
      .send({ message: 'remember this turn for me', maxSteps: 2 })
      .ok((r) => r.status === 201 || r.status === 200);
    expect([200, 201]).toContain(res.status);
    const row = await prisma.agentSession.findUnique({ where: { id: sessionId } });
    const texts = JSON.parse(JSON.stringify(row!.messages)) as Array<{ role: string; content: string | null }>;
    expect(texts.some((m) => m.role === 'user' && m.content === 'remember this turn for me')).toBe(true);
  });

  it('converse returns a deterministic stub answer (hermetic, no gateway)', async () => {
    const res = await http()
      .post(`/api/agent/sessions/${sessionId}/converse`)
      .send({ message: 'ping pong', maxSteps: 2 })
      .ok((r) => r.status === 201 || r.status === 200);
    expect([200, 201]).toContain(res.status);
    expect(res.body.answer).toMatch(/^\[stub\] /);
    expect(res.body.answer).toContain('ping pong');
    expect(res.body.steps).toBe(0);
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

  it('POST /api/agent/turn — validates maxSteps and payload shape without calling the LLM', async () => {
    const tooBig = await http()
      .post('/api/agent/turn')
      .send({ message: 'hi', maxSteps: 21 })
      .expect(400);
    expect(JSON.stringify(tooBig.body.message)).toContain('maxSteps');

    const tooSmall = await http()
      .post('/api/agent/turn')
      .send({ message: 'hi', maxSteps: 0 })
      .expect(400);
    expect(JSON.stringify(tooSmall.body.message)).toContain('maxSteps');

    const noMessage = await http()
      .post('/api/agent/turn')
      .send({ maxSteps: 3 })
      .expect(400);
    expect(JSON.stringify(noMessage.body.message)).toContain('message');

    const extra = await http()
      .post('/api/agent/turn')
      .send({ message: 'hi', bogus: 1 })
      .expect(400);
    expect(JSON.stringify(extra.body.message)).toContain('bogus');
  });

  it('rejects unknown session ids with 404', async () => {
    const res = await http()
      .post('/api/agent/sessions/00000000-0000-0000-0000-000000000001/converse')
      .send({ message: 'hi' })
      .expect(404);
    expect(res.body.message).toContain('not found');
  });

  it('auto-titles a session from its first user message', async () => {
    const created = await http().post('/api/agent/sessions').send({}).expect(201);
    const id = created.body.id;
    try {
      await http()
        .post(`/api/agent/sessions/${id}/converse`)
        .send({ message: 'auto-title me please', maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);
      const fetched = await http().get(`/api/agent/sessions/${id}`).expect(200);
      expect(fetched.body.title).toBe('auto-title me please');

      // A later message must not change the derived title.
      await http()
        .post(`/api/agent/sessions/${id}/converse`)
        .send({ message: 'second message', maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);
      const after = await http().get(`/api/agent/sessions/${id}`).expect(200);
      expect(after.body.title).toBe('auto-title me please');
    } finally {
      await http().delete(`/api/agent/sessions/${id}`).ok((r) => r.status === 200);
    }
  });
  it('renames a session and persists the new title', async () => {
    const created = await http()
      .post('/api/agent/sessions')
      .send({ title: 'before rename' })
      .expect(201);
    const id = created.body.id;
    try {
      const renamed = await http()
        .patch(`/api/agent/sessions/${id}`)
        .send({ title: '  after rename  ' })
        .expect(200);
      expect(renamed.body.title).toBe('after rename');

      const fetched = await http().get(`/api/agent/sessions/${id}`).expect(200);
      expect(fetched.body.title).toBe('after rename');

      await http().patch(`/api/agent/sessions/${id}`).send({ title: '   ' }).expect(400);
      await http().patch(`/api/agent/sessions/${id}`).send({}).expect(400);

      const other = '00000000-0000-4000-8000-000000000000';
      await http().patch(`/api/agent/sessions/${other}`).send({ title: 'x' }).expect(404);
    } finally {
      await http().delete(`/api/agent/sessions/${id}`).ok((r) => r.status === 200);
    }
  });
  it('deletes a session', async () => {
    const del = await http().delete(`/api/agent/sessions/${sessionId}`).expect(200);
    expect(del.body).toEqual({ deleted: true });
    const prisma = app.get(PrismaService);
    expect(await prisma.agentSession.findUnique({ where: { id: sessionId } })).toBeNull();
    sessionId = '';
    await http().get(`/api/agent/sessions/00000000-0000-0000-0000-000000000001`).expect(404);
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


  it('runs sessions and turns against a saved connection', async () => {
    const prisma = app.get(PrismaService);
    const connName = `e2e-conn-${Date.now().toString(36)}`;
    let connId = '';
    const createdConn = await http()
      .post('/api/connections')
      .send({
        displayName: connName,
        baseUrl: 'http://ollama.e2e.test/v1',
        modelName: 'llama3.2',
        contextLength: 8192,
        apiKey: 'e2e-secret',
        defaultParameters: { temperature: 0.7 },
      })
      .expect(201);
    connId = createdConn.body.id;
    const sessionIds: string[] = [];
    // Session persistence is best-effort + asynchronous by design (a DB
    // failure must never break the in-memory chat), so poll briefly.
    const waitForRow = async (id: string) => {
      for (let i = 0; i < 25; i++) {
        const row = await prisma.agentSession.findUnique({ where: { id } });
        if (row?.connectionId === connId) return row;
        await new Promise((r) => setTimeout(r, 100));
      }
      return prisma.agentSession.findUnique({ where: { id } });
    };
    try {
      // Create pinned to the connection — the id is persisted immediately.
      const pinned = await http()
        .post('/api/agent/sessions')
        .send({ title: 'pinned session', connectionId: connId })
        .expect(201);
      sessionIds.push(pinned.body.id);
      expect(pinned.body.connectionId).toBe(connId);
      const pinnedRow = await waitForRow(pinned.body.id);
      expect(pinnedRow?.connectionId).toBe(connId);

      // Conversations on the pinned session still answer hermetically and
      // keep the connection on the row.
      await http()
        .post(`/api/agent/sessions/${pinned.body.id}/converse`)
        .send({ message: 'hello ollama', maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);
      const rowAfter = await waitForRow(pinned.body.id);
      expect(rowAfter?.connectionId).toBe(connId);

      // An explicit catalog model on a pinned session is accepted (the
      // catalog model overrides the connection's stored model for the turn).
      await http()
        .post(`/api/agent/sessions/${pinned.body.id}/converse`)
        .send({ message: 'qwen override', connectionId: connId, model: 'qwen3.6-35b', maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);

      // Attach a connection to an existing session via converse.
      const plain = await http().post('/api/agent/sessions').send({}).expect(201);
      sessionIds.push(plain.body.id);
      await http()
        .post(`/api/agent/sessions/${plain.body.id}/converse`)
        .send({ message: 'switch to ollama', connectionId: connId, maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);
      const attRow = await waitForRow(plain.body.id);
      expect(attRow?.connectionId).toBe(connId);

      // Stateless turn with the connection is accepted.
      const turn = await http()
        .post('/api/agent/turn')
        .send({ message: 'ping via connection', connectionId: connId })
        .expect(201);
      expect(turn.body.answer).toMatch(/^\[stub\] /);

      // An explicit catalog model overrides the connection's stored model
      // on the wire for a stateless turn (baseUrl/key still from the row).
      const overrideTurn = await http()
        .post('/api/agent/turn')
        .send({ message: 'ping qwen', connectionId: connId, model: 'qwen3.6-35b' })
        .expect(201);
      expect(overrideTurn.body.answer).toMatch(/^\[stub\] /);
      expect(overrideTurn.body.model).toBe('qwen3.6-35b');

      // Unknown connection ids are 404s everywhere.
      const missing = '00000000-0000-4000-8000-000000000000';
      await http()
        .post('/api/agent/sessions')
        .send({ connectionId: missing })
        .expect(404);
      await http()
        .post('/api/agent/turn')
        .send({ message: 'hi', connectionId: missing })
        .expect(404);
      await http()
        .post(`/api/agent/sessions/${plain.body.id}/converse`)
        .send({ message: 'hi', connectionId: missing })
        .expect(404);

      // Malformed (non-UUID) connection ids are validation errors.
      await http()
        .post('/api/agent/sessions')
        .send({ connectionId: 'not-a-uuid' })
        .expect(400);
      await http()
        .post('/api/agent/turn')
        .send({ message: 'hi', connectionId: 'not-a-uuid' })
        .expect(400);
    } finally {
      for (const id of sessionIds) {
        await http().delete(`/api/agent/sessions/${id}`).ok((r) => r.status === 200);
      }
      if (connId) {
        await http().delete(`/api/connections/${connId}`).ok((r) => r.status === 200);
      }
    }
  });
});

