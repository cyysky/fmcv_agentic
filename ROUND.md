# Round 92 — E2E journey presets: one-word quick runs (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 91's first focus item (journey presets for `E2E_JOURNEYS`),
closing the "flat list, not per-mode shorthands" ticket.

## What changed this round

- **`E2E_JOURNEYS` presets** — `e2e/browser-e2e.mjs` maps one-word shorthands
  to explicit flow lists: `cron-only` = `routes,cron`; `ui-only` =
  `routes,nav,mobile,html,settings,skills`; `core` = `routes,agent,cron`.
  Presets are mixable with plain flow names (`core,skills`) and expand inside
  the existing selection parser, so `want()` and the report's `journeys`
  field reflect the real executed flows.
- **Docs** — the `E2E_JOURNEYS` row in `e2e/README.md` documents the three
  presets and mixability; README Testing block now shows `E2E_JOURNEYS=core`.
- **Live proof runs (`E2E_JOURNEYS=cron-only`, `ui-only`, `core`)** — all
  three presets green with zero console/network/HTTP errors; report shows the
  expanded journeys list for each run (latest committed = `ui-only` run:
  `routes,nav,mobile,html,settings,skills`).

## Test status

- Backend unit: **14 suites / 182 tests passed.**
- Backend API E2E (real Postgres, run earlier this session): **12 suites /
  123 tests passed** (known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, `next build`, backend `nest build` — all
  green in Round 91; bundle-size guard passes at the 600 KB budget.
- Browser E2E (real Chrome over CDP, enabled mode): `cron-only` (17/17 cron
  steps), `core` (routes+agent+cron), and `ui-only` (routes+nav+mobile+html+
  settings+skills) — all green, zero errors.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- **Ticket** — `frontend/app/agent/agent-client.tsx` is a ~1.5 MB single
  client file (composite of chat, sessions, channels, member debug); split
  into lazy-loaded views.
- **Low** — the full default run (all eleven flows, `E2E_JOURNEYS=all`) has
  not been executed since the Round 89 feed-format guard landed.

## Next round focus

1. **Full default browser E2E run** — `E2E_JOURNEYS=all` (all eleven flows
   together, first time since the feed-format guard) and refresh the report.
2. **Lazy agent-client split** — split the ~1.5 MB `agent-client.tsx` into
   lazy-loaded views if the full run lands cleanly.
3. **Re-run the unit + API E2E suites** once before the handoff if the full
   run makes any UI changes.
