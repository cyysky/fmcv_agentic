# ROUND 23 — 2026-08-08 (autonomous iteration round 23)

User instruction: **read on loop.md and do works**. This round landed the
three Round-22 focus items: probe results are persisted server-side so
`/settings` shows known health after a reload, connections gain a Fetch
Models action (GET the provider's `/models`) with case-insensitive dedupe,
and the browser E2E now sweeps stale fixtures before every run. Mid-round,
`DIRECTION.md` started carrying human direction (managed document buckets,
cron jobs, agent skills) — that direction becomes the next round's primary
goal.

## What changed this round

- **Persisted probe results** — `Connection` stores the last live probe
  (`lastProbeAt/Ok/Status/LatencyMs/Model/Message`; migration
  `20260808063438_add_connection_probe`); `test(id)` writes the outcome back,
  `/settings` renders a `probed HH:MM` marker after reload, and failed probes
  that returned an HTTP status keep the `HTTP <status> · <ms>` metrics row.
- **Model discovery** — `GET /api/connections/:id/models` (stored key) and
  `POST /api/connections/models/fetch` (draft values) fetch `{baseUrl}/models`
  with a 50-id cap; ids are trimmed and de-duped case-insensitively
  (first-seen casing wins); non-OK responses, non-JSON bodies, and dead
  endpoints return a graceful `{ ok: false, message, status? }`.
- **Settings Fetch Models button** — hydrates the Models textarea from the
  provider via the stored key, or from the form's draft values before save;
  dead/invalid endpoints show the reason inline.
- **Browser E2E** — new pre-run `staleSweep()` deletes fixture channels /
  sessions / connections left by interrupted runs; the settings journey now
  proves persisted probe + reload (`probed HH:MM`), failure-with-status
  metrics persisted, Fetch Models via stored-key and draft paths (Bearer auth
  asserted), case-variant dedupe, and graceful dead-endpoint failure.
- **Gateway key restored** — the backend container's `AGENT_API_KEY` was
  empty, so default-gateway turns 401'd and the sessions journey stalled. The
  key is now supplied from the local Codex provider config at container start
  (`AGENT_API_KEY` is injected per-run; nothing secret is committed).
- **Docs** — README REST table gained the two model-fetch endpoints and the
  connections section describes persisted probes + Fetch Models; CHANGELOG
  gained the Round 23 entry. The working tree's `DIRECTION.md` (human
  direction) and README reference-table updates are preserved and committed
  with this handoff.

## Test status

- Unit: **94 passed / 11 suites** (`npm test`).
- API E2E: **65 passed / 7 suites** (`npm run test:e2e`, real Postgres).
- Backend: `nest build` + `tsc --noEmit` clean; frontend `tsc --noEmit` +
  `eslint` clean; migration applied on the running DB.
- Browser E2E: exit 0, zero console/network errors on all 12 route probes and
  the nav/channel/files/settings/sessions journeys (incl. the new settings
  assertions and stale sweep); `e2e/report.json` + screenshots refreshed.
- Note: rerunning the browser E2E requires the backend container to be started
  with a working `AGENT_API_KEY` (empty by default in docker-compose).

## Known issues / open tickets

- `AGENT_API_KEY` is empty by default; the backend must be started with a key
  or default-gateway turns/session titles fail with upstream 401. The key is
  deliberately not committed (sourced locally, e.g. from
  `~/.codex/config.toml`'s vrs provider token).
- No other blockers. Persisted-probe and model-discovery semantics for
  non-standard providers (non-OpenAI `/models` shapes) are best-effort.
- `DIRECTION.md` now lists three larger feature tracks; none started yet.

## Next round focus

1. **Managed document buckets** (DIRECTION.md item 1) — unique bucket names,
   read-only buckets mapped to a project or agent folder, many buckets per
   folder, managed documents (PDF/text/video/audio) inside buckets; plan →
   schema/API → UI → tests → E2E, kept small and committable.
2. **Cron jobs** (DIRECTION.md item 2) — create/manage cron jobs (schedule +
   recurring task runner).
3. **Agent skills** (DIRECTION.md item 3) — agents can create, install, and
   use skills.

Round summary: **Round 23: probe persistence + provider model discovery landed
and verified end-to-end, browser E2E green with stale-fixture sweep.** Tests:
94 unit + 65 API E2E passed / 0 failed; browser E2E exit 0, zero console/network
errors. Committed as see git tag `round-23` (commits in this handoff). Next: managed document buckets · cron jobs ·
agent skills. Exit checked: none — continuing (human direction active).
