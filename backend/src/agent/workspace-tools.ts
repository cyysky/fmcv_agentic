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
 * Build the scoped workspace file tools for the base agent. Every path is
 * resolved through `WorkspaceService.safeResolve` against the selected root,
 * so no tool can escape its allowed folder.
 */
export function buildWorkspaceTools(ws: WorkspaceService): BaseTool[] {
  /** Recursive JSON tree of an agent's own folder or a public project. */
  const listWorkspace: BaseTool['run'] = async (args) => {
    const agent = argString(args, 'agent');
    let relPath = argOptionalString(args, 'path');
    const normalized = relPath.replace(/^\/+/, '');

    // A `path` prefixed with `projects/` lists a shared public project.
    if (normalized === 'projects' || normalized.startsWith('projects/')) {
      const root = ws.getProjectRoot();
      const sub = normalized === 'projects' ? '.' : normalized.slice('projects/'.length);
      const target = await ws.safeResolve(root, sub || '.');
      return ws.readTree(target);
    }

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
          agent: { type: 'string', description: 'Named agent id (e.g. coder, researcher).' },
          path: {
            type: 'string',
            description:
              'Relative path inside the agent folder, or "projects/<name>" to list a public project.',
          },
        },
        required: ['agent', 'path'],
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
