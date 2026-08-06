# Changelog

Git history is the source of truth (`git log`); this file summarizes
behavior-relevant changes per round.

## Round 2026-08-06 — second 8-hour deep-work round

### Added
- API E2E coverage: channel-delete stops running jobs (exactly one `stopped`
  event), plus `maxSteps`/payload-shape validation for POST /api/agent/turn
  without calling the LLM. API E2E now 43 tests / 4 suites.
- Per-page browser document titles via server metadata wrappers:
  `FMCV Agentic` (home), `Settings - FMCV Agentic`, `Agent - FMCV Agentic`.

### Fixed
- Deleting a channel now stops any in-flight agent job for the channel tree
  (including sub-channels) and marks it `stopped` before the rows are removed,
  so workers never keep running against a deleted channel. A stopped job is
  no longer downgraded to `error` when its run later trips over the deletion.
- Empty channel-owned project folders are pruned on channel delete (folders
  still holding artifacts are kept).
- Settings/agent pages no longer show the Next.js starter title, and the
  settings initial-load effect passes React's setState-in-effect lint rule.

### Changed
- CDP browser E2E hardened: each route gets a fresh tab (no silent reuse of
  busy/stale tabs), per-step timeouts + content settle conditions, document
  title assertions, progress logging, a global watchdog, and guaranteed tab
  cleanup on success or failure.
- Frontend lint clean (0 errors, 0 warnings); type-check clean.

## Round 2026-08-05 — first full 8-hour deep-work round

### Added
- Agent system: stateless turns + persistent sessions, model catalog
  (`ds4-flash` default, `qwen3.6-35b`), configurable `maxSteps` cap (1–20).
- Filesystem workspaces with named agent folders (`coder`, `researcher`) and
  shared projects; file tools + connection-credentials tool.
- Slack-style channels: agent members, streaming SSE jobs, subchannels/threads,
  interjections, per-member debug/status pane.
- Agent chat UI at `/agent` with tool-call trace and workspace viewer.
- CDP browser E2E (`e2e/browser-e2e.mjs`) with screenshots + JSON report.
- Unit + real-Postgres API E2E suites (37 unit / 41 API tests).

### Fixed
- Stop path emits exactly one `stopped` event (was duplicated/non-terminal).
- `maxSteps` enforced on session `converse` (1–20 range, rejects out-of-range).
- Workspace project listings work without an `agent` argument.
- Unknown agent names rejected at the API boundary with valid-name hints.
- Channel slugs have stray dashes trimmed; removing a non-member agent is
  rejected instead of silently succeeding.

### Changed
- Postgres persistence extended from `connections` to `channels`,
  `channel_members`, `channel_messages` (Prisma models + migrations).
