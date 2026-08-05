import { promises as fs } from 'fs';
import * as path from 'path';
import type { BaseTool } from './base-agent.service';
import { WorkspaceService } from './workspace.service';

/** Max file size (bytes) `read_workspace_file` will return. */
const MAX_FILE_BYTES = 100 * 1024;

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
    const target = await ws.safeResolve(root, relPath.replace(/^\/+/, '') || '.');
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
      throw new Error(`file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`);
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
    return { written: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
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
    let relPath = argOptionalString(args, 'path');
    const normalized = relPath.replace(/^\/+/, '');

    // A `path` prefixed with `projects/` lists a shared public project.
    if (normalized === 'projects' || normalized.startsWith('projects/')) {
      const root = ws.getProjectRoot();
      const sub = normalized === 'projects' ? '.' : normalized.slice('projects/'.length);
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
      throw new Error(`file too large (${stat.size} bytes, max ${MAX_FILE_BYTES})`);
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
    return { written: true, path: target, bytes: Buffer.byteLength(content, 'utf8') };
  };

  return [
    {
      name: 'list_workspace',
      description:
        'List a recursive JSON tree of a named agent\'s own folder ' +
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
        "a named agent's own folder (kind=\"agent\"). Size-capped at 100KB. " +
        'args: { kind, name, path }.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['project', 'agent'] },
          name: { type: 'string', description: 'Project or named agent id.' },
          path: { type: 'string', description: 'Relative file path within the selected root.' },
        },
        required: ['kind', 'name', 'path'],
      },
      run: readWorkspaceFile,
    },
    {
      name: 'write_workspace_file',
      description:
        'Write content into a named agent\'s own folder. Cannot write into ' +
        'public projects. Creates parent directories as needed. ' +
        'args: { name, path, content }.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Named agent id (the caller\'s own folder).' },
          path: { type: 'string', description: 'Relative file path within the agent folder.' },
          content: { type: 'string', description: 'File contents to write.' },
        },
        required: ['name', 'path', 'content'],
      },
      run: writeWorkspaceFile,
    },
  ];
}
