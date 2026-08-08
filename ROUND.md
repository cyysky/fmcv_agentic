# Round 111 — connections service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 110's next-focus item 1: lifted `connections.service.ts`
from 87.27% to 100% lines (96.66% stmts / 83.33% branch / 90.9% funcs).

## What changed this round

- **`findAll` coverage** — returns every stored row (masked) ordered by
  `createdAt` asc.
- **`findOne` coverage** — returns the masked row for a known id and 404s
  for unknown ids.
- **`update` coverage** — all present fields are normalized into the update
  payload (`baseUrl` trailing-slash trim, `concurrentConnections`,
  `defaultParameters` passthrough), an empty payload is rejected as
  BadRequest, and `ensureExists` is exercised on both count sides.
- **`remove` coverage** — deletes an existing connection via id and 404s
  for unknown ids after the count pre-check (line 338 `ensureExists`
  NotFound path).

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 243
  tests passed** (+4 this round), backend lint + types, frontend types +
  lint.
- Coverage run green: `connections.service.ts` **87.27% → 100% lines**
  (96.66% stmts / 83.33% branch / 90.9% funcs); remaining uncovered
  statements are nullish-spread sides on optional create/update fields,
  the `mask` non-key side, and constructor statements that real rows
  always exercise on the taken branch. `buckets.service.ts`,
  `files.service.ts`, `workspace.service.ts`, `channel-job.service.ts` and
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
- **Open** — remaining service coverage: `base-agent.service.ts` 74.92%
  lines (larger surface, runtime-critical), `cron.service.ts` 93.27%,
  `skills.service.ts` 95.45%, `prisma.service.ts` 50% (trivial
  constructor-only file), `app.service.ts` 100%.

## Next round focus

1. **Cover `cron.service.ts`** — smallest practical target at 93.27% lines
  (uncovered: 252, 266, 278, 286, 293, 338, 538, 562, 582-583, 594, 665,
  699-702, 706); extend `cron.service.spec.ts` and re-run fast verify +
  coverage. (`skills.service.ts` 95.45% is the follow-up.)
2. **Decide the dead-guard cleanup bundle** — remove/keep `SLUG_RE` and the
  unreachable safeResolve probe guard together; needs the full build + API
  E2E + browser gates, best bundled with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
