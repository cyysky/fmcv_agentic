import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { MODEL_CATALOG, ModelSpec, fallbackFor, resolveModel } from './agent.models';
import { WorkspaceService } from './workspace.service';
import { buildWorkspaceTools } from './workspace-tools';

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
  run: (args: Record<string, unknown>) => Promise<unknown> | unknown;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: string;
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
  createdAt: string;
  messages: ChatMessage[];
}

export const DEFAULT_SYSTEM_PROMPT = `You are FMCC Base Agent, a helpful, tool-using AI assistant.
You have access to a set of tools. Reason about the user's request, call the
right tools when they help, and give a clear, correct final answer. Be concise.`;

@Injectable()
export class BaseAgentService {
  private readonly logger = new Logger(BaseAgentService.name);

  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly defaultModelId: string;
  private readonly llmTimeoutMs: number;

  /** In-memory sessions keyed by id (sessions persist for the process only). */
  private readonly sessions = new Map<string, Session>();

  /** Registered tools, keyed by tool name. */
  private readonly tools = new Map<string, BaseTool>();

  constructor(config: ConfigService, workspaces: WorkspaceService) {
    this.baseUrl = (config.get<string>('AGENT_BASE_URL', 'http://60.51.17.97:9999/v1') ?? '').replace(/\/+$/, '');
    this.apiKey = config.get<string>('AGENT_API_KEY', '') ?? '';
    this.defaultModelId = config.get<string>('AGENT_DEFAULT_MODEL', 'ds4-flash') ?? 'ds4-flash';
    this.llmTimeoutMs = Number(config.get<string>('AGENT_LLM_TIMEOUT_MS', '120000')) || 120000;
    this.registerTools(buildWorkspaceTools(workspaces));
    this.logger.log(`Base agent ready. baseUrl=${this.baseUrl} defaultModel=${this.defaultModelId}`);
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

  createSession(title = 'New session', model?: string): Session {
    const spec = resolveModel(model ?? this.defaultModelId);
    const session: Session = {
      id: randomUUID(),
      title,
      model: spec.id,
      createdAt: new Date().toISOString(),
      messages: [{ role: 'system', content: DEFAULT_SYSTEM_PROMPT }],
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new NotFoundException(`Session ${id} not found`);
    return s;
  }

  listSessions(): Session[] {
    return [...this.sessions.values()];
  }

  deleteSession(id: string): { deleted: boolean } {
    const ok = this.sessions.delete(id);
    if (!ok) throw new NotFoundException(`Session ${id} not found`);
    return { deleted: true };
  }

  /* ------------------------------------------------------------------ *
   * Public turn entry points
   * ------------------------------------------------------------------ */

  /** Stateless single-turn answer (optionally with prior message history). */
  async runTurn(opts: { message: string; history?: string[]; model?: string; maxSteps?: number }): Promise<{
    answer: string;
    model: string;
    steps: number;
  }> {
    const spec = resolveModel(opts.model ?? this.defaultModelId);
    const messages: ChatMessage[] = [
      { role: 'system', content: DEFAULT_SYSTEM_PROMPT },
      ...(opts.history ?? []).map((h) => ({ role: 'user' as const, content: h })),
      { role: 'user', content: opts.message },
    ];
    const { answer, steps } = await this.runLoop(messages, spec, opts.maxSteps ?? 10);
    return { answer, model: spec.id, steps };
  }

  /** Append a user message to a session, run the loop, return the final text. */
  async converse(sessionId: string, message: string, model?: string): Promise<{ answer: string; steps: number }> {
    const session = this.getSession(sessionId);
    const spec = resolveModel(model ?? session.model);
    session.model = spec.id;
    session.messages.push({ role: 'user', content: message });
    const { answer, steps, messages } = await this.runLoop(session.messages, spec, 10);
    session.messages = messages;
    return { answer, steps };
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
  ): Promise<{ answer: string; steps: number; messages: ChatMessage[] }> {
    let steps = 0;
    let lastAnswer = '';

    for (; steps < maxSteps; steps++) {
      let completion;
      try {
        completion = await this.callModel(messages, spec);
      } catch (err) {
        const fb = fallbackFor(spec);
        if (!fb) throw err;
        this.logger.warn(
          `Primary model ${spec.id} failed (${(err as Error).message}); falling back to ${fb.id}`,
        );
        completion = await this.callModel(messages, fb);
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

    return { answer: lastAnswer, steps, messages };
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
  ): Promise<{ content: string | null; tool_calls?: ToolCallRequest[] }> {
    const body: Record<string, unknown> = {
      model: spec.provider_model,
      messages,
      temperature: spec.reasoning ? undefined : 0.2,
      max_tokens: 8192,
    };
    const apiTools = this.toApiTools();
    if (apiTools.length > 0) body.tools = apiTools;
    if (spec.reasoning) delete body.temperature;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.llmTimeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
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

  private async executeTool(call: ToolCallRequest): Promise<string> {
    const tool = this.tools.get(call.name);
    if (!tool) return JSON.stringify({ error: `Unknown tool: ${call.name}` });

    let args: Record<string, unknown> = {};
    try {
      args = call.arguments ? JSON.parse(call.arguments) : {};
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
