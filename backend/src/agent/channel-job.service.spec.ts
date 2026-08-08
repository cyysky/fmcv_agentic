import { ChannelJobService } from './channel-job.service';

function prismaDouble() {
  const upsert = jest.fn(async () => ({ id: 'job' }));
  const findUnique = jest.fn(async () => null);
  const findFirst = jest.fn(async () => null);
  const findMany = jest.fn(async () => []);
  const deleteMany = jest.fn(async () => ({ count: 0 }));
  return {
    channelRun: { upsert, findUnique, findFirst, findMany, deleteMany },
    _upsert: upsert,
    _findUnique: findUnique,
    _findFirst: findFirst,
    _findMany: findMany,
    _deleteMany: deleteMany,
  };
}

const makeSvc = (
  channels: ReturnType<typeof channelsDouble>,
  agent: ReturnType<typeof agentDouble>,
  prisma = prismaDouble(),
) => new ChannelJobService(channels as never, agent as never, prisma as never);

function channelsDouble() {
  return {
    prepareChannelTurn: jest.fn(async () => ({
      channel: { slug: 'team', projectName: 'team' },
      thread: '[you] hello',
    })),
    ensureSubChannel: jest.fn(async (parentId: string, agentName: string) => ({
      id: `sub-${agentName}`,
      parentId,
      agentName,
    })),
    postMessage: jest.fn(async () => ({ id: 'm1' })),
  };
}

function agentDouble() {
  return { runChannelTurnStreaming: jest.fn() };
}

function streamingResult(opts: Record<string, unknown>) {
  return { answer: 'done', steps: 2, trace: [] };
}

describe('ChannelJobService', () => {
  it('runs a streaming turn and publishes the final answer', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    (agent.runChannelTurnStreaming as jest.Mock).mockImplementation(
      (opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: 'status', text: 'Agent started' });
        opts.onEvent({ type: 'answer', text: 'done', step: 2 });
        return Promise.resolve(streamingResult(opts));
      },
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'work',
      persistHuman: false,
    });
    await job.process;

    expect(job.status).toBe('done');
    expect(job.answer).toBe('done');
    expect(job.events.map((e) => e.type)).toContain('answer');
    expect(job.events.map((e) => e.type)).toContain('status');
    expect(channels.postMessage).toHaveBeenCalledWith(
      'ch1',
      'agent',
      'coder',
      'done',
      [],
    );
    // Debug trace went to the sub-channel.
    expect(channels.ensureSubChannel).toHaveBeenCalledWith('ch1', 'coder');
  });

  it('marks an error job and emits exactly one error event', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    (agent.runChannelTurnStreaming as jest.Mock).mockRejectedValue(
      new Error('llm down'),
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' });
    await job.process;

    expect(job.status).toBe('error');
    expect(job.error).toBe('llm down');
    expect(job.events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('stop() emits ONE stopped event and the run does not duplicate it', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    let release: () => void = () => {};
    const gate = new Promise<{ answer: string; steps: number; trace: unknown[] }>(
      (resolve) => {
        release = () => resolve({ answer: '[stopped]', steps: 0, trace: [] });
      },
    );
    (agent.runChannelTurnStreaming as jest.Mock).mockImplementation(
      (opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: 'status', text: 'Agent started' });
        return gate;
      },
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' });
    await new Promise((r) => setImmediate(r));
    svc.stop(job.id, 'ch1');
    expect(job.status).toBe('stopped');
    expect(job.events.filter((e) => e.type === 'stopped')).toHaveLength(1);

    release();
    await job.process;
    // Still exactly one stopped event, and the status stays stopped.
    expect(job.status).toBe('stopped');
    expect(job.events.filter((e) => e.type === 'stopped')).toHaveLength(1);
  });

  it('recovers interrupted runs as stopped and serves them from history', async () => {
    const prisma = prismaDouble();
    const staleRow = {
      id: 'job-recovered',
      channelId: 'ch1',
      agentName: 'coder',
      status: 'running',
      events: [{ type: 'status', ts: '2026-08-06T00:00:00.000Z', text: 'started' }],
      answer: null,
      steps: null,
      error: null,
      maxSteps: 3,
      startedAt: new Date('2026-08-06T00:00:00.000Z'),
      finishedAt: null,
      createdAt: new Date('2026-08-06T00:00:00.000Z'),
      updatedAt: new Date('2026-08-06T00:00:00.000Z'),
    } as Record<string, unknown>;
    (prisma._findMany as jest.Mock).mockResolvedValue([staleRow]);

    const svc = makeSvc(channelsDouble(), agentDouble(), prisma);
    await svc.onModuleInit();

    // The interrupted run is honest: terminal stopped + one explanatory event.
    const job = svc.get('job-recovered');
    expect(job.status).toBe('stopped');
    expect(job.events.map((e) => e.type)).toContain('stopped');
    expect(job.events[job.events.length - 1].text).toContain('restart');
    expect(prisma._upsert).toHaveBeenCalled();

    // A history lookup that is not in memory falls back to Postgres.
    (prisma._findFirst as jest.Mock).mockResolvedValue({
      ...staleRow,
      status: 'done',
      answer: 'hello',
      steps: 1,
      finishedAt: new Date('2026-08-06T00:01:00.000Z'),
    });
    const latest = await svc.latestFor('other', 'coder');
    expect(latest?.status).toBe('done');
    expect(latest?.answer).toBe('hello');

    (prisma._findUnique as jest.Mock).mockResolvedValue({
      ...staleRow,
      status: 'error',
      error: 'llm down',
      answer: null,
    });
    const snap = await svc.snapshot('unknown-in-memory');
    expect(snap?.status).toBe('error');
    expect(snap?.error).toBe('llm down');
  });

  it('persists terminal state via channelRun upserts on create/run/stop', async () => {
    const prisma = prismaDouble();
    const channels = channelsDouble();
    const agent = agentDouble();
    (agent.runChannelTurnStreaming as jest.Mock).mockResolvedValue({
      answer: 'ok',
      steps: 1,
      trace: [],
    });
    const svc = makeSvc(channels, agent, prisma);
    const job = svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' });
    await job.process;

    expect(job.status).toBe('done');
    // upsert: once on create, once at terminal (done) — plus channelPost etc.
    expect(prisma._upsert).toHaveBeenCalledTimes(2);
    const updateArg = (prisma._upsert as jest.Mock).mock.calls[1][0] as {
      update: { status: string; answer: string; finishedAt: Date | null };
    };
    expect(updateArg.update.status).toBe('done');
    expect(updateArg.update.answer).toBe('ok');
    expect(updateArg.update.finishedAt).not.toBeNull();
  });

  it('rejects new jobs while a channel tree is being deleted', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    (agent.runChannelTurnStreaming as jest.Mock).mockResolvedValue({
      answer: 'done',
      steps: 0,
      trace: [],
    });
    const svc = makeSvc(channels, agent);

    svc.beginChannelDelete(['ch1']);

    // A job for the deleted channel cannot start...
    expect(() =>
      svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' }),
    ).toThrow('being deleted');

    // ...but other channels are unaffected.
    const other = svc.create({ channelId: 'ch2', agentName: 'coder', message: 'x' });
    expect(other.status).toBe('running');
    await other.process;

    // After deletion finishes, the channel accepts jobs again.
    svc.endChannelDelete(['ch1']);
    const again = svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' });
    expect(again.status).toBe('running');
    await again.process;
    expect(again.status).toBe('done');
  });

  it('queues interjections without blocking and drains them on read', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    let capturedInterject: (() => string[]) | null = null;
    (agent.runChannelTurnStreaming as jest.Mock).mockImplementation(
      (opts: { interject: () => string[]; onEvent: (e: unknown) => void }) => {
        capturedInterject = opts.interject;
        opts.onEvent({ type: 'status', text: 'Agent started' });
        return Promise.resolve({ answer: 'ok', steps: 0, trace: [] });
      },
    );
    const svc = makeSvc(channels, agent);
    const job = svc.create({ channelId: 'ch1', agentName: 'coder', message: 'x' });

    svc.interject(job.id, 'ch1', 'do it differently');
    expect((job as unknown as { mailbox: string[] }).mailbox).toEqual([
      'do it differently',
    ]);
    await job.process;
    expect(capturedInterject).not.toBeNull();
    // The interject() getter drains the mailbox on read.
    expect(capturedInterject!()).toEqual(['do it differently']);
    expect((job as unknown as { mailbox: string[] }).mailbox).toEqual([]);
  });
});
