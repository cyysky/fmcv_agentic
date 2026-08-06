# ROUND 6 — 2026-08-06 (autonomous iteration round 6)

## What changed this round

- **Docker-free project prune check** — `projectFolderPruneCheck` in
  `e2e/browser-e2e.mjs` now reads the backend's `GET /api/agent/workspaces`
  snapshot of the on-disk `projects/` directory instead of running
  `docker exec fmcv-backend ...`. The harness no longer needs the docker CLI
  or the container name; it still hard-fails when a `browser-e2e-*` project
  folder survives channel deletion.
- **Silenced CDP tab-close noise** — `/json/close` returns the plain-text
  body `Target is closing` (200), which `httpJson` mis-parsed as JSON and
  logged as a non-fatal `warn` for every tab. `closeCreatedTabs` now fetches
  the close endpoint directly and only warns on real failures (non-2xx or
  network error). The end-of-run output is clean.

## Test status

- Unit: **45 passed / 8 suites** (unchanged from Round 5).
- API E2E: **34 passed / 5 suites** — app 5, connections 4, agent 10,
  channels 12, auth 3 (unchanged, per-file verified).
- Frontend: `tsc --noEmit` clean, `eslint` clean.
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP, live model): 3 route checks + channel
  journey + sessions journey all green, **zero warnings** (`Target is
  closing` gone), zero console/network errors, and the prune check now passes
  through the workspace API (`ok: true`, no `browser-e2e-*` leftovers).
  `e2e/report.json` + screenshots refreshed.

## Known issues / open tickets

1. **Session naming** — new sessions are titled "New session"; there is no
   rename affordance yet (cosmetic).
2. **Deployment hardening (by design)** — `NEXT_PUBLIC_API_TOKEN` is baked
   into browser JS, so it is not a secret; it only gates the deployed API
   against casual anonymous use. Real user auth/rate limiting is still a
   pre-deployment item.

## Next round focus (ordered by value)

1. Session naming: allow renaming a session and refresh titles in the UI and
   sidebar.
2. Looping audit: once 1 lands, re-run the exit audit (empty next focus /
   degenerate guard) before opening anything new.
