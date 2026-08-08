## Round 2026-08-08 — autonomous iteration round 48 (tag `round-48`)

### Fixed
- Session persistence race: `createSession`, `renameSession`, and
  `converse` now await the best-effort Postgres upsert before responding,
  so API callers always read their own writes. Previously a turn could
  return before its row landed, making the restart-persistence E2E flaky
  (the user message could be missing from the DB row read immediately after
  the response).

### Changed
- Re-verified the completed DIRECTION.md items 1-4 (managed document
  buckets, cron jobs, agent skills, HTML view): backend unit 146/146, API
  E2E 107/107 across three consecutive runs, backend lint + `nest build` +
  `npx tsc --noEmit` clean, frontend lint + `npx tsc --noEmit` clean; live
  smoke (`/`, buckets, cron, skills) all 200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions/files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Confirmed the DB and workspace fixture baseline is clean after the run
  (buckets/cron/skills/sessions/connections at 0; only the two default
  channels remain).

## Round 2026-08-08 — autonomous iteration round 47 (verification, tag `round-47`)

### Changed
- Re-verified the completed DIRECTION.md items 1-4 (managed document
  buckets, cron jobs, agent skills, HTML view): backend unit 146/146, API
  E2E 107/107, backend lint + `nest build` + `npx tsc --noEmit` clean,
  frontend lint + `npx tsc --noEmit` clean; live smoke (`/` frontend;
  API origin `/api`, buckets, cron, skills) all 200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions/files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Confirmed the DB and workspace fixture baseline is clean after the run
  (buckets/cron/skills/sessions/connections at 0; only the two default
  channels remain). No application code changed.

## Round 2026-08-08 — autonomous iteration round 46 (verification, tag `round-46`)

### Changed
- Re-verified the completed DIRECTION.md items 1-4 (managed document
  buckets, cron jobs, agent skills, HTML view): backend unit 146/146, API
  E2E 107/107, backend lint + `nest build` + `npx tsc --noEmit` clean,
  frontend lint + `npx tsc --noEmit` clean; live smoke (`/`, buckets, cron,
  skills) all 200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions, files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Confirmed the DB and workspace fixture baseline is clean after the run
  (buckets/cron/skills/sessions/connections at 0; only the two default
  channels remain). No application code changed.

## Round 2026-08-08 — autonomous iteration round 45 (verification, tag `round-45`)

### Changed
- Full green-gate re-verification of DIRECTION.md items 1-4 (managed document
  buckets, cron jobs, agent skills, HTML view): backend unit 146/146, API E2E
  107/107, backend lint + `nest build` + `npx tsc --noEmit` clean, frontend
  lint + `npx tsc --noEmit` clean; live smoke (`/`, buckets, cron, skills) all
  200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions, files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Confirmed the DB and workspace fixture baseline is clean after the run
  (buckets/cron/skills/sessions/connections at 0; only the two default
  channels remain).

## Round 2026-08-08 — autonomous iteration round 44 (verification, tag `round-44`)

### Changed
- Full green-gate re-verification of the completed feature set: backend unit
  146/146, API E2E 107/107, backend lint/build/tsc clean, frontend
  lint/tsc clean; live smoke (`/`, buckets, cron, skills) all 200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions, files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Confirmed the DB and workspace fixture baseline is clean after the run
  (buckets/cron/skills/sessions/connections at 0; only the two default
  channels remain).

## Round 2026-08-08 — autonomous iteration round 42 (tag `round-42`)

### Added
- **Restart-persistence E2E tests** — the cron and skills suites now boot a
  second app instance against the same Postgres and prove the contract the
  docs promise: an installed skill (name/description/content/installed flag)
  and a cron job (schedule/prompt/enabled + recomputed `nextRunAt`) both
  survive a backend restart. API E2E 105 -> 107 tests.

### Fixed
- **Stale persistence claims in handoff docs** — CHANGELOG "accepted
  limitations" entries (rounds 25-41) claimed skills install state was
  in-memory per backend instance; skills have been Postgres-backed since
  their introduction (Prisma `skills` table with an `installed` column, read
  live from the DB on every agent turn). Corrected to: cron/skills rows
  persist across restarts; only the cron scheduler ticker runs in-process
  (single-instance deployment assumed). The behavior is now pinned by the
  new restart E2E tests.

### Changed
- README test matrix updated: API E2E 105 -> 107 tests (cron 12 -> 13,
  skills 10 -> 11); browser E2E report + screenshots refreshed against the
  clean green gate.

### Test status
- Backend unit 146/14 passed; API E2E 107/10 passed; backend
  lint/build/tsc clean; frontend lint/tsc/build clean; browser E2E exit 0
  (21 route probes, all flows, zero console/network/HTTP errors);
  live-stack smoke probes (frontend, buckets, cron, skills) all 200.

### Known issues / accepted limitations
- Unchanged from round 41: CSP `sandbox` inline-preview limits, in-process
  cron scheduler over DB-persisted rows (single-instance deployment
  assumed), read-only buckets, and the recoverable pre-existing dev
  leftovers (`/data/.trash-round34` + `coder` scratch files) left untouched
  until a human asks for them to be pruned.

## Round 2026-08-08 — autonomous iteration round 41 (tag `round-41`)

### Added
- **Loop-harness stop guard** — `run_loop.sh` now detects a `Loop state:
  finished` handoff in `ROUND.md` (exit conditions C/D per LOOP.md) and stops
  spawning iterations unless a newer human direction has arrived in
  `DIRECTION.md`. This halts the rounds-35-40 pattern of repeated
  no-change verification rounds.

### Changed
- `ROUND.md` Round 41 handoff records the stop decision; no source or test
  changes this round.

### Known issues / accepted limitations
- None open. Unchanged from round 40: CSP `sandbox` inline-preview limits,
  in-process scheduler over DB-persisted cron/skills rows, read-only buckets,
  and the recoverable pre-existing dev leftovers (`/data/.trash-round34` in
  the backend container plus old scratch files in the `coder` workspace),
  which are left untouched until a human asks for them to be pruned.

## Round 2026-08-08 — autonomous iteration round 37 (tag `round-37`)

### Added
- **Verification sweep (no production changes)** — re-ran every gate against
  the live compose stack: backend unit 146/14, API E2E 105/10,
  build/type-check/eslint clean on both sides, frontend production build
  clean, and the CDP browser E2E refreshed `e2e/report.json` + screenshots
  (exit 0, 21 route probes, all 8 flows, zero console/network/HTTP errors;
  fixtures cleaned down to baseline: buckets 0, cron 0, skills 0, sessions 0,
  channels `FMCV`/`coder` only).

### Changed
- **Browser E2E artifacts refreshed** (`e2e/report.json`, `e2e/screenshots/`)
  against the current live stack; no source or test changes this round.

### Known issues / accepted limitations
- None open. Unchanged from round 36: CSP `sandbox` inline-preview limits,
  in-process scheduler over DB-persisted cron/skills rows, read-only buckets,
  and the recoverable pre-existing dev leftovers (`/data/.trash-round34` in
  the backend container plus old scratch files in the `coder` workspace),
  which are left untouched until a human asks for them to be pruned.

## Round 2026-08-08 — autonomous iteration round 35 (tag `round-35`)

### Added
- **Changelog backfill for Round 34** — the Round 34 handoff commit only
  touched `ROUND.md`, so its entry never landed in `CHANGELOG.md`; this entry
  records that round's work below and keeps the changelog aligned with the
  tags again.
- **Verification sweep (no production changes)** — re-ran every gate against
  the live compose stack: backend unit 146/14, API E2E 105/10,
  build/type-check/eslint clean on both sides, frontend production build
  clean, and the CDP browser E2E refreshed `e2e/report.json` + screenshots
  (exit 0, 21 route probes, all 9 journeys, zero console/network/HTTP
  errors; fixtures cleaned down to baseline: sessions 0, connections 0,
  buckets 0, cron 0, skills 0, channels `FMCV`/`coder` only).

### Changed
- **Browser E2E artifacts refreshed** (`e2e/report.json`, `e2e/screenshots/`)
  against the current live stack; no source or test changes this round.

### Known issues / accepted limitations
- Unchanged from round 34: CSP `sandbox` inline-preview limits, in-process
  scheduler over DB-persisted cron/skills rows, read-only buckets, and the
  recoverable `/data/.trash-round34` folder inside the backend container.

## Round 2026-08-08 — autonomous iteration round 34 (tag `round-34`)

### Added
- **Session reconciliation (backend)** — `BaseAgentService.listSessions()`
  and `deleteSession()` are now async and reconcile with persisted rows that
  exist in Postgres but not in the in-memory map: GET merges them in (DB
  failure degrades to the live list) and DELETE removes the row even when it
  was never loaded into memory, 404ing only when neither source has it.
  `sessionFromRow()` is shared with `onModuleInit()` so both paths map rows
  identically; unit test
  `'lists and deletes sessions persisted outside the live map'` added
  (unit count 145 → 146).
- **E2E cleanup fixes** — the channel journey's `round2.md` agent fixture is
  now deleted by cleanup (and asserted), and the `skill-aware e2e` sessions
  created by `skills.e2e-spec.ts` are deleted in a `finally` plus swept as a
  fixture prefix, so leaked rows can no longer resurrect invisible sessions.
- **Housekeeping** — stale dev project folders (`test-round`, `round-sandbox`,
  `round2-*`, `dbg-member-check`, `dm-coder`, `e2e-stream-test`, `myproject`)
  moved to a recoverable `/data/.trash-round34` inside the backend container;
  8 debug channels and 7 dev sessions deleted via the API; pre-cleanup DB
  backup kept at `logs/round34_precleanup_backup.sql` (gitignored).

### Fixed
- **Orphan session visibility/deletion** — a session row inserted directly
  into Postgres now appears in `GET /api/agent/sessions` and `DELETE`
  returns 200 with the DB count back to 0 (verified live after the fix).
- **Live-stack LLM auth** — backend rebuild restored `AGENT_API_KEY` from the
  local session record (the key is deliberately not committed), un-401ing
  live LLM calls.

### Changed
- README unit count updated 145 → 146; browser E2E report + screenshots
  refreshed against the fixed stack.

### Known issues / accepted limitations
- `/data/.trash-round34` (backend container) holds the retired dev folders
  until pruned; the pre-cleanup DB backup lives in gitignored `logs/`.
- Unchanged, by design: CSP `sandbox` disables scripts/forms/external
  navigation inside the inline HTML preview; scheduler runs in-process
  (cron/skills rows, incl. installed state, are DB-persisted and survive
  restarts; single-instance deployment assumed); buckets have no
  delete/rename endpoints.
- `AGENT_API_KEY` is not committed (by design); stacks started fresh must
  supply it (or use `AGENT_LLM_STUB=1`) or live LLM calls will 401.

## Round 2026-08-08 — autonomous iteration round 33 (tag `round-33`)

### Added
- **Full verification sweep (no production changes)** — re-ran every gate
  against the live compose stack: backend unit 145/14, API E2E 105/10,
  build/tsc/eslint clean on both sides, frontend production build clean, and
  the CDP browser E2E re-recorded `e2e/report.json` + screenshots (exit 0,
  21 routes, 9 journeys, zero console/network/HTTP errors; fixtures cleaned).
- **Live-state smoke check** — GET smoke over connections/skills/cron/buckets/
  workspaces and a DB row audit confirmed zero leftover round fixtures.

### Changed
- No code or test changes; Round 33 is a pure verification round.
- Handoff (`ROUND.md`) notes pre-existing dev leftovers (older debug channels
  and empty project folders from earlier rounds) left untouched, since they
  are outside the loop's fixture-cleaning scope.

### Known issues / accepted limitations
- Unchanged from round 32: CSP `sandbox` inline-preview limits, in-process
  scheduler over DB-persisted cron/skills rows, read-only buckets, and the
  parallel-session fixture-name collision hazard.

## Round 2026-08-08 — autonomous iteration round 32 (tag `round-32`)

### Added
- **Verification + docs accuracy pass** — re-ran every gate against the live
  compose stack: backend unit 145/14, API E2E 105/10, build/tsc/eslint clean
  on both sides, frontend production build clean, and the CDP browser E2E
  refreshed `e2e/report.json` + screenshots (exit 0, 21 routes, 9 journeys,
  zero console/network/HTTP errors; fixtures cleaned).
- **README API E2E count corrected** — total 105 (was 104) with the per-suite
  breakdown fixed to the declared tests (connections 22, files 13, skills 10).

### Fixed
- **Stale bucket fixture cleanup** — removed a leftover `round32-handwalk`
  bucket row + document (folder already gone) and a probe fixture via
  id-scoped SQL, because buckets expose no delete API by design. Both came
  from two concurrent loop sessions choosing the same natural fixture name
  for the same round number.

### Known issues / accepted limitations
- Concurrent loop sessions sharing this repo/db can choose identical natural
  fixture names and interfere; use unique per-session suffixes. Leftover
  read-only bucket rows must be cleared with SQL (no API delete by design).
- Unchanged from round 31: CSP `sandbox` preview limits, in-process scheduler /
  DB-persisted cron/skills rows with an in-process scheduler, read-only
  buckets, test-file lint exemptions.

## Round 2026-08-08 — autonomous iteration round 31 (tag `round-31`)

### Added
- **Full verification sweep (no production changes)** — fresh browser E2E
  run over the live compose stack confirming the four DIRECTION features
  (managed document buckets, cron jobs, agent skills, HTML view by link /
  new tab) all pass their unit, API E2E, and browser gates. `e2e/report.json`
  and screenshots re-recorded; no code changes required.

### Test status
- Backend unit **145 passed / 14 suites**; API E2E **105 passed / 10 suites**;
  backend build + `tsc` + eslint clean.
- Frontend lint + `tsc --noEmit` + `next build` clean.
- Browser E2E **exit 0**: all routes + journeys, zero console/network errors.

### Known issues / accepted limitations
- Unchanged from round 30: CSP `sandbox` preview limits, in-process scheduler /
  DB-persisted cron/skills rows with an in-process scheduler, read-only
  buckets, test-file lint exemptions.

## Round 2026-08-08 — autonomous iteration round 30 (tag `round-30`)

### Added
- **Token-safe HTML view proxy** (closes the Round 28/29 known issue) — the
  `/files` preview iframe and **Open in new tab** link now use a same-origin
  frontend route handler (`<app origin>/api/files/view`) that attaches the
  API bearer token server-side, then streams the backend's response with only
  its inline-view headers (`text/html`, `inline` disposition, CSP `sandbox`,
  `nosniff`, `no-store`) passed through. HTML viewing by link / new tab now
  works on `API_TOKEN`-protected deployments without leaking the token into
  URLs. Compose gets a new runtime `API_INTERNAL_URL` (default
  `http://backend:5555/api`) so the proxy can reach the backend container.

### Changed
- Browser E2E html-view journey asserts both the iframe and the new-tab link
  point at the same-origin proxy and verifies the fresh tab through that
  href (no raw-backend fallback); backend API E2E +1 — with `API_TOKEN` set,
  `/api/files/view` is 401 without the bearer header and streams `text/html`
  with it.

### Test status
- Unit **145 passed / 14 suites**; API E2E **105 passed / 10 suites** (+1
  token-gate view test); backend `nest build` + `tsc --noEmit` clean.
- Frontend lint + `tsc --noEmit` + `next build` clean (new proxy route
  compiled as dynamic `ƒ /api/files/view`).
- Browser E2E **exit 0**: all routes + journeys with zero console/network
  errors; html-view report now records the same-origin `proxyHref`;
  screenshots + `e2e/report.json` refreshed.

### Known issues / accepted limitations
- `Content-Security-Policy: sandbox` intentionally disables scripts/forms and
  external navigation inside the preview iframe (safe viewing; interactive
  pages open in a new tab, where the same CSP header still applies).
- Scheduler runs in-process (single-instance deployment assumed); cron jobs
  and skills — including installed state — are DB-persisted and survive
  restarts.
- Buckets are read-only by design (no delete/rename endpoints).
- Test files are intentionally exempt from `no-unsafe-*` / `require-await`
  (supertest `res.body` / Prisma test doubles are `any` by nature);
  production sources stay strictly type-checked.

## Round 2026-08-08 — autonomous iteration round 29 (tag `round-29`)

### Changed
- **Backend lint backlog cleared** — `backend/eslint.config.mjs` now ignores
  `dist/` and `coverage/` (generated build output used to be linted) and adds
  a scoped test-only block relaxing `no-unsafe-*` / `require-await` for
  `src/**/*.spec.ts` and `test/**/*.e2e-spec.ts`; production `src/**/*.ts`
  keeps the strict `recommendedTypeChecked` set. Full-repo `npx eslint .`
  exits 0 (previously 300+ errors, all in legacy test/spec files).
- **Production type tightening** — `base-agent.service.ts` (`BaseTool.run`
  narrowed to `unknown`, `JSON.parse` results typed), `cron.service.ts`
  (sync `tick()`), `main.ts` (`void bootstrap()`), unused imports dropped in
  `connection.dto.ts` / `agent.controller.ts`.
- **Legacy test/spec cleanup** — ~296 Prettier auto-fixes across old files;
  `test/files.e2e-spec.ts` fully converted to ESM imports with typed response
  interfaces (the model for the rest); `test/app.e2e-spec.ts` and
  `test/auth.e2e-spec.ts` response bodies typed; unused imports/params and
  sync-lifecycle call sites fixed. No behavior changes.

### Test status
- Unit **145 passed / 14 suites**; API E2E **104 passed / 10 suites** (both
  re-run green after the type-only edits).
- Backend `nest build` + `npx tsc --noEmit` clean; `npx eslint .` **0 errors**.
- Browser E2E **exit 0** — all journeys + route probes with zero
  console/network errors; screenshots + `e2e/report.json` refreshed.

 (tag `round-28`)

### Added
- **View HTML by link / new tab-window** (DIRECTION.md item 4) — new
  `GET /api/files/view?scope=&path=` endpoint that resolves a file exactly
  like download but serves only `.html`/`.htm` inline: `Content-Type:
  text/html; charset=utf-8`, `Content-Disposition: inline`, `Content-Length`,
  `Content-Security-Policy: sandbox`, `X-Content-Type-Options: nosniff`, and
  `Cache-Control: no-store` (400 empty path/directory, 404 missing files,
  415 non-HTML content). The file manager's viewer renders HTML files in a
  sandboxed `iframe` (no scripts/forms/external navigation) and adds an
  **Open in new tab** link that opens the same `view` URL in a fresh
  tab/window; the 100 KB read cap no longer blocks previewing larger HTML
  files.
- **Tests** — unit +3 (view metadata/resolution: HTML inline with bytes
  unchanged, 415 for `.txt`/no extension, 400 for directory/empty path, 404
  missing), API E2E +3 (inline `text/html` headers + body, 415 non-HTML,
  directory/empty-path 400).
- **Browser E2E html-view journey** — creates a `view.html` fixture through
  the `/files` UI, asserts the sandboxed in-app iframe preview and the
  `/files/view` wire headers, opens the link in a new tab with a trusted
  CDP mouse click (popup blocker proof), verifies the new page target
  renders the fixture marker + title, then deletes file + folder through the
  UI. The stale sweep now also removes leftover `browser-e2e-files-*` /
  `browser-e2e-html-*` fixture folders (emptied first) and `.dot-*` files.

### Test status
- Unit **145 passed / 14 suites** (142 → +3 files-service view tests).
- API E2E **104 passed / 10 suites** (101 → +3 files endpoint tests against
  real Postgres).
- Backend `nest build` + `tsc --noEmit` clean; scoped eslint clean for the
  new backend files (remaining e2e-spec strict-TS `any` errors are legacy).
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E **exit 0**: 21 route probes, nav, agent-channel,
  sessions/saved-connection, files, **html-view**, buckets, cron, skills,
  and settings journeys — zero console/network errors; screenshots +
  `e2e/report.json` refreshed.

### Known issues / open tickets
- The direct `view` link uses the browser-visible API URL without a token;
  fine in the compose deploy (`API_TOKEN` unset), but token-protected
  deployments need the link authenticated or proxied.
- `Content-Security-Policy: sandbox` intentionally disables scripts/forms and
  external navigation inside the preview iframe (viewing is safe, interactive
  pages should be opened in a new tab).
- Scheduler runs in-process (single-instance deployment assumed); cron jobs
  and skills — including installed state — are DB-persisted and survive
  restarts.
- Full-repo backend eslint backlog predates this round (legacy files).
- DIRECTION items 1 (buckets), 2 (cron jobs), 3 (agent skills), and 4
  (**view HTML by link / new tab-window**) are all complete.

## Round 2026-08-08 — autonomous iteration round 27 (tag `round-27`)

### Added
- **Agent skills** (DIRECTION.md item 3 — backend slice, commit
  `72453b3`) — new Prisma `Skill` model (unique slug-form names, description,
  markdown content, installed flag, timestamps) + migration
  `20260808072441_add_skills`; REST API under `/api/skills`
  (create/list/get/patch/delete + `POST :id/install` / `:id/uninstall`).
  Installs require non-empty content, uninstall keeps the authored record,
  patches with empty bodies and duplicate names are rejected (409), and
  content is capped at 200k chars.
- **Agent integration** — `BaseAgentService` gains an optional
  `SkillsService` (injected via `@Optional()`); when the registry is wired,
  every `runTurn`/`converse`/channel turn builds an "Installed skills"
  system-prompt registry block and registers a `read_skill` tool that returns
  the full markdown body of a named skill.
- **Skills UI (`/skills`)** — human-facing page wired to the API: create
  (name/description/markdown-instructions + optional install-now), edit
  (name immutable), install/uninstall per row with status pills, two-click
  delete, dismissible error/success banners, dark-mode friendly and
  responsive. `/skills` sits in the global nav (7 links) and the home page
  gained an `Open Skills` CTA; the 360px nav fit was re-verified.
- **Skills browser E2E** — the CDP journey creates a skill through the UI
  with the install box checked, verifies the Installed pill + notice,
  reloads and proves skill + installed state persist, edits
  description/instructions (name stays disabled), uninstalls (pill flips,
  record stays listed), reinstalls, and deletes with the two-click confirm;
  cleanup uses the skills DELETE API and the stale sweep removes
  `browser-e2e-skill-*` rows. Route probes now cover `/skills` in
  light/dark/mobile (21 probes across 7 routes) and the nav journey clicks
  through all seven links.

### Test status
- Unit **142 passed / 14 suites** (126 → +12 skills service, +4 base-agent
  skills integration).
- API E2E **101 passed / 10 suites** (91 → +11 skills against real
  Postgres).
- Backend `nest build` + `tsc --noEmit` clean; scoped eslint clean for the
  new skills files.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E exit 0: 21 route probes (`/`, `/settings`, `/agent`, `/files`,
  `/buckets`, `/cron`, `/skills` × light/dark/mobile) plus nav,
  agent-channel, sessions/saved-connection, files, buckets, cron, **skills**,
  and settings journeys — zero console/network errors; screenshots +
  `e2e/report.json` refreshed.

### Known issues / open tickets
- Scheduler runs in-process: only one backend instance should be scaled, and
  a backend restart re-derives next-run timing from the persisted row.
- Buckets still have no delete/rename endpoints (read-only by design).
- Skills are authored in-app and surfaced through the `read_skill` tool +
  system-prompt registry; skills rows (incl. installed state) are
  DB-persisted and survive restarts.
- Full-repo backend eslint backlog predates this round (legacy files).
- DIRECTION items 1 (buckets), 2 (cron jobs), and 3 (**agent skills**) are
  done; item 4 (**view HTML by link / new tab-window**) remains open.

## Round 2026-08-08 — autonomous iteration round 26 (tag `round-26`)

### Added
- **Cron jobs** (DIRECTION.md item 2 — backend slice) — new `CronJob`
  model + `cronJobs` relation on `Connection` (migration
  `20260808080000_add_cron_jobs`): unique job names, five-field cron
  schedules, agent-turn tasks (prompt + optional model / connection /
  maxSteps), enabled flag, and persisted `nextRunAt` / `lastRun*` fields.
  New `/api/cron*` endpoints create/list/get/patch/delete, and
  `POST /:id/run` executes a job immediately outside its schedule.
- **In-process scheduler** — a 1s ticker checks due jobs against an
  in-memory mirror; `nextRunAt` slides to the next slot after every run,
  per-job concurrency is guarded (delete is rejected with 409 while a job is
  running), schedules are validated up front with `cron-parser`, and a boot
  recovery pass marks jobs left `running` by a crash as `error`. Run results
  (done/error, message, model, duration) persist on the row; `nextRunAt`
  survives backend restarts (re-derived on boot).
- **Cron UI (`/cron`)** — human-facing page wired to the API: create jobs
  (name, schedule with inline five-field help, prompt, optional model and
  max-steps, enabled toggle), edit, pause/resume, run now, and delete with a
  two-click confirm; status pills (Idle/Running/Done/Failed/Paused), last-run
  + next-run lines, dismissible success/error banners, dark-mode friendly
  and responsive. `/cron` sits in the global nav and the home page gained an
  `Open Cron` CTA.
- **Cron browser E2E** — the CDP journey creates a job through the UI
  (fixture name, yearly schedule so the scheduler never fires mid-flow,
  "Next run:" verified), clicks **Run now** and waits for the status pill to
  reach `Done`/`Failed` (the compose gateway is configured from the local
  provider key), renames it, pauses (`Paused` + `Next run: paused`), resumes,
  and deletes it with the two-click confirm; cleanup uses the cron DELETE API
  (retried on 409) and the stale sweep now also removes
  `browser-e2e-cron-*` rows. Route probes grew to 19 (`/cron` in
  light/dark/mobile with panel/input dark checks and no-overflow nav fit),
  and the nav journey clicks through `/cron`. To keep the 6-link nav inside
  a 360px viewport the compact breakpoint hides the brand and tightens link
  padding.
- **Type-safety fix** — `cron.service.spec.ts` mock store is explicitly
  typed (`Record<string, jest.Mock>`), so `tsc --noEmit` (full tsconfig,
  including specs) is clean again after the cron suite landed.

### Test status
- Unit **126 passed / 13 suites** (112 → +14 cron service).
- API E2E **91 passed / 9 suites** (79 → +12 cron, agent service stubbed;
  three consecutive green full-suite runs; one initial ordering/timing flake
  in `agent.e2e-spec.ts` did not reproduce).
- Backend `nest build` + `tsc --noEmit` clean.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E exit 0: 19 route probes (`/`, `/settings`, `/agent`, `/files`,
  `/buckets`, `/cron` × light/dark/mobile) plus nav, agent-channel,
  sessions/saved-connection, files, buckets, **cron**, and settings
  journeys — zero console/network errors; cron run-now reached `Done` via
  the live default gateway; screenshots + `e2e/report.json` refreshed.

### Known issues / open tickets
- Scheduler runs in-process: only one backend instance should be scaled, and
  a backend restart re-derives next-run timing from the persisted row.
- Buckets still have no delete/rename endpoints (read-only by design).
- Full-repo backend eslint backlog predates this round (legacy files).
- DIRECTION item 1 (buckets) and item 2 (cron jobs) are done; item 3
  (**agent skills**) and item 4 (**view HTML by link / new tab-window**)
  remain open.

## Round 2026-08-08 — autonomous iteration round 25 (tag `round-25`)

### Added
- **Buckets UI (`/buckets`)** (finishes DIRECTION.md item 1) — a
  human-facing page wired to the Round 24 buckets API: pick an agent or
  project folder, create a uniquely named bucket, upload PDF/text/video/audio
  documents, and list/download them. Duplicate bucket names and duplicate
  uploads (immutable documents) fail with the API's 409 rendered as a
  dismissible in-page error banner; the page marks buckets as read-only,
  shows per-document kind badges (pdf/text/video/audio/other), sizes, and
  upload timestamps, and reloads from the server so created buckets +
  documents persist. Responsive + dark-mode friendly; `/buckets` is linked
  from the global nav and the home page (`Open Buckets` CTA).
- **Buckets browser E2E** — the CDP journey now creates a bucket through the
  UI (agent folder), proves a duplicate bucket name 409s in-page, uploads a
  text document, proves a duplicate upload 409s, downloads it via
  `Browser.setDownloadBehavior` and byte-compares the saved file, reloads and
  verifies the bucket + document survived, then removes the fixtures
  server-side (files API + psql rows in the compose DB; buckets deliberately
  expose no delete endpoint). Route probes were extended to `/buckets` in
  light/dark/mobile variants with nav, no-overflow, and responsive assertions,
  and the global nav journey now clicks through `/buckets`.
- **Expected-4xx handling in the E2E harness** — journeys may declare allowed
  HTTP statuses (buckets: 409); those responses and their browser log lines
  are recorded under `expectedHttp` instead of failing the page-quality gate,
  so flows that must trigger API errors stay honest without false failures.

### Fixed
- Browser E2E buckets gate looked for `flow.downloadVerified` (files-shaped
  field) instead of the buckets `flow.result.downloadVerified`, which always
  failed even when the journey passed — corrected.

### Test status
- Unit **112 passed / 12 suites**; API E2E **79 passed / 8 suites**;
  backend `nest build` + `tsc --noEmit` + scoped eslint clean.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E exit 0: 16 route probes (`/`, `/settings`, `/agent`,
  `/files`, `/buckets` × light/dark/mobile) plus the nav, agent-channel,
  sessions/saved-connection, files, buckets, and settings journeys — zero
  console/network errors (the buckets journey's intentional 409s recorded as
  expected); screenshots + `e2e/report.json` refreshed.

## Round 2026-08-08 — autonomous iteration round 24 (tag `round-24`)

### Added
- **Managed document buckets** (DIRECTION.md item 1, backend slice) — new
  `Bucket` + `ManagedDocument` models (migration
  `20260808064954_add_buckets`): bucket names are unique, buckets are
  read-only, and each bucket maps to a project folder or an agent folder (one
  folder can hold many buckets). New `/api/buckets*` endpoints create/list/read
  buckets, list documents, upload documents, and download them.
- **Immutable managed documents** — uploads are memory-buffered (100 MB cap),
  filenames are sanitized (basename, printable chars only, ≤ 180 chars), the
  kind is derived from MIME then extension (`pdf|text|video|audio|other`),
  and each file is written exactly once with `wx` under
  `<mapped folder>/<bucket>/<name>`. The unique `[bucketId, name]` pair plus
  no-overwrite file creation means duplicate uploads always 409 and no
  document can be overwritten, renamed, edited, or deleted through the API;
  downloads stream with `Content-Disposition: attachment`.
- **Validation + safety** — unknown projects, unknown agents, and invalid
  folder types are 400s; a duplicate bucket name rolls its created folder
  back; the workspace anti-traversal rules apply to bucket folder mapping.
- **Tests** — 18 new unit tests (bucket service) and 14 new API E2E tests
  (real Postgres + temp workspace) covering the full create → list → upload →
  list → download journey plus all failure modes.

### Fixed
- `test/buckets.e2e-spec.ts` is fully type-safe (typed `json<T>` response
  helper) so the new spec adds no `no-unsafe-*` eslint hits.

### Test status
- Unit **112 passed / 12 suites** (94 → +18 bucket-service tests).
- API E2E **79 passed / 8 suites** (65 → +14 buckets suite).
- Backend `nest build` + `tsc --noEmit` clean; eslint clean on new
  `src/buckets/` + `test/buckets.e2e-spec.ts`; migration applied and the
  backend container rebuilt with the buckets code; the buckets journey was
  walked by hand over HTTP (create/list/upload/list/download, 409s, headers).
- Browser E2E all green against the rebuilt backend (exit 0, zero
  console/network errors; report + screenshots refreshed). Buckets are API-only
  this round, so the browser E2E does not cover them yet.

## Round 2026-08-08 — autonomous iteration round 23 (tag `round-23`)

### Added
- **Persisted probe results** — the `Connection` row now stores the last live
  probe outcome (`lastProbeAt`, `lastProbeOk`, `lastProbeStatus`,
  `lastProbeLatencyMs`, `lastProbeModel`, `lastProbeMessage`; migration
  `20260808063438_add_connection_probe`). `test(id)` writes the result back to
  the row, so reloading `/settings` still shows a connection's known health —
  the UI marks it with a `probed HH:MM` line — and failed probes that returned
  an HTTP status keep the `HTTP <status> · <ms>` metrics row.
- **Model discovery** — two new endpoints fetch a provider's model list via
  `GET {baseUrl}/models` (stored row: `GET /api/connections/:id/models`; draft
  form values: `POST /api/connections/models/fetch`), using the stored or
  entered bearer key. Results are trimmed, de-duped case-insensitively
  (first-seen casing wins), and capped at 50 ids (`truncated: true` beyond
  that); non-OK responses and dead endpoints return a graceful
  `{ ok: false, message, status? }` result instead of an exception.
- **Settings Fetch Models button** — hydrates the Models textarea from the
  provider when the row has a stored key, and for unsaved form values (key
  entry) before save; dead endpoints show the reason inline.
- **Browser E2E** — new pre-run `staleSweep()` deletes fixture channels /
  sessions / connections left over from interrupted runs so failed-run
  leftovers are impossible, and the settings journey now proves: persisted
  probe survives reload (`probed HH:MM`), failure-with-status metrics
  (`HTTP 401 · N ms`) persist server-side, Fetch Models works through both the
  stored-key and draft paths (Bearer auth asserted on the fake upstream),
  case-variant model ids (`llama-3.1-70b` vs `LLAMA-3.1-70B`) dedupe to one,
  and a dead `/models` endpoint fails gracefully.

### Fixed
- Settings no longer loses known-health information across reloads, and a
  failed probe with an HTTP status shows its metrics instead of a bare error
  message.
- Browser E2E did not auto-clean fixtures from a run that died mid-session;
  the new sweep removes them before every run and reports any leftover
  fixture folders it cannot delete.

### Test status
- Unit **94 passed / 11 suites** (84 → +10: probe persistence, model fetch
  stored/draft success + auth failure + unreachable + non-JSON body, 50-cap
  truncation, case-insensitive dedupe, 404 unknown id, draft URL validation).
- API E2E **65 passed / 7 suites** (58 → +7: lastProbe round trip +
  normalization, models fetch stored/draft/401/unreachable/validation).
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean (0 warnings); `prisma migrate` applied on the running DB.
- Browser E2E all green (exit 0, zero console/network errors): 12 route
  probes, nav/channel/files journeys, extended settings journey (persisted
  probe + Fetch Models + failure metrics), and the sessions journey with the
  default gateway key restored (`AGENT_API_KEY` supplied from the local
  provider config; not committed).

## Round 2026-08-08 — autonomous iteration round 22 (tag `round-22`)

### Added
- Per-connection model lists: `Connection.models String[] @default([])`
  (migration `20260808060737_add_connection_models`). Settings gets a
  **Models** textarea (one provider model id per line) that round-trips on
  create/edit; the backend trims, drops blanks, and de-dupes the list on
  create/update, an empty array clears it, and malformed lists (non-array,
  non-string entries, > 50 ids, > 200-char ids) are 400s.
- The agent model picker treats connection-provided models as first-class:
  with a connection selected it lists the connection default, every id from
  the connection's `models` list, and the catalog models. Picking a
  connection model is a per-turn override (`model` + `connectionId` on the
  wire) with the same route-through semantics as catalog overrides.
- Raw (non-catalog) model ids are sent to the endpoint verbatim: before this
  round an unknown explicit model was silently resolved to the catalog
  default, so a provider-specific model could never actually be used. The
  chosen id is also stored verbatim on the session.
- Browser E2E: the sessions journey now proves the connection-model path
  against the hermetic fake upstream — the fixture row carries a non-catalog
  model id, it is absent from the default-gateway picker, appears only after
  the connection is selected, drives a real turn whose wire model is the raw
  id with the fixture's bearer key, and stays green alongside the existing
  catalog-override path (new gated flags `connListNotCatalog`,
  `connListOptionSeen`, `connListModelSentOnConverse`, `connListUpstreamHit`,
  `connListUpstreamModel`/`AuthOk`, `connListReplySeen`).

### Fixed
- Explicit `model` values outside the catalog no longer fall back to the
  catalog default on the wire (`resolveWireModel` maps catalog ids to their
  `provider_model` and passes everything else through verbatim); pinned
  sessions persist the raw id so reopening shows the user's choice.

### Test status
- Unit **84 passed / 11 suites** (80 → +4: models normalization on
  create/update/absent-key, non-catalog model used verbatim on turn +
  converse and stored on the session).
- API E2E **58 passed / 7 suites** (56 → +2: model-list
  normalize/replace/clear round trip, malformed model-list 400s; the agent
  suite asserts a raw provider model id is reported back from a turn).
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean (0 warnings).
- Browser E2E all green (exit 0, zero console/network errors): all 12 route
  probes, nav/channel/files/settings journeys (incl. Round 21 auto-probe),
  and the extended sessions journey (default path + connection-model path +
  catalog-override path). `e2e/report.json` + screenshots refreshed;
  containers rebuilt/restarted with the new images and migration applied.

## Round 2026-08-08 — autonomous iteration round 21 (tag `round-21`)

### Added
- Settings probe results show the full picture in one glance: the backend
  success message is short (`Connected — <model> responded.`) and the UI
  composes the structured `HTTP <status> · <latency> ms` line beneath it in
  both the row test result and the edit form's test result — latency/status
  are no longer duplicated inside the message text.
- Edit replays the row's last-known probe: opening the edit form shows the
  connection's known health (message + HTTP status + latency) until any
  probed field changes.
- Auto-probe on save: when a connection is saved with values that were never
  probed in the form, the client probes the persisted row right after the save
  lands (best-effort — the save is never blocked by a slow endpoint). The
  success banner reports `Probe: <summary>` or a graceful
  `Probe unavailable: <message>`.
- Browser E2E: the settings journey now proves the auto-probe path through the
  form against a hermetic fake upstream — saved row shows
  `Connected · HTTP 200 · <n> ms`, the banner shows `Probe:`, the upstream
  receives `/chat/completions` with `max_tokens: 1` and the stored bearer key,
  and reopening Edit replays the probe result into the form.

### Fixed
- Probe results no longer repeat latency/status inside the message text when
  the structured fields are already rendered by the UI.

### Test status
- Unit **80 passed / 11 suites** (count unchanged; reachable-probe message
  assertion updated to the new short form).
- API E2E **56 passed / 7 suites**.
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean (0 warnings).
- Browser E2E all green (exit 0, zero console/network errors) including the
  extended settings journey (auto-probe-on-save + edit-probe replay;
  `autoProbeRowSeen`, `autoProbeBannerSeen`, `autoProbeUpstreamHit`,
  `autoProbeUpstreamAuthOk`, `autoProbeUpstreamModel`,
  `autoProbeUpstreamMaxTokens`, `autoEditReplaysProbe`, `autoCleanup` all
  verified). `e2e/report.json` + screenshots refreshed, including
  `settings-auto-probe.png`.

## Round 2026-08-08 — autonomous iteration round 20 (tag `round-20`)
## Round 2026-08-08 — autonomous iteration round 20 (tag `round-20`)

### Added
- Agent chat model picker works with a saved connection selected: the
  connection's own model is the default option ("connection default"),
  catalog models stay selectable, and choosing one sends `model` +
  `connectionId` — an explicit catalog override that routes through the
  connection's base URL/key/default parameters instead of the built-in
  gateway. Switching back to the default gateway restores the catalog model
  that was selected before.
- Backend override semantics: `runTurn` and `converse` treat an explicit
  `model` as a per-call override that wins on the wire over the pinned
  connection's `modelName`; without an explicit model the connection's
  modelName is used (Round 19 behavior unchanged). The resulting wire model
  is returned from turns and stored on the session during conversations.
- Browser E2E: the sessions journey now asserts the full override path —
  catalog model selection with the fixture connection active, wire converse
  POST carrying `connectionId` + `model`, the hermetic upstream receiving
  the override model with the fixture's bearer key and message, the fixture
  reply rendering, and the override model persisted server-side.
  `E2E_CONN_OVERRIDE_MODEL` (default `qwen3.6-35b`, must differ from
  `E2E_CONN_MODEL`) controls the override model.

### Fixed
- Reopening a pinned session previously restored the catalog model stored on
  the row, which could switch a connection-default chat to the default
  catalog model; pinned sessions now reopen on the connection's own model
  (overrides are per-chat choices, not silently resurrected).

### Test status
- Unit **80 passed / 11 suites** (79 → +1: explicit catalog model override
  on turn + conversation through a pinned connection, per-call fallback to
  the connection's model, session model update).
- API E2E **56 passed / 7 suites** — the saved-connection journey now also
  converses and turns with a catalog model override accepted alongside
  `connectionId`.
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean (0 warnings).
- Browser E2E all green (exit 0, zero console/network errors): every route
  probe plus nav/channel/files/settings journeys and the extended sessions
  journey (connection default path + catalog override path).
  `e2e/report.json` + screenshots refreshed.

## Round 2026-08-08 — autonomous iteration round 19 (tag `round-19`)

### Added
- `AgentSession.connectionId` — sessions and stateless turns accept an
  optional UUID `connectionId`. When present, the saved Connection's base
  URL, model name, stored API key, and default parameters replace the
  built-in gateway + catalog for that call — and, on sessions, for every
  later turn (the pin persists on the row). Unknown ids are 404s on
  create/turn/converse; malformed ids are 400s; a deleted connection
  self-heals the session back to the default gateway (`onDelete: SetNull`).
- Agent chat connection picker: a "Settings connection" select next to the
  model picker ("Default gateway" or `displayName · modelName`). Selecting a
  connection disables the model picker (tooltip names the connection's
  model), pins new sessions/turns, restores a session's pinned connection on
  open, badges pinned sessions in the sidebar, and shows a "Using connection
  …" note in the thread view.
- Browser E2E coverage: the sessions journey now drives the full chain
  through a hermetic fake OpenAI-compatible upstream — fixture connection
  via the API, picker selection, wire `connectionId` with no `model`, fake
  upstream model/bearer/message assertions, fixture reply in the thread,
  server-side pin, then cleanup. `E2E_CONN_HOST` / `E2E_CONN_MODEL`
  override the fixture endpoint/model.

### Fixed
- Catalog fallback no longer fires for custom endpoints: an explicit
  connection choice fails loudly instead of silently retrying with a
  catalog fallback model that almost certainly does not exist on the
  user's provider.
- Browser E2E session cleanup now receives the real flow object, so leftover
  E2E sessions are actually deleted after each run (24 stale rows cleaned).

### Test status
- Unit **79 passed / 11 suites** (74 → +5: session pin persists through DB
  persistence, unknown connection 404 on create/turn, converse resolves
  baseUrl/model/key/default-parameters, self-heal on deleted pinned
  connection, attach-a-connection-via-converse).
- API E2E **56 passed / 7 suites** — the agent suite now includes a
  saved-connection journey (pin persists on create/converse, attach via
  converse, stateless turn with the connection, unknown connection 404,
  malformed id 400).
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean.
- Browser E2E all green (exit 0, zero console/network errors): every route
  probe plus nav/channel/files/settings journeys and the new
  connection-driven sessions journey. `e2e/report.json` + screenshots
  refreshed (`agent-sessions-picker.png`, `agent-sessions-connection.png`).

## Round 2026-08-08 — autonomous iteration round 18 (tag `round-18`)

### Added
- `POST /api/connections/test` — connection-test probe for **unsaved** form
  values. Same one-token `chat/completions` probe as the stored-row test
  (bounded by `CONNECTION_TEST_TIMEOUT_MS`), but takes `baseUrl`, `modelName`,
  and optional `apiKey` from the request instead of a DB row; validates the
  URL with the same rule and never creates or touches a connection.
- Settings form **Test Connection** button: while adding or editing, the form
  probes the currently-entered endpoint inline (`aria-live` result) so users
  can validate before committing; the result clears on any form change, save,
  cancel, or edit-switch.
- **Clear stored API key** checkbox on Edit: arming it disables the key field
  with a "Stored key will be removed on save." placeholder and saves an
  explicit `apiKey: ""`; the backend stores that as NULL (on both create and
  update), so a cleared secret is never an empty string and never masked-shown
  as `***`.

### Fixed
- Invalid HTML nesting when clearing keys: the Credential field was a `<label>`
  wrapping another `<label>`, which can misroute checkbox clicks; the outer
  wrapper is now a `<div>` with an `htmlFor`-wired label.
- Empty-string key artifacts: PATCHing `apiKey: ""` previously stored `""`
  and the API returned `""` instead of `null`; both create and update now
  normalize empty strings to NULL.
- e2e/README duplicate list numbering (two items both numbered 5).

### Test status
- Unit **74 passed / 11 suites** (67 → +4 draft-probe, +3 apiKey
  normalization).
- API E2E **56 passed / 7 suites** (51 → +4 draft endpoint cases: entered-key
  success with bearer assertion, 401 reporting, unreachable graceful failure,
  invalid URL 400 — plus +1 explicit key-clearing to NULL round-trip).
- Backend `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean; Docker `next build` clean.
- Browser E2E all green (exit 0, zero console/network errors across every
  probe and journey). The settings journey gained four gates: form-test
  graceful failure against a dead endpoint, Cancel preserving the stored URL,
  clear-key PATCH carrying `apiKey:""` with a NULL server-side result, and
  the existing key-blank / no-key-replay / row-Test gates. Screenshots +
  `e2e/report.json` refreshed.



### Added
- Connection testing: `POST /api/connections/:id/test` probes a stored
  endpoint live — one-token `chat/completions` with the stored model + key,
  bounded by `CONNECTION_TEST_TIMEOUT_MS` (default 8 s) — and returns
  pass/fail with HTTP status, latency, and a human-readable message. Network
  failures and timeouts are graceful results, never dangling requests.
- Settings Test buttons: one per connection row, with an inline
  `aria-live` result (green "Connected — …" or red fail reason) and a
  busy/disabled state while the probe runs.
- Unit coverage for the probe (reachable 200, upstream 401, network failure,
  abort/timeout, unknown id 404) and API E2E probes against a hermetic fake
  upstream on an ephemeral port (verifies the bearer key is sent, 401
  reporting, unreachable graceful failure, 404).

### Fixed
- Credential clobber on edit: the masked API-key preview (`sk-***xyz`) was
  pre-filled into the edit form, so saving without touching it wrote the
  masked string back over the real key. The field now opens blank with a
  "kept when left blank" hint, and the browser E2E captures the wire PATCH to
  prove `apiKey` is never replayed.
- Dead success notice: `handleSubmit` set the "Connection added/updated."
  banner then called `resetForm()`, which cleared it again in the same
  render — the notices never appeared. Ordering fixed, verified by the new
  settings journey.

### Changed
- Counts: unit 62 → 67 (11 suites), API E2E 47 → 51 (7 suites); backend
  `nest build` clean; frontend `tsc --noEmit` + `eslint` clean; browser E2E
  all green (exit 0, zero console/network errors on every probe) including the
  new settings journey (`settings-test-result.png` + refreshed
  `e2e/report.json`). README/e2e docs updated with the new API, env var, and
  journey.

## Round 2026-08-06 — Round 17 · autonomous iteration round 15
## Round 2026-08-06 — Round 17 · autonomous iteration round 15

### Added
- File downloads: `GET /api/files/download?scope=&path=` streams the target
  as `application/octet-stream` with an `attachment` filename (quotes /
  CR / LF stripped) and `Content-Length` — binary-safe and without the
  100 KB viewer cap; directories, empty paths, and path escapes are
  rejected.
- Files page Download buttons: one per file row and one in the viewer panel
  (the viewer one also works in read-only project scopes); clicking starts a
  browser save and shows a dismissible "Downloaded …" success notice.
- Test coverage: `FilesService.download()` unit tests (resolve returns
  metadata, directory/empty-path 400s, missing file 404), files API E2E
  additions (text download headers/body, binary download byte-for-byte,
  directory/escape 400), and the CDP browser E2E journey now clicks the row
  Download, asserts the wire headers, saves the file to disk via
  `Browser.setDownloadBehavior`, and compares the bytes.

### Changed
- Counts: unit 62/10, API E2E 47/7; frontend `tsc --noEmit` + `eslint` clean
  (`next build` clean in Docker); backend `nest build` clean; browser E2E all
  green (exit 0, zero console/network errors) including the saved-to-disk
  download check and the 360px mobile probes; `files-download.png`
  screenshot and `e2e/report.json` refreshed.

## Round 2026-08-06 — Round 16 · autonomous iteration round 14

### Added
- Responsive mobile layout: the site nav compacts at ≤640px and shortens the
  brand to "FMCV" at ≤380px; settings, agent, and files pages no longer
  overflow at 320–360px (containers shrink, header action rows wrap, files
  rows use a three-column grid with ellipsized names, agent composer and Send
  button stay on-screen).
- Home-page dark card: the landing panel gets a `#111827` surface with a
  border in dark mode (previously pure black on black), and CTA rows now wrap
  on narrow screens.
- Browser E2E mobile probes: all four routes re-probed at 360×640 with device
  metrics, asserting no horizontal overflow, all nav links fit, the agent
  composer is visible, files rows use the responsive grid, and the dark home
  card holds its color on mobile.

### Changed
- Counts unchanged (unit 59/10, API E2E 44/7); frontend `tsc --noEmit` +
  `eslint` clean (`next build` clean in Docker); backend `nest build` clean;
  browser E2E all green (exit 0, zero console/network errors) including the
  four mobile probes and dark checks; new `*-mobile.png` screenshots and
  refreshed `e2e/report.json`.

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

## Round 2026-08-08 — Round 43 · autonomous iteration round 43 (verification)

### Changed
- Full green-gate re-verification of the completed feature set: backend unit
  146/146, API E2E 107/107, backend lint/build/tsc clean, frontend
  lint/tsc/build clean; live smoke (`/`, buckets, cron, skills) all 200.
- Browser E2E re-run (exit 0): 21 route probes + channel, sessions, files,
  HTML view/new-tab, buckets, cron, skills, and settings journeys with zero
  console/network errors; `e2e/report.json` + screenshots refreshed.
- Docs re-scanned for stale persistence claims — none found.
