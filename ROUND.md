# Round 131 — DIRECTION: agents can save binary files (2026-08-10)

Loop state: finished

DIRECTION (human) item: add a tool that lets agents save binary content
(downloaded PDFs, images, archives) to the workspace/channel folder — when
an agent fetches a URL returning binary data it must save the actual binary
(base64 or streamed) instead of falling back to extracted `.md` text.

## What changed this round

- **`save_binary` + `save_own_binary` workspace tools**
  (`backend/src/agent/workspace-tools.ts`) — save binary content into any
  named agent's own folder (self-scoped variant needs no name), from
  `base64` (strictly validated decode; garbage rejected) or `url` (native
  fetch, redirects followed, 100 MB declared + live-stream cap, 60 s
  timeout, partial-file cleanup). Results return metadata only — binary
  bytes are never echoed into the tool trace.
- **`channel_save_binary` channel tool**
  (`backend/src/agent/channel-tools.ts`) — same semantics scoped to the
  channel's project folder.
- **Agent system prompts** (`backend/src/agent/base-agent.service.ts`) —
  both channel prompt blocks (non-streaming + streaming) advertise the new
  tools and explicitly say never to fall back to saving extracted text as
  `.md`.
- **Unit coverage** — 4 new specs: base64 round-trip + invalid/missing/
  both-inputs/escape rejections; URL streaming with 302 redirect followed
  and HTTP 404 rejected; own-folder scoping; channel-project scoping +
  escape rejection.
- **Backend image rebuilt/restarted** (`fmcv-backend`) so the runtime
  picked up the new tools.
- **New `binary` browser E2E journey** (`e2e/browser-e2e.mjs`) — a real
  `/agent` channel run downloads the EGGROLL paper PDF (the exact URL from
  the ticket) with `channel_save_binary` + `save_own_binary`, both via the
  `url` argument; the live trace shows both tool rows, and both saved files
  are re-downloaded through the files API and verified with `%PDF` magic
  bytes + byte counts matching the tool results (2,578,984 B). Cleanup
  removes the agent fixture via API, deletes the channel, and removes the
  exact `browser-e2e-binary-*` project folder (project scope is read-only)
  with the prune check green.
- **Docs** — README feature list + source structure and e2e README journey
  list/exit gate updated; CHANGELOG Round 131 entry added.

## Test status

- Backend unit: **16 suites / 332 tests passed** (+4 from Round 130).
- Browser E2E: **enabled-mode full run green** — 14 flows including the new
  `binary` journey, zero console/network/HTTP errors; the EGGROLL paper PDF
  was downloaded and saved byte-exact by the live agent.
- Fast gate `node scripts/verify.mjs`: **green** (REST docs + test-count
  guards, lint + type checks both apps).

## Known issues / open tickets

- None open. Accepted environmental limitation unchanged: Brave/DDG
  captchas on datacenter IPs, mitigated by the proven Bing RSS fallback.
- Note: `/api/files/view` only serves `.html` inline (415 for a PDF), so
  the binary journey verifies project-scope fixtures via
  `/api/files/download` — documented in the journey.

## Next round focus

_(empty — DIRECTION item implemented, unit-tested, and live-E2E-proven; no
tickets open; no obviously valuable improvement identified.)_

Exit: **condition C (goal complete)** — stopping. Resume only when new
human direction arrives or a runtime change warrants re-running the gates.
