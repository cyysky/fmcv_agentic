# Round 107 — channel-job service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 106's next-focus item 1: lifted `channel-job.service.ts`
from 76.27% to 100% lines (98.43% stmts / 80.48% branch / 100% funcs).

## What changed this round

- **`statusFor` coverage** — returns the latest in-memory job per
  channel+agent (including after it finishes) and null for never-run members.
- **`getRunning` validation edges** — wrong-channel jobs raise 404, finished
  jobs raise 400 (`is not running`) for both `interject` and `stop`, and an
  unknown job id raises 404 from `get()`.
- **Aborted-run failure path** — when a run is stopped and later rejects,
  the terminal `stopped` status is preserved: no `error` event, no
  downgrade, single `finishedAt`.
- **Debug-trace routing** — per-tool `toolStatusPost` lands in the created
  sub-channel; when `ensureSubChannel` fails, the run degrades gracefully
  and posts trace updates to the main channel.
- **`stopForChannel` lifecycle** — running jobs are stopped with exactly one
  `stopped` event and finished jobs are untouched; persisted run history is
  pruned via `channelRun.deleteMany`, and a prune failure is logged, not
  thrown. Unrelated channels verify a zero count.
- **Failure tolerance** — a `channelRun.upsert` rejection never fails the
  in-memory job; `onModuleInit` recovery, `snapshot`, and `latestFor` all
  return null/undefined cleanly on DB errors and on missing rows.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 203
  tests passed** (+8 this round), backend lint + types, frontend types +
  lint.
- Coverage run green: `channel-job.service.ts` **76.27% → 100% lines**;
  remaining branch gaps are nullish-fallback sides over persisted-row
  fields (answer/error/events/finishedAt), mostly impossible with real DB
  rows. `channel.service.ts` stays 99.04% (dead `SLUG_RE` guard),
  `workspace-tools.ts` stays 100%.
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
  as defense-in-depth.
- **Open** — `buckets.service.ts` is now the lowest service at 79.45% lines
  (uncovered: 65-66, 115, 133-134, 159-160, 203, 218-224, 242, 258, 292,
  313-318, 328-344, 361, 371-372, 411).

## Next round focus

1. **Cover `buckets.service.ts`** — extend `buckets.service.spec.ts` toward
  the 90%+ service bar, targeting the listed bucket lifecycle/validation
  paths; re-run fast verify + coverage after.
2. **Decide the dead `SLUG_RE` guard** — a small runtime cleanup
  (remove the unreachable branch) needs the full build + API E2E + browser
  gates; only worth doing bundled with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
