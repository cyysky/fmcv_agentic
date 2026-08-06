# FMCV Agentic

Full-stack agent workspace: manage OpenAI-compatible model endpoints, chat with
built-in agents (`coder`, `researcher`), share files through project folders,
and coordinate multi-agent teams in Slack-style channels.

- **Frontend** — Next.js 16 (React 19, TypeScript) on port 3333: home,
  `/settings` (connection management) and `/agent` (chat, workspaces, channels).
- **Backend** — NestJS 11 (TypeScript) on port 5555: REST API under `/api`,
  global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`).
- **Database** — PostgreSQL 16 via Docker Compose (port 5432), Prisma ORM 7
  with the Postgres driver adapter.

## Stack

| Layer      | Tech                                                     | Port | Notes                                        |
|------------|----------------------------------------------------------|------|----------------------------------------------|
| Frontend   | Next.js 16 (React 19, TypeScript)                        | 3333 | App Router; `/settings` + `/agent` UI        |
| Backend    | NestJS 11 (TypeScript)                                   | 5555 | REST under `/api`; SSE streaming for jobs    |
| Database   | PostgreSQL 16 (Docker)                                   | 5432 | Reachable from services + host tooling       |
| ORM        | Prisma 7 (`@prisma/client` + `@prisma/adapter-pg`)       | —    | Driver-adapter based                         |

## Features

- **Connections CRUD** — add/list/update/delete OpenAI-compatible API
  connections (display name, base URL, model, context length, concurrent
  connections, optional key).
- **Agent chat (`/agent`)** — stateless turns plus persistent sessions; model
  picker (`ds4-flash` default, `qwen3.6-35b`), conversation loop with a hard
  `maxSteps` cap, tool-call trace and workspace viewer in the UI.
- **Agent workspaces** — filesystem workspace under `AGENT_WORKSPACE_ROOT`
  (Docker default `/data/workspaces`): named agent folders (`coder`,
  `researcher`) and shared project folders; agents get file read/write/list
  tools plus connection-credentials lookup.
- **Channels (`/agent` → Channels tab)** — Slack-style channels with agent
  members, streaming jobs (SSE), subchannels/threads, human interjections, and
  a per-member debug pane (event stream, steps, answer/error).
- **Settings UI (`/settings`)** — full CRUD for connections.

## REST API

Connections:

| Method | Path                   | Purpose       |
|--------|------------------------|---------------|
| POST   | `/api/connections`     | create        |
| GET    | `/api/connections`     | list          |
| GET    | `/api/connections/:id` | get one       |
| PATCH  | `/api/connections/:id` | update        |
| DELETE | `/api/connections/:id` | delete        |

Agent:

| Method | Path                                   | Purpose                                     |
|--------|----------------------------------------|---------------------------------------------|
| POST   | `/api/agent/turn`                      | stateless single-turn answer (`maxSteps`)   |
| POST   | `/api/agent/sessions`                  | create a session                            |
| GET    | `/api/agent/sessions`                  | list sessions                               |
| GET    | `/api/agent/sessions/:id`              | read one session                            |
| POST   | `/api/agent/sessions/:id/converse`     | append message + run loop (`maxSteps` 1–20) |
| DELETE | `/api/agent/sessions/:id`              | drop a session                              |
| GET    | `/api/agent/models`                    | model catalog for the picker                |
| GET    | `/api/agent/defaults`                  | provider / default-model info               |
| GET    | `/api/agent/workspaces`                | workspace info                              |
| POST   | `/api/agent/workspaces/projects`       | create public project folder                |
| POST   | `/api/agent/workspaces/agents`         | ensure agent folder exists                  |
| GET    | `/api/agent/workspaces/projects/:name` | list project content                        |
| GET    | `/api/agent/workspaces/agents/:name`   | list agent folder content                   |

Channels:

| Method | Path                                          | Purpose                                     |
|--------|-----------------------------------------------|---------------------------------------------|
| GET    | `/api/channels`                               | list channels                               |
| POST   | `/api/channels`                               | create channel (+ project folder)           |
| GET    | `/api/channels/:id`                           | detail (members, messages, tree)            |
| DELETE | `/api/channels/:id`                           | remove channel (stops its running jobs)     |
| POST   | `/api/channels/:id/members`                   | add an agent member                         |
| DELETE | `/api/channels/:id/members/:agentName`        | remove a member                             |
| GET    | `/api/channels/:id/member-status`             | per-member last job status / debug data     |
| GET    | `/api/channels/:id/messages`                  | message feed                                |
| POST   | `/api/channels/:id/messages`                  | post a message (auto-starts agent reply)    |
| POST   | `/api/channels/:id/turn`                      | an agent works in the channel               |
| POST   | `/api/channels/:id/jobs`                      | start a streaming channel job               |
| GET    | `/api/channels/:id/jobs/:jobId`               | poll a running job                          |
| POST   | `/api/channels/:id/jobs/:jobId/interject`     | interject user text into a job              |

Input validation is enforced at the boundary via `class-validator`; unknown
agents are rejected with a message listing the valid names (`coder`,
`researcher`).

## Testing

```sh
# Unit tests (backend, no external services)
cd backend && npm test -- --runInBand

# API E2E against real Postgres (docker compose up -d db first)
cd backend && npm run test:e2e

# Browser E2E via Chrome DevTools Protocol (Chrome must run with
# --remote-debugging-port=9222; see e2e/README.md)
cd e2e && node browser-e2e.mjs
```

- **Unit: 41 tests / 7 suites** — model catalog, workspace service + tools,
  channel service, job service (incl. restart recovery + persistence),
  base-agent loop (incl. abort and `maxSteps`).
- **API E2E: 45 tests / 4 suites** (`backend/test/*.e2e-spec.ts`) — real
  Postgres via `e2e-setup.ts` (temp workspace root): app health, connections,
  agent sessions/turns, channel lifecycle + streaming jobs (including that
  deleting a channel stops its running jobs, job history persists to
  `channel_runs`, and channel delete cascade-prunes run history).
- **Browser E2E** (`e2e/browser-e2e.mjs`) — zero npm dependencies; opens a
  fresh tab per check (no reuse of busy/stale tabs), verifies `/`, `/settings`,
  `/agent` render their content and document titles with no console/network
  errors, then drives a live channel create → post → agent answer journey with
  screenshots, and deletes the channel it created (a clean `[error]` terminal
  is accepted; only stuck runs / console / network failures gate the run).
  Per-step timeouts + a global watchdog bound the run and all created tabs are
  closed even on failure. Artifacts land in `e2e/screenshots/` and
  `e2e/report.json`.

## Progress (from git history)

### `cf5b6e6` — Initial setup
- Next.js frontend + NestJS backend scaffolded, wired with Docker Compose;
  basic hello world on both.

### `f96b49a` — Ignore reference repos
- Added `reference/` to `.gitignore`.

### `fb0f2f8` — Connections CRUD with Prisma/Postgres
- NestJS `connections` module, global ValidationPipe, `/api` prefix, Postgres
  persistence with Prisma (driver adapter), `/settings` management UI.

### `33633d4` → `2a2469f` — Base agent + workspaces
- Base-agent service with model catalog (`ds4-flash` default, `qwen3.6-35b`),
  sessions, stateless turns, tool loop.
- Filesystem workspaces: named agent folders + shared projects + connection
  credentials tool.

### `f95d243` → `a75e3d6` — Agent UI, tool-call trace, channels
- `/agent` chat UI, tool-call trace + workspace viewer.
- Slack-style channels: streaming jobs (SSE), members, message feeds,
  subchannels/threads, interjections.

### `c46b7dd` → `1e0af2b` — Round hardening (this round's fixes)
- `maxSteps` on session converse (1–20, caps the agent loop).
- Exactly one `stopped` event when a channel job stops.
- Workspace listings work without an `agent` argument.
- Unknown agents rejected with valid-name hints; stray slug dashes trimmed;
  removal of non-member agents rejected.

### `54af105` → `7ce4ced` — Round test coverage + browser E2E
- Unit suites for models, workspaces, tools, channels, jobs, and the agent loop.
- Real-Postgres API E2E suites (agent, channels, connections, app).
- CDP browser E2E script driving the agent channel flow (repeatable; committed
  screenshots + report).

## Local development

```bash
# Prerequisites: Docker + Docker Compose
docker compose up --build
```

Then open:

- Frontend UI: http://localhost:3333 (Settings: http://localhost:3333/settings,
  Agent: http://localhost:3333/agent)
- Backend API: http://localhost:5555/api/connections

Stop everything with `docker compose down`.

### Agent environment

- `AGENT_BASE_URL` — OpenAI-compatible LLM gateway (default
  `http://60.51.17.97:9999/v1`).
- `AGENT_DEFAULT_MODEL` — default model id (default `ds4-flash`).
- `AGENT_API_KEY` — optional; when unset the backend reads the key from the
  matching `connections` DB row.
- `AGENT_LLM_STUB=1` — deterministic offline mode: the agent answers with a
  stable `[stub]` echo instead of calling the gateway. The API E2E suite
  defaults to this so it runs hermetically; the browser E2E still uses the
  live model.

### Database & migrations (Prisma)

```bash
cd backend
export DATABASE_URL="postgresql://fmcv:fmcv_dev_password@localhost:5432/fmcv?schema=public"

# After changing prisma/schema.prisma:
npx prisma migrate dev --name <migration_name>   # create + apply
npx prisma generate                              # regen the client
```

Migrations live in `backend/prisma/migrations/`. The Prisma config is at
`backend/prisma.config.ts` (reads `DATABASE_URL` from `backend/.env`).

> **Note on running inside Docker:** Postgres (`db`) is exposed on host port
> 5432 so local Prisma tooling can reach it; other services reach it over the
> compose network via the service name `db`.

## Project layout

```
backend/
  prisma/                # schema.prisma (Connection, Channel, ChannelMember,
                         # ChannelMessage) + migrations
  prisma.config.ts       # Prisma datasource config (DATABASE_URL)
  src/
    main.ts              # bootstrap: /api prefix, ValidationPipe, CORS
    app.module.ts        # wires AgentModule, ConnectionsModule, PrismaModule
    prisma/              # PrismaService (+ driver adapter)
    connections/         # module, service, controller, DTOs
    agent/
      agent.controller.ts     # sessions, turns, workspaces endpoints
      channel.controller.ts   # channels / jobs / members / messages endpoints
      base-agent.service.ts   # tool-loop agent (sessions + stateless turns)
      channel.service.ts      # channel persistence + message feeds
      channel-job.service.ts  # streaming SSE jobs per channel member
      workspace.service.ts    # filesystem workspaces (AGENT_WORKSPACE_ROOT)
      workspace-tools.ts      # agent file/credential tools
      channel-tools.ts        # agent channel tools
      agent.models.ts         # model catalog (ds4-flash, qwen3.6-35b)
  test/                  # API E2E suites + bootstrap/e2e-setup helpers
frontend/
  app/
    page.tsx             # home → links to settings / agent
    settings/            # connections management UI
    agent/               # agent chat, workspaces, channels UI
e2e/
  browser-e2e.mjs        # CDP browser E2E (repeatable, zero-dependency)
  README.md              # how to run the browser E2E
docker-compose.yml       # frontend + backend + db services
```
