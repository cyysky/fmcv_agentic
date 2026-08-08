# Round 93 — full default E2E + lazy agent-client split (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 92's focus items: the full default browser E2E run, then the
lazy `agent-client.tsx` split.

## What changed this round

- **Full default browser E2E run (all eleven journeys)** — first time since
  the Round 89 feed-format guard; every flow green with zero console/network/
  HTTP errors, report refreshed (`e2e/report.json` + `report-enabled.json`).
- **Lazy agent-client split** — `frontend/app/agent/agent-client.tsx` went
  from 2390 to ~1360 lines. Shared types moved to `agent-types.ts`; the
  sessions and channels tab panels (plus their member-debug/live-job/project-
  tree subcomponents) moved to `agent-views.tsx`, loaded via
  `next/dynamic({ ssr: false })` from `AgentPage`. State and handlers stay in
  `AgentPage`; the panels are controlled components whose prop names mirror
  the original locals, so the moved JSX is byte-identical.
- **Slimmer `/agent` first load** — pre-split page chunk ~50 KB; after the
  split the eager `/agent` first load is 512.6 KB → 496.4 KB (-16 KB) with a
  ~23 KB panel chunk fetched only when a tab opens. Bundle guard passes:
  largest first load `/agent` 485 KiB within the 600 KB budget.
- **Docs** — README bundle-baseline section rewritten with the Round 93
  numbers and the lazy-split note.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh run this round).
- Backend API E2E (real Postgres): **12 suites / 123 tests passed** earlier
  this session (known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, `next build`, backend `nest build` —
  all green via `node scripts/verify.mjs --build`; REST docs, test-count,
  and bundle-size guards all pass.
- Browser E2E (real Chrome over CDP, enabled mode): full default run of all
  eleven journeys green pre-refactor; post-refactor proof run
  `E2E_JOURNEYS=core,sessions` (routes+agent+cron+sessions) green with zero
  errors against the rebuilt frontend container running the new build.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via committed reports (by design).
- **Low** — the lazy panels are connected through a wide controlled-prop
  surface (~25 sessions / ~45 channels props); a shared context/store could
  tighten that later if prop drift becomes painful.
- **Low** — the post-split full default run (all eleven journeys against the
  lazy panels) has not been re-run as a single command yet.

## Next round focus

1. **Full default post-refactor E2E run** — all eleven journeys together
   against the lazy panels; refresh the report and log any friction.
2. **Re-run the API E2E suite fresh** (`--api-e2e`) to refresh the 123-test
   evidence for the round handoff.
3. **Optional tightening** — if the full run surfaces panel interactions
   (e.g. tab-switch state), address those, then audit the agent-views prop
   surface for a lighter connection pattern.
