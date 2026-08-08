# Round 89 — Agent/journal friction sweep: local-time feed timestamps (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 88's first focus item (agent/journal friction sweep):
walked the agent journey in live Chrome, found the channel feed rendering
raw UTC ISO timestamps, and fixed it with one shared local-time formatter.

## What changed this round

- **Shared local-time formatting (`frontend/lib/time.ts`)** — new
  `formatTime()` / `formatTimeShort()` helpers (localized
  `8/9/2026, 1:34:38 AM`-style display, raw ISO fallback for unparseable
  input). The channel message feed, session list, and member-status line in
  `agent-client.tsx` now use them; `cron-client.tsx` drops its local
  duplicate in favor of the shared `formatTime`.
- **Duplicate helper cleanup** — `buckets-client.tsx` and
  `skills-client.tsx` had byte-for-byte copies of the same formatter; both
  now import from `frontend/lib/time.ts` (no behavior change).
- **Docs** — README Channels section documents the local-time feed/session/
  member-status timestamp display.
- **E2E report refresh** — enabled-mode report re-run covering `routes`,
  `agent`, `buckets`, and `skills` journeys, zero console/network/HTTP
  errors; the agent flow's `feedSnippet` proves localized feed timestamps
  (`8/9/2026, 1:34:38 AM`, not `T…Z`). A separate `cron`-only run also went
  green earlier in the round.

## Test status

- Backend unit: **14 suites / 182 tests passed.**
- Backend API E2E (real Postgres, mode flip + restore): **12 suites /
  123 tests passed** (suite exits 0; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, `next build` — all green; backend
  `nest build` green.
- Guards: REST docs drift and test-count guards pass.
- Browser E2E (enabled mode, real Chrome over CDP): **all journeys green** —
  `routes,agent,buckets,skills` (0 console errors / 0 net failures / 0 HTTP
  errors) and a separate `cron` run; stale-sweep clean, fixtures cleaned.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- **Low** — `E2E_JOURNEYS` is a flat list, not per-mode shorthands; users
  must spell out the flows they care about (a `cron-only` / `ui-only`
  preset could come later).
- **Open** — connection-less default-provider agent walk (no saved
  connections, fresh-state empty channels/sessions) was not yet exercised
  this round; the walk here used the provisioned connections.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Connection-less agent walk** — with no saved connections and an empty
  channel/session state, walk `/agent` and log empty states / confusing
  notices / stale fetch after save; fix what is cheap (this round's
  friction sweep used provisioned connections only).
- **Bundle/frontend hygiene** — inspect `next build` size output for
  large/duplicated client bundles and ticket real wins.
- **Journey presets** — add `E2E_JOURNEYS=cron-only|ui-only|core` shorthands
  so quick runs are one word instead of a flow list.

## Loop state

Loop state: running — Round 89 fixed the raw-UTC timestamp friction found
during the agent/journal sweep, consolidated four duplicate formatters into
one shared helper, and left every suite and the browser E2E green. No exit
condition fires; proceed to Round 90.
