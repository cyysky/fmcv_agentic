# ROUND 17 — 2026-08-08 (autonomous iteration round 17)

User instruction: **read on loop.md and do works** — Round 16 had satisfied
exit condition C (empty next focus, no tickets), so this round re-opened the
loop with a fresh orientation → test → use → improve → E2E → verify pass.

## What changed this round

- **Credential-clobber bug fixed** — the edit form pre-filled the masked API
  key (`sk-***xyz`), so saving without touching it wrote the masked string
  back over the real key. The field now opens blank with a "kept when left
  blank" hint; the browser E2E captures the wire PATCH to prove `apiKey` is
  never replayed.
- **Dead success notice fixed** — `setMessage(...)` was immediately cleared
  by `resetForm()` in the same batched render, so "Connection added/updated."
  never appeared. Ordering fixed; the settings journey now asserts the notice.
- **Connection testing added** — `POST /api/connections/:id/test` probes a
  stored endpoint live (one-token `chat/completions` with the stored key,
  bounded by `CONNECTION_TEST_TIMEOUT_MS`) and returns pass/fail with HTTP
  status, latency, and a readable message. Settings rows got a Test button
  with an inline `aria-live` result and busy state.
- **Spec hygiene** — pre-existing backend `tsc` errors in two spec files
  (spreading a `never` value; `ThrottlerException` imported from the wrong
  package) fixed; `tsc --noEmit` is now fully clean across the repo.
- **Docs** — README (feature, REST table, env var, counts, progress),
  e2e/README (new journey), CHANGELOG, and this handoff updated.

## Test status

- Unit: **67 passed / 11 suites** (62 + 5 connection-probe tests).
- API E2E: **51 passed / 7 suites** (47 + 4 probe tests against a hermetic
  fake upstream on an ephemeral port: bearer-auth success, 401 reporting,
  unreachable-endpoint graceful failure, unknown-id 404).
- Backend: `nest build` clean; **`tsc --noEmit` clean** (no errors at all now).
- Frontend: `tsc --noEmit` + `eslint` clean; Docker `next build` clean.
- Browser E2E: all green, exit 0, zero console/network errors — all 12 route
  probes (light/dark/mobile), nav/channel/sessions/files journeys, and the
  new settings journey (fixture created via API → Edit opens with blank key →
  save without key + PATCH body asserted key-free → Test returns graceful
  failure → fixture deleted server-side). Refreshed
  `e2e/screenshots/settings-test-result.png` + `e2e/report.json`.

## Known issues / open tickets

- None. No TODO/FIXME markers; worktree contains only this round's changes.

## Next round focus

- (none pressing) — settings key-safety, connection testing, and the notice
  bug are shipped and covered end-to-end; all suites are green. A future
  round could add connection test results to the edit form or a "test on
  save" flow, but nothing here is obviously broken or missing without a new
  user instruction. Loop closed per exit condition C.
