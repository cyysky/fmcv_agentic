# Browser E2E (CDP)

Repeatable end-to-end browser checks for FMCV Agentic, driven through a real
Chrome instance over the Chrome DevTools Protocol. Zero npm dependencies
(Node 22+ built-in `fetch`/`WebSocket` only).

## Prerequisites

Chrome must already be running with a remote debugging port:

```sh
google-chrome --remote-debugging-port=9223 --remote-allow-origins=*   --user-data-dir=/tmp/fmcv-chromedata
node scripts/cdp-relay.mjs   # 0.0.0.0:9222 -> host Chrome 127.0.0.1:9223
```

The relay is what makes CDP reachable from inside the `fmcv-backend`
container (default `WEB_CDP_HOST=host.docker.internal`, `WEB_CDP_PORT=9222`),
so the web tools actually take the CDP-first path (`via: "cdp"`) rather than
falling back to native fetch. Host Chrome on 9222 alone is loopback-only and
unreachable from the container. Run Chrome on whatever port you like and point
the relay at it with `CDP_RELAY_TARGET`; point this script at the reachable
port with `CHROME_DEBUG_PORT`.

The app must be up (`docker compose up -d --build`); the script talks to the
frontend in the browser and requires the backend API reachable from Chrome's
network view.

## Run

```sh
cd e2e
CHROME_DEBUG_PORT=9223 node browser-e2e.mjs
# or from anywhere:
CHROME_DEBUG_PORT=9223 node e2e/browser-e2e.mjs
```

Environment overrides:

| Variable            | Default                       | Meaning                             |
| ------------------- | ----------------------------- | ----------------------------------- |
| `CHROME_DEBUG_HOST` | `127.0.0.1`                   | CDP host                            |
| `CHROME_DEBUG_PORT` | `9222`                        | CDP port                            |
| `E2E_APP_BASE`      | `http://localhost:3333`       | frontend base URL                   |
| `E2E_API_ONLY`      | unset                          | run the cron flow against an API-only backend (`CRON_SCHEDULER_ENABLED=false docker compose up -d --force-recreate backend`): asserts the "Scheduler disabled — API-only" chip, the "no lease · no background firing" meta, and the overview gauge's "disabled" lease chip |
| `E2E_JOURNEYS`      | `all`                          | comma-separated flow selection for faster regression runs: `routes`, `nav`, `agent`, `webtools`, `agentskills`, `mobile`, `sessions`, `files`, `html`, `buckets`, `cron`, `skills`, `settings`; skipped flows are omitted from execution and validation. Shorthand presets (mixable with flow names): `cron-only` = `routes,cron`; `ui-only` = `routes,nav,mobile,html,settings,skills`; `core` = `routes,agent,cron` |
| `E2E_SHOT_DIR`      | `e2e/screenshots/<mode>`      | screenshot output dir (`enabled` or `api-only` subdir; an explicit value is used verbatim) |
| `E2E_REPORT`        | `e2e/report.json` (+`report-<mode>.json`) | JSON report path; the mode archive `report-<mode>.json` is always written too (an explicit `E2E_REPORT` value is used verbatim as the latest mirror) |
| `E2E_WATCHDOG_MS`   | `600000`                      | overall run watchdog                |
| `E2E_CONN_HOST`      | auto-detected                 | host/IP the fixture connection points the backend at (override when the backend container cannot reach the auto-detected IP) |
| `E2E_CONN_MODEL`     | `ds4-flash`                   | model name stored on the fixture connection in the sessions journey |
| `E2E_CONN_OVERRIDE_MODEL` | `qwen3.6-35b`          | catalog model picked as an override during the sessions journey (must differ from `E2E_CONN_MODEL`) |

## What it checks

1. **Routes load cleanly**: `/`, `/settings`, `/agent`, `/files`,
   `/buckets`, `/cron`, and `/skills` render their expected content with **no console
   errors, no uncaught exceptions, no failed network requests, and no HTTP >=
   400 responses** (measured over CDP events, including polling fetches the
   SPA makes after first paint).
2. **Document titles**: each route must expose its expected browser tab
   title (`FMCV Agentic`, `Settings - FMCV Agentic`, `Agent - FMCV Agentic`,
   `Buckets - FMCV Agentic`, `Cron - FMCV Agentic`, and
   `Skills - FMCV Agentic`).
3. **Channel journey**: on `/agent`, the script opens the Channels tab,
   creates a new channel via the modal (with `coder` as creator), posts a
   message, and waits for the auto-reply agent job to reach a terminal state
   (`[answer]`, `[stopped]`, or `[error]`). The feed snippet is also guarded
   to reject raw UTC ISO timestamps: every message must render the shared
   local-time format (`8/9/2026, 1:34:38 AM`), so the Round 89 formatting
   fix cannot regress silently. After the channel is deleted, the cleanup
   also removes the `round2.md` fixture the brief makes `coder` write into
   its own agent folder (channel deletion only cascades the channel's
   project folder) and fails the run if either artifact is left behind.
4. **Web-tools journey**: on `/agent`, a fresh `browser-e2e-web-*` channel is
   created through the same UI path, posted a brief that explicitly asks for
   `fetch_url` on `https://example.com` and `web_search` for `OpenAI`, and the
   run is watched (up to 240 s) until terminal. Every tool row in the live
   trace is expanded and read from the DOM: both `fetch_url` and `web_search`
   must show `via: "cdp"` (proving the CDP-first path from inside the
   container, not the native-fetch fallback), and the fetch row must include
   the "Example Domain" title. The channel is deleted afterwards and the
   `browser-e2e-web-*` project folder must be gone. DuckDuckGo may still
   bot-block (its CAPTCHA challenge); `web_search` then automatically falls
   back to Bing RSS (`provider: "bing"`) — the assertions are the `via`
   provenance, a real rendered page/title, and the fetch body containing
   "Example Domain".
5. **Agent-skills journey**: on `/agent`, a fresh `browser-e2e-skills-*`
   channel is created through the Channels UI and the agent is told to run
   the full skill CRUD loop in order — `list_skills`, `create_skill`
   (`e2e-agent-skill`), `read_skill` by the returned id, `update_skill`,
   `delete_skill`. Every tool row must appear in the live trace, the
   `read_skill` row must actually return the created skill (not an error),
   and afterwards the skill must be gone from the skills API. The channel is
   deleted and the `browser-e2e-skills-*` project folder must be pruned.
6. **Sessions + saved-connection journey**: on `/agent`, the script opens the
   Sessions tab, creates a session, posts a live converse, asserts the
   auto-title and history survive a page reload, renames the session through
   the UI, and reopens it to prove history + title persisted. It then starts
   a hermetic fake OpenAI-compatible upstream on an ephemeral port, creates a
   fixture Connection via the API (base URL pointing at that upstream, with a
   stored model, a bearer key, and a `models` list containing one
   non-catalog id), selects it in the header picker, and proves the saved
   connection drives the chat: the model picker defers to the connection's
   model, the wire converse POST carries `connectionId` with no `model` key,
   the upstream sees `POST /chat/completions` with the connection's model and
   `Bearer <stored key>`, its reply renders in the thread, the sidebar badges
   the pinned session, and GET sessions shows the server-side `connectionId`.
   With the connection still active it then proves the **connection-model
   path**: the non-catalog id is absent from the default-gateway picker,
   appears as an option after the connection is selected, and picking it
   sends `connectionId` + `model` on the wire with the raw id arriving at the
   upstream with the fixture's bearer key (no catalog fallback). Next it
   picks a catalog model and proves the same override path
   (`E2E_CONN_OVERRIDE_MODEL` controls which catalog model is picked and must
   differ from `E2E_CONN_MODEL`); the override model is persisted
   server-side. Finally it restores the default gateway, deletes the fixture
   Connection + upstream, and asserts cleanup (`E2E_CONN_HOST` /
   `E2E_CONN_MODEL` override the fixture endpoint/model).
7. **Files journey**: on `/files`, the script creates a nested file and a
   dotfile through the UI (agent scope), verifies the root listing shows both,
   navigates into the folder, reads the file content back, deletes the file +
   folder + dotfile through the UI, and then confirms server-side removal via
   the files API (no leftovers).
8. **HTML-view journey**: on `/files`, the script creates an
   `view.html` fixture through the UI (agent scope), clicks **View** and
   proves the in-app sandboxed iframe preview renders the fixture, asserts
   both the iframe and the **Open in new tab** link point at the
   same-origin frontend proxy (`<app origin>/api/files/view`), captures the
   proxy response headers over CDP to assert `text/html`, `inline`
   disposition, `Content-Security-Policy: sandbox`, and `nosniff` are
   preserved, then clicks **Open in new tab** with a trusted CDP mouse click
   (so the popup blocker treats it as a user gesture), finds the new page
   target via `/json/list`, and proves the new tab rendered the fixture's
   marker and document title. The file + folder are then deleted through the
   UI and the server-side state is verified clean. If the popup target is ever
   missed, the script falls back to opening the same proxy `href` in a fresh
   tab and still verifies the rendered document.
9. **Settings journey**: the script creates a throwaway connection via the
   API (with a stored key), clicks Edit and asserts the API-key field opens
   blank (so the masked preview cannot overwrite the stored secret), changes
   the URL to a dead endpoint and clicks the form's **Test Connection** button
   to prove unsaved values are probed gracefully, then clicks Cancel and
   asserts the stored URL is preserved. It re-enters Edit, renames, and
   captures the wire PATCH body to prove `apiKey` is never replayed on a plain
   edit, then checks **Clear stored API key**, asserts the clear PATCH sends
   `apiKey:""`, and verifies via the API that the stored secret became NULL.
   Then it clicks the row Test against the dead endpoint for a graceful inline
   result. Finally it starts the hermetic fake OpenAI-compatible upstream,
   creates a second connection through the **form** (name, upstream base URL,
   model, stored key) and proves the auto-probe-on-save path: the saved row
   renders `Connected · HTTP 200 · <n> ms`, the success banner reports
   `Probe:`, the upstream receives a single `POST /chat/completions` with
   `max_tokens: 1` and the stored bearer key, and reopening Edit replays that
   probe result (message + HTTP status + latency) into the form until a probed
   value changes. Both fixtures are then deleted via the API and the script
   asserts both rows disappear server-side (cleanup).
10. **Buckets journey**: on `/buckets`, the script creates a document bucket
   through the UI (unique name, agent folder), proves a duplicate bucket name
   renders the in-page 409, opens the bucket, uploads a text document from a
   temp file, proves a duplicate upload 409s (documents are immutable),
   downloads the document and verifies the saved-to-disk bytes via CDP
   `Browser.setDownloadBehavior`, then reloads the page and proves the
   bucket and document survived, renames the bucket through the UI and
   proves the document persists under the new name, then deletes the bucket
   via the two-click confirm. Server-side cleanup afterwards uses the new
   `DELETE /api/buckets/:id` endpoint; the psql helpers only remain as a
   final DB verification/fallback.
11. **Skills journey**: on `/skills`, the script creates a skill through
   the UI (slug-form fixture name, description, markdown instructions) with
   the **Install now** box checked, verifies the row + Installed pill +
   success notice, reloads and proves the skill and its installed state
   persisted, edits description/instructions through the UI (the name field
   stays immutable), uninstalls (pill flips to Not installed and the record
   stays listed), reinstalls from the row button, then deletes it with the
   two-click confirm. Fixtures are removed afterwards via the skills DELETE
   API (idempotent, verified 404).
12. **Screenshots**: key screens (home, settings, agent, channel running,
    channel done, sessions picker/connection, files before/after,
    html-view/iframe/new-tab/clean, buckets
    created/uploaded/downloaded/reloaded, skills created/reload/edited/
    deleted, mobile channel dashboard + member debug) are captured to
    `e2e/screenshots/<mode>/` (mode = `enabled` or `api-only`, so both
    runs' screenshots can be committed side by side).

13. **Mobile channel-dashboard journey**: on `/agent` emulated at 360×640,
    the script creates a fixture channel (with `coder` as creator), opens the
    Channels tab and the channel row, and asserts the dashboard stacks —
    sidebar, conversation, and member/project column each fit the viewport
    with no horizontal overflow. It then clicks a member row and proves the
    debug pane opens and the page still fits; both screenshots
    (`agent-channels-mobile.png`, `agent-channels-member-mobile.png`) are
    captured and the fixture channel is deleted afterwards (project-folder
    prune verified via the workspace API).
## Exit code / gate

Exit code `0` only when every route check and every journey (channel,
mobile channel dashboard, sessions, files, HTML view, buckets, cron,
skills, settings) pass
*without* console/network errors — this is the Phase-5 browser quality gate.
Failures print the failing routes/checks and the collected errors in
`e2e/report-<mode>.json` (also mirrored to `e2e/report.json`).

## Notes

- Every check opens a brand-new tab via `PUT /json/new` and closes every tab
  it created in a `finally` block — even when a route fails — so runs never
  leave stray `localhost:3333` tabs behind in a busy Chrome.
- The saved-connection journey needs no external services: it runs a hermetic
  fake OpenAI-compatible upstream (Node `http` server on an ephemeral port)
  and tears the fixture Connection + upstream down in `finally` on both
  success and failure.
- Wait loops have explicit per-step timeouts and content settle conditions
  (e.g. the settings page waits for "Connections (" before checking body
  text), so slow renders on a loaded machine don't produce false failures.
- Progress is logged per route/step; a global watchdog aborts after
  `E2E_WATCHDOG_MS` (default 10 min).
- Messages that auto-start agent jobs invoke the real LLM configured by the
  backend; the run usually finishes in a few seconds.
- Navigation aborts (`net::ERR_ABORTED`) are ignored as noise — they are the
  old document being discarded when the script navigates.
- The bucket journey deletes its own fixture through `DELETE /api/buckets/:id`
  (via the UI and in cleanup); the docker CLI + `fmcv-db` container are still
  used by the psql fallback/verification, so if docker is unavailable the
  sweep and cleanup report an error rather than silently leaving fixture rows
  behind.
- The skills journey needs no docker: skills expose a full CRUD API, so the
  fixture is deleted via `DELETE /api/skills/:id` and verified gone; the
  pre-run stale sweep removes any `browser-e2e-skill-*` leftovers the same
  way.
- The files and html-view journeys need no docker either: their fixtures are
  deleted through the UI and double-checked with the files API. The pre-run
  stale sweep also removes leftover `browser-e2e-files-*` /
  `browser-e2e-html-*` fixture folders — emptying each folder first because
  the files API refuses to delete non-empty directories — plus `.dot-*`
  fixture files left by interrupted runs.
- The mobile channel-dashboard journey's `browser-e2e-mobile-*` fixture is
  covered by the same pre-run stale sweep as the other `browser-e2e-*`
  channels, so an interrupted run is cleaned up on the next start.
