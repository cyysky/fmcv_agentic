import {
  Body,
  Controller,
  Delete,
  Get,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ChannelService } from './channel.service';
import { BaseAgentService } from './base-agent.service';
import { ChannelJobService } from './channel-job.service';
import {
  ChannelInterjectDto,
  ChannelMemberDto,
  ChannelMessageDto,
  ChannelTurnDto,
  CreateChannelJobDto,
  CreateChannelDto,
} from './agent.dto';

/**
 * HTTP surface for the Slack-like team-communication layer.
 *
 *   GET    /api/channels                 — list channels
 *   POST   /api/channels                 — create a channel (+ its project folder)
 *   GET    /api/channels/:id             — channel detail (members, messages, tree)
 *   DELETE /api/channels/:id             — remove a channel
 *   POST   /api/channels/:id/members     — add an agent
 *   DELETE /api/channels/:id/members/:agentName — remove an agent
 *   GET    /api/channels/:id/messages    — message feed
 *   POST   /api/channels/:id/messages    — human posts to the feed
 *   POST   /api/channels/:id/turn        — an agent works in the channel
 *   POST   /api/channels/:id/jobs        — start a streaming channel job
 *   GET    /api/channels/:id/jobs/:jobId — poll a running job
 *   POST   /api/channels/:id/jobs/:jobId/interject — interject user text
 */
@Controller('channels')
export class ChannelController {
  constructor(
    private readonly channels: ChannelService,
    private readonly baseAgent: BaseAgentService,
    private readonly jobs: ChannelJobService,
  ) {}

  @Get()
  list() {
    return this.channels.list();
  }

  @Post()
  create(@Body() dto: CreateChannelDto) {
    return this.channels.create({
      name: dto.name,
      projectName: dto.projectName,
      creatorAgent: dto.creatorAgent,
    });
  }

  @Get(':id')
  getOne(@Param('id') id: string) {
    return this.channels.get(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    // Stop any running agent jobs for the channel tree before the rows go
    // away, so workers never keep running against a deleted channel. The
    // begin/end guards reject NEW jobs while delete is in progress, closing
    // the window between stopForChannel() and row removal.
    const ids = await this.channels.deletionCandidates(id);
    this.jobs.beginChannelDelete(ids);
    try {
      this.jobs.stopForChannel(ids);
      return await this.channels.remove(id);
    } finally {
      this.jobs.endChannelDelete(ids);
    }
  }

  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: ChannelMemberDto) {
    return this.channels.addMember(id, dto.agentName);
  }

  @Delete(':id/members/:agentName')
  removeMember(@Param('id') id: string, @Param('agentName') agentName: string) {
    return this.channels.removeMember(id, agentName);
  }

  /**
   * Per-member debugging status for a channel: for each member (agent) return
   * their most recent job summary (status + event stream) so the UI can show a
   * member's debugging detail even when no job is actively running.
   */
  @Get(':id/member-status')
  async memberStatus(@Param('id') id: string) {
    const channel = await this.channels.get(id);
    return Promise.all(
      channel.members.map(async (agentName) => {
        // In-memory job first (live runs); persisted history after restart.
        const job =
          this.jobs.statusFor(id, agentName) ??
          (await this.jobs.latestFor(id, agentName));
        return {
          agentName,
          hasRun: !!job,
          status: job?.status ?? null,
          answer: job?.answer ?? null,
          steps: job?.steps ?? null,
          error: job?.error ?? null,
          events: job?.events ?? [],
          startedAt: job?.startedAt ?? null,
        };
      }),
    );
  }

  @Get(':id/messages')
  listMessages(@Param('id') id: string) {
    return this.channels.listMessages(id);
  }

  @Post(':id/messages')
  async postMessage(
    @Param('id') id: string,
    @Body() dto: ChannelMessageDto,
  ) {
    const msg = await this.channels.postMessage(
      id,
      'user',
      dto.author ?? 'human',
      dto.text,
    );

    // Auto-reply: pick the target agent (@mention wins, else first member) and
    // start a streaming agent job so posting a message in a channel elicits a
    // live agent response with observation + divert. Returns jobId so the UI
    // can poll the run. A `system` post (e.g. "joined") doesn't trigger runs.
    if (dto.role !== 'system') {
      const agentName = await this.channels.resolveReplyAgent(id, dto.text);
      if (agentName) {
        const job = this.jobs.create({
          channelId: id,
          agentName,
          message: dto.text,
          persistHuman: false, // already persisted above
        });
        return { msg, jobId: job.id, status: job.status, agentName };
      }
    }

    return { msg };
  }

  @Post(':id/turn')
  runTurn(
    @Param('id') id: string,
    @Body() dto: ChannelTurnDto,
  ) {
    return this.channels.runTurn(
      this.baseAgent,
      id,
      dto.agentName,
      dto.message,
      dto.model,
    );
  }

  @Post(':id/jobs')
  createJob(@Param('id') id: string, @Body() dto: CreateChannelJobDto) {
    const job = this.jobs.create({
      channelId: id,
      agentName: dto.agentName,
      message: dto.message,
      model: dto.model,
      maxSteps: dto.maxSteps,
    });
    return { jobId: job.id, status: job.status };
  }

  @Get(':id/jobs/:jobId')
  async getJob(@Param('id') id: string, @Param('jobId') jobId: string) {
    const job = await this.jobs.snapshot(jobId);
    if (!job || job.channelId !== id) {
      throw new NotFoundException(`Job ${jobId} not found in channel ${id}`);
    }
    return {
      jobId: job.id,
      status: job.status,
      events: job.events,
      answer: job.answer,
      steps: job.steps,
      error: job.error,
    };
  }

  @Post(':id/jobs/:jobId/interject')
  interject(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
    @Body() dto: ChannelInterjectDto,
  ) {
    this.jobs.interject(jobId, id, dto.text);
    return { ok: true };
  }

  @Post(':id/jobs/:jobId/stop')
  stop(
    @Param('id') id: string,
    @Param('jobId') jobId: string,
  ) {
    this.jobs.stop(jobId, id);
    return { ok: true, status: 'stopped' };
  }
}
