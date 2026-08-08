import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Skill } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateSkillDto, UpdateSkillDto } from './skills.dto';

/**
 * Agent skills (DIRECTION.md item 3).
 *
 * A skill is a named capability: a description plus markdown instructions
 * (the skill body, e.g. a SKILL.md) that agents can load and follow. Skills
 * are authored through CRUD below, marked `installed` when ready for use,
 * and surfaced to agent turns via `listInstalled()` (the system-prompt
 * registry) and `contentFor(name)` (the `read_skill` tool body). Uninstalling
 * keeps the authored record; deleting removes it.
 */
@Injectable()
export class SkillsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Create a skill. Names are globally unique (409 on clash). Installing at
   *  creation requires non-empty content — a skill with nothing to follow is
   *  not usable. */
  async create(dto: CreateSkillDto): Promise<Skill> {
    const name = dto.name.trim();
    const description = (dto.description ?? '').trim();
    const content = dto.content ?? '';
    const installed = dto.installed ?? false;
    if (installed && !content.trim()) {
      throw new BadRequestException(
        'A skill must have content before it can be installed',
      );
    }
    try {
      return await this.prisma.skill.create({
        data: { name, description, content, installed },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(`Skill "${name}" already exists`);
      }
      throw err;
    }
  }

  async list(): Promise<Skill[]> {
    return this.prisma.skill.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async get(id: string): Promise<Skill> {
    const skill = await this.prisma.skill.findUnique({ where: { id } });
    if (!skill) throw new NotFoundException(`Skill ${id} not found`);
    return skill;
  }

  async update(id: string, dto: UpdateSkillDto): Promise<Skill> {
    const existing = await this.get(id);
    if (!Object.values(dto).some((v) => v !== undefined)) {
      throw new BadRequestException('At least one field is required to update');
    }
    const content = dto.content ?? existing.content;
    const installed = dto.installed ?? existing.installed;
    if (installed && !content.trim()) {
      throw new BadRequestException(
        'A skill must have content before it can be installed',
      );
    }
    try {
      return await this.prisma.skill.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          description:
            dto.description === undefined ? undefined : dto.description.trim(),
          content: dto.content === undefined ? undefined : dto.content,
          installed: dto.installed,
        },
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Skill name "${dto.name?.trim() ?? existing.name}" already exists`,
        );
      }
      throw err;
    }
  }

  async delete(id: string): Promise<{ deleted: boolean }> {
    await this.get(id);
    await this.prisma.skill.delete({ where: { id } });
    return { deleted: true };
  }

  /** Mark a skill installed (requires non-empty content). */
  async install(id: string): Promise<Skill> {
    const skill = await this.get(id);
    if (!skill.content.trim()) {
      throw new BadRequestException(
        'A skill must have content before it can be installed',
      );
    }
    return this.prisma.skill.update({
      where: { id },
      data: { installed: true },
    });
  }

  /** Uninstall a skill (keeps the authored record; agents stop seeing it). */
  async uninstall(id: string): Promise<Skill> {
    await this.get(id);
    return this.prisma.skill.update({
      where: { id },
      data: { installed: false },
    });
  }

  /** Installed skills, as the registry block fed to agent system prompts. */
  async listInstalled(): Promise<Pick<Skill, 'name' | 'description'>[]> {
    return this.prisma.skill.findMany({
      where: { installed: true },
      orderBy: { name: 'asc' },
      select: { name: true, description: true },
    });
  }

  /** Full skill body for the `read_skill` tool; null when the skill does not
   *  exist or is not installed. */
  async contentFor(name: string): Promise<string | null> {
    const skill = await this.prisma.skill.findFirst({
      where: { installed: true, name },
      select: { content: true },
    });
    return skill?.content ?? null;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'P2002'
    );
  }
}
