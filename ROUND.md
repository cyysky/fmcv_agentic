# ROUND 18 — 2026-08-08 (autonomous iteration round 18)

User instruction: **read on loop.md and do works** — the loop was re-opened
after Round 17 closed it. This round shipped the two settings-journey
frictions found during the "Use" walk: endpoints can now be probed before
they are saved, and stored API keys can be explicitly cleared.

## What changed this round

- **Test-before-save** — `POST /api/connections/test` probes unsaved form
  values (base URL, model, entered key) with the same one-token
  `chat/completions` probe as the stored-row test; the settings form gained a
  "Test Connection" button with an inline `aria-live` result that clears on
  any form change. No connection row is created or touched.
- **Explicit key clearing** — Edit now has a "Clear stored API key" checkbox;
  arming it disables the key field ("Stored key will be removed on save.")
  and PATCHes `apiKey: ""`. Backend create/update normalize empty strings to
  NULL, so a cleared secret is never persisted or returned as `""`.
- **BUG from browser E2E**: the first extended run proved the empty-string
  artifact (PATCH `apiKey:""` stored `""` and responses showed `""`), and the
  Credential field's invalid nested `<label>` could misroute checkbox clicks;
  both fixed (NULL normalization + `<div>`/`htmlFor` label).
- **Docs** — README (REST table, feature bullets, counts, Round 18 section),
  e2e/README (settings journey + duplicate list-numbering fix), CHANGELOG.

## Test status

- Unit: **74 passed / 11 suites** (was 67: +4 draft-probe, +3 apiKey
  normalization, including a null-prisma proof that draft probes never read
  the DB).
- API E2E: **56 passed / 7 suites** (was 51: +4 draft endpoint cases against
  the hermetic fake upstream — entered-key success with bearer assertion,
  401 reporting, unreachable graceful failure, invalid URL 400 — plus an
  explicit key-clearing round-trip that asserts GET returns null).
- Backend: `nest build` clean; `tsc --noEmit` clean.
- Frontend: `tsc --noEmit` + `eslint` clean; Docker `next build` clean.
- Browser E2E: all green, exit 0, zero console/network errors — all 12 route
  probes (light/dark/mobile), nav/channel/sessions/files journeys, and the
  extended settings journey: key-blank on edit → form Test fails gracefully
  on a dead endpoint → Cancel preserves the stored URL → plain-edit PATCH
  carries no `apiKey` → clear-key PATCH sends `apiKey:""` with a NULL
  server-side result → row Test fails gracefully → fixture deleted.
  `e2e/report.json` + screenshots refreshed.

## Known issues / open tickets

- None in this round's scope. No TODO/FIXME markers; worktree holds exactly
  this round's changes (plus the committed E2E artifacts).

## Next round focus

1. **(Biggest dead-end in the main journey)** The agent chat ignores saved
   connections: Sessions/turns only use the fixed `AGENT_BASE_URL` gateway +
   the hardcoded model catalog, so a connection added in Settings (e.g. a
   local Ollama or a custom provider) cannot be selected for chat. Make
   sessions carry an optional `connectionId` (endpoint + model + key +
   default parameters) and expose a connection picker in the agent chat UI,
   so Settings really drives the agent.
2. If #1 lands, keep the model picker working per connection: catalog models
   remain, but any stored connection's modelName becomes selectable with its
   row's baseUrl/key.
3. Polish from the settings round: consider showing latency+status in the
   edit form after a successful probe, or auto-running a probe on save when
   the row has never been tested.
