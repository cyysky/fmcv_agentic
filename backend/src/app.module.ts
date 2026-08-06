import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { ConnectionsModule } from './connections/connections.module';
import { ApiTokenGuard } from './common/api-token.guard';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConnectionsModule, PrismaModule, AgentModule],
  controllers: [AppController],
  providers: [AppService, { provide: APP_GUARD, useClass: ApiTokenGuard }],
})
export class AppModule {}
