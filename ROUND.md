# Round 78 — overview transition "load all" history (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 77's top focus item: memory-coasting the overview
window depth with a paginated **load-all transition history** pass that
mirrors the run-history load-all.

## What changed this round

- **Paginated overview transition events API** — `GET /api/cron/overview/events`
  pages every lease-transition event with the same 1–100 `limit` clamp as
  the overview window plus `offset`, optional `group=` scoping, and a
  `total` (scoped count) so the UI can report "all N" or "first N of M".
  Routes stay stable (declared after `/overview`, no Nest conflicts).
- **Load-all transitions UI** — when the depth-limited window trails the
  selected group's (or All's) event total, the Transitions line gains
  **Load all for this group** / **Load all transitions**; the button swaps
  the line to a full-history snapshot paginated in 100-event pages
  (bounded by a 500-event safety cap), labeled "all N transitions" or
  "first N of M transitions", with a **back to newest {depth}** button to
  return to the depth-limited window. A stale snapshot (filter/depth
  changed after load) is ignored during render instead of resetting state
  in an effect — satisfying the `react-hooks/set-state-in-effect` rule.
- **Tests** — 2 unit tests for `overviewEvents` (newest-first pagination +
  `total` mapping; clamp/default coercion for limit/offset and no-group
  `where:{}`), 1 API E2E test seeding 14 events (page boundaries, no
  overlap, tail drain, offset past end, defaults, 500→100 clamp, unknown
  group, and a cross-group full pass), and a browser proof that clicks
  Load-all (all 13 synthetic transitions, data-complete), screenshots it,
  and asserts back-to-newest restores "newest 10 of 13". Fixed one e2e
  assertion that pointed at the wrong chain link (id 13's previousOwner is
  replica-12, not id 12's).
- **Docs** — REST table row for the new endpoint (routes 70 / docs rows 69),
  README cron-prose for the load-all pass + back button, and the browser
  journey paragraph extended.

## Test status

- Backend unit: **177 passed / 14 suites** (+2); `npx tsc --noEmit` +
  `npx eslint .` clean.
- Backend API E2E: **120 passed / 11 suites** (+1; live Docker backend
  stopped per the canonical workflow; known Jest keep-alive warning
  remains, exit code 0).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean.
- Docs drift guard OK — routes 70 / docs rows 69.
- Browser E2E: **all checks passed** (zero console/network/HTTP errors;
  new `overview-events-load-all` step + flag in `e2e/report.json`,
  screenshot `cron-overview-events-all.png`); frontend + backend Docker
  images rebuilt together so the live stack carried the new contract.

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
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Scheduler isolation for shared-DB stacks** — decide whether jobs should
  carry a lease-group owner (schema + claim filter) or deployments get a
  scheduler-disable switch, so API E2E no longer depends on the
  stop-the-backend workflow.
- **Docker/ops docs for rebuild-together** — document that frontend +
  backend containers must be rebuilt together after any API/UI contract
  change before the browser E2E (Round 76 leftover).
- **Group-search / timeline view** — with load-all now proven, consider a
  per-group event timeline with time-range filters for really long failover
  histories (only if clearly justified).

## Loop state

Loop state: running — Round 78 delivered the overview's load-all transition
history (API + UI + unit/API/browser proofs, docs refreshed, live images
rebuilt together). No exit condition fires; proceed to Round 79.
