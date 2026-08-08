import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapApp } from './test-app';

interface SkillRow {
  id: string;
  name: string;
  description: string;
  content: string;
  installed: boolean;
}

interface TypedResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
const json = <T>(res: TypedResponse): T => res.body as T;

describe('Skills API (e2e, real Postgres)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now().toString(36);
  const names = {
    main: `e2e-skill-${stamp}`,
    dup: `e2e-skill-dup-${stamp}`,
    badName: `e2e-skill-bad-${stamp}`,
    empty: `e2e-skill-empty-${stamp}`,
    installed: `e2e-skill-installed-${stamp}`,
    restart: `e2e-skill-restart-${stamp}`,
  };
  let skillId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.skill.deleteMany({
      where: { name: { in: Object.values(names) } },
    });
    await app.close();
  });

  it('creates a skill and 409s on a duplicate name', async () => {
    const res = await http()
      .post('/api/skills')
      .send({
        name: names.main,
        description: 'Code review checklist',
        content: '# Code review\nCheck edge cases and test gaps.',
      })
      .expect(201);
    const created = json<SkillRow>(res);
    expect(created).toMatchObject({
      name: names.main,
      description: 'Code review checklist',
      content: '# Code review\nCheck edge cases and test gaps.',
      installed: false,
    });
    expect(created.id).toBeTruthy();
    skillId = created.id;

    await http()
      .post('/api/skills')
      .send({
        name: names.main,
        description: 'Duplicate',
        content: 'Dup body',
      })
      .expect(409);
  });

  it('400s on an invalid skill name', async () => {
    await http()
      .post('/api/skills')
      .send({
        name: 'bad name!',
        description: 'Not slug-form',
        content: 'Body',
      })
      .expect(400);
  });

  it('rejects installing at creation without content', async () => {
    await http()
      .post('/api/skills')
      .send({ name: names.empty, installed: true })
      .expect(400);

    const created = json<SkillRow>(
      await http()
        .post('/api/skills')
        .send({ name: names.empty, description: 'No body yet' })
        .expect(201),
    );
    await http().post(`/api/skills/${created.id}/install`).expect(400);
  });

  it('creates a skill already installed when content is present', async () => {
    const res = await http()
      .post('/api/skills')
      .send({
        name: names.installed,
        description: 'Ship it',
        content: '# Deploy\nRun the pipeline.',
        installed: true,
      })
      .expect(201);
    expect(json<SkillRow>(res).installed).toBe(true);
  });

  it('lists skills and gets one (404 on unknown)', async () => {
    const list = await http().get('/api/skills').expect(200);
    const rows = json<SkillRow[]>(list);
    const row = rows.find((s) => s.id === skillId);
    expect(row).toBeTruthy();
    expect(row?.name).toBe(names.main);

    const one = await http().get(`/api/skills/${skillId}`).expect(200);
    expect(json<SkillRow>(one).content).toContain('# Code review');

    await http()
      .get('/api/skills/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('updates description/content and rejects clearing content while installed', async () => {
    const updated = json<SkillRow>(
      await http()
        .patch(`/api/skills/${skillId}`)
        .send({ description: 'Tighter checklist' })
        .expect(200),
    );
    expect(updated.description).toBe('Tighter checklist');

    // Install so the content guard is live.
    await http().post(`/api/skills/${skillId}/install`).expect(201);
    await http()
      .patch(`/api/skills/${skillId}`)
      .send({ content: '  ' })
      .expect(400);

    await http().patch(`/api/skills/${skillId}`).send({}).expect(400);
  });

  it('uninstalls and reinstalls a skill', async () => {
    const off = json<SkillRow>(
      await http().post(`/api/skills/${skillId}/uninstall`).expect(201),
    );
    expect(off.installed).toBe(false);

    const on = json<SkillRow>(
      await http().post(`/api/skills/${skillId}/install`).expect(201),
    );
    expect(on.installed).toBe(true);
  });

  it('installed skills survive a backend restart', async () => {
    const created = json<SkillRow>(
      await http()
        .post('/api/skills')
        .send({
          name: names.restart,
          description: 'Persists across instances',
          content: '# Restart\nStill installed after a backend restart.',
          installed: true,
        })
        .expect(201),
    );

    const restarted = await bootstrapApp();
    try {
      const row = json<SkillRow>(
        await request(restarted.getHttpServer())
          .get(`/api/skills/${created.id}`)
          .expect(200),
      );
      expect(row).toMatchObject({
        name: names.restart,
        description: 'Persists across instances',
        installed: true,
      });
      expect(row.content).toContain('# Restart');
    } finally {
      await restarted.close();
    }
  });

  it('agent turns still run with installed skills present', async () => {
    const created = await http()
      .post('/api/agent/sessions')
      .send({ title: 'skill-aware e2e' })
      .expect(201);
    const sessionId = created.body.id as string;
    try {
      const res = await http()
        .post('/api/agent/turn')
        .send({ message: 'ping pong with skills', maxSteps: 2 })
        .ok((r) => r.status === 201 || r.status === 200);
      expect([200, 201]).toContain(res.status);
      expect(json<{ answer: string }>(res).answer).toMatch(/^\[stub\] /);
    } finally {
      // Session rows are persisted to the shared Postgres but only tracked
      // in-memory by the live backend, so an un-deleted fixture here would be
      // invisible to the running app until restart. Always clean it up.
      const del = await http()
        .delete(`/api/agent/sessions/${sessionId}`)
        .ok((r) => r.status === 200);
      expect(del.body).toEqual({ deleted: true });
      expect(
        await prisma.agentSession.findUnique({ where: { id: sessionId } }),
      ).toBeNull();
    }
  });

  it('400s/404s on unknown ids for install, uninstall, and delete', async () => {
    const unknown = '00000000-0000-4000-8000-000000000000';
    await http().post(`/api/skills/${unknown}/install`).expect(404);
    await http().post(`/api/skills/${unknown}/uninstall`).expect(404);
    await http().delete(`/api/skills/${unknown}`).expect(404);
  });

  it('deletes a skill', async () => {
    await http().delete(`/api/skills/${skillId}`).expect(200);
    skillId = '';
    await http()
      .get('/api/skills/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });
});
