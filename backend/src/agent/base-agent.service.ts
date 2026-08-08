import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import {
  MODEL_CATALOG,
  ModelSpec,
  fallbackFor,
  resolveModel,
  resolveWireModel,
} from './agent.models';
import { WorkspaceService } from './workspace.service';
import { buildWorkspaceTools, buildSelfTools } from './workspace-tools';
import { buildChannelTools } from './channel-tools';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type { SkillsService } from '../skills/skills.service';

/**
 * Base agent for FMCC Agentic.
 *
 * A self-contained, provider-agnostic LLM agent loop modeled on the
 * reference agent implementations:
 *
 * - `reference/pi/packages/agent/src/agent.ts` — the core loop that runs a
 *   model, executes tool calls, and iterates until the model stops.
 * - `reference/pi/packages/agent/src/agent-loop.ts` — the step/tool budget
 *   handling the loop below approximates.
 * - `reference/pi/packages/ai/src/model-catalog.ts` — catalog-driven model
 *   resolution.
 * - `reference/jcode/src/lib.rs` + `reference/hermes-agent/agent` — how a
 *   base agent is structured into a runnable, tool-capable unit.
 *
 * The model provider is configured from environment variables, defaulting to
 * the VRS provider the user already uses in `~/.codex/config.toml`:
 *
 *   AGENT_BASE_URL  (default http://60.51.17.97:9999/v1)
 *   AGENT_API_KEY   (default from AGENT_API_KEY env)
 *   AGENT_DEFAULT_MODEL
 *
 * Endpoint is `/chat/completions` on the base URL, authenticated with a
 * Bearer token — the OpenAI-compatible wire format shared by qwen3.6-35b
 * and ds4-flash on the VRS gateway.
 */

export interface BaseTool {
  /** Tool name sent to the model (snake_case). */
  name: string;
  /** One-line description for the tool list. */
  description: string;
  /** JSON-schema parameters object. */
  parameters: Record<string, unknown>;
  /** Executor. `args` is the parsed JSON args map. */
  run: (args: Record<string, unknown>) => unknown;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
}

/** One tool invocation recorded for the turn trace shown in the UI. */
export interface ToolTraceStep {
  type: 'tool_call';
  name: string;
  arguments: string;
  result: string;
}

/** Live event emitted while a channel turn streams, so the UI can watch. */
export interface ChannelTurnStreamEvent {
  type: 'status' | 'tool_call' | 'interject' | 'answer' | 'error';
  text?: string;
  name?: string;
  arguments?: string;
  result?: string;
  step?: number;
}

/** OpenAI-compatible tool call shape for assistant messages on the wire. */
export interface ApiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ApiToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  connectionId?: string;
  createdAt: string;
  messages: ChatMessage[];
}

/**
 * A resolved provider endpoint for one turn. When a saved Connection is
 * chosen, its baseUrl/modelName/apiKey/defaultParameters replace the agent's
 * built-in gateway + catalog model for that turn.
 */
export interface ModelEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
  defaultParameters?: Record<string, unknown>;
}

/** Default session title until the first user message can auto-title it. */
export const DEFAULT_SESSION_TITLE = 'New session';

/** Derive a short, single-line sidebar title from a user message. */
function deriveSessionTitle(message: string): string {
  const flat = message.trim().replace(/\s+/g, ' ');
  if (!flat) return DEFAULT_SESSION_TITLE;
  return flat.length > 40 ? `${flat.slice(0, 40)}…` : flat;
}

export const DEFAULT_SYSTEM_PROMPT = `You are FMCC Base Agent, a helpful, tool-using AI assistant.
You have access to a set of tools. Reason about the user's request, call the
right tools when they help, and give a clear, correct final answer. Be concise.`;

@Injectable()
export class BaseAgentService implements OnModuleInit {
  private readonly logger = new Logger(BaseAgentService.name);

  private readonly baseUrl: string;
  private readonly defaultModelId: string;
  private readonly llmTimeoutMs: number;
  private readonly llmStub: boolean;
  private readonly workspaces: WorkspaceService;
  private readonly prisma: PrismaService;
  private readonly envApiKey: string;

  /** In-memory sessions keyed by id (sessions persist for the process only). */
  private readonly sessions = new Map<string, Session>();

  /** Registered tools, keyed by tool name. */
  private readonly tools = new Map<string, BaseTool>();

  /** Optional skill registry (DIRECTION item 3). When injected, agents get a
   *  `read_skill` tool and a system-prompt block listing installed skills. */
  private readonly skills?: SkillsService | null;

  constructor(
    config: ConfigService,
    workspaces: WorkspaceService,
    prisma: PrismaService,
    @Optional() skills?: SkillsService,
  ) {
    this.baseUrl = (
      config.get<string>('AGENT_BASE_URL', 'http://60.51.17.97:9999/v1') ?? ''
    ).replace(/\/+$/, '');
    this.envApiKey = config.get<string>('AGENT_API_KEY', '') ?? '';
    this.defaultModelId =
      config.get<string>('AGENT_DEFAULT_MODEL', 'ds4-flash') ?? 'ds4-flash';
    this.llmTimeoutMs =
      Number(config.get<string>('AGENT_LLM_TIMEOUT_MS', '120000')) || 120000;
    this.llmStub = ['1', 'true', 'yes', 'on'].includes(
      (config.get<string>('AGENT_LLM_STUB', '') ?? '').toLowerCase(),
    );
    this.workspaces = workspaces;
    this.prisma = prisma;
    this.registerTools(buildWorkspaceTools(workspaces));
    if (skills) {
      this.skills = skills;
      this.registerTool({
        name: 'read_skill',
        description:
          'Load the full instructions of an installed skill by its exact name. Use it whenever a named skill is relevant to the request.',
        parameters: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact name of the installed skill',
            },
          },
          required: ['name'],
        },
        run: async (args: Record<string, unknown>) => {
          const name = typeof args.name === 'string' ? args.name.trim() : '';
          if (!name) {
            return JSON.stringify({ error: 'Skill name is required' });
          }
          const content = await this.skillsContent(name);
          if (content === null) {
            return JSON.stringify({
              error: `No installed skill named "${name}"`,
            });
          }
          return content;
        },
      });
    }
    this.logger.log(
      `Base agent ready. baseUrl=${this.baseUrl} defaultModel=${this.defaultModelId} stub=${this.llmStub}`,
    );
  }

  /**
   * Resolve the LLM API key: the `AGENT_API_KEY` env var wins if set; otherwise
   * fall back to the first `connections` row matching this agent's base URL,
   * read live from the DB. This removes the need to pass the key at deploy
   * time — the backend reads it wherever it is configured (the DB).
   */
  private async apiKey(): Promise<string> {
    if (this.envApiKey) return this.envApiKey;
    try {
      const row = await this.prisma.connection.findFirst({
        where: { baseUrl: { equals: this.baseUrl, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
      });
      if (row?.apiKey) return row.apiKey;
    } catch (err) {
      this.logger.warn(
        `Could not read API key from DB: ${(err as Error).message}`,
      );
    }
    return '';
  }

  /**
   * Resolve a saved Connection into the endpoint override used for a turn.
   * `detachIfMissing` is for sessions whose stored connection was deleted:
   * they fall back to the default endpoint (mirroring the FK SetNull).
   * For explicit ids (create/turn/attach), a missing row is a 404.
   */
  private async resolveConnectionEndpoint(
    connectionId: string | undefined,
    detachIfMissing: boolean,
  ): Promise<ModelEndpoint | null> {
    if (!connectionId) return null;
    const row = await this.prisma.connection.findUnique({
      where: { id: connectionId },
    });
    if (!row) {
      if (detachIfMissing) return null;
      throw new NotFoundException(`Connection ${connectionId} not found`);
    }
    return {
      baseUrl: row.baseUrl,
      model: row.modelName,
      ...(row.apiKey ? { apiKey: row.apiKey } : {}),
      ...(row.defaultParameters
        ? {
            defaultParameters: row.defaultParameters as unknown as Record<
              string,
              unknown
            >,
          }
        : {}),
    };
  }

  /* ------------------------------------------------------------------ *
   * Tool registry
   * ------------------------------------------------------------------ */

  /** Register a tool the model can call. */
  registerTool(tool: BaseTool): this {
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Register a batch of tools. */
  registerTools(tools: BaseTool[]): this {
    for (const t of tools) this.registerTool(t);
    return this;
  }

  listTools(): BaseTool[] {
    return [...this.tools.values()];
  }

  /* ------------------------------------------------------------------ *
   * Sessions
   * ------------------------------------------------------------------ */

  async createSession(
    title = DEFAULT_SESSION_TITLE,
    model?: string,
    connectionId?: string,
  ): Promise<Session> {
    const spec = resolveModel(model ?? this.defaultModelId);
    const session: Session = {
      id: randomUUID(),
      title,
      model: spec.id,
      createdAt: new Date().toISOString(),
      messages: [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }],
    };
    if (connectionId) {
      session.connectionId = connectionId;
      // Fail fast: never persist a session pinned to a connection that does
      // not exist (checked explicitly, so a bad id is a 404 right here).
      await this.resolveConnectionEndpoint(connectionId, false);
    }
    this.sessions.set(session.id, session);
    await this.persistSession(session);
    return session;
  }

  getSession(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException(`Session ${id} not found`);
    return s;
  }

  listSessions(): Promise<Session[]> {
    const live = [...this.sessions.values()];
    return this.prisma.agentSession
      .findMany({ orderBy: { createdAt: 'desc' } })
      .then((rows) => {
        const known = new Set(this.sessions.keys());
        const persisted = rows
          .filter((row) => !known.has(row.id))
          .map((row) => this.sessionFromRow(row));
        return [...live, ...persisted];
      })
      .catch((err) => {
        this.logger.warn(
          `Could not list persisted sessions: ${(err as Error).message}`,
        );
        return live;
      });
  }

  async renameSession(id: string, title: string): Promise<Session> {
    const clean = title.trim();
    if (!clean) {
      throw new BadRequestException('Session title must not be blank');
    }
    const session = this.getSession(id);
    session.title = clean;
    await this.persistSession(session);
    return session;
  }

  async deleteSession(id: string): Promise<{ deleted: boolean }> {
    const hadLive = this.sessions.delete(id);
    if (!hadLive) {
      const row = await this.prisma.agentSession
        .findUnique({ where: { id } })
        .catch(() => null);
      if (!row) throw new NotFoundException(`Session ${id} not found`);
    }
    // Remove the row after the in-memory map. A row missing from the map can
    // still exist in Postgres (e.g. written by another process against the
    // shared DB), so the DB delete is the fallback that makes cleanup work.
    await this.prisma.agentSession
      .delete({ where: { id } })
      .catch(() => undefined);
    return { deleted: true };
  }

  /** Best-effort write of a session row to Postgres; a DB failure must never
   *  break the in-memory session flow, so it is logged and swallowed. Callers
   *  await the promise so a completed turn never races ahead of its own
   *  persisted row (read-your-writes for API callers). */
  private async persistSession(session: Session): Promise<void> {
    try {
      await this.prisma.agentSession.upsert({
        where: { id: session.id },
        create: {
          id: session.id,
          title: session.title,
          model: session.model,
          ...(session.connectionId
            ? { connectionId: session.connectionId }
            : {}),
          messages: session.messages as unknown as Prisma.InputJsonValue,
          createdAt: new Date(session.createdAt),
        },
        update: {
          title: session.title,
          model: session.model,
          ...(session.connectionId
            ? { connectionId: session.connectionId }
            : { connectionId: null }),
          messages: session.messages as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(
        `Could not persist session ${session.id}: ${(err as Error).message}`,
      );
    }
  }

  /** Map a persisted row onto the public Session shape. */
  private sessionFromRow(row: {
    id: string;
    title: string;
    model: string;
    connectionId: string | null;
    createdAt: Date;
    messages: unknown;
  }): Session {
    return {
      id: row.id,
      title: row.title,
      model: row.model,
      ...(row.connectionId ? { connectionId: row.connectionId } : {}),
      createdAt: row.createdAt.toISOString(),
      messages: (row.messages as ChatMessage[]) ?? [],
    };
  }

  /** Reload persisted sessions after a restart so `/api/agent/sessions`
   *  and GET-by-id keep working (in-memory wins for live sessions). */
  async onModuleInit(): Promise<void> {
    try {
      const rows = await this.prisma.agentSession.findMany({
        orderBy: { createdAt: 'desc' },
      });
      for (const row of rows) {
        if (this.sessions.has(row.id)) continue;
        this.sessions.set(row.id, this.sessionFromRow(row));
      }
      if (rows.length > 0) {
        this.logger.log(`Recovered ${rows.length} persisted session(s)`);
      }
    } catch (err) {
      this.logger.warn(
        `Could not recover sessions on startup: ${(err as Error).message}`,
      );
    }
  }
  /** Installed-skill registry snippet for system prompts. Returns null when
   *  there are no installed skills (or no skill registry is wired). */
  private async buildSkillsBlock(): Promise<string | null> {
    if (!this.skills) return null;
    let installed: { name: string; description: string }[];
    try {
      installed = await this.skills.listInstalled();
    } catch (err) {
      this.logger.warn(
        `Could not load installed skills: ${(err as Error).message}`,
      );
      return null;
    }
    if (installed.length === 0) return null;
    const lines = installed.map(
      (skill) => `- ${skill.name}: ${skill.description || 'no description'}`,
    );
    return [
      'Installed skills are available to you. When one is relevant, call read_skill with its exact name to load its full instructions.',
      ...lines,
    ].join('\n');
  }

  /** Content of an installed skill for the `read_skill` tool (null when no
   *  registry is wired or the skill is missing/not installed). */
  private async skillsContent(name: string): Promise<string | null> {
    if (!this.skills) return null;
    return this.skills.contentFor(name);
  }

  /* ------------------------------------------------------------------ *
   * Public turn entry points
   * ------------------------------------------------------------------ */

  /** Stateless single-turn answer (optionally with prior message history). */
  async runTurn(opts: {
    message: string;
    history?: string[];
    model?: string;
    maxSteps?: number;
    connectionId?: string;
  }): Promise<{
    answer: string;
    model: string;
    steps: number;
    trace?: ToolTraceStep[];
  }> {
    const spec = resolveModel(opts.model ?? this.defaultModelId);
    // An explicit `model` is a catalog override: it wins over the pinned
    // connection's stored modelName while still routing through the
    // connection's baseUrl/key/default parameters. Without one, the
    // connection's modelName is the wire model.
    const modelOverride = opts.model !== undefined;
    // An explicit connection is required to exist (bad id => 404); sessions
    // that lost their connection can self-heal, but a fresh turn cannot.
    const endpoint = await this.resolveConnectionEndpoint(
      opts.connectionId,
      false,
    );
    const wireEndpoint =
      endpoint && modelOverride
        ? { ...endpoint, model: resolveWireModel(opts.model as string) }
        : endpoint;
    const skillsBlock = this.skills ? await this.buildSkillsBlock() : null;
    const messages: ChatMessage[] = [
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      ...(skillsBlock
        ? [{ role: 'system' as const, content: skillsBlock }]
        : []),
      ...(opts.history ?? []).map((h) => ({
        role: 'user' as const,
        content: h,
      })),
      { role: 'user', content: opts.message },
    ];
    const { answer, steps, trace } = await this.runLoop(
      messages,
      spec,
      opts.maxSteps ?? 10,
      wireEndpoint ?? undefined,
    );
    return { answer, model: wireEndpoint?.model ?? spec.id, steps, trace };
  }

  /**
   * Append a user message to a session, run the loop, return the final text.
   * `connectionId` optionally pins the session to a saved Connection; once
   * pinned it persists, so later turns keep using that provider. If the
   * pinned connection was deleted, the session self-heals back to the
   * default endpoint (mirrors the DB `onDelete: SetNull`).
   */
  async converse(
    sessionId: string,
    message: string,
    model?: string,
    maxSteps?: number,
    connectionId?: string,
  ): Promise<{ answer: string; steps: number }> {
    const session = this.getSession(sessionId);
    const explicitConnection = connectionId !== undefined;
    if (explicitConnection) session.connectionId = connectionId;
    const endpoint = await this.resolveConnectionEndpoint(
      session.connectionId,
      !explicitConnection,
    );
    if (endpoint === null && !explicitConnection && session.connectionId) {
      this.logger.warn(
        `Session ${sessionId}: stored connection ${session.connectionId} no longer exists; using the default endpoint`,
      );
      delete session.connectionId;
    }
    const explicitModel = model !== undefined;
    const spec = resolveModel(model ?? session.model);
    // A catalog model chosen alongside the connection overrides the stored
    // modelName on the wire for this turn (per-call choice; without one the
    // connection's modelName is used).
    const wireEndpoint =
      endpoint && explicitModel
        ? { ...endpoint, model: resolveWireModel(model) }
        : endpoint;
    // Store the explicit id verbatim (a catalog id or a raw provider model
    // from the connection's list) so reopening the session sees the same
    // model the user picked; without an explicit model keep the resolved id.
    session.model = model ?? spec.id;
    const userMsgCount = session.messages.filter(
      (m) => m.role === 'user',
    ).length;
    session.messages.push({ role: 'user', content: message });
    // Auto-title: the first user message names a default-titled session, so
    // the sidebar is useful without a manual rename. Later messages and
    // manually renamed sessions are left alone.
    if (session.title === DEFAULT_SESSION_TITLE && userMsgCount === 0) {
      session.title = deriveSessionTitle(message);
    }
    const maxRunSteps = maxSteps && maxSteps > 0 ? maxSteps : 10;
    const skillsBlock = this.skills ? await this.buildSkillsBlock() : null;
    let runMessages = session.messages;
    if (skillsBlock) {
      runMessages = [...session.messages];
      runMessages.splice(1, 0, { role: 'system', content: skillsBlock });
    }
    const { answer, steps, messages } = await this.runLoop(
      runMessages,
      spec,
      maxRunSteps,
      wireEndpoint ?? undefined,
    );
    // Keep the persisted transcript free of the per-turn skills registry:
    // it is re-injected fresh on every turn, so stored history stays clean.
    session.messages = skillsBlock
      ? messages.filter(
          (m) => !(m.role === 'system' && m.content === skillsBlock),
        )
      : messages;
    await this.persistSession(session);
    return { answer, steps };
  }

  /**
   * Run an agent turn scoped to a team channel. The agent gets a tight set of
   * channel tools (list/read/write the channel's project folder, post to the
   * feed) PLUS its normal own-folder workspace tools, so it can work both on
   * the channel project and its own folder. The channel thread is injected as
   * context. Returns the final answer and the tool-call trace.
   */
  async runChannelTurn(opts: {
    agentName: string;
    channelSlug: string;
    channelProjectName: string;
    thread: string;
    message: string;
    model?: string;
    maxSteps?: number;
    channelPost: (text: string, toolCalls?: unknown[]) => Promise<unknown>;
  }): Promise<{ answer: string; steps: number; trace?: ToolTraceStep[] }> {
    const spec = resolveModel(opts.model ?? this.defaultModelId);

    const skillsBlock = this.skills ? await this.buildSkillsBlock() : null;
    const systemPrompt =
      [
        DEFAULT_SYSTEM_PROMPT,
        '',
        `You are working in team channel #${opts.channelSlug}.`,
        `The channel owns a project folder named "${opts.channelProjectName}".`,
        `Your agent name is "${opts.agentName}" — your own folder is agents/${opts.agentName}.`,
        `When asked about "your" folder or files, use list_own_workspace / read_own_file / write_own_file (no agent argument needed).`,
        'You can work directly on this channel project folder with the',
        'channel_list / channel_read / channel_write tools, and you can also work',
        'in your own agent folder with the workspace tools. Use channel_post to',
        'publish short updates to the channel feed so your teammates can see them.',
      ].join('\n') + (skillsBlock ? `\n\n${skillsBlock}` : '');

    const threadBlock =
      opts.thread && opts.thread.trim().length > 0
        ? [
            '',
            'Recent channel activity (messages by you and teammates):',
            opts.thread,
          ].join('\n')
        : '';

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...(threadBlock ? [{ role: 'user' as const, content: threadBlock }] : []),
      { role: 'user', content: opts.message },
    ];

    // Build a per-turn tool set: channel tools + workspace tools for this agent.
    const channelTools = buildChannelTools(this.workspaces, {
      agentName: opts.agentName,
      channelSlug: opts.channelSlug,
      channelProjectName: opts.channelProjectName,
      channelPost: opts.channelPost,
    });

    const baseTools = this.listTools().filter(
      (t) =>
        ![
          'channel_list',
          'channel_read',
          'channel_write',
          'channel_post',
        ].includes(t.name),
    );
    // Self-scoped equivalents of the workspace tools, bound to THIS agent so
    // the model never has to pass its own agent name (no more guessing).
    const selfTools = buildSelfTools(this.workspaces, opts.agentName);
    const turnTools = [...channelTools, ...selfTools, ...baseTools];

    // Run the loop with the restricted tool set. To avoid mutating the global
    // tool registry per request, we run the core loop directly with an injectable
    // tool resolver by temporarily swapping the registry.
    const prevTools = new Map(this.tools);
    try {
      // Temporarily replace the registry so executeTool resolves channel tools.
      this.tools.clear();
      for (const t of turnTools) this.tools.set(t.name, t);
      const { answer, steps, trace } = await this.runLoop(
        messages,
        spec,
        opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : 12,
      );
      return { answer, steps, trace };
    } finally {
      this.tools.clear();
      for (const [k, v] of prevTools) this.tools.set(k, v);
    }
  }

  /**
   * Streaming variant of `runChannelTurn`. Builds the same system prompt,
   * thread context and per-turn tool set, but streams live `onEvent` updates
   * as the loop runs and accepts an `interject()` getter so the UI can push
   * user text into the agent's context before the next model call.
   *
   * `messages` is a live array owned by the caller: the initial system/user
   * messages and any interjections are appended to it, so the job can keep it
   * in sync with what the model actually sees.
   */
  async runChannelTurnStreaming(opts: {
    agentName: string;
    channelSlug: string;
    channelProjectName: string;
    thread: string;
    message: string;
    model?: string;
    maxSteps?: number;
    channelPost: (text: string, toolCalls?: unknown[]) => Promise<unknown>;
    /** Optional separate callback for the per-tool-call status posts (the
     *  lightweight "used <tool> on <target>" updates). When provided, these
     *  go to a different feed (e.g. an agent sub-channel / debug trace) than
     *  `channel_post` and the final answer. Defaults to `channelPost`. */
    toolStatusPost?: (text: string, toolCalls?: unknown[]) => Promise<unknown>;
    messages: ChatMessage[];
    onEvent: (event: ChannelTurnStreamEvent) => void;
    interject: () => string[];
    signal?: AbortSignal;
  }): Promise<{ answer: string; steps: number; trace?: ToolTraceStep[] }> {
    const spec = resolveModel(opts.model ?? this.defaultModelId);

    const skillsBlock = this.skills ? await this.buildSkillsBlock() : null;
    const systemPrompt =
      [
        DEFAULT_SYSTEM_PROMPT,
        '',
        `You are working in team channel #${opts.channelSlug}.`,
        `The channel owns a project folder named "${opts.channelProjectName}".`,
        `Your agent name is "${opts.agentName}" — your own folder is agents/${opts.agentName}.`,
        `When asked about "your" folder or files, use list_own_workspace / read_own_file / write_own_file (no agent argument needed).`,
        'You can work directly on this channel project folder with the',
        'channel_list / channel_read / channel_write tools, and you can also work',
        'in your own agent folder with the workspace tools. Use channel_post to',
        'publish short updates to the channel feed so your teammates can see them.',
      ].join('\n') + (skillsBlock ? `\n\n${skillsBlock}` : '');

    const threadBlock =
      opts.thread && opts.thread.trim().length > 0
        ? [
            '',
            'Recent channel activity (messages by you and teammates):',
            opts.thread,
          ].join('\n')
        : '';

    const messages = opts.messages;
    messages.push({ role: 'system', content: systemPrompt });
    if (threadBlock) {
      messages.push({ role: 'user', content: threadBlock });
    }
    messages.push({ role: 'user', content: opts.message });
    opts.onEvent({ type: 'status', text: 'Agent started' });

    // Build a per-turn tool set: channel tools + workspace tools for this agent.
    const channelTools = buildChannelTools(this.workspaces, {
      agentName: opts.agentName,
      channelSlug: opts.channelSlug,
      channelProjectName: opts.channelProjectName,
      channelPost: opts.channelPost,
    });

    const baseTools = this.listTools().filter(
      (t) =>
        ![
          'channel_list',
          'channel_read',
          'channel_write',
          'channel_post',
        ].includes(t.name),
    );
    // Self-scoped equivalents of the workspace tools, bound to THIS agent so
    // the model never has to pass its own agent name (no more guessing).
    const selfTools = buildSelfTools(this.workspaces, opts.agentName);
    const turnTools = [...channelTools, ...selfTools, ...baseTools];

    const prevTools = new Map(this.tools);
    try {
      // Temporarily replace the registry so executeTool resolves channel tools.
      this.tools.clear();
      for (const t of turnTools) this.tools.set(t.name, t);

      let steps = 0; // counts executed tool CALLS (matches the trace length)
      let answer = '';
      const trace: ToolTraceStep[] = [];
      // Harden against degenerate loops: if this many consecutive rounds of
      // tool calls return errors, stop instead of burning the whole budget.
      const MAX_CONSECUTIVE_ERROR_ROUNDS = 3;
      let consecutiveErrorRounds = 0;
      const maxIterations =
        opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : 12;

      for (
        let iter = 0;
        iter < maxIterations && !opts.signal?.aborted;
        iter++
      ) {
        // 1. Drain the mailbox: any queued interjections land in context now.
        const interjections = opts.interject();
        for (const text of interjections) {
          messages.push({ role: 'user', content: text });
          opts.onEvent({ type: 'interject', text, step: steps });
        }

        // 2. Call the model with the (possibly interjected-upon) messages.
        let completion;
        try {
          completion = await this.callModel(messages, spec, opts.signal);
        } catch (err) {
          // If the aborted call was due to a stop request, end the turn quietly.
          if (opts.signal?.aborted) {
            answer = answer || '[stopped]';
            break;
          }
          const fb = fallbackFor(spec);
          if (!fb) throw err;
          this.logger.warn(
            `Primary model ${spec.id} failed (${(err as Error).message}); falling back to ${fb.id}`,
          );
          completion = await this.callModel(messages, fb, opts.signal);
        }

        if (completion.tool_calls && completion.tool_calls.length > 0) {
          messages.push({
            role: 'assistant',
            content: completion.content,
            tool_calls: completion.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: tc.arguments },
            })),
          });
          let roundErrors = 0;
          const roundCalls = completion.tool_calls.length;
          // 3. Execute each tool call, stream it, and post a short feed update.
          for (const call of completion.tool_calls) {
            const result = await this.executeTool(call);
            // Count a round as "failed" if every call in it errored.
            let isError = false;
            try {
              const parsed = JSON.parse(result) as { error?: unknown };
              isError = !!parsed?.error;
            } catch {
              /* non-JSON result counts as success */
            }
            if (isError) roundErrors++;
            steps += 1; // each executed tool call is one step
            trace.push({
              type: 'tool_call',
              name: call.name,
              arguments: call.arguments,
              result,
            });
            messages.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.name,
              content: result,
            });
            opts.onEvent({
              type: 'tool_call',
              name: call.name,
              arguments: call.arguments,
              result,
              step: steps,
            });
            await (opts.toolStatusPost ?? opts.channelPost)(
              this.shortToolText(call.name, call.arguments),
              [{ name: call.name, arguments: call.arguments, result }],
            );
          }
          if (roundErrors === roundCalls && roundCalls > 0) {
            consecutiveErrorRounds++;
          } else {
            consecutiveErrorRounds = 0;
          }
          if (consecutiveErrorRounds >= MAX_CONSECUTIVE_ERROR_ROUNDS) {
            answer =
              answer ||
              '[stopped] Repeated tool errors — the agent could not make progress.';
            opts.onEvent({
              type: 'answer',
              text: answer,
              step: steps,
            });
            break;
          }
          continue; // loop again so the model sees tool results
        }

        // 4. Plain-text answer.
        answer = completion.content ?? '';
        messages.push({ role: 'assistant', content: answer });
        opts.onEvent({ type: 'answer', text: answer, step: steps });
        break;
      }

      return { answer, steps, trace };
    } finally {
      this.tools.clear();
      for (const [k, v] of prevTools) this.tools.set(k, v);
    }
  }

  /** Build a short one-line feed update describing a tool call. */
  private shortToolText(name: string, rawArgs: string): string {
    let target: string | undefined;
    try {
      const args = rawArgs
        ? (JSON.parse(rawArgs) as Record<string, unknown>)
        : {};
      target =
        typeof args.path === 'string'
          ? args.path
          : typeof args.file === 'string'
            ? args.file
            : undefined;
    } catch {
      // ignore malformed args
    }
    return target ? `used ${name} on ${target}` : `used ${name}`;
  }

  /* ------------------------------------------------------------------ *
   * Core agent loop
   * ------------------------------------------------------------------ */

  /**
   * Runs the model→tools→model loop until the model produces a plain-text
   * (non-tool-call) completion or the step budget is exhausted. Mirrors the
   * tool-call loop from `reference/pi/packages/agent/src/agent-loop.ts` and
   * the `mastic_mosti_ocr` research agent.
   */
  private async runLoop(
    messages: ChatMessage[],
    spec: ModelSpec,
    maxSteps: number,
    endpoint?: ModelEndpoint,
  ): Promise<{
    answer: string;
    steps: number;
    messages: ChatMessage[];
    trace: ToolTraceStep[];
  }> {
    let steps = 0;
    let lastAnswer = '';
    const trace: ToolTraceStep[] = [];

    for (; steps < maxSteps; steps++) {
      let completion;
      try {
        completion = await this.callModel(messages, spec, undefined, endpoint);
      } catch (err) {
        // A custom connection IS the user's explicit provider choice — a
        // catalog fallback model almost certainly does not exist there.
        const fb = endpoint ? null : fallbackFor(spec);
        if (!fb) throw err;
        this.logger.warn(
          `Primary model ${spec.id} failed (${(err as Error).message}); falling back to ${fb.id}`,
        );
        completion = await this.callModel(messages, fb, undefined, endpoint);
      }

      if (completion.tool_calls && completion.tool_calls.length > 0) {
        // Execute each requested tool call and append results as `tool` msgs.
        messages.push({
          role: 'assistant',
          content: completion.content,
          // Echo the tool_calls back in the OpenAI-compatible wire shape
          // ({id, type:'function', function:{name, arguments}}) so the LLM
          // receives a valid tool-call message on the next round.
          tool_calls: completion.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
        for (const call of completion.tool_calls) {
          const result = await this.executeTool(call);
          trace.push({
            type: 'tool_call',
            name: call.name,
            arguments: call.arguments,
            result,
          });
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: result,
          });
        }
        continue; // loop again so the model sees tool results
      }

      // Plain text answer.
      lastAnswer = completion.content ?? '';
      messages.push({ role: 'assistant', content: lastAnswer });
      break;
    }

    return { answer: lastAnswer, steps, messages, trace };
  }

  /* ------------------------------------------------------------------ *
   * LLM transport (OpenAI-compatible chat completions)
   * ------------------------------------------------------------------ */

  private toApiTools() {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private async callModel(
    messages: ChatMessage[],
    spec: ModelSpec,
    signal?: AbortSignal,
    endpoint?: ModelEndpoint,
  ): Promise<{ content: string | null; tool_calls?: ToolCallRequest[] }> {
    if (this.llmStub) {
      return this.stubCompletion(messages);
    }
    const body: Record<string, unknown> = {
      model: endpoint?.model ?? spec.provider_model,
      messages,
    };
    if (spec.reasoning) {
      delete body.temperature;
    } else {
      body.temperature = 0.2;
    }
    body.max_tokens = 8192;
    // Saved connection default parameters override the loop's defaults, but
    // can never hijack the wire model, messages, or tool definitions.
    if (endpoint?.defaultParameters) {
      for (const [k, v] of Object.entries(endpoint.defaultParameters)) {
        if (k === 'model' || k === 'messages' || k === 'tools') continue;
        body[k] = v;
      }
    }
    const apiTools = this.toApiTools();
    if (apiTools.length > 0) body.tools = apiTools;
    if (spec.reasoning) delete body.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.llmTimeoutMs);

    // Combine the internal timeout with an optional external stop signal so a
    // caller (e.g. the channel-job stop endpoint) can abort an in-flight call.
    const combinedSignal = signal
      ? AbortSignal.any([controller.signal, signal])
      : controller.signal;

    try {
      // A connection's stored key is used verbatim for ITS endpoint; the env
      // key / DB-matched key only ever applies to the built-in gateway.
      const key = endpoint ? (endpoint.apiKey ?? '') : await this.apiKey();
      const baseUrl = endpoint?.baseUrl ?? this.baseUrl;
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: combinedSignal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`LLM ${response.status}: ${text.slice(0, 500)}`);
      }

      const data = (await response.json()) as {
        choices: Array<{
          message?: {
            content?: string | null;
            tool_calls?: Array<{
              id?: string;
              function?: { name?: string; arguments?: string };
            }>;
          };
        }>;
      };

      const msg = data.choices?.[0]?.message;
      const content = msg?.content ?? null;

      const toolCalls = (msg?.tool_calls ?? [])
        .filter((tc) => tc?.function?.name)
        .map((tc) => ({
          id: tc.id ?? randomUUID(),
          name: tc.function!.name!,
          arguments: tc.function!.arguments ?? '{}',
        }));

      return { content, tool_calls: toolCalls.length ? toolCalls : undefined };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Deterministic offline mode (`AGENT_LLM_STUB=1`): short-circuits the LLM
   *  transport so API/channel E2E can run without the external gateway. The
   *  answer is a stable echo of the last user message — a plain-text reply,
   *  so the agent loop terminates after zero tool steps. */
  private stubCompletion(messages: ChatMessage[]): { content: string } {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const text = String(lastUser?.content ?? 'ok')
      .replace(/\s+/g, ' ')
      .trim();
    return { content: `[stub] ${text.slice(0, 160)}` };
  }

  private async executeTool(call: ToolCallRequest): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${call.name}` });

    let args: Record<string, unknown> = {};
    try {
      args = call.arguments
        ? (JSON.parse(call.arguments) as Record<string, unknown>)
        : {};
    } catch {
      return JSON.stringify({ error: `Invalid JSON args for ${call.name}` });
    }

    try {
      const result = await tool.run(args);
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (err) {
      return JSON.stringify({ error: (err as Error).message ?? String(err) });
    }
  }

  /* ------------------------------------------------------------------ *
   * Model listing helper for the controller
   * ------------------------------------------------------------------ */

  getCatalog() {
    return MODEL_CATALOG.map(({ id, label, description, is_default }) => ({
      id,
      label,
      description,
      is_default,
    }));
  }

  getDefaults() {
    const def = resolveModel(undefined);
    return {
      defaultModel: def.id,
      baseUrl: this.baseUrl,
      contextWindow: def.context_window ?? 131000,
    };
  }
}
