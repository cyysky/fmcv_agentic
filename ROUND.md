# ROUND 77 — 2026-08-09 (autonomous iteration round 77)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 76's top focus item: surrogate-safe run-message
truncation (`MAX_RUN_MESSAGE` hygiene).

## What changed this round

- **Surrogate-safe run-message truncation** — `truncate()` in
  `cron.service.ts` is now exported and flattens/trims text, keeps the
  ellipsis inside the 500-code-unit cap, and backs the cut off when it
  would split a UTF-16 surrogate pair (emoji straddling the boundary), so
  persisted run messages and history rows are always valid Unicode. Added an
  8-case unit block (empty/whitespace -> null, at-cap unchanged, long text
  capped with the ellipsis inside the cap, whitespace collapse, emoji at the
  cut, straddling surrogate backed off, leading emoji kept, degenerate caps).
  README now documents the "500 valid-Unicode code units, never split
  mid-emoji" contract.
- **Root-caused + fixed the intermittent API E2E flake** — the
  cron-multireplica suite failed ~5/8 runs at `lastRunMessage` = null while
  `lastRunStatus` was `done`. Instrumented runs proved the suite's own
  replicas never write that row: the live Docker backend's cron scheduler
  scans *all* due jobs in the shared Postgres regardless of lease group,
  claims the e2e-created failover job, runs it against the real gateway (the
  container has no `AGENT_LLM_STUB`), and persists a `done` row with a
  null/empty answer. Stopping the backend container during API E2E (the old
  documented-but-unfollowed workflow) makes the suite deterministic: 5
  consecutive full runs at 119/119.
- **Docs** — root README Testing + backend README now give the exact
  `docker compose stop backend` / `npm run test:e2e` / start workflow and
  explain both interference sources (cross-stack due-job race + boot-time
  recovery sweep). Browser E2E report refreshed (same checks, all passed).

## Test status

- Backend unit: **175 passed / 14 suites** (+8 for `truncate`); `npx tsc
  --noEmit` + `npx eslint .` clean.
- Backend API E2E: **119 passed / 11 suites × 5 consecutive runs** (all
  green, live backend stopped; previously flaky 4/6 with it running).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean.
- Docs drift guard OK — routes 69 / docs rows 68.
- Browser E2E: **all checks passed** (zero console errors / failed requests
  / HTTP errors; run against the rebuilt backend); report refreshed.

## Known issues / open tickets

- **Medium — scheduler due-job scan is not lease-group scoped**: any
  deployment sharing one Postgres can claim another deployment's due jobs
  (lease groups isolate the scheduler, not the job scan). In practice API
  E2E must run with the live backend container stopped; a real fix would be
  per-job group ownership/claim or a `CRON_SCHEDULER_ENABLED=false`-style
  switch for test isolation.
- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- Startup acquisition in `onModuleInit` is deliberately not recorded as an
  event — only transitions observed inside `tick()` write audit rows.
- Load-all is deliberately capped at 200 runs; a history deeper than that
  shows "First 200 runs" (bounded UI memory).

## Next round focus

- **Memory-coast the overview window depth** — the Round 76 `?limit=` /
  selector is applied per fetch but a selected group's deeper window could
  also drive a "load all for this group" pass like run histories (or a
  group-search/timeline view) when clusters have long failover histories.
- **Scheduler isolation for shared-DB stacks** — decide whether jobs should
  carry a lease-group owner (schema + claim filter) or deployments get a
  scheduler-disable switch, so API E2E no longer depends on the
  stop-the-backend workflow.
- **Docker/ops docs for rebuild-together** — document that frontend +
  backend containers must be rebuilt together after any API/UI contract
  change before the browser E2E (Round 76 leftover).

## Loop state

Loop state: running — Round 77 delivered surrogate-safe run-message
truncation (unit-proven), root-caused the API E2E flake to live-stack
scheduler interference, verified 5 consecutive green full API E2E runs, and
hardened the docs/workflow so the trap is documented for every future round.
No exit condition fires; proceed to Round 78.
