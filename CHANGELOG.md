## Round 2026-08-06 — Round 15 · autonomous iteration round 13

### Added
- Dark-mode support via `@media (prefers-color-scheme: dark)` on the settings
  page (cards, inputs, buttons, banners), the agent page (chat bubbles,
  composer, workspace/tree, trace, channel sidebar/conversation/feed, member
  chips, session rows), and the files page (panels, list, breadcrumb, scope
  select, inputs, viewers, badges); the site nav gains keyboard
  focus-visible outlines.
- Browser E2E dark probes: CDP `Emulation.setEmulatedMedia` with
  `prefers-color-scheme: dark` re-checks `/settings`, `/agent`, and `/files`
  (computed card/input/select backgrounds, primary button stays blue, body
  background), plus dark screenshots (`home-dark`, `settings-dark`,
  `agent-dark`, `files-dark`).

### Changed
- Counts unchanged (unit 59/10, API E2E 44/7); frontend `tsc --noEmit` +
  `eslint` clean (`next build` clean in Docker); backend `nest build` clean;
  browser E2E all green (exit 0, zero console/network errors) including the
  four dark probes; screenshots and `e2e/report.json` refreshed.


## Round 2026-08-06 — Round 14 · autonomous iteration round 12

### Added
- Global navigation: sticky top bar on every page (brand + Home/Agent/Files/
  Settings) with active-route highlighting (`aria-current="page"`), rendered
  from the root layout; page heights adjusted so each route accounts for the
  nav (no content underlap or extra scroll).
- Files page UX: the create/edit panel is now a real `<form>` so Enter in the
  name field submits, Create/Save are submit actions with Cancel explicitly a
  non-submit button, and create/save/delete render a dismissible success
  notice (`Created …`, `Saved …`, `Deleted …`) that clears on navigation or
  errors.
- Browser E2E: nav assertions on every route probe (nav present, four links,
  correct active link), a full nav journey that clicks each link and verifies
  URL + title + active state, and files-journey assertions that the success
  notice appears after create and delete.

### Changed
- Counts unchanged (unit 59/10, API E2E 44/7); frontend `tsc --noEmit` +
  `eslint` clean; backend `nest build` clean; browser E2E all green (exit 0,
  zero console/network errors) including the new nav journey; refreshed
  screenshots, new `nav-journey.png`, and updated `e2e/report.json`.

## Round 2026-08-06 — Round 13 · autonomous iteration round 11

### Added
- File manager API: `GET /api/files/list`, `GET /api/files/read`,
  `PUT /api/files/write`, `POST /api/files/mkdir` and
  `DELETE /api/files/delete`, scoped `agent:<name>` (read/write) or
  `project:<name>` (read-only — writes 403). Every path resolves through
  `WorkspaceService.safeResolve`, so `..`, absolute, and symlink escapes are
  rejected (400); lists are one-level entries (name/type/size/mtimeMs,
  directories first), reads cap at 100 KB (413), writes mkdir parents
  recursively, and deletes accept files or empty directories only.
- `/files` frontend page: agent/project scope picker, breadcrumb navigation,
  one-level listing with size + mtime, view/edit, create file/folder,
  delete, dotfile rendering, read-only marking for project scopes, error
  banner, and refresh. Linked from the home page.
- Browser E2E files journey in `e2e/browser-e2e.mjs` (create nested file +
  dotfile via the UI, read content back, delete through the UI, verify
  server-side removal), plus `/files` in the route probes; files screenshots
  + report refreshed.

### Changed
- Unit tests 52 → 59 (10 suites); API E2E 38 → 44 (7 suites, new files
  suite); frontend `tsc --noEmit` + `eslint` clean; browser E2E all green
  (exit 0, zero console/network errors).
- README refresh: Files feature + REST table, updated test counts, `/files`
  route in stack/local-dev docs.

## Round 2026-08-06 — Round 12 · autonomous iteration round 10

## Round 2026-08-06 — Round 12 · autonomous iteration round 10

### Changed
- Looping audit round: verified rounds 7–9 each shipped a tested,
  user-visible improvement, no TODO/FIXME markers remain, and the worktree
  is clean end-to-end. The only deferred item (real user auth, optional by
  design for a local-first single-operator tool) is not an open ticket.
- Exit condition C fired: next focus empty, no open tickets, no obviously
  valuable improvement. Automated loop closed; `round-10` tag is final.

## Round 2026-08-06 — Round 11 · autonomous iteration round 9

### Added
- Global per-IP request throttling on the API: `@nestjs/throttler` wired
  through `ThrottlerModule` + a global `APP_GUARD`, with `RATE_LIMIT_MAX`
  (default 100 req/window; `0` disables) and `RATE_LIMIT_TTL_MS` (default
  60000) read per request, so limits change without a reboot. Over-limit
  bursts get 429 + `Retry-After` and recover after the window.
- Unit + API E2E coverage for throttling (unit 47 → 52; e2e 36 → 38), and
  compose env plumbing for the two rate-limit variables.

### Changed
- README refresh: unit 52/9, API E2E 38/6 (throttle 2), env docs for
  rate limiting.

## Round 2026-08-06 — Round 10 · autonomous iteration round 8

### Added
- Session auto-titles: the backend derives a title from a default-titled
  session's first user message (whitespace collapsed, 40-char snippet with
  `…`), persisted through the same Postgres upsert; later messages do not
  re-title and manual renames win. The frontend refreshes the sidebar list
  after a reply so the derived title appears immediately.
- Unit + API E2E coverage for auto-titling (unit 46 → 47; agent e2e 11 → 12).

### Changed
- Browser E2E sessions journey now gates on the auto-derived title in the
  sidebar after the first reply, in addition to the rename + reload
  persistence gates.
- README refresh: unit 47/8, API E2E 36/5 (agent 12), browser E2E description
  covers the auto-title step.

## Round 2026-08-06 — Round 9 · autonomous iteration round 7

### Added
- `PATCH /api/agent/sessions/:id` — rename a session (`{ title }`, trimmed,
  max 120 chars; 400 on blank, 404 on unknown id), persisted to Postgres like
  create/converse.
- Session rename UI: a `✎` button on each sessions-sidebar item opens an
  inline title input (Enter saves, Escape cancels, blur saves) and updates the
  sidebar title in place.

### Changed
- Browser E2E sessions journey now renames the created session through the UI
  and asserts both the message history and the renamed title survive a page
  reload; removed a duplicated `reload-list` step marker from the report.
- README refresh: unit 46/8, API E2E 35/5 (agent 11 incl. rename), browser
  E2E description covers the rename step.

## Round 2026-08-06 — Round 8 · autonomous iteration round 6

### Changed
- Browser E2E prune check no longer needs docker: it verifies channel project
  folders are gone through the backend's `GET /api/agent/workspaces` snapshot
  (still a hard failure when a `browser-e2e-*` folder survives).
- Browser E2E tab cleanup stops echoing the non-fatal CDP
  `Target is closing` text as a warning (`/json/close` returns plain text, not
  JSON); only real close failures log now. End-of-run output is clean.
- README refresh (browser E2E description reflects the docker-free prune
  check + clean tab close).

## Round 2026-08-06 — Round 7 · autonomous iteration round 5

### Added
- Optional bearer-token gate: backend `API_TOKEN` env; when set, all requests
  need `Authorization: Bearer <token>` (constant-time compare, else 401).
  Empty/unset → fail-open so local dev and the browser E2E are unaffected.
- Frontend `apiFetch` in `frontend/lib/api.ts`: reads `NEXT_PUBLIC_API_URL` +
  optional `NEXT_PUBLIC_API_TOKEN` and forwards the bearer header; the agent
  and settings clients now use it.
- Compose/Docker plumbing for `API_TOKEN` / `NEXT_PUBLIC_API_TOKEN` (empty
  defaults) + unit and API E2E coverage for the gate (unit 42 → 45; API E2E
  counting corrected, below).

### Changed
- E2E harness fix: `bootstrapApp` moved from `app.e2e-spec.ts` to
  `test/test-app.ts`. The old import re-registered app's 5 tests inside each
  importing suite (inflated totals: 46/4 suites, then 54/5). Counts now equal
  the declared tests: 34/5 — app 5, connections 4, agent 10, channels 12,
  auth 3 — verified file by file.
- README refresh: unit 45/8, API E2E 34/5 with per-suite breakdown, token env
  vars documented, live-prove instructions added.

## Round 2026-08-06 — Round 6 · autonomous iteration round 4

### Added
- `/agent` Sessions tab: persistent-session sidebar (newest first), New chat,
  open/continue, delete with confirm; the model picker now applies to session
  chats. Responsive stacking under 760px.
- Browser E2E sessions journey (create → live converse → reload → reopen from
  the sidebar → history survives → delete), with per-run created-session
  cleanup via the API.

### Changed
- Browser E2E reload step now waits for the CDP navigation event and React's
  hydration marker before clicking the Sessions tab, removing a flaky race
  where clicks landed pre-hydration and were silently ignored (hardened flow:
  3/3 consecutive green runs).
- README refresh (unit 42 / API E2E 46; browser E2E description covers the
  sessions journey).

## Round 2026-08-06 — Round 5 · autonomous iteration round 3

### Added
- `AGENT_LLM_STUB=1` deterministic offline mode: `BaseAgentService.callModel`
  short-circuits to a stable `[stub] <last user message>` answer (no gateway,
  no API key).

### Changed
- API E2E is now hermetic: `e2e-setup.ts` defaults the stub on, so converse /
  channel suites run without the external model gateway (~9s → ~2.8s); browser
  E2E still exercises the live model.
- Unit + API E2E coverage for stub determinism (unit 41 → 42; API E2E 45 → 46).
- README: new "Agent environment" section (`AGENT_BASE_URL`,
  `AGENT_DEFAULT_MODEL`, `AGENT_API_KEY`, `AGENT_LLM_STUB`).

## Round 2026-08-06 — Round 4 · autonomous iteration round 2

### Added
- `agent_sessions` Postgres table: agent chats persist on create, after every
  completed `converse` loop, and are removed on delete; `OnModuleInit` reloads
  them after a restart (same recovery pattern as `channel_runs`).
- Unit + API E2E coverage for session persistence/recovery/delete (unit
  40 → 41; API E2E 44 → 45).

### Changed
- Browser E2E journey writes its artifact into the agent's own folder
  (`write_own_file` → `round2.md`) instead of the channel project, so channel
  delete fully prunes the channel workspace; the harness now fails on leftover
  `browser-e2e-*` project folders (best-effort docker check).
- Removed the last Round-1 leftover channel project folder; session persistence
  live-proven across a backend container restart.

## Round 2026-08-06 — Round 3 (autonomous iteration round 1)

### Added
- `channel_runs` Postgres table: streaming job history is persisted on create
  and at every terminal state, so member debug panes and job polling survive
  backend restarts.
- Recovery-on-startup: runs still `running` when the process died are marked
  `stopped` with an explicit "restarted" event instead of spinning forever.
- Browser E2E channel cleanup: the flow deletes its own channel via the API
  after the journey and verifies the row is gone.

### Fixed
- Channel deletion race: the delete path now reserves the channel tree before
  stopping jobs; new jobs for a channel mid-delete are rejected instead of
  slipping between stop and row removal.
- Browser E2E gate: a real agent `[error]` terminal is no longer treated as a
  browser failure (checked page console/network errors still fail the run).

### Changed
- Unit 38 → 40 tests (TOCTOU guard, restart recovery, persistence upserts);
  API E2E 43 → 44 tests (real job persisted in `channel_runs`, delete
  cascade-prunes history).
- E2E screenshots + report refreshed; `vision_test.png` ignored.

# Changelog

Git history is the source of truth (`git log`); this file summarizes
behavior-relevant changes per round.

## Round 2026-08-06 — second 8-hour deep-work round

### Added
- API E2E coverage: channel-delete stops running jobs (exactly one `stopped`
  event), plus `maxSteps`/payload-shape validation for POST /api/agent/turn
  without calling the LLM. API E2E now 43 tests / 4 suites.
- Per-page browser document titles via server metadata wrappers:
  `FMCV Agentic` (home), `Settings - FMCV Agentic`, `Agent - FMCV Agentic`.

### Fixed
- Deleting a channel now stops any in-flight agent job for the channel tree
  (including sub-channels) and marks it `stopped` before the rows are removed,
  so workers never keep running against a deleted channel. A stopped job is
  no longer downgraded to `error` when its run later trips over the deletion.
- Empty channel-owned project folders are pruned on channel delete (folders
  still holding artifacts are kept).
- Settings/agent pages no longer show the Next.js starter title, and the
  settings initial-load effect passes React's setState-in-effect lint rule.

### Changed
- CDP browser E2E hardened: each route gets a fresh tab (no silent reuse of
  busy/stale tabs), per-step timeouts + content settle conditions, document
  title assertions, progress logging, a global watchdog, and guaranteed tab
  cleanup on success or failure.
- Frontend lint clean (0 errors, 0 warnings); type-check clean.

## Round 2026-08-05 — first full 8-hour deep-work round

### Added
- Agent system: stateless turns + persistent sessions, model catalog
  (`ds4-flash` default, `qwen3.6-35b`), configurable `maxSteps` cap (1–20).
- Filesystem workspaces with named agent folders (`coder`, `researcher`) and
  shared projects; file tools + connection-credentials tool.
- Slack-style channels: agent members, streaming SSE jobs, subchannels/threads,
  interjections, per-member debug/status pane.
- Agent chat UI at `/agent` with tool-call trace and workspace viewer.
- CDP browser E2E (`e2e/browser-e2e.mjs`) with screenshots + JSON report.
- Unit + real-Postgres API E2E suites (37 unit / 41 API tests).

### Fixed
- Stop path emits exactly one `stopped` event (was duplicated/non-terminal).
- `maxSteps` enforced on session `converse` (1–20 range, rejects out-of-range).
- Workspace project listings work without an `agent` argument.
- Unknown agent names rejected at the API boundary with valid-name hints.
- Channel slugs have stray dashes trimmed; removing a non-member agent is
  rejected instead of silently succeeding.

### Changed
- Postgres persistence extended from `connections` to `channels`,
  `channel_members`, `channel_messages` (Prisma models + migrations).
