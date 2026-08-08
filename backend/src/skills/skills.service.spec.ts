import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Skill } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SkillsService } from './skills.service';

/** Minimal Prisma double covering the skill store. */
type MockStore = Record<string, jest.Mock>;
function prismaDouble(defaults: { findMany?: unknown } = {}): {
  skill: MockStore;
} {
  const skill: MockStore = {
    create: jest.fn(),
    findMany: jest.fn(() => Promise.resolve(defaults.findMany ?? [])),
    findUnique: jest.fn(() => Promise.resolve(null)),
    findFirst: jest.fn(() => Promise.resolve(null)),
    update: jest.fn(() => Promise.resolve(row())),
    delete: jest.fn(() => Promise.resolve({ id: 'skill-1' })),
  };
  return { skill };
}

function row(over: Partial<Skill> = {}): Skill {
  return {
    id: 'skill-1',
    name: 'code-review',
    description: 'Review a diff with a checklist',
    content: '# Code review\nCheck for edge cases.',
    installed: false,
    createdAt: new Date('2026-08-08T00:00:00Z'),
    updatedAt: new Date('2026-08-08T00:00:00Z'),
    ...over,
  };
}

function makeSvc(prisma = prismaDouble()): {
  service: SkillsService;
  prisma: ReturnType<typeof prismaDouble>;
} {
  return {
    service: new SkillsService(prisma as unknown as PrismaService),
    prisma,
  };
}

describe('SkillsService', () => {
  it('creates a skill with normalized fields', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.create.mockResolvedValue(row());
    const created = await service.create({
      name: ' code-review ',
      description: '  Review a diff with a checklist  ',
      content: '# Code review\nCheck for edge cases.',
    });
    expect(created.id).toBe('skill-1');
    expect(created.installed).toBe(false);
    expect(prisma.skill.create).toHaveBeenCalledWith({
      data: {
        name: 'code-review',
        description: 'Review a diff with a checklist',
        content: '# Code review\nCheck for edge cases.',
        installed: false,
      },
    });
  });

  it('409s on a duplicate skill name', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.create({ name: 'code-review' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('rethrows non-unique create errors untouched', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.create({ name: 'code-review', content: 'body' }),
    ).rejects.toThrow('db down');
  });

  it('rejects installing at creation without content', async () => {
    const { service } = makeSvc();
    await expect(
      service.create({ name: 'empty-skill', installed: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates with an empty body when content is omitted (install still guarded)', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.create.mockResolvedValue(row({ content: '' }));
    const created = await service.create({ name: 'uninstalled' });
    expect(created.content).toBe('');
    expect(prisma.skill.create).toHaveBeenCalledWith({
      data: {
        name: 'uninstalled',
        description: '',
        content: '',
        installed: false,
      },
    });
  });

  it('lists skills newest first', async () => {
    const { service } = makeSvc();
    await service.list();
  });

  it('gets a skill and 404s on an unknown id', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row());
    await expect(service.get('skill-1')).resolves.toMatchObject({
      name: 'code-review',
    });
    prisma.skill.findUnique.mockResolvedValue(null);
    await expect(service.get('missing')).rejects.toThrow(NotFoundException);
  });

  it('updates fields; rejects an empty patch or clearing content while installed', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row({ installed: true }));
    await expect(service.update('skill-1', {})).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.update('skill-1', { content: '  ' })).rejects.toThrow(
      BadRequestException,
    );

    prisma.skill.update.mockResolvedValue(
      row({ description: 'New', installed: true }),
    );
    const updated = await service.update('skill-1', { description: 'New' });
    expect(updated.installed).toBe(true);
  });

  it('passes content through when an update provides it', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row());
    prisma.skill.update.mockResolvedValue(row({ content: '# New body' }));
    const updated = await service.update('skill-1', { content: '# New body' });
    expect(prisma.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-1' },
      data: expect.objectContaining({ content: '# New body' }),
    });
    expect(updated.content).toBe('# New body');
  });

  it('409s when an update collides with an existing skill name', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row());
    prisma.skill.update.mockRejectedValue({ code: 'P2002' });
    await expect(service.update('skill-1', { name: 'taken' })).rejects.toThrow(
      ConflictException,
    );
  });

  it('uses the existing name in the 409 message when an update drops the name', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row({ name: 'code-review' }));
    prisma.skill.update.mockRejectedValue({ code: 'P2002' });
    await expect(
      service.update('skill-1', { description: 'Renamed away' }),
    ).rejects.toThrow('Skill name "code-review" already exists');
  });

  it('rethrows non-unique update errors untouched', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row());
    prisma.skill.update.mockRejectedValue(new Error('db down'));
    await expect(
      service.update('skill-1', { description: 'New' }),
    ).rejects.toThrow('db down');
  });

  it('deletes a skill and 404s on an unknown id', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row());
    await expect(service.delete('skill-1')).resolves.toEqual({ deleted: true });
    expect(prisma.skill.delete).toHaveBeenCalledWith({
      where: { id: 'skill-1' },
    });

    prisma.skill.findUnique.mockResolvedValue(null);
    await expect(service.delete('missing')).rejects.toThrow(NotFoundException);
  });

  it('install requires content and flips the flag', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row({ content: '' }));
    await expect(service.install('skill-1')).rejects.toThrow(
      BadRequestException,
    );

    prisma.skill.findUnique.mockResolvedValue(row());
    prisma.skill.update.mockResolvedValue(row({ installed: true }));
    await expect(service.install('skill-1')).resolves.toMatchObject({
      installed: true,
    });
    expect(prisma.skill.update).toHaveBeenCalledWith({
      where: { id: 'skill-1' },
      data: { installed: true },
    });
  });

  it('uninstall keeps the record but flips the flag off', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findUnique.mockResolvedValue(row({ installed: true }));
    prisma.skill.update.mockResolvedValue(row({ installed: false }));
    await expect(service.uninstall('skill-1')).resolves.toMatchObject({
      installed: false,
    });
  });

  it('listInstalled returns only installed skills for the registry', async () => {
    const { service } = makeSvc(
      prismaDouble({
        findMany: [{ name: 'code-review', description: 'A checklist' }],
      }),
    );
    await expect(service.listInstalled()).resolves.toEqual([
      { name: 'code-review', description: 'A checklist' },
    ]);
  });

  it('contentFor returns the body only for installed skills', async () => {
    const { service, prisma } = makeSvc();
    prisma.skill.findFirst.mockResolvedValue({ content: '# Code review' });
    await expect(service.contentFor('code-review')).resolves.toBe(
      '# Code review',
    );
    expect(prisma.skill.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { installed: true, name: 'code-review' },
      }),
    );

    prisma.skill.findFirst.mockResolvedValue(null);
    await expect(service.contentFor('absent')).resolves.toBeNull();
  });
});
