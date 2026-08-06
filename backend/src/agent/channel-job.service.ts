import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { BaseAgentService } from './base-agent.service';
import type {
  ChatMessage,
  ChannelTurnStreamEvent,
} from './base-agent.service';
import { ChannelService } from './channel.service';

export type ChannelJobEventType =
  | 'status'
  | 'tool_call'
  | 'interject'
  | 'answer'
  | 'error'
  | 'stopped';

export interface ChannelJobEvent {
  type: ChannelJobEventType;
  ts: string; // ISO
  text?: string; // status text / interject text / final answer
  name?: string; // tool name
  arguments?: string; // tool args (raw JSON string)
  result?: string; // tool result (string)
  step?: number;
}

export interface ChannelJob {
  id: string;
  channelId: string;
  agentName: string;
  status: 'running' | 'done' | 'error' | 'stopped';
  events: ChannelJobEvent[];
  mailbox: string[]; // interjections queued by user
  startedAt: string;
  finishedAt?: string;
  answer?: string;
  steps?: number;
  error?: string;
  /** Optional custom step budget for the turn loop. */
  maxSteps?: number;
  // internal
  messages: ChatMessage[]; // live ChatMessage[] so interjections land in context
  process: Promise<void>;
  abort: AbortController; // stop/divert signal consumed by the streaming loop
}

/**
 * In-memory, singleton manager for streaming channel turns. Each channel turn
 * is a background job the frontend can watch (tool calls stream in via
 * `events`) and interject into via the mailbox (queued text is drained into
 * the agent's live message context before its next model call).
 *
 * Jobs live only in memory — they are lost on restart, which is acceptable
 * for this feature.
 */
@Injectable()
export class ChannelJobService {
  private readonly logger = new Logger(ChannelJobService.name);
  private readonly jobs = new Map<string, ChannelJob>();
  /** Most recent job per channel+agent, so a member's debugging status
   *  (running/stopped/error + event stream) can be shown even when nothing is
   *  actively running. Keyed by `${channelId}::${agentName}`. */
  private readonly recentByAgent = new Map<string, ChannelJob>();

  constructor(
    private readonly channels: ChannelService,
    private readonly baseAgent: BaseAgentService,
  ) {}

  create(input: {
    channelId: string;
    agentName: string;
    message: string;
    model?: string;
    /** Custom step budget for the turn loop (default 12). */
    maxSteps?: number;
    /** skip re-persisting the human message (already in the feed). */
    persistHuman?: boolean;
  }): ChannelJob {
    const job: ChannelJob = {
      id: randomUUID(),
      channelId: input.channelId,
      agentName: input.agentName,
      status: 'running',
      events: [],
      mailbox: [],
      startedAt: new Date().toISOString(),
      messages: [],
      process: Promise.resolve(),
      abort: new AbortController(),
      maxSteps: input.maxSteps,
    };

    job.process = this.run(job, input).catch((err) => {
      if (job.abort.signal.aborted) {
        // Already stopped via stop()/stopForChannel() — keep that terminal
        // status and never downgrade it to error, even if the run later trips
        // over the channel being deleted/out of context.
        job.finishedAt ??= new Date().toISOString();
        return;
      }
      job.status = 'error';
      job.error = (err as Error).message ?? String(err);
      job.finishedAt = new Date().toISOString();
      this.emit(job, { type: 'error', text: job.error });
      this.logger.error(
        `Channel job ${job.id} failed for channel ${input.channelId}: ${job.error}`,
      );
    });

    this.jobs.set(job.id, job);
    this.recentByAgent.set(
      `${input.channelId}::${input.agentName}`,
      job,
    );
    this.logger.log(
      `Channel job ${job.id} started for channel ${input.channelId} (${input.agentName})`,
    );
    return job;
  }

  /**
   * Latest debugging status for a member (agent) in a channel. Returns the most
   * recent job for that agent (e.g. still-running, or last done/stopped/error),
   * or null if the member has never run a job here.
   */
  statusFor(channelId: string, agentName: string): ChannelJob | null {
    return this.recentByAgent.get(`${channelId}::${agentName}`) ?? null;
  }

  get(jobId: string): ChannelJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new NotFoundException(`Job ${jobId} not found`);
    return job;
  }

  /** Validate a job belongs to a channel and is running. */
  private getRunning(jobId: string, channelId: string): ChannelJob {
    const job = this.get(jobId);
    if (job.channelId !== channelId) {
      throw new NotFoundException(`Job ${jobId} not found in channel ${channelId}`);
    }
    if (job.status !== 'running') {
      throw new BadRequestException(`Job ${jobId} is not running`);
    }
    return job;
  }

  interject(jobId: string, channelId: string, text: string): void {
    const job = this.getRunning(jobId, channelId);
    // Never blocks: just enqueue; drained by the streaming loop before the
    // agent's next model call.
    job.mailbox.push(text);
  }

  private emit(job: ChannelJob, event: Omit<ChannelJobEvent, 'ts'>): void {
    job.events.push({ ...event, ts: new Date().toISOString() });
  }

  private async run(
    job: ChannelJob,
    input: {
      channelId: string;
      agentName: string;
      message: string;
      model?: string;
      maxSteps?: number;
      persistHuman?: boolean;
    },
  ): Promise<void> {
    const { channel, thread } = await this.channels.prepareChannelTurn({
      channelId: input.channelId,
      agentName: input.agentName,
      message: input.message,
      persistHuman: input.persistHuman,
    });

    // Auto-create the per-agent sub-channel that hosts the debug trace (the
    // lightweight "used <tool> on <target>" updates) and lets the user talk
    // directly with this agent. The main channel only keeps the final answer.
    // Creation is async; we await it before the run starts so per-tool posts
    // below can land in the sub-channel immediately. If it ever fails we
    // gracefully fall back to posting debug updates in the main channel.
    let subChannelId: string | null = null;
    try {
      const sub = await this.channels.ensureSubChannel(
        input.channelId,
        input.agentName,
      );
      subChannelId = sub.id;
    } catch (err) {
      this.logger.warn(
        `Could not create sub-channel for ${input.agentName} in channel ${input.channelId}: ${(err as Error).message}`,
      );
    }

    const channelPost = async (text: string, toolCalls?: unknown[]) => {
      return this.channels.postMessage(
        input.channelId,
        'agent',
        input.agentName,
        text,
        toolCalls,
      );
    };
    // Debug-trace posts (per-tool status) go to the sub-channel when one was
    // created, else fall back to the main channel.
    const toolStatusPost = async (text: string, toolCalls?: unknown[]) => {
      return this.channels.postMessage(
        subChannelId ?? input.channelId,
        'agent',
        input.agentName,
        text,
        toolCalls,
      );
    };

    const result = await this.baseAgent.runChannelTurnStreaming({
      agentName: input.agentName,
      channelSlug: channel.slug,
      channelProjectName: channel.projectName,
      thread,
      message: input.message,
      model: input.model,
      maxSteps: input.maxSteps,
      channelPost,
      toolStatusPost,
      messages: job.messages,
      onEvent: (event: ChannelTurnStreamEvent) =>
        this.emit(job, event as Omit<ChannelJobEvent, 'ts'>),
      interject: () => job.mailbox.splice(0),
      signal: job.abort.signal,
    });

    job.answer = result.answer;
    job.steps = result.steps;
    job.finishedAt = new Date().toISOString();

    // Persist the agent's final answer into the main channel feed (unless we
    // stopped). The final answer is the ONLY thing guaranteed to land in the
    // main channel from a run — the per-tool debug trace lives in the
    // sub-channel. When a stop was requested, `stop()` already emitted the
    // single 'stopped' event and set the status, so the run only mirrors that
    // status here without emitting a duplicate.
    if (!job.abort.signal.aborted) {
      job.status = 'done';
      await channelPost(result.answer, result.trace);
    } else {
      job.status = 'stopped';
    }
  }

  /**
   * Stop a running job immediately: abort any in-flight LLM call and mark the
   * job stopped so the UI stops treating it as active.
   */
  stop(jobId: string, channelId: string): void {
    const job = this.getRunning(jobId, channelId);
    job.abort.abort();
    job.status = 'stopped';
    job.finishedAt = new Date().toISOString();
    this.emit(job, { type: 'stopped', text: 'Agent run stopped.' });
  }

  /**
   * Stop every in-memory job belonging to a channel (or one of its
   * sub-channels) and forget its per-member debug bookkeeping. Called when a
   * channel tree is deleted, so a running agent doesn't keep working on a
   * channel that no longer exists. Emits exactly one `stopped` event per
   * running job and leaves already-finished jobs untouched.
   */
  stopForChannel(channelIds: string[]): { stopped: number } {
    const ids = new Set(channelIds);
    let stopped = 0;
    for (const job of this.jobs.values()) {
      if (!ids.has(job.channelId)) continue;
      this.recentByAgent.delete(`${job.channelId}::${job.agentName}`);
      if (job.status !== 'running') continue;
      job.abort.abort();
      job.status = 'stopped';
      job.finishedAt = new Date().toISOString();
      this.emit(job, { type: 'stopped', text: 'Channel deleted; run stopped.' });
      stopped += 1;
    }
    return { stopped };
  }
}
