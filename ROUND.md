# Round 97 — workspace viewer moved out of the eager /agent load (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 96's first focus item: the workspace viewer — the last big
block of agent-tree JSX still compiled into the eager page chunk — is now a
lazy `next/dynamic` component, and the browser E2E guard proves it loads on
demand instead of with the page.

## What changed this round

- **Lazy workspace viewer** — new `frontend/app/agent/workspace-viewer.tsx`
  renders the agent/project trees (folders/files) and is fetched only when
  the header Workspace button reveals it. AgentPage keeps the workspace
  data/loaders (shared with the toggle via a new `WorkspaceViewerContext`,
  `ws`-prefixed to stay disjoint from the sessions/channels panel contexts),
  so caching, collapse state, and the Hide/Show label are unchanged.
- **Eager /agent first load shaved again** — `/agent` drops to **484 KB /
  8 eager chunks** (from 485 KB / 8 — route bundle stats: 497,014 → 495,766
  uncompressed bytes). Tree-render glue (~60 lines of JSX + helpers) left the
  page chunk; bundle guard still shows `/agent` as the largest route, under
  the 600 KB budget.
- **E2E lazy guard extended** — `agentChannelFlow` now opens Workspace before
  the Channels flow: asserts a NEW deferred chunk arrives, the viewer renders
  both Agents and Projects blocks with real folder names, and the panel
  marker (`"saved sessions yet"`) stays out of the eager set AND out of the
  workspace-viewer chunk. Guard shows 14 eager / 1 workspace-lazy / 1
  panel-lazy on both modes.
- **Fresh full verify + both browser modes** — `verify --build --api-e2e`
  green; frontend container rebuilt; full all-journey browser E2E green in
  enabled and API-only modes (21 route probes each, zero console/network
  errors), reports refreshed in `report-enabled.json` + `report-api-only.json`.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via verify this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, and `next build` green (incl. the new
  `workspace-viewer.tsx`); bundle guard largest first-load **484 KB (`/agent`,
  8 chunks)** within the 600 KB budget.
- Browser E2E (real Chrome 151 over CDP): full all-journey runs green in both
  enabled and API-only modes — 21 route probes each, zero errors; lazy-chunk
  guard on both runs: 14 eager / 1 workspace-lazy / 1 panel-lazy,
  workspace-viewer rendered `AGENTS` + `PROJECTS` with real folders.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-round
  archives live in git history via committed `report-<mode>.json` (by design).
- **Closed this round** — workspace viewer JSX in the eager `/agent` first
  load (now a lazy chunk with its own E2E guard).

## Next round focus

1. **Re-check eager `/agent` headroom after the viewer split** — the route is
  now ~115 KB under budget and only ~20 KB above the framework baseline
  (compare `/agent` vs `/files` in `route-bundle-stats.json`); the remaining
  agent-specific bytes are the chat composer, trace viewer, and the
  models/connections header pickers, which all render on first load by
  design. Consider a measurement commit only, or pick the picker dropdowns if
  a profiling pass shows them costing more than ~5 KB.
2. **Keep the E2E gate current** — the workspace-viewer guard now runs inside
  `agentChannelFlow`; remember to re-run `verify --build --api-e2e` plus both
  browser modes after any future frontend change, and keep the bundle guard
  baseline (484 KB `/agent`).
3. **Optional** — benchmark panel open/close render cost and, only if it
  shows, move channel polling (8s interval) behind the active tab's
  visibility so idle `/agent` tabs stay quiet.
