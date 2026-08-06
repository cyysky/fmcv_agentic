import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { bootstrapApp } from './app.e2e-spec';

describe('Channel API (e2e, real Postgres + workspace)', () => {
  let app: INestApplication<App>;
  const stamp = Date.now().toString(36);
  const name = `E2E ${stamp}`;
  const slug = `e2e-${stamp}`;
  let channelId = '';
  const http = () => request(app.getHttpServer());
  const stoppedEvents = (job: { events: Array<{ type: string }> }) =>
    job.events.filter((e) => e.type === 'stopped').length;

  beforeAll(async () => {
    app = await bootstrapApp();
  });

  afterAll(async () => {
    if (channelId) {
      // Best-effort cleanup if the delete test never ran.
      await http().delete(`/api/channels/${channelId}`).ok((r) => r.status === 200 || r.status === 404);
    }
    await app.close();
  });

  it('creates a channel with slug + creator member', async () => {
    const res = await http()
      .post('/api/channels')
      .send({ name, creatorAgent: 'coder' })
      .expect(201);
    channelId = res.body.id;
    expect(res.body.slug).toBe(slug);
    expect(res.body.projectName).toBe(slug);
    expect(res.body.members).toContain('coder');
    expect(res.body.messages.map((m: { role: string }) => m.role)).toContain('system');
  });

  it('rejects duplicate slugs', async () => {
    const res = await http()
      .post('/api/channels')
      .send({ name: `${slug}!!!` })
      .expect(400);
    expect(JSON.stringify(res.body.message)).toContain('already exists');
  });

  it('trims stray dashes while slugifying', async () => {
    const res = await http()
      .post('/api/channels')
      .send({ name: `-- ${stamp} --`, creatorAgent: 'coder' })
      .expect(201);
    expect(res.body.slug).toBe(stamp);
    await http().delete(`/api/channels/${res.body.id}`).expect(200);
  });

  it('rejects empty channel names', async () => {
    const res = await http().post('/api/channels').send({ name: '   ' }).expect(400);
    expect(JSON.stringify(res.body.message)).toContain('empty');
  });

  it('lists and fetches channels', async () => {
    const list = await http().get('/api/channels').expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toContain(channelId);
    const one = await http().get(`/api/channels/${channelId}`).expect(200);
    expect(one.body.slug).toBe(slug);
  });

  it('adds and removes members with validation', async () => {
    const added = await http()
      .post(`/api/channels/${channelId}/members`)
      .send({ agentName: 'researcher' })
      .expect(201);
    expect(added.body.members).toContain('researcher');

    // Unknown agent names are rejected with the valid list in the message.
    const bad = await http()
      .post(`/api/channels/${channelId}/members`)
      .send({ agentName: 'bogus' })
      .expect(400);
    expect(JSON.stringify(bad.body.message)).toContain('Valid named agents');

    const removed = await http()
      .delete(`/api/channels/${channelId}/members/researcher`)
      .expect(200);
    expect(removed.body.members).not.toContain('researcher');

    // Removing a non-member fails instead of silently succeeding.
    const again = await http()
      .delete(`/api/channels/${channelId}/members/researcher`)
      .expect(400);
    expect(JSON.stringify(again.body.message)).toContain('not a member');
  });

  it('posts a human message and starts an auto-reply job', async () => {
    const res = await http()
      .post(`/api/channels/${channelId}/messages`)
      .send({ text: 'e2e hello', author: 'e2e-user' })
      .expect(201);
    expect(res.body.msg.id).toBeDefined();
    expect(res.body.msg.role).toBe('user');
    expect(res.body.msg.author).toBe('e2e-user');
    expect(res.body.jobId).toBeDefined();
    expect(res.body.agentName).toBe('coder');
    // Don't let the background job linger: stop it right away.
    const stop = await http()
      .post(`/api/channels/${channelId}/jobs/${res.body.jobId}/stop`)
      .ok((r) => r.status === 200 || r.status === 400);
    const job = await http()
      .get(`/api/channels/${channelId}/jobs/${res.body.jobId}`)
      .expect(200);
    expect(['done', 'stopped']).toContain(job.body.status);
    // Regression for the duplicate-'stopped' bug: at most one stopped event.
    expect(stoppedEvents(job.body)).toBeLessThanOrEqual(1);
    void stop;
  });

  it('rejects invalid maxSteps on job creation', async () => {
    const tooBig = await http()
      .post(`/api/channels/${channelId}/jobs`)
      .send({ agentName: 'coder', message: 'x', maxSteps: 21 })
      .expect(400);
    expect(JSON.stringify(tooBig.body.message)).toContain('maxSteps');
    const zero = await http()
      .post(`/api/channels/${channelId}/jobs`)
      .send({ agentName: 'coder', message: 'x', maxSteps: 0 })
      .expect(400);
    expect(JSON.stringify(zero.body.message)).toContain('maxSteps');
  });

  it('starts a job and stops it with a single stopped event', async () => {
    const created = await http()
      .post(`/api/channels/${channelId}/jobs`)
      .send({ agentName: 'coder', message: 'work in the channel', maxSteps: 3 })
      .expect(201);
    expect(created.body.status).toBe('running');

    // Stop immediately after create; the endpoint is synchronous so the job is
    // still in its pre-LLM phase and definitely running.
    const stop = await http()
      .post(`/api/channels/${channelId}/jobs/${created.body.jobId}/stop`)
      .ok((r) => r.status === 200 || r.status === 400);

    const job = await http()
      .get(`/api/channels/${channelId}/jobs/${created.body.jobId}`)
      .expect(200);
    expect(['stopped', 'done']).toContain(job.body.status);
    if (stop.status === 200) {
      // The exact regression: stop emits exactly one 'stopped' event, and the
      // job run finishing afterwards does not emit a duplicate.
      expect(job.body.status).toBe('stopped');
      expect(stoppedEvents(job.body)).toBe(1);
    } else {
      expect(stoppedEvents(job.body)).toBeLessThanOrEqual(1);
    }
  });

  it('deleting a channel stops its running jobs with exactly one stopped event', async () => {
    const res = await http()
      .post('/api/channels')
      .send({ name: `delete-jobs ${stamp}`, creatorAgent: 'coder' })
      .expect(201);
    const id = res.body.id as string;

    const job = await http()
      .post(`/api/channels/${id}/jobs`)
      .send({ agentName: 'coder', message: 'work in the channel', maxSteps: 20 })
      .expect(201);
    expect(job.body.status).toBe('running');

    const del = await http().delete(`/api/channels/${id}`).expect(200);
    expect(del.body.deleted).toBe(true);

    const after = await http()
      .get(`/api/channels/${id}/jobs/${job.body.jobId}`)
      .expect(200);
    expect(after.body.status).toBe('stopped');
    expect(stoppedEvents(after.body)).toBe(1);
  });

  it('deletes a channel', async () => {
    const res = await http().delete(`/api/channels/${channelId}`).expect(200);
    expect(res.body).toEqual({ deleted: true });
    await http().get(`/api/channels/${channelId}`).expect(404);
    channelId = '';
  });
});
