import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BaseAgentService,
  ChatMessage,
  DEFAULT_SYSTEM_PROMPT,
} from './base-agent.service';
import { WorkspaceService } from './workspace.service';

function configMock(root: string, opts: { llmStub?: boolean } = {}) {
  return {
    get: (k: string, d?: string) => {
      if (k === 'AGENT_WORKSPACE_ROOT') return root;
      if (k === 'AGENT_BASE_URL') return 'http://vrs.test/v1';
      if (k === 'AGENT_DEFAULT_MODEL') return 'ds4-flash';
      if (k === 'AGENT_API_KEY') return '';
      if (k === 'AGENT_LLM_STUB') return opts.llmStub ? '1' : '';
      return d;
    },
  } as never;
}

function prismaDouble() {
  const agentSession = {
    upsert: jest.fn(async () => ({ id: 's' })),
    findMany: jest.fn(async () => []),
    findUnique: jest.fn(async () => null),
    delete: jest.fn(async () => ({ id: 's' })),
  };
  return {
    connection: {
      findFirst: jest.fn(async () => null),
      findUnique: jest.fn(async () => null),
    },
    agentSession,
  } as never;
}

async function makeAgent() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-'));
  const ws = new WorkspaceService(configMock(root));
  await ws.ensureAgentFolder('coder');
  const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
  return { agent, ws, root };
}

describe('BaseAgentService sessions', () => {
  it('persists sessions to Postgres and recovers them on startup', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-sess-'));
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: {
          upsert: jest.Mock;
          findMany: jest.Mock;
          delete: jest.Mock;
        };
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);

      const s = await agent.createSession('persist me');
      // create + converse would both persist; here create alone does an upsert.
      expect(fake.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ id: s.id, title: 'persist me' }),
        }),
      );

      // Simulate a restart: memory is cleared, startup reloads from DB.
      const row = {
        id: s.id,
        title: 'persist me',
        model: 'ds4-flash',
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [
          { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
          { role: 'user', content: 'hi' },
        ],
      };
      fake.agentSession.findMany.mockResolvedValue([row]);
      const fresh = new BaseAgentService(configMock(root), ws, fake as never);
      await fresh.onModuleInit();
      expect(fresh.getSession(s.id).messages.map((m) => m.role)).toEqual([
        'system',
        'user',
      ]);

      await fresh.deleteSession(s.id);
      expect(fake.agentSession.delete).toHaveBeenCalledWith({
        where: { id: s.id },
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('recovers sparse rows with null messages and a pinned connection', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-sess-sparse-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findMany: jest.Mock };
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      fake.agentSession.findMany.mockResolvedValue([
        {
          id: 'sparse-session',
          title: 'sparse',
          model: 'ds4-flash',
          connectionId: 'c-1',
          createdAt: new Date(),
          updatedAt: new Date(),
          messages: null,
        },
      ]);
      await agent.onModuleInit();
      const s = agent.getSession('sparse-session');
      expect(s.connectionId).toBe('c-1');
      expect(s.messages).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps live sessions when startup reload finds the same id', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-sess-live-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findMany: jest.Mock; upsert: jest.Mock };
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const live = await agent.createSession('live title');
      fake.agentSession.findMany.mockResolvedValue([
        {
          id: live.id,
          title: 'stale title',
          model: 'ds4-flash',
          createdAt: new Date(),
          updatedAt: new Date(),
          messages: [{ role: 'user', content: 'from disk' }],
        },
      ]);
      await agent.onModuleInit();
      expect(agent.getSession(live.id)).toBe(live);
      expect(agent.getSession(live.id).title).toBe('live title');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('lists and deletes sessions persisted outside the live map', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-orphan-'));
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: {
          upsert: jest.Mock;
          findMany: jest.Mock;
          findUnique: jest.Mock;
          delete: jest.Mock;
        };
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const orphan = {
        id: '4f9e207a-70ba-46df-8add-b3ca5e27cbb0',
        title: 'skill-aware e2e',
        model: 'ds4-flash',
        connectionId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        messages: [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }],
      };
      fake.agentSession.findMany.mockResolvedValue([orphan]);
      fake.agentSession.findUnique.mockResolvedValue(orphan);

      const listed = await agent.listSessions();
      expect(listed.map((s) => s.id)).toContain(orphan.id);
      expect(listed.find((s) => s.id === orphan.id)?.title).toBe(
        'skill-aware e2e',
      );

      await expect(agent.deleteSession(orphan.id)).resolves.toEqual({
        deleted: true,
      });
      expect(fake.agentSession.delete).toHaveBeenCalledWith({
        where: { id: orphan.id },
      });

      fake.agentSession.findUnique.mockResolvedValue(null);
      await expect(agent.deleteSession(orphan.id)).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('auto-titles a default session from its first user message', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-autotitle-'),
    );
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(
        configMock(root, { llmStub: true }),
        ws,
        prismaDouble(),
      );

      const s = await agent.createSession();
      expect(s.title).toBe('New session');
      await agent.converse(s.id, '  Fix the parser   please now  ');
      expect(agent.getSession(s.id).title).toBe('Fix the parser please now');

      // A later message must not re-title.
      await agent.converse(s.id, 'second message');
      expect(agent.getSession(s.id).title).toBe('Fix the parser please now');

      // Long first messages are truncated to a 40-char snippet.
      const long = await agent.createSession();
      await agent.converse(long.id, 'x'.repeat(60));
      expect(agent.getSession(long.id).title).toBe(`${'x'.repeat(40)}…`);

      // Manually renamed sessions keep their custom title.
      const named = await agent.createSession();
      await agent.renameSession(named.id, 'My title');
      await agent.converse(named.id, 'hello');
      expect(agent.getSession(named.id).title).toBe('My title');

      // Blank first messages leave the default title.
      const blank = await agent.createSession();
      await agent.converse(blank.id, '   ');
      expect(agent.getSession(blank.id).title).toBe('New session');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('renames a session, persists the new title, and rejects blank input', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-rename-'));
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { upsert: jest.Mock };
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);

      const s = await agent.createSession('old title');
      const renamed = await agent.renameSession(s.id, '  new title  ');
      expect(renamed.title).toBe('new title');
      expect(agent.getSession(s.id).title).toBe('new title');
      expect(fake.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: s.id },
          update: expect.objectContaining({ title: 'new title' }),
        }),
      );
      await expect(agent.renameSession(s.id, '   ')).rejects.toThrow(/blank/);
      await expect(
        agent.renameSession('00000000-0000-4000-8000-000000000000', 'x'),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('creates sessions with the default model and resolves unknown models', async () => {
    const { agent, root } = await makeAgent();
    try {
      const s = await agent.createSession('t');
      expect(s.model).toBe('ds4-flash');
      expect(s.messages[0].role).toBe('system');
      expect(agent.getSession(s.id).id).toBe(s.id);
      const s2 = await agent.createSession('t2', 'not-a-model');
      expect(s2.model).toBe('ds4-flash');
      await expect(agent.listSessions()).resolves.toHaveLength(2);
      await expect(agent.deleteSession(s.id)).resolves.toEqual({
        deleted: true,
      });
      await expect(agent.listSessions()).resolves.toHaveLength(1);
      await expect(agent.deleteSession(s.id)).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService loop', () => {
  it('stub mode answers deterministically without the network', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-stub-'));
    try {
      const ws = new WorkspaceService(configMock(root, { llmStub: true }));
      const agent = new BaseAgentService(
        configMock(root, { llmStub: true }),
        ws,
        prismaDouble(),
      );
      const res = await agent.runTurn({ message: 'echo this for me' });
      expect(res.answer).toBe('[stub] echo this for me');
      expect(res.steps).toBe(0);
      expect(res.model).toBe('ds4-flash');

      const s = await agent.createSession('stub chat');
      const conv = await agent.converse(s.id, 'persist this stub turn');
      expect(conv.answer).toBe('[stub] persist this stub turn');
      expect(conv.steps).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns a plain-text answer in one step and records the model', async () => {
    const { agent, root } = await makeAgent();
    try {
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async () => ({ content: 'hi there', tool_calls: undefined }),
      );
      const res = await agent.runTurn({ message: 'hello' });
      expect(res.answer).toBe('hi there');
      expect(res.steps).toBe(0);
      expect(res.model).toBe('ds4-flash');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('executes tool calls and continues until a plain-text answer', async () => {
    const { agent, root } = await makeAgent();
    try {
      const calls: jest.Mock = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          tool_calls: [
            {
              id: 'call-1',
              name: 'write_workspace_file',
              arguments: JSON.stringify({
                name: 'coder',
                path: 'hello.txt',
                content: 'hello',
              }),
            },
          ],
        })
        .mockResolvedValueOnce({
          content: 'wrote it',
          tool_calls: undefined,
        });
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      const res = await agent.runTurn({ message: 'write a file' });
      expect(res.steps).toBe(1);
      expect(res.answer).toBe('wrote it');
      expect(res.trace).toHaveLength(1);
      expect(res.trace?.[0].name).toBe('write_workspace_file');
      const content = await fs.readFile(
        path.join(root, 'agents', 'coder', 'hello.txt'),
        'utf8',
      );
      expect(content).toBe('hello');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('falls back from qwen to ds4-flash when the primary call fails', async () => {
    const { agent, root } = await makeAgent();
    try {
      const usedModels: string[] = [];
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async (messages: ChatMessage[], spec: { provider_model: string }) => {
          usedModels.push(spec.provider_model);
          if (spec.provider_model === 'qwen3.6-35b') {
            throw new Error('502 upstream');
          }
          return { content: 'recovered', tool_calls: undefined };
        },
      );
      const res = await agent.runTurn({ message: 'x', model: 'qwen3.6-35b' });
      expect(res.answer).toBe('recovered');
      expect(usedModels).toEqual(['qwen3.6-35b', 'ds4-flash']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('converse appends to the session and caps model rounds at maxSteps', async () => {
    const { agent, root } = await makeAgent();
    try {
      const s = await agent.createSession('s');
      // The model never produces a plain answer, so the loop runs until the
      // step budget is exhausted — the only way to observe the cap.
      const calls = jest.fn(async () => ({
        content: null,
        tool_calls: [
          {
            id: 'call-1',
            name: 'write_workspace_file',
            arguments: JSON.stringify({
              name: 'coder',
              path: 'cap.txt',
              content: 'x',
            }),
          },
        ],
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      await agent.converse(s.id, 'q1', undefined, 2);
      expect(calls).toHaveBeenCalledTimes(2);
      expect(agent.getSession(s.id).messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'tool',
        'assistant',
        'tool',
      ]);

      // A lowered budget on the next call takes effect immediately.
      await agent.converse(s.id, 'q2', undefined, 1);
      expect(calls).toHaveBeenCalledTimes(3);
      expect(
        await fs.readFile(
          path.join(root, 'agents', 'coder', 'cap.txt'),
          'utf8',
        ),
      ).toBe('x');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService connections', () => {
  const CONN_ID = '22222222-2222-4222-8222-222222222222';
  const BAD_CONN_ID = '99999999-9999-4999-8999-999999999999';

  function withConn(overrides: Record<string, unknown> = {}) {
    const fake = prismaDouble() as unknown as {
      connection: { findUnique: jest.Mock };
      agentSession: { upsert: jest.Mock };
    };
    fake.connection.findUnique.mockResolvedValue({
      id: CONN_ID,
      displayName: 'Local Ollama',
      baseUrl: 'http://ollama.test/v1',
      modelName: 'llama3.2',
      apiKey: 'secret-key',
      defaultParameters: { temperature: 0.7, top_p: 0.5 },
      ...overrides,
    });
    return fake;
  }

  it('pins a session to a saved connection and persists connectionId', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-persist-'),
    );
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);

      const s = await agent.createSession('ollama chat', undefined, CONN_ID);
      expect(s.connectionId).toBe(CONN_ID);
      expect(fake.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ connectionId: CONN_ID }),
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('404s on an unknown connection for create and turn', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-bad-'),
    );
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
      await expect(
        agent.createSession('bad', undefined, BAD_CONN_ID),
      ).rejects.toThrow(`Connection ${BAD_CONN_ID} not found`);
      await expect(
        agent.runTurn({ message: 'hi', connectionId: BAD_CONN_ID }),
      ).rejects.toThrow(`Connection ${BAD_CONN_ID} not found`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the pinned connection for converse turns (baseUrl/model/key/params)', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-converse-'),
    );
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'via connection',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      const s = await agent.createSession('conn chat', undefined, CONN_ID);
      const conv = await agent.converse(s.id, 'hello');
      expect(conv.answer).toBe('via connection');
      expect(calls.mock.calls[0][3]).toEqual({
        baseUrl: 'http://ollama.test/v1',
        model: 'llama3.2',
        apiKey: 'secret-key',
        defaultParameters: { temperature: 0.7, top_p: 0.5 },
      });
      // A stateless turn on the same connection reports its wire model.
      const turn = await agent.runTurn({
        message: 'hi',
        connectionId: CONN_ID,
      });
      expect(turn.model).toBe('llama3.2');
      expect(calls.mock.calls[1][3]).toEqual(
        expect.objectContaining({
          baseUrl: 'http://ollama.test/v1',
          model: 'llama3.2',
        }),
      );
      // Re-running the session keeps using the stored connection.
      await agent.converse(s.id, 'again');
      expect(calls.mock.calls[2][3]).toEqual(
        expect.objectContaining({ baseUrl: 'http://ollama.test/v1' }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('omits apiKey and parameters when the stored connection has none', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-nokey-'),
    );
    try {
      const fake = withConn({ apiKey: null, defaultParameters: null });
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'no key needed',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      const turn = await agent.runTurn({
        message: 'hi',
        connectionId: CONN_ID,
      });
      expect(turn.answer).toBe('no key needed');
      expect(calls.mock.calls[0][3]).toEqual({
        baseUrl: 'http://ollama.test/v1',
        model: 'llama3.2',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('lets an explicit catalog model override the connection model on the wire', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-override-'),
    );
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'override answered',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      // Stateless turn: catalog model wins on the wire, but the endpoint's
      // baseUrl/key/default-parameters still come from the connection.
      const turn = await agent.runTurn({
        message: 'hi',
        connectionId: CONN_ID,
        model: 'qwen3.6-35b',
      });
      expect(turn.model).toBe('qwen3.6-35b');
      expect(calls.mock.calls[0][3]).toEqual({
        baseUrl: 'http://ollama.test/v1',
        model: 'qwen3.6-35b',
        apiKey: 'secret-key',
        defaultParameters: { temperature: 0.7, top_p: 0.5 },
      });

      // The override is per-call: without an explicit model the connection's
      // stored modelName wins again.
      const turn2 = await agent.runTurn({
        message: 'hi again',
        connectionId: CONN_ID,
      });
      expect(turn2.model).toBe('llama3.2');
      expect(calls.mock.calls[1][3]).toEqual(
        expect.objectContaining({ model: 'llama3.2' }),
      );

      // The same semantics apply on an existing pinned session via converse
      // (and the chosen catalog model is stored on the session).
      const s = await agent.createSession('override chat', undefined, CONN_ID);
      await agent.converse(s.id, 'hello', 'qwen3.6-35b');
      expect(calls.mock.calls[2][3]).toEqual(
        expect.objectContaining({
          baseUrl: 'http://ollama.test/v1',
          model: 'qwen3.6-35b',
        }),
      );
      expect(agent.getSession(s.id).model).toBe('qwen3.6-35b');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('uses a connection-provided (non-catalog) model verbatim on the wire', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-list-model-'),
    );
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'list model answered',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      // A raw provider id from the connection's `models` list is not in the
      // catalog: it must reach the upstream verbatim (never the catalog
      // fallback) while baseUrl/key/params still come from the connection.
      const rawModel = 'custom-provider-model-a';
      const turn = await agent.runTurn({
        message: 'hi',
        connectionId: CONN_ID,
        model: rawModel,
      });
      expect(turn.model).toBe(rawModel);
      expect(calls.mock.calls[0][3]).toEqual({
        baseUrl: 'http://ollama.test/v1',
        model: rawModel,
        apiKey: 'secret-key',
        defaultParameters: { temperature: 0.7, top_p: 0.5 },
      });

      // Same on a pinned session: the explicit raw id wins on the wire and is
      // stored verbatim on the session (not the resolved catalog default).
      const s = await agent.createSession('list chat', undefined, CONN_ID);
      await agent.converse(s.id, 'hello', rawModel);
      expect(calls.mock.calls[1][3]).toEqual(
        expect.objectContaining({
          baseUrl: 'http://ollama.test/v1',
          model: rawModel,
        }),
      );
      expect(agent.getSession(s.id).model).toBe(rawModel);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('self-heals a session whose pinned connection was deleted (falls back to default)', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-gone-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findUnique: jest.Mock };
      };
      fake.connection.findUnique.mockResolvedValue(null);
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'default answer',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      // Simulate a session recovered from a prior run whose connection row
      // has since been deleted.
      const s = await agent.createSession('orphan');
      (s as unknown as { connectionId?: string }).connectionId = BAD_CONN_ID;
      const conv = await agent.converse(s.id, 'still works?');
      expect(conv.answer).toBe('default answer');
      expect(calls.mock.calls[0][3]).toBeUndefined();
      expect(agent.getSession(s.id).connectionId).toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('attaches a connection to an existing session via converse', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-conn-attach-'),
    );
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'ok',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      const s = await agent.createSession('attach later');
      await agent.converse(s.id, 'hello', undefined, undefined, CONN_ID);
      expect(agent.getSession(s.id).connectionId).toBe(CONN_ID);
      expect(calls.mock.calls[0][3]).toEqual(
        expect.objectContaining({ baseUrl: 'http://ollama.test/v1' }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService streaming channel turns', () => {
  it('streams status/tool/answer events, drains interjections, and restores tools', async () => {
    const { agent, root } = await makeAgent();
    try {
      const initialTools = agent.listTools().map((t) => t.name);
      const events: string[] = [];
      const messages: ChatMessage[] = [];

      const toolArgs = '';
      (agent as unknown as { callModel: jest.Mock }).callModel = jest
        .fn()
        .mockImplementationOnce(async () => ({
          content: null,
          tool_calls: [
            {
              id: 'c1',
              name: 'channel_write',
              arguments: JSON.stringify({ path: 'a.md', content: 'A' }),
            },
          ],
        }))
        .mockImplementationOnce(async () => ({
          content: 'final',
          tool_calls: undefined,
        }));

      const res = await agent.runChannelTurnStreaming({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team',
        thread: '[you] start',
        message: 'write a.md',
        channelPost: async (text: string) => {
          events.push(`post:${text}`);
          return { ok: true };
        },
        toolStatusPost: async (text: string) => {
          events.push(`status:${text}`);
          return { ok: true };
        },
        messages,
        onEvent: (e) => events.push(`${e.type}:${e.name ?? e.text ?? ''}`),
        interject: () => {
          // Drain one interjection queued between calls.
          if (messages.some((m) => m.content === 'interject-me')) return [];
          messages.push({
            role: 'user',
            content: 'interject-me',
            tool_call_id: undefined,
          });
          return ['interject-me'];
        },
      });

      expect(res.answer).toBe('final');
      expect(res.steps).toBe(1);
      expect(events[0]).toBe('status:Agent started');
      expect(events.some((e) => e === 'tool_call:channel_write')).toBe(true);
      expect(events.some((e) => e === 'answer:final')).toBe(true);
      expect(
        events.some((e) => e.startsWith('status:used channel_write')),
      ).toBe(true);

      // Interjection text landed in the live message context.
      expect(messages.some((m) => m.content === 'interject-me')).toBe(true);
      // The file was actually written by the channel tool.
      const content = await fs.readFile(
        path.join(root, 'projects', 'team', 'a.md'),
        'utf8',
      );
      expect(content).toBe('A');
      void toolArgs;
      // Global tool registry restored after the turn.
      expect(agent.listTools().map((t) => t.name)).toEqual(initialTools);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('stops when the abort signal fires mid-loop', async () => {
    const { agent, root } = await makeAgent();
    try {
      const ac = new AbortController();
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        () =>
          new Promise((_resolve, reject) => {
            // Simulate an in-flight LLM call that the abort cancels.
            ac.signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const messages: ChatMessage[] = [];
      // Kick the turn off first so the mocked in-flight LLM call has attached
      // its abort listener, then fire the stop signal.
      const runPromise = agent.runChannelTurnStreaming({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team',
        thread: '',
        message: 'x',
        channelPost: async () => ({}),
        messages,
        onEvent: () => {},
        interject: () => [],
        signal: ac.signal,
      });
      ac.abort();
      const res = await runPromise;
      expect(res.answer).toContain('stopped');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService skills integration', () => {
  function skillsDouble(
    installed: { name: string; description: string }[] = [
      { name: 'code-review', description: 'A review checklist' },
    ],
  ) {
    return {
      listInstalled: jest.fn(async () => installed),
      contentFor: jest.fn(async (name: string) =>
        name === 'code-review' ? '# Code review\nCheck edge cases.' : null,
      ),
    };
  }

  it('registers read_skill only when a skill registry is wired', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-skillreg-'),
    );
    try {
      const plain = new BaseAgentService(
        configMock(root),
        new WorkspaceService(configMock(root)),
        prismaDouble(),
      );
      expect(plain.listTools().map((t) => t.name)).not.toContain('read_skill');

      const withSkills = new BaseAgentService(
        configMock(root),
        new WorkspaceService(configMock(root)),
        prismaDouble(),
        skillsDouble() as never,
      );
      const tools = withSkills.listTools();
      const readSkill = tools.find((t) => t.name === 'read_skill');
      expect(readSkill).toBeTruthy();
      expect(readSkill?.description).toContain('installed skill');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('read_skill returns the body of an installed skill and errors otherwise', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-readskill-'),
    );
    try {
      const skills = skillsDouble();
      const agent = new BaseAgentService(
        configMock(root),
        new WorkspaceService(configMock(root)),
        prismaDouble(),
        skills as never,
      );
      const readSkill = agent.listTools().find((t) => t.name === 'read_skill')!;
      await expect(readSkill.run({ name: 'code-review' })).resolves.toBe(
        '# Code review\nCheck edge cases.',
      );
      await expect(readSkill.run({ name: 'absent' })).resolves.toContain(
        'No installed skill named',
      );
      await expect(readSkill.run({})).resolves.toContain(
        'Skill name is required',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('runTurn injects the installed-skills registry into the LLM context', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-skillturn-'),
    );
    try {
      const skills = skillsDouble();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(
        configMock(root),
        ws,
        prismaDouble(),
        skills as never,
      );
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'ok',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      await agent.runTurn({ message: 'review this diff' });
      const sent = calls.mock.calls[0][0] as ChatMessage[];
      const registry = sent.filter(
        (m) =>
          m.role === 'system' &&
          m.content?.includes('Installed skills are available'),
      );
      expect(registry).toHaveLength(1);
      expect(registry[0].content).toContain('code-review: A review checklist');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('converse injects the registry per turn but keeps the stored transcript clean', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-skillconv-'),
    );
    try {
      const skills = skillsDouble();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(
        configMock(root),
        ws,
        prismaDouble(),
        skills as never,
      );
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'done',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;

      const s = await agent.createSession('skill chat');
      await agent.converse(s.id, 'review the diff');
      const sent = calls.mock.calls[0][0] as ChatMessage[];
      expect(
        sent.some(
          (m) =>
            m.content ===
            'Installed skills are available to you. When one is relevant, call read_skill with its exact name to load its full instructions.\n- code-review: A review checklist',
        ),
      ).toBe(true);

      const stored = agent.getSession(s.id).messages;
      expect(
        stored.some((m) =>
          m.content?.includes('Installed skills are available'),
        ),
      ).toBe(false);
      expect(stored.some((m) => m.content === 'review the diff')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService resilience', () => {
  it('falls back to live sessions when the persistence read fails', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-listfail-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findMany: jest.Mock; upsert: jest.Mock };
      };
      fake.agentSession.findMany.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await agent.createSession('live');
      const listed = await agent.listSessions();
      expect(listed).toHaveLength(1);
      expect(listed[0].title).toBe('live');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('treats a failed persisted-lookup as a missing session on delete', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-delfail-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findUnique: jest.Mock };
      };
      fake.agentSession.findUnique.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(agent.deleteSession('missing')).rejects.toThrow(/not found/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('still reports a delete when the persisted row removal fails', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-delfail2-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findUnique: jest.Mock; delete: jest.Mock };
      };
      fake.agentSession.findUnique.mockResolvedValue({ id: 'orphan' });
      fake.agentSession.delete.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(agent.deleteSession('orphan')).resolves.toEqual({
        deleted: true,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('keeps the in-memory session when persisting fails', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-persistfail-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { upsert: jest.Mock };
      };
      fake.agentSession.upsert.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(agent.createSession('resilient')).resolves.toMatchObject({
        title: 'resilient',
      });
      await expect(agent.listSessions()).resolves.toHaveLength(1);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('survives a failed session reload on startup', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-reloadfail-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        agentSession: { findMany: jest.Mock };
      };
      fake.agentSession.findMany.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(agent.onModuleInit()).resolves.toBeUndefined();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService apiKey resolution', () => {
  it('short-circuits on the env key', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-envkey-'));
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findFirst: jest.Mock };
      };
      const cfg = configMock(root) as unknown as {
        get: (k: string, d?: string) => string;
      };
      const baseGet = cfg.get;
      cfg.get = (k: string, d?: string) =>
        k === 'AGENT_API_KEY' ? 'env-secret' : baseGet(k, d);
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(cfg as never, ws, fake as never);
      await expect(
        (agent as unknown as { apiKey(): Promise<string> }).apiKey(),
      ).resolves.toBe('env-secret');
      expect(fake.connection.findFirst).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reads the key from the first matching connection row', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-dbkey-'));
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findFirst: jest.Mock };
      };
      fake.connection.findFirst.mockResolvedValue({ apiKey: 'db-secret' });
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(
        (agent as unknown as { apiKey(): Promise<string> }).apiKey(),
      ).resolves.toBe('db-secret');
      expect(fake.connection.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            baseUrl: { equals: 'http://vrs.test/v1', mode: 'insensitive' },
          },
        }),
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('logs and returns an empty key when the DB lookup fails', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-keyfail-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findFirst: jest.Mock };
      };
      fake.connection.findFirst.mockRejectedValue(new Error('db down'));
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(
        (agent as unknown as { apiKey(): Promise<string> }).apiKey(),
      ).resolves.toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('returns an empty key when no connection row has one', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-nokey-'));
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findFirst: jest.Mock };
      };
      fake.connection.findFirst.mockResolvedValue({ apiKey: null });
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      await expect(
        (agent as unknown as { apiKey(): Promise<string> }).apiKey(),
      ).resolves.toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService runTurn context', () => {
  it('injects caller history as preceding user messages', async () => {
    const { agent, root } = await makeAgent();
    try {
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'ok',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;
      await agent.runTurn({
        message: 'fresh',
        history: ['first q', 'second q'],
      });
      const sent = calls.mock.calls[0][0] as ChatMessage[];
      expect(
        sent.filter((m) => m.role === 'user').map((m) => m.content),
      ).toEqual(['first q', 'second q', 'fresh']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('survives an installed-skills registry failure and turns without it', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-skillfail-'),
    );
    try {
      const skills = {
        listInstalled: jest.fn(async () => {
          throw new Error('skills down');
        }),
        contentFor: jest.fn(),
      };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(
        configMock(root),
        ws,
        prismaDouble(),
        skills as never,
      );
      const calls: jest.Mock = jest.fn(async () => ({
        content: 'ok',
        tool_calls: undefined,
      }));
      (agent as unknown as { callModel: jest.Mock }).callModel = calls;
      await agent.runTurn({ message: 'hi' });
      const sent = calls.mock.calls[0][0] as ChatMessage[];
      expect(
        sent.some((m) => m.content?.includes('Installed skills are available')),
      ).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService runChannelTurn', () => {
  it('runs a channel turn in stub mode and restores the global tool registry', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-chanturn-'),
    );
    try {
      const stubCfg = configMock(root, { llmStub: true });
      const ws = new WorkspaceService(stubCfg);
      const agent = new BaseAgentService(stubCfg, ws, prismaDouble());
      const initial = agent.listTools().map((t) => t.name);
      const res = await agent.runChannelTurn({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team-proj',
        thread: 'you: start',
        message: 'hello there',
        channelPost: async () => ({ ok: true }),
      });
      expect(res.answer).toBe('[stub] hello there');
      expect(res.steps).toBe(0);
      expect(agent.listTools().map((t) => t.name)).toEqual(initial);

      // The empty-thread branch keeps the prompt lean.
      const res2 = await agent.runChannelTurn({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team-proj',
        thread: '   ',
        message: 'again',
        channelPost: async () => ({ ok: true }),
      });
      expect(res2.answer).toBe('[stub] again');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService streaming failure handling', () => {
  it('stops after consecutive tool-error rounds with a final answer', async () => {
    const { agent, root } = await makeAgent();
    try {
      const events: string[] = [];
      const messages: ChatMessage[] = [];
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async () => ({
          content: null,
          tool_calls: [{ id: 'c1', name: 'channel_write', arguments: '{}' }],
        }),
      );
      const res = await agent.runChannelTurnStreaming({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team',
        thread: 'x',
        message: 'do it',
        channelPost: async () => ({}),
        messages,
        onEvent: (e) => events.push(`${e.type}:${e.text ?? ''}`),
        interject: () => [],
      });
      expect(res.answer).toContain('Repeated tool errors');
      expect(res.steps).toBe(3);
      expect(events.some((e) => e.startsWith('answer:'))).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('falls back to ds4-flash when the primary streaming model fails', async () => {
    const { agent, root } = await makeAgent();
    try {
      const specs: string[] = [];
      const messages: ChatMessage[] = [];
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async (_m: ChatMessage[], spec: { provider_model: string }) => {
          specs.push(spec.provider_model);
          if (spec.provider_model === 'qwen3.6-35b') {
            throw new Error('502 upstream');
          }
          return { content: 'recovered', tool_calls: undefined };
        },
      );
      const res = await agent.runChannelTurnStreaming({
        agentName: 'coder',
        channelSlug: 'team',
        channelProjectName: 'team',
        thread: '',
        message: 'x',
        model: 'qwen3.6-35b',
        channelPost: async () => ({}),
        messages,
        onEvent: () => {},
        interject: () => [],
      });
      expect(res.answer).toBe('recovered');
      expect(specs).toEqual(['qwen3.6-35b', 'ds4-flash']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rethrows when the default streaming model fails with no fallback', async () => {
    const { agent, root } = await makeAgent();
    try {
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async () => {
          throw new Error('llm down');
        },
      );
      const messages: ChatMessage[] = [];
      await expect(
        agent.runChannelTurnStreaming({
          agentName: 'coder',
          channelSlug: 'team',
          channelProjectName: 'team',
          thread: '',
          message: 'x',
          channelPost: async () => ({}),
          messages,
          onEvent: () => {},
          interject: () => [],
        }),
      ).rejects.toThrow('llm down');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService LLM transport', () => {
  it('completes a real chat-completions call with the DB-resolved key', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-transport-'),
    );
    try {
      const fake = prismaDouble() as unknown as {
        connection: { findFirst: jest.Mock };
        agentSession: { upsert: jest.Mock; findMany: jest.Mock };
      };
      fake.connection.findFirst.mockResolvedValue({ apiKey: 'db-secret' });
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValue({
        ok: true,
        text: jest.fn(async () => ''),
        json: jest.fn(async () => ({
          choices: [{ message: { content: 'hi from llm' } }],
        })),
      } as never);
      try {
        const res = await agent.runTurn({ message: 'hello' });
        expect(res.answer).toBe('hi from llm');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://vrs.test/v1/chat/completions');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('ds4-flash');
        expect(body.temperature).toBe(0.2);
        expect(body.max_tokens).toBe(8192);
        expect(body.tools.length).toBeGreaterThan(0);
        expect(body.tools[0].type).toBe('function');
        expect((init as RequestInit).headers).toEqual(
          expect.objectContaining({ authorization: 'Bearer db-secret' }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('merges connection defaults and maps wire tool_calls', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-toolmap-'),
    );
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValue({
        ok: true,
        text: jest.fn(async () => ''),
        json: jest.fn(async () => ({
          choices: [
            {
              message: {
                content: null,
                tool_calls: [
                  {
                    function: {
                      name: 'list_own_workspace',
                      arguments: undefined,
                    },
                  },
                ],
              },
            },
          ],
        })),
      } as never);
      const endpoint = {
        baseUrl: 'http://ollama.test/v1',
        model: 'llama3.2',
        apiKey: 'secret-key',
        defaultParameters: { temperature: 0.7, top_p: 0.5, extra: 1 },
      };
      try {
        const svc = agent as unknown as {
          callModel(
            messages: ChatMessage[],
            spec: never,
            signal?: AbortSignal,
            endpoint?: never,
          ): Promise<{
            content: string | null;
            tool_calls?: Array<{
              id: string;
              name: string;
              arguments: string;
            }>;
          }>;
        };
        const output = await svc.callModel(
          [{ role: 'user', content: 'hi' }],
          { provider_model: 'llama3.2', reasoning: false } as never,
          undefined,
          endpoint as never,
        );
        expect(output.content).toBeNull();
        expect(output.tool_calls).toEqual([
          {
            id: expect.any(String),
            name: 'list_own_workspace',
            arguments: '{}',
          },
        ]);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://ollama.test/v1/chat/completions');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('llama3.2');
        expect(body.temperature).toBe(0.7);
        expect(body.top_p).toBe(0.5);
        expect(body.extra).toBe(1);
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect((init as RequestInit).headers).toEqual(
          expect.objectContaining({ authorization: 'Bearer secret-key' }),
        );
      } finally {
        fetchMock.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('drops temperature for reasoning models', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-reason-'));
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValue({
        ok: true,
        text: jest.fn(async () => ''),
        json: jest.fn(async () => ({
          choices: [{ message: { content: 'reasoned' } }],
        })),
      } as never);
      try {
        const svc = agent as unknown as {
          callModel(messages: ChatMessage[], spec: never): Promise<never>;
        };
        await svc.callModel([{ role: 'user', content: 'hi' }], {
          provider_model: 'reasoner',
          reasoning: true,
        } as never);
        const body = JSON.parse(
          (fetchMock.mock.calls[0][1] as RequestInit).body as string,
        );
        expect(body.model).toBe('reasoner');
        expect(body.temperature).toBeUndefined();
        expect(body.max_tokens).toBe(8192);
      } finally {
        fetchMock.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('surfaces a non-200 upstream response without an auth header', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-llm500-'));
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
      const fetchMock = jest.spyOn(global, 'fetch');
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: jest.fn(async () => 'boom detail'),
        json: jest.fn(async () => ({})),
      } as never);
      try {
        const svc = agent as unknown as {
          callModel(messages: ChatMessage[], spec: never): Promise<never>;
        };
        await expect(
          svc.callModel([{ role: 'user', content: 'hi' }], {
            provider_model: 'ds4-flash',
            reasoning: false,
          } as never),
        ).rejects.toThrow('LLM 500: boom detail');
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect(
          (init.headers as Record<string, string>).authorization,
        ).toBeUndefined();
      } finally {
        fetchMock.mockRestore();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('BaseAgentService executeTool and catalog', () => {
  it('reports invalid JSON arguments as a tool error', async () => {
    const { agent, root } = await makeAgent();
    try {
      const out = await (
        agent as unknown as {
          executeTool(call: {
            id: string;
            name: string;
            arguments: string;
          }): Promise<string>;
        }
      ).executeTool({
        id: 'c1',
        name: 'write_workspace_file',
        arguments: '{oops',
      });
      expect(out).toContain('Invalid JSON args');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('reports a thrown tool run as a JSON error', async () => {
    const { agent, root } = await makeAgent();
    try {
      agent.registerTool({
        name: 'boom',
        description: 'always throws',
        parameters: {},
        run: async () => {
          throw new Error('kaboom');
        },
      });
      const out = await (
        agent as unknown as {
          executeTool(call: {
            id: string;
            name: string;
            arguments: string;
          }): Promise<string>;
        }
      ).executeTool({ id: 'c2', name: 'boom', arguments: '{}' });
      expect(out).toBe(JSON.stringify({ error: 'kaboom' }));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exposes the model catalog and defaults', async () => {
    const { agent, root } = await makeAgent();
    try {
      const catalog = agent.getCatalog();
      expect(catalog.map((m) => m.id)).toEqual(['qwen3.6-35b', 'ds4-flash']);
      expect(catalog.find((m) => m.is_default)?.id).toBe('ds4-flash');
      expect(agent.getDefaults()).toEqual({
        defaultModel: 'ds4-flash',
        baseUrl: 'http://vrs.test/v1',
        contextWindow: 131000,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('applies documented config defaults when values are missing', async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'fmcv-agent-defaults-'),
    );
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(
        {
          get: (k: string) => (k === 'AGENT_WORKSPACE_ROOT' ? root : undefined),
        } as never,
        ws,
        prismaDouble(),
      );
      const svc = agent as unknown as {
        envApiKey: string;
        defaultModelId: string;
        llmTimeoutMs: number;
        llmStub: boolean;
      };
      expect(svc.envApiKey).toBe('');
      expect(svc.defaultModelId).toBe('ds4-flash');
      expect(svc.llmTimeoutMs).toBe(120000);
      expect(svc.llmStub).toBe(false);
      expect(agent.getDefaults().baseUrl).toBe('');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
