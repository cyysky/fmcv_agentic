import { promises as fs } from 'fs';
import * as path from 'path';
import type { BaseTool } from './base-agent.service';
import { WorkspaceService } from './workspace.service';

/** Max file size (bytes) `channel_read` returns. */
const MAX_FILE_BYTES = 100 * 1024;

export interface ChannelToolContext {
  /** Agent running the turn (used to scope its own writable folder). */
  agentName: string;
  /** Channel slug (e.g. `team-alpha`). */
  channelSlug: string;
  /** Project folder name owned by the channel (e.g. matching the slug). */
  channelProjectName: string;
  /** Publish a message to the channel feed. */
  channelPost: (text: string, toolCalls?: unknown[]) => Promise<unknown>;
}

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v;
}

/**
 * Build channel-scoped tools. These let a channel agent write directly into
 * the channel's own project folder, plus its own agent folder, and publish
 * updates to the channel feed. Every path is resolved through
 * `WorkspaceService.safeResolve` so nothing can escape the allowed roots.
 */
export function buildChannelTools(
  ws: WorkspaceService,
  ctx: ChannelToolContext,
): BaseTool[] {
  /** List the channel project folder tree. */
  const channelList: BaseTool['run'] = async (args) => {
    const relPath = typeof args.path === 'string' ? args.path : '.';
    const root = path.join(ws.getProjectRoot(), ctx.channelProjectName);
    const target = await ws.safeResolve(root, relPath.replace(/^\/+/, '') || '.');
    return ws.readTree(target);
  };

  /** Read a file from the channel project folder (size-capped). */
  const channelRead: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const root = path.join(ws.getProjectRoot(), ctx.channelProjectName);
    const target = await ws.safeResolve(root, relPath);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      throw new Error('channel_read expects a file');
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(`file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`);
    }
    const content = await fs.readFile(target, 'utf8');
    return { path: target, size: stat.size, content };
  };

  /** Write a file into the channel project folder. */
  const channelWrite: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : '';
    const root = path.join(ws.getProjectRoot(), ctx.channelProjectName);
    const target = await ws.safeResolve(root, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return { written: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
  };

  /** Post a message to the channel feed (the agent "speaks" in the thread). */
  const channelPost: BaseTool['run'] = async (args) => {
    const text = argString(args, 'text');
    await ctx.channelPost(text);
    return { posted: true, channel: ctx.channelSlug };
  };

  return [
    {
      name: 'channel_list',
      description: `List the recursive JSON tree of the current team channel's project folder (project "${ctx.channelProjectName}"). args: { path: string }.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative path inside the channel project folder.' },
        },
        required: [],
      },
      run: channelList,
    },
    {
      name: 'channel_read',
      description: `Read a file from the current team channel's project folder (project "${ctx.channelProjectName}"). Size-capped at 100KB. args: { path: string }.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the channel project folder.' },
        },
        required: ['path'],
      },
      run: channelRead,
    },
    {
      name: 'channel_write',
      description: `Write content into a file in the current team channel's project folder (project "${ctx.channelProjectName}"). Creates parent directories as needed. args: { path, content }.`,
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative file path inside the channel project folder.' },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['path', 'content'],
      },
      run: channelWrite,
    },
    {
      name: 'channel_post',
      description: `Post a short update to the current team channel's message feed so other members/agents see it. args: { text: string }.`,
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The message text to post to the channel.' },
        },
        required: ['text'],
      },
      run: channelPost,
    },
  ];
}
