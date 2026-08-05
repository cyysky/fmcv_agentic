import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AgentModule } from './agent/agent.module';
import { ConnectionsModule } from './connections/connections.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [ConnectionsModule, PrismaModule, AgentModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
