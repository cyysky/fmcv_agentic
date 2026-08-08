# Round 84 — suite-level test counts + drift guard for README Testing (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 83's first focus item: stop the README test-count
paragraphs from drifting.

## What changed this round

- **README Testing bullets trimmed to suite counts** — the unit and API E2E
  headers now say "14 suites" / "12 suites" instead of "181 tests / 14
  suites" / "122 tests / 12 suites", and every per-suite exact count
  (`cron jobs (14: ...)`, `app health (5), ...`, `token gate (3), ...`) is
  gone. The prose still describes each suite's coverage, but the numbers
  cannot silently fall behind a growing suite.
- **New `scripts/verify-test-counts.mjs` drift guard** — zero-dependency;
  counts `*.spec.ts` under `backend/src` and `*.e2e-spec.ts` under
  `backend/test`, verifies the README Testing section reports exactly those
  suite counts, and fails if exact per-test count forms (`N tests / M
  suites`, `(N:`, bare `(N)`) reappear in that section. Documented in the
  Testing command block + a dedicated bullet next to the REST docs guard.
- **Browser E2E re-run (enabled mode)** — full journey green with the Round
  83 badge + group-filter flow still proven (`schedulerChip: "enabled"`,
  `groupFilterProven: true`); report refreshed, zero console/network/HTTP
  errors.

## Test status

- Backend unit: **182 passed / 14 suites** (`npm test -- --runInBand`).
- Backend API E2E: **123 passed / 12 suites** in API-only mode (Jest
  keep-alive warning remains, exit code 0); backend restored to enabled mode
  afterwards.
- Test-count guard: OK — unit 14 suites / API E2E 12 suites, README matches.
- REST docs guard: OK — routes 70 / docs rows 69.
- Browser E2E: **all checks passed** (enabled mode), zero errors.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — the E2E report + screenshots only keep the last mode's run, so
  enabled-mode and API-only evidence from the same round is not archived
  together; each round's artifact reflects whichever mode ran last.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Mode-suffixed E2E artifacts** — write the browser E2E report as
  `report-<enabled|api-only>.json` (and per-mode screenshots) so both modes'
  evidence is archived per round instead of last-run-only.
- **Browse for other friction** — sweep the current journeys for remaining
  rough edges (stale client caches, filter/refresh interplay, error states,
  E2E cleanup), fix what is cheap and ticket what is not.
- **Wire the new guards into one verify command** — a single `npm run
  verify` (or repo-root script) that runs the REST docs guard, the
  test-count guard, and frontend/backend type checks, so a round's
  verification step is one command instead of several hand-remembered ones.

## Loop state

Loop state: running — Round 84 killed the docs test-count drift (suite-level
bullets + a guard that bans exact counts from the Testing section) with all
suites green and browser E2E re-proven. No exit condition fires; proceed to
Round 85.
