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
import { SkillsService } from './skills.service';
import { CreateSkillDto, UpdateSkillDto } from './skills.dto';

/**
 * HTTP surface for agent skills (DIRECTION.md item 3).
 *
 *   POST /api/skills         — create a skill
 *   GET  /api/skills         — list skills
 *   GET  /api/skills/:id     — read one skill
 *   PATCH /api/skills/:id    — update fields
 *   POST /api/skills/:id/install   — mark installed
 *   POST /api/skills/:id/uninstall — stop exposing it to agents
 *   DELETE /api/skills/:id   — delete the skill
 */
@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  @Post()
  create(@Body() dto: CreateSkillDto) {
    return this.skills.create(dto);
  }

  @Get()
  list() {
    return this.skills.list();
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.skills.get(id);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateSkillDto) {
    return this.skills.update(id, dto);
  }

  @Post(':id/install')
  install(@Param('id', ParseUUIDPipe) id: string) {
    return this.skills.install(id);
  }

  @Post(':id/uninstall')
  uninstall(@Param('id', ParseUUIDPipe) id: string) {
    return this.skills.uninstall(id);
  }

  @Delete(':id')
  delete(@Param('id', ParseUUIDPipe) id: string) {
    return this.skills.delete(id);
  }
}
