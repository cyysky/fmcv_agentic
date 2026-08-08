import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { CreateCronJobDto, UpdateCronJobDto } from './cron.dto';
import { CronService } from './cron.service';

/**
 * Recurring cron jobs (DIRECTION.md item 2).
 *
 *   POST   /api/cron           create a job (unique name, 5-field schedule,
 *                              agent-turn task: prompt + optional model /
 *                              connection / maxSteps)
 *   GET    /api/cron           list jobs (with last/next run info)
 *   GET    /api/cron/:id       get one job
 *   PATCH  /api/cron/:id       update name/schedule/prompt/task/enabled
 *   DELETE /api/cron/:id       delete a job (rejected while running)
 *   POST   /api/cron/:id/run   run the job immediately, outside its schedule
 */
@Controller('cron')
export class CronController {
  constructor(private readonly cron: CronService) {}

  @Post()
  create(@Body() dto: CreateCronJobDto) {
    return this.cron.create(dto);
  }

  @Get()
  list() {
    return this.cron.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.cron.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCronJobDto) {
    return this.cron.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.cron.delete(id);
  }

  @Post(':id/run')
  run(@Param('id', ParseUUIDPipe) id: string) {
    return this.cron.runNow(id);
  }
}
