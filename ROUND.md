# ROUND 21 — 2026-08-08 (autonomous iteration round 21)

User instruction: **read on loop.md and do works**. This round polished the
settings probe UX: probe results now show structured HTTP status + latency
without dying in the message text, the edit form replays a row's last-known
probe, and saving untested values auto-probes the saved row.

## What changed this round

- **Structured probe metrics** — the backend success message is now short
  (`Connected — <model> responded.`); the settings UI composes
  `HTTP <status> · <latency> ms` beneath it in both the row result and the
  edit-form result, so latency/status are never duplicated inside the message.
- **Edit replays known probe** — opening Edit fills the form's test-result
  area with the row's last probe (`testStates[id].result`) until any probed
  value changes (any field change clears it again).
- **Auto-probe on save** — saving a connection whose form values were never
  probed kicks a client-side probe of the persisted row after the save lands
  (never blocking the save): the row renders `Connected · HTTP 200 · <n> ms`,
  the success banner reports `Probe: <summary>` (or graceful
  `Probe unavailable: <message>` when the probe fails).
- **Browser E2E** — the settings journey now runs the whole auto-probe path
  against the hermetic fake upstream: form create → row result with curated
  metrics → `Probe:` banner → single one-token `chat/completions` with the
  stored bearer key + `max_tokens: 1` → Edit replays the probe → both fixtures
  deleted + server-side cleanup verified. New flags: `autoProbeRowSeen`,
  `autoProbeBannerSeen`, `autoProbeUpstreamHit`, `autoProbeUpstreamAuthOk`,
  `autoProbeUpstreamModel`, `autoProbeUpstreamMaxTokens`, `autoProbeRowText`,
  `autoEditReplaysProbe`, `autoCleanup` (all gated).

## Test status

- Unit: **80 passed / 11 suites** (count unchanged; reachable-probe message
  assertion updated to the short form).
- API E2E: **56 passed / 7 suites**.
- Backend: `nest build` + `tsc --noEmit` clean.
- Frontend: `tsc --noEmit` + `eslint` clean, zero warnings.
- Browser E2E: all green, exit 0, zero console/network errors —
  `e2e/report.json` + screenshots refreshed (incl. `settings-auto-probe.png`);
  containers rebuilt/restarted with the Round-21 images before the run.

## Known issues / open tickets

- None blocking. Documented semantics: the auto-probe is best-effort and
  client-side, so a slow endpoint can leave the banner in
  `Probe unavailable: …` even though the save succeeded (graceful by design).

## Next round focus

1. **Per-connection model lists** (Round 20's #2) — beyond the catalog
   override, let a connection expose a provider-specific model list (e.g.
   `/models` discovery or an editable list in Settings) so non-catalog
   providers are first-class in the agent model picker.
2. **Housekeeping** — audit TODO/FIXME markers, check for stale browser E2E
   sessions/connections after failed runs, and re-verify docs/README counts
   are accurate.
3. **Probe polish follow-ups** — e.g. surface the probe metrics line in the
   row even when a previous probe is stale, or persist the last probe result
   server-side so a reload of `/settings` still shows known health.
