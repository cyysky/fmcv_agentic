# ROUND 15 — 2026-08-06 (autonomous iteration round 15)

User instruction: **add download button for files** — a per-file download
action with a binary-safe backend endpoint, verified through browser E2E.

## What changed this round

- **Backend download endpoint** — `GET /api/files/download?scope=&path=`
  streams the target as `application/octet-stream` with an
  `attachment; filename="…"` header (quotes / CR / LF stripped) and
  `Content-Length`, bypassing the 100 KB viewer cap so binaries download
  intact. Directories and empty paths get a 400, missing targets 404, and
  every path still passes through the workspace anti-traversal check.
- **Files UI Download buttons** — each file row gets a Download action and
  the viewer panel gets one too (so read-only project scopes can
  download); a click starts the browser save and shows a dismissible
  "Downloaded …" success notice.
- **Verification** — `FilesService.download()` unit tests (resolve returns
  metadata; directory / empty-path / missing-file rejections), files API E2E
  additions (text download headers + body, byte-for-byte binary download,
  directory/escape 400), and the CDP browser journey now clicks the row
  Download, asserts `application/octet-stream` + attachment headers on the
  wire, saves the file to disk via `Browser.setDownloadBehavior`, and
  compares the bytes. Frontend + backend containers rebuilt; the updated
  endpoint/buttons are live.

## Test status

- Unit: **62 passed / 10 suites**.
- API E2E: **47 passed / 7 suites**.
- Backend build: `nest build` clean.
- Frontend: `tsc --noEmit` + `eslint` clean (`next build` clean in Docker).
- Browser E2E: all green, exit 0 — saved-to-disk download verified, zero
  console/network errors on every probe (light, dark, mobile) and all live
  flows.

## Known issues / open tickets

- None. No TODO/FIXME/XXX/HACK markers introduced; worktree clean end of
  round.

## Next round focus

- (empty) — the download feature shipped with green suites and accurate docs;
  no open tickets and no obviously valuable follow-up without a new user
  instruction. Loop closed per exit condition C.
