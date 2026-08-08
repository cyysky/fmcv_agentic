# Round 112 — cron service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 111's next-focus item 1: lifted `cron.service.ts` from
93.27% to **100% lines** (98.75% stmts / 83.75% branch / 100% funcs) by
extending `cron.service.spec.ts` with 13 new failure-path and timer tests.

## What changed this round

- **Boot best-effort failures** — legacy lease sweep, interrupted-run
  recovery, startup cache load, and per-job recompute keep `onModuleInit()`
  from crashing; each logs its warning.
- **Create rethrow** — a non-unique/unknown create failure propagates the
  original error untouched rather than being mislabeled as taken.
- **Standby lease path** — a failed previous-owner lookup is tolerated in
  standby, and a lease-transition event write failure is logged without
  blocking the beat.
- **Due-tick fire failure** — a claim failure inside the tick is logged via
  the per-job rejection handler instead of taking the scheduler down.
- **Re-entrant runNow** — a second `runNow` on this replica rejects with
  `already running` while the first is in flight, then the first completes.
- **recordResult fallbacks** — a DB-row lookup failure at record time falls
  back to `null` and the run result is still persisted/returned; a failed
  `cronRun.create` and a failed prune are both logged and never mask the
  caller's result.
- **Ticker interval** — fake timers prove the 1s ticker really fires
  `tick()` (standby path: `lastTickAt` updated, previous-owner lookup
  performed).

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 256
  tests passed** (+13 this round; `cron.service.spec.ts` alone 55/55),
  backend lint + types, frontend types + lint.
- Coverage run green: `cron.service.ts` **93.27% → 100% lines** (98.75%
  stmts / 83.75% branch / 100% funcs); the only remaining uncovered hits
  are 3 partial-line statements (the `NotFoundException` throw side in
  `refreshed()`, plus two short-expression sides on already-covered lines).
  `buckets.service.ts`, `files.service.ts`, `workspace.service.ts`,
  `connections.service.ts`, `channel-job.service.ts` and
  `workspace-tools.ts` stay at 100% lines; `channel.service.ts` stays
  99.04% (dead `SLUG_RE` guard).
- Full build gate not re-run (test-only change, no runtime code touched):
  Round 100's `verify --build --api-e2e` remains green — API E2E 12/123,
  bundle `/agent` 484 KB / 8 chunks, headroom 33.6 KB within 44 KB.
- Browser E2E: not re-run (no frontend runtime change); Round 100 enabled +
  api-only runs (21 route probes each, zero console/network errors) remain
  current.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Open** — `channel.service.ts` line 67 (`SLUG_RE` guard) is dead by
  construction; decide in a runtime round whether to delete it or keep it
  as defense-in-depth (bundle with the unreachable safeResolve probe
  guard).
- **Open** — remaining service coverage: `skills.service.ts` 95.45%,
  `base-agent.service.ts` 74.92% (larger surface, runtime-critical),
  `prisma.service.ts` 50% (trivial constructor-only file); all other
  services at 100% lines.

## Next round focus

1. **Cover `skills.service.ts`** — smallest practical target left at
   ~95.45% lines; extend `skills.service.spec.ts`, then re-run fast verify
   + coverage. (`base-agent.service.ts` 74.92% is the larger follow-up.)
2. **Cover `base-agent.service.ts`** — biggest remaining gap at 74.92%
   lines and runtime-critical; plan by endpoint/guard before writing tests
   (larger surface, many branch sides).
3. **Decide the dead-guard cleanup bundle** — remove/keep `SLUG_RE` and the
   unreachable safeResolve probe guard together; needs the full build + API
   E2E + browser gates, best bundled with a real frontend/backend change.
