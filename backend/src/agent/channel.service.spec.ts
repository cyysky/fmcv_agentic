import { BadRequestException } from '@nestjs/common';
import { ChannelService } from './channel.service';

/** Minimal Prisma double that mimics the calls ChannelService makes. */
function prismaDouble() {
  const members: { channelId: string; agentName: string }[] = [];
  const messages: Record<string, unknown>[] = [];
  const rows = new Map<string, Record<string, unknown>>();
  const seed = {
    channel: {
      findUnique: jest.fn(async ({ where, include }: any) => {
        const r = rows.get(where.id ?? where.slug);
        if (!r) return null;
        return {
          ...r,
          members: include?.members
            ? members.filter((m) => m.channelId === r.id)
            : undefined,
          messages: include?.messages
            ? messages.filter((m) => (m as any).channelId === r.id)
            : undefined,
        };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        for (const r of rows.values()) {
          if (where.agentName && (r as any).agentName !== where.agentName)
            continue;
          if (where.parentId && (r as any).parentId !== where.parentId)
            continue;
          return r;
        }
        return null;
      }),
      findMany: jest.fn(async () => [...rows.values()]),
      create: jest.fn(async (p: any) => {
        const row = {
          id: `ch-${rows.size + 1}`,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          ...p.data,
        };
        rows.set(row.id, row);
        return row;
      }),
      delete: jest.fn(async ({ where }: any) => {
        rows.delete(where.id);
        return { id: where.id };
      }),
    },
    channelMember: {
      upsert: jest.fn(async (p: any) => {
        const key = `${p.where.channelId_agentName.channelId}::${p.where.channelId_agentName.agentName}`;
        if (!members.some((m) => `${m.channelId}::${m.agentName}` === key)) {
          members.push({
            channelId: p.where.channelId_agentName.channelId,
            agentName: p.where.channelId_agentName.agentName,
          });
        }
        return {};
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const key = `${where.channelId_agentName.channelId}::${where.channelId_agentName.agentName}`;
        const row = members.find(
          (m) => `${m.channelId}::${m.agentName}` === key,
        );
        return row ? { ...row } : null;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        members.filter((m) => m.channelId === where.channelId),
      ),
      createMany: jest.fn(async () => ({ count: 0 })),
      delete: jest.fn(async ({ where }: any) => {
        const key = `${where.channelId_agentName.channelId}::${where.channelId_agentName.agentName}`;
        members.splice(
          members.findIndex((m) => `${m.channelId}::${m.agentName}` === key),
          1,
        );
        return {};
      }),
    },
    channelMessage: {
      findMany: jest.fn(async ({ where }: any) =>
        messages.filter((m) => (m as any).channelId === where.channelId),
      ),
      create: jest.fn(async (p: any) => {
        const row = {
          id: `msg-${messages.length + 1}`,
          createdAt: new Date('2026-01-01T00:00:01Z'),
          ...p.data,
        };
        messages.push(row);
        return row;
      }),
    },
  };
  return { prisma: seed as never, members, messages, rows };
}

function workspacesDouble() {
  const agentDirs = new Set(['coder', 'researcher']);
  return {
    assertAgentName: jest.fn((name: string) => {
      if (!agentDirs.has(name)) {
        throw new BadRequestException(
          `Unknown agent: ${name}. Valid named agents: coder, researcher`,
        );
      }
    }),
    ensureAgentFolder: jest.fn(async (name: string) => ({
      name,
      path: `/data/workspaces/agents/${name}`,
      workDir: `/data/workspaces/agents/${name}/work`,
    })),
    createPublicProject: jest.fn(async (name: string) => ({
      name,
      path: `/data/workspaces/projects/${name}`,
    })),
    listProjectContent: jest.fn(async () => ({})),
  } as never;
}

describe('ChannelService', () => {
  it('creates a channel with its own project and seeded system message', async () => {
    const { prisma, rows } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const detail = await svc.create({ name: 'Team Alpha' });
    expect(detail.slug).toBe('team-alpha');
    expect(rows.get(detail.id)).toBeDefined();
    expect(detail.messages.some((m) => m.text.includes('created'))).toBe(true);
  });

  it('slugifies names and rejects empties', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    await expect(svc.create({ name: '  ' })).rejects.toThrow(
      BadRequestException,
    );
    const d = await svc.create({ name: 'My Team!!!' });
    expect(d.slug).toBe('my-team');
  });

  it('rejects duplicate channel slugs', async () => {
    const { prisma, rows } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    (prisma as any).channel.findUnique.mockResolvedValueOnce({
      id: 'existing',
      slug: 'dup',
      createdAt: new Date(),
    });
    await expect(svc.create({ name: 'dup' })).rejects.toThrow(
      'Channel #dup already exists',
    );
    expect(rows.size).toBe(0);
  });

  it('adds and removes members with validation symmetry', async () => {
    const { prisma } = prismaDouble();
    const ws = workspacesDouble();
    const svc = new ChannelService(prisma, ws);
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });
    expect(d.members).toEqual(['coder']);

    await expect(svc.addMember(d.id, 'ghost')).rejects.toThrow(
      /Unknown agent: ghost/,
    );

    await expect(svc.removeMember(d.id, 'researcher')).rejects.toThrow(
      BadRequestException,
    );

    await svc.addMember(d.id, 'researcher');
    await expect(svc.removeMember(d.id, 'researcher')).resolves.toBeDefined();
    expect((await svc.get(d.id)).members).toEqual(['coder']);
  });

  it('ensures sub-channels exactly once and never nests sub-sub-channels', async () => {
    const { prisma, rows } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const parent = await svc.create({ name: 'team', creatorAgent: 'coder' });

    const sub1 = await svc.ensureSubChannel(parent.id, 'coder');
    const sub2 = await svc.ensureSubChannel(parent.id, 'coder');
    expect(sub1.id).toBe(sub2.id);
    expect(sub1.parentId).toBe(parent.id);
    expect(sub1.agentName).toBe('coder');

    // Calling ensureSubChannel ON the sub-channel returns it unchanged.
    const chained = await svc.ensureSubChannel(sub1.id, 'coder');
    expect(chained.id).toBe(sub1.id);
    expect(chained.parentId).toBe(parent.id);
    expect(rows.size).toBe(2); // parent + one sub-channel
  });

  it('resolves @mentions for auto-reply, else the first member', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const d = await svc.create({ name: 'team' });
    await svc.addMember(d.id, 'coder');
    await svc.addMember(d.id, 'researcher');

    expect(await svc.resolveReplyAgent(d.id, 'please look @coder')).toBe(
      'coder',
    );
    expect(await svc.resolveReplyAgent(d.id, 'look at @researcher now')).toBe(
      'researcher',
    );
    expect(await svc.resolveReplyAgent(d.id, 'plain message')).toBe('coder');
  });
});
