# ROUND 20 — 2026-08-08 (autonomous iteration round 20)

User instruction: **read on loop.md and do works**. This round landed the
second half of "Settings really drives the agent": with a saved Connection
selected, the model picker stays usable — catalog models become explicit
per-turn overrides that route through the connection's endpoint/key.

## What changed this round

- **Model picker + connection picker compose** — selecting a connection now
  leaves the model picker enabled with a new "connection default" option
  (the connection's `modelName`); catalog models remain selectable as
  overrides. Choosing a catalog model sends `model` alongside `connectionId`;
  switching back to the default gateway restores the previously selected
  catalog model (`lastGatewayModelRef`).
- **Backend override semantics** — `runTurn` and `converse` treat an
  explicit `model` as a catalog override: it wins on the wire over the
  pinned connection's `modelName` while the connection's baseUrl/apiKey/
  defaultParameters still apply. Without an explicit model the connection's
  modelName is the wire model (Round 19 behavior unchanged). Turns return
  the wire model; conversations store the chosen catalog model on the session.
- **Reopen default** — opening a pinned session no longer resurrects the
  stored catalog model (which could switch a connection-default chat to the
  default catalog model); pinned sessions reopen on the connection's own
  model, and overrides are per-chat choices.
- **Browser E2E** — the sessions journey now covers both paths: the default
  path (connection model sent, no `model` key) and the override path (pick
  a catalog model with the connection active; wire POST carries
  `connectionId` + `model`; the hermetic upstream receives the override
  model with the fixture's bearer key; the reply renders; the override model
  persists server-side). New `E2E_CONN_OVERRIDE_MODEL` env var (must differ
  from `E2E_CONN_MODEL`).

## Test status

- Unit: **80 passed / 11 suites** (79 → +1: explicit catalog-model override
  on turn + conversation through a pinned connection, per-call fallback to
  the connection's model, session model update).
- API E2E: **56 passed / 7 suites** — the saved-connection journey now also
  converses and turns with `connectionId` + catalog `model` override.
- Backend: `nest build` + `tsc --noEmit` clean (verified after the change).
- Frontend: `tsc --noEmit` + `eslint` clean, zero warnings.
- Browser E2E: all green, exit 0, zero console/network errors — all 12 route
  probes, nav/channel/files/settings journeys, and the extended sessions
  journey (default path + override path; all result flags true, including
  `overrideModelSentOnConverse`, `overrideUpstreamModel`,
  `overrideUpstreamAuthOk`, `overrideReplySeen`, `overrideModelPersisted`).
  `e2e/report.json` + screenshots refreshed; containers rebuilt/restarted
  with the new images before the run.

## Known issues / open tickets

- None blocking. Documented semantics: a catalog override is per-chat; a
  pinned session reopened in a new browser tab resumes on the connection's
  default model (the stored `session.model` may lag the last override).

## Next round focus

1. **Settings probe polish** (Round 18's #3): show latency + status from a
   successful probe inside the edit form, or auto-run a probe when saving a
   connection that has never been tested (client-side after save, so saving
   is never blocked by a slow endpoint).
2. **Per-connection model lists** — beyond the catalog override, consider
   letting a connection expose a provider-specific model list (e.g. `/models`
   discovery or an editable list in Settings) so non-catalog providers are
   first-class in the picker.
3. **Round 21 housekeeping** — full suite re-run after any change, audit
   TODO/FIXME markers and stale sessions, refresh docs/README counts if they
   shift.
