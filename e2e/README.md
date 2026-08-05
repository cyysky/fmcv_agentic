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

## What it checks

1. **Routes load cleanly**: `/`, `/settings`, `/agent` render their expected
   content with **no console errors, no uncaught exceptions, no failed
   network requests, and no HTTP >= 400 responses** (measured over CDP events,
   including polling fetches the SPA makes after first paint).
2. **Real user journey**: on `/agent`, the script opens the Channels tab,
   creates a new channel via the modal (with `coder` as creator), posts a
   message, and waits for the auto-reply agent job to reach a terminal state
   (`[answer]`, `[stopped]`, or `[error]`).
3. **Screenshots**: key screens (home, settings, agent, channel running,
   channel done) are captured to `e2e/screenshots/`.

## Exit code / gate

Exit code `0` only when every route check and the channel journey pass
*without* console/network errors — this is the Phase-5 browser quality gate.
Failures print the failing routes/checks and the collected errors in
`e2e/report.json`.

## Notes

- The script reuses an existing tab whose URL matches, otherwise opens a new
  tab and closes any tab it created when done.
- Messages that auto-start agent jobs invoke the real LLM configured by the
  backend; the run usually finishes in a few seconds.
- Navigation aborts (`net::ERR_ABORTED`) are ignored as noise — they are the
  old document being discarded when the script navigates.
