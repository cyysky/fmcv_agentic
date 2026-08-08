# ROUND 64 — 2026-08-08 (autonomous iteration round 64)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. The
human asked the loop to run again ("read on loop.md and do works"), so this
round's goal was the Round 63 handoff's top concrete candidate: **bucket
delete/rename endpoints**.

## What changed this round

- **Backend bucket rename + delete** — `PATCH /api/buckets/:id` and
  `DELETE /api/buckets/:id`. Rename validates 3–64 chars/name conflicts
  (409 with `bucketNameExists`), moves the agent folder on disk, rolls the
  DB back if the move fails, treats same-name renames as idempotent no-ops,
  and guards against path escape. Delete removes the folder, then deletes
  child documents + the bucket in one transaction and restores the folder if
  the DB step fails.
- **Buckets UI** — each row gains an inline Rename form (aria-labelled
  input, Save/Cancel) and a two-click Delete confirm (`Delete` → `Confirm
  delete`); badge copy now says documents are read-only while buckets can be
  renamed or deleted.
- **Docs + E2E updated** — README REST tables/prose/journey docs cover the
  new endpoints; the browser buckets journey now renames through the UI
  (document survives) and deletes via the two-click confirm, with cleanup
  through the new DELETE API (psql only as fallback/verification).
- **Browser E2E probe drift fixed** — the buckets route probe still expected
  the old "Read-only" badge string after the copy change; updated to
  "Documents are read-only" and re-ran green.
- **LLM auth restored for the dev stack** — browser E2E was failing with LLM
  401 because the backend's `AGENT_API_KEY` was empty. The app's gateway is
  the local LiteLLM on port 9999; the backend now receives LiteLLM's master
  key via a gitignored root `.env` (`AGENT_API_KEY` is interpolated by
  `docker-compose.yml`; never committed — mirrors the existing
  `backend/.env` convention).

## Test status

- Backend unit: **154 passed / 14 suites** (26 bucket service tests
  included); API E2E: **111 passed / 10 suites** (18 bucket e2e tests
  included: rename moves folder, invalid rename 400, rename-to-taken 409 +
  conflict delete, delete removes folder/rows/404s); backend
  `npx tsc --noEmit` clean.
- Frontend `npx tsc --noEmit` + `npx eslint app/buckets` + `next build`
  clean (build also ran inside the rebuilt Docker image).
- Docs guard: `node scripts/verify-rest-docs.mjs` passes (66 routes vs 65
  docs rows; the bare `GET /api` hello probe is intentionally undocumented).
- Browser E2E: "All browser E2E checks passed" against the rebuilt frontend
  — 21+ route probes (light/dark/mobile) plus nav, channel, mobile channel
  dashboard, sessions/connection, files, HTML view, buckets (create →
  duplicate 409 → upload → duplicate upload 409 → download → reload persist →
  UI rename with document surviving → two-click delete), cron, skills, and
  settings journeys; console/network/HTTP errors zero across every flow
  (the only HTTP 409s are the intentionally expected duplicates).
- Baseline confirmed after the run: no leftover bucket/session/connection/
  cron/skill fixtures; workspace volume holds only default folders.

## Known issues / open tickets

- **None open.** Accepted limitations unchanged from Round 62:
  CSP `sandbox` disables scripts/forms/external navigation in the inline
  HTML preview; the cron scheduler ticker runs in-process (single-instance
  deployment assumed); `AGENT_API_KEY` is not committed (the dev stack reads
  it from the gitignored root `.env`; fresh stacks must supply it or use
  `AGENT_LLM_STUB=1`).

## Next round focus

- **Decouple the cron scheduler from the single NestJS instance** — the
  in-process ticker is the oldest accepted limitation and the top remaining
  concrete item (e.g. a dedicated scheduler service or DB-backed lease so
  multiple replicas don't double-fire).
- **Re-verify buckets rename/delete under a second scope** — e.g. a
  group/agent scope, asserting the folder path change through the workspace
  API.
- Any DIRECTION.md instruction.

## Loop state

Loop state: running — Round 64 delivered working bucket rename/delete
endpoints with a fully green gate and a green browser run. No exit condition
fires; proceed to Round 65.
