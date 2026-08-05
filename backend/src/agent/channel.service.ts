import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { BaseAgentService } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import { PrismaService } from '../prisma/prisma.service';

/** Slug/name: alphanumeric + dash + underscore. */
const SLUG_RE = /^[A-Za-z0-9_-]+$/;

export interface ChannelSummary {
  id: string;
  slug: string;
  name: string;
  projectName: string;
  parentId: string | null;
  agentName: string | null;
  memberCount: number;
  createdAt: string;
}

export interface ChannelDetail extends ChannelSummary {
  members: string[];
  messages: ChannelMessageDto[];
  projectTree: Record<string, unknown>;
}

export interface ChannelMessageDto {
  id: string;
  role: string; // user | agent | system
  author: string;
  text: string;
  toolCalls?: unknown[];
  createdAt: string;
}

/**
 * Team-communication layer for the agentic workspace.
 *
 * Each channel owns exactly one project folder (under `projects/<slug>`),
 * and named agents can be added to multiple channels. Channel messages form
 * a Slack-like thread, and a channel turn lets an agent work directly on
 * that channel's project folder (plus its own agent folder) and post
 * updates back to the feed.
 */
@Injectable()
export class ChannelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly workspaces: WorkspaceService,
  ) {}

  private slugify(name: string): string {
    // Slugify is forgiving: anything outside [a-z0-9_-] becomes a dash, then
    // stray leading/trailing dashes are trimmed. A name with nothing left
    // (e.g. only spaces) is rejected.
    const s = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
    if (!s) throw new BadRequestException('Channel name cannot be empty');
    if (!SLUG_RE.test(s)) {
      throw new BadRequestException(
        'Channel slug must be alphanumeric, dash or underscore only',
      );
    }
    return s;
  }

  /**
   * Create a channel. It auto-creates its own project folder under
   * `projects/<slug>` (or the provided `projectName`), and adds the creator
   * agent as the first member if `creatorAgent` is given.
   */
  async create(input: {
    name: string;
    projectName?: string;
    creatorAgent?: string;
  }): Promise<ChannelDetail> {
    const slug = this.slugify(input.name);
    const projectName =
      input.projectName?.trim() || slug;

    // Persist the channel row first.
    const existing = await this.prisma.channel.findUnique({ where: { slug } });
    if (existing) {
      throw new BadRequestException(`Channel #${slug} already exists`);
    }

    // Ensure the owning project folder exists on disk.
    await this.workspaces.createPublicProject(projectName);

    const channel = await this.prisma.channel.create({
      data: { slug, name: input.name.trim(), projectName },
    });

    if (input.creatorAgent) {
      try {
        await this.addMember(channel.id, input.creatorAgent);
      } catch {
        // Non-fatal: a bad creator agent name shouldn't fail channel creation.
      }
    }

    await this.postMessage(channel.id, 'system', 'system', `Channel #${slug} created.`);
    return this.get(channel.id);
  }

  /** Create (or return the existing) sub-channel for an agent in a channel.
   *  Sub-channels host the agent's debug trace + user↔agent discussion, so the
   *  main channel feed stays clean (final message only). Named
   *  `{agentName}` under a parent channel (the UI shows the parent name for
   *  context). Idempotent per (parentId, agentName). */
  async ensureSubChannel(
    parentId: string,
    agentName: string,
  ): Promise<ChannelDetail> {
    const parent = await this.prisma.channel.findUnique({ where: { id: parentId } });
    if (!parent) throw new NotFoundException(`Channel ${parentId} not found`);

    // If this channel is already a sub-channel (has a parent), it IS the debug
    // channel — don't nest. This prevents an auto-reply inside a sub-channel
    // from creating a sub-sub-channel.
    if (parent.parentId) return this.get(parent.id);

    const existing = await this.prisma.channel.findFirst({
      where: { parentId, agentName },
    });
    if (existing) return this.get(existing.id);

    const slug = `${parent.slug}-${agentName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}`;
    const channel = await this.prisma.channel.create({
      data: {
        slug,
        name: `${agentName}`,
        projectName: parent.projectName,
        parentId,
        agentName,
      },
    });

    // The sub-channel shares the parent's project folder; give it the parent
    // members so the agent (and humans) can be addressed there. Copy parent
    // members into the sub-channel.
    const parentMembers = await this.prisma.channelMember.findMany({
      where: { channelId: parentId },
    });
    await this.prisma.channelMember.createMany({
      data: parentMembers.map((m) => ({
        channelId: channel.id,
        agentName: m.agentName,
      })),
      skipDuplicates: true,
    });

    await this.postMessage(
      channel.id,
      'system',
      'system',
      `Debug trace channel for ${agentName} in #${parent.slug}.`,
    );
    return this.get(channel.id);
  }

  async list(): Promise<ChannelSummary[]> {
    const channels = await this.prisma.channel.findMany({
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { members: true } } },
    });
    return channels.map((c) => ({
      id: c.id,
      slug: c.slug,
      name: c.name,
      projectName: c.projectName,
      parentId: c.parentId,
      agentName: c.agentName,
      memberCount: c._count.members,
      createdAt: c.createdAt.toISOString(),
    }));
  }

  async get(id: string): Promise<ChannelDetail> {
    const channel = await this.prisma.channel.findUnique({
      where: { id },
      include: { members: true, messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!channel) throw new NotFoundException(`Channel ${id} not found`);

    const projectTree = await this.workspaces.listProjectContent(
      channel.projectName,
    );

    return {
      id: channel.id,
      slug: channel.slug,
      name: channel.name,
      projectName: channel.projectName,
      parentId: channel.parentId,
      agentName: channel.agentName,
      memberCount: channel.members.length,
      createdAt: channel.createdAt.toISOString(),
      members: channel.members.map((m) => m.agentName),
      messages: channel.messages.map((m) => ({
        id: m.id,
        role: m.role,
        author: m.author,
        text: m.text,
        toolCalls: (m.toolCalls as unknown[]) ?? undefined,
        createdAt: m.createdAt.toISOString(),
      })),
      projectTree,
    };
  }

  async remove(id: string): Promise<{ deleted: boolean }> {
    const channel = await this.prisma.channel.findUnique({ where: { id } });
    if (!channel) throw new NotFoundException(`Channel ${id} not found`);
    await this.prisma.channel.delete({ where: { id } });
    return { deleted: true };
  }

  /** Add a named agent to a channel (idempotent). */
  async addMember(channelId: string, agentName: string): Promise<ChannelDetail> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    this.workspaces.assertAgentName(agentName);
    await this.workspaces.ensureAgentFolder(agentName);

    await this.prisma.channelMember.upsert({
      where: { channelId_agentName: { channelId, agentName } },
      create: { channelId, agentName },
      update: {},
    });
    await this.postMessage(
      channelId,
      'system',
      'system',
      `Agent ${agentName} joined #${channel.slug}.`,
    );

    return this.get(channelId);
  }

  /** Remove a named agent from a channel. */
  async removeMember(
    channelId: string,
    agentName: string,
  ): Promise<ChannelDetail> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    this.workspaces.assertAgentName(agentName);
    const existing = await this.prisma.channelMember.findUnique({
      where: { channelId_agentName: { channelId, agentName } },
    });
    if (!existing) {
      throw new BadRequestException(
        `Agent ${agentName} is not a member of #${channel.slug}`,
      );
    }

    await this.prisma.channelMember.delete({
      where: { channelId_agentName: { channelId, agentName } },
    });
    await this.postMessage(
      channelId,
      'system',
      'system',
      `Agent ${agentName} left #${channel.slug}.`,
    );

    return this.get(channelId);
  }

  async listMessages(channelId: string): Promise<ChannelMessageDto[]> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
    const messages = await this.prisma.channelMessage.findMany({
      where: { channelId },
      orderBy: { createdAt: 'asc' },
    });
    return messages.map((m) => ({
      id: m.id,
      role: m.role,
      author: m.author,
      text: m.text,
      toolCalls: (m.toolCalls as unknown[]) ?? undefined,
      createdAt: m.createdAt.toISOString(),
    }));
  }

  /** Append a message to the channel feed. */
  async postMessage(
    channelId: string,
    role: string,
    author: string,
    text: string,
    toolCalls?: unknown[],
  ): Promise<ChannelMessageDto> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    const msg = await this.prisma.channelMessage.create({
      data: {
        channelId,
        role,
        author,
        text,
        toolCalls: (toolCalls as Prisma.InputJsonValue | undefined) ?? undefined,
      },
    });
    return {
      id: msg.id,
      role: msg.role,
      author: msg.author,
      text: msg.text,
      toolCalls: (msg.toolCalls as unknown[]) ?? undefined,
      createdAt: msg.createdAt.toISOString(),
    };
  }

  /**
   * Run an agent turn inside a channel. The agent works on the channel's
   * project folder (plus its own agent folder) and can post to the feed.
   * Recent channel messages are injected as context so it "sees" the thread.
   */
  async runTurn(
    baseAgent: BaseAgentService,
    channelId: string,
    agentName: string,
    message: string,
    model?: string,
  ): Promise<{ answer: string; steps: number; trace?: unknown[] }> {
    const { channel, thread } = await this.prepareChannelTurn({
      channelId,
      agentName,
      message,
    });

    const result = await baseAgent.runChannelTurn({
      agentName,
      channelSlug: channel.slug,
      channelProjectName: channel.projectName,
      thread,
      message,
      model,
      channelPost: async (text: string, toolCalls?: unknown[]) => {
        return this.postMessage(channelId, 'agent', agentName, text, toolCalls);
      },
    });

    // Persist the agent's final answer into the feed.
    await this.postMessage(channelId, 'agent', agentName, result.answer, result.trace);
    return { answer: result.answer, steps: result.steps, trace: result.trace };
  }

  /**
   * Pick the agent that should auto-reply to a human post: the @mentioned
   * member if any, else the first member. Returns null when the channel has
   * no agent members, so callers can skip auto-reply.
   */
  async resolveReplyAgent(channelId: string, text: string): Promise<string | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
      include: { members: true },
    });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);
    const members = channel.members.map((m) => m.agentName);
    if (members.length === 0) return null;
    for (const m of members) {
      if (new RegExp(`@${m}\\b`, 'i').test(text)) return m;
    }
    return members[0];
  }

  /**
   * Shared setup for a channel turn: validate the agent is a member, persist
   * the human request, and build the thread context. Used by the blocking
   * `runTurn` and the streaming job layer.
   *
   * Pass `persistHuman: false` when the human message was already written to
   * the feed by the caller (e.g. the auto-reply path in postMessage), to
   * avoid duplicating it.
   */
  async prepareChannelTurn(input: {
    channelId: string;
    agentName: string;
    message: string;
    persistHuman?: boolean;
  }): Promise<{
    channel: { slug: string; projectName: string };
    thread: string;
  }> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: input.channelId },
      include: { members: true },
    });
    if (!channel) {
      throw new NotFoundException(`Channel ${input.channelId} not found`);
    }

    this.workspaces.assertAgentName(input.agentName);
    const isMember = channel.members.some((m) => m.agentName === input.agentName);
    if (!isMember) {
      throw new BadRequestException(
        `Agent ${input.agentName} is not a member of #${channel.slug}`,
      );
    }

    // Persist the human request unless the caller already did.
    if (input.persistHuman !== false) {
      await this.postMessage(input.channelId, 'user', input.agentName, input.message);
    }

    const recent = await this.prisma.channelMessage.findMany({
      where: { channelId: input.channelId },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    const thread = recent
      .reverse()
      .filter((m) => m.role !== 'system' || m.author === 'system')
      .map((m) => {
        const who = m.author === input.agentName ? 'you' : m.author;
        return `[${who}] ${m.text}`;
      })
      .join('\n');

    return {
      channel: { slug: channel.slug, projectName: channel.projectName },
      thread,
    };
  }
}
