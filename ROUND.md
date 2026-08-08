# ROUND 24 — 2026-08-08 (autonomous iteration round 24)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
human direction (managed document buckets, cron jobs, agent skills). This
round fulfils DIRECTION item 1 as a small, committable backend slice: managed
**document buckets** — unique, read-only bucket names mapped to project or
agent folders, with immutable uploaded documents (list/read/download only).

## What changed this round

- **Bucket + ManagedDocument schema** — migration `20260808064954_add_buckets`
  adds `Bucket` (unique `name`, `folderType` project/agent, `folderName`,
  timestamps, `documents` relation) and `ManagedDocument` (unique
  `[bucketId, name]`, `kind` pdf/text/video/audio/other, `mimeType`,
  `sizeBytes`); applied to the running DB and `prisma generate` re-run.
- **Buckets API** (`backend/src/buckets/`) — `POST /api/buckets` (validates the
  mapped project/agent folder exists, creates `<folder>/<bucket>/`, 409 on
  duplicate name with folder rollback), `GET /api/buckets` (with document
  counts), `GET /api/buckets/:id`, `GET /api/buckets/:id/documents`, `POST
  /api/buckets/:id/documents` (multipart memory-buffered upload, 100 MB cap,
  sanitized filename, kind derived from MIME then extension, `wx` create so a
  duplicate name always 409s and nothing is ever overwritten), and `GET
  /api/buckets/:id/documents/:documentId/download` (attachment headers +
  byte-exact stream). No update/delete/overwrite endpoints exist — buckets and
  documents are read-only by design.
- **Tests** — 18 new unit tests (`buckets.service.spec.ts`) and 14 new API E2E
  tests (`test/buckets.e2e-spec.ts`, real Postgres + temp workspace): create →
  duplicate 409 → invalid type/missing project/unknown agent 400s → list with
  counts → get-one → 404 unknown bucket → PDF upload (kind/mime/size) →
  duplicate name 409 → missing multipart field 400 → list after upload →
  download bytes + attachment headers → 404 missing document. The e2e spec is
  fully type-safe (typed `json<T>` helper; no `no-unsafe-*` noise).
- **Runtime verified** — backend container rebuilt with the buckets code
  (`AGENT_API_KEY` injected from the local provider config, never committed)
  and the journey walked by hand over HTTP: bucket create/list, upload/list,
  duplicate 409s, download with `Content-Type` +
  `Content-Disposition: attachment` + correct byte length; manual artifacts
  cleaned up afterwards.
- **Docs** — README gained a bucket feature bullet, a `/api/buckets*` REST
  table, and refreshed test counts; CHANGELOG gained the Round 24 entry.

## Test status

- Unit: **112 passed / 12 suites** (`npm test`).
- API E2E: **79 passed / 8 suites** (`npm run test:e2e`, real Postgres).
- Backend: `nest build` + `tsc --noEmit` clean; eslint clean on new
  `src/buckets` files + `test/buckets.e2e-spec.ts`; migration applied.
- Browser E2E: exit 0, zero console/network errors on all 12 route probes and
  the nav/channel/files/settings/sessions journeys against the rebuilt
  backend (report + screenshots refreshed). Buckets are API-only this round,
  so the browser E2E does not cover them yet.
- Manual HTTP journey: bucket create/list, upload/list/download, duplicate
  bucket 409 + document 409, attachment headers verified.

## Known issues / open tickets

- No buckets UI yet — the feature is API-only; `/files` remains the only
  human-facing workspace browser (open next round).
- Uploads are memory-buffered via `FileInterceptor` with a 100 MB cap; a later
  slice can stream/buffer to disk for larger files.
- Buckets have no delete/rename endpoints by design (read-only); there is no
  admin/cleanup path yet for removing a bucket or its folder.
- Browser E2E does not exercise buckets (no UI to drive).
- `AGENT_API_KEY` must be supplied at backend container start (e.g. from the
  local Codex provider config); it is deliberately not committed.

## Next round focus

1. **Buckets UI + browser E2E** (finish DIRECTION.md item 1) — a `/buckets`
   (or `/settings`-adjacent) page: create bucket (project/agent folder),
   upload/list/download documents, reload persistence, plus a browser E2E
   journey.
2. **Cron jobs** (DIRECTION.md item 2) — create/manage cron jobs (schedule +
   recurring task runner).
3. **Agent skills** (DIRECTION.md item 3) — agents can create, install, and
   use skills.

Round summary: **Round 24: managed document buckets backend landed — unique
read-only buckets mapped to project/agent folders with immutable managed
documents (upload/list/download), fully unit + API-E2E covered and verified by
hand over HTTP.** Tests: 112 unit + 79 API E2E passed / 0 failed; browser E2E
exit 0, zero console/network errors. Committed as git tag `round-24`. Next:
buckets UI + browser E2E · cron jobs · agent skills. Exit checked:
none — continuing (human direction active).
