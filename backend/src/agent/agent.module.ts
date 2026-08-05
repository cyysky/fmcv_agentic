import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentController } from './agent.controller';
import { ChannelController } from './channel.controller';
import { BaseAgentService } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import { ChannelService } from './channel.service';
import { ChannelJobService } from './channel-job.service';

@Module({
  imports: [ConfigModule],
  controllers: [AgentController, ChannelController],
  providers: [BaseAgentService, WorkspaceService, ChannelService, ChannelJobService],
  exports: [BaseAgentService, WorkspaceService, ChannelService, ChannelJobService],
})
export class AgentModule {}
