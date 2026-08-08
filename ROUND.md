# Round 109 — files service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 108's next-focus item 1: lifted `files.service.ts` from
88.8% to 100% lines (97.08% stmts / 90.41% branch / 100% funcs).

## What changed this round

- **Path validation edge** — NUL bytes in a path are rejected as
  BadRequest before any filesystem access.
- **`list` edge cases** — a missing non-root subpath 404s; listing a plain
  file is BadRequest; an unreadable directory degrades to an empty listing
  instead of failing; entries whose `lstat` fails are skipped without
  aborting the listing; non-ENOENT stat failures are rethrown.
- **`write` failure paths** — writing over an existing directory (EISDIR)
  is BadRequest; any other store failure is wrapped as BadRequest with the
  underlying message.
- **`remove` failure paths** — deleting the scope root is refused; rmdir
  failures other than non-empty (e.g. EACCES) are rethrown untouched.
- **`resolveOrThrow` fallback** — safeResolve failures with messages other
  than the escape guard are wrapped as BadRequest (`Invalid path: ...`).
- **`statOrThrow` fallback** — non-ENOENT stat failures (e.g. ENOTDIR /
  injected kernel errors) are rethrown untouched instead of masked.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 231
  tests passed** (+12 this round), backend lint + types, frontend types +
  lint.
- Coverage run green: `files.service.ts` **88.8% → 100% lines**
  (97.08% stmts / 90.41% branch / 100% funcs); remaining uncovered
  statements are branch-sides in sort/type plumbing plus the true guard
  sides of stat/read checks — no reachable line gaps.
  `buckets.service.ts` stays 100% lines, `channel-job.service.ts` and
  `workspace-tools.ts` stay 100%, `channel.service.ts` stays 99.04% (dead
  `SLUG_RE` guard).
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
- **Open** — `channel.service.ts` line 67 (`SLUG_RE` guard) is dead by
  construction; decide in a runtime round whether to delete it or keep it
  as defense-in-depth.
- **Open** — `workspace.service.ts` is now the lowest meaningful service at
  80.48% lines (uncovered: 117-124, 154-159, 186-198, 206);
  `base-agent.service.ts` sits at 74.92% but is a much larger surface.

## Next round focus

1. **Cover `workspace.service.ts`** — extend `workspace.service.spec.ts`
  toward the 90%+ service bar, targeting the listed root/readTree
  validation paths; re-run fast verify + coverage after.
2. **Decide the dead `SLUG_RE` guard** — a small runtime cleanup
  (remove the unreachable branch) needs the full build + API E2E + browser
  gates; only worth doing bundled with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
