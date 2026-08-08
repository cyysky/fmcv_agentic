import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { CronController } from './cron.controller';
import { CronService } from './cron.service';

@Module({
  imports: [AgentModule],
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
