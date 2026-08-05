import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { promises as fs } from 'fs';
import * as path from 'path';

/** A named agent with its own fixed working folder. */
export interface NamedAgent {
  name: string;
  label: string;
  description: string;
}

/** Static registry of named agents. */
export const NAMED_AGENTS: NamedAgent[] = [
  { name: 'coder', label: 'Coder', description: 'Writes code in its own folder.' },
  {
    name: 'researcher',
    label: 'Researcher',
    description: 'Reads public projects, writes notes in its own folder.',
  },
];

/** Allowed characters for project / agent names. */
const NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Filesystem workspace for the base agent.
 *
 * Layout under a single configurable root (`AGENT_WORKSPACE_ROOT`, default
 * `/data/workspaces`):
 *
 *   <root>/
 *   ├── projects/   # PUBLIC shared folders (read-only from tools)
 *   └── agents/
 *       ├── coder/      # coder's own writable folder
 *       └── researcher/ # researcher's own writable folder
 *
 * `safeResolve` is the single enforcement point for every path resolution:
 * it rejects `..` / absolute escapes / symlink escapes outside the allowed
 * root.
 */
@Injectable()
export class WorkspaceService {
  private readonly root: string;

  constructor(config: ConfigService) {
    this.root = path.resolve(
      config.get<string>('AGENT_WORKSPACE_ROOT', '/data/workspaces') ?? '/data/workspaces',
    );
  }

  getRoot(): string {
    return this.root;
  }

  getProjectRoot(): string {
    return path.join(this.root, 'projects');
  }

  getAgentRoot(agentName: string): string {
    this.assertAgentName(agentName);
    return path.join(this.root, 'agents', agentName);
  }

  getAgentWorkDir(agentName: string): string {
    return path.join(this.getAgentRoot(agentName), 'work');
  }

  /** Reject project names that aren't alphanumeric + `-` / `_`. */
  sanitizeName(name: string): string {
    if (!NAME_RE.test(name)) {
      throw new BadRequestException(
        'Invalid name: alphanumeric, dash and underscore only',
      );
    }
    return name;
  }

  /** Reject unknown named agents. The error lists the valid names so a
   *  calling model can recover on the first miss instead of guessing. */
  assertAgentName(name: string): void {
    this.sanitizeName(name);
    if (!NAMED_AGENTS.some((a) => a.name === name)) {
      throw new BadRequestException(
        `Unknown agent: ${name}. Valid named agents: ${NAMED_AGENTS.map((a) => a.name).join(', ')}`,
      );
    }
  }

  /** Public project folders currently present on disk. */
  async listPublicProjects(): Promise<{ name: string; path: string }[]> {
    const root = this.getProjectRoot();
    const names = await this.readDirNames(root);
    return names.map((name) => ({ name, path: path.join(root, name) }));
  }

  /** Create a public project folder (the only way public projects are made). */
  async createPublicProject(name: string): Promise<{ name: string; path: string }> {
    const safe = this.sanitizeName(name);
    const dir = path.join(this.getProjectRoot(), safe);
    await fs.mkdir(dir, { recursive: true });
    return { name: safe, path: dir };
  }

  /** Ensure a named agent's folder (and its `work/` dir) exists on disk. */
  async ensureAgentFolder(name: string): Promise<{
    name: string;
    path: string;
    workDir: string;
  }> {
    this.assertAgentName(name);
    const root = this.getAgentRoot(name);
    const workDir = this.getAgentWorkDir(name);
    await fs.mkdir(workDir, { recursive: true });
    return { name, path: root, workDir };
  }

  /** Snapshot of root + public projects + named agents (folder paths). */
  async getWorkspaceInfo(): Promise<{
    root: string;
    projectsDir: string;
    projects: { name: string; path: string }[];
    agents: {
      name: string;
      label: string;
      description: string;
      root: string;
      workDir: string;
    }[];
  }> {
    const projects = await this.listPublicProjects();
    return {
      root: this.getRoot(),
      projectsDir: this.getProjectRoot(),
      projects,
      agents: NAMED_AGENTS.map((a) => ({
        name: a.name,
        label: a.label,
        description: a.description,
        root: this.getAgentRoot(a.name),
        workDir: this.getAgentWorkDir(a.name),
      })),
    };
  }

  /** Recursive JSON tree of a directory's contents (files -> null). */
  async readTree(dir: string, maxDepth = 5): Promise<Record<string, unknown>> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const items: Record<string, unknown> = {};
      for (const entry of entries) {
        if (entry.isDirectory()) {
          items[entry.name] =
            maxDepth > 0
              ? await this.readTree(path.join(dir, entry.name), maxDepth - 1)
              : {};
        } else {
          items[entry.name] = null;
        }
      }
      return items;
    } catch {
      return {};
    }
  }

  /** Listing helper used by the read-only controller endpoints. */
  async listProjectContent(name: string): Promise<Record<string, unknown>> {
    const safe = this.sanitizeName(name);
    return this.readTree(path.join(this.getProjectRoot(), safe));
  }

  async listAgentContent(name: string): Promise<Record<string, unknown>> {
    this.assertAgentName(name);
    return this.readTree(this.getAgentRoot(name));
  }

  private async readDirNames(dir: string): Promise<string[]> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Single path-enforcement point. Resolves `root/relPath` and asserts the
   * result stays inside `root`, rejecting `..`, absolute escapes and symlink
   * escapes. Mirrors `context_references._resolve_path`.
   */
  async safeResolve(root: string, relPath: string): Promise<string> {
    const resolvedRoot = path.resolve(root);
    const target = path.resolve(resolvedRoot, relPath);

    // 1. Lexical containment check.
    if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
      throw new Error('path outside allowed root');
    }

    // 2. Symlink escape check: resolve the real path of the deepest existing
    //    ancestor and ensure it still lives inside the real root.
    let realRoot: string | null = null;
    try {
      realRoot = await fs.realpath(resolvedRoot);
    } catch {
      realRoot = null;
    }

    if (realRoot) {
      let probe = target;
      for (;;) {
        try {
          const real = await fs.realpath(probe);
          if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
            throw new Error('path outside allowed root');
          }
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            const parent = path.dirname(probe);
            if (parent === probe) throw new Error('unable to resolve path');
            probe = parent;
            continue;
          }
          throw err;
        }
      }
    }

    return target;
  }
}
