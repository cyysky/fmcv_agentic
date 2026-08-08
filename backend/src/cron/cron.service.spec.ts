import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CronJob, Prisma } from '@prisma/client';
import { BaseAgentService } from '../agent/base-agent.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CronService,
  MAX_RUN_HISTORY,
  MAX_RUN_MESSAGE,
  OVERVIEW_EVENT_LIMIT_MAX,
  OVERVIEW_RECENT_EVENTS,
  nextCronRun,
  truncate,
} from './cron.service';

/** Minimal Prisma double covering cronJob + connection lookups. */
type MockStore = Record<string, jest.Mock>;
function prismaDouble(): {
  cronJob: MockStore;
  connection: MockStore;
  cronSchedulerLease: MockStore;
  cronSchedulerEvent: MockStore;
  cronRun: MockStore;
  $executeRaw: jest.Mock;
} {
  const cronJob: MockStore = {
    create: jest.fn(),
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
    update: jest.fn(async () => row()),
    // Scheduler lease claim/renew + run-result persist succeed; the boot
    // recovery sweep (no id) and cross-instance claim losses return 0.
    updateMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      if (w && !w.id) return { count: 0 };
      if (w && w.lastRunStatus === 'running') return { count: 1 };
      return { count: 1 }; // atomic fire claim
    }),
    delete: jest.fn(async () => ({ id: 'job-1' })),
  };
  const cronSchedulerLease: MockStore = {
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
    updateMany: jest.fn(async () => ({ count: 1 })),
  };
  const cronSchedulerEvent: MockStore = {
    create: jest.fn(async () => ({ id: 'evt-1' })),
    findMany: jest.fn(async () => []),
    groupBy: jest.fn(async () => []),
    count: jest.fn(async () => 0),
  };
  const cronRun: MockStore = {
    create: jest.fn(async () => ({ id: 'run-1' })),
    findMany: jest.fn(async () => []),
    deleteMany: jest.fn(async () => ({ count: 0 })),
    count: jest.fn(async () => 0),
    groupBy: jest.fn(async () => []),
  };
  return {
    cronJob,
    connection: { findUnique: jest.fn(async () => null) },
    cronSchedulerLease,
    cronSchedulerEvent,
    cronRun,
    $executeRaw: jest.fn(async () => 1),
  };
}

function row(over: Partial<CronJob> = {}): CronJob {
  return {
    id: 'job-1',
    name: 'daily-digest',
    schedule: '0 9 * * *',
    taskType: 'agent-turn',
    prompt: 'Summarize the backlog',
    model: null,
    connectionId: null,
    maxSteps: null,
    enabled: true,
    schedulerGroup: 'default',
    lastRunAt: null,
    lastRunStatus: null,
    lastRunMessage: null,
    lastRunModel: null,
    lastRunMs: null,
    nextRunAt: new Date('2099-01-01T00:00:00Z'),
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    ...over,
  };
}

function agentDouble() {
  return { runTurn: jest.fn() };
}

function makeSvc(
  prisma = prismaDouble(),
  agent = agentDouble(),
): {
  service: CronService;
  prisma: ReturnType<typeof prismaDouble>;
  agent: ReturnType<typeof agentDouble>;
} {
  return {
    service: new CronService(
      prisma as unknown as PrismaService,
      agent as unknown as BaseAgentService,
    ),
    prisma,
    agent,
  };
}

const createDto = {
  name: 'daily-digest',
  schedule: '0 9 * * *',
  prompt: 'Summarize the backlog',
};

describe('CronService', () => {
  it('creates a job with normalized fields and a nextRunAt', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    const before = Date.now();
    const created = await service.create(createDto);
    expect(created.id).toBe('job-1');
    expect(prisma.cronJob.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'daily-digest',
          schedule: '0 9 * * *',
          taskType: 'agent-turn',
          prompt: 'Summarize the backlog',
          enabled: true,
        }),
      }),
    );
    const called = prisma.cronJob.create.mock.calls[0][0].data as {
      nextRunAt: Date;
    };
    expect(called.nextRunAt.getTime()).toBeGreaterThan(before);
  });

  it('keeps nextRunAt null and registers the job when created disabled', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(
      row({ enabled: false, nextRunAt: null }),
    );
    const created = await service.create({ ...createDto, enabled: false });
    expect(created.enabled).toBe(false);
    expect(created.nextRunAt).toBeNull();
  });

  it('409s on a duplicate job name', async () => {
    const { service, prisma } = makeSvc();
    const err = new Prisma.PrismaClientKnownRequestError('unique constraint', {
      code: 'P2002',
      clientVersion: 'x',
    });
    prisma.cronJob.create.mockRejectedValue(err);
    await expect(service.create(createDto)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('400s on an invalid cron schedule', async () => {
    const { service } = makeSvc();
    await expect(
      service.create({ ...createDto, schedule: '61 * * * *' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.create({ ...createDto, schedule: 'bad' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('400s when a pinned connection does not exist', async () => {
    const { service } = makeSvc();
    await expect(
      service.create({
        ...createDto,
        connectionId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lists jobs and 404s on unknown ids', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findMany.mockResolvedValue([row()]);
    expect(await service.list()).toHaveLength(1);
    await expect(
      service.get('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates schedule/enabled and slides nextRunAt accordingly', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(row());
    // Update the schedule: nextRunAt is recomputed for the new expression.
    prisma.cronJob.update.mockResolvedValue(
      row({
        schedule: '*/10 * * * *',
        nextRunAt: new Date('2099-02-02T00:00:00Z'),
      }),
    );
    await service.update('job-1', { schedule: '*/10 * * * *' });
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
        data: expect.objectContaining({
          schedule: '*/10 * * * *',
          nextRunAt: expect.any(Date),
        }),
      }),
    );
    // Disable: nextRunAt becomes null.
    prisma.cronJob.update.mockResolvedValue(
      row({ enabled: false, nextRunAt: null }),
    );
    await service.update('job-1', { enabled: false });
    expect(prisma.cronJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ enabled: false, nextRunAt: null }),
      }),
    );
    // Re-enable: a fresh nextRunAt is computed.
    prisma.cronJob.update.mockResolvedValue(
      row({ enabled: true, nextRunAt: new Date('2099-03-03T00:00:00Z') }),
    );
    await service.update('job-1', { enabled: true });
    expect(prisma.cronJob.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          enabled: true,
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  it('400s on an empty update patch', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(row());
    await expect(service.update('job-1', {})).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('runs a job now through the agent and records the result', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.findMany.mockResolvedValue([row()]);
    await service.onModuleInit();
    service.onModuleDestroy();
    prisma.cronJob.findUnique.mockResolvedValue(
      row({
        lastRunStatus: 'done',
        lastRunMessage: 'Backlog summarized',
        lastRunModel: 'ds4-flash',
        lastRunMs: 42,
      }),
    );
    prisma.cronJob.create.mockResolvedValue(row());
    agent.runTurn.mockResolvedValue({
      answer: 'Backlog summarized',
      model: 'ds4-flash',
      steps: 3,
    });
    const created = await service.create(createDto);
    const after = await service.runNow(created.id);
    expect(agent.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Summarize the backlog',
        maxSteps: 10,
      }),
    );
    expect(prisma.cronJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'job-1',
          OR: [{ lastRunStatus: { not: 'running' } }, { lastRunStatus: null }],
        }),
        data: expect.objectContaining({ lastRunStatus: 'running' }),
      }),
    );
    expect(prisma.cronJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1', lastRunStatus: 'running' },
        data: expect.objectContaining({ lastRunStatus: 'done' }),
      }),
    );
    expect(after.lastRunStatus).toBe('done');
  });

  it('records an error result when the agent run fails', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'error', lastRunMessage: 'llm down' }),
    );
    agent.runTurn.mockRejectedValue(new Error('llm down'));
    const created = await service.create(createDto);
    const after = await service.runNow(created.id);
    expect(after.lastRunStatus).toBe('error');
    expect(after.lastRunMessage).toContain('llm down');
    expect(prisma.cronJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastRunMessage: 'llm down' }),
      }),
    );
  });

  it('computes the next run from the DB row when this replica never cached the job', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.findMany.mockResolvedValue([row()]);
    await service.onModuleInit();
    service.onModuleDestroy();
    agent.runTurn.mockResolvedValue({
      answer: 'cross-replica',
      model: 'ds4-flash',
      steps: 1,
    });
    prisma.cronJob.create.mockResolvedValue(row());
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'done', lastRunMessage: 'cross-replica' }),
    );
    const created = await service.create(createDto);
    // This replica fired a job that another replica created: no cache entry.
    (service as unknown as { jobs: Map<string, CronJob> }).jobs.clear();
    await service.runNow(created.id);
    expect(prisma.cronJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          lastRunStatus: 'done',
          nextRunAt: expect.any(Date),
        }),
      }),
    );
  });

  it('reports the local scheduler/lease status', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    await service.create(createDto);
    const status = service.schedulerStatus();
    expect(status).toMatchObject({
      leaseHeld: false,
      leaseGroup: 'default',
      tickIntervalMs: 1000,
      failoverMs: 5000,
      jobCount: 1,
      enabledCount: 1,
      lastTickAt: null,
    });
    expect(status.leaseExpireAt).toBeNull();
  });

  it('persists a run-history row for a terminal result', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.findMany.mockResolvedValue([row()]);
    await service.onModuleInit();
    service.onModuleDestroy();
    agent.runTurn.mockResolvedValue({
      answer: 'Backlog summarized',
      model: 'ds4-flash',
      steps: 2,
    });
    prisma.cronJob.create.mockResolvedValue(row());
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'done', lastRunMessage: 'Backlog summarized' }),
    );
    const created = await service.create(createDto);
    await service.runNow(created.id);
    expect(prisma.cronRun.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          cronJobId: 'job-1',
          status: 'done',
          message: 'Backlog summarized',
          model: 'ds4-flash',
          ms: expect.any(Number) as number,
        }),
      }),
    );
  });

  it('lists run history newest-first with stable tie-break and 404s on an unknown job', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(row());
    prisma.cronRun.findMany.mockResolvedValue([
      { id: 'run-2', cronJobId: 'job-1', status: 'done' },
      { id: 'run-1', cronJobId: 'job-1', status: 'error' },
    ] as never);
    const runs = await service.runs('job-1');
    expect(runs).toHaveLength(2);
    expect(prisma.cronRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cronJobId: 'job-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 20,
        skip: 0,
      }),
    );
    prisma.cronJob.findUnique.mockResolvedValue(null);
    await expect(
      service.runs('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clamps pagination limit and offset for run history', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(row());
    prisma.cronRun.findMany.mockResolvedValue([] as never);
    await service.runs('job-1', 2000, -3);
    expect(prisma.cronRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 100, skip: 0 }),
    );
    await service.runs(
      'job-1',
      'nope' as unknown as number,
      'zzz' as unknown as number,
    );
    expect(prisma.cronRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 20, skip: 0 }),
    );
    await service.runs('job-1', 2, 10);
    expect(prisma.cronRun.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 2, skip: 10 }),
    );
  });

  it('prunes run history beyond the retention cap after a terminal run', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'done', lastRunMessage: 'Pruned' }),
    );
    prisma.cronJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.cronRun.create.mockResolvedValue({ id: 'run-new' });
    prisma.cronRun.findMany.mockResolvedValue([
      { id: 'run-newest' },
      { id: 'run-older' },
    ]);
    agent.runTurn.mockResolvedValue({
      answer: 'Done',
      model: 'ds4-flash',
      steps: 1,
    });
    await service.runNow('job-1');
    expect(prisma.cronRun.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cronJobId: 'job-1' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
        take: MAX_RUN_HISTORY,
      }),
    );
    expect(prisma.cronRun.deleteMany).toHaveBeenCalledWith({
      where: {
        cronJobId: 'job-1',
        id: { notIn: ['run-newest', 'run-older'] },
      },
    });
  });

  it('aggregates the cluster-wide scheduler overview', async () => {
    const { service, prisma } = makeSvc();
    const future = new Date(Date.now() + 60_000);
    const past = new Date(Date.now() - 60_000);
    const eventAt = new Date('2026-08-08T12:00:00Z');
    prisma.cronSchedulerLease.findMany.mockResolvedValue([
      {
        id: 'default',
        schedulerGroup: 'default',
        owner: 'replica-a',
        expireAt: future,
        createdAt: past,
        updatedAt: past,
      },
      {
        id: 'e2e',
        schedulerGroup: 'e2e',
        owner: 'replica-b',
        expireAt: past,
        createdAt: past,
        updatedAt: past,
      },
    ]);
    prisma.cronRun.count.mockResolvedValueOnce(7).mockResolvedValueOnce(3);
    prisma.cronRun.groupBy
      .mockResolvedValueOnce([
        { status: 'done', _count: { _all: 6 }, _avg: { ms: 120 } },
        { status: 'error', _count: { _all: 1 }, _avg: { ms: 3000 } },
      ])
      .mockResolvedValueOnce([
        { cronJobId: 'job-1', _count: { _all: 5 }, _avg: { ms: 100 } },
        { cronJobId: 'job-2', _count: { _all: 2 }, _avg: { ms: 200 } },
      ]);
    // First overview call: job ownership rows (Round 81); second call: the
    // busiest jobs' names for the per-job stats.
    prisma.cronJob.findMany
      .mockResolvedValueOnce([
        {
          schedulerGroup: 'default',
          enabled: true,
          lastRunStatus: null,
          nextRunAt: past,
        },
        {
          schedulerGroup: 'default',
          enabled: true,
          lastRunStatus: 'running',
          nextRunAt: past,
        },
        {
          schedulerGroup: 'e2e',
          enabled: false,
          lastRunStatus: 'done',
          nextRunAt: null,
        },
      ])
      .mockResolvedValueOnce([
        { id: 'job-1', name: 'daily-digest' },
        { id: 'job-2', name: 'weekly-report' },
      ]);
    prisma.cronSchedulerEvent.findMany.mockResolvedValue([
      {
        id: 'evt-1',
        schedulerGroup: 'e2e',
        owner: 'replica-c',
        event: 'acquired',
        previousOwner: 'replica-b',
        createdAt: eventAt,
      },
    ]);
    prisma.cronSchedulerEvent.groupBy.mockResolvedValue([
      { schedulerGroup: 'default', _count: { _all: 4 } },
      { schedulerGroup: 'e2e', _count: { _all: 1 } },
    ]);
    const overview = await service.overview();
    expect(overview.leases).toEqual([
      expect.objectContaining({
        group: 'default',
        owner: 'replica-a',
        held: true,
      }),
      expect.objectContaining({
        group: 'e2e',
        owner: 'replica-b',
        held: false,
      }),
    ]);
    expect(overview.runs.total).toBe(7);
    expect(overview.runs.lastHour).toBe(3);
    expect(overview.runs.byStatus).toEqual([
      { status: 'done', count: 6, avgMs: 120 },
      { status: 'error', count: 1, avgMs: 3000 },
    ]);
    expect(overview.runs.perJob).toEqual([
      { cronJobId: 'job-1', name: 'daily-digest', runCount: 5, avgMs: 100 },
      { cronJobId: 'job-2', name: 'weekly-report', runCount: 2, avgMs: 200 },
    ]);
    expect(overview.events).toEqual([
      {
        id: 'evt-1',
        group: 'e2e',
        event: 'acquired',
        owner: 'replica-c',
        previousOwner: 'replica-b',
        createdAt: '2026-08-08T12:00:00.000Z',
      },
    ]);
    expect(overview.eventGroups).toEqual(['default', 'e2e']);
    expect(overview.eventStats).toEqual([
      { group: 'default', total: 4 },
      { group: 'e2e', total: 1 },
    ]);
    expect(overview.jobGroups).toEqual([
      { group: 'default', jobs: 2, enabled: 2, running: 1, due: 1 },
      { group: 'e2e', jobs: 1, enabled: 0, running: 0, due: 0 },
    ]);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: OVERVIEW_RECENT_EVENTS,
      }),
    );
    expect(prisma.cronSchedulerEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['schedulerGroup'],
        _count: { _all: true },
        orderBy: { schedulerGroup: 'asc' },
      }),
    );
    expect(prisma.cronRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['status'],
        _count: { _all: true },
        _avg: { ms: true },
      }),
    );
    expect(prisma.cronRun.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['cronJobId'],
        orderBy: { _count: { cronJobId: 'desc' } },
        take: 5,
      }),
    );
  });

  it('filters overview transition events per lease group', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronSchedulerEvent.groupBy.mockResolvedValue([
      { schedulerGroup: 'default', _count: { _all: 4 } },
      { schedulerGroup: 'e2e', _count: { _all: 2 } },
    ]);
    const overview = await service.overview('e2e');
    expect(overview.events).toEqual([]);
    expect(overview.eventGroups).toEqual(['default', 'e2e']);
    expect(overview.eventStats).toEqual([
      { group: 'default', total: 4 },
      { group: 'e2e', total: 2 },
    ]);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schedulerGroup: 'e2e' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: OVERVIEW_RECENT_EVENTS,
      }),
    );
  });

  it('applies and clamps the overview transition window limit', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronSchedulerEvent.groupBy.mockResolvedValue([
      { schedulerGroup: 'default', _count: { _all: 13 } },
    ]);
    prisma.cronSchedulerEvent.findMany.mockResolvedValue(
      Array.from({ length: 13 }, (_, i) => ({
        id: `evt-${i}`,
        schedulerGroup: 'default',
        owner: `replica-${i}`,
        event: 'acquired',
        previousOwner: i ? `replica-${i - 1}` : null,
        createdAt: new Date('2026-08-08T12:00:00Z'),
      })),
    );
    await service.overview('default', 13);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { schedulerGroup: 'default' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 13,
      }),
    );
    await service.overview(undefined, 0);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: OVERVIEW_RECENT_EVENTS }),
    );
    await service.overview(undefined, -5);
    // Negative values clamp to the 1-event floor rather than the default.
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: 1 }),
    );
    await service.overview(undefined, 500);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: OVERVIEW_EVENT_LIMIT_MAX }),
    );
    await service.overview(undefined, Number.NaN);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({ take: OVERVIEW_RECENT_EVENTS }),
    );
  });

  describe('overviewEvents pagination (Round 78)', () => {
    it('pages newest-first with limit/offset and reports the group total', async () => {
      const { service, prisma } = makeSvc();
      prisma.cronSchedulerEvent.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => ({
          id: `evt-${i}`,
          schedulerGroup: 'e2e',
          owner: `replica-${i}`,
          event: 'acquired',
          previousOwner: i ? `replica-${i - 1}` : null,
          createdAt: new Date('2026-08-08T12:00:00Z'),
        })),
      );
      prisma.cronSchedulerEvent.count.mockResolvedValue(14);
      const page = await service.overviewEvents('e2e', 5, 5);
      expect(page.group).toBe('e2e');
      expect(page.total).toBe(14);
      expect(page.offset).toBe(5);
      expect(page.limit).toBe(5);
      expect(page.events).toEqual(
        Array.from({ length: 5 }, (_, i) => ({
          id: `evt-${i}`,
          group: 'e2e',
          event: 'acquired',
          owner: `replica-${i}`,
          previousOwner: i ? `replica-${i - 1}` : null,
          createdAt: '2026-08-08T12:00:00.000Z',
        })),
      );
      expect(prisma.cronSchedulerEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { schedulerGroup: 'e2e' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 5,
          skip: 5,
        }),
      );
      expect(prisma.cronSchedulerEvent.count).toHaveBeenCalledWith({
        where: { schedulerGroup: 'e2e' },
      });
    });

    it('clamps and defaults limit/offset like the overview window', async () => {
      const { service, prisma } = makeSvc();
      prisma.cronSchedulerEvent.count.mockResolvedValue(0);
      await service.overviewEvents(undefined, 0, -3);
      expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: {},
          take: OVERVIEW_RECENT_EVENTS,
          skip: 0,
        }),
      );
      await service.overviewEvents(undefined, 500, Number.NaN);
      expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          take: OVERVIEW_EVENT_LIMIT_MAX,
          skip: 0,
        }),
      );
      await service.overviewEvents('g', -2, 7.9);
      expect(prisma.cronSchedulerEvent.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({ take: 1, skip: 7 }),
      );
      const page = await service.overviewEvents(undefined, 13, 0);
      expect(page.group).toBeNull();
      expect(page.total).toBe(0);
      expect(page.events).toEqual([]);
      expect(prisma.cronSchedulerEvent.count).toHaveBeenCalledWith({
        where: {},
      });
    });
  });

  it('records an acquired lease event with the previous owner on takeover', async () => {
    const { service, prisma } = makeSvc();
    // Startup: another replica already holds the lease, so this one stands by.
    prisma.$executeRaw.mockResolvedValue(0);
    await service.onModuleInit();
    service.onModuleDestroy();
    // The standby learns the current owner, then its claim wins the takeover.
    prisma.cronSchedulerLease.findUnique.mockResolvedValue({
      owner: 'replica-a',
    });
    prisma.$executeRaw.mockResolvedValue(1);
    prisma.cronJob.findMany.mockResolvedValue([]);
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronSchedulerEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.cronSchedulerEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          schedulerGroup: 'default',
          event: 'acquired',
          previousOwner: 'replica-a',
          owner: expect.any(String) as string,
        }),
      }),
    );
    // Ordinary renewal: held before and after, so no transition event.
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronSchedulerEvent.create).toHaveBeenCalledTimes(1);
  });

  it('records a lost lease event when a renewal races away to another replica', async () => {
    const { service, prisma } = makeSvc();
    // Startup: this replica wins the lease and becomes the holder.
    prisma.$executeRaw.mockResolvedValue(1);
    await service.onModuleInit();
    service.onModuleDestroy();
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronSchedulerEvent.create).not.toHaveBeenCalled();
    // The next renewal loses (another replica took the lease): a `lost`
    // event records this replica as the previous holder.
    prisma.$executeRaw.mockResolvedValue(0);
    prisma.cronJob.findMany.mockResolvedValue([]);
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronSchedulerEvent.create).toHaveBeenCalledTimes(1);
    const call = prisma.cronSchedulerEvent.create.mock.calls[0][0] as {
      data: {
        schedulerGroup: string;
        owner: string;
        event: string;
        previousOwner: string | null;
      };
    };
    expect(call.data.event).toBe('lost');
    expect(call.data.schedulerGroup).toBe('default');
    expect(call.data.previousOwner).toBe(call.data.owner);
  });

  it('rejects a concurrent run after another replica claimed the job', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    // First claim succeeds; a concurrent replica's claim of the same row then
    // sees lastRunStatus=running and loses the atomic updateMany.
    let claimed = false;
    prisma.cronJob.updateMany.mockImplementationOnce(async () => {
      claimed = true;
      return { count: 1 };
    });
    prisma.cronJob.updateMany.mockImplementationOnce(async () => ({
      count: claimed ? 0 : 1,
    }));
    agent.runTurn.mockResolvedValue({
      answer: 'slow',
      model: 'ds4-flash',
      steps: 1,
    });
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'done', lastRunMessage: 'slow' }),
    );
    const created = await service.create(createDto);
    const first = service.runNow(created.id);
    await expect(service.runNow(created.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await first;
    expect(agent.runTurn).toHaveBeenCalledTimes(1);
  });

  it('deletes a job and rejects deleting one that is running', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    prisma.cronJob.findUnique.mockResolvedValue(row());
    let release!: () => void;
    agent.runTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ answer: 'slow', model: 'ds4-flash' });
        }),
    );
    const created = await service.create(createDto);
    const first = service.runNow(created.id);
    await expect(service.delete(created.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    release();
    await first;
    await expect(service.delete(created.id)).resolves.toEqual({
      deleted: true,
    });
    prisma.cronJob.findUnique.mockResolvedValue(null);
    await expect(
      service.delete('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('only the lease holder fires due scheduler ticks', async () => {
    const { service, prisma, agent } = makeSvc();
    // First acquire (startup): lease already held by another replica. Then
    // standby renewals keep losing; after the holder dies, this replica's
    // conditional INSERT ... ON CONFLICT succeeds (count 1).
    prisma.$executeRaw.mockResolvedValue(0);
    await service.onModuleInit();
    service.onModuleDestroy();
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronJob.findMany).toHaveBeenCalledTimes(1); // startup load only
    prisma.$executeRaw.mockResolvedValueOnce(1);
    prisma.cronJob.findMany.mockResolvedValue([]);
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(agent.runTurn).not.toHaveBeenCalled(); // fire is async; claim path
    expect(prisma.cronJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          schedulerGroup: 'default',
          enabled: true,
          OR: [{ lastRunStatus: { not: 'running' } }, { lastRunStatus: null }],
        }),
      }),
    );
  });

  describe('CRON_LEASE_GROUP job ownership (Round 80)', () => {
    const original = process.env.CRON_LEASE_GROUP;

    afterEach(() => {
      if (original === undefined) {
        delete process.env.CRON_LEASE_GROUP;
      } else {
        process.env.CRON_LEASE_GROUP = original;
      }
    });

    it('stamps create with the current lease group', async () => {
      process.env.CRON_LEASE_GROUP = 'deploy-a';
      const { service, prisma } = makeSvc();
      prisma.cronJob.create.mockResolvedValue(
        row({ schedulerGroup: 'deploy-a' }),
      );
      const created = await service.create(createDto);
      expect(prisma.cronJob.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ schedulerGroup: 'deploy-a' }),
        }),
      );
      expect(created.schedulerGroup).toBe('deploy-a');
    });

    it('scopes boot recovery, the startup cache, and the due scan to the owner group', async () => {
      process.env.CRON_LEASE_GROUP = 'deploy-a';
      const { service, prisma } = makeSvc();
      prisma.$executeRaw.mockResolvedValue(1);
      prisma.cronJob.findMany.mockResolvedValue([
        row({ id: 'j1', lastRunStatus: 'running' }),
      ]);
      await service.onModuleInit();
      service.onModuleDestroy();
      // Only deploy-a's interrupted rows are swept on boot.
      expect(prisma.cronJob.updateMany).toHaveBeenCalledWith({
        where: { lastRunStatus: 'running', schedulerGroup: 'deploy-a' },
        data: expect.objectContaining({ lastRunStatus: 'error' }),
      });
      // The startup cache load never pulls another deployment's jobs in.
      expect(prisma.cronJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { schedulerGroup: 'deploy-a' } }),
      );
      // The due scan carries the owner filter, so a cross-group job can
      // never be returned (and therefore never fired) by this deployment.
      prisma.cronJob.findMany.mockResolvedValue([]);
      await (service as unknown as { tick(): Promise<void> }).tick();
      expect(prisma.cronJob.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            schedulerGroup: 'deploy-a',
            enabled: true,
          }),
        }),
      );
    });
  });

  it('rejects deleting a job whose run is stored as running on another replica', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'running' }),
    );
    prisma.cronJob.create.mockResolvedValue(row());
    const created = await service.create(createDto);
    await expect(service.delete(created.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
  it('recovers stale running jobs and re-schedules enabled jobs on startup', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.findMany.mockResolvedValue([
      row({ id: 'j1', enabled: true, nextRunAt: null }),
      row({ id: 'j2', enabled: false, nextRunAt: null }),
    ]);
    prisma.cronJob.update.mockResolvedValue(
      row({ id: 'j1', nextRunAt: new Date('2099-01-01T00:00:00Z') }),
    );
    await service.onModuleInit();
    expect(prisma.cronJob.updateMany).toHaveBeenCalledWith({
      where: { lastRunStatus: 'running', schedulerGroup: 'default' },
      data: expect.objectContaining({ lastRunStatus: 'error' }),
    });
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'j1' } }),
    );
    service.onModuleDestroy();
  });

  it('computes the next cron occurrence via nextCronRun', () => {
    const from = new Date('2026-08-08T00:02:30Z');
    const next = nextCronRun('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-08-08T00:05:00.000Z');
    expect(() => nextCronRun('61 * * * *', from)).toThrow(BadRequestException);
  });
});

describe('truncate', () => {
  it('returns null for empty, whitespace-only, and missing messages', () => {
    expect(truncate(undefined, MAX_RUN_MESSAGE)).toBeNull();
    expect(truncate(null, MAX_RUN_MESSAGE)).toBeNull();
    expect(truncate('', MAX_RUN_MESSAGE)).toBeNull();
    expect(truncate('   \n\t ', MAX_RUN_MESSAGE)).toBeNull();
  });

  it('leaves messages at or under the cap unchanged', () => {
    expect(truncate('short answer', 500)).toBe('short answer');
    expect(truncate('x'.repeat(500), 500)).toBe('x'.repeat(500));
  });

  it('caps long text at max code units with the ellipsis inside the cap', () => {
    const out = truncate('x'.repeat(501), 500);
    expect(out).toBe('x'.repeat(499) + '…');
    expect(out!.length).toBe(500);
  });

  it('collapses inner whitespace before capping', () => {
    expect(truncate('a  \n b', 500)).toBe('a b');
  });

  it('drops an emoji cleanly when it starts at the cut boundary', () => {
    // 499 'a' units, then 😀 (2 units at indexes 499-500) -> 501 units.
    const msg = 'a'.repeat(499) + '😀';
    expect(truncate(msg, 500)).toBe('a'.repeat(499) + '…');
  });

  it('backs the cut off when a surrogate pair straddles it', () => {
    // High surrogate at index 498, low at 499; the 500-cap cut would split
    // them, so both units are dropped and the ellipsis takes their place.
    const straddle = 'a'.repeat(498) + '😀x';
    expect(truncate(straddle, 500)).toBe('a'.repeat(498) + '…');
  });

  it('keeps a leading emoji intact when the cut lands later in the string', () => {
    const msg = '😀' + 'x'.repeat(499);
    const out = truncate(msg, 500);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(500);
    expect(out!.startsWith('😀')).toBe(true);
    expect(out!.endsWith('…')).toBe(true);
  });

  it('handles degenerate caps without producing unpaired surrogates', () => {
    expect(truncate('😀😀😀', 1)).toBe('…');
    expect(truncate('abc', 0)).toBeNull();
    expect(truncate('abc', -1)).toBeNull();
  });
});

describe('CRON_SCHEDULER_ENABLED switch (Round 79)', () => {
  const original = process.env.CRON_SCHEDULER_ENABLED;

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CRON_SCHEDULER_ENABLED;
    } else {
      process.env.CRON_SCHEDULER_ENABLED = original;
    }
  });

  it('disables lease/tick/recovery and reports enabled:false', async () => {
    process.env.CRON_SCHEDULER_ENABLED = 'false';
    const { service, prisma } = makeSvc();
    await service.onModuleInit();
    const status = service.schedulerStatus();
    expect(status.enabled).toBe(false);
    expect(status.leaseHeld).toBe(false);
    expect(status.leaseExpireAt).toBeNull();
    expect(status.lastTickAt).toBeNull();
    expect(status.jobCount).toBe(0);
    // No legacy-lease cleanup, no interrupted-run sweep, no cache load.
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.cronJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.cronJob.findMany).not.toHaveBeenCalled();
    // A stray tick must not scan or fire due jobs.
    await (service as unknown as { tick(): Promise<void> }).tick();
    expect(prisma.cronJob.findMany).not.toHaveBeenCalled();
    service.onModuleDestroy();
  });

  it('is enabled by default and for explicit true/case-insensitive values', async () => {
    delete process.env.CRON_SCHEDULER_ENABLED;
    expect(makeSvc().service.schedulerStatus().enabled).toBe(true);
    process.env.CRON_SCHEDULER_ENABLED = 'true';
    expect(makeSvc().service.schedulerStatus().enabled).toBe(true);
    process.env.CRON_SCHEDULER_ENABLED = 'TRUE';
    expect(makeSvc().service.schedulerStatus().enabled).toBe(true);
    process.env.CRON_SCHEDULER_ENABLED = 'FALSE';
    expect(makeSvc().service.schedulerStatus().enabled).toBe(false);
  });
});
