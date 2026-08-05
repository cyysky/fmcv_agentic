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
  | 'error';

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
  status: 'running' | 'done' | 'error';
  events: ChannelJobEvent[];
  mailbox: string[]; // interjections queued by user
  startedAt: string;
  finishedAt?: string;
  answer?: string;
  steps?: number;
  error?: string;
  // internal
  messages: ChatMessage[]; // live ChatMessage[] so interjections land in context
  spec: unknown;
  tools: Map<string, unknown>;
  process: Promise<void>;
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

  constructor(
    private readonly channels: ChannelService,
    private readonly baseAgent: BaseAgentService,
  ) {}

  create(input: {
    channelId: string;
    agentName: string;
    message: string;
    model?: string;
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
      spec: {},
      tools: new Map(),
      process: Promise.resolve(),
    };

    job.process = this.run(job, input).catch((err) => {
      job.status = 'error';
      job.error = (err as Error).message ?? String(err);
      job.finishedAt = new Date().toISOString();
      this.emit(job, { type: 'error', text: job.error });
      this.logger.error(
        `Channel job ${job.id} failed for channel ${input.channelId}: ${job.error}`,
      );
    });

    this.jobs.set(job.id, job);
    this.logger.log(
      `Channel job ${job.id} started for channel ${input.channelId} (${input.agentName})`,
    );
    return job;
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
    },
  ): Promise<void> {
    const { channel, thread } = await this.channels.prepareChannelTurn({
      channelId: input.channelId,
      agentName: input.agentName,
      message: input.message,
    });

    const channelPost = async (text: string, toolCalls?: unknown[]) => {
      return this.channels.postMessage(
        input.channelId,
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
      channelPost,
      messages: job.messages,
      onEvent: (event: ChannelTurnStreamEvent) =>
        this.emit(job, event as Omit<ChannelJobEvent, 'ts'>),
      interject: () => job.mailbox.splice(0),
    });

    job.status = 'done';
    job.answer = result.answer;
    job.steps = result.steps;
    job.finishedAt = new Date().toISOString();

    // Persist the agent's final answer into the feed.
    await channelPost(result.answer, result.trace);
  }
}
