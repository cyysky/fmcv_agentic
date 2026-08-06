import { ConfigService } from '@nestjs/config';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { mkdtempSync, promises as fsp, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { WorkspaceService } from '../agent/workspace.service';
import { FilesService, MAX_VIEW_BYTES } from './files.service';

describe('FilesService', () => {
  let root: string;
  let files: FilesService;

  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'fmcv-files-spec-'));
    const workspaces = new WorkspaceService(
      new ConfigService({ AGENT_WORKSPACE_ROOT: root }),
    );
    files = new FilesService(workspaces);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  afterEach(async () => {
    try {
      await fsp.rm(path.join(root, 'agents', 'coder'), {
        recursive: true,
        force: true,
      });
    } catch {
      /* nothing to clean */
    }
  });

  it('writes, lists and reads a file back in an agent scope', async () => {
    const written = await files.write(
      'agent:coder',
      'notes/hello.txt',
      'hello file manager',
    );
    expect(written.bytes).toBe('hello file manager'.length);
    expect(written.path).toBe('notes/hello.txt');

    const list = await files.list('agent:coder', 'notes');
    expect(list.entries.map((e) => e.name)).toEqual(['hello.txt']);
    expect(list.entries[0].type).toBe('file');
    expect(list.entries[0].size).toBe('hello file manager'.length);

    const read = await files.read('agent:coder', 'notes/hello.txt');
    expect(read.content).toBe('hello file manager');
    expect(read.size).toBe('hello file manager'.length);
  });

  it('lists directories first, then files by name', async () => {
    await files.write('agent:coder', 'z.txt', 'z');
    await files.write('agent:coder', 'a.txt', 'a');
    await files.mkdir('agent:coder', 'b-dir');
    const list = await files.list('agent:coder');
    expect(list.entries.map((e) => e.name)).toEqual(['b-dir', 'a.txt', 'z.txt']);
    expect(list.entries[0].type).toBe('directory');
  });

  it('deletes files and empty directories but refuses non-empty ones', async () => {
    await files.write('agent:coder', 'keep.txt', 'x');
    await files.write('agent:coder', 'dir/child.txt', 'x');
    await expect(
      files.remove('agent:coder', 'dir'),
    ).rejects.toThrow(BadRequestException);

    await files.remove('agent:coder', 'dir/child.txt');
    await files.remove('agent:coder', 'dir');
    await expect(files.read('agent:coder', 'dir')).rejects.toThrow(
      NotFoundException,
    );

    await files.remove('agent:coder', 'keep.txt');
    await expect(files.read('agent:coder', 'keep.txt')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('refuses to read files larger than the viewer cap', async () => {
    const big = 'x'.repeat(MAX_VIEW_BYTES + 1);
    await files.write('agent:coder', 'big.txt', big);
    await expect(files.read('agent:coder', 'big.txt')).rejects.toThrow(
      PayloadTooLargeException,
    );
  });

  it('rejects paths that escape the scope root', async () => {
    await expect(files.list('agent:coder', '../..')).rejects.toThrow(
      BadRequestException,
    );
    await expect(files.read('agent:coder', 'notes/../../lib/passwd')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('keeps public projects read-only', async () => {
    await expect(files.write('project:shared', 'x.txt', 'x')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(files.mkdir('project:shared', 'sub')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(files.remove('project:shared', 'x.txt')).rejects.toThrow(
      ForbiddenException,
    );
    // Listing a missing public project is an empty folder, not an error.
    const list = await files.list('project:newproj');
    expect(list.entries).toEqual([]);
  });

  it('rejects invalid scopes', async () => {
    await expect(files.list('bogus:coder')).rejects.toThrow(BadRequestException);
    await expect(files.write('agent:unknown', 'x.txt', 'x')).rejects.toThrow(
      BadRequestException,
    );
  });
});
