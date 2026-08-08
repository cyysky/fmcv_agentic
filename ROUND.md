# ROUND 28 — 2026-08-08 (autonomous iteration round 28)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
active human direction (managed document buckets, cron jobs, agent skills,
HTML view). Rounds 25–27 completed items 1–3; this round completes item 4
(**view HTML by link / open in a new tab-window**) end to end.

## What changed this round

- **Backend `GET /api/files/view`** — new endpoint that resolves a file like
  `download` but serves only `.html`/`.htm` inline: `text/html;
  charset=utf-8`, `Content-Disposition: inline`, `Content-Length`, CSP
  `sandbox`, `nosniff`, `Cache-Control: no-store`. 400 for empty
  path/directory, 404 for missing files, 415 for non-HTML content.
- **Files UI** — HTML files now preview in a sandboxed in-app `iframe`
  (bypassing the 100 KB read cap) and get an **Open in new tab** link that
  opens the same `view` URL in a new tab/window.
- **Unit +3** — view metadata/resolution (HTML inline with bytes unchanged,
  415 for `.txt`/no extension, 400 directory/empty path, 404 missing).
- **API E2E +3** — inline `text/html` headers + body, 415 non-HTML, 400
  directory/empty path (with a `plain.txt` fixture + `view.html` cleanup
  entry).
- **Browser E2E html-view journey** — creates a `view.html` fixture via the
  UI, asserts the sandboxed iframe preview + `/files/view` wire headers,
  opens **Open in new tab** with a trusted CDP mouse click (so the popup
  blocker doesn't swallow it), finds the new page target via `/json/list` and
  proves the marker + `<title>` render there, then deletes file + folder via
  the UI and verifies server-side cleanup. Stale sweep now also removes
  leftover `browser-e2e-files-*` / `browser-e2e-html-*` folders (emptied
  first) and `.dot-*` fixture files.
- **Docs** — README (file-manager feature bullet, `view` REST row, unit
  142→145, API E2E 101→104, files manager 9→12, browser-E2E paragraph +
  stale-sweep note), e2e README (html-view journey, screenshots, stale-sweep
  note), CHANGELOG Round 28 entry.

## Test status

- Unit: **145 passed / 14 suites**; API E2E: **104 passed / 10 suites**
  (both re-run green this round).
- Backend `nest build` + `tsc --noEmit` clean; scoped eslint clean for the
  new backend files (remaining `files.e2e-spec.ts` strict-TS `any` errors are
  pre-existing legacy lines, 24 → 22 after the prettier pass).
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E **exit 0**: 21 route probes (7 routes × light/dark/mobile) plus
  nav, agent-channel, sessions/saved-connection, files, **html-view**,
  buckets, cron, skills, and settings journeys — zero console/network errors;
  `e2e/screenshots/files-html-{view,tab,clean}.png` +
  `e2e/report.json` refreshed.

## Known issues / open tickets

- The direct `view` link uses the browser-visible API URL with no Bearer
  token; fine in the compose deploy (API token unset) but token-protected
  deployments need the link authenticated or proxied server-side.
- CSP `sandbox` on the preview iframe intentionally disables scripts, forms,
  and external navigation; interactive HTML should be opened in a new tab
  (which this round's journey verifies).
- Scheduler runs in-process and skills install state is in-memory per backend
  instance (single-instance deployment assumed; restart re-derives scheduler
  next-run timing).
- Buckets have no delete/rename endpoints (read-only by design).
- Full-repo backend eslint backlog predates this round (legacy files) — the
  tidy number is roughly 20+ strict-TS `any` violations across old specs.
- DIRECTION items 1–4 are **all complete**.

## Next round focus

1. **Backend eslint backlog housekeeping** — clear the legacy strict-TS `any`
   violations in old backend specs (e.g. `files.e2e-spec.ts`, `helpers` and
   other legacy files) so full-repo `npm run lint` is green.
2. Follow-up polish for this feature if any friction shows up in real use
   (e.g. token-protected deployments viewing HTML by link).
