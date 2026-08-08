import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/prisma/prisma.service';
import { bootstrapApp } from './test-app';

interface CronJobRow {
  id: string;
  name: string;
  schedule: string;
  enabled: boolean;
  lastRunStatus: string | null;
  lastRunMessage: string | null;
  nextRunAt: string | null;
}

interface SchedulerStatus {
  enabled: boolean;
  leaseHeld: boolean;
  leaseGroup: string;
  leaseExpireAt: string | null;
  lastTickAt: string | null;
  jobCount: number;
  enabledCount: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Cron scheduler disabled mode (e2e, CRON_SCHEDULER_ENABLED=false)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const stamp = Date.now().toString(36);
  const leaseGroup = `e2e-disabled-${stamp}`;
  const jobName = `e2e-cron-disabled-${stamp}`;
  const originalGroup = process.env.CRON_LEASE_GROUP;
  const originalEnabled = process.env.CRON_SCHEDULER_ENABLED;
  let jobId = '';

  beforeAll(async () => {
    process.env.CRON_LEASE_GROUP = leaseGroup;
    process.env.CRON_SCHEDULER_ENABLED = 'false';
    app = await bootstrapApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await prisma.cronJob
      .deleteMany({ where: { name: jobName } })
      .catch(() => undefined);
    await app?.close();
    await prisma.$executeRaw`DELETE FROM cron_scheduler_leases WHERE "schedulerGroup" = ${leaseGroup}`.catch(
      () => undefined,
    );
    await prisma.$executeRaw`DELETE FROM cron_scheduler_events WHERE "schedulerGroup" = ${leaseGroup}`.catch(
      () => undefined,
    );
    if (originalGroup === undefined) {
      delete process.env.CRON_LEASE_GROUP;
    } else {
      process.env.CRON_LEASE_GROUP = originalGroup;
    }
    if (originalEnabled === undefined) {
      delete process.env.CRON_SCHEDULER_ENABLED;
    } else {
      process.env.CRON_SCHEDULER_ENABLED = originalEnabled;
    }
  });

  it('reports enabled:false, never acquires a lease, and never fires a due job', async () => {
    const status = (
      await request(app.getHttpServer()).get('/api/cron/scheduler').expect(200)
    ).body as SchedulerStatus;
    expect(status.enabled).toBe(false);
    expect(status.leaseHeld).toBe(false);
    expect(status.leaseExpireAt).toBeNull();
    expect(status.lastTickAt).toBeNull();
    expect(status.leaseGroup).toBe(leaseGroup);
    // No lease row may ever appear for this group — not even after the
    // tick interval that an enabled replica would have used to claim it.
    await sleep(1300);
    expect(
      await prisma.cronSchedulerLease.findUnique({ where: { id: leaseGroup } }),
    ).toBeNull();

    // A job forced due stays unfired: no ticker, no background agent turn.
    const due = (
      await request(app.getHttpServer())
        .post('/api/cron')
        .send({
          name: jobName,
          schedule: '* * * * *',
          prompt: 'Stay put',
          maxSteps: 2,
        })
        .expect(201)
    ).body as CronJobRow;
    jobId = due.id;
    await prisma.cronJob.update({
      where: { id: jobId },
      data: { nextRunAt: new Date(Date.now() - 2000) },
    });
    await sleep(2500);
    const unfired = await prisma.cronJob.findUnique({ where: { id: jobId } });
    expect(unfired?.lastRunStatus).toBeNull();
    expect(unfired?.lastRunMessage).toBeNull();
    expect(await prisma.cronRun.count({ where: { cronJobId: jobId } })).toBe(0);

    // API-only mode keeps manual execution: run-now fires exactly once.
    const ran = (
      await request(app.getHttpServer())
        .post(`/api/cron/${jobId}/run`)
        .expect(201)
    ).body as CronJobRow;
    expect(ran.lastRunStatus).toBe('done');
    expect(ran.lastRunMessage).toBeTruthy();
    expect(await prisma.cronRun.count({ where: { cronJobId: jobId } })).toBe(1);
  });
});
