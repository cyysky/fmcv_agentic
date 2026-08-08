# ROUND 25 — 2026-08-08 (autonomous iteration round 25)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
active human direction (managed document buckets, cron jobs, agent skills,
HTML view). Round 24 landed the buckets backend; this round finishes
DIRECTION item 1 with the **buckets UI + browser E2E**, then hands off to
cron jobs.

## What changed this round

- **Buckets UI (`/buckets`)** — new Next.js page + client component wired to
  the Round 24 API: loads agent/project workspaces, lists buckets (with
  document counts), creates a bucket (unique name, folder type
  project/agent, folder name from the live workspace list), opens a bucket
  detail, uploads documents via FormData, downloads via blob + anchor,
  reload-persists, and shows a read-only notice. Duplicate bucket names and
  duplicate uploads render the API's 409 as a dismissible in-page error
  banner; per-document kind badges (pdf/text/video/audio/other), sizes, and
  upload timestamps are displayed. Dark-mode friendly + responsive
  (`buckets.module.css`); `/buckets` is in the global nav and home page now
  has an `Open Buckets` CTA.
- **Browser E2E buckets journey** (`e2e/browser-e2e.mjs`) — creates a bucket
  through the UI (agent folder), proves a duplicate bucket name 409s in-page,
  uploads a text document, proves a duplicate upload 409s (immutable
  documents), downloads via CDP `Browser.setDownloadBehavior` and
  byte-compares the saved file, reloads and verifies bucket + document
  persistence, then removes fixtures server-side (files API for physical
  files + psql rows in the compose `fmcv-db` container via
  `bucketRowsByNameLike` / `deleteBucketRowsFor`; buckets expose no delete
  endpoint by design). Route probes now cover `/buckets` light/dark/mobile;
  the global-nav journey clicks through `/buckets`.
- **E2E harness: expected-4xx handling** — `wireErrorCapture` accepts an
  `allowedStatuses` option: intentionally triggered responses (buckets: 409)
  and their browser log lines are recorded under `expectedHttp` rather than
  counted as page-quality failures. Fixed a buckets-gate bug that read
  `flow.downloadVerified` (files-shaped) instead of
  `flow.result.downloadVerified`, so a fully passing journey falsely failed.
- **Docs** — README buckets bullet now describes the `/buckets` UI (was
  "API only; UI planned") and the browser-E2E paragraph covers all five
  routes + the buckets journey; e2e README download wording matches the
  actual saved-to-disk verification; CHANGELOG gained this entry.

## Test status

- Backend unit: **112 passed / 12 suites** (`npm test`).
- API E2E: **79 passed / 8 suites** (`npm run test:e2e`, real Postgres).
- Backend `nest build` clean; `tsc --noEmit` clean; scoped eslint clean
  (`src/buckets/**/*.ts` + `test/buckets.e2e-spec.ts`). Note: full-repo
  backend `npm run lint` still reports a pre-existing backlog of 377 errors
  across legacy files untouched this round (unchanged at HEAD).
- Frontend: `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E: exit 0 — 16 route probes (`/`, `/settings`, `/agent`,
  `/files`, `/buckets` × light/dark/mobile) + nav, agent-channel,
  sessions/saved-connection, files, **buckets**, and settings journeys, all
  with zero console/network errors (the buckets journey's intentional 409s
  are recorded as expected). Screenshots + `e2e/report.json` refreshed;
  fixtures swept clean (channels/sessions/connections/buckets/project
  folders).

## Known issues / open tickets

- Buckets have no delete/rename endpoints by design (read-only); there is no
  admin/cleanup path yet — browser-E2E fixtures are cleaned via psql in the
  compose DB.
- Uploads are memory-buffered via `FileInterceptor` with a 100 MB cap; a
  later slice can stream/buffer to disk for larger files.
- DIRECTION item 2 (**cron jobs**) hasn't started; item 3 (**agent skills**)
  and item 4 (**view HTML by link / new tab-window**) remain open.
- Full-repo backend eslint backlog predates this round (legacy files).

## Next round focus

1. **Cron jobs** (DIRECTION.md item 2) — create/manage cron jobs (schedule +
   recurring task runner).
2. **Agent skills** (DIRECTION.md item 3) — agents can create, install, and
   use skills.
3. **View HTML** (DIRECTION.md item 4) — view HTML by link, or open it in a
   new tab or window.

Round summary: **Round 25: buckets UI + browser E2E landed — `/buckets`
create/upload/list/download with in-page 409s and reload persistence, driven
end-to-end by CDP (expected 4xx handling added to the harness), completing
DIRECTION item 1.** Tests: 112 unit + 79 API E2E passed / 0 failed; frontend
lint+tsc+build clean; browser E2E exit 0 with zero console/network errors.
Committed as git tag `round-25`. Next: cron jobs · agent skills · view HTML.
Exit checked: none — continuing (human direction active).
