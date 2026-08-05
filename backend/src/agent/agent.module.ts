import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentController } from './agent.controller';
import { BaseAgentService } from './base-agent.service';
import { WorkspaceService } from './workspace.service';

@Module({
  imports: [ConfigModule],
  controllers: [AgentController],
  providers: [BaseAgentService, WorkspaceService],
  exports: [BaseAgentService, WorkspaceService],
})
export class AgentModule {}
