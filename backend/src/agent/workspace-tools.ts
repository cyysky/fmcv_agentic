import { createWriteStream, promises as fs } from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import type { BaseTool } from './base-agent.service';
import { WorkspaceService } from './workspace.service';

/** Max file size (bytes) `read_workspace_file` will return. */
const MAX_FILE_BYTES = 100 * 1024;
/** Max binary payload a save_binary-family tool will write (matches the
 *  /buckets upload cap of 100 MB; keeps the workspace disk bounded). */
const MAX_BINARY_BYTES = 100 * 1024 * 1024;
/** Timeout for the streamed URL-download path of the save_binary tools. */
const DOWNLOAD_TIMEOUT_MS = 60_000;

function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${key} must be a non-empty string`);
  }
  return v;
}

function argOptionalString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '.';
}
/** Decode a base64 string into bytes, validating the payload strictly enough
 *  that `Buffer.from(..., 'base64')` cannot silently accept garbage. Padded
 *  and unpadded base64 both work; whitespace is ignored. */
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

/** Stream an http(s) URL into `target`, enforcing the MAX_BINARY_BYTES cap on
 *  the declared content-length AND on the live body stream, cleaning up the
 *  partial file when a download fails mid-stream. */
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

/**
 * Write binary content to an already-safe-resolved target. Exactly one of
 * `base64` (decoded bytes) or `url` (streamed download) must be provided;
 * never echo the bytes back into the tool result, only metadata.
 */
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
 * Build self-scoped workspace tools for a named agent. These tools operate
 * exclusively on the agent's OWN folder (agents/<agentName>) and take NO
 * `agent` argument, so the model never has to guess its own name — the
 * binding is done here at build time. This eliminates the "guess the folder
 * name" loop (list_workspace agent=base / fmcv / fmccagent ... x46).
 */
export function buildSelfTools(
  ws: WorkspaceService,
  agentName: string,
): BaseTool[] {
  /** Recursive JSON tree of the agent's own folder. */
  const listOwn: BaseTool['run'] = async (args) => {
    const root = ws.getAgentRoot(agentName);
    const relPath = typeof args.path === 'string' ? args.path : '.';
    const target = await ws.safeResolve(
      root,
      relPath.replace(/^\/+/, '') || '.',
    );
    return ws.readTree(target);
  };

  /** Read a file from the agent's own folder (size-capped). */
  const readOwn: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const root = ws.getAgentRoot(agentName);
    const target = await ws.safeResolve(root, relPath);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      throw new Error('read_own_file expects a file');
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`,
      );
    }
    const content = await fs.readFile(target, 'utf8');
    return { path: target, size: stat.size, content };
  };

  /** Write a file into the agent's own folder. */
  const writeOwn: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : '';
    const root = ws.getAgentRoot(agentName);
    const target = await ws.safeResolve(root, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return {
      written: true,
      path: target,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  };

  /** Save binary content into the agent's own folder (base64 or URL). */
  const saveOwnBinary: BaseTool['run'] = async (args) => {
    const relPath = argString(args, 'path');
    const target = await ws.safeResolve(ws.getAgentRoot(agentName), relPath);
    return saveBinaryTo(target, args);
  };

  return [
    {
      name: 'list_own_workspace',
      description:
        `List the recursive JSON tree of YOUR OWN agent folder ` +
        `(agents/${agentName}). Use this instead of list_workspace when you need ` +
        `to see your own files — no agent argument required. ` +
        `args: { path?: string }.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative path inside your own folder (default ".").',
          },
        },
        required: [],
      },
      run: listOwn,
    },
    {
      name: 'read_own_file',
      description:
        `Read the contents of a file from YOUR OWN agent folder ` +
        `(agents/${agentName}). Size-capped at 100KB. ` +
        `args: { path: string }.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside your own folder.',
          },
        },
        required: ['path'],
      },
      run: readOwn,
    },
    {
      name: 'write_own_file',
      description:
        `Write content into a file in YOUR OWN agent folder ` +
        `(agents/${agentName}). Creates parent directories as needed. ` +
        `args: { path, content }.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside your own folder.',
          },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['path', 'content'],
      },
      run: writeOwn,
    },
    {
      name: 'save_own_binary',
      description:
        `Save BINARY content (PDF, image, archive, etc.) into a file in ` +
        `YOUR OWN agent folder (agents/${agentName}). Provide base64 ` +
        `(decoded to bytes) or url (downloaded and streamed to disk, max ` +
        `${MAX_BINARY_BYTES} bytes). Use this instead of write_own_file when ` +
        `the payload is a real binary file — never fall back to saving .md ` +
        `text. Creates parent directories as needed. ` +
        `args: { path, base64?, url? } — exactly one of base64 or url.`,
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Relative file path inside your own folder.',
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
      run: saveOwnBinary,
    },
  ];
}

/**
 * Build the scoped workspace file tools for the base agent. Every path is
 * resolved through `WorkspaceService.safeResolve` against the selected root,
 * so no tool can escape its allowed folder.
 */
export function buildWorkspaceTools(ws: WorkspaceService): BaseTool[] {
  /** Recursive JSON tree of an agent's own folder or a public project. */
  const listWorkspace: BaseTool['run'] = async (args) => {
    // `agent` is only needed for agent-folder listings; public-project
    // listings (path "projects/...") work without it.
    const agent = typeof args.agent === 'string' ? args.agent : '';
    const relPath = argOptionalString(args, 'path');
    const normalized = relPath.replace(/^\/+/, '');

    // A `path` prefixed with `projects/` lists a shared public project.
    if (normalized === 'projects' || normalized.startsWith('projects/')) {
      const root = ws.getProjectRoot();
      const sub =
        normalized === 'projects' ? '.' : normalized.slice('projects/'.length);
      const target = await ws.safeResolve(root, sub || '.');
      return ws.readTree(target);
    }

    if (!agent) throw new Error('agent must be a non-empty string');
    ws.assertAgentName(agent);
    const root = ws.getAgentRoot(agent);
    const target = await ws.safeResolve(root, relPath || '.');
    return ws.readTree(target);
  };

  /** Read a file from a public project or an agent's own folder (size-capped). */
  const readWorkspaceFile: BaseTool['run'] = async (args) => {
    const kind = argString(args, 'kind');
    const name = argString(args, 'name');
    const relPath = argOptionalString(args, 'path');

    let root: string;
    if (kind === 'project') {
      ws.sanitizeName(name);
      root = path.join(ws.getProjectRoot(), name);
    } else if (kind === 'agent') {
      root = ws.getAgentRoot(name);
    } else {
      throw new Error("kind must be 'project' or 'agent'");
    }

    const target = await ws.safeResolve(root, relPath);
    const stat = await fs.stat(target);
    if (stat.isDirectory()) {
      throw new Error('read_workspace_file expects a file');
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`,
      );
    }
    const content = await fs.readFile(target, 'utf8');
    return { path: target, size: stat.size, content };
  };

  /** Write into an agent's own folder (never into public projects). */
  const writeWorkspaceFile: BaseTool['run'] = async (args) => {
    const name = argString(args, 'name');
    const relPath = argString(args, 'path');
    const content = typeof args.content === 'string' ? args.content : '';

    // Writable only by the caller's own named agent; unknown names rejected.
    const root = ws.getAgentRoot(name);
    const target = await ws.safeResolve(root, relPath);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
    return {
      written: true,
      path: target,
      bytes: Buffer.byteLength(content, 'utf8'),
    };
  };

  /** Save binary content into a named agent's own folder. */
  const saveWorkspaceBinary: BaseTool['run'] = async (args) => {
    const name = argString(args, 'name');
    const relPath = argString(args, 'path');
    const target = await ws.safeResolve(ws.getAgentRoot(name), relPath);
    return saveBinaryTo(target, args);
  };

  return [
    {
      name: 'list_workspace',
      description:
        "List a recursive JSON tree of a named agent's own folder " +
        '(agents/<agent>/...) or a shared public project (path starting with ' +
        '"projects/"). args: { agent: string, path: string }.',
      parameters: {
        type: 'object',
        properties: {
          agent: {
            type: 'string',
            description:
              'Named agent id (e.g. coder, researcher) — required only when ' +
              'path does NOT start with "projects/".',
          },
          path: {
            type: 'string',
            description:
              'Relative path inside the agent folder, or "projects/<name>" to list a public project.',
          },
        },
        required: [],
      },
      run: listWorkspace,
    },
    {
      name: 'read_workspace_file',
      description:
        'Read the contents of a file from a public project (kind="project") or ' +
        'a named agent\'s own folder (kind="agent"). Size-capped at 100KB. ' +
        'args: { kind, name, path }.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['project', 'agent'] },
          name: { type: 'string', description: 'Project or named agent id.' },
          path: {
            type: 'string',
            description: 'Relative file path within the selected root.',
          },
        },
        required: ['kind', 'name', 'path'],
      },
      run: readWorkspaceFile,
    },
    {
      name: 'write_workspace_file',
      description:
        "Write content into a named agent's own folder. Cannot write into " +
        'public projects. Creates parent directories as needed. ' +
        'args: { name, path, content }.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "Named agent id (the caller's own folder).",
          },
          path: {
            type: 'string',
            description: 'Relative file path within the agent folder.',
          },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['name', 'path', 'content'],
      },
      run: writeWorkspaceFile,
    },
    {
      name: 'save_binary',
      description:
        'Save BINARY content (PDF, image, archive, etc.) into a named ' +
        "agent's own folder. Provide base64 (decoded to bytes) or url " +
        '(downloaded and streamed to disk, max 100MB). Use this instead of ' +
        'write_workspace_file when the payload is a real binary file — never ' +
        'fall back to saving .md text. Creates parent directories as needed. ' +
        'args: { name, path, base64?, url? } — exactly one of base64 or url.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: "Named agent id (the caller's own folder).",
          },
          path: {
            type: 'string',
            description: 'Relative file path within the agent folder.',
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
        required: ['name', 'path'],
      },
      run: saveWorkspaceBinary,
    },
  ];
}
