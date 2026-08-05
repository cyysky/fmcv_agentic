import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AgentController } from './agent.controller';
import { BaseAgentService } from './base-agent.service';

@Module({
  imports: [ConfigModule],
  controllers: [AgentController],
  providers: [BaseAgentService],
  exports: [BaseAgentService],
})
export class AgentModule {}
