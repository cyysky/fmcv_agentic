import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseAgentService, ChatMessage, DEFAULT_SYSTEM_PROMPT } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import type { ToolCallRequest } from './base-agent.service';

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
      const fake = prismaDouble() as unknown as { agentSession: { upsert: jest.Mock; findMany: jest.Mock; delete: jest.Mock } };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);

      const s = await agent.createSession('persist me');
      // create + converse would both persist; here create alone does an upsert.
      expect(fake.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ create: expect.objectContaining({ id: s.id, title: 'persist me' }) }),
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
      expect(fresh.getSession(s.id).messages.map((m) => m.role)).toEqual(['system', 'user']);

      fresh.deleteSession(s.id);
      expect(fake.agentSession.delete).toHaveBeenCalledWith({ where: { id: s.id } });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('auto-titles a default session from its first user message', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-autotitle-'));
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root, { llmStub: true }), ws, prismaDouble());

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
      agent.renameSession(named.id, 'My title');
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
      const fake = prismaDouble() as unknown as { agentSession: { upsert: jest.Mock } };
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);

      const s = await agent.createSession('old title');
      const renamed = agent.renameSession(s.id, '  new title  ');
      expect(renamed.title).toBe('new title');
      expect(agent.getSession(s.id).title).toBe('new title');
      expect(fake.agentSession.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: s.id },
          update: expect.objectContaining({ title: 'new title' }),
        }),
      );
      expect(() => agent.renameSession(s.id, '   ')).toThrow(/blank/);
      expect(() => agent.renameSession('00000000-0000-4000-8000-000000000000', 'x')).toThrow();
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
      expect(agent.listSessions()).toHaveLength(2);
      expect(agent.deleteSession(s.id)).toEqual({ deleted: true });
      expect(agent.listSessions()).toHaveLength(1);
      expect(() => agent.deleteSession(s.id)).toThrow();
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
      const calls: jest.Mock = jest.fn()
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
            } as ToolCallRequest,
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
            arguments: JSON.stringify({ name: 'coder', path: 'cap.txt', content: 'x' }),
          } as ToolCallRequest,
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
      expect(await fs.readFile(path.join(root, 'agents', 'coder', 'cap.txt'), 'utf8')).toBe('x');
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-conn-persist-'));
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-conn-bad-'));
    try {
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, prismaDouble());
      await expect(agent.createSession('bad', undefined, BAD_CONN_ID)).rejects.toThrow(
        `Connection ${BAD_CONN_ID} not found`,
      );
      await expect(
        agent.runTurn({ message: 'hi', connectionId: BAD_CONN_ID }),
      ).rejects.toThrow(`Connection ${BAD_CONN_ID} not found`);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the pinned connection for converse turns (baseUrl/model/key/params)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-conn-converse-'));
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
      const turn = await agent.runTurn({ message: 'hi', connectionId: CONN_ID });
      expect(turn.model).toBe('llama3.2');
      expect(calls.mock.calls[1][3]).toEqual(
        expect.objectContaining({ baseUrl: 'http://ollama.test/v1', model: 'llama3.2' }),
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

  it('self-heals a session whose pinned connection was deleted (falls back to default)', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-conn-gone-'));
    try {
      const fake = prismaDouble() as unknown as { connection: { findUnique: jest.Mock } };
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
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fmcv-agent-conn-attach-'));
    try {
      const fake = withConn();
      const ws = new WorkspaceService(configMock(root));
      const agent = new BaseAgentService(configMock(root), ws, fake as never);
      const calls: jest.Mock = jest.fn(async () => ({ content: 'ok', tool_calls: undefined }));
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

      let toolArgs = '';
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
        .mockImplementationOnce(async () => ({ content: 'final', tool_calls: undefined }));

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
          messages.push({ role: 'user', content: 'interject-me', tool_call_id: undefined });
          return ['interject-me'];
        },
      });

      expect(res.answer).toBe('final');
      expect(res.steps).toBe(1);
      expect(events[0]).toBe('status:Agent started');
      expect(events.some((e) => e === 'tool_call:channel_write')).toBe(true);
      expect(events.some((e) => e === 'answer:final')).toBe(true);
      expect(events.some((e) => e.startsWith('status:used channel_write'))).toBe(true);

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
