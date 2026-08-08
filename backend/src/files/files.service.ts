import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { promises as fs, Stats } from 'fs';
import * as path from 'path';
import { WorkspaceService } from '../agent/workspace.service';

/** Max file size the viewer will read back (mirrors the agent tools). */
export const MAX_VIEW_BYTES = 100 * 1024;

export interface FileEntry {
  name: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

export interface FileListResult {
  scope: string;
  path: string;
  entries: FileEntry[];
}

export interface FileReadResult {
  scope: string;
  path: string;
  size: number;
  content: string;
}

export interface FileViewResult {
  target: string;
  fileName: string;
  size: number;
  contentType: string;
}

export interface FileWriteResult {
  scope: string;
  path: string;
  bytes: number;
}

export interface FileRemoveResult {
  scope: string;
  path: string;
  removed: boolean;
  type: 'file' | 'directory';
}

/** A validated scope: public project (read-only) or named agent (writable). */
type Scope =
  | { kind: 'project'; name: string; root: string; writable: false }
  | { kind: 'agent'; name: string; root: string; writable: true };

const SCOPE_RE = /^(project|agent):([A-Za-z0-9_-]+)$/;

/** Files that may be served to a browser as inline HTML (case-insensitive). */
const HTML_EXT_RE = /\.html?$/i;

/** Normalize a user-supplied relative path (leading slashes stripped, NULs
 *  rejected, empty meaning the scope root). Traversal is handled later by
 *  `safeResolve`, the single path-enforcement point. */
function normalizeRel(relPath: string | undefined): string {
  const raw = relPath ?? '';
  if (raw.includes('\0')) {
    throw new BadRequestException('Path contains a NUL byte');
  }
  return raw.replace(/^\/+/, '');
}

/**
 * HTTP file manager over the agent workspace.
 *
 * Scopes are `agent:<name>` (full create/edit/delete inside the named
 * agent's folder) and `project:<name>` (read-only, mirroring the agent
 * tools which never write into public projects). Every path goes through
 * `WorkspaceService.safeResolve`, so `..`, absolute and symlink escapes are
 * rejected.
 */
@Injectable()
export class FilesService {
  constructor(private readonly workspaces: WorkspaceService) {}

  /** One-level listing with metadata, directories first, then by name. */
  async list(scopeStr: string, relPath?: string): Promise<FileListResult> {
    const scope = this.resolveScope(scopeStr);
    const rel = normalizeRel(relPath);
    const target = await this.resolveOrThrow(scope, rel);

    let stat: Stats;
    try {
      stat = await fs.stat(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // A missing agent root is just an empty folder, not an error.
      if (code === 'ENOENT' && rel === '') {
        return { scope: scopeStr, path: rel, entries: [] };
      }
      if (code === 'ENOENT') throw new NotFoundException('Path not found');
      throw err;
    }
    if (!stat.isDirectory()) {
      throw new BadRequestException('Path is not a directory');
    }

    let names: string[] = [];
    try {
      names = await fs.readdir(target);
    } catch {
      names = [];
    }

    const entries: FileEntry[] = [];
    for (const name of names) {
      let st: Stats;
      try {
        st = await fs.lstat(path.join(target, name));
      } catch {
        continue;
      }
      // Symlinks are never surfaced: an entry-level symlink could point
      // outside the scope, and the file manager only deals with real files.
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        entries.push({ name, type: 'directory', size: 0, mtimeMs: st.mtimeMs });
      } else if (st.isFile()) {
        entries.push({
          name,
          type: 'file',
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      }
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.localeCompare(b.name)
        : a.type === 'directory'
          ? -1
          : 1,
    );
    return { scope: scopeStr, path: rel, entries };
  }

  /** Read a text file back (size-capped at MAX_VIEW_BYTES). */
  async read(scopeStr: string, relPath?: string): Promise<FileReadResult> {
    const scope = this.resolveScope(scopeStr);
    const rel = normalizeRel(relPath);
    const target = await this.resolveOrThrow(scope, rel);
    const stat = await this.statOrThrow(target);
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    if (stat.size > MAX_VIEW_BYTES) {
      throw new PayloadTooLargeException(
        `File is ${stat.size} bytes; the viewer cap is ${MAX_VIEW_BYTES}`,
      );
    }
    const content = await fs.readFile(target, 'utf8');
    return { scope: scopeStr, path: rel, size: stat.size, content };
  }

  /** Resolve a file for a binary-safe download stream (no size cap — the
   *  whole file is streamed to the client, unlike the capped JSON viewer). */
  async download(
    scopeStr: string,
    relPath?: string,
  ): Promise<{
    target: string;
    fileName: string;
    size: number;
  }> {
    const scope = this.resolveScope(scopeStr);
    const rel = normalizeRel(relPath);
    if (rel === '') throw new BadRequestException('Path must name a file');
    const target = await this.resolveOrThrow(scope, rel);
    const stat = await this.statOrThrow(target);
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    return { target, fileName: path.basename(target), size: stat.size };
  }

  /** Resolve an HTML file for an inline browser view. Like downloads this is
   *  streamed uncapped; only `.html`/`.htm` files are served as `text/html`
   *  so arbitrary binaries are never interpreted by the browser. */
  async view(scopeStr: string, relPath?: string): Promise<FileViewResult> {
    const scope = this.resolveScope(scopeStr);
    const rel = normalizeRel(relPath);
    if (rel === '') throw new BadRequestException('Path must name a file');
    const target = await this.resolveOrThrow(scope, rel);
    const stat = await this.statOrThrow(target);
    if (!stat.isFile()) throw new BadRequestException('Path is not a file');
    if (!HTML_EXT_RE.test(rel)) {
      throw new UnsupportedMediaTypeException(
        'Only .html and .htm files can be viewed inline',
      );
    }
    return {
      target,
      fileName: path.basename(target),
      size: stat.size,
      contentType: 'text/html; charset=utf-8',
    };
  }

  /** Create or overwrite a text file inside a writable scope. */
  async write(
    scopeStr: string,
    relPath: string | undefined,
    content?: string,
  ): Promise<FileWriteResult> {
    const scope = this.resolveScope(scopeStr, true);
    const rel = normalizeRel(relPath);
    if (rel === '') throw new BadRequestException('Path must name a file');
    const target = await this.resolveOrThrow(scope, rel);
    const body = content ?? '';
    try {
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, body, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EISDIR') {
        throw new BadRequestException('Path is an existing directory');
      }
      throw new BadRequestException(
        `Cannot write file: ${(err as Error).message}`,
      );
    }
    return {
      scope: scopeStr,
      path: rel,
      bytes: Buffer.byteLength(body, 'utf8'),
    };
  }

  /** Create a folder tree in a writable scope. */
  async mkdir(
    scopeStr: string,
    relPath: string | undefined,
  ): Promise<{
    scope: string;
    path: string;
    created: boolean;
  }> {
    const scope = this.resolveScope(scopeStr, true);
    const rel = normalizeRel(relPath);
    if (rel === '') throw new BadRequestException('Path must name a folder');
    const target = await this.resolveOrThrow(scope, rel);
    await fs.mkdir(target, { recursive: true });
    return { scope: scopeStr, path: rel, created: true };
  }

  /** Delete a file or an empty directory from a writable scope. */
  async remove(
    scopeStr: string,
    relPath: string | undefined,
  ): Promise<FileRemoveResult> {
    const scope = this.resolveScope(scopeStr, true);
    const rel = normalizeRel(relPath);
    if (rel === '') {
      throw new BadRequestException('Refusing to delete the scope root');
    }
    const target = await this.resolveOrThrow(scope, rel);
    const stat = await this.statOrThrow(target);
    if (stat.isDirectory()) {
      try {
        await fs.rmdir(target);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOTEMPTY' || code === 'EEXIST') {
          throw new BadRequestException('Directory is not empty');
        }
        throw err;
      }
      return { scope: scopeStr, path: rel, removed: true, type: 'directory' };
    }
    await fs.unlink(target);
    return { scope: scopeStr, path: rel, removed: true, type: 'file' };
  }

  /* ----------------------------- internals ----------------------------- */

  private resolveScope(scopeStr: string, writableOnly = false): Scope {
    const match = SCOPE_RE.exec(scopeStr);
    if (!match) {
      throw new BadRequestException(
        'Invalid scope: use agent:<name> or project:<name>',
      );
    }
    const kind = match[1];
    const name = match[2];
    let scope: Scope;
    if (kind === 'project') {
      this.workspaces.sanitizeName(name);
      scope = {
        kind: 'project',
        name,
        root: path.join(this.workspaces.getProjectRoot(), name),
        writable: false,
      };
    } else {
      this.workspaces.assertAgentName(name);
      scope = {
        kind: 'agent',
        name,
        root: this.workspaces.getAgentRoot(name),
        writable: true,
      };
    }
    if (writableOnly && !scope.writable) {
      throw new ForbiddenException(
        'Public projects are read-only in the file manager',
      );
    }
    return scope;
  }

  private async resolveOrThrow(scope: Scope, rel: string): Promise<string> {
    try {
      return await this.workspaces.safeResolve(scope.root, rel || '.');
    } catch (err) {
      if (err instanceof Error && err.message === 'path outside allowed root') {
        throw new BadRequestException('Path escapes the workspace root');
      }
      throw new BadRequestException(`Invalid path: ${(err as Error).message}`);
    }
  }

  private async statOrThrow(target: string): Promise<Stats> {
    try {
      return await fs.stat(target);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new NotFoundException('Path not found');
      throw err;
    }
  }
}
