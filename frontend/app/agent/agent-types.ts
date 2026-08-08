/**
 * agent-types.ts — shared types for the agent page (chat + sessions + channels).
 * Extracted in Round 93 so the lazy agent views can import them without
 * pulling the whole agent client into their chunks.
 */

export interface ModelOption {
  id: string;
  label: string;
  description: string;
  is_default: boolean;
}

export interface ConnectionOption {
  id: string;
  displayName: string;
  baseUrl: string;
  modelName: string;
  contextLength: number;
  models?: string[];
}

export interface ToolTraceStep {
  type: "tool_call";
  name: string;
  arguments: string;
  result: string;
}

export interface TurnResponse {
  answer: string;
  model: string;
  steps: number;
  trace?: ToolTraceStep[];
}

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  error?: boolean;
  trace?: ToolTraceStep[];
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  model: string;
  connectionId?: string;
  createdAt: string;
}

export interface AgentSessionMessage {
  role: string;
  content: string;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

export type ChannelJobEvent =
  | { type: "tool_call"; ts: string; name?: string; arguments?: string;
      result?: string; step?: number }
  | { type: "interject"; ts: string; text?: string; step?: number }
  | { type: "answer";   ts: string; text?: string }
  | { type: "status";   ts: string; text?: string }
  | { type: "error";    ts: string; text?: string }
  | { type: "stopped";  ts: string; text?: string };

export interface ChannelJobResponse {
  jobId: string;
  status: "running" | "done" | "error" | "stopped";
  events: ChannelJobEvent[];
  answer?: string;
  steps?: number;
  error?: string;
}

/** Per-member debugging status returned by GET /channels/:id/member-status. */
export interface MemberStatus {
  agentName: string;
  hasRun: boolean;
  status: "running" | "done" | "error" | "stopped" | null;
  answer: string | null;
  steps: number | null;
  error: string | null;
  events: ChannelJobEvent[];
  startedAt: string | null;
}

/* ------------------------- workspace viewer types ------------------------ */

export interface AgentEntry {
  name: string;
  label: string;
  description: string;
  root: string;
  workDir: string;
}

export interface ProjectEntry {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  root: string;
  projectsDir: string;
  projects: ProjectEntry[];
  agents: AgentEntry[];
}

/** Recursive tree of a single directory listing, in {"name": {…} | null} form. */
export type DirNode = { [name: string]: DirNode | null };

/* --------------------------- channels types ------------------------------ */

export interface ChannelSummary {
  id: string;
  slug: string;
  name: string;
  projectName: string | null;
  parentId: string | null;
  agentName: string | null;
  memberCount: number;
  createdAt: string;
}

export interface ChannelMessage {
  id: string;
  role: "system" | "user" | "agent";
  author: string;
  text: string;
  toolCalls?: unknown;
  createdAt: string;
}

export interface ChannelDetail extends ChannelSummary {
  members: string[];
  messages: ChannelMessage[];
  projectTree: Record<string, unknown>;
}
