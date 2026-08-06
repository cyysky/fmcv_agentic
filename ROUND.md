# ROUND 9 — 2026-08-06 (autonomous iteration round 9)

## What changed this round

- **Global request throttling** — `@nestjs/throttler` wired through
  `ThrottlerModule` + a global `AppThrottlerGuard` (per client IP). Limits
  are read per request from env: `RATE_LIMIT_MAX` (default 100 per window;
  `0` disables throttling entirely) and `RATE_LIMIT_TTL_MS` (default 60000).
  Generous defaults keep local dev / browser E2E fail-open; over-limit
  bursts get 429 + `Retry-After` and recover after the window. A dedicated
  e2e suite boots its own low-limit instance, so other suites are never 429d.
- **Compose env plumbing** — backend service forwards `RATE_LIMIT_MAX` /
  `RATE_LIMIT_TTL_MS` (defaults 100 / 60000).

## Test status

- Unit: **52 passed / 9 suites** (was 47; +5 throttle-guard).
- API E2E: **38 passed / 6 suites** (was 36; +2 throttle) — app 5,
  connections 4, agent 12, channels 12, auth 3, throttle 2 (per-file
  verified).
- Frontend: `tsc --noEmit` clean, `eslint` clean.
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP, live model): 3 route checks + channel
  journey + sessions journey all green with zero console/network errors and
  zero warnings; screenshots + report refreshed.
- Live API proof (docker): with `RATE_LIMIT_MAX=2 RATE_LIMIT_TTL_MS=1000`,
  3 rapid requests to `/api/agent/models` returned 200 → 200 → 429
  (`X-RateLimit-Limit: 2`, `Retry-After: 1`) and the next request after the
  window returned 200; rebuilt with defaults (limit 100) and re-verified —
  all 200 with `X-RateLimit-Limit: 100`.

## Known issues / open tickets

1. **Deployment hardening (by design)** — request throttling is now in
  place, but `NEXT_PUBLIC_API_TOKEN` is still baked into browser JS: there
  is no real user identity/auth layer, so treat any non-local deployment as
  access-controlled at best. A minimal user-auth layer alongside `API_TOKEN`
  remains the only open pre-deployment item if one is wanted.

## Next round focus (ordered by value)

1. Looping audit: re-run the exit audit (empty next focus / degenerate
  guard). Round 9 added a real hardening feature with new tests, so the loop
  is healthy; if Round 10's audit finds no obviously valuable work and no
  open tickets, close per exit condition C.
