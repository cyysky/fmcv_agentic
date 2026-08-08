# Round 104 — Extended channel service unit coverage (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
continued Round 103's "genuinely valuable improvement" focus by closing the
biggest backend service coverage gap: `channel.service.ts` was at 60% lines
and is now at 82.85% lines with 5 new tests (182 → 187 unit tests).

## What changed this round

- **`resolveReplyAgent` edge coverage** — empty member set returns null,
  unknown channel raises 404, `@mention` matching is case-insensitive with a
  word boundary (`@CODER` matches, `ccoder` does not).
- **`postMessage` / `listMessages` round-trip** — role/author/text/toolCalls
  persist and re-list correctly; both raise 404 on a missing channel.
- **`get()` mapping** — members and the channel project tree are mapped from
  the Prisma row + workspace lookup; missing channel raises 404.
- **`prepareChannelTurn` thread building** — past human messages render as
  `[author]`, system-trace lines are kept as `[system]`, the current agent's
  own prior answers map to `[you]`, and the new ask is persisted by default.
- **`prepareChannelTurn` persistHuman:false** — no duplicate feed write when
  the caller already posted the message, thread still built, and non-member
  agents are rejected with 400 before any write.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 187
  tests passed**, backend lint + types, frontend types + lint.
- Coverage run green: `channel.service.ts` **60% → 82.85% lines**
  (80% stmts / 82.81% branch / 73.07% funcs); full backend suite a clean
  14 suites / 187 tests under `--coverage`.
- Full build gate not re-run (test-only change, no runtime code touched):
  Round 100's `verify --build --api-e2e` remains green — API E2E 12/123,
  bundle `/agent` 484 KB / 8 chunks, headroom 33.6 KB within 44 KB.
- Browser E2E: not re-run (no frontend runtime change); Round 100 enabled +
  api-only runs (21 route probes each, zero console/network errors) remain
  current.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Open** — `channel.service.ts` still has uncovered lifecycle paths:
  slug sanitization edge (line 67), `deletionCandidates` (176–180), `remove`
  incl. project pruning (228–253), and the LLM `runChannelTurn` path
  (381–407).

## Next round focus

1. **Close the channel lifecycle coverage gap** — add unit tests for
  `deletionCandidates` (parent + children), `remove` (cascade + workspace
  prune + 404s), and the slug-sanitization edge; cheapest remaining
  coverage wins in the same spec file.
2. **Cover the LLM `runChannelTurn` success path** — stub `BaseAgentService`
  in the channel spec to exercise `runChannelTurn`'s post + final-answer
  persistence, then decide whether the unbeaten lines justify it.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
