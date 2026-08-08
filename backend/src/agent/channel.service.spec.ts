import { BadRequestException, NotFoundException } from '@nestjs/common';
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
      findMany: jest.fn(async (p: any) => {
        let out = [...rows.values()];
        if (p?.where?.parentId !== undefined) {
          out = out.filter((r) => (r as any).parentId === p.where.parentId);
          if (p?.select) return out.map((r) => ({ id: (r as any).id }));
        }
        if (p?.include?._count) {
          return out.map((r) => ({
            ...r,
            _count: {
              members: members.filter((m) => m.channelId === (r as any).id)
                .length,
            },
          }));
        }
        return out;
      }),
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

function baseAgentDouble() {
  return {
    runChannelTurn: jest.fn(async ({ channelPost }: any) => {
      await channelPost('working...');
      return { answer: 'final answer', steps: 3, trace: [{ step: 'x' }] };
    }),
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

  it('resolves reply agents only for real members: empty, case, and word edges', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());

    // A channel with no agent members gets no auto-reply.
    const lonely = await svc.create({ name: 'lonely' });
    expect(await svc.resolveReplyAgent(lonely.id, 'any message')).toBeNull();

    // Unknown channel -> 404 before any member logic.
    await expect(svc.resolveReplyAgent('nope', 'hi')).rejects.toThrow(
      NotFoundException,
    );

    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });
    await svc.addMember(d.id, 'researcher');

    // @mention is case-insensitive with a word boundary.
    expect(await svc.resolveReplyAgent(d.id, 'please look @CODER now')).toBe(
      'coder',
    );
    // A name inside a longer word is NOT a mention -> falls back to first.
    expect(await svc.resolveReplyAgent(d.id, 'ccoder is the best')).toBe(
      'coder',
    );
  });

  it('postMessage and listMessages round-trip role/author/text/toolCalls', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });

    const posted = await svc.postMessage(d.id, 'agent', 'coder', 'done', [
      { name: 'read_file', arguments: '{}' },
    ]);
    expect(posted.role).toBe('agent');
    expect(posted.author).toBe('coder');
    expect(posted.text).toBe('done');
    expect(posted.toolCalls).toEqual([{ name: 'read_file', arguments: '{}' }]);

    const listed = await svc.listMessages(d.id);
    expect(listed.at(-1)).toMatchObject({
      role: 'agent',
      author: 'coder',
      text: 'done',
    });
    expect(listed.at(-1)!.toolCalls).toEqual([
      { name: 'read_file', arguments: '{}' },
    ]);

    await expect(
      svc.postMessage('ghost', 'user', 'coder', 'x'),
    ).rejects.toThrow(NotFoundException);
    await expect(svc.listMessages('ghost')).rejects.toThrow(NotFoundException);
  });

  it('get() maps members, messages, and the channel project tree', async () => {
    const { prisma } = prismaDouble();
    const ws = workspacesDouble();
    (ws as any).listProjectContent = jest.fn(async () => ({
      files: ['note.txt'],
    }));
    const svc = new ChannelService(prisma, ws);
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });

    const detail = await svc.get(d.id);
    expect(detail.members).toEqual(['coder']);
    expect(detail.projectTree).toEqual({ files: ['note.txt'] });
    await expect(svc.get('ghost')).rejects.toThrow(NotFoundException);
  });

  it('prepareChannelTurn builds the thread with the you/author mapping', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });
    await svc.addMember(d.id, 'researcher');

    // Seed context: a past human request, a system-trace line (kept for
    // system author), and a prior agent answer with tool calls.
    await svc.postMessage(d.id, 'user', 'researcher', 'summarize the logs');
    await svc.postMessage(d.id, 'system', 'system', 'trace note');
    await svc.postMessage(d.id, 'agent', 'coder', 'checking...', [
      { name: 'read_file' },
    ]);

    const prepared = await svc.prepareChannelTurn({
      channelId: d.id,
      agentName: 'coder',
      message: 'continue',
    });
    expect(prepared.channel).toEqual({
      slug: 'team',
      projectName: 'team',
    });
    // The asker's own voice is mapped to "you".
    expect(prepared.thread).toContain('[researcher] summarize the logs');
    expect(prepared.thread).toContain('[system] trace note');
    expect(prepared.thread).toContain('[you] checking...');
    // The new human request is persisted into the feed.
    const feed = await svc.listMessages(d.id);
    expect(feed.at(-1)).toMatchObject({
      role: 'user',
      author: 'coder',
      text: 'continue',
    });
  });

  it('prepareChannelTurn skips persisting when the caller already wrote the message', async () => {
    const { prisma, messages } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });

    await svc.postMessage(d.id, 'user', 'coder', 'already in the feed');
    const before = messages.length;

    const prepared = await svc.prepareChannelTurn({
      channelId: d.id,
      agentName: 'coder',
      message: 'already in the feed',
      persistHuman: false,
    });
    expect(messages.length).toBe(before);
    expect(prepared.thread).toContain('[you] already in the feed');

    // Non-member agents are rejected before any thread is built.
    await expect(
      svc.prepareChannelTurn({
        channelId: d.id,
        agentName: 'researcher',
        message: 'sneak in',
      }),
    ).rejects.toThrow(BadRequestException);
    expect(messages.length).toBe(before);
  });

  it('list() returns ordered summaries with member counts', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const alpha = await svc.create({ name: 'alpha', creatorAgent: 'coder' });
    const beta = await svc.create({ name: 'beta' });
    await svc.addMember(beta.id, 'researcher');

    const list = await svc.list();
    expect(list.map((c) => c.slug)).toEqual(['alpha', 'beta']);
    expect(list[0]).toMatchObject({
      id: alpha.id,
      name: 'alpha',
      memberCount: 1,
    });
    expect(list[1]).toMatchObject({ name: 'beta', memberCount: 1 });
    expect(list[0].createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('deletionCandidates returns the channel and all sub-channels', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const parent = await svc.create({ name: 'team', creatorAgent: 'coder' });
    const sub = await svc.ensureSubChannel(parent.id, 'coder');
    const solo = await svc.create({ name: 'solo' });

    await expect(svc.deletionCandidates('nope')).rejects.toThrow(
      NotFoundException,
    );
    await expect(svc.deletionCandidates(parent.id)).resolves.toEqual([
      parent.id,
      sub.id,
    ]);
    await expect(svc.deletionCandidates(solo.id)).resolves.toEqual([solo.id]);
  });

  it('remove() deletes the row and prunes the empty project folder', async () => {
    const { prisma, rows } = prismaDouble();
    const ws = workspacesDouble();
    (ws as any).removeProjectIfEmpty = jest.fn(async () => ({ removed: true }));
    const svc = new ChannelService(prisma, ws);
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });

    await expect(svc.remove('nope')).rejects.toThrow(NotFoundException);
    await expect(svc.remove(d.id)).resolves.toEqual({ deleted: true });
    expect(rows.has(d.id)).toBe(false);
    expect((ws as any).removeProjectIfEmpty).toHaveBeenCalledWith('team');
  });

  it('prepareChannelTurn rejects unknown channels with 404', async () => {
    const { prisma } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    await expect(
      svc.prepareChannelTurn({
        channelId: 'ghost',
        agentName: 'coder',
        message: 'hi',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('runTurn delegates to the base agent and persists its final answer', async () => {
    const { prisma, messages } = prismaDouble();
    const svc = new ChannelService(prisma, workspacesDouble());
    const d = await svc.create({ name: 'team', creatorAgent: 'coder' });
    const base = baseAgentDouble();

    const out = await svc.runTurn(base, d.id, 'coder', 'do the thing', 'fast');
    expect(out).toEqual({
      answer: 'final answer',
      steps: 3,
      trace: [{ step: 'x' }],
    });
    expect((base as any).runChannelTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team',
        message: 'do the thing',
        model: 'fast',
      }),
    );

    const posted = messages.filter((m) => (m as any).channelId === d.id);
    expect(posted.at(-2)).toMatchObject({
      role: 'agent',
      author: 'coder',
      text: 'working...',
    });
    expect(posted.at(-1)).toMatchObject({
      role: 'agent',
      author: 'coder',
      text: 'final answer',
    });
  });
});
