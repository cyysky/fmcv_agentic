import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { AgentModule } from '../agent/agent.module';
import { CronController } from './cron.controller';
import { CronService } from './cron.service';

@Module({
  // Native NestJS scheduling (DIRECTION item 3): the ticker interval below
  // is registered through @nestjs/schedule, never system cron / host
  // crontab, so the whole stack stays portable (docker-compose deployable
  // anywhere). CronService keeps the distributed Postgres lease on top, so
  // multi-replica deployments still elect exactly one firing replica.
  imports: [ScheduleModule.forRoot(), AgentModule],
  controllers: [CronController],
  providers: [CronService],
  exports: [CronService],
})
export class CronModule {}
