import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CronJob, Prisma } from '@prisma/client';
import { BaseAgentService } from '../agent/base-agent.service';
import { PrismaService } from '../prisma/prisma.service';
import { CronService, nextCronRun } from './cron.service';

/** Minimal Prisma double covering cronJob + connection lookups. */
type MockStore = Record<string, jest.Mock>;
function prismaDouble(): { cronJob: MockStore; connection: MockStore } {
  const cronJob: MockStore = {
    create: jest.fn(),
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
    update: jest.fn(async () => row()),
    updateMany: jest.fn(async () => ({ count: 0 })),
    delete: jest.fn(async () => ({ id: 'job-1' })),
  };
  return {
    cronJob,
    connection: { findUnique: jest.fn(async () => null) },
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
): { service: CronService; prisma: ReturnType<typeof prismaDouble>; agent: ReturnType<typeof agentDouble> } {
  return {
    service: new CronService(prisma as unknown as PrismaService, agent as unknown as BaseAgentService),
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
    const called = prisma.cronJob.create.mock.calls[0][0].data as { nextRunAt: Date };
    expect(called.nextRunAt.getTime()).toBeGreaterThan(before);
  });

  it('keeps nextRunAt null and registers the job when created disabled', async () => {
    const { service, prisma } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row({ enabled: false, nextRunAt: null }));
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
      row({ schedule: '*/10 * * * *', nextRunAt: new Date('2099-02-02T00:00:00Z') }),
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
    await service.onModuleDestroy();
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
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'job-1' },
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
    expect(prisma.cronJob.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastRunMessage: 'llm down' }),
      }),
    );
  });

  it('rejects a concurrent run of the same job', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    let release!: () => void;
    agent.runTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ answer: 'slow', model: 'ds4-flash' });
        }),
    );
    prisma.cronJob.findUnique.mockResolvedValue(
      row({ lastRunStatus: 'done', lastRunMessage: 'slow' }),
    );
    const created = await service.create(createDto);
    const first = service.runNow(created.id);
    await expect(service.runNow(created.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    release();
    await first;
  });

  it('deletes a job and rejects deleting one that is running', async () => {
    const { service, prisma, agent } = makeSvc();
    prisma.cronJob.create.mockResolvedValue(row());
    prisma.cronJob.findUnique.mockResolvedValue(row());
    let release!: () => void;
    agent.runTurn.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ answer: 'slow', model: 'ds4-flash' });
        }),
    );
    const created = await service.create(createDto);
    const first = service.runNow(created.id);
    await expect(service.delete(created.id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    release();
    await first;
    await expect(service.delete(created.id)).resolves.toEqual({ deleted: true });
    prisma.cronJob.findUnique.mockResolvedValue(null);
    await expect(
      service.delete('00000000-0000-4000-8000-000000000000'),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    await service.onModuleDestroy();
  });

  it('computes the next cron occurrence via nextCronRun', () => {
    const from = new Date('2026-08-08T00:02:30Z');
    const next = nextCronRun('*/5 * * * *', from);
    expect(next.toISOString()).toBe('2026-08-08T00:05:00.000Z');
    expect(() => nextCronRun('61 * * * *', from)).toThrow(BadRequestException);
  });
});
