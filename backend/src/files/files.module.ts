import { Module } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [AgentModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
