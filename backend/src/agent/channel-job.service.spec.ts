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

function streamingResult() {
  return { answer: 'done', steps: 2, trace: [] };
}

describe('ChannelJobService', () => {
  it('runs a streaming turn and publishes the final answer', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockImplementation(
      (opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: 'status', text: 'Agent started' });
        opts.onEvent({ type: 'answer', text: 'done', step: 2 });
        return Promise.resolve(streamingResult());
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
    agent.runChannelTurnStreaming.mockRejectedValue(new Error('llm down'));
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;

    expect(job.status).toBe('error');
    expect(job.error).toBe('llm down');
    expect(job.events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('stringifies non-Error run failures into the error message', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockRejectedValue('kaboom');
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;

    expect(job.status).toBe('error');
    expect(job.error).toBe('kaboom');
  });

  it('stop() emits ONE stopped event and the run does not duplicate it', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    let release: () => void = () => {};
    const gate = new Promise<{
      answer: string;
      steps: number;
      trace: unknown[];
    }>((resolve) => {
      release = () => resolve({ answer: '[stopped]', steps: 0, trace: [] });
    });
    agent.runChannelTurnStreaming.mockImplementation(
      (opts: { onEvent: (e: unknown) => void }) => {
        opts.onEvent({ type: 'status', text: 'Agent started' });
        return gate;
      },
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
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
      events: [
        { type: 'status', ts: '2026-08-06T00:00:00.000Z', text: 'started' },
      ],
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
    agent.runChannelTurnStreaming.mockResolvedValue({
      answer: 'ok',
      steps: 1,
      trace: [],
    });
    const svc = makeSvc(channels, agent, prisma);
    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;

    expect(job.status).toBe('done');
    // A live in-memory job wins the snapshot lookup over Postgres.
    await expect(svc.snapshot(job.id)).resolves.toMatchObject({
      id: job.id,
      status: 'done',
    });
    // upsert: once on create, once at terminal (done) — plus channelPost etc.
    expect(prisma._upsert).toHaveBeenCalledTimes(2);
    const calls1 = (prisma._upsert as jest.Mock).mock.calls[1] as [
      { update: { status: string; answer: string; finishedAt: Date | null } },
    ];
    const updateArg = calls1[0];
    expect(updateArg.update.status).toBe('done');
    expect(updateArg.update.answer).toBe('ok');
    expect(updateArg.update.finishedAt).not.toBeNull();
  });

  it('rejects new jobs while a channel tree is being deleted', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockResolvedValue({
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
    const other = svc.create({
      channelId: 'ch2',
      agentName: 'coder',
      message: 'x',
    });
    expect(other.status).toBe('running');
    await other.process;

    // After deletion finishes, the channel accepts jobs again.
    svc.endChannelDelete(['ch1']);
    const again = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    expect(again.status).toBe('running');
    await again.process;
    expect(again.status).toBe('done');
  });

  it('queues interjections without blocking and drains them on read', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    let capturedInterject: (() => string[]) | null = null;
    agent.runChannelTurnStreaming.mockImplementation(
      (opts: { interject: () => string[]; onEvent: (e: unknown) => void }) => {
        capturedInterject = opts.interject;
        opts.onEvent({ type: 'status', text: 'Agent started' });
        return Promise.resolve({ answer: 'ok', steps: 0, trace: [] });
      },
    );
    const svc = makeSvc(channels, agent);
    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });

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

  it('statusFor returns the most recent job per channel+agent or null', async () => {
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockResolvedValue(streamingResult());
    const svc = makeSvc(channelsDouble(), agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    expect(svc.statusFor('ch1', 'coder')).toBe(job);
    expect(svc.statusFor('ch1', 'researcher')).toBeNull();
    await job.process;
    // The finished job is still the "latest" for the member.
    expect(svc.statusFor('ch1', 'coder')).toBe(job);
  });

  it('getRunning rejects wrong channels and non-running jobs', async () => {
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockResolvedValue(streamingResult());
    const svc = makeSvc(channelsDouble(), agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;

    expect(() => svc.interject(job.id, 'ch2', 'hi')).toThrow(
      'not found in channel ch2',
    );
    expect(() => svc.interject(job.id, 'ch1', 'hi')).toThrow('is not running');
    expect(() => svc.stop(job.id, 'ch1')).toThrow('is not running');
    // Unknown job id is a 404 from get().
    expect(() => svc.stop('ghost', 'ch1')).toThrow(/Job ghost not found/);
  });

  it('an aborted run that later fails stays stopped, never error', async () => {
    const agent = agentDouble();
    let release: () => void = () => {};
    const gate = new Promise<never>((_, reject) => {
      release = () => reject(new Error('channel deleted under the run'));
    });
    agent.runChannelTurnStreaming.mockImplementation(() => gate);
    const svc = makeSvc(channelsDouble(), agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await new Promise((r) => setImmediate(r));
    svc.stop(job.id, 'ch1');
    expect(job.finishedAt).toBeDefined();

    release();
    await job.process;
    expect(job.status).toBe('stopped');
    expect(job.error).toBeUndefined();
    expect(job.events.some((e) => e.type === 'error')).toBe(false);
  });

  it('routes debug-trace posts to the created sub-channel', async () => {
    const channels = channelsDouble();
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockImplementation(
      (opts: { toolStatusPost: (t: string) => Promise<unknown> }) =>
        opts.toolStatusPost('per-tool trace').then(() => streamingResult()),
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;
    expect(channels.postMessage).toHaveBeenCalledWith(
      'sub-coder',
      'agent',
      'coder',
      'per-tool trace',
      undefined,
    );
  });

  it('falls back to the main channel when the sub-channel cannot be created', async () => {
    const channels = channelsDouble();
    channels.ensureSubChannel.mockRejectedValue(new Error('disk full'));
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockImplementation(
      (opts: { toolStatusPost: (t: string) => Promise<unknown> }) =>
        opts.toolStatusPost('tracing...').then(() => streamingResult()),
    );
    const svc = makeSvc(channels, agent);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;
    expect(job.status).toBe('done');
    expect(channels.postMessage).toHaveBeenCalledWith(
      'ch1',
      'agent',
      'coder',
      'tracing...',
      undefined,
    );
  });

  it('stopForChannel stops running jobs and prunes persisted history', async () => {
    const prisma = prismaDouble();
    const agent = agentDouble();
    let release: () => void = () => {};
    const gate = new Promise<{
      answer: string;
      steps: number;
      trace: unknown[];
    }>((resolve) => {
      release = () => resolve({ answer: 'x', steps: 0, trace: [] });
    });
    agent.runChannelTurnStreaming.mockImplementationOnce(() => gate);
    agent.runChannelTurnStreaming.mockResolvedValueOnce({
      answer: 'done',
      steps: 0,
      trace: [],
    });
    const svc = makeSvc(channelsDouble(), agent, prisma);

    const running = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    const done = svc.create({
      channelId: 'ch2',
      agentName: 'coder',
      message: 'x',
    });
    await done.process;

    // Unrelated channels are untouched.
    expect(svc.stopForChannel(['ghost']).stopped).toBe(0);

    const stopped = svc.stopForChannel(['ch1', 'ch2']);
    expect(stopped.stopped).toBe(1);
    expect(running.status).toBe('stopped');
    expect(done.status).toBe('done');
    expect(running.events.filter((e) => e.type === 'stopped')).toHaveLength(1);
    expect(prisma._deleteMany).toHaveBeenLastCalledWith({
      where: { channelId: { in: ['ch1', 'ch2'] } },
    });

    // A history-prune failure is logged, never thrown to callers.
    (prisma._deleteMany as jest.Mock).mockRejectedValueOnce(
      new Error('prune failed'),
    );
    expect(svc.stopForChannel(['ghost']).stopped).toBe(0);

    release();
    await running.process;
    // Terminal `stopped` from stopForChannel survives the run finishing.
    expect(running.status).toBe('stopped');
    expect(running.events.filter((e) => e.type === 'stopped')).toHaveLength(1);
  });

  it('a persistence failure does not fail the in-memory job', async () => {
    const prisma = prismaDouble();
    (prisma._upsert as jest.Mock).mockRejectedValue(new Error('db down'));
    const agent = agentDouble();
    agent.runChannelTurnStreaming.mockResolvedValue(streamingResult());
    const svc = makeSvc(channelsDouble(), agent, prisma);

    const job = svc.create({
      channelId: 'ch1',
      agentName: 'coder',
      message: 'x',
    });
    await job.process;
    expect(job.status).toBe('done');
    expect(job.answer).toBe('done');
  });

  it('recovery and history lookups degrade gracefully on DB errors', async () => {
    const prisma = prismaDouble();
    (prisma._findMany as jest.Mock).mockRejectedValue(new Error('db down'));
    const svc = makeSvc(channelsDouble(), agentDouble(), prisma);
    await expect(svc.onModuleInit()).resolves.toBeUndefined();

    (prisma._findUnique as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(svc.snapshot('nope')).resolves.toBeNull();
    (prisma._findUnique as jest.Mock).mockResolvedValue(null);
    await expect(svc.snapshot('missing-row')).resolves.toBeNull();

    (prisma._findFirst as jest.Mock).mockRejectedValue(new Error('db down'));
    await expect(svc.latestFor('ch1', 'coder')).resolves.toBeNull();

    (prisma._findFirst as jest.Mock).mockResolvedValue(null);
    await expect(svc.latestFor('ch1', 'coder')).resolves.toBeNull();
  });

  it('history rows with null events and max steps degrade to empty defaults', async () => {
    const prisma = prismaDouble();
    const sparse = {
      id: 'job-sparse',
      channelId: 'ch1',
      agentName: 'coder',
      status: 'done',
      events: null,
      answer: null,
      steps: null,
      error: null,
      maxSteps: null,
      startedAt: new Date('2026-08-06T00:00:00.000Z'),
      finishedAt: null,
      createdAt: new Date('2026-08-06T00:00:00.000Z'),
      updatedAt: new Date('2026-08-06T00:00:00.000Z'),
    } as Record<string, unknown>;
    const svc = makeSvc(channelsDouble(), agentDouble(), prisma);

    (prisma._findFirst as jest.Mock).mockResolvedValue(sparse);
    const latest = await svc.latestFor('ch1', 'coder');
    expect(latest?.events).toEqual([]);
    expect(latest?.maxSteps).toBeUndefined();

    (prisma._findUnique as jest.Mock).mockResolvedValue(sparse);
    const snap = await svc.snapshot('job-sparse');
    expect(snap?.events).toEqual([]);
    expect(snap?.maxSteps).toBeUndefined();

    // Recovery also defaults the null events column before appending the
    // explanatory stopped event.
    (prisma._findMany as jest.Mock).mockResolvedValueOnce([
      { ...sparse, id: 'job-recovered-sparse', status: 'running' },
    ]);
    await svc.onModuleInit();
    const recovered = svc.get('job-recovered-sparse');
    expect(recovered.events).toHaveLength(1);
    expect(recovered.events[0].type).toBe('stopped');
  });
});
