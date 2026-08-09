import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
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

/** Max binary payload a channel_save_binary can write (100 MB, matching the
 *  /buckets upload cap; keeps the workspace disk bounded). */
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
/** Timeout for the streamed URL-download path. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

/** Decode a base64 string into bytes, rejecting garbage that
 *  `Buffer.from(..., 'base64')` would otherwise silently accept. */
function decodeBase64(value: string): Buffer {
  const cleaned = value.replace(/\s+/g, '');
  if (!cleaned) throw new Error('base64 must be a non-empty string');
  const buf = Buffer.from(cleaned, 'base64');
  const normalized = buf.toString('base64').replace(/=+$/, '');
  if (buf.length === 0 || normalized !== cleaned.replace(/=+$/, '')) {
    throw new Error('base64 must be valid base64-encoded content');
  }
  return buf;
}

/** Stream an http(s) URL into `target`, capped on the declared
 *  content-length AND the live body stream, cleaning up partial files. */
async function streamDownloadToFile(
  url: string,
  target: string,
): Promise<{ bytes: number; finalUrl: string }> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('url must be an absolute http(s) URL');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent':
          'Mozilla/5.0 (compatible; fmcv-agent-binary/1.0; +agent download tool)',
      },
    });
    if (!res.ok || !res.body) {
      throw new Error(
        `Download failed: HTTP ${res.status ?? 'no response body'}`,
      );
    }
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > MAX_BINARY_BYTES) {
      throw new Error(
        `Download too large (${declared} bytes, max ${MAX_BINARY_BYTES})`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const out = createWriteStream(target);
    let bytes = 0;
    const cap = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (bytes > MAX_BINARY_BYTES) {
          cb(new Error(`Download exceeded the ${MAX_BINARY_BYTES} byte limit`));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(Readable.fromWeb(res.body as never), cap, out);
    } catch (err) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      throw err;
    }
    return { bytes, finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

/** Write binary content to a safe-resolved target: `base64` decoded bytes or
 *  `url` streamed to disk. Never echo bytes into the tool result. */
async function saveBinaryTo(
  target: string,
  args: Record<string, unknown>,
): Promise<{
  saved: true;
  path: string;
  bytes: number;
  via: 'base64' | 'url';
  url?: string;
}> {
  const hasBase64 =
    typeof args.base64 === 'string' && args.base64.trim() !== '';
  const hasUrl = typeof args.url === 'string' && args.url.trim() !== '';
  if (hasBase64 && hasUrl) {
    throw new Error('provide exactly one of base64 or url');
  }
  if (hasUrl) {
    const { bytes, finalUrl } = await streamDownloadToFile(
      (args.url as string).trim(),
      target,
    );
    return { saved: true, path: target, bytes, via: 'url', url: finalUrl };
  }
  if (hasBase64) {
    const buf = decodeBase64(args.base64 as string);
    if (buf.length > MAX_BINARY_BYTES) {
      throw new Error(
        `content too large (${buf.length} bytes, max ${MAX_BINARY_BYTES})`,
      );
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buf);
    return { saved: true, path: target, bytes: buf.length, via: 'base64' };
  }
  throw new Error('base64 or url must be provided');
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
    const target = await ws.safeResolve(
      root,
      relPath.replace(/^\/+/, '') || '.',
    );
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
      throw new Error(
        `file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`,
      );
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
    return {
      written: true,
      path: target,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  };

  /** Save binary content into the channel project folder (base64 or URL). */
  const channelSaveBinary: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const root = path.join(ws.getProjectRoot(), ctx.channelProjectName);
    const target = await ws.safeResolve(root, relPath);
    return saveBinaryTo(target, args);
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
          path: {
            type: 'string',
            description: 'Relative path inside the channel project folder.',
          },
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
          path: {
            type: 'string',
            description:
              'Relative file path inside the channel project folder.',
          },
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
          path: {
            type: 'string',
            description:
              'Relative file path inside the channel project folder.',
          },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['path', 'content'],
      },
      run: channelWrite,
    },
    {
      name: 'channel_save_binary',
      description:
        `Save BINARY content (PDF, image, archive, etc.) into a file in the ` +
        `current team channel's project folder (project "${ctx.channelProjectName}"). ` +
        `Provide base64 (decoded to bytes) or url (downloaded and streamed to ` +
        `disk, max 100MB). Use this instead of channel_write when the payload ` +
        `is a real binary file — never fall back to saving .md text. Creates ` +
        `parent directories as needed. args: { path, base64?, url? } — ` +
        `exactly one of base64 or url.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Relative file path inside the channel project folder.',
          },
          base64: {
            type: 'string',
            description: 'Binary file content encoded as base64.',
          },
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to download and save as-is.',
          },
        },
        required: ['path'],
      },
      run: channelSaveBinary,
    },
    {
      name: 'channel_post',
      description: `Post a short update to the current team channel's message feed so other members/agents see it. args: { text: string }.`,
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The message text to post to the channel.',
          },
        },
        required: ['text'],
      },
      run: channelPost,
    },
  ];
}
