# Round 100 — visibilitychange channel refresh (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 99's focus item #1: the Channels view now refreshes
immediately when the tab returns, instead of waiting up to 8s for the next
polling tick. The 0–8s staleness on return was user-visible in practice
(tab switches are exactly when a fresh feed matters), so the change was
adopted and pinned by an extended browser E2E guard.

## What changed this round

- **Immediate refresh on `visibilitychange`** — `frontend/app/agent/agent-client.tsx`
  now listens for `visibilitychange` in the Channels polling effect and calls
  `loadChannels()` the moment the tab returns to visible; the 8s visibility-gated
  tick still covers the hidden/open case, and the listener is removed in effect
  cleanup. Commit `2f66233`.
- **E2E guard extended** — the `agentChannelFlow` polling guard first proves
  polling stays fully hidden while the tab is hidden (>2 intervals, zero list
  fetches), then restores visibility and now asserts an immediate resume
  within 2s (`immediateCount > hiddenCount`) plus resumed tick activity
  (`resumedCount > hiddenCount`). Log line:
  `visibility polling guard: hidden kept 2/2, immediate resume 1, resumed 4 (ok)`.
- **Frontend container rebuilt** with the Round 100 build
  (`docker compose build frontend && up -d --force-recreate frontend`).
- **Both browser modes green** — enabled-mode run and API-only mode run
  (fresh this round): 21 route probes each, zero console/network errors,
  all journeys passed. API-only mode also re-proved the startup-race stale
  sweep (`stale sweep: clean`).
- **README updated** — Channels bullet documents the visibility-gated 8s
  polling + immediate resume on tab return; the E2E description notes the
  resume-within-2s guard; the headroom baseline was remeasured after the
  feature (page chunk +153 B) and updated.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via
  `verify --build --api-e2e` this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, Nest + Next builds green; bundle-size
  guard `/agent` **484 KB / 8 chunks** within 600 KB; headroom guard
  **33.6 KB** agent-specific delta within the 44 KB budget (remeasured
  495,956 B vs 461,553 B baseline after the feature's +153 B page chunk).
- Browser E2E: **both modes re-run this round** — enabled and api-only,
  21 route probes each, zero console/network errors; polling guard
  `hidden 2/2, immediate resume 1, resumed 4 (ok)` in both; api-only mode
  kept `stale sweep: clean`. Reports committed
  (`e2e/report.json`, `report-enabled.json`, `report-api-only.json`).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-mode
  archives live in git history via committed `report-<mode>.json` (by design).

## Next round focus

1. **Optional** — try folding the 316 B `/agent` edge chunk into the page
   chunk (Turbopack emits it as a separate module edge; negligible, but a
   cheap clean-up if trivial).
2. **Optional** — deeper bundle profiling only when a new feature threatens
   the 44 KB `/agent` headroom budget; routine rounds don't need it.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser modes after any future frontend change; keep the baseline
   `/agent` 484 KB / 33.6 KB headroom.
