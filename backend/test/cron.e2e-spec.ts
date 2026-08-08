import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapApp } from './test-app';

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  taskType: string;
  prompt: string;
  model?: string | null;
  connectionId?: string | null;
  maxSteps?: number | null;
  enabled: boolean;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
  lastRunMessage?: string | null;
  lastRunModel?: string | null;
  lastRunMs?: number | null;
  nextRunAt?: string | null;
}

interface CronRunRow {
  id: string;
  cronJobId: string;
  status: string;
  message?: string | null;
  model?: string | null;
  ms?: number | null;
  createdAt: string;
}

interface CronOverviewRow {
  now: string;
  leases: Array<{
    group: string;
    owner: string;
    expireAt: string | null;
    held: boolean;
    updatedAt: string | null;
  }>;
  events: Array<{
    id: string;
    group: string;
    event: string;
    owner: string;
    previousOwner: string | null;
    createdAt: string;
  }>;
  eventGroups: string[];
  eventStats: Array<{ group: string; total: number }>;
  runs: {
    total: number;
    lastHour: number;
    byStatus: Array<{ status: string; count: number; avgMs: number | null }>;
    perJob: Array<{
      cronJobId: string;
      name: string | null;
      runCount: number;
      avgMs: number | null;
    }>;
  };
}

interface TypedResponse {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}
const json = <T>(res: TypedResponse): T => res.body as T;

describe('Cron API (e2e, real Postgres, stub agent)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now().toString(36);
  const names = {
    main: `e2e-cron-${stamp}`,
    dup: `e2e-cron-dup-${stamp}`,
    invalid: `e2e-cron-invalid-${stamp}`,
    disabled: `e2e-cron-disabled-${stamp}`,
    restart: `e2e-cron-restart-${stamp}`,
  };
  let jobId = '';
  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    app = await bootstrapApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.cronJob.deleteMany({
      where: { name: { in: Object.values(names) } },
    });
    await app.close();
  });

  it('creates a recurring agent-turn cron job with a next run', async () => {
    const res = await http()
      .post('/api/cron')
      .send({
        name: names.main,
        schedule: '*/10 * * * *',
        prompt: 'Summarize the backlog',
        maxSteps: 4,
      })
      .expect(201);
    const created = json<CronJobRow>(res);
    expect(created).toMatchObject({
      name: names.main,
      schedule: '*/10 * * * *',
      taskType: 'agent-turn',
      prompt: 'Summarize the backlog',
      maxSteps: 4,
      enabled: true,
    });
    expect(created.id).toBeTruthy();
    expect(new Date(created.nextRunAt as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
    jobId = created.id;
  });

  it('409s on a duplicate job name', async () => {
    await http()
      .post('/api/cron')
      .send({
        name: names.main,
        schedule: '0 9 * * *',
        prompt: 'Duplicate',
      })
      .expect(409);
  });

  it('400s on an invalid cron schedule', async () => {
    await http()
      .post('/api/cron')
      .send({
        name: names.invalid,
        schedule: '61 * * * *',
        prompt: 'Bad schedule',
      })
      .expect(400);
    await http()
      .post('/api/cron')
      .send({ name: names.invalid, schedule: 'bad', prompt: 'Bad too' })
      .expect(400);
  });

  it('400s when the pinned connection does not exist', async () => {
    await http()
      .post('/api/cron')
      .send({
        name: `e2e-cron-conn-${stamp}`,
        schedule: '*/10 * * * *',
        prompt: 'Pinned',
        connectionId: '00000000-0000-4000-8000-000000000000',
      })
      .expect(400);
  });

  it('lists cron jobs', async () => {
    const res = await http().get('/api/cron').expect(200);
    const rows = json<CronJobRow[]>(res);
    const row = rows.find((j) => j.id === jobId);
    expect(row).toBeTruthy();
    expect(row?.name).toBe(names.main);
  });

  it('gets one cron job and 404s on an unknown id', async () => {
    const res = await http().get(`/api/cron/${jobId}`).expect(200);
    expect(json<CronJobRow>(res).id).toBe(jobId);
    await http()
      .get('/api/cron/00000000-0000-4000-8000-000000000000')
      .expect(404);
  });

  it('restores cron jobs and next-run timing on a backend restart', async () => {
    const created = json<CronJobRow>(
      await http()
        .post('/api/cron')
        .send({
          name: names.restart,
          schedule: '0 8 * * *',
          prompt: 'Morning digest',
          enabled: true,
        })
        .expect(201),
    );
    expect(new Date(created.nextRunAt as string).getTime()).toBeGreaterThan(
      Date.now(),
    );

    const restarted = await bootstrapApp();
    try {
      const row = json<CronJobRow>(
        await request(restarted.getHttpServer())
          .get(`/api/cron/${created.id}`)
          .expect(200),
      );
      expect(row).toMatchObject({
        name: names.restart,
        schedule: '0 8 * * *',
        prompt: 'Morning digest',
        enabled: true,
      });
      expect(new Date(row.nextRunAt as string).getTime()).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      await restarted.close();
    }
  });

  it('updates the schedule and slides the next run forward', async () => {
    const res = await http()
      .patch(`/api/cron/${jobId}`)
      .send({ schedule: '0 9 * * *' })
      .expect(200);
    const row = json<CronJobRow>(res);
    expect(row.schedule).toBe('0 9 * * *');
    expect(new Date(row.nextRunAt as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('disables a job (nextRunAt null) and re-enables it', async () => {
    const disabled = json<CronJobRow>(
      await http()
        .patch(`/api/cron/${jobId}`)
        .send({ enabled: false })
        .expect(200),
    );
    expect(disabled.enabled).toBe(false);
    expect(disabled.nextRunAt).toBeNull();

    const reenabled = json<CronJobRow>(
      await http()
        .patch(`/api/cron/${jobId}`)
        .send({ enabled: true })
        .expect(200),
    );
    expect(reenabled.enabled).toBe(true);
    expect(new Date(reenabled.nextRunAt as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('400s on an empty update patch', async () => {
    await http().patch(`/api/cron/${jobId}`).send({}).expect(400);
  });

  it('runs the job now via the stub agent and records the result', async () => {
    const res = await http().post(`/api/cron/${jobId}/run`).expect(201);
    const row = json<CronJobRow>(res);
    expect(row.lastRunStatus).toBe('done');
    expect(row.lastRunMessage).toContain('[stub]');
    expect(row.lastRunModel).toBe('ds4-flash');
    expect(typeof row.lastRunMs).toBe('number');
    expect(new Date(row.lastRunAt as string).getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(new Date(row.nextRunAt as string).getTime()).toBeGreaterThan(
      Date.now(),
    );
  });

  it('lists the persisted run history for a job', async () => {
    const res = await http().get(`/api/cron/${jobId}/runs`).expect(200);
    const runs = json<CronRunRow[]>(res);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      cronJobId: jobId,
      status: 'done',
    });
    expect(runs[0].message).toContain('[stub]');
    expect(runs[0].model).toBe('ds4-flash');
    expect(typeof runs[0].ms).toBe('number');
    // Runs for an unknown job 404 like the job itself.
    await http()
      .get('/api/cron/00000000-0000-4000-8000-000000000000/runs')
      .expect(404);
  });

  it('paginates run history with limit and offset', async () => {
    // Two more terminal runs so the job has three rows to page through.
    await http().post(`/api/cron/${jobId}/run`).expect(201);
    await http().post(`/api/cron/${jobId}/run`).expect(201);
    const first = json<CronRunRow[]>(
      await http().get(`/api/cron/${jobId}/runs?limit=2&offset=0`).expect(200),
    );
    expect(first).toHaveLength(2);
    const second = json<CronRunRow[]>(
      await http().get(`/api/cron/${jobId}/runs?limit=2&offset=2`).expect(200),
    );
    expect(second).toHaveLength(1);
    const all = json<CronRunRow[]>(
      await http().get(`/api/cron/${jobId}/runs?limit=10`).expect(200),
    );
    expect(all).toHaveLength(3);
    // Pages stitch together newest-first with no overlap or gap.
    expect([...first, ...second].map((run) => run.id)).toEqual(
      all.map((run) => run.id),
    );
    // Offset beyond the end returns an empty page.
    const beyond = json<CronRunRow[]>(
      await http().get(`/api/cron/${jobId}/runs?offset=99`).expect(200),
    );
    expect(beyond).toHaveLength(0);
  });

  it('exposes cluster-wide scheduler overview with leases and run throughput', async () => {
    const res = await http().get('/api/cron/overview').expect(200);
    const overview = json<CronOverviewRow>(res);
    const defaultLease = overview.leases.find(
      (lease) => lease.group === 'default',
    );
    if (!defaultLease) throw new Error('overview: default lease group missing');
    expect(typeof defaultLease.owner).toBe('string');
    expect(defaultLease.owner.length).toBeGreaterThan(0);
    expect(defaultLease.expireAt).toBeTruthy();
    expect(new Date(overview.now).getTime()).toBeLessThanOrEqual(Date.now());
    // Round 71: recent lease transition events ride along. This suite never
    // fails over (single local replica, no transitions), so it is additive.
    expect(Array.isArray(overview.events)).toBe(true);
    // Round 73: per-group event history is advertised for filtering.
    expect(overview.eventGroups).toEqual(expect.arrayContaining(['default']));
    // Round 74: per-group transition totals match the advertised groups.
    expect(overview.eventStats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          group: 'default',
          total: expect.any(Number),
        }),
      ]),
    );
    // The job behind this suite has three terminal runs at this point.
    expect(overview.runs.total).toBeGreaterThanOrEqual(3);
    expect(overview.runs.lastHour).toBeGreaterThanOrEqual(3);
    expect(overview.runs.byStatus.length).toBeGreaterThan(0);
    const jobStat = overview.runs.perJob.find((job) => job.cronJobId === jobId);
    if (!jobStat)
      throw new Error('overview: this suite job missing from per-job stats');
    expect(jobStat.runCount).toBeGreaterThanOrEqual(3);
  });

  it('filters overview transition events per lease group', async () => {
    const all = json<CronOverviewRow>(
      await http().get('/api/cron/overview').expect(200),
    );
    const group = all.eventGroups[0] ?? 'default';
    const filtered = json<CronOverviewRow>(
      await http()
        .get(`/api/cron/overview?group=${encodeURIComponent(group)}`)
        .expect(200),
    );
    expect(filtered.events.every((evt) => evt.group === group)).toBe(true);
    expect(filtered.eventGroups).toEqual(all.eventGroups);
    expect(filtered.eventStats).toEqual(all.eventStats);
    const none = json<CronOverviewRow>(
      await http()
        .get('/api/cron/overview?group=no-such-group-e2e')
        .expect(200),
    );
    expect(none.events).toEqual([]);
    expect(none.eventGroups).toEqual(all.eventGroups);
  });

  it('widens the overview transition window with ?limit=', async () => {
    const group = `e2e-window-${stamp}`;
    await prisma.cronSchedulerEvent.createMany({
      data: Array.from({ length: 13 }, (_, i) => ({
        id: `e2e-window-${stamp}-${i}`,
        schedulerGroup: group,
        owner: `replica-${i}`,
        event: 'acquired',
        previousOwner: i ? `replica-${i - 1}` : null,
        createdAt: new Date(Date.now() - (13 - i) * 1000),
      })),
    });
    try {
      // Default window is the newest 10.
      const tightened = json<CronOverviewRow>(
        await http()
          .get(`/api/cron/overview?group=${encodeURIComponent(group)}&limit=10`)
          .expect(200),
      );
      expect(tightened.events).toHaveLength(10);
      expect(tightened.events.every((evt) => evt.group === group)).toBe(true);
      expect(tightened.eventStats).toEqual(
        expect.arrayContaining([expect.objectContaining({ group, total: 13 })]),
      );
      // A deeper window shows the group's full history while totals stay
      // group-wide.
      const widened = json<CronOverviewRow>(
        await http()
          .get(`/api/cron/overview?group=${encodeURIComponent(group)}&limit=50`)
          .expect(200),
      );
      expect(widened.events).toHaveLength(13);
      expect(widened.eventStats).toEqual(tightened.eventStats);
      // Omitted/malformed limits keep the documented default; a huge limit
      // clamps at 100 but still returns the shallow history here.
      const defaultLen = json<CronOverviewRow>(
        await http()
          .get(`/api/cron/overview?group=${encodeURIComponent(group)}`)
          .expect(200),
      ).events.length;
      expect(defaultLen).toBe(10);
      const clamped = json<CronOverviewRow>(
        await http()
          .get(
            `/api/cron/overview?group=${encodeURIComponent(group)}&limit=500`,
          )
          .expect(200),
      );
      expect(clamped.events).toHaveLength(13);
    } finally {
      await prisma.cronSchedulerEvent.deleteMany({
        where: { schedulerGroup: group },
      });
    }
  });

  it('404s running an unknown job', async () => {
    await http()
      .post('/api/cron/00000000-0000-4000-8000-000000000000/run')
      .expect(404);
  });

  it('deletes a cron job', async () => {
    const deletedId = jobId;
    await http().delete(`/api/cron/${jobId}`).expect(200);
    jobId = '';
    await http()
      .get('/api/cron/00000000-0000-4000-8000-000000000000')
      .expect(404);
    // Run history is cascade-deleted with the job.
    expect(
      await prisma.cronRun.count({ where: { cronJobId: deletedId } }),
    ).toBe(0);
  });
});
