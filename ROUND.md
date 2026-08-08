# Round 79 — API-only scheduler switch for shared-DB isolation (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 78's top focus item: removing the API E2E dependency
on stopping the live backend by giving deployments an explicit
scheduler-disable switch.

## What changed this round

- **`CRON_SCHEDULER_ENABLED=false` API-only mode** — a backend that sets it
  skips lease acquisition, the 1 s ticker, the due-job scan, and the
  boot-time recovery sweep; CRUD and `Run now` still work. Every other
  value (or unset) keeps the full scheduler, so existing deployments are
  unchanged. `GET /api/cron/scheduler` now reports `enabled` so API-only
  nodes are distinguishable from standby replicas.
- **Live-stack E2E workflow upgraded** — the docs now prefer
  `CRON_SCHEDULER_ENABLED=false docker compose up -d --force-recreate backend`
  for API E2E (no stop required, suite deterministic); the old
  stop/start fallback is still documented. `docker-compose.yml` wires the
  env var through. Also documented the rebuild-both-containers rule before
  browser E2E after a contract change (Round 76 leftover).
- **UI** — the scheduler chip shows "Scheduler disabled — API-only" and
  "no lease · no background firing" when the backend reports `enabled:false`.
- **Tests** — 2 unit tests (disabled-mode `onModuleInit`/`tick` produce no
  lease/recovery/cache/Due-scan calls and status is honest; default and
  explicit true/TRUE enabled, FALSE disabled) and a new
  `cron-disabled.e2e-spec.ts` that boots an API-only app on its own lease
  group, proves no lease row ever appears, forces a job due and proves it
  stays unfired across 2.5 s of ticks, then proves `Run now` still executes
  exactly once — all in one e2e suite.

## Test status

- Backend unit: **179 passed / 14 suites** (+2); `npx tsc --noEmit` +
  `npx eslint .` clean.
- Backend API E2E: **121 passed / 12 suites × 3 consecutive runs** (+1
  suite), **with the live Docker backend running in API-only mode the whole
  time** — the previous stop-the-backend requirement is no longer needed
  for determinism (Jest keep-alive warning remains, exit code 0).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean.
- Docs drift guard OK — routes 70 / docs rows 69.
- Browser E2E: **all checks passed** (zero console/network/HTTP errors;
  report refreshed) against both rebuilt containers running the full
  scheduler again.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low — scheduler disable only, not ownership scoping**: API-only mode
  closes the cross-deployment race for nodes that opt out, but an *enabled*
  node sharing one Postgres with another deployment can still claim that
  deployment's due jobs (the due-job scan has no group owner). If multi-
  deployment-in-one-DB is ever a real topology, jobs need a lease-group
  owner column + claim filter.
- Startup acquisition in `onModuleInit` is deliberately not recorded as an
  event — only transitions observed inside `tick()` write audit rows.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Cron schema/lease-group ownership (optional, only if multi-deployment-
  in-one-DB is real)** — add an owner/filter so due-job scans never cross
  deployment boundaries; otherwise close the ticket as "solved by
  API-only mode".
- **Tidy the docs test-count paragraphs** — the giant "Testing" bullets now
  list exact counts; keep them in sync automatically or trim to suite
  counts to avoid drift.
- **Browser E2E proof of the disabled chip** — drive the /cron page against
  an API-only backend and assert "Scheduler disabled — API-only" renders
  (requires a second app boot in the script; only worth it once the script
  supports a per-flow backend mode).

## Loop state

Loop state: running — Round 79 delivered `CRON_SCHEDULER_ENABLED=false`
API-only mode (unit-proven, e2e-proven while the live stack stayed up 3/3
runs), upgraded the E2E workflow docs, surfaced the mode in the UI, and
cleared the Round 76 rebuild-together docs leftover. No exit condition
fires; proceed to Round 80.
