# LOOP PROMPT — Autonomous Iteration Rounds (fmcv_agentic system)

You are in an autonomous loop. Each execution is one ROUND. You may run many rounds
in a single session — keep going until an exit condition fires.

## 0. Loop state (always read first)
- Read `DIRECTION.md` once, at the start of the round (do not keep re-reading it).
  - **If it contains instructions:** those come from the human. Treat them as this
    round's direction — steadily and patiently plan a path, then move toward it; if
    the direction is a bug report or fix request, fix it. It overrides "Next round
    focus" from ROUND.md for this round.
  - **If it is empty / whitespace-only:** no human direction right now — run the
    normal loop below.
- Load git log, README, CHANGELOG, docs, and `ROUND.md` (if present) to learn:
  - What round you are on (parse from commits, tags, or ROUND.md).
  - What the previous round completed, left broken, or planned next.
- If ROUND.md exists, its "Next round focus" section is your primary goal this round.
- If DIRECTION.md carried a human instruction this round, that instruction is your
  primary goal this round instead of the ROUND.md focus.
- If no state exists, this is Round 1: do orientation as described below.

## 1. Every round, do all of this:
1. **Orient (10 min).** Diff since last round's tag/commit. Re-read anything touched.
   You already read `DIRECTION.md` once at the start of this round (section 0) — do
   not re-read it mid-round. If it held a human instruction, keep the plan steady
   and patient until that direction is fulfilled.
2. **Test.** Run the full suite. Add tests for new/changed behavior. Fix regressions.
   Red → Green → Refactor. Suite must be green before the round can end.
3. **Use.** Walk the main user journeys by hand. Log every friction/bug/dead-end as a ticket.
4. **Improve.** Fix tickets, refactor bloat, and — only if clearly justified — introduce
   new features/functions. Dramatic redesign is allowed when the existing design is the blocker.
5. **E2E.** Where a browser is available, drive real Chrome over CDP
   (puppeteer-core / chrome-remote-interface). Capture console errors, failed requests,
   and screenshots. Keep these as committed, re-runnable scripts.
6. **Verify.** All tests green, no console/network errors on main flows, docs accurate.

## 2. End of round — write the handoff
Create/update `ROUND.md` with:
- **Round number & date.**
- **What changed this round** (fixed/built/removed, one line each).
- **Test status** (pass/fail counts).
- **Known issues / open tickets.**
- **Next round focus** (up to 3 concrete items, ordered by value).
Then: `git add -A && git commit` (conventional message) and tag `round-N`.

## 3. Continuation logic (decide AFTER the handoff is written)
Proceed to the next round automatically UNLESS any exit condition is true.
**Exit conditions (stop here):**
- A. User interrupts / sends a new instruction.
- B. Hard stop: time or budget reached (e.g., 8h elapsed, N rounds done) — and you
  have already produced the round report above.
- C. Goal complete: ROUND.md's "Next round focus" is empty and no tickets remain open,
  and no improvement would be obviously valuable.
- D. Degenerate loop guard: the last 3 rounds made no net user-visible improvement
  (same tickets, no new tests, no changes). Stop instead of spinning.

If no exit condition fires: greet Round N+1, update the round counter, and run the
round procedure again with the new "Next round focus" as your goal.

## 4. Round summary (say this out loud at the end of every round)
- Round N: [one-line result]. Tests: X passed / Y failed. Committed as [hash].
- Next: [item 1] · [item 2] · [item 3]. Exit checked: [condition or "none — continuing"].

## Ground rules
- Commit after every logical unit of work, not just at round end.
- Never lose work: commit before any risky refactor/dramatic change.
- If a step cannot run (no browser, no network, missing dep), skip it explicitly in
  ROUND.md, don't silently drop it.
- Prefer many small rounds to few giant ones; each round must end committable.
- Be honest in the handoff: if you didn't do something, say so and put it in "Next focus."
