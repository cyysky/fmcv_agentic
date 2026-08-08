import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { BaseAgentService } from '../src/agent/base-agent.service';
import { CronService } from '../src/cron/cron.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapApp } from './test-app';

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  lastRunModel: string | null;
  lastRunMs: number | null;
  nextRunAt: string | null;
}

interface SchedulerStatus {
  leaseHeld: boolean;
  leaseGroup: string;
  leaseExpireAt: string | null;
  tickIntervalMs: number;
  failoverMs: number;
  lastTickAt: string | null;
  jobCount: number;
  enabledCount: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until the two replicas settle into exactly one lease holder. */
async function electHolder(apps: [INestApplication<App>, INestApplication<App>]): Promise<{
  holder: INestApplication<App>;
  standby: INestApplication<App>;
}> {
  const status = async (app: INestApplication<App>): Promise<SchedulerStatus> =>
    (await request(app.getHttpServer()).get('/api/cron/scheduler').expect(200))
      .body as SchedulerStatus;
  let a = await status(apps[0]);
  let b = await status(apps[1]);
  const deadline = Date.now() + 8000;
  while (a.leaseHeld === b.leaseHeld && Date.now() < deadline) {
    await sleep(300);
    a = await status(apps[0]);
    b = await status(apps[1]);
  }
  expect([a.leaseHeld, b.leaseHeld].filter(Boolean)).toHaveLength(1);
  return a.leaseHeld
    ? { holder: apps[0], standby: apps[1] }
    : { holder: apps[1], standby: apps[0] };
}

/** Make this replica's agent turn take ~600 ms and count every execution. */
function slowAgent(
  app: INestApplication<App>,
  counter: { runs: number },
): void {
  const agent = app.get(BaseAgentService);
  const original = agent.runTurn.bind(agent);
  agent.runTurn = async (opts) => {
    counter.runs += 1;
    await sleep(600);
    return original(opts);
  };
}

describe('Cron scheduler (e2e, two replicas, exactly-once)', () => {
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now().toString(36);
  const leaseGroup = `e2e-${stamp}`;
  const jobName = `e2e-cron-race-${stamp}`;
  let jobId = '';

  beforeAll(async () => {
    // Isolate this suite from the live stack's `default` lease (the running
    // container renews it every second, so test replicas would never win it).
    process.env.CRON_LEASE_GROUP = leaseGroup;
    appA = await bootstrapApp();
    appB = await bootstrapApp();
    prisma = appA.get(PrismaService);
  });

  afterAll(async () => {
    if (jobId) {
      await prisma.cronJob
        .deleteMany({ where: { name: jobName } })
        .catch(() => undefined);
    }
    await Promise.all([appA?.close(), appB?.close()]);
    await prisma
      .$executeRaw`DELETE FROM cron_scheduler_leases WHERE "schedulerGroup" = ${leaseGroup}`
      .catch(() => undefined);
    if (process.env.CRON_LEASE_GROUP === leaseGroup) {
      delete process.env.CRON_LEASE_GROUP;
    }
  });

  it('elects exactly one scheduler lease holder across two replicas', async () => {
    const { holder, standby } = await electHolder([appA, appB]);
    expect(holder).toBeDefined();
    expect(standby).toBeDefined();
    expect(standby).not.toBe(holder);
    const holderStatus = (
      await request(holder.getHttpServer()).get('/api/cron/scheduler').expect(200)
    ).body as SchedulerStatus;
    const standbyStatus = (
      await request(standby.getHttpServer()).get('/api/cron/scheduler').expect(200)
    ).body as SchedulerStatus;
    expect(holderStatus.leaseHeld).toBe(true);
    expect(standbyStatus.leaseHeld).toBe(false);
    expect(holderStatus.leaseExpireAt).toBeTruthy();
    expect(holderStatus.failoverMs).toBe(5000);
  });

  it(
    'runs a due job exactly once when the ticker and run-now race across replicas',
    async () => {
      const { holder, standby } = await electHolder([appA, appB]);
      const holderRuns = { runs: 0 };
      const standbyRuns = { runs: 0 };
      slowAgent(holder, holderRuns);
      slowAgent(standby, standbyRuns);

      // Create through the standby (its cache has the row) so run-now runs on
      // a different replica than the ticker, then force the row due.
      const created = (
        await request(standby.getHttpServer())
          .post('/api/cron')
          .send({
            name: jobName,
            schedule: '* * * * *',
            prompt: 'Race me',
            maxSteps: 2,
          })
          .expect(201)
      ).body as CronJobRow;
      jobId = created.id;
      await prisma.cronJob.update({
        where: { id: jobId },
        data: { nextRunAt: new Date(Date.now() - 5000) },
      });

      // Fire run-now on the standby; the lease holder's ticker will also see
      // the due row within its next beat. Exactly one claim may win.
      const runNow = await request(standby.getHttpServer())
        .post(`/api/cron/${jobId}/run`)
        .send();
      expect([201, 409]).toContain(runNow.status);

      // Settle: poll until a terminal status appears (via the holder).
      let row: CronJobRow | null = null;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        row = (
          await request(holder.getHttpServer()).get(`/api/cron/${jobId}`).expect(200)
        ).body as CronJobRow;
        if (row.lastRunStatus === 'done' || row.lastRunStatus === 'error') break;
        await sleep(200);
      }
      expect(row?.lastRunStatus).toBe('done');
      expect(row?.lastRunMessage).toContain('[stub]');
      expect(row?.lastRunModel).toBe('ds4-flash');
      expect(typeof row?.lastRunMs).toBe('number');

      // Exactly-once: across both replicas the agent was entered exactly once,
      // and the winner's progress is the row both runners agree on.
      expect(holderRuns.runs + standbyRuns.runs).toBe(1);
      const agree = (
        await request(standby.getHttpServer()).get(`/api/cron/${jobId}`).expect(200)
      ).body as CronJobRow;
      expect(agree).toEqual(row);
      expect(new Date(agree.nextRunAt as string).getTime()).toBeGreaterThan(
        Date.now(),
      );

      await request(standby.getHttpServer()).delete(`/api/cron/${jobId}`).expect(200);
      jobId = '';
    },
    30000,
  );

  it(
    'fails the lease over and fires a due job on the new holder',
    async () => {
      const { holder, standby } = await electHolder([appA, appB]);
      const failoverName = `e2e-cron-failover-${stamp}`;
      const created = (
        await request(standby.getHttpServer())
          .post('/api/cron')
          .send({
            name: failoverName,
            schedule: '* * * * *',
            prompt: 'After takeover',
            maxSteps: 2,
          })
          .expect(201)
      ).body as CronJobRow;
      try {
        // Simulate holder death: stop its ticker (lifecycle hook).
        holder.get(CronService).onModuleDestroy();
        // Standby must take over the lease inside the failover window...
        let takenOver = false;
        const takeoverDeadline = Date.now() + 9000;
        while (Date.now() < takeoverDeadline && !takenOver) {
          const status = (
            await request(standby.getHttpServer())
              .get('/api/cron/scheduler')
              .expect(200)
          ).body as SchedulerStatus;
          if (status.leaseHeld) takenOver = true;
          await sleep(300);
        }
        expect(takenOver).toBe(true);

        // ...and only once it owns the lease should the due job fire.
        await prisma.cronJob.update({
          where: { id: created.id },
          data: { nextRunAt: new Date(Date.now() - 5000) },
        });
        let row: CronJobRow | null = null;
        const fireDeadline = Date.now() + 6000;
        while (Date.now() < fireDeadline && !row) {
          const probe = (
            await request(standby.getHttpServer())
              .get(`/api/cron/${created.id}`)
              .expect(200)
          ).body as CronJobRow;
          if (probe.lastRunStatus === 'done') row = probe;
          await sleep(250);
        }
        expect(row?.lastRunStatus).toBe('done');
        expect(row?.lastRunMessage).toContain('[stub]');
      } finally {
        await request(standby.getHttpServer())
          .delete(`/api/cron/${created.id}`)
          .expect(200);
      }
    },
    30000,
  );
});
