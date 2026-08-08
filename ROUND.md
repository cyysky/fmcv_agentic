# ROUND 22 — 2026-08-08 (autonomous iteration round 22)

User instruction: **read on loop.md and do works**. This round landed
per-connection model lists (Round 21's top focus): Settings can store a
provider-specific model list per connection, the agent model picker treats
those ids as first-class overrides, and non-catalog ids reach the endpoint
verbatim instead of silently falling back to the catalog default.

## What changed this round

- **Connection model lists** — `Connection.models String[]` (migration
  `20260808060737_add_connection_models`) with a Settings textarea (one
  provider model id per line) that round-trips on create/edit; backend trims,
  drops blanks, and de-dupes the list, an empty array clears it, and
  malformed lists (non-array, non-string, > 50 ids, > 200-char ids) are 400s.
- **First-class provider models in the picker** — with a connection selected,
  the agent model picker shows the connection default, every id from the
  connection's `models` list, and the catalog models; picking a connection
  model sends `model` + `connectionId` on the wire (per-turn override).
- **Raw model ids sent verbatim** — `resolveWireModel` maps catalog ids to
  their `provider_model` and passes everything else (e.g. a connection-list
  id) through unchanged; pinned sessions store the user's chosen id verbatim.
- **Browser E2E** — the sessions journey proves the connection-model path
  against the hermetic fake upstream: the fixture row's non-catalog id is
  absent from the default-gateway picker, appears after the connection is
  selected, drives a real turn with the fixture's bearer key, and reports the
  raw id at the upstream (new gated flags `connList*`).
- **Housekeeping** — removed 10 stale "New session" rows and 1 leftover
  connection fixture (with a stored API key) left by earlier interrupted
  browser-E2E runs; verified no stray localhost tabs after the run; fixed a
  duplicate CHANGELOG heading. A stray `.gitignore` rule that would have
  untracked `e2e/screenshots/` was reverted so screenshots stay committed as
  round evidence, consistent with all previous rounds.

## Test status

- Unit: **84 passed / 11 suites** (`npm test`).
- API E2E: **58 passed / 7 suites** (`npm run test:e2e`, real Postgres).
- Backend: `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean (0 warnings); `prisma generate` + migration status clean.
- Browser E2E: exit 0, zero console/network errors on all routes and the
  nav/channel/files/settings/sessions journeys; `e2e/report.json` +
  screenshots refreshed against freshly rebuilt images (migration applied);
  fixture connections/sessions cleaned up server-side (`connections: 0,
  sessions: 0` after the run + housekeeping).

## Known issues / open tickets

- None blocking. The connection-model list is a manual textarea list (no
  `/models` discovery yet); dedupe is case-sensitive; the picker omits a
  catalog duplicate when the same id is also in the connection list (the
  connection's raw id wins) — both are documented semantics, not blockers.

## Next round focus

1. **Probe polish follow-ups** (Round 21's #3) — surface the probe metrics
   line in a row even when a previous probe is stale, or persist the last
   probe result server-side so a reload of `/settings` still shows known
   health.
2. **Model discovery / editable validation** — add a "fetch models" action
   (GET the provider's `/models` where available) or validate connection
   model ids against a documented endpoint; consider case-insensitive
   de-dupe/conflict handling between the connection list and the catalog.
3. **Housekeeping rhythm** — keep the API-E2E and browser-E2E suites wired
   into the round loop with a short smoke check of stale-session cleanup in
   the browser script itself (it already deletes its own fixtures; an
   explicit pre-run stale sweep would make failed-run leftovers impossible).
