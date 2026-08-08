import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { ConnectionsModule } from './connections/connections.module';
import { ApiTokenGuard } from './common/api-token.guard';
import { AppThrottlerGuard, envPositiveInt } from './common/throttle.guard';
import { BucketsModule } from './buckets/buckets.module';
import { FilesModule } from './files/files.module';
import { CronModule } from './cron/cron.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConnectionsModule,
    PrismaModule,
    AgentModule,
    FilesModule,
    BucketsModule,
    CronModule,
    // Global per-IP throttling; limits are resolved per request (see
    // AppThrottlerGuard), and the defaults never trip local development.
    ThrottlerModule.forRoot([
      {
        ttl: () => envPositiveInt('RATE_LIMIT_TTL_MS', 60_000),
        limit: () => envPositiveInt('RATE_LIMIT_MAX', 100),
      },
    ]),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ApiTokenGuard },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
  ],
})
export class AppModule {}
