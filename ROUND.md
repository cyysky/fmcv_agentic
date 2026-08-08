# Round 113 — skills service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 112's next-focus item 1: lifted `skills.service.ts` from
95.45% to **100% lines** (100% stmts / 93.02% branch / 100% funcs) by
extending `skills.service.spec.ts` with 2 new tests.

## What changed this round

- **Create rethrow** — a non-`P2002` create failure propagates the original
  error untouched instead of being swallowed by the unique-name handling.
- **Update rethrow** — the same guarantee for `update()`: non-unique
  failures surface unchanged to the caller.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 258
  tests passed** (+2 this round; `skills.service.spec.ts` alone 14/14),
  backend lint + types, frontend types + lint.
- Coverage run green: `skills.service.ts` **95.45% → 100% lines** (100%
  stmts / 93.02% branch / 100% funcs). The remaining `Uncovered Line #s`
  (23 / 79 / 86) are partial-expression branch sides on already-covered
  lines (nullish-trim and ternary-expression sides), matching the 100%-line
  pattern of the other services. `buckets.service.ts`, `files.service.ts`,
  `workspace.service.ts`, `connections.service.ts`, `cron.service.ts`,
  `channel-job.service.ts` and `workspace-tools.ts` stay at 100% lines;
  `channel.service.ts` stays 99.04% (dead `SLUG_RE` guard).
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
- **Open** — remaining service coverage: `base-agent.service.ts` 74.92%
  (larger surface, runtime-critical), `prisma.service.ts` 50% (trivial
  constructor-only file); all other services at 100% lines.

## Next round focus

1. **Cover `base-agent.service.ts`** — the last big gap at ~74.92% lines and
  runtime-critical; plan by public method before writing tests, then re-run
  fast verify + coverage.
2. **Cover `prisma.service.ts`** — trivial constructor-only file at 50%;
  bundle with the base-agent round so every service is at 100% lines.
3. **Decide the dead-guard cleanup bundle** — remove/keep `SLUG_RE` and the
  unreachable safeResolve probe guard together; needs the full build + API
  E2E + browser gates, best bundled with a real frontend/backend change.
