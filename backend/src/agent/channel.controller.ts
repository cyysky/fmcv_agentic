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
  remove(@Param('id') id: string) {
    return this.channels.remove(id);
  }

  @Post(':id/members')
  addMember(@Param('id') id: string, @Body() dto: ChannelMemberDto) {
    return this.channels.addMember(id, dto.agentName);
  }

  @Delete(':id/members/:agentName')
  removeMember(@Param('id') id: string, @Param('agentName') agentName: string) {
    return this.channels.removeMember(id, agentName);
  }

  @Get(':id/messages')
  listMessages(@Param('id') id: string) {
    return this.channels.listMessages(id);
  }

  @Post(':id/messages')
  postMessage(
    @Param('id') id: string,
    @Body() dto: ChannelMessageDto,
  ) {
    return this.channels.postMessage(
      id,
      'user',
      dto.author ?? 'human',
      dto.text,
    );
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
    });
    return { jobId: job.id, status: job.status };
  }

  @Get(':id/jobs/:jobId')
  getJob(@Param('id') id: string, @Param('jobId') jobId: string) {
    const job = this.jobs.get(jobId);
    if (job.channelId !== id) {
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
}
