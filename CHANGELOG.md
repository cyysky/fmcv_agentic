# Changelog

Git history is the source of truth (`git log`); this file summarizes
behavior-relevant changes per round.

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
