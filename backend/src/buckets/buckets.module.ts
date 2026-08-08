import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { BucketsController } from './buckets.controller';
import { BucketsService } from './buckets.service';

@Module({
  imports: [AgentModule],
  controllers: [BucketsController],
  providers: [BucketsService],
  exports: [BucketsService],
})
export class BucketsModule {}
