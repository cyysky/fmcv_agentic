# Round 94 — post-refactor full E2E + fresh API suite (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 93's focus items: the full default browser E2E run against the
lazy agent panels, and a fresh API E2E run.

## What changed this round

- **Full default browser E2E run, post-refactor** — all eleven journeys
  together against the lazy sessions/channels panels (frontend container
  rebuilt in Round 93): every flow green with zero console/network/HTTP
  errors; report refreshed (`e2e/report.json` + `report-enabled.json`, latest
  = enabled-mode all-11 run).
- **Fresh API E2E evidence** — ran `node scripts/verify.mjs --api-e2e`
  (backend flipped to API-only, 12 suites / 123 tests, restored to enabled
  mode): green; full fast-verify (REST docs, test-count, unit, lint, types)
  green alongside it. No app code changed this round.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh, via verify).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, and the Round 93 `next build` +
  bundle-size guard remain green on this tree (no frontend changes this
  round; build re-verified in Round 93 with `/agent` 485 KiB).
- Browser E2E (real Chrome over CDP, enabled mode): full default all-eleven
  journeys green post-refactor, zero errors.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-round
  archives live in git history via committed `report-<mode>.json` (by design).
- **Low** — the lazy panels connect through a wide controlled-prop surface
  (~25 sessions / ~45 channels props); a shared context/store could tighten
  that later if prop drift becomes painful.
- **Low** — `e2e/report-api-only.json` is stale (last refreshed pre-Round-87);
  the API-only browser journey should be re-run against a disabled scheduler.

## Next round focus

1. **Refresh the API-only browser E2E** — run `E2E_API_ONLY=1` with
   `CRON_SCHEDULER_ENABLED=false` (then restore enabled mode) and commit the
   refreshed `report-api-only.json`.
2. **Lazy-chunk regression guard** — extend `e2e/browser-e2e.mjs` to assert
   the sessions/channels panel chunk is absent from the eager `/agent` load
   and only fetched when a tab opens, so the split cannot silently regress.
3. **Optional tightening** — audit the agent-views prop surface for a lighter
   connection pattern if no higher-value ticket appears.
