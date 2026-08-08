# ROUND 66 — 2026-08-08 (autonomous iteration round 66)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 65's handoff: prove exactly-once across replicas
against real Postgres, and surface scheduler/lease status in the cron UI.

## What changed this round

- **Scheduler status endpoint** — `GET /api/cron/scheduler` reports this
  replica's lease state (`leaseHeld`, `leaseGroup`, `leaseExpireAt`,
  `tickIntervalMs`, `failoverMs`, `lastTickAt`, local job/enabled counts).
- **Cron UI lease chip** — the `/cron` page now shows "Scheduler active on
  this node" vs standby, the last tick/beat, and the lease expiry, refreshed
  every 5 s; the endpoint + chip are documented in the README REST table.
- **Multi-replica e2e suite (new, real Postgres)** — three tests boot two
  NestJS replicas against the shared DB in an isolated lease group and prove
  the distributed scheduler: exactly one lease holder is elected; a ticker
  fire racing a run-now on a due job results in exactly one agent execution
  (both replicas agree on the terminal row, and the loser is a 409/claim
  loss); and after the holder's ticker stops, the standby takes over the
  lease and fires a due job itself.
- **Cross-replica next-run bugfix** — `recordResult` recomputed the next slot
  from the in-memory cache, so a lease holder firing a job created on another
  replica (never cached) would null out `nextRunAt`. It now falls back to the
  fresh DB row; a unit test pins the behavior.
- **Lease identity fix** — the lease row `id` was a hard-coded singleton
  while the table also UNIQUEs `schedulerGroup`, so a second group's insert
  always collided on the PK (never elected). Row id is now the scheduler
  group itself, boot sweeps old-scheme rows for the group, and
  `CRON_LEASE_GROUP` env override lets deployments/e2e runs elect
  independently. The live stack was rebuilt onto this scheme (single fresh
  `default` row, old singleton row swept at boot).

## Test status

- Backend unit: **158 passed / 14 suites** (18 cron tests incl. the
  DB-fallback next-run and scheduler-status shape).
- Backend API E2E: **114 passed / 11 suites** (13 cron + 3 multi-replica:
  lease election, ticker/run-now exactly-once race, failover firing).
- Backend `npx tsc --noEmit` clean; docs guard OK (67 routes / 66 docs
  rows — the bare `GET /api` hello probe stays undocumented).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` + `next build` clean;
  both Docker images rebuilt and recreated.
- Browser E2E: **all checks passed** against the live stack — cron journey
  (create → run → done → edit → pause → resume → delete) with zero
  console/network/HTTP errors; buckets + all other flows green; scheduler
  chip text confirmed present in the deployed bundle.
- Baseline clean: 0 cron jobs / 0 leftover fixtures; one fresh `default`
  lease row by design; live `GET /api/cron/scheduler` reports lease held.

## Known issues / open tickets

- **Low** — Jest e2e prints the "did not exit" keep-alive warning after the
  multi-replica suite closes (supertest/in-process server sockets); suites
  pass with exit code 0. Closing the default supertest agents would silence it.
- Accepted limitations: the failover gap is up to 5 s; the lease renews only
  on ticker beats; the status endpoint is a per-replica view (other
  replicas' last beat is not aggregated).

## Next round focus

- **Cron run history** — jobs overwrite `lastRun*` on every firing; a small
  `CronRun` table + "History" section would make multi-fire auditing and
  exactly-once verification observable from the UI (the cluster-wide story
  currently lives only in tests).
- **Browser E2E scheduler chip assertion** — assert the "Scheduler active on
  this node" chip text (and standby behaviour after the holder is stopped)
  inside the existing cron browser journey.
- Any DIRECTION.md instruction.

## Loop state

Loop state: running — Round 66 closed the exactly-once story with a
real-DB two-replica proof and made scheduler ownership visible in the UI,
with a fully green gate. No exit condition fires; proceed to Round 67.
