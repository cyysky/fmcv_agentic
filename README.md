# FMCV Agentic

Full-stack agent workspace: manage OpenAI-compatible model endpoints, chat with
built-in agents (`coder`, `researcher`), share files through project folders,
and coordinate multi-agent teams in Slack-style channels.

- **Frontend** — Next.js 16 (React 19, TypeScript) on port 3333: home,
  `/settings` (connection management), `/agent` (chat, workspaces, channels)
  and `/files` (file manager).
- **Backend** — NestJS 11 (TypeScript) on port 5555: REST API under `/api`,
  global `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`).
- **Database** — PostgreSQL 16 via Docker Compose (port 5432), Prisma ORM 7
  with the Postgres driver adapter.

## Stack

| Layer      | Tech                                                     | Port | Notes                                        |
|------------|----------------------------------------------------------|------|----------------------------------------------|
| Frontend   | Next.js 16 (React 19, TypeScript)                        | 3333 | App Router; `/settings` + `/agent` + `/files` |
| Backend    | NestJS 11 (TypeScript)                                   | 5555 | REST under `/api`; SSE streaming for jobs    |
| Database   | PostgreSQL 16 (Docker)                                   | 5432 | Reachable from services + host tooling       |
| ORM        | Prisma 7 (`@prisma/client` + `@prisma/adapter-pg`)       | —    | Driver-adapter based                         |

## Features

- **Global navigation** — sticky top bar on every page (`/`, `/agent`,
  `/files`, `/settings`) with active-route highlighting, keyboard
  focus-visible outlines, and client-side transitions; the home page keeps
  its quick-launch CTAs.
- **Dark mode** — settings, agent, files, and the home page add `@media
  (prefers-color-scheme: dark)` palettes (panels, inputs, bubbles, viewers,
  channel UI, landing card) that follow the OS theme with no toggle needed.
- **Responsive layout** — the app is usable down to 320px-wide screens: the
  nav compacts (brand shortens to "FMCV"), header control rows wrap, files
  rows truncate names with ellipsis, and the agent composer stays on-screen.
- **Connections CRUD** — add/list/update/delete OpenAI-compatible API
  connections (display name, base URL, model, context length, concurrent
  connections, optional key). Every row has a **Test** button that probes the
  endpoint live (one-token `chat/completions` with the stored key) and shows a
  graceful pass/fail result with structured HTTP status + latency; the
  create/edit form has its own **Test Connection** button that probes the
  unsaved values before you commit and shows the same metrics, and editing
  replays the row's last-known probe result until a probed value changes.
  Saving values that were never probed auto-runs a probe of the persisted row
  (client-side, best-effort — the save is never blocked by a slow endpoint)
  and reports the result in the success banner. Probe results are persisted
  server-side, so reloading `/settings` still shows a row's known health (`probed HH:MM`
  marker) even after the endpoint goes stale, and failed probes that returned an HTTP
  status still render the metrics line. A **Fetch Models** button hydrates the Models
  textarea from the provider's `GET /models` (stored key, or draft values before save),
  de-duping case-insensitively and capping at 50 ids; dead or invalid endpoints fail
  gracefully with the row/textbox showing the reason. A connection can also carry a
  **Models** list (one provider model id per line) so non-catalog providers
  are first-class in the agent model picker. Editing never replays the
  masked key back over the stored secret, and an explicit "Clear stored API
  key" checkbox lets you remove a secret (stored as NULL, never an empty
  string).
- **Agent chat (`/agent`)** — stateless turns plus a persistent Sessions tab
  (sidebar, continue, delete) backed by Postgres; model picker (`ds4-flash`
  default, `qwen3.6-35b`) plus a **connection picker**: sessions and
  stateless turns can pin a saved Connection from Settings, so that row's
  base URL, model, stored API key, and default parameters drive the LLM
  instead of the built-in gateway. Selecting a connection defers the model
  picker to the connection's model by default, while the connection's own
  **Models** list (set in Settings) and the catalog models remain selectable
  as per-turn overrides that still route through the connection's endpoint +
  key; non-catalog model ids are sent verbatim on the wire. Opening a pinned
  session restores its connection (with the connection default model) and
  badges it in the sidebar. Conversation loop with a hard `maxSteps` cap,
  tool-call trace and workspace viewer in the UI.
- **Agent workspaces** — filesystem workspace under `AGENT_WORKSPACE_ROOT`
  (Docker default `/data/workspaces`): named agent folders (`coder`,
  `researcher`) and shared project folders; agents get file read/write/list
  tools plus connection-credentials lookup.
- **File manager (`/files`)** — human-facing browser over the same
  workspace: pick an agent (read/write) or public project (read-only) scope,
  navigate one level at a time with a breadcrumb, view or download file
  contents (downloads are binary-safe and bypass the viewer cap), create
  files/folders, edit, and delete files or empty folders. Dotfiles are shown,
  path escapes are rejected by the API, the create/edit panel submits from the
  name field (Enter), and every create/save/download/delete action shows a
  dismissible success notice.
- **Channels (`/agent` → Channels tab)** — Slack-style channels with agent
  members, streaming jobs (SSE), subchannels/threads, human interjections, and
  a per-member debug pane (event stream, steps, answer/error).
- **Settings UI (`/settings`)** — full CRUD for connections plus per-row
  live connectivity testing.

## REST API

Connections:

| Method | Path                   | Purpose       |
|--------|------------------------|---------------|
| POST   | `/api/connections`     | create        |
| GET    | `/api/connections`     | list          |
| GET    | `/api/connections/:id` | get one       |
| PATCH  | `/api/connections/:id` | update        |
| DELETE | `/api/connections/:id` | delete        |
| POST   | `/api/connections/:id/test` | live connectivity probe (one-token chat/completions with the stored key) |
| GET    | `/api/connections/:id/models` | fetch provider models via the stored row (GET `{baseUrl}/models`, stored key) |
| POST   | `/api/connections/test`      | same probe against unsaved form values (test before save)               |
| POST   | `/api/connections/models/fetch` | fetch provider models against unsaved form values (draft key)          |

Agent:

| Method | Path                                   | Purpose                                     |
|--------|----------------------------------------|---------------------------------------------|
| POST   | `/api/agent/turn`                      | stateless single-turn answer (`maxSteps`, optional `connectionId`) |
| POST   | `/api/agent/sessions`                  | create a session (optional `connectionId` pins the provider)       |
| GET    | `/api/agent/sessions`                  | list sessions                               |
| GET    | `/api/agent/sessions/:id`              | read one session                            |
| POST   | `/api/agent/sessions/:id/converse`     | append message + run loop (`maxSteps` 1–20, optional `connectionId`) |
| DELETE | `/api/agent/sessions/:id`              | drop a session                              |
| GET    | `/api/agent/models`                    | model catalog for the picker                |
| GET    | `/api/agent/defaults`                  | provider / default-model info               |
| GET    | `/api/agent/workspaces`                | workspace info                              |
| POST   | `/api/agent/workspaces/projects`       | create public project folder                |
| POST   | `/api/agent/workspaces/agents`         | ensure agent folder exists                  |
| GET    | `/api/agent/workspaces/projects/:name` | list project content                        |
| GET    | `/api/agent/workspaces/agents/:name`   | list agent folder content                   |

When an optional `connectionId` (UUID) is supplied, the saved Connection's
base URL, model name, stored API key, default parameters, and model list
replace the built-in gateway + catalog for that call. Without an explicit
`model` the connection's own model wins; an explicit `model` is a per-turn
override — catalog model ids map to their provider model, while any other id
(e.g. a raw model from the connection's stored `models` list) is sent to the
endpoint verbatim, with no catalog fallback. Unknown connection ids are 404s
on create/turn/converse. On sessions the pin persists, so later turns keep
using that provider; if the connection is later deleted, the session
self-heals back to the default gateway.

Files (file manager — `agent:<name>` scopes are read/write, `project:<name>`
scopes are read-only; every path resolves through the workspace anti-traversal
check):

| Method | Path                                  | Purpose                               |
|--------|---------------------------------------|---------------------------------------|
| GET    | `/api/files/list?scope=&path=`        | one-level directory listing (dirs first) |
| GET    | `/api/files/read?scope=&path=`        | read a text file (100 KB viewer cap)  |
| GET    | `/api/files/download?scope=&path=`    | stream a file as an attachment (binary-safe, no cap) |
| PUT    | `/api/files/write?scope=&path=`       | write a file (parents created)        |
| POST   | `/api/files/mkdir?scope=&path=`       | create a directory                    |
| DELETE | `/api/files/delete?scope=&path=`      | delete a file or empty directory      |

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

- **Unit: 84 tests / 11 suites** — model catalog, workspace service + tools,
  channel service, job service (incl. restart recovery + persistence),
  base-agent loop (incl. abort and `maxSteps`), API token guard, session
  rename + auto-title, request-throttle guard, the file manager service
  (list/read/download/write/mkdir/delete, directory-first ordering,
  `..`/absolute/symlink escapes rejected, project scopes read-only, 100 KB
  read cap, download resolver rejects directories / empty paths / missing
  files), and the connection-test probes (reachable 200, upstream 401,
  network failure, abort/timeout, unknown id 404; draft values tested without
  touching the DB, trailing-slash normalization, no-auth-header omission) plus
  apiKey normalization (empty-string clears to NULL on create and update),
  per-connection `models` normalization (trim/dedupe/blanks on create, empty
  array clears on update, absent key leaves the list untouched), and
  connection-pinned agent calls (session pin persists through DB persistence,
  unknown connection 404 on create/turn, converse resolves the row's
  baseUrl/model/key/default-parameters, a deleted pinned connection
  self-heals to the default endpoint, attaching a connection to an existing
  session via converse, explicit catalog-model overrides through a connection
  on both turns and sessions, and a non-catalog model id used verbatim on the
  wire + stored verbatim on the session).
- **API E2E: 58 tests / 7 suites** (`backend/test/*.e2e-spec.ts`) — real
  Postgres via `e2e-setup.ts` (temp workspace root) + shared bootstrap in
  `test/test-app.ts`: app health (5), connections CRUD + live probes (15:
  CRUD round-trip, masked key, validation 400s, explicit empty-string clears
  the stored key to NULL server-side, model-list normalization/replace/clear,
  malformed model-list 400s, probe OK through a hermetic fake upstream that
  asserts the stored bearer key, 401 reporting, unreachable endpoint graceful
  failure, unknown id 404, draft endpoint success/401/unreachable/validation
  against entered values without persisting a row), agent
  sessions/turns/rename/auto-title + saved-connection pinning (12: pin
  persists on create/converse, attach via converse, stateless turn with the
  connection, explicit catalog-model override via turn/converse, a raw
  provider model id used verbatim and reported back, unknown connection 404
  on create/turn/converse, malformed id 400), channel lifecycle + streaming
  jobs (12), files manager (9: CRUD round-trip, directory-first ordering,
  empty-dir delete + file delete, path-escape 400, project-scope 403, scope
  validation, text download headers/body, binary download byte-for-byte,
  directory/escape download 400), the API token gate (3), and throttling
  (2: over-limit 429 then window recovery). Deleting a channel stops its running
  jobs, job history persists to `channel_runs`, and channel delete
  cascade-prunes run history. Each suite's count equals its declared tests
  (verified per file).
- **Browser E2E** (`e2e/browser-e2e.mjs`) — zero npm dependencies; opens a
  fresh tab per check (no reuse of busy/stale tabs), verifies `/`, `/settings`,
  `/agent`, `/files` render their content and document titles with no
  console/network errors, asserts the global nav on each route (links present,
  correct active link), re-runs `/settings`, `/agent`, and `/files` with CDP
  `prefers-color-scheme: dark` emulation and asserts the dark computed styles
  (card/input/select backgrounds, primary button still blue, body background),
  re-probes all four routes at 360×640 device metrics asserting no horizontal
  overflow, fit nav links, a visible agent composer, and the files responsive
  row grid,
  and drives a nav journey that clicks through every route
  verifying URL, title and active state, then runs live journeys: a channel create → post →
  agent answer → delete, a sessions create → live converse → auto-title in the
  sidebar → rename via the UI → page reload → reopen →
  history-and-new-title-survive → delete, then a saved-connection journey
  that starts a hermetic fake OpenAI-compatible upstream (ephemeral port),
  creates a fixture Connection via the API, selects it in the agent header,
  and proves the connection drives the chat: the model picker defers to the
  connection's model, the wire converse POST carries `connectionId` and no
  `model`, the fake upstream receives `/chat/completions` with the
  connection's model + stored bearer key, its reply renders in the thread,
  the sidebar badges the pinned session, and the server-side row records
  `connectionId`; the journey then picks a catalog model while the
  connection stays active and proves the same upstream receives that override
  model with the connection's key (wire POST carries both `connectionId` and
  `model`, and the override is stored on the session server-side) — then the
  fixture + upstream are cleaned up, a files journey that creates a
  nested file + dotfile through the `/files` UI, reads the content back,
  downloads the created file (asserts the attachment headers on the wire and
  saves it to disk via CDP `Browser.setDownloadBehavior`, comparing the bytes),
  deletes both through the UI, confirms the removal server-side via the
  files API, and asserts the success notice after each create/download/delete,
  and a settings journey that creates a throwaway connection through the API,
  proves the Edit form opens with a blank API-key field, clicks the form's
  "Test Connection" button against a dead endpoint to prove unsaved values are
  probed gracefully and then Cancel preserves the stored URL, captures the wire
  PATCH (`Network.requestWillBeSent`) to prove `apiKey` is never replayed on a
  plain edit, checks "Clear stored API key" and asserts the wire PATCH sends
  `apiKey:""` with a NULL server-side result, clicks the row Test against a
  dead endpoint to assert the graceful inline failure result, then creates a
  second fixture through the form against a hermetic fake upstream and proves
  saving untested values auto-probes the persisted row: the row shows
  `Connected · HTTP 200 · <n> ms`, the success banner reports `Probe:`, the
  fake upstream receives the one-token `chat/completions` with the stored
  bearer key, and reopening Edit replays that probe result into the form until
  a value changes — then both fixtures are deleted and cleanup is verified
  server-side. The sessions step waits for the CDP navigation
  event and React hydration before clicking so it cannot race the dev server;
  hard gates are stuck runs, missing persisted history, and console/network
  failures. The channel-delete step also proves the channel project folder is
  pruned server-side via the workspace API (no docker dependency), and tab
  cleanup no longer logs the non-fatal CDP `Target is closing` text as a
  warning. Per-step timeouts + a global watchdog bound the run and all created
  tabs are closed even on failure. Artifacts land in `e2e/screenshots/` and
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

### `493a99d` → `ec1c5d7` — File manager (Round 11)
- File manager API (`/api/files/list|read|write|mkdir|delete`) over agent
  (read/write) and project (read-only) scopes; every path goes through the
  workspace anti-traversal check, reads cap at 100 KB, writes mkdir parents,
  and deletes accept files/empty directories only. Unit + API E2E covered.
- `/files` Next.js page: scope picker, breadcrumb navigation, one-level
  listing with size + mtime, view/edit/create/delete, dotfiles rendered, and
  read-only marking for public projects.
- CDP browser E2E files journey (create nested file + dotfile → read back →
  delete via UI → server-side verify) plus `/files` in the route probes;
  screenshots + report refreshed.

### Round 17 — connection testing + credential-safe edits
- `POST /api/connections/:id/test` probes a stored connection live with the
  stored model/key (one-token `chat/completions`, bounded by
  `CONNECTION_TEST_TIMEOUT_MS`) and reports pass/fail with HTTP status and
  latency; unreachable and timed-out endpoints fail gracefully.
- Settings rows get a Test button with an inline, dismissible-by-navigation
  result; editing opens with a blank API-key field (placeholder-only hint) so
  the masked preview can never clobber the stored secret on save, and the
  create/edit success notice now actually renders (a batched-state ordering
  bug had `resetForm()` clearing it before paint).
- Unit 62 → 67, API E2E 47 → 51, frontend lint/tsc clean, browser E2E all
  green including the new settings journey (key-blank on edit, no `apiKey` in
  the wire PATCH, graceful Test result, fixture cleanup).

### Round 18 — test-before-save + explicit key clearing
- `POST /api/connections/test` probes *unsaved* form values (base URL, model,
  entered key) with the same one-token `chat/completions` semantics as the
  stored-row test — validation and reachability are verified before saving,
  and no row is created.
- Settings form "Test Connection" button with an inline `aria-live` result;
  cancelling an edit after a failed probe preserves the stored URL.
- "Clear stored API key" checkbox on Edit: sends `apiKey: ""`, stored as NULL
  (never an empty string) on both create and update; the credential field
  disables with a "will be removed" placeholder while armed.
- Unit 67 → 74 (draft-probe + apiKey-normalization suites), API E2E 51 → 56
  (draft endpoint against a hermetic fake upstream + explicit key-clearing),
  backend `nest build`/`tsc --noEmit` clean, frontend `tsc --noEmit` +
  `eslint` clean, browser E2E all green including the extended settings
  journey (form-test fail → cancel keeps URL → plain-edit PATCH carries no
  key → clear-key PATCH empties the stored secret server-side → row Test).

### Round 19 — agent chat uses saved connections
- `AgentSession.connectionId` (nullable FK, `onDelete: SetNull`) + migration;
  `createSession`, `runTurn`/`POST /api/agent/turn`, and `converse` accept an
  optional UUID `connectionId`. The pinned row's base URL / model / stored
  key / default parameters replace the built-in gateway + catalog for the
  call (the request `model` and the row's default `model`/`messages`/`tools`
  cannot hijack the wire), catalog fallback is disabled for custom endpoints,
  unknown ids are 404s, a session keeps its pin across turns, and a deleted
  connection self-heals the session back to the default gateway.
- Agent chat header gains a "Settings connection" picker (Default gateway or
  `displayName · modelName`); selecting one disables the model picker with a
  tooltip naming the connection's model, new sessions/turns are pinned, the
  open session shows a "Using connection …" note, and the sidebar badges any
  session pinned to a connection.
- Browser E2E sessions journey now proves the full chain against a hermetic
  fake upstream (fixture connection → picker → wire `connectionId` without
  `model` → upstream model/key/message assertions → fixture reply rendered →
  server-side pin → cleanup).
- Unit 74 → 79, API E2E stays 56; backend `nest build` + `tsc --noEmit`
  clean, frontend `tsc --noEmit` + `eslint` clean, browser E2E all green
  (`e2e/report.json` + screenshots refreshed, including
  `agent-sessions-picker.png` / `agent-sessions-connection.png`).

### Round 22 — per-connection model lists
- Connections gain an editable **Models** list (one provider model id per
  line) stored on the row (`models String[]`, migration
  `20260808060737_add_connection_models`); ids are trimmed/deduped
  server-side, an empty list clears the field, and the Settings edit form
  round-trips the list.
- The agent model picker is now first-class for non-catalog providers: with a
  connection selected it shows the connection default, every model in the
  connection's list, and the catalog models. Picking a connection model is a
  per-turn override — `model` + `connectionId` on the wire — and the backend
  treats a non-catalog id as a raw provider model sent verbatim (previously
  `resolveModel` silently fell back to the catalog default for unknown ids),
  storing it verbatim on the session so reopening keeps the user's choice.
- Browser E2E: the sessions journey now proves the connection-model path —
  the fixture row carries a non-catalog model id, it is absent from the
  default-gateway picker, appears only after the connection is selected,
  drives a real turn whose wire model is the raw id with the fixture's bearer
  key, and the process is repeated for the catalog-override path with both
  cleanups verified. New flags: `connListNotCatalog`, `connListOptionSeen`,
  `connListModelSentOnConverse`, `connListUpstreamHit`,
  `connListUpstreamModel`/`AuthOk`, `connListReplySeen` (all gated).
- Unit 80 → 84, API E2E 56 → 58; backend `nest build` + `tsc --noEmit`
  clean, frontend `tsc --noEmit` + `eslint` clean, browser E2E all green
  (`e2e/report.json` + screenshots refreshed; containers rebuilt with the
  migration applied).

### Round 21 — probe metrics + auto-probe after save
- Probe results now carry the full picture in one glance: the backend message
  stays short (`Connected — <model> responded.`) and the settings UI composes
  the structured `HTTP <status> · <latency> ms` line beneath it — in both the
  row test result and the edit form's test result, so latency/status are never
  duplicated in the message text.
- Edit replays the row's last-known probe: opening Edit shows the connection's
  known health until a probed field changes (any change clears it again).
- Saving a connection whose values were never probed auto-probes the persisted
  row client-side after the save lands — the save is never blocked by a slow or
  unreachable endpoint, and the success banner reports `Probe: <summary>` (or a
  graceful `Probe unavailable: <message>`).
- Browser E2E: the settings journey now proves the whole auto-probe path
  against a hermetic fake upstream — form create → saved row shows
  `Connected · HTTP 200 · <n> ms` → banner shows `Probe:` → the upstream
  receives `/chat/completions` with `max_tokens: 1` and the stored bearer key →
  Edit replays the probe → both fixtures are deleted and cleanup is verified.
- Unit stays 80 / 11, API E2E stays 56 / 7; backend `nest build` + `tsc
  --noEmit` clean, frontend `tsc --noEmit` + `eslint` clean, browser E2E all
  green (`e2e/report.json` + screenshots refreshed, including
  `settings-auto-probe.png`).

### Round 20 — catalog model overrides through saved connections
- The agent chat model picker stays usable with a connection selected: its
  default option is the connection's own model ("connection default"),
  catalog models remain selectable, and a chosen catalog model is sent as an
  explicit `model` override alongside `connectionId` — the backend uses that
  model on the wire while still routing through the connection's
  baseUrl/key/default parameters (per-call semantics).
- Backend: `runTurn`/`converse` treat an explicit `model` as an override that
  wins over the pinned connection's `modelName` (connection endpoint/key/
  params unchanged); without an explicit model the connection's modelName is
  the wire model, so Round 19 behavior is untouched.
- Browser E2E: the sessions journey now also proves the override path —
  pick a catalog model with the fixture connection active, assert the wire
  converse POST carries `connectionId` + `model`, the hermetic upstream
  receives the override model with the fixture's bearer key, and the
  override model is persisted server-side (`E2E_CONN_OVERRIDE_MODEL`).
- Unit 79 → 80, API E2E stays 56; backend `nest build` + `tsc --noEmit`
  clean, frontend `tsc --noEmit` + `eslint` clean, browser E2E all green
  (`e2e/report.json` + screenshots refreshed).

## Local development

```bash
# Prerequisites: Docker + Docker Compose
docker compose up --build
```

Then open:

- Frontend UI: http://localhost:3333 (Settings: http://localhost:3333/settings,
  Agent: http://localhost:3333/agent, Files: http://localhost:3333/files)
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
- `API_TOKEN` — optional bearer-token gate. Set to require
  `Authorization: Bearer <token>` on every API request (401 otherwise);
  empty/unset keeps the API fully open for local dev.
- `NEXT_PUBLIC_API_TOKEN` — optional frontend build-time token; forwarded as
  the bearer header by `frontend/lib/api.ts` when `API_TOKEN` is set on the
  backend. It ships in browser JS, so treat it as access gating, not a secret.
- `RATE_LIMIT_MAX` — max requests per window per client IP (default 100);
  set `0` to disable throttling entirely. Over-limit bursts get 429 with
  `Retry-After` and recover once the window elapses.
- `RATE_LIMIT_TTL_MS` — throttling window length in milliseconds (default
  60000). Both variables are read per request, so they take effect without a
  backend restart.
- `CONNECTION_TEST_TIMEOUT_MS` — socket/TTL timeout for the connection-test
  probe in milliseconds (default 8000); over-limit probes return a graceful
  "timed out" result instead of hanging the settings page.

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

## References

The `reference/` directory holds local clones of open-source agent projects
kept for study/reference. It is gitignored, so these folders exist only in
local checkouts. If any referenced repo is missing locally or not up to date,
clone or pull it into `reference/` (e.g. `git clone <upstream> reference/<name>`
or `git -C reference/<name> pull --ff-only`), then re-verify the local folder
matches the upstream.

| Name | Folder | Upstream | What it demonstrates |
|------|--------|----------|----------------------|
| PageIndex | [reference/PageIndex](reference/PageIndex) | [VectifyAI/PageIndex](https://github.com/VectifyAI/PageIndex) | Reasoning-based RAG with tree indexing. |
| turbovec | [reference/turbovec](reference/turbovec) | [RyanCodrai/turbovec](https://github.com/RyanCodrai/turbovec) | Rust ANN index library, used by embedder-py. |
| Hermes Agent | [reference/hermes-agent](reference/hermes-agent) | [NousResearch/hermes-agent](https://github.com/nousresearch/hermes-agent) | Nous Research agent CLI; pi / hermes design source; self-improving agent with a built-in learning loop, autonomous skill creation, and a multi-platform gateway (CLI/TUI, Telegram, Slack, ...). |
| Pi | [reference/pi](reference/pi) | [earendil-works/pi](https://github.com/earendil-works/pi) | The agent runtime that inspired round 48ci. |
| Prime Agent | [reference/prime-agent](reference/prime-agent) | [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent) | TypeScript agent harness; RL infra reference (persistent Python control environment, recursive subagents, durable harness state). |
| jcode | [reference/jcode](reference/jcode) | [1jehuang/jcode](https://github.com/1jehuang/jcode) | CLI coding agent, Anthropic-API compatible. |
