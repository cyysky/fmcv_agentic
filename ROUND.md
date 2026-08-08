# Round 90 — Connection-less agent walk + feed-format regression guard (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 89's first focus item (connection-less agent walk) and
closed the loop on the Round 89 timestamp fix with a regression guard in the
browser E2E.

## What changed this round

- **Connection-less agent walk (live Chrome, CDP)** — with zero saved
  connections and one persisted session, walked `/agent` end to end: Chat
  empty state (helpful "Ask the agent to do something…" example), model
  picker (active, both catalog models + Default gateway), Sessions tab
  (`SESSIONS (1)` row, localized session meta, empty-state hint), and
  Channels tab with pre-existing `#FMCV` (members, delete buttons, member
  debug pane, live feed). **No friction found** — zero console errors,
  zero failed network requests, zero exceptions. The pre-existing `#FMCV`
  feed renders localized timestamps (`8/5/2026, 4:14:06 PM`); the raw UTC
  values seen once were a stale pre-fix tab that resolved on reload.
- **Feed-format regression guard (`e2e/browser-e2e.mjs`)** — the channel
  journey now fails the run if the feed contains a raw UTC ISO timestamp
  (`AAAA-MM-DDTHH:MM:SS`) or shows no local-time timestamp, so the shared
  local-time formatting fix cannot silently regress. Proved live: agent
  journey green, feed snippet all `8/9/2026, 1:39:43 AM`-style.
- **Docs** — `e2e/README.md` documents the new feed-format assertion in the
  channel journey.
- **E2E report refresh** — enabled-mode report updated by the agent-journey
  run with the guard active (zero console/network/HTTP errors).

## Test status

- Backend unit: **14 suites / 182 tests passed.**
- Backend API E2E (real Postgres, mode flip + restore, run earlier this
  session): **12 suites / 123 tests passed** (known Jest keep-alive warning
  only).
- Frontend: `tsc --noEmit`, ESLint, `next build` — all green; backend
  `nest build` green.
- Guards: REST docs drift and test-count guards pass.
- Browser E2E (enabled mode): **agent journey green with the new feed-format
  guard**; routes/agent/buckets/skills and cron journeys were also green
  this session (Round 89 runs, un-changed code paths).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- **Low** — `E2E_JOURNEYS` is a flat list, not per-mode shorthands; users
  must spell out the flows they care about (a `cron-only` / `ui-only`
  preset could come later).
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Bundle/frontend hygiene** — inspect `next build` size output for
  large/duplicated client bundles and ticket real wins.
- **Journey presets** — add `E2E_JOURNEYS=cron-only|ui-only|core` shorthands
  so quick runs are one word instead of a flow list.
- **Full default browser E2E run** — exercise all ten journeys together for
  the first time since the feed-format guard landed, and refresh the
  report accordingly.

## Loop state

Loop state: running — Round 90 walked the connection-less agent journey
(friction-free), proved the Round 89 local-time fix live on pre-existing
channel history, and added a browser-E2E guard so raw UTC feed timestamps
fail the suite. No exit condition fires; proceed to Round 91.
