# Round 96 — context-backed agent panels (prop-drill bloat removed) (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 95's first focus item: the lazy sessions/channels panels no
longer consume ~25 sessions / ~45 channels controlled props drilled through
AgentPage; they read the same values from shared context, and the lazy chunk
split is proven intact on both E2E modes.

## What changed this round

- **Context-backed lazy panels** — new `frontend/app/agent/agent-context.ts`
  defines `SessionsPanelValue` / `ChannelsPanelValue` plus
  `SessionsPanelContext` / `ChannelsPanelContext` and `useSessionsPanel` /
  `useChannelsPanel` hooks. AgentPage now wraps each dynamic panel in its
  provider (`agent-client.tsx`), and the panels read their state through the
  hooks instead of destructuring props (`agent-views.tsx`). ~180 lines of
  prop-interface/signature threading removed; panel JSX unchanged.
- **Lazy split kept** — the context module is tiny and lands in the eager
  bundle while the panel JSX stays deferred. Bundle guard still reports
  `/agent` 485 KB / 8 chunks; the E2E lazy-chunk guard on both modes shows 14
  eager / 1 lazy chunk with the panel marker only in `3w62qozxqps9r.js`.
- **Fresh full verify** — `node scripts/verify.mjs --build --api-e2e` green
  (REST docs + test-count guards, backend unit, backend/frontend lint + type
  checks, `nest build`, `next build`, bundle-size guard, API E2E, backend
  restored to enabled mode).
- **Both browser E2E modes on the rebuilt stack** — frontend container
  rebuilt with the refactor; full all-journey runs green in enabled and
  API-only modes (21 route probes each, zero console/network/HTTP errors),
  guard evidence refreshed in `report-enabled.json` + `report-api-only.json`.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via verify this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, and `next build` green (no warnings in
  the touched agent files); bundle guard largest first-load **485 KB
  (`/agent`, 8 chunks)** within the 600 KB budget.
- Browser E2E (real Chrome over CDP): full all-journey runs green in both
  enabled and API-only modes — 21 route probes each, zero errors; lazy-chunk
  guard verified on both runs (14 eager / 1 lazy, marker only in the lazy
  chunk).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-round
  archives live in git history via committed `report-<mode>.json` (by design).
- **Closed this round** — wide controlled-prop surface on the lazy panels
  (context providers/hooks now carry the same state; a future store/reducer
  remains an option if more panels appear).

## Next round focus

1. **Shave the remaining eager `/agent` first load** — the 485 KB route is
   still ~115 KB under budget; candidates are the models/connections pickers
   and workspace viewer glue still compiled into the eager page chunk, as
   long as the lazy-chunk guard stays green.
2. **Keep the E2E gate current** — re-run `verify --build --api-e2e` plus the
   full enabled/API-only browser E2E after any frontend change, and re-check
   the bundle guard baseline (485 KB `/agent`).
3. **Optional** — benchmark panel open/close render cost and, only if it
   shows, move channel polling (8s interval) behind the active tab's
   visibility so idle `/agent` tabs stay quiet.
