# Round 108 — buckets service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 107's next-focus item 1: lifted `buckets.service.ts` from
79.45% to 100% lines (96.89% stmts / 95.91% branch).

## What changed this round

- **Upload naming edges** — long names are capped at 180 chars with the
  extension preserved; empty/undefined `originalname` falls back to
  `'document'`; uploads without a usable buffer are rejected.
- **`listDocuments` delegation** — checks bucket membership, then delegates
  to `findMany` with the correct where/orderBy.
- **`createBucket` failure paths** — non-unique DB errors are rethrown with
  the folder rolled back; folder-creation failures are wrapped as
  BadRequest; a project folder path that is a file is rejected
  (`is not a folder`).
- **`resolveDownload` edges** — 404 when the stored document is missing;
  metadata fallback to `application/octet-stream` for a null mime type with
  a real file on disk.
- **`renameBucket` failure paths** — non-ENOENT target inspection →
  BadRequest; ENOTEMPTY move → Conflict; other move errnos (EACCES)
  rethrown; DB-update failure rolls the folder back (unique violation →
  Conflict, generic → BadRequest).
- **`deleteBucket` failure paths** — folder-removal failure wrapped as
  BadRequest; a failing transaction restores the folder.
- **`addDocument` write/DB failures** — non-EEXIST store failures wrapped as
  BadRequest; the stored file is removed when the document row create fails
  (unique violation → Conflict, generic → rethrown).

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 219
  tests passed** (+16 this round), backend lint + types, frontend types +
  lint.
- Coverage run green: `buckets.service.ts` **79.45% → 100% lines**
  (96.89% stmts / 95.91% branch); the three remaining uncovered statements
  are nullish-fallback/constructor quirks in `sanitizeFileName`,
  `deriveDocumentKind`, and the constructor — no reachable code left.
  `channel.service.ts` stays 99.04% (dead `SLUG_RE` guard),
  `channel-job.service.ts` and `workspace-tools.ts` stay at 100% lines.
- Full build gate not re-run (test-only change, no runtime code touched):
  Round 100's `verify --build --api-e2e` remains green — API E2E 12/123,
  bundle `/agent` 484 KB / 8 chunks, headroom 33.6 KB within 44 KB.
- Browser E2E: not re-run (no frontend runtime change); Round 100 enabled +
  api-only runs (21 route probes each, zero console/network errors) remain
  current.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Open** — `channel.service.ts` line 67 (`SLUG_RE` guard) is dead by
  construction; decide in a runtime round whether to delete it or keep it
  as defense-in-depth.
- **Open** — `files.service.ts` is now the lowest service at 88.8% lines
  (uncovered: 72, 105-106, 109, 116, 125, 224-228, 264, 276, 328, 338).

## Next round focus

1. **Cover `files.service.ts`** — extend `files.service.spec.ts` toward the
  90%+ service bar, targeting the listed file lifecycle/validation paths;
  re-run fast verify + coverage after.
2. **Decide the dead `SLUG_RE` guard** — a small runtime cleanup
  (remove the unreachable branch) needs the full build + API E2E + browser
  gates; only worth doing bundled with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
