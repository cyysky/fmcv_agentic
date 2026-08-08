# ROUND 30 — 2026-08-08 (autonomous iteration round 30)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
active human direction; items 1–4 (managed buckets, cron jobs, agent skills,
view HTML) were all complete as of Round 28. Round 29 left no concrete next
item, but the known-issue list still carried one real-use friction named in
its handoff: HTML viewing by link/new tab was broken on `API_TOKEN`-protected
deployments. That was this round's goal — close the ticket rather than spin.

## What changed this round

- **Token-safe same-origin HTML view proxy** — new frontend route handler
  `frontend/app/api/files/view/route.ts` serves the same path as the backend
  view endpoint on the app origin: it attaches the bearer token server-side,
  forwards only the backend's inline-view headers (`text/html`, `inline`
  disposition, CSP `sandbox`, `nosniff`, `no-store`), and streams the body.
  The `/files` preview iframe and **Open in new tab** link now point at it, so
  token-protected deployments work without leaking the token into URLs and
  without losing the CSP sandbox.
- **Compose** — frontend gains a runtime `API_INTERNAL_URL`
  (default `http://backend:5555/api`) so the proxy reaches the backend
  container; falls back to `NEXT_PUBLIC_API_URL` / `localhost` elsewhere.
- **Tests** — backend API E2E +1: with `API_TOKEN` set, `/api/files/view`
  returns 401 without the bearer header and streams `text/html` with it
  (env restore deletes the key instead of setting it to `"undefined"`).
  Browser E2E html-view journey now asserts the same-origin proxy href and
  verifies the new tab through that href instead of falling back to the raw
  backend URL.
- **Docs** — README (file-manager bullet, files API table, env vars) and
  `e2e/README.md` describe the proxy; CHANGELOG gets this entry.

## Test status

- Unit: **145 passed / 14 suites**; API E2E: **105 passed / 10 suites** (+1
  token-gate view test); backend `nest build` + `npx tsc --noEmit` + lint
  clean.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` clean (proxy
  compiled as dynamic `ƒ /api/files/view`).
- Browser E2E **exit 0** — all routes + journeys, zero console/network
  errors; report records `proxyHref` = `http://localhost:3333/api/files/view?...`;
  screenshots + `e2e/report.json` refreshed.
- Manual proxy check: same-origin view returned 200 with CSP `sandbox`,
  inline disposition, `nosniff`, and `no-store` headers preserved.

## Known issues / accepted limitations

- CSP `sandbox` intentionally disables scripts/forms and external navigation
  inside the preview iframe; interactive HTML should be opened in a new tab
  (where the same CSP header still applies). By design.
- Scheduler runs in-process and skills install state is in-memory per backend
  instance (single-instance deployment assumed).
- Buckets have no delete/rename endpoints (read-only by design).
- Test files are intentionally exempt from `no-unsafe-*` / `require-await`
  (supertest `res.body` and Prisma test doubles are `any`-typed by nature);
  production sources remain strictly type-checked.

## Next round focus

- **No concrete next item.** DIRECTION items 1–4 are complete, the HTML-view
  token ticket is closed (verified in the API + browser E2E suites), and the
  remaining items above are accepted design limitations rather than open
  tickets. Continue only if the human updates DIRECTION.md or reports new
  real-use friction.
