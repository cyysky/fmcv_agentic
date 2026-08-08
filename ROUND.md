# ROUND 65 — 2026-08-08 (autonomous iteration round 65)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round's goal was the Round 64 handoff's top concrete item: **decouple the
cron scheduler from the single NestJS instance**.

## What changed this round

- **Distributed scheduler lease** — new `cron_scheduler_leases` singleton
  table + migration. Each replica atomically claims/renews the lease
  (`INSERT ... ON CONFLICT`, 5 s expiry); only the lease holder runs the
  per-second ticker, and a standby takes over after failover. Standby
  replicas keep serving CRUD, run-now, and deletes.
- **Exactly-once fire claims** — due-job firing and run-now both claim the
  row atomically (`lastRunStatus` → `running` via guarded `updateMany`), so
  a job never executes twice cluster-wide even under split-brain leases or
  an overlapping run-now; `recordResult` is guarded the same way.
- **Never-run job bugfix** — Postgres evaluates `NOT (lastRunStatus =
  'running')` as NULL on fresh rows, so Prisma's plain `{ not }` filter
  silently skipped them: scheduled fires never happened and run-now failed
  with 409 Conflict. Fire claims and the due-query now match both
  non-running and NULL statuses (regression-proven against real Postgres;
  spec asserts the OR filter).
- **Resilient ticker** — tick-fire rejects are caught and logged instead of
  crashing the loop via an unhandled promise rejection.
- **Delete guard** — refuses deletion when the DB row shows `running` on
  another replica.
- **Docs** — README scheduler section documents the lease + exactly-once
  claims; live stack rebuilt and recreated onto the new image (lease held,
  migration present).

## Test status

- Backend unit: **156 passed / 14 suites** (16 cron tests, incl. lease-gated
  ticker, cross-replica delete guard, never-run claim filter).
- Backend API E2E: **111 passed / 10 suites** (13 cron tests; run-now
  through the stub agent ends `done` with next run slid forward).
- Backend `npx tsc --noEmit` clean; docs guard `verify-rest-docs.mjs` OK
  (66 routes / 65 docs rows).
- Frontend `npx tsc --noEmit`, `npx eslint app/buckets`, `next build` clean.
- Browser E2E: **all checks passed** against the live stack — cron journey
  (create → run via UI → `done` → edit → pause → resume → delete), buckets
  journey, plus nav/channels/files/skills/settings/sessions flows;
  console/network/HTTP errors zero.
- Baseline clean after the run: 0 cron jobs / 0 buckets / no leftover
  fixtures; the single lease row remains by design.

## Known issues / open tickets

- **None open.** Accepted limitations: the failover gap is up to 5 s; the
  lease renews only on ticker beats; the cron UI does not surface which
  replica holds the lease; cross-replica run-now stress (two replicas racing
  the same row) is unit-tested but not yet e2e-tested.

## Next round focus

- **Multi-replica consistency e2e** — boot two in-process replicas against
  the same Postgres, race run-now and a due tick on the same job, and assert
  exactly one execution and one terminal result. This closes the Round 65
  story with a real-DB proof.
- **Cron UI scheduler status** — surface whether this backend holds the
  scheduler lease, the last tick time, and failover state (small
  `scheduler/status` endpoint + indicator on the cron page).
- Any DIRECTION.md instruction.

## Loop state

Loop state: running — Round 65 delivered the distributed scheduler with a
fully green gate and live-stack verification. No exit condition fires;
proceed to Round 66.
