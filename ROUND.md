# Round 117 — focused branch-coverage pass (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 116's next-focus item 1 (branch coverage) as a dedicated pass:
no runtime code changed; only specs were added/extended, and every new branch
was verified green under full coverage + the full gate.

## What changed this round

- **channel.service.spec.ts** — ghost-id 404-before-work tests for
  `ensureSubChannel`/`addMember`/`removeMember` (false sides).
- **skills.service.spec.ts** — empty-content create fallback (`''`), 409
  message fallback to `existing.name`, and content passthrough on update.
- **buckets.service.spec.ts** — undefined uploaded-name fallback to
  `document` (with real-file cleanup) and `deriveDocumentKind` extension
  fallback (`photo.bin` + `image/png` → `other`).
- **throttle.guard.spec.ts** — `envPositiveInt` missing/0/negative/non-numeric
  variants → **100% branch**.
- **files.service.spec.ts** — symlink exclusion from listings, directory and
  empty-path read/write/mkdir rejections, omitted-content empty write.
- **app.controller.spec.ts** — AppService-override passthrough test (L6
  conditional; constructor cond-expr remains instrumented, see Known issues).
- **connections.service.spec.ts** — null `apiKey` rows send no auth header,
  timeout env fallback, non-Error failures stringified, malformed model-list
  payloads filtered, `defaultParameters` created through the spread.
- **cron.service.spec.ts** — create/update normalization (model trim,
  connectionId, maxSteps), execute forwards stored fields, `runNow` 404,
  overview null-avg rows + default limits, lost claim race skips run history.
- **agent.models.spec.ts** — catalog default/fallback branch variants →
  **100% branch** (12/12).
- **base-agent.service.spec.ts** — sparse session recovery (null messages),
  live session wins over stale startup row, minimal connection request body
  (no apiKey/defaultParameters), config-defaults fallbacks.
- **channel-job.service.spec.ts** — non-Error run failures stringified, sparse
  history rows (null events/maxSteps) degrade to defaults, live in-memory job
  wins `snapshot`, empty-history lookups return null.

## Test status

- Backend unit: **15 suites / 314 tests passed** (round start: 15 / 281).
- API E2E: **12 suites / 123 tests passed** (backend flipped to API-only and
  restored to enabled mode).
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green** — REST docs
  guard, unit + lint + types, `nest build` + `next build`, /agent bundle
  484 KB / 33.6 KB headroom, API E2E all pass.
- Coverage: overall branch **70.89% → 75.78%** (stmts 77.37%). Per-service
  branch (before → after): base-agent 83.78 → 87.64; channel-job 80.49 →
  95.12; channel 91.94 → 96.77; skills 83.33 → 97.67; connections 83.33 →
  95.23; cron 83.75 → 94.92; files 90.41 → 97.26; buckets 95.92 → 97.95;
  workspace 93.94 (unchanged); throttle guard 91.67 → 100; agent.models →
  100.
- Browser E2E **not rerun** this round: only unit spec files changed, no
  runtime behavior changed.

## Known issues / open tickets

- **Low** — Jest keep-alive warning after unit/API e2e runs; suites exit 0.
- **Low** — Remaining branch gaps are defensive/structural: constructor TS
  param-props (channel-job 71–72, cron 232, files 88, skills 23), defensive
  catch/fallback paths (channel-job 323, cron 685/732/889/903–913,
  connections 38/206/316/371, files 132, base-agent connector-missing-row and
  schedule-recompute), and the app.controller constructor cond-expr.
- **By design** — controllers/DTOs/modules still 0% under unit coverage; API
  E2E covers them. `workspace.service.ts:248` probe-termination guard is
  intentionally untested (structural safety, see Round 116).

## Next round focus

1. **Keep the gates current** — after any future frontend/backend runtime
   change, re-run `verify --build --api-e2e` + both browser E2E modes; /agent
   baseline 484 KB / 33.6 KB headroom, unit 15 suites / 314 tests, API E2E 12
   suites / 123 tests.
2. **Optional, low value** — if a dedicated branch push continues to be wanted,
   target the leftover defensive paths (connector missing-row, cron
   recompute/standby, constructor param-props); document rather than force
   them.
3. **Check for new user direction each round** — DIRECTION.md is currently
   empty; re-read it at the start of the next round per LOOP.md.
