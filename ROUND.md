# Round 91 — Bundle/frontend hygiene: measured + guarded (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 90's first focus item (bundle/frontend hygiene):
measured the `next build` first-load bundles, looked for duplicated client
modules, and added a bundle-size guard to the build gate.

## What changed this round

- **First-load bundle measurement** — parsed
  `frontend/.next/diagnostics/route-bundle-stats.json`: every route pays a
  ~451-513 KB uncompressed Next/React framework baseline (shared chunks,
  ~156 KB gzipped) plus a small page chunk (13-50 KB). No duplicated app
  modules were found: Turbopack emits each app module in exactly one chunk
  (checked `Default gateway`, `channelRow`, and page-specific identifiers
  across the static chunk set). `/agent` is the largest first load at
  ~501 KB uncompressed; `/cron` ~475 KB; the rest ~460-464 KB.
- **Bundle-size guard (`scripts/verify-bundle-size.mjs`)** — new
  zero-dependency script that reads `route-bundle-stats.json` after
  `next build` and fails the gate when any route's uncompressed
  first-load JS exceeds the budget (default 600 KB,
  `FMCV_BUNDLE_BUDGET_BYTES` override). Wired into
  `node scripts/verify.mjs --build` as a final step.
- **Docs** — README Testing block and the one-command-verify bullet
  document the new guard and the Round 91 baseline numbers.

## Test status

- Backend unit: **14 suites / 182 tests passed.**
- Backend API E2E (real Postgres, run earlier this session): **12 suites /
  123 tests passed** (known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, `next build` — all green; backend
  `nest build` green.
- Guards: REST docs drift, test-count, and the new bundle-size guard all
  pass — largest first-load `/agent` 501 KB within the 600 KB budget.
- Browser E2E: unchanged code paths (agent-journey run with the feed guard
  was green in Round 90; the full default run is scheduled for Round 92).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- **Low** — `E2E_JOURNEYS` is a flat list, not per-mode shorthands; users
  must spell out the flows they care about (a `cron-only` / `ui-only`
  preset could come later).
- **Ticket** — `frontend/app/agent/agent-client.tsx` is a ~1.5 MB single
  client file (composite of chat, sessions, channels, member debug).
  Route-level chunks stay small because Turbopack splits per page, but the
  file is a maintainability risk; a lazy component split is a candidate
  refactor, not worth the risk in a hygiene-only round.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Journey presets** — add `E2E_JOURNEYS=cron-only|ui-only|core` shorthands
  so quick runs are one word instead of a flow list.
- **Full default browser E2E run** — exercise all ten journeys together for
  the first time since the feed-format guard landed, and refresh the
  report accordingly.
- **Lazy agent-client split (ticket)** — split the heaviest client file
  into lazy-loaded views if the first two land cleanly.

## Loop state

Loop state: running — Round 91 measured the frontend bundles (no duplication;
~460-513 KB framework baseline per route, app chunks 13-50 KB) and locked the
baseline behind a budget guard in `verify --build`. No exit condition fires;
proceed to Round 92.
