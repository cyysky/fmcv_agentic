# Browser E2E (CDP)

Repeatable end-to-end browser checks for FMCV Agentic, driven through a real
Chrome instance over the Chrome DevTools Protocol. Zero npm dependencies
(Node 22+ built-in `fetch`/`WebSocket` only).

## Prerequisites

Chrome must already be running with a remote debugging port:

```sh
google-chrome --remote-debugging-port=9222 --remote-allow-origins=*   --user-data-dir=/tmp/fmcv-chromedata
```

The app must be up (`docker compose up -d --build`); the script talks to the
frontend in the browser and requires the backend API reachable from Chrome's
network view.

## Run

```sh
cd e2e
node browser-e2e.mjs
# or from anywhere:
node e2e/browser-e2e.mjs
```

Environment overrides:

| Variable            | Default                       | Meaning                             |
| ------------------- | ----------------------------- | ----------------------------------- |
| `CHROME_DEBUG_HOST` | `127.0.0.1`                   | CDP host                            |
| `CHROME_DEBUG_PORT` | `9222`                        | CDP port                            |
| `E2E_APP_BASE`      | `http://localhost:3333`       | frontend base URL                   |
| `E2E_SHOT_DIR`      | `e2e/screenshots`             | screenshot output dir               |
| `E2E_REPORT`        | `e2e/report.json`             | JSON report path                    |
| `E2E_WATCHDOG_MS`   | `600000`                      | overall run watchdog                |
| `E2E_CONN_HOST`      | auto-detected                 | host/IP the fixture connection points the backend at (override when the backend container cannot reach the auto-detected IP) |
| `E2E_CONN_MODEL`     | `ds4-flash`                   | model name stored on the fixture connection in the sessions journey |
| `E2E_CONN_OVERRIDE_MODEL` | `qwen3.6-35b`          | catalog model picked as an override during the sessions journey (must differ from `E2E_CONN_MODEL`) |

## What it checks

1. **Routes load cleanly**: `/`, `/settings`, `/agent`, `/files` render their
   expected content with **no console errors, no uncaught exceptions, no failed
   network requests, and no HTTP >= 400 responses** (measured over CDP events,
   including polling fetches the SPA makes after first paint).
2. **Document titles**: each route must expose its expected browser tab
   title (`FMCV Agentic`, `Settings - FMCV Agentic`, `Agent - FMCV Agentic`).
3. **Channel journey**: on `/agent`, the script opens the Channels tab,
   creates a new channel via the modal (with `coder` as creator), posts a
   message, and waits for the auto-reply agent job to reach a terminal state
   (`[answer]`, `[stopped]`, or `[error]`).
4. **Sessions + saved-connection journey**: on `/agent`, the script opens the
   Sessions tab, creates a session, posts a live converse, asserts the
   auto-title and history survive a page reload, renames the session through
   the UI, and reopens it to prove history + title persisted. It then starts
   a hermetic fake OpenAI-compatible upstream on an ephemeral port, creates a
   fixture Connection via the API (base URL pointing at that upstream, with a
   stored model + bearer key), selects it in the header picker, and proves
   the saved connection drives the chat: the model picker defers to the
   connection's model, the wire converse POST carries `connectionId` with no
   `model` key, the upstream sees `POST /chat/completions` with the
   connection's model and `Bearer <stored key>`, its reply renders in the
   thread, the sidebar badges the pinned session, and GET sessions shows the
   server-side `connectionId`. With the connection still active it then
   picks a catalog model and proves the override path: the wire POST carries
   both `connectionId` and `model`, the same upstream receives the override
   model with the fixture's bearer key, and the override model is persisted
   server-side (`E2E_CONN_OVERRIDE_MODEL` controls which catalog model is
   picked and must differ from `E2E_CONN_MODEL`). Finally it restores the
   default gateway, deletes the fixture Connection + upstream, and asserts
   cleanup (`E2E_CONN_HOST` / `E2E_CONN_MODEL` override the fixture
   endpoint/model).
5. **Files journey**: on `/files`, the script creates a nested file and a
   dotfile through the UI (agent scope), verifies the root listing shows both,
   navigates into the folder, reads the file content back, deletes the file +
   folder + dotfile through the UI, and then confirms server-side removal via
   the files API (no leftovers).
6. **Settings journey**: the script creates a throwaway connection via the
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
7. **Screenshots**: key screens (home, settings, agent, channel running,
   channel done, sessions picker/connection, files before/after) are captured
   to `e2e/screenshots/`.

## Exit code / gate

Exit code `0` only when every route check and the channel journey pass
*without* console/network errors — this is the Phase-5 browser quality gate.
Failures print the failing routes/checks and the collected errors in
`e2e/report.json`.

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
