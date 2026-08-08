# Round 81 — per-group job ownership in the cluster overview (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 80's first focus item: making job ownership visible in
the cluster overview now that every `CronJob` carries a `schedulerGroup`.

## What changed this round

- **`/api/cron/overview` answers "who owns what"** — the payload gains
  `jobGroups` (`jobs`/`enabled`/`running`/`due` per `schedulerGroup`,
  sorted by group), aggregated from one cheap `cronJob.findMany`
  (`schedulerGroup`+state fields only) alongside the existing lease/event/
  run queries. `due` mirrors the ticker's `NOT_RUNNING` semantics
  (enabled + past `nextRunAt` + not running/never run).
- **Cron page renders ownership chips** — a "Jobs by group" row under Lease
  groups shows `group · N jobs · E enabled · R running · D due` per group
  (neutral chip style, hover tooltip with the full breakdown), refreshing
  with the same 5 s overview poll.
- **Tests** — the unit overview test covers cross-group aggregation
  (2 default jobs incl. one running/due, 1 disabled e2e-group job) and the
  API e2e overview test asserts the default group's ownership counts
  (>= 3 jobs owned after the main/restart/grouped jobs, all enabled, none
  running).

## Test status

- Backend unit: **181 passed / 14 suites**; `npx tsc --noEmit` +
  `npx eslint .` clean.
- Backend API E2E: **122 passed / 12 suites** with the live Docker backend
  running in API-only mode (Jest keep-alive warning remains, exit code 0);
  scheduler restored afterward.
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean.
- Docs drift guard OK — routes 70 / docs rows 69 (no route change).
- Browser E2E: **all checks passed** (zero console/network/HTTP errors;
  report refreshed) against both rebuilt containers running the full
  scheduler; live `/api/cron/overview` spot-checked and serves `jobGroups`.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — docs test-count paragraphs drift with every test change; keep
  syncing manually or trim the bullets to suite counts (this round's
  counts were unchanged, so no drift was introduced).
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Browser E2E proof of the API-only chip** — drive the /cron page against
  a backend with `CRON_SCHEDULER_ENABLED=false` and assert "Scheduler
  disabled — API-only" renders (needs a second app/environment in the
  script), closing the last visual gap from Round 79.
- **Ownership in the job row** — surface `schedulerGroup` on the individual
  job cards/rows and maybe make `/api/cron` list filterable per group, so
  ops can see (and optionally filter) who owns each job without the
  overview only.
- **Tidy the docs test-count paragraphs** — trim the unit/API e2e bullets
  to suite-level counts or wire an automatic consistency check so exact
  numbers stop drifting.

## Loop state

Loop state: running — Round 81 delivered per-group job ownership counts in
the cluster overview (service + unit/e2e coverage, UI chips, docs), and
backend/API/browser suites are all green. No exit condition fires; proceed
to Round 82.
