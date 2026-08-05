import { BadRequestException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NAMED_AGENTS, WorkspaceService } from './workspace.service';

function configMock(root: string) {
  return { get: (k: string, d?: string) => (k === 'AGENT_WORKSPACE_ROOT' ? root : d) } as never;
}

describe('WorkspaceService', () => {
  let root: string;
  let ws: WorkspaceService;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-ws-'));
    ws = new WorkspaceService(configMock(root));
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves the workspace layout', () => {
    expect(ws.getRoot()).toBe(path.resolve(root));
    expect(ws.getProjectRoot()).toBe(path.join(path.resolve(root), 'projects'));
    expect(ws.getAgentRoot('coder')).toBe(
      path.join(path.resolve(root), 'agents', 'coder'),
    );
    expect(ws.getAgentWorkDir('coder')).toBe(
      path.join(path.resolve(root), 'agents', 'coder', 'work'),
    );
  });

  it('sanitizes names and rejects bad ones', () => {
    expect(ws.sanitizeName('my-project_2')).toBe('my-project_2');
    expect(() => ws.sanitizeName('has space')).toThrow(BadRequestException);
    expect(() => ws.sanitizeName('../evil')).toThrow(BadRequestException);
    expect(() => ws.sanitizeName('')).toThrow(BadRequestException);
  });

  it('rejects unknown named agents with a hint listing valid names', () => {
    expect(() => ws.assertAgentName('coder')).not.toThrow();
    expect(() => ws.assertAgentName('ghost')).toThrow(
      new RegExp(`Valid named agents: ${NAMED_AGENTS.map((a) => a.name).join(', ')}`),
    );
  });

  it('creates public projects and lists them', async () => {
    const proj = await ws.createPublicProject('alpha');
    expect(proj.name).toBe('alpha');
    const listed = await ws.listPublicProjects();
    expect(listed.map((p) => p.name)).toContain('alpha');
  });

  it('ensures agent folders with a work/ dir', async () => {
    const res = await ws.ensureAgentFolder('coder');
    await expect(fs.access(res.workDir)).resolves.toBeUndefined();
  });

  it('builds a recursive tree of directory contents', async () => {
    await ws.ensureAgentFolder('coder');
    const target = path.join(ws.getAgentRoot('coder'), 'tree-demo');
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, 'a.txt'), 'a');
    await fs.mkdir(path.join(target, 'sub'));
    await fs.writeFile(path.join(target, 'sub', 'b.txt'), 'b');

    const tree = await ws.readTree(path.join(ws.getAgentRoot('coder')), 3);
    expect((tree['tree-demo'] as Record<string, unknown>)['a.txt']).toBeNull();
    expect(
      ((tree['tree-demo'] as Record<string, unknown>)['sub'] as Record<string, unknown>)['b.txt'],
    ).toBeNull();
  });

  describe('safeResolve', () => {
    let root2: string;
    beforeAll(async () => {
      root2 = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-ws2-'));
      await fs.mkdir(path.join(root2, 'inner'));
      await fs.writeFile(path.join(root2, 'inner', 'f.txt'), 'x');
    });
    afterAll(async () => {
      await fs.rm(root2, { recursive: true, force: true });
    });

    it('resolves nested paths inside the root', async () => {
      expect(await ws.safeResolve(root2, 'inner/f.txt')).toBe(
        path.join(root2, 'inner', 'f.txt'),
      );
      expect(await ws.safeResolve(root2, 'missing/deep/path')).toBe(
        path.join(root2, 'missing', 'deep', 'path'),
      );
    });

    it('rejects lexical escapes (.., absolute paths)', async () => {
      await expect(ws.safeResolve(root2, '../outside')).rejects.toThrow(
        'path outside allowed root',
      );
      await expect(ws.safeResolve(root2, '../../../etc/passwd')).rejects.toThrow(
        'path outside allowed root',
      );
      await expect(ws.safeResolve(root2, '/etc/passwd')).rejects.toThrow(
        'path outside allowed root',
      );
    });

    it('rejects symlink escapes pointing outside the root', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-outside-'));
      await fs.symlink(outside, path.join(root2, 'escape-link'));
      await expect(ws.safeResolve(root2, 'escape-link/secret.txt')).rejects.toThrow(
        'path outside allowed root',
      );
      await fs.rm(outside, { recursive: true, force: true });
      await fs.unlink(path.join(root2, 'escape-link'));
    });

    it('allows symlinks that stay inside the root', async () => {
      const targetInner = path.join(root2, 'inner');
      await fs.symlink(targetInner, path.join(root2, 'inner-link'));
      expect(await ws.safeResolve(root2, 'inner-link/f.txt')).toBe(
        path.join(root2, 'inner-link', 'f.txt'),
      );
      await fs.unlink(path.join(root2, 'inner-link'));
    });
  });
});
