# REQUIREMENTS — Agent Workspaces (public project folders + per-agent folders)

Status: DRAFT (awaiting codex implementation)
Scope: backend only. Frontend wiring is a follow-up.

## Objective

Extend the existing FMCC **base agent** (`backend/src/agent/`) so that **each
named agent gets its own working folder**, alongside a set of shared **public
project folders**. Agents operate inside an isolated, per-agent filesystem
workspace with scoped file tools; no agent can touch files outside its own root.

This mirrors the reference repos:
- `reference/hermes-agent/agent/runtime_cwd.py` — single pinned working dir per
  agent, one source of truth for where the agent "lives".
- `reference/hermes-agent/agent/context_references.py` — file/folder tools that
  resolve paths relative to an allowed root and guard against traversal
  (`_resolve_path(cwd, target, allowed_root=_ALLOWED_ROOT)`).
- `reference/pi/packages/agent` — agent-owns-a-workspace pattern.

## Decided design (per user clarification)

1. **Multiple public project folders** — a fixed root directory containing N
   shared project folders that any agent may read.
2. **Per-agent named folders** — each *named agent* (e.g. `coder`,
   `researcher`) has its **own** fixed working folder, writable only by that
   agent.
3. **No per-session folders.** Session state is separate and stays in-memory
   (as today); only the agent-level working directories are materialized on
   disk.

## Layout (on the backend host filesystem)

```
<WORKSPACE_ROOT=/data/workspaces>          # configurable via AGENT_WORKSPACE_ROOT
├── projects/                              # PUBLIC project folders (shared)
│   ├── <projectA>/
│   └── <projectB>/
└── agents/                                # PER-AGENT folders (isolated)
    ├── coder/
    │   ├── work/                          # coder's writable working folder
    │   └── notes -> (optional)
    └── researcher/
        └── work/
```

Env var: `AGENT_WORKSPACE_ROOT` (default `/data/workspaces`). Inside the Docker
container this must be a volume-mounted path so folders persist across
container restarts.

## Core service: `WorkspaceService`

New file: `backend/src/agent/workspace.service.ts`

Responsibilities:
- Resolve the workspace root from `AGENT_WORKSPACE_ROOT` (fallback
  `/data/workspaces`).
- `getProjectRoot()` → path to `projects/`; list public project folders.
- `createPublicProject(name)` → `projects/<name>/` (sanitize the name:
  alphanumeric + `-`/`_` only).
- `getAgentRoot(agentName)` / `getAgentWorkDir(agentName)` → `agents/<name>/`
  (or `agents/<name>/work`).
- `ensureAgentFolder(name)` → create on demand if missing.
- **Path-traversal guard**: a `safeResolve(root, relPath)` helper that
  resolves `root/relPath` and asserts the result stays inside `root`
  (rejects `..`, absolute escapes, symlink escapes). Mirror `context_references._resolve_path`.

Named-agent registry — a small static map, e.g.:

```ts
const NAMED_AGENTS = [
  { name: 'coder',      label: 'Coder',      description: 'Writes code in its own folder.' },
  { name: 'researcher', label: 'Researcher', description: 'Reads public projects, writes notes in its own folder.' },
];
```

## Scoped file tools (registered on the base agent)

Register tools on `BaseAgentService` (its `registerTool` registry already
exists; the tool-loop `executeTool` already dispatches by name). Each tool
resolves paths via `WorkspaceService.safeResolve` against the **calling
agent's** root.

Tool names (snake_case, must be unique & descriptive for the model):

1. `list_workspace` — args `{ agent: string, path: string }` → JSON tree of the
   agent's own folder (`agents/<agent>/...`) or a public project
   (`projects/<name>`). Guards against escaping the selected root.
2. `read_workspace_file` — args `{ kind: 'project'|'agent', name: string,
   path: string }` → file contents (size-capped, e.g. 100KB). `kind='project'`
   resolves under `projects/<name>`, `kind='agent'` under `agents/<name>`.
3. `write_workspace_file` — args `{ name: string, path: string, content: string
   }` → write into `agents/<name>/` (agent's **own** folder only; never allow
   writing into public `projects/` from here). Creates parent dirs.

Each tool result is a JSON string so the loop's `executeTool` returns it
correctly (`executeTool` already stringifies non-string tool results).

> Note: because the base agent today is single-session and has no "active
> agent" concept, tools take an explicit `agent`/`name` arg (the named-agent
> id). The tool layer validates the name against the registry.

## Controller endpoints (extend `agent.controller.ts`)

- `GET  /api/agent/workspaces` — workspace root info + list of public projects
  + list of named agents (each with its folder path).
- `POST /api/agent/workspaces/projects` — body `{ name }` → create a public
  project folder.
- `POST /api/agent/workspaces/agents` — body `{ name }` → ensure a named agent
  folder exists.
- `GET  /api/agent/workspaces/projects/:name` — list contents of a public
  project.
- `GET  /api/agent/workspaces/agents/:name` — list contents of a named agent's
  folder.

Use `ParseUUIDPipe`-style sanitization / validation for `:name` (alphanumeric +
`-`/`_`).

## Security / safety invariants (must not be violated)

- **Never** write outside the workspace root. `safeResolve` is the single
  enforcement point; if a resolved path escapes its root → throw / return
  `{ error: 'path outside allowed root' }`.
- Public `projects/` folders are **read-only from tools** — only the
  `POST /api/agent/workspaces/projects` endpoint may create them.
- Agent folders are writable **by their own agent only**. A tool call with
  `name` that doesn't match a registered agent → error.
- No env secrets, tokens, or credentials are read/printed/written by these
  tools or endpoints.
- Do NOT modify the model catalog, the session loop semantics, or the LLM
  transport in `base-agent.service.ts` beyond registering new tools.

## Files changed (expected)

- `backend/src/agent/workspace.service.ts` — NEW
- `backend/src/agent/workspace-tools.ts` — NEW (tool factory: build `BaseTool[]`
  for the three tools, injected with `WorkspaceService`)
- `backend/src/agent/agent.module.ts` — provide/export `WorkspaceService`; wire
  tools onto `BaseAgentService`
- `backend/src/agent/agent.controller.ts` — add the workspace endpoints
- `backend/src/agent/agent.dto.ts` — DTOs for create-project / create-agent
- `docker-compose.yml` — add `AGENT_WORKSPACE_ROOT` env + a named volume for
  `/data/workspaces`

## Verification (codex should run, then Hermes re-runs)

1. `cd backend && npm run build` → exit 0.
2. Unit/type check passes.
3. Controller smoke test (after Hermes redeploy): create a project, ensure an
   agent folder, list both.
4. Tool-level check: call `write_workspace_file` then `read_workspace_file` for
   the same agent; confirm `safeResolve` rejects `../../etc/passwd`.

## Out of scope (this task)

- Frontend UI for workspaces.
- Persisting agent/session state to the DB.
- Running actual external commands/terminal in the workspace.
