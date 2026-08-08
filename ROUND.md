# Round 98 — visibility-gated channel polling + startup-safe stale sweep (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 97's focus item #3: the `/agent` channel-list refresh now
stops polling while the tab is hidden, guarded by a browser E2E test that
proves the network goes quiet and resumes on return. Also fixed an E2E
harness flake where the pre-run stale sweep could fail right after a
container recreate while the backend was still binding its port.

## What changed this round

- **Visibility-gated channel polling** — `frontend/app/agent/agent-client.tsx`:
  the 8s channel-list refresh skips `loadChannels()` whenever
  `document.visibilityState === "hidden"` and resumes on the next interval
  tick when the tab becomes visible again; idle background tabs no longer
  poll `/api/channels` every 8s.
- **Polling E2E guard** — `agentChannelFlow()` in `e2e/browser-e2e.mjs`
  records `/api/channels` list responses via CDP `Network.responseReceived`,
  opens a spare `about:blank` tab to hide the agent tab (visibility flips
  verified), waits two+ poll intervals with zero list fetches while hidden,
  then restores the tab and asserts refreshes resume (baseline 2 / hidden 2 /
  resumed 3 on both modes; tracked as `flow.pollingGuard`).
- **Startup-safe stale sweep** — `staleSweep()` retries each list read
  (channels, sessions, connections, cron, skills, workspaces) up to 5 times
  with a 2s pause; the earlier API-only flake (`fetch failed` x6 immediately
  after `--force-recreate backend`) is gone — the recreated backend comes up
  under the retries and the suite exits clean.
- **README bundle docs refreshed** — eager-chunk inventory and the 484 KB
  `/agent` baseline updated.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via
  `verify --build --api-e2e` this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, Nest + Next builds green; bundle guard
  largest first-load **484 KB (`/agent`, 8 chunks)** within the 600 KB budget.
- Browser E2E (real Chrome 151 over CDP): full all-journey runs green in
  **both** enabled and API-only modes — 21 route probes each, zero
  console/network errors; workspace-viewer lazy guard 14 eager / 1
  workspace-lazy / 1 panel-lazy on both; visibility polling guard
  `baseline 2 / hidden 2 / resumed 3` on both; stale sweep clean on both.
  Reports refreshed in `report-enabled.json` + `report-api-only.json`.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-mode
  archives live in git history via committed `report-<mode>.json` (by design).
- **Closed this round** — hidden `/agent` tabs kept polling channels every 8s
  (now gated behind tab visibility with an E2E guard); API-only E2E flaked on
  backend startup after a container recreate (now retried in the stale sweep).

## Next round focus

1. **Measurement-only eager `/agent` headroom pass** — compare `/agent`
   (484 KB / 8 chunks) against the framework baseline (`/`, `/files`) in
   `frontend/.next/diagnostics/route-bundle-stats.json`; the remaining
   first-load agent code is the composer, trace viewer, and the
   models/connections header pickers by design. Split a picker only if
   profiling shows it costs >~5 KB; otherwise leave the route as-is.
2. **Optional** — refresh channels immediately on `visibilitychange` when the
   tab returns (today the first visible refresh waits for the next 8s tick);
   implement only if the 0-8s staleness on return is user-visible in practice.
3. **Keep the E2E gate current** — after any future frontend change, re-run
   `verify --build --api-e2e` + both browser modes and keep the 484 KB
   `/agent` baseline.
