import { ChannelJobService } from './channel-job.service';

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
    const svc = new ChannelJobService(channels as never, agent as never);

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
    const svc = new ChannelJobService(channels as never, agent as never);

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
    const svc = new ChannelJobService(channels as never, agent as never);

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
    const svc = new ChannelJobService(channels as never, agent as never);
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
