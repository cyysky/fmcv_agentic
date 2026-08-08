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
  OVERVIEW_RECENT_EVENTS,
  nextCronRun,
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
    prisma.cronJob.findMany.mockResolvedValue([
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
      { schedulerGroup: 'default' },
      { schedulerGroup: 'e2e' },
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
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: OVERVIEW_RECENT_EVENTS,
      }),
    );
    expect(prisma.cronSchedulerEvent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        by: ['schedulerGroup'],
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
      { schedulerGroup: 'default' },
      { schedulerGroup: 'e2e' },
    ]);
    const overview = await service.overview('e2e');
    expect(overview.events).toEqual([]);
    expect(overview.eventGroups).toEqual(['default', 'e2e']);
    expect(prisma.cronSchedulerEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { schedulerGroup: 'e2e' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: OVERVIEW_RECENT_EVENTS,
      }),
    );
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
          enabled: true,
          OR: [{ lastRunStatus: { not: 'running' } }, { lastRunStatus: null }],
        }),
      }),
    );
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
      where: { lastRunStatus: 'running' },
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
