import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentController } from './agent.controller';
import { ChannelController } from './channel.controller';
import { BaseAgentService } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import { ChannelService } from './channel.service';
import { ChannelJobService } from './channel-job.service';
import { SkillsModule } from '../skills/skills.module';
import { WebModule } from '../web/web.module';

@Module({
  imports: [ConfigModule, SkillsModule, WebModule],
  controllers: [AgentController, ChannelController],
  providers: [
    BaseAgentService,
    WorkspaceService,
    ChannelService,
    ChannelJobService,
  ],
  exports: [
    BaseAgentService,
    WorkspaceService,
    ChannelService,
    ChannelJobService,
  ],
})
export class AgentModule {}
