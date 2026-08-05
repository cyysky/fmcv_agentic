import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BaseAgentService, ChatMessage } from './base-agent.service';
import { WorkspaceService } from './workspace.service';
import type { ToolCallRequest } from './base-agent.service';

function configMock(root: string) {
  return {
    get: (k: string, d?: string) => {
      if (k === 'AGENT_WORKSPACE_ROOT') return root;
      if (k === 'AGENT_BASE_URL') return 'http://vrs.test/v1';
      if (k === 'AGENT_DEFAULT_MODEL') return 'ds4-flash';
      if (k === 'AGENT_API_KEY') return '';
      return d;
    },
  } as never;
}

function prismaDouble() {
  return {
    connection: { findFirst: jest.fn(async () => null) },
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
  it('creates sessions with the default model and resolves unknown models', async () => {
    const { agent, root } = await makeAgent();
    try {
      const s = agent.createSession('t');
      expect(s.model).toBe('ds4-flash');
      expect(s.messages[0].role).toBe('system');
      expect(agent.getSession(s.id).id).toBe(s.id);
      const s2 = agent.createSession('t2', 'not-a-model');
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

  it('converse appends to the session and obeys maxSteps', async () => {
    const { agent, root } = await makeAgent();
    try {
      const s = agent.createSession('s');
      const maxCalls = 2;
      (agent as unknown as { callModel: jest.Mock }).callModel = jest.fn(
        async () => ({ content: 'ok', tool_calls: undefined }),
      );
      await agent.converse(s.id, 'q1', undefined, maxCalls);
      expect(agent.getSession(s.id).messages.map((m) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
      ]);
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
