import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WorkspaceService } from './workspace.service';
import { buildSelfTools, buildWorkspaceTools } from './workspace-tools';
import { buildChannelTools } from './channel-tools';

function configMock(root: string) {
  return {
    get: (k: string, d?: string) => (k === 'AGENT_WORKSPACE_ROOT' ? root : d),
  } as never;
}

describe('workspace tools', () => {
  let root: string;
  let ws: WorkspaceService;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-tools-'));
    ws = new WorkspaceService(configMock(root));
    await ws.ensureAgentFolder('coder');
    await ws.ensureAgentFolder('researcher');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('write -> read -> list round-trip in an agent folder', async () => {
    const tools = buildWorkspaceTools(ws);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const empty = (await byName['write_workspace_file'].run({
      name: 'coder',
      path: 'empty.txt',
    })) as { written: boolean; bytes: number };
    expect(empty.written).toBe(true);
    expect(empty.bytes).toBe(0);

    const written = (await byName['write_workspace_file'].run({
      name: 'coder',
      path: 'notes/hello.txt',
      content: 'hello',
    })) as { written: boolean; bytes: number };
    expect(written.written).toBe(true);
    expect(written.bytes).toBe(5);

    const read = (await byName['read_workspace_file'].run({
      kind: 'agent',
      name: 'coder',
      path: 'notes/hello.txt',
    })) as { content: string };
    expect(read.content).toBe('hello');

    const tree = (await byName['list_workspace'].run({
      agent: 'coder',
      path: 'notes',
    })) as Record<string, unknown>;
    expect(tree).toEqual({ 'hello.txt': null });
  });

  it('reads public projects only (write paths under projects/ are blocked)', async () => {
    const tools = buildWorkspaceTools(ws);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    await ws.createPublicProject('public-a');
    await fs.writeFile(
      path.join(ws.getProjectRoot(), 'public-a', 'readme.md'),
      'public',
    );

    const read = (await byName['read_workspace_file'].run({
      kind: 'project',
      name: 'public-a',
      path: 'readme.md',
    })) as { content: string };
    expect(read.content).toBe('public');

    // Writing "into" a project via the agent writer must be rejected because
    // the resolved path escapes the agent's own root. The raw tool throws;
    // the agent loop's executeTool would wrap that into {error: ...}.
    await expect(
      byName['write_workspace_file'].run({
        name: 'coder',
        path: '../projects/public-a/hacked.md',
        content: 'nope',
      }),
    ).rejects.toThrow('path outside allowed root');
  });

  it('rejects traversal attempts and unknown agents with hints', async () => {
    const tools = buildWorkspaceTools(ws);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    await expect(
      byName['read_workspace_file'].run({
        kind: 'agent',
        name: 'coder',
        path: '../../../../etc/passwd',
      }),
    ).rejects.toThrow('path outside allowed root');

    await expect(
      byName['list_workspace'].run({ agent: 'ghost', path: '.' }),
    ).rejects.toThrow('Valid named agents: coder, researcher');
  });

  it('lists a public project without requiring an agent arg', async () => {
    const tools = buildWorkspaceTools(ws);
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    const tree = (await byName['list_workspace'].run({
      path: 'projects/public-a',
    })) as Record<string, unknown>;
    expect(tree).toEqual({ 'readme.md': null });

    // The projects root itself lists without an agent arg too.
    const rootTree = (await byName['list_workspace'].run({
      path: 'projects',
    })) as Record<string, unknown>;
    expect(rootTree).toHaveProperty('public-a');

    // A trailing slash normalizes to the same root tree.
    const rootTree2 = (await byName['list_workspace'].run({
      path: 'projects/',
    })) as Record<string, unknown>;
    expect(rootTree2).toHaveProperty('public-a');

    // An empty agent-folder path falls back to the folder root.
    await byName['write_workspace_file'].run({
      name: 'coder',
      path: 'probe.txt',
      content: 'probe',
    });
    const agentRoot = (await byName['list_workspace'].run({
      agent: 'coder',
      path: '',
    })) as Record<string, unknown>;
    expect(agentRoot['probe.txt']).toBeNull();
  });

  it('self tools list/read/write inside the agent folder only', async () => {
    const byName = Object.fromEntries(
      buildSelfTools(ws, 'coder').map((t) => [t.name, t]),
    );

    // Default empty content, nested dirs created on write.
    const written = (await byName['write_own_file'].run({
      path: 'drafts/note.txt',
    })) as { written: boolean; bytes: number; path: string };
    expect(written.written).toBe(true);
    expect(written.bytes).toBe(0);
    expect(written.path).toContain('drafts/note.txt');

    await byName['write_own_file'].run({
      path: 'drafts/note.txt',
      content: 'hello',
    });
    const read = (await byName['read_own_file'].run({
      path: 'drafts/note.txt',
    })) as { content: string; size: number };
    expect(read.content).toBe('hello');
    expect(read.size).toBe(5);

    // Explicit sub-path and the default "." both produce trees.
    const tree = (await byName['list_own_workspace'].run({
      path: 'drafts',
    })) as Record<string, unknown>;
    expect(tree).toEqual({ 'note.txt': null });
    const rootTree = (await byName['list_own_workspace'].run({})) as Record<
      string,
      unknown
    >;
    expect(rootTree).toHaveProperty('drafts');
    const slashRoot = (await byName['list_own_workspace'].run({
      path: '/',
    })) as Record<string, unknown>;
    expect(slashRoot).toHaveProperty('drafts');
  });

  it('self tools reject missing paths, directories, and oversized files', async () => {
    const byName = Object.fromEntries(
      buildSelfTools(ws, 'coder').map((t) => [t.name, t]),
    );

    await expect(byName['read_own_file'].run({})).rejects.toThrow(
      'path must be a non-empty string',
    );
    await expect(byName['write_own_file'].run({})).rejects.toThrow(
      'path must be a non-empty string',
    );
    await expect(byName['read_own_file'].run({ path: '.' })).rejects.toThrow(
      'read_own_file expects a file',
    );

    await byName['write_own_file'].run({
      path: 'big.bin',
      content: 'x'.repeat(101 * 1024),
    });
    await expect(
      byName['read_own_file'].run({ path: 'big.bin' }),
    ).rejects.toThrow(/file too large/);
  });

  it('workspace tools reject bad kinds, missing names, and directories', async () => {
    const byName = Object.fromEntries(
      buildWorkspaceTools(ws).map((t) => [t.name, t]),
    );

    await expect(byName['list_workspace'].run({})).rejects.toThrow(
      'agent must be a non-empty string',
    );
    await expect(
      byName['read_workspace_file'].run({
        kind: 'bogus',
        name: 'coder',
        path: '.',
      }),
    ).rejects.toThrow("kind must be 'project' or 'agent'");
    await expect(
      byName['read_workspace_file'].run({ kind: 'project', path: 'x' }),
    ).rejects.toThrow('name must be a non-empty string');
    await expect(
      byName['read_workspace_file'].run({
        kind: 'agent',
        name: 'coder',
        path: '.',
      }),
    ).rejects.toThrow('read_workspace_file expects a file');

    await byName['write_workspace_file'].run({
      name: 'coder',
      path: 'big.bin',
      content: 'x'.repeat(101 * 1024),
    });
    await expect(
      byName['read_workspace_file'].run({
        kind: 'agent',
        name: 'coder',
        path: 'big.bin',
      }),
    ).rejects.toThrow(/file too large/);
  });
});

describe('channel tools', () => {
  let root: string;
  let ws: WorkspaceService;
  const posted: string[] = [];

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-chtools-'));
    ws = new WorkspaceService(configMock(root));
    await ws.createPublicProject('team-alpha');
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('scopes all reads/writes/posts to the channel project', async () => {
    const tools = buildChannelTools(ws, {
      agentName: 'coder',
      channelSlug: 'team-alpha',
      channelProjectName: 'team-alpha',
      channelPost: async (text: string) => {
        posted.push(text);
        return { ok: true };
      },
    });
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

    const written = await byName['channel_write'].run({
      path: 'plan.md',
      content: '# plan',
    });
    expect(JSON.stringify(written)).toContain('"written":true');

    const read = (await byName['channel_read'].run({ path: 'plan.md' })) as {
      content: string;
    };
    expect(read.content).toBe('# plan');

    const tree = (await byName['channel_list'].run({ path: '.' })) as Record<
      string,
      unknown
    >;
    expect(tree).toEqual({ 'plan.md': null });

    await byName['channel_post'].run({ text: 'update' });
    expect(posted).toEqual(['update']);
  });
});
