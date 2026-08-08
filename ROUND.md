# Round 80 — per-job lease-group ownership (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 79's top focus item: giving every cron job a lease-group
owner so the due-job scan and boot-recovery sweep never cross deployment
boundaries in a shared-DB topology.

## What changed this round

- **`CronJob.schedulerGroup` owner column** — `TEXT NOT NULL DEFAULT 'default'`
  plus a composite index `[schedulerGroup, nextRunAt]`; migration
  `20260808162602_add_cron_job_scheduler_group` applied. Existing rows inherit
  `'default'`, so current deployments are unchanged.
- **Create stamps ownership** — `create()` records the creating backend's
  `CRON_LEASE_GROUP` on the row; a repeated env lookup is now a single private
  `leaseGroup` getter shared by `onModuleInit`, `acquireLease`, `tick`, and
  `schedulerStatus`.
- **Scoped background work** — the boot recovery sweep, the startup cache
  load, and the due-job scan all filter on `schedulerGroup`, so a deployment
  never sweeps, caches, reschedules, or fires another group's jobs. Manual
  `Run now` stays group-agnostic (atomic `lastRunStatus` claim still enforces
  exactly-once), and `overview`/`overviewEvents`/list still read across groups
  for cluster observability.
- **Tests** — 2 unit tests (create stamps the group; sweep/cache/due scan
  carry `CRON_LEASE_GROUP`) and 1 e2e test that creates a job, hands it to a
  foreign `schedulerGroup` while due, proves it stays unfired for 2.5 s, then
  restores ownership and proves the ticker fires it exactly once.
- **Docs** — README + backend README rewrite the shared-DB caveat: job
  ownership is group-isolated, so only the main cron suite (which shares the
  container's `default` group) still needs the live stack in API-only mode;
  test counts refreshed to verified numbers.

## Test status

- Backend unit: **181 passed / 14 suites** (+2); `npx tsc --noEmit` +
  `npx eslint .` clean.
- Backend API E2E: **122 passed / 12 suites × 3 consecutive runs** (+1 test)
  with the live Docker backend running in API-only mode the whole time
  (Jest keep-alive warning remains, exit code 0); scheduler restored
  afterward.
- Docs drift guard OK — routes 70 / docs rows 69 (no route change).
- Browser E2E: **all checks passed** (zero console/network/HTTP errors;
  report refreshed) against the rebuilt backend + unchanged frontend
  containers running the full scheduler.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Behavior note** — `GET /api/cron/scheduler` `jobCount`/`enabledCount` now
  reflect only this deployment's lease group (the startup cache is scoped);
  cluster-wide counts remain visible via `/api/cron/overview`.
- **Low** — docs test-count paragraphs drift with every test change; keep
  syncing manually or trim the bullets to suite counts.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Overview per-group job ownership** — `CronJob` now carries
  `schedulerGroup`, so the cluster overview can add per-group job counts (and
  maybe due/running breakdowns) so ops on a shared DB can see which
  deployment owns which jobs at a glance; UI chips for the filter bar follow.
- **Browser E2E proof of the API-only chip** — drive the /cron page against a
  backend with `CRON_SCHEDULER_ENABLED=false` and assert "Scheduler disabled
  — API-only" renders (needs a second app/environment in the script).
- **Tidy the docs test-count paragraphs** — trim the unit/API e2e bullets to
  suite-level counts or wire an automatic consistency check so exact numbers
  stop drifting.

## Loop state

Loop state: running — Round 80 delivered per-job lease-group ownership
(schema + migration, create stamp, group-scoped sweep/cache/due scan,
unit-proven and e2e-proven with a foreign-group isolation test, docs
refreshed). No exit condition fires; proceed to Round 81.
