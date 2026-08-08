#!/usr/bin/env node
// browser-e2e.mjs — repeatable end-to-end browser checks for FMCV Agentic
// built on the Chrome DevTools Protocol (no npm deps; Node 22+ global WebSocket).
//
// Requires a Chrome instance on CHROME_DEBUG_PORT (default 9222):
//   google-chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=/tmp/chromedata
//
// Usage:
//   E2E_APP_BASE=http://localhost:3333 node e2e/browser-e2e.mjs
//   E2E_API_ONLY=1 E2E_APP_BASE=http://localhost:3333 node e2e/browser-e2e.mjs
//     (run with the backend in API-only mode: the cron flow asserts the
//      "Scheduler disabled — API-only" chip instead of active/standby)
//   CHROME_DEBUG_PORT=9222 E2E_APP_BASE=http://10.0.151.7:3333 node e2e/browser-e2e.mjs
//   E2E_CONN_HOST=<host-ip>  # host IP the Dockerized backend can reach for the fake upstream
//                            # (defaults to the APP hostname or `hostname -I`)
//
// Checks:
//   1. Every SPA route (/, /agent, /files, /buckets, /cron, /skills, /settings)
//      loads without console errors / failed network requests
//   2. Each route renders its expected document.title (browser tab title)
//   3. /agent: create a channel, post a message, agent runs to an answer/stop
//   4. Screenshots land in e2e/screenshots/, report printed to stdout + JSON
//   5. Channel deletion prunes the per-channel project folder (verified via the
//      workspace API — no docker/container dependency)
//   6. Sessions: create a persisted chat, converse, reload the page and re-open
//      it from the sidebar (history survived), then prove a saved connection
//      drives a real turn (picker -> connectionId -> the connection's own
//      endpoint/model/key on a hermetic fake upstream), then delete everything
//   7. Files: create a file + dotfile through the /files UI, read the content
//      back, download it (wire headers/bytes + saved-to-disk when CDP allows),
//      then delete both through the UI and verify server-side removal
//   8. Global nav: active-route state per page + nav links drive real
//      client-side navigation between all six routes
//   9. Dark mode: all six routes re-probed with prefers-color-scheme: dark
//      (Emulation.setEmulatedMedia), asserting dark surfaces actually apply
//      and the pages still render without console/network errors
//   10. Mobile: all six routes re-probed at 360x640 with device metrics,
//      asserting no horizontal overflow, nav links fit, and the agent
//      composer / files row grid are usable
//   10b. Buckets: create a document bucket through the /buckets UI (agent
//      folder), prove a duplicate name 409s in-page, upload a document,
//      prove a duplicate upload 409s, download it (CDP saved bytes when
//      available), reload and verify both bucket and document persist,
//      rename the bucket through the UI and prove the document survives,
//      then delete it via the two-click confirm (the new DELETE API backs
//      both the UI and the server-side cleanup)
//   10c. Cron: create a cron job through the /cron UI, run it now (waiting
//      for a Done/Failed terminal status pill), rename it through the UI,
//      pause/resume it, then delete it with the two-click confirm and verify
//      server-side cleanup; the scheduler chip assertion switches with
//      E2E_API_ONLY=1 (disabled chip + no background firing) vs the default
//      enabled mode (active/standby chip)
//   10d. Skills: create a skill through the /skills UI with instructions and
//      install it (Installed pill + registry notice), reload and verify it
//      persists, edit description/content, uninstall and reinstall it, then
//      delete it with the two-click confirm and verify server-side cleanup
//   10e. HTML view: create an HTML file through the /files UI, prove the
//      in-app preview renders it inside a sandboxed iframe served inline by
//      the same-origin frontend proxy (/api/files/view — text/html + inline
//      + CSP sandbox headers preserved from the backend), assert the new-tab
//      link points at that proxy, click "Open in new tab" and prove the same
//      link renders the document in a fresh tab, then delete the fixture
//      through the UI and verify server-side cleanup
//   10f. Mobile channel dashboard: at 360x640 the channel dashboard stacks
//      sidebar / conversation / right column with no horizontal overflow,
//      the member panel is reachable, and clicking a member opens the debug
//      panel inside the scrollable column (screenshots + channel fixture
//      cleanup)
//   11. Settings: editing a connection never sends `apiKey` back (the field
//      starts blank on edit so the masked preview cannot clobber the stored
//      secret), and the new Test button probes a connection and renders a
//      graceful inline result
//   12. Pre-run stale sweep: rows/folders from interrupted runs with this
//      script's fixture prefixes (browser-e2e-*, e2e-settings-*, e2e-auto-*,
//      e2e-session-*, e2e-status-*) are deleted before any flow starts
//   13. Settings model discovery + probe persistence: Fetch Models fills the
//      Models textarea through both the stored-key and draft endpoints
//      (case-insensitive dedupe, graceful dead-endpoint failure), probes
//      persist server-side and survive reload with a "probed HH:MM" marker,
//      and failure-with-status rows keep their HTTP 401 · N ms metrics
// Exits non-zero when a main flow fails (quality gate for the round).

import { mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.CHROME_DEBUG_HOST || "127.0.0.1";
const PORT = process.env.CHROME_DEBUG_PORT || "9222";
const BASE = `http://${HOST}:${PORT}`;
const APP = (process.env.E2E_APP_BASE || "http://localhost:3333").replace(/\/$/, "");
// Backend API used by the cleanup step (same host, port 5555, /api prefix).
const API = process.env.E2E_API_BASE || APP.replace(/:\d+/, ":5555") + "/api";
// Resolve artifact paths relative to this script's directory so the script
// behaves the same no matter where it is invoked from.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(process.env.E2E_SHOT_DIR || resolve(SCRIPT_DIR, "screenshots"));
const REPORT = resolve(process.env.E2E_REPORT || resolve(SCRIPT_DIR, "report.json"));
// Overall watchdog: a stuck CDP target must not let the round hang forever.
const WATCHDOG_MS = Number(process.env.E2E_WATCHDOG_MS || 10 * 60 * 1000);
mkdirSync(SHOT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) =>
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${args.join(" ")}`);

/** Tabs this run created; they are closed in `finally` even on failure. */
const createdTabs = [];

/* ----------------------------- CDP client ----------------------------- */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ws.addEventListener("message", (e) => this._onMessage(e));
    this.ws.addEventListener("close", () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.addEventListener("open", res, { once: true });
      this.ws.addEventListener("error", () => rej(new Error("CDP websocket error")), { once: true });
    });
  }
  on(method, fn) {
    const set = this.handlers.get(method) ?? new Set();
    set.add(fn);
    this.handlers.set(method, set);
  }
  _onMessage(e) {
    const msg = JSON.parse(e.data);
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result || msg);
      return;
    }
    if (msg.method) {
      for (const fn of this.handlers.get(msg.method) ?? []) fn(msg.params);
    }
  }
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP websocket closed"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    if (!this.closed) this.ws.close();
  }
}

async function httpJson(path, method = "GET") {
  const r = await fetch(`${BASE}${path}`, { method });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}

/** Temporary OpenAI-compatible upstream for the hermetic connection fixture.
 *  Serves /v1/chat/completions on an ephemeral port and records every request
 *  (body + authorization header) so the E2E can prove the agent routed the
 *  turn to the saved connection's endpoint/model/key without touching a real
 *  LLM or any secret. */
async function startFakeUpstream(options = {}) {
  // Options: `key` auth-gates both routes; `chatStatus` (default 200) makes
  // POST /chat/completions fail with that HTTP status so the E2E can exercise
  // failure-with-status metrics. GET /models deliberately returns a
  // case-variant duplicate so the Settings Fetch Models flow can prove
  // case-insensitive dedupe (probe-model, llama-3.1-70b, LLAMA-3.1-70B).
  const expectedKey = options.key ?? null;
  const chatStatus = Number(options.chatStatus ?? 200);
  const received = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw || "{}");
      } catch {
        body = null;
      }
      received.push({
        url: req.url,
        method: req.method,
        authorization: req.headers.authorization ?? null,
        body,
      });
      if (req.method === "GET" && (req.url ?? "").endsWith("/models")) {
        if (expectedKey && req.headers.authorization !== `Bearer ${expectedKey}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unauthorized" } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          object: "list",
          data: [
            { id: "probe-model" },
            { id: "llama-3.1-70b" },
            { id: "LLAMA-3.1-70B" },
          ],
        }));
        return;
      }
      if (req.method === "POST" && (req.url ?? "").endsWith("/chat/completions")) {
        if (expectedKey && req.headers.authorization !== `Bearer ${expectedKey}`) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: "unauthorized" } }));
          return;
        }
        if (chatStatus !== 200) {
          res.writeHead(chatStatus, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `simulated HTTP ${chatStatus}` } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "e2e-conn-completion",
          object: "chat.completion",
          created: 0,
          model: body?.model ?? "e2e",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Connection fixture reply OK" },
            finish_reason: "stop",
          }],
        }));
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  return { server, port: server.address().port, received };
}

/** IP a Dockerized backend can use to reach an upstream started on this host:
 *  explicit override, else the APP hostname when non-loopback, else the first
 *  non-loopback host address, else loopback. */
function connectionHostIp() {
  if (process.env.E2E_CONN_HOST) return process.env.E2E_CONN_HOST;
  try {
    const appHost = new URL(APP).hostname;
    if (appHost && appHost !== "localhost" && appHost !== "127.0.0.1" && appHost !== "::1" && /^\d+\.\d+\.\d+\.\d+$/.test(appHost)) return appHost;
  } catch {
    // fall through to the address sniff
  }
  try {
    const addrs = execFileSync("hostname", ["-I"], { encoding: "utf8", timeout: 5000 })
      .trim().split(/\s+/).filter(Boolean);
    const v4 = addrs.find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a));
    if (v4) return v4;
  } catch {
    // fall through to loopback
  }
  return "127.0.0.1";
}

/** Open a brand-new page tab (never silently reuse a busy/stale tab). */
async function openTab(url) {
  const t = await httpJson(`/json/new?${encodeURIComponent(url)}`, "PUT");
  createdTabs.push(t.id);
  return { id: t.id, url, wsUrl: t.webSocketDebuggerUrl, created: true };
}

async function closeCreatedTabs() {
  for (const id of createdTabs.splice(0)) {
    // /json/close returns the plain text "Target is closing" (200), not JSON,
    // so httpJson would choke on it. Only a real failure (non-2xx or fetch
    // error) is worth a warning.
    const ok = await fetch(`${BASE}/json/close/${id}`, { method: "GET" })
      .then((r) => r.ok)
      .catch(() => false);
    if (!ok) log(`  warn: could not close tab ${id}`);
  }
}

async function evalJs(c, expression) {
  const r = await c.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    const where = d.url && d.lineNumber != null ? ` (${d.url}:${d.lineNumber + 1})` : "";
    throw new Error(`eval failed: ${d.text}${where}: ${d.exception?.description ?? ""}`);
  }
  return r.result?.value;
}

// Click a <button> whose trimmed text equals or contains `text`.
const jsClick = (text, exact) => {
  const matcher = exact
    ? `b.textContent.trim() === ${JSON.stringify(text)}`
    : `b.textContent.includes(${JSON.stringify(text)})`;
  return `(() => {
  const els = [...document.querySelectorAll("button")];
  const el = els.find((b) => ${matcher});
  if (!el) return false;
  el.click();
  return true;
})()`;
};

const jsSetInput = (selector, value) => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return el.value;
})()`;

/** Click a button (by exact text) inside a specific listing row. */
const rowBtnExpr = (name, text) => `(() => {
  const row = document.querySelector(${JSON.stringify(`[data-name="${name}"]`)});
  if (!row) return false;
  const b = [...row.querySelectorAll("button")].find((x) => x.textContent.trim() === ${JSON.stringify(text)});
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Build a page expression that calls document.querySelector safely. */
const selExpr = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

/** Dark-mode assertions shared by every route probe. */
const bodyBgDark = `["rgb(0, 0, 0)", "rgb(10, 10, 10)"].includes(getComputedStyle(document.body).backgroundColor)`;
const noHorizontalOverflow = `document.documentElement.scrollWidth <= innerWidth + 2`;
const navLinksFit = `[...document.querySelectorAll('nav a')].every(a => { const r = a.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; })`;
const composerVisible = `(() => { const f = document.querySelector('form[class*="composer"]'); if (!f) return false; const r = f.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= innerWidth + 1; })()`;
const filesRowGrid = `(() => { const r = document.querySelector('li[class*="row"]'); if (!r) return false; return getComputedStyle(r).display === "grid" && getComputedStyle(r).gridTemplateColumns.split(" ").length === 3; })()`;


/** Global-nav assertions shared by every route probe. */
const navChecks = {
  present: `!!${selExpr('nav[aria-label="Main"]')}`,
  links: `(() => {
    const hrefs = [...document.querySelectorAll('nav[aria-label="Main"] a')].map((a) => a.getAttribute("href"));
    return ["/", "/agent", "/files", "/buckets", "/cron", "/skills", "/settings"].every((h) => hrefs.includes(h));
  })()`,
};
const navActive = (href) =>
  `document.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.getAttribute("href") === ${JSON.stringify(href)}`;

async function waitFor(c, expression, timeoutMs, stepMs = 400, label = "") {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await evalJs(c, expression);
    } catch {
      // Page may be mid-navigation; keep polling until the timeout.
      last = null;
    }
    if (last) return last;
    await delay(stepMs);
  }
  log(`  warn: waitFor timed out after ${timeoutMs}ms${label ? ` (${label})` : ""}`);
  return null;
}

async function screenshot(c, name) {
  const out = resolve(SHOT_DIR, name);
  const r = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(r.data, "base64"));
  return out;
}

/* --------------------------- error collection --------------------------- */

function wireErrorCapture(c, sink, opts = {}) {
  // Intentionally-expected HTTP statuses (e.g. a journey that must trigger a
  // duplicate 409) are recorded in sink.expectedHttp and excluded from the
  // page-quality error gate; they still exercise the app's error handling.
  const allowedStatuses = new Set(opts.allowedStatuses || []);
  const allowedLogPattern = [...allowedStatuses].length
    ? new RegExp(`status of (${[...allowedStatuses].join("|")})\\b`)
    : null;
  c.on("Network.loadingFailed", (p) => {
    // Aborts caused by navigation away are noise, not app failures.
    if (p.errorText && p.errorText.includes("net::ERR_ABORTED") && p.canceled) return;
    sink.netFailures.push({ url: p.url || "(unknown)", errorText: p.errorText });
  });
  c.on("Network.responseReceived", (p) => {
    if (p.response && p.response.status >= 400 && !/favicon/.test(p.response.url)) {
      if (allowedStatuses.has(p.response.status)) {
        if (!sink.expectedHttp.some((e) => e.url === p.response.url)) {
          sink.expectedHttp.push({ url: p.response.url, status: p.response.status });
        }
        return;
      }
      if (sink.httpErrors.every((e) => e.url !== p.response.url)) {
        sink.httpErrors.push({ url: p.response.url, status: p.response.status });
      }
    }
  });
  c.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error") {
      sink.consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  c.on("Runtime.exceptionThrown", (p) => {
    sink.exceptions.push(p.exceptionDetails?.text ?? "unknown exception");
  });
  c.on("Log.entryAdded", (p) => {
    if (p.entry?.level === "error") {
      if (allowedLogPattern && allowedLogPattern.test(p.entry.text || "")) return;
      sink.logErrors.push(p.entry.text);
    }
  });
}

function errorCount(sink) {
  return sink.netFailures.length + sink.httpErrors.length +
    sink.consoleErrors.length + sink.exceptions.length + sink.logErrors.length;
}

/* ------------------------------ flow steps ------------------------------ */

async function setupPage(url) {
  const tab = await openTab(url);
  const c = new CDP(tab.wsUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Log.enable");
  return { tab, c };
}

async function probeRoute(route) {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  log(`probe ${route.route} -> ${route.url}`);
  const { tab, c } = await setupPage(route.url);
  try {
    wireErrorCapture(c, sink);
    if (route.viewport) {
      await c.send("Emulation.setDeviceMetricsOverride", {
        width: route.viewport.width,
        height: route.viewport.height,
        deviceScaleFactor: 2,
        mobile: true,
      });
    }
    if (route.emulate === "dark") {
      await c.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: "dark" }],
      });
    }
    await c.send("Page.navigate", { url: route.url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, `${route.route} ready`);
    if (!ready) throw new Error(`${route.route}: page never reached readyState complete`);

    // Wait for the first expected body text so slow SPA renders (busy Chrome)
    // settle instead of failing on a half-drawn page.
    if (route.waitText) {
      const text = await waitFor(
        c,
        `document.body.innerText.includes(${JSON.stringify(route.waitText)})`,
        30000,
        600,
        `${route.route} content`,
      );
      if (!text) throw new Error(`${route.route}: expected text "${route.waitText}" never appeared`);
    }
    await delay(600);

    if (route.clickBeforeChecks) {
      const clicked = await evalJs(c, jsClick(route.clickBeforeChecks, true));
      if (!clicked) throw new Error(`${route.route}: before-checks click ${route.clickBeforeChecks} missing`);
      // Routes may declare their own form selector (e.g. the skills page's
      // create form); the default matches the shared panel class used by cron.
      const panelSelector = route.panelSelector || 'form[class*="panel"]';
      const panelSeen = await waitFor(
        c,
        `!!document.querySelector(${JSON.stringify(panelSelector)})`,
        10000,
        400,
        `${route.route} panel`,
      );
      if (!panelSeen) throw new Error(`${route.route}: panel never opened for checks`);
    }

    const docTitle = await evalJs(c, "document.title");
    const body = await evalJs(c, "document.body.innerText");
    const checks = {};
    for (const [name, text] of Object.entries(route.bodyText)) {
      checks[name] = body.includes(text);
    }
    if (route.jsChecks) {
      for (const [name, expr] of Object.entries(route.jsChecks)) {
        checks[name] = Boolean(await evalJs(c, expr));
      }
    }
    if (route.darkChecks) {
      for (const [name, expr] of Object.entries(route.darkChecks)) {
        checks[name] = Boolean(await evalJs(c, expr));
      }
    }
    if (route.mobileChecks) {
      for (const [name, expr] of Object.entries(route.mobileChecks)) {
        checks[name] = Boolean(await evalJs(c, expr));
      }
    }
    if (route.title) checks.docTitle = docTitle === route.title;
    await screenshot(c, route.shotName || `${route.route}.png`);
    return {
      route: route.route,
      url: route.url,
      docTitle,
      tabInfo: { id: tab.id, created: tab.created },
      checks,
      errors: sink,
    };
  } finally {
    c.close();
  }
}

/** Global-nav journey: active-route state on load, then use the nav links
 *  to move between every route and confirm the URL, title and active state
 *  follow along (proves the navigation actually works, not just renders). */
async function navFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/`;
  log(`flow global nav -> ${url}`);
  const { tab, c } = await setupPage(url);
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "nav home ready");
    if (!ready) throw new Error("nav flow: page never loaded");
    const flow = { steps: [], result: null };

    const active = await waitFor(
      c,
      `!!document.querySelector('nav[aria-label="Main"] a[aria-current="page"]')`,
      30000,
      500,
      "nav active link",
    );
    if (!active) throw new Error("nav flow: active nav link never rendered");
    flow.homeActive = await evalJs(c, navActive("/"));
    flow.steps.push("active-home");

    const clickAndVerify = async (href, pathname, titlePart, label) => {
      const clicked = await evalJs(c, `(() => {
        const a = [...document.querySelectorAll('nav[aria-label="Main"] a')]
          .find((x) => x.getAttribute("href") === ${JSON.stringify(href)});
        if (!a) return false;
        a.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`nav flow: ${label} link missing`);
      const atPath = await waitFor(c, `location.pathname === ${JSON.stringify(pathname)}`, 20000, 400, `nav ${label} path`);
      if (!atPath) throw new Error(`nav flow: navigation to ${label} never committed`);
      const titled = await waitFor(c, `document.title.includes(${JSON.stringify(titlePart)})`, 20000, 400, `nav ${label} title`);
      if (!titled) throw new Error(`nav flow: ${label} document.title incorrect`);
      const activeLink = await waitFor(
        c,
        `document.querySelector('nav[aria-label="Main"] a[aria-current="page"]')?.getAttribute("href") === ${JSON.stringify(href)}`,
        10000,
        300,
        `nav ${label} active`,
      );
      if (!activeLink) throw new Error(`nav flow: active state did not move to ${label}`);
      flow[`${label}Active`] = true;
      flow.steps.push(`active-${label}`);
    };

    await clickAndVerify("/files", "/files", "Files - ", "files");
    await clickAndVerify("/buckets", "/buckets", "Buckets - ", "buckets");
    await clickAndVerify("/cron", "/cron", "Cron - ", "cron");
    await clickAndVerify("/skills", "/skills", "Skills - ", "skills");
    await clickAndVerify("/settings", "/settings", "Settings - ", "settings");
    await clickAndVerify("/agent", "/agent", "Agent - ", "agent");
    await clickAndVerify("/", "/", "FMCV Agentic", "home");
    await delay(300);
    await screenshot(c, "nav-journey.png");
    flow.result = { active: true };
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
  }
}

/** Resolve the id of the channel a just-created E2E run owns. */
async function findChannelId(channelSlug) {
  const res = await fetch(`${API}/channels`);
  if (!res.ok) throw new Error(`list channels -> HTTP ${res.status}`);
  const channels = await res.json();
  const hit = channels.find((c) => c.slug === channelSlug);
  return hit?.id ?? null;
}

/** Drive cleanup over the real API: delete the E2E channel and confirm the
 *  row is gone, so repeat runs don't litter the workspace/database. */
async function cleanupChannel(channelSlug) {
  const id = await findChannelId(channelSlug);
  if (!id) {
    log(`  cleanup: channel #${channelSlug} not found (nothing to do)`);
    return "not-found";
  }
  const res = await fetch(`${API}/channels/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`delete channel -> HTTP ${res.status}`);
  const checked = await findChannelId(channelSlug);
  if (checked) throw new Error(`cleanup failed: #${channelSlug} still listed`);
  log(`  cleanup: deleted #${channelSlug} (${id})`);
  return "deleted";
}

/** A channel run "achieved its terminal state" when it reached any final
 *  render — answer, stopped, or a real agent error. Only a page-level crash /
 *  stuck run is a hard failure in the browser gate. */
function terminalOk(result) {
  return (
    !!result &&
    (result.answer === true ||
      result.stopped === true ||
      result.error === true)
  );
}

async function agentChannelFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/agent`;
  log(`flow agent channel -> ${url}`);
  const { tab, c } = await setupPage(url);
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "agent ready");
    if (!ready) throw new Error("agent flow: page never loaded");
    const flow = { steps: [], timings: {}, result: null };

    // Composer must exist before we try to drive the channel UI.
    const composer = await waitFor(
      c,
      `!!${selExpr('textarea')}`,
      30000,
      600,
      "agent composer",
    );
    if (!composer) throw new Error("agent flow: page never rendered its composer");
    flow.docTitle = await evalJs(c, "document.title");
    await delay(800);

    // 1. Open the Channels tab and the New-channel modal.
    await evalJs(c, jsClick("Channels", true));
    await delay(400);
    const modalOpen = await evalJs(c, `!!${selExpr('input[placeholder="# channel name"]')}`);
    if (!modalOpen) {
      await evalJs(c, jsClick("New channel", false));
      await delay(400);
    }
    const channelName = `browser-e2e-${Date.now().toString(36)}`;
    await evalJs(c, jsSetInput('input[placeholder="# channel name"]', channelName));
    await evalJs(c, jsSetInput('input[placeholder="creatorAgent"]', "coder"));
    await delay(100);
    await evalJs(c, jsClick("Create", true));
    flow.steps.push("created-channel");
    flow.channelName = channelName;
    log(`  created channel ${channelName}`);

    // 2. The channel auto-opens; wait for its composer, then post a message.
    const composerReady = await waitFor(
      c,
      `!!${selExpr('textarea[placeholder*="Post a message"]')}`,
      30000,
      600,
      "channel composer",
    );
    if (!composerReady) throw new Error("agent flow: channel composer never appeared");
    const msg =
      'Follow the channel brief: write round2.md into YOUR OWN agent folder with write_own_file ' +
      '(args: { path: "round2.md", content: "# Round 2 own-folder E2E artifact." }), then reply hello.';
    await evalJs(c, jsSetInput('textarea[placeholder*="Post a message"]', msg));
    await delay(100);
    // Submit the channel composer specifically (the mode-toggle button is also
    // labelled "Post"): find the form that holds a textarea and click its
    // enabled submit button.
    const submitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector("textarea"));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!submitted) throw new Error("agent flow: composer submit button not found/enabled");
    flow.steps.push("posted-message");
    flow.timings.postedAt = new Date().toISOString();
    log("  posted message; waiting for agent run");

    // Capture the "running" state a beat later for the report.
    await delay(1800);
    await screenshot(c, "agent-channel-running.png");

    // 3. Wait for a terminal render: [answer], [stopped] or [error].
    const started = Date.now();
    const terminal = await waitFor(
      c,
      '(() => { const t = document.body.innerText.toUpperCase(); return t.includes("[ANSWER]") || t.includes("[STOPPED]") || t.includes("[ERROR]"); })()',
      180000,
      800,
      "agent terminal state",
    );
    flow.timings.finishedAt = new Date().toISOString();
    if (!terminal) throw new Error("agent flow: no terminal state within 180s");
    const state = await evalJs(c, `(() => {
      const t = document.body.innerText.toUpperCase();
      return { answer: t.includes("[ANSWER]"), stopped: t.includes("[STOPPED]"), error: t.includes("[ERROR]") };
    })()`);
    await delay(500);
    await screenshot(c, "agent-channel-done.png");
    flow.result = state;
    flow.steps.push("terminal-state");
    flow.timings.elapsedMs = Date.now() - started;
    log(`  agent terminal: ${JSON.stringify(state)} in ${flow.timings.elapsedMs}ms`);
    const feed = await evalJs(c, 'document.querySelector("[class*=\\"channelFeed\\"]")?.innerText ?? "NO FEED"');
    flow.feedSnippet = feed.slice(0, 600);
    return { url, tabInfo: { id: tab.id, created: tab.created }, channelName, flow, errors: sink };
  } finally {
    c.close();
  }
}

/** After channel delete, confirm the per-channel project folder is gone from
 *  the backend workspace. Docker-free: the backend's `GET /api/agent/workspaces`
 *  snapshots the actual projects directory on disk, so it proves the prune
 *  without requiring a container/exec (skipped cleanly when the API is down). */
async function projectFolderPruneCheck(channelPrefix) {
  try {
    const res = await fetch(`${API}/agent/workspaces`);
    if (!res.ok) throw new Error(`workspaces -> HTTP ${res.status}`);
    const body = await res.json();
    const projects = Array.isArray(body.projects) ? body.projects : [];
    const names = projects.map((p) => String(p.name ?? p));
    const leftovers = names.filter((n) => n.startsWith(channelPrefix));
    return { ok: leftovers.length === 0, leftovers, projects: names };
  } catch (err) {
    return { ok: null, error: String(err.message ?? err).slice(0, 200), note: "workspace API unavailable; skipped" };
  }
}

async function agentChannelCleanup(f) {
  if (!f?.channelName) return null;
  const parts = [];
  try {
    parts.push(await cleanupChannel(f.channelName));
    // The channel brief asks the `coder` agent to write round2.md into its
    // OWN agent folder. Channel deletion only cascades the channel's project
    // folder, so this fixture file must be pruned separately or every run
    // leaves an agent-scope artifact behind.
    const delRes = await fetch(
      `${API}/files/delete?scope=agent:coder&path=round2.md`,
      { method: "DELETE" },
    );
    if (delRes.status >= 400 && delRes.status !== 404) {
      throw new Error(`delete agent fixture round2.md -> HTTP ${delRes.status}`);
    }
    const listRes = await fetch(`${API}/files/list?scope=agent:coder&path=`);
    if (!listRes.ok) throw new Error(`agent files list -> HTTP ${listRes.status}`);
    const body = await listRes.json();
    const names = (body.entries ?? []).map((e) => e.name);
    if (names.includes("round2.md")) {
      throw new Error("agent fixture round2.md still present after delete");
    }
    parts.push("agent-fixture-clean");
    log("  cleanup: channel deleted + agent fixture round2.md removed");
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
  return parts.join("+");
}

/** Mobile channel-dashboard flow: at a 360x640 phone viewport the channel
 *  dashboard must stack sidebar / conversation / right column with no
 *  horizontal overflow, and the member debug panel must be reachable inside
 *  the scrollable column (the member list lives below the conversation). */
async function mobileChannelFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/agent`;
  const channelName = `browser-e2e-mobile-${Date.now().toString(36)}`;
  const created = await fetch(`${API}/channels`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: channelName, creatorAgent: "coder" }),
  });
  if (!created.ok) {
    throw new Error(`mobile channel flow: create fixture #${channelName} -> HTTP ${created.status}`);
  }
  log(`flow mobile channel dashboard -> ${url} (fixture #${channelName})`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], timings: {}, result: null, channelName };
  const started = Date.now();
  try {
    wireErrorCapture(c, sink);
    // Force a phone-shaped viewport before the page boots.
    await c.send("Emulation.setDeviceMetricsOverride", {
      width: 360,
      height: 640,
      deviceScaleFactor: 2,
      mobile: true,
    });
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "mobile agent ready");
    if (!ready) throw new Error("mobile channel flow: page never loaded");

    // 1. Open the Channels tab, then the fixture channel row.
    const channelsTab = await waitFor(
      c,
      `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Channels"); if (!b) return false; b.click(); return true; })()`,
      15000,
      500,
      "channels tab",
    );
    if (!channelsTab) throw new Error("mobile channel flow: Channels tab not found");
    const listSeen = await waitFor(
      c,
      `!!${selExpr('[class*="channelList"]')}`,
      15000,
      500,
      "channel list",
    );
    if (!listSeen) throw new Error("mobile channel flow: channel list never rendered");
    // The list container can render while the async /channels fetch is still
    // in flight, so poll for the fixture row instead of checking once.
    const rowOpened = await waitFor(
      c,
      `(() => {
        const rows = [...document.querySelectorAll('[class*="channelList"] [class*="channelRow"]')];
        const row = rows.find((r) => r.innerText.includes(${JSON.stringify(channelName)}));
        const b = row && row.querySelector("button");
        if (!b) return false;
        b.click();
        return true;
      })()`,
      15000,
      500,
      "mobile fixture channel row",
    );
    if (!rowOpened) throw new Error(`mobile channel flow: fixture row #${channelName} not found`);

    // 2. Wait for the member list, then assert the stacked layout.
    const membersReady = await waitFor(
      c,
      `document.querySelectorAll('[class*="memberList"] [class*="memberRow"]').length > 0`,
      15000,
      500,
      "member list",
    );
    if (!membersReady) throw new Error("mobile channel flow: member list never appeared");
    const layout = await evalJs(c, `(() => {
      const vw = innerWidth;
      const inView = (el) => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= -1 && r.right <= vw + 1;
      };
      const sidebar = document.querySelector('[class*="channelSidebar"]');
      const conversation = document.querySelector('[class*="conversation"]');
      const rightCol = document.querySelector('[class*="rightCol"]');
      const channels = document.querySelector('[class*="channels"]');
      const rect = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        noHorizontalOverflow: document.documentElement.scrollWidth <= vw + 2,
        stacked: !!channels && getComputedStyle(channels).flexDirection === "column",
        sidebarInView: inView(sidebar),
        conversationInView: inView(conversation),
        rightColInView: inView(rightCol),
        widths: {
          sidebar: rect(sidebar)?.width ?? -1,
          conversation: rect(conversation)?.width ?? -1,
          rightCol: rect(rightCol)?.width ?? -1,
        },
      };
    })()`);
    flow.layout = layout;
    if (
      !layout.noHorizontalOverflow ||
      !layout.stacked ||
      !layout.sidebarInView ||
      !layout.conversationInView ||
      !layout.rightColInView
    ) {
      throw new Error(`mobile channel flow: stacked dashboard layout broken (${JSON.stringify(layout)})`);
    }
    flow.steps.push("dashboard-layout");
    await screenshot(c, "agent-channels-mobile.png");

    // 3. Click a member row and prove the debug panel opens without overflow.
    const memberClicked = await evalJs(c, `(() => {
      const b = document.querySelector('[class*="memberList"] [class*="memberRow"]');
      if (!b) return false;
      b.scrollIntoView({ block: "nearest" });
      b.click();
      return true;
    })()`);
    if (!memberClicked) throw new Error("mobile channel flow: no member row to click");
    const debugSeen = await waitFor(
      c,
      `!!${selExpr('[class*="memberDebug"]')}`,
      10000,
      400,
      "member debug",
    );
    if (!debugSeen) throw new Error("mobile channel flow: member debug never opened");
    const overflowAfterDebug = await evalJs(c, "document.documentElement.scrollWidth <= innerWidth + 2");
    if (!overflowAfterDebug) {
      throw new Error("mobile channel flow: horizontal overflow after opening member debug");
    }
    flow.result = { layoutOk: true, memberDebugReachable: true, overflowAfterDebug };
    flow.steps.push("member-debug");
    await delay(300);
    await screenshot(c, "agent-channels-member-mobile.png");
    flow.timings.elapsedMs = Date.now() - started;
    log(`  mobile channel dashboard verified in ${flow.timings.elapsedMs}ms`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, channelName, flow, errors: sink };
  } finally {
    c.close();
  }
}

/** Mobile channel-dashboard cleanup: delete the fixture channel, then prove
 *  its per-channel project folder is gone from the workspace. */
async function mobileChannelCleanup(f) {
  if (!f?.channelName) return null;
  const parts = [];
  try {
    parts.push(await cleanupChannel(f.channelName));
    const prune = await projectFolderPruneCheck("browser-e2e-mobile-");
    if (prune.ok === false) {
      parts.push(`project-leftovers:${prune.leftovers.join(",")}`);
    } else if (prune.ok === true) {
      parts.push("project-folder-clean");
    } else {
      parts.push(`prune-skipped:${prune.note ?? prune.error}`);
    }
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
  log(`  cleanup: mobile channel fixture removed (${parts.join("+")})`);
  return parts.join("+");
}

/** Sessions flow: create a persisted chat, converse, reload the page, and
 *  re-open the same session from the sidebar to prove history survived. */
async function agentSessionsFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/agent`;
  log(`flow agent sessions -> ${url}`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], timings: {}, result: null, fixtureId: null, fixtureName: null, fixtureModel: null, fixtureLive: null };
  let upstream = null;
  let connKey = "";
  try {
    wireErrorCapture(c, sink);
    // Hermetic fixture: a throwaway saved connection pointed at a local fake
    // OpenAI-compatible upstream, so the picker can drive a REAL turn
    // end-to-end (endpoint + model + key + reply) with no secrets and no
    // dependence on the real gateway. The fake records the wire request, so
    // route-through can be asserted at the upstream itself.
    upstream = await startFakeUpstream();
    connKey = `sk-e2e-session-${Date.now().toString(36)}`;
    flow.fixtureLive = true;
    const connModel = process.env.E2E_CONN_MODEL || "ds4-flash";
    const connName = `e2e-session-${Date.now().toString(36)}`;
    // A provider-specific model id that is NOT in the built-in catalog; it
    // must only appear in the picker after the connection row (with its
    // `models` list) is selected.
    const connListModel = `e2e-conn-list-${Date.now().toString(36)}`;
    flow.fixtureModels = [connListModel];
    const createdConn = await fetch(`${API}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: connName,
        baseUrl: `http://${connectionHostIp()}:${upstream.port}/v1`,
        modelName: connModel,
        contextLength: 128000,
        apiKey: connKey,
        models: flow.fixtureModels,
      }),
    });
    if (!createdConn.ok) {
      throw new Error(`sessions flow: could not create connection fixture (HTTP ${createdConn.status})`);
    }
    const conn = await createdConn.json();
    flow.fixtureId = conn.id;
    flow.fixtureName = conn.displayName;
    flow.fixtureModel = connModel;
    flow.steps.push("connection-fixture-created");
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "sessions ready");
    if (!ready) throw new Error("sessions flow: page never loaded");

    // 1. Open the Sessions tab and start a new chat.
    const clickable = await waitFor(
      c,
      `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sessions")`,
      30000,
      500,
      "sessions tab",
    );
    if (!clickable) throw new Error("sessions flow: Sessions tab missing");
    // Click may fire before React hydration attaches handlers; retry the click
    // until the sessions view (sidebar with "New chat") actually renders.
    const newChat = await waitFor(
      c,
      `(() => {
        if (document.body.innerText.includes("New chat")) return true;
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sessions");
        if (b) b.click();
        return false;
      })()`,
      30000,
      600,
      "new chat",
    );
    if (!newChat) throw new Error("sessions flow: New chat button missing");
    flow.createdAt = new Date().toISOString();
    await evalJs(c, jsClick("New chat", false));
    flow.steps.push("created-session");
    const composer = await waitFor(
      c,
      `!!${selExpr('textarea[placeholder*="Message this session"]')}`,
      30000,
      600,
      "sessions composer",
    );
    if (!composer) throw new Error("sessions flow: sessions composer never appeared");

    // 2. Post a real message and wait for the assistant bubble.
    const msg = `Hello from sessions E2E (${Date.now().toString(36)})`;
    flow.sentText = msg;
    await evalJs(c, jsSetInput('textarea[placeholder*="Message this session"]', msg));
    await delay(100);
    const submitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector("textarea"));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!submitted) throw new Error("sessions flow: composer submit button not found/enabled");
    flow.steps.push("posted-message");
    flow.timings.postedAt = new Date().toISOString();
    log("  posted session message; waiting for agent reply");

    const started = Date.now();
    const answered = await waitFor(
      c,
      `(() => {
        const els = [...document.querySelectorAll('[class*="bubbleAgent"]')];
        return els.length > 0 &&
          els.some((el) => el.innerText.trim().length > 0 && !el.innerText.includes("Typing"));
      })()`,
      180000,
      800,
      "sessions answer",
    );
    flow.timings.finishedAt = new Date().toISOString();
    if (!answered) throw new Error("sessions flow: no agent reply within 180s");
    const threadText = await evalJs(c, `document.querySelector('[class*="thread"]')?.innerText ?? "NO THREAD"`);
    flow.answerSeen = threadText.includes(msg);
    flow.threadSnippet = threadText.slice(0, 400);
    await delay(500);
    await screenshot(c, "agent-sessions-done.png");
    flow.steps.push("reply-rendered");

    // 2a. The backend auto-titles a default session from its first user
    //     message; the sidebar must show the derived title (refreshed by the
    //     frontend right after the reply lands).
    const autoTitle = await waitFor(
      c,
      `[...document.querySelectorAll('[class*="sessionTitle"]')].some((el) => el.textContent.trim() === ${JSON.stringify(msg)})`,
      15000,
      400,
      "auto-derived session title",
    );
    flow.autoTitleSeen = !!autoTitle;
    if (!autoTitle) throw new Error("sessions flow: auto-derived title not shown in sidebar");
    flow.timings.elapsedMs = Date.now() - started;
    log(`  sessions reply rendered in ${flow.timings.elapsedMs}ms (user text seen: ${flow.answerSeen})`);

    // 2b. Rename the session from the sidebar; the new title must survive the
    //     reload below just like the message history.
    const renameTitle = `Renamed ${Date.now().toString(36)}`;
    const renameClicked = await evalJs(c, `(() => {
      const btn = [...document.querySelectorAll("button")].find((b) =>
        (b.getAttribute("aria-label") || "").startsWith("Rename session"));
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (!renameClicked) throw new Error("sessions flow: rename affordance missing");
    const renameInput = await waitFor(
      c,
      `!!document.querySelector('input[aria-label="Session title"]')`,
      15000,
      400,
      "rename input",
    );
    if (!renameInput) throw new Error("sessions flow: rename input never appeared");
    const typed = await evalJs(c, `(() => {
      const input = document.querySelector('input[aria-label="Session title"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, ${JSON.stringify(renameTitle)});
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      return true;
    })()`);
    if (!typed) throw new Error("sessions flow: rename input not editable");
    const titleShown = await waitFor(
      c,
      `[...document.querySelectorAll('[class*="sessionTitle"]')].some((el) => el.textContent.trim() === ${JSON.stringify(renameTitle)})`,
      15000,
      400,
      "renamed title in sidebar",
    );
    if (!titleShown) throw new Error("sessions flow: renamed title not rendered in sidebar");
    flow.renamedTitle = renameTitle;
    flow.steps.push("renamed-session");
    log(`  session renamed to "${renameTitle}"`);

    // 3. Reload the page; the session should be persisted in the sidebar and
    //    its history should re-render when reopened. Guard every stage:
    //    navigation start -> fresh document ready -> React hydration marker.
    //    Clicking an SSR-ed but not-yet-hydrated tab button is a silent no-op,
    //    so the old "click until it appears" loop raced the dev-server compile.
    let navStarted = false;
    const onNavStart = () => { navStarted = true; };
    c.on("Page.frameStartedLoading", onNavStart);
    await c.send("Page.reload");
    const navDeadline = Date.now() + 20000;
    while (!navStarted && Date.now() < navDeadline) await delay(250);
    if (!navStarted) throw new Error("sessions flow: reload never committed");
    const reloaded = await waitFor(c, "document.readyState === 'complete'", 60000, 500, "reload ready");
    if (!reloaded) throw new Error("sessions flow: reload stalled");
    const hydrated = await waitFor(
      c,
      `(() => {
        const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sessions");
        if (!b) return false;
        return Object.keys(b).some((k) => k.startsWith("__reactProps") || k.startsWith("__reactFiber"));
      })()`,
      60000,
      500,
      "hydration after reload",
    );
    if (!hydrated) throw new Error("sessions flow: app never hydrated after reload");
    let item = null;
    let polls = 0;
    for (; polls < 60; polls += 1) {
      try {
        item = await evalJs(
          c,
          `(() => {
            const els = [...document.querySelectorAll('[class*="sessionItem"]')];
            if (els.length > 0) return true;
            const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "Sessions");
            if (b) b.click();
            return false;
          })()`,
        );
      } catch {
        item = null;
      }
      if (item) break;
      await delay(700);
    }
    if (!item) {
      const snap = await evalJs(
        c,
        `JSON.stringify({
          hasTab: [...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "Sessions"),
          items: document.querySelectorAll('[class*="sessionItem"]').length,
          sidebar: (document.querySelector('[class*="sessionSidebar"]')?.innerText ?? "(no sidebar)").slice(0, 200),
          errorTexts: [...document.querySelectorAll("div")]
            .filter((d) => d.children.length === 0 && (d.textContent.indexOf("failed") >= 0 || d.textContent.indexOf("error") >= 0))
            .map((d) => d.textContent.trim()).slice(0, 3),
          body: document.body.innerText.slice(0, 200).replace(/\\n/g, " | "),
        })`,
      ).catch(() => "(snapshot eval failed)");
      throw new Error(`sessions flow: no persisted session listed after reload; snapshot=${snap}`);
    }
    flow.steps.push("reload-list");
    await evalJs(c, `(() => {
      const b = document.querySelector('[class*="sessionItem"] button[class*="sessionOpen"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    const history = await waitFor(
      c,
      `document.querySelector('[class*="thread"]')?.innerText.includes(${JSON.stringify(msg)}) ?? false`,
      30000,
      600,
      "reloaded session history",
    );
    flow.historySeen = !!history;
    if (!history) throw new Error("sessions flow: persisted history not rendered after reload");
    flow.steps.push("history-rendered");
    // The renamed title must also have survived the reload (proves the rename
    // was persisted server-side, not just painted locally).
    const renamedAfterReload = await waitFor(
      c,
      `[...document.querySelectorAll('[class*="sessionTitle"]')].some((el) => el.textContent.trim() === ${JSON.stringify(renameTitle)})`,
      15000,
      500,
      "renamed title after reload",
    );
    flow.titleAfterReload = !!renamedAfterReload;
    if (!renamedAfterReload) throw new Error("sessions flow: renamed title lost after reload");
    await delay(400);
    await screenshot(c, "agent-sessions-reload.png");

    // 4. Connection picker: a saved connection must be selectable, the model
    //    picker must defer to it, and the next turn must route through it.
    const picker = await waitFor(
      c,
      `!!document.querySelector('select[aria-label="Settings connection"]')`,
      15000,
      500,
      "connection picker",
    );
    if (!picker) throw new Error("sessions flow: connection picker missing");
    const fixtureOption = await waitFor(
      c,
      `[...document.querySelectorAll('select[aria-label="Settings connection"] option')].some((o) => o.value === ${JSON.stringify(flow.fixtureId)})`,
      15000,
      500,
      "connection fixture option",
    );
    if (!fixtureOption) throw new Error("sessions flow: fixture connection not listed in picker");
    // The connection-provided model must NOT be a catalog option — it has to
    // come from the fixture row's `models` list once the connection is picked.
    const connListHiddenBeforeSelect = await waitFor(
      c,
      `![...document.querySelectorAll('select[class*="modelSelect"]')[0]?.options ?? []].some((o) => o.value === ${JSON.stringify(connListModel)})`,
      10000,
      400,
      "connection model list hidden pre-selection",
    );
    flow.connListNotCatalog = !!connListHiddenBeforeSelect;
    if (!connListHiddenBeforeSelect) {
      throw new Error("sessions flow: connection-provided model leaked into the default catalog picker");
    }
    await screenshot(c, "agent-sessions-picker.png");

    // Capture the outgoing converse request so the wiring can be asserted:
    // `connectionId` must be sent and the catalog `model` must be omitted.
    const conversePosts = [];
    c.on("Network.requestWillBeSent", (p) => {
      const req = p.request;
      if (req.method !== "POST" || !req.url.includes("/api/agent/sessions/") || !req.url.includes("/converse")) return;
      let body = null;
      try {
        body = JSON.parse(req.postData ?? "{}");
      } catch {
        body = null;
      }
      conversePosts.push({ url: req.url, body });
    });

    const picked = await evalJs(c, `(() => {
      const sel = document.querySelector('select[aria-label="Settings connection"]');
      if (!sel) return false;
      const opt = [...sel.options].find((o) => o.value === ${JSON.stringify(flow.fixtureId)});
      if (!opt) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, opt.value);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!picked) throw new Error("sessions flow: could not select fixture connection");
    const pickerActive = await waitFor(
      c,
      `document.querySelector('select[aria-label="Settings connection"]')?.value === ${JSON.stringify(flow.fixtureId)}`,
      10000,
      300,
      "picker selection",
    );
    if (!pickerActive) throw new Error("sessions flow: picker selection did not stick");
    flow.connectionSelected = true;
    flow.steps.push("connection-selected");

    // The catalog model picker stays usable with a connection active, but it
    // must default to the connection's own model: value "" (a "connection
    // default" option) and a title naming the connection's model.
    const modelDeferred = await waitFor(
      c,
      `(() => {
        const modelSel = document.querySelectorAll('select[class*="modelSelect"]')[0];
        const connSel = document.querySelectorAll('select[class*="modelSelect"]')[1];
        return !!modelSel && !!connSel &&
          connSel.value === ${JSON.stringify(flow.fixtureId)} &&
          modelSel.disabled === false &&
          modelSel.value === "" &&
          (modelSel.title || "").includes(${JSON.stringify(flow.fixtureModel)}) &&
          [...modelSel.options].some((o) => o.value === "" && o.textContent.includes(${JSON.stringify(flow.fixtureModel)}));
      })()`,
      10000,
      400,
      "model picker deferred to connection",
    );
    flow.modelDeferredToConnection = !!modelDeferred;
    if (!modelDeferred) throw new Error("sessions flow: model picker not deferred to selected connection");

    // The session detail must announce the active connection.
    const note = await waitFor(
      c,
      `document.querySelector('[class*="sessionNote"]')?.innerText.includes(${JSON.stringify(flow.fixtureName)}) ?? false`,
      10000,
      400,
      "connection note",
    );
    flow.connectionNoteShown = !!note;
    if (!note) throw new Error("sessions flow: connection note not rendered");

    // 5. Send a turn while the connection is selected; the hermetic fake
    //    upstream answers in milliseconds, and the request wiring, badge, and
    //    server-side pin must all hold.
    const connMsg = `Via saved connection (${Date.now().toString(36)})`;
    flow.connectionMessage = connMsg;
    await evalJs(c, jsSetInput('textarea[placeholder*="Message this session"]', connMsg));
    await delay(100);
    // Snapshot the bubble count BEFORE the click: the fake upstream answers in
    // milliseconds, so counting after could already include the reply.
    const bubblesBefore = await evalJs(c, `document.querySelectorAll('[class*="bubbleAgent"]').length`);
    const submittedConn = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector("textarea"));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!submittedConn) throw new Error("sessions flow: connection-driven submit not enabled");
    flow.timings.connectionSentAt = new Date().toISOString();
    const connAnswered = await waitFor(
      c,
      `(() => {
        const els = [...document.querySelectorAll('[class*="bubbleAgent"]')];
        return els.length > ${JSON.stringify(bubblesBefore)} &&
          els.slice(${JSON.stringify(bubblesBefore)}).some((el) => el.innerText.trim().length > 0 && !el.innerText.includes("Typing"));
      })()`,
      180000,
      800,
      "connection-driven reply",
    );
    flow.timings.connectionFinishedAt = new Date().toISOString();
    if (!connAnswered) throw new Error("sessions flow: no reply from connection-driven turn");
    const connThread = await evalJs(c, `document.querySelector('[class*="thread"]')?.innerText ?? "NO THREAD"`);
    flow.connectionReplyError = connThread.includes("Request failed") || connThread.includes("[error]");
    flow.connectionThreadSnippet = connThread.slice(0, 300);
    // The fake upstream must have been the one that answered: same endpoint
    // URL, the fixture's model, the fixture's bearer key, and our message.
    const upstreamHit = upstream.received.find(
      (r) => r.method === "POST" && (r.url ?? "").endsWith("/chat/completions"),
    );
    flow.upstreamHit = !!upstreamHit;
    flow.upstreamModel = upstreamHit?.body?.model ?? null;
    flow.upstreamAuthOk = upstreamHit?.authorization === `Bearer ${connKey}`;
    flow.upstreamMessageSeen = !!upstreamHit?.body?.messages?.some((m) => m.content === connMsg);
    flow.connectionReplySeen = !!upstreamHit && connThread.includes("Connection fixture reply OK");
    if (!upstreamHit) {
      throw new Error("sessions flow: backend never reached the connection's upstream");
    }
    if (flow.upstreamModel !== flow.fixtureModel) {
      throw new Error(`sessions flow: wrong model at upstream (${JSON.stringify(flow.upstreamModel)})`);
    }
    if (!flow.upstreamAuthOk) {
      throw new Error("sessions flow: backend did not send the connection's API key");
    }
    if (!flow.upstreamMessageSeen || !flow.connectionReplySeen) {
      throw new Error(`sessions flow: reply not from the connection's upstream (${JSON.stringify(flow.upstreamMessageSeen)}, ${JSON.stringify(flow.connectionReplySeen)})`);
    }

    const post = conversePosts.find((p) => p.body && p.body.connectionId === flow.fixtureId);
    flow.connectionIdSent = !!post;
    flow.modelOmittedFromConverse = !!post && !("model" in (post.body ?? {}));
    flow.converseUrl = post?.url ?? null;
    if (!post) {
      throw new Error(`sessions flow: converse request missing connectionId (posts=${JSON.stringify(conversePosts)})`);
    }
    if ("model" in (post.body ?? {})) {
      throw new Error(`sessions flow: catalog model sent alongside connectionId (${JSON.stringify(post.body)})`);
    }
    flow.steps.push("connection-request-verified");

    // 5b. A connection-provided model is first-class in the picker: the
    // fixture row's `models` list must render as options, and picking one
    // uses the SAME override semantics as a catalog model — `model` +
    // `connectionId` on the wire, the connection's bearer key at the fake
    // upstream, and a reply rendered from the upstream.
    const connListModelVisible = await waitFor(
      c,
      `[...document.querySelectorAll('select[class*="modelSelect"]')[0]?.options ?? []].some((o) => o.value === ${JSON.stringify(connListModel)})`,
      10000,
      400,
      "connection model list options",
    );
    flow.connListOptionSeen = !!connListModelVisible;
    if (!connListModelVisible) {
      const opts = await evalJs(c, `[...document.querySelectorAll('select[class*="modelSelect"]')[0].options].map((o) => o.value).join(",")`);
      throw new Error(`sessions flow: connection model list not in picker (options=${JSON.stringify(opts)})`);
    }
    const connListMsg = `Via connection model list (${Date.now().toString(36)})`;
    flow.connListMessage = connListMsg;
    const connListPicked = await evalJs(c, `(() => {
      const modelSel = document.querySelectorAll('select[class*="modelSelect"]')[0];
      const opt = [...modelSel.options].find((o) => o.value === ${JSON.stringify(connListModel)});
      if (!opt) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(modelSel, opt.value);
      modelSel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!connListPicked) throw new Error("sessions flow: connection model list option missing/disabled");
    const connListActive = await waitFor(
      c,
      `document.querySelectorAll('select[class*="modelSelect"]')[0]?.value === ${JSON.stringify(connListModel)}`,
      10000,
      300,
      "connection model list selection",
    );
    if (!connListActive) throw new Error("sessions flow: connection model list selection did not stick");
    flow.steps.push("conn-list-model-selected");
    await evalJs(c, jsSetInput('textarea[placeholder*="Message this session"]', connListMsg));
    const connListBubblesBefore = await evalJs(c, `document.querySelectorAll('[class*="bubbleAgent"]').length`);
    const connListSubmitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector("textarea"));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!connListSubmitted) throw new Error("sessions flow: conn-list submit not enabled");
    flow.timings.connListSentAt = new Date().toISOString();
    const connListAnswered = await waitFor(
      c,
      `(() => {
        const els = [...document.querySelectorAll('[class*="bubbleAgent"]')];
        return els.length > ${JSON.stringify(connListBubblesBefore)} &&
          els.slice(${JSON.stringify(connListBubblesBefore)}).some((el) => el.innerText.trim().length > 0 && !el.innerText.includes("Typing"));
      })()`,
      180000,
      800,
      "connection-list reply",
    );
    flow.timings.connListFinishedAt = new Date().toISOString();
    if (!connListAnswered) throw new Error("sessions flow: no reply from connection-list turn");
    const connListThread = await evalJs(c, `document.querySelector('[class*="thread"]')?.innerText ?? "NO THREAD"`);
    const connListHit = upstream.received.slice().reverse().find(
      (r) =>
        r.method === "POST" &&
        (r.url ?? "").endsWith("/chat/completions") &&
        r.body?.messages?.some((m) => m.content === connListMsg),
    );
    flow.connListUpstreamHit = !!connListHit;
    flow.connListUpstreamModel = connListHit?.body?.model ?? null;
    flow.connListUpstreamAuthOk = connListHit?.authorization === `Bearer ${connKey}`;
    flow.connListReplySeen = !!connListHit && connListThread.includes("Connection fixture reply OK");
    if (!connListHit) {
      throw new Error("sessions flow: connection-list turn never reached the connection's upstream");
    }
    if (flow.connListUpstreamModel !== connListModel) {
      throw new Error(`sessions flow: wrong connection-list model at upstream (${JSON.stringify(flow.connListUpstreamModel)})`);
    }
    if (!flow.connListUpstreamAuthOk) {
      throw new Error("sessions flow: connection-list turn lost the connection's API key");
    }
    if (!flow.connListReplySeen) {
      throw new Error("sessions flow: connection-list reply not from the connection's upstream");
    }
    const connListPost = conversePosts.find(
      (p) => p.body && p.body.connectionId === flow.fixtureId && p.body.model === connListModel,
    );
    flow.connListModelSentOnConverse = !!connListPost;
    if (!connListPost) {
      throw new Error(`sessions flow: converse missing connection-list model+connectionId (posts=${JSON.stringify(conversePosts)})`);
    }
    flow.steps.push("conn-list-request-verified");
    // Reset to the connection default so the catalog-override step below
    // starts from the same baseline it always has.
    await evalJs(c, `(() => {
      const modelSel = document.querySelectorAll('select[class*="modelSelect"]')[0];
      if (!modelSel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(modelSel, "");
      modelSel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const connListReset = await waitFor(
      c,
      `document.querySelectorAll('select[class*="modelSelect"]')[0]?.value === ""`,
      10000,
      300,
      "connection-list model reset to default",
    );
    if (!connListReset) throw new Error("sessions flow: model picker did not reset after connection-list turn");
    flow.steps.push("conn-list-reset-to-default");

    // 5a. A catalog model override must stay on the SAME connection: pick a
    // catalog model while the fixture connection is active and prove the
    // upstream sees the override model with the fixture's bearer key.
    const overrideModel = process.env.E2E_CONN_OVERRIDE_MODEL || "qwen3.6-35b";
    if (overrideModel === flow.fixtureModel) {
      throw new Error(`sessions flow: E2E_CONN_OVERRIDE_MODEL must differ from the fixture model (${flow.fixtureModel})`);
    }
    const overrideMsg = `Override via saved connection (${Date.now().toString(36)})`;
    flow.overrideModel = overrideModel;
    const overridePicked = await evalJs(c, `(() => {
      const modelSel = document.querySelectorAll('select[class*="modelSelect"]')[0];
      if (!modelSel || modelSel.disabled) return false;
      const opt = [...modelSel.options].find((o) => o.value === ${JSON.stringify(overrideModel)});
      if (!opt) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(modelSel, opt.value);
      modelSel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!overridePicked) {
      throw new Error(`sessions flow: catalog model override option missing/disabled (${overrideModel})`);
    }
    const overrideActive = await waitFor(
      c,
      `document.querySelectorAll('select[class*="modelSelect"]')[0]?.value === ${JSON.stringify(overrideModel)}`,
      10000,
      300,
      "override model selection",
    );
    if (!overrideActive) throw new Error("sessions flow: override model selection did not stick");
    flow.steps.push("override-model-selected");
    await evalJs(c, jsSetInput('textarea[placeholder*="Message this session"]', overrideMsg));
    await delay(100);
    const overrideBubblesBefore = await evalJs(c, `document.querySelectorAll('[class*="bubbleAgent"]').length`);
    const overrideSubmitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector("textarea"));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!overrideSubmitted) throw new Error("sessions flow: override-driven submit not enabled");
    flow.timings.overrideSentAt = new Date().toISOString();
    const overrideAnswered = await waitFor(
      c,
      `(() => {
        const els = [...document.querySelectorAll('[class*="bubbleAgent"]')];
        return els.length > ${JSON.stringify(overrideBubblesBefore)} &&
          els.slice(${JSON.stringify(overrideBubblesBefore)}).some((el) => el.innerText.trim().length > 0 && !el.innerText.includes("Typing"));
      })()`,
      180000,
      800,
      "override-driven reply",
    );
    flow.timings.overrideFinishedAt = new Date().toISOString();
    if (!overrideAnswered) throw new Error("sessions flow: no reply from override-driven turn");
    const overrideThread = await evalJs(c, `document.querySelector('[class*="thread"]')?.innerText ?? "NO THREAD"`);
    const overrideHit = upstream.received.slice().reverse().find(
      (r) => r.method === "POST" && (r.url ?? "").endsWith("/chat/completions") &&
        r.body?.messages?.some((m) => m.content === overrideMsg),
    );
    flow.overrideUpstreamHit = !!overrideHit;
    flow.overrideUpstreamModel = overrideHit?.body?.model ?? null;
    flow.overrideUpstreamAuthOk = overrideHit?.authorization === `Bearer ${connKey}`;
    flow.overrideReplySeen = !!overrideHit && overrideThread.includes("Connection fixture reply OK");
    if (!overrideHit) {
      throw new Error("sessions flow: override turn never reached the connection's upstream");
    }
    if (flow.overrideUpstreamModel !== overrideModel) {
      throw new Error(`sessions flow: wrong model at upstream (${JSON.stringify(flow.overrideUpstreamModel)})`);
    }
    if (!flow.overrideUpstreamAuthOk) {
      throw new Error("sessions flow: override turn lost the connection's API key");
    }
    if (!flow.overrideReplySeen) {
      throw new Error("sessions flow: override reply not from the connection's upstream");
    }
    const overridePost = conversePosts.find(
      (p) => p.body && p.body.connectionId === flow.fixtureId && p.body.model === overrideModel,
    );
    flow.overrideModelSentOnConverse = !!overridePost;
    if (!overridePost) {
      throw new Error(`sessions flow: converse override missing model+connectionId (posts=${JSON.stringify(conversePosts)})`);
    }
    flow.steps.push("override-request-verified");
    // Reset the model picker to the connection default so the rest of the
    // journey describes the default path.
    await evalJs(c, `(() => {
      const modelSel = document.querySelectorAll('select[class*="modelSelect"]')[0];
      if (!modelSel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(modelSel, "");
      modelSel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    const modelReset = await waitFor(
      c,
      `document.querySelectorAll('select[class*="modelSelect"]')[0]?.value === ""`,
      10000,
      300,
      "model reset to connection default",
    );
    if (!modelReset) throw new Error("sessions flow: model picker did not reset to connection default");
    flow.steps.push("override-reset-to-default");

    // Sidebar badge + server-side persistence of the pinned connection.
    const badge = await waitFor(
      c,
      `[...document.querySelectorAll('[class*="sessionBadge"]')].some((el) => el.textContent.trim().includes(${JSON.stringify(flow.fixtureName)}))`,
      15000,
      500,
      "connection badge in sidebar",
    );
    flow.badgeShown = !!badge;
    if (!badge) throw new Error("sessions flow: connection badge missing from sidebar");
    let pinned = null;
    for (let i = 0; i < 20; i += 1) {
      const sessList = await fetch(`${API}/agent/sessions`).then((r) => r.json());
      pinned = sessList.find((s) => s.title === renameTitle);
      if (pinned?.connectionId === flow.fixtureId && pinned?.model === flow.overrideModel) break;
      await delay(300);
    }
    flow.serverPinnedConnection = pinned?.connectionId === flow.fixtureId;
    flow.overrideModelPersisted = pinned?.model === flow.overrideModel;
    if (!flow.serverPinnedConnection) {
      throw new Error(`sessions flow: connectionId not persisted server-side (${JSON.stringify(pinned)})`);
    }
    if (!flow.overrideModelPersisted) {
      throw new Error(`sessions flow: override model not persisted server-side (${JSON.stringify(pinned)})`);
    }
    flow.steps.push("connection-pinned-server-side");
    await delay(300);
    await screenshot(c, "agent-sessions-connection.png");

    // Restore the default gateway so the runner's other flows are unaffected,
    // then drop the fixture (verified by a 404 on the second GET).
    await evalJs(c, `(() => {
      const sel = document.querySelector('select[aria-label="Settings connection"]');
      if (!sel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, "");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    await fetch(`${API}/connections/${flow.fixtureId}`, { method: "DELETE" });
    flow.fixtureId = null;
    flow.connectionCleanup = await fetch(`${API}/connections/${conn.id}`, { method: "GET" })
      .then((r) => (r.status === 404 ? "deleted" : "leftover"))
      .catch(() => "unknown");
    if (flow.connectionCleanup !== "deleted") {
      throw new Error(`sessions flow: fixture connection not removed (${flow.connectionCleanup})`);
    }
    flow.steps.push("connection-fixture-deleted");

    flow.result = {
      persisted: true,
      renamed: true,
      connectionSelected: flow.connectionSelected,
      modelDeferredToConnection: flow.modelDeferredToConnection,
      connectionNoteShown: flow.connectionNoteShown,
      connectionIdSent: flow.connectionIdSent,
      modelOmittedFromConverse: flow.modelOmittedFromConverse,
      badgeShown: flow.badgeShown,
      serverPinnedConnection: flow.serverPinnedConnection,
      fixtureLive: flow.fixtureLive,
      fixtureModel: flow.fixtureModel,
      connListNotCatalog: flow.connListNotCatalog,
      connListOptionSeen: flow.connListOptionSeen,
      connListModel: connListModel,
      connListModelSentOnConverse: flow.connListModelSentOnConverse,
      connListUpstreamHit: flow.connListUpstreamHit,
      connListUpstreamModel: flow.connListUpstreamModel,
      connListUpstreamAuthOk: flow.connListUpstreamAuthOk,
      connListReplySeen: flow.connListReplySeen,
      connectionReplySeen: flow.connectionReplySeen,
      connectionReplyError: flow.connectionReplyError,
      upstreamHit: flow.upstreamHit,
      upstreamModel: flow.upstreamModel,
      upstreamAuthOk: flow.upstreamAuthOk,
      upstreamMessageSeen: flow.upstreamMessageSeen,
      overrideModel: flow.overrideModel,
      overrideModelSentOnConverse: flow.overrideModelSentOnConverse,
      overrideUpstreamHit: flow.overrideUpstreamHit,
      overrideUpstreamModel: flow.overrideUpstreamModel,
      overrideUpstreamAuthOk: flow.overrideUpstreamAuthOk,
      overrideReplySeen: flow.overrideReplySeen,
      overrideModelPersisted: flow.overrideModelPersisted,
      connectionCleanup: flow.connectionCleanup,
    };
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    if (flow.fixtureId) {
      await fetch(`${API}/connections/${flow.fixtureId}`, { method: "DELETE" }).catch(() => undefined);
      flow.fixtureId = null;
    }
    if (upstream) {
      try {
        upstream.server.close();
      } catch {
        // socket already closed
      }
    }
    c.close();
  }
}

/** Delete every session this run created (identified by createdAt). */
async function cleanupSessions(flow) {
  if (!flow?.createdAt) return null;
  const after = new Date(flow.createdAt).getTime() - 1000;
  try {
    const res = await fetch(`${API}/agent/sessions`);
    if (!res.ok) throw new Error(`list sessions -> HTTP ${res.status}`);
    const list = await res.json();
    const owned = list.filter((s) => new Date(s.createdAt).getTime() >= after);
    let deleted = 0;
    for (const s of owned) {
      const del = await fetch(`${API}/agent/sessions/${s.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete session -> HTTP ${del.status}`);
      deleted++;
    }
    log(`  cleanup: deleted ${deleted} session(s)`);
    return deleted > 0 ? `deleted ${deleted} session(s)` : "none";
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
}

/** Files flow: create a file + a dotfile through the /files UI, read the
 *  content back, download it (wire headers/bytes + saved-to-disk when CDP
 *  allows), then delete both through the UI and prove the removal really
 *  happened (server-side) via the backend API. */
async function filesFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/files`;
  log(`flow files -> ${url}`);
  const { tab, c } = await setupPage(url);
  let downloadDir = null;
  let browserSock = null;
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "files ready");
    if (!ready) throw new Error("files flow: page never loaded");
    const flow = { steps: [], timings: {}, result: null };
    const started = Date.now();

    // The scope picker must settle on an agent scope before we drive it.
    const scoped = await waitFor(
      c,
      `(() => { const s = document.querySelector('select[aria-label="Scope"]'); return !!s && !s.disabled && s.value.startsWith("agent:"); })()`,
      30000,
      600,
      "files scope",
    );
    if (!scoped) throw new Error("files flow: no agent scope selected");
    flow.scope = await evalJs(c, `document.querySelector('select[aria-label="Scope"]')?.value`);
    flow.createdAt = new Date().toISOString();
    await delay(400);

    const stamp = Date.now().toString(36);
    const folder = `browser-e2e-files-${stamp}`;
    const dotfile = `.dot-${stamp}`;
    const file = `${folder}/hello.txt`;
    const content = `hello from files e2e ${stamp}`;
    flow.folder = folder;
    flow.dotfile = dotfile;
    flow.file = file;
    flow.content = content;

    // Create the nested file and the dotfile from the root listing.
    for (const [name, body] of [[file, content], [dotfile, `dot ${stamp}`]]) {
      const opened = await evalJs(c, jsClick("New file", true));
      if (!opened) throw new Error("files flow: New file button missing");
      const panelReady = await waitFor(
        c,
        `!!document.querySelector('input[aria-label="File name"]')`,
        10000,
        400,
        "new file panel",
      );
      if (!panelReady) throw new Error("files flow: new-file panel never appeared");
      await evalJs(c, jsSetInput('input[aria-label="File name"]', name));
      await evalJs(c, jsSetInput('textarea[aria-label="File content"]', body));
      await delay(100);
      const created = await evalJs(c, jsClick("Create", true));
      if (!created) throw new Error("files flow: Create button missing");
      const closed = await waitFor(
        c,
        `!document.querySelector('input[aria-label="File name"]')`,
        15000,
        400,
        "create finished",
      );
      if (!closed) throw new Error(`files flow: create did not complete for ${name}`);
      const noticeAfterCreate = await waitFor(
        c,
        `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Created ${name}`)}) ?? false`,
        5000,
        300,
        "create success notice",
      );
      if (!noticeAfterCreate) throw new Error(`files flow: success notice missing after ${name}`);
      flow.steps.push(`created ${name}`);
    }

    // Root must list the new folder AND the dotfile (dotfiles are not hidden).
    const folderRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)})`,
      15000,
      500,
      "folder row",
    );
    const dotRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${dotfile}"]`)})`,
      15000,
      500,
      "dotfile row",
    );
    if (!folderRow || !dotRow) throw new Error(
      `files flow: root listing missing folder/dotfile (folder=${!!folderRow} dot=${!!dotRow})`,
    );
    flow.steps.push("root-lists-folder-and-dotfile");
    await screenshot(c, "files-created.png");

    // Navigate into the folder and read the file back.
    const navInto = await evalJs(
      c,
      `(() => { const b = document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)}).querySelector("button"); if (!b) return false; b.click(); return true; })()`,
    );
    if (!navInto) throw new Error("files flow: folder row not clickable");
    const fileRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="hello.txt"]`)})`,
      15000,
      500,
      "files list inside folder",
    );
    if (!fileRow) throw new Error("files flow: hello.txt not listed inside folder");
    flow.steps.push("navigated-into-folder");

    const viewClicked = await evalJs(c, rowBtnExpr("hello.txt", "View"));
    if (!viewClicked) throw new Error("files flow: View button missing");
    const seen = await waitFor(
      c,
      `document.body.innerText.includes(${JSON.stringify(content)})`,
      15000,
      500,
      "file content in viewer",
    );
    if (!seen) throw new Error("files flow: file content never rendered");
    flow.contentSeen = true;
    await delay(300);
    await screenshot(c, "files-view.png");
    await evalJs(c, jsClick("Close", true));
    await delay(200);

    // Download through the row action. Verify the wire bytes + attachment
    // headers; when CDP allows, also compare the bytes Chrome saved to disk.
    const downloadHits = [];
    const onDownload = (p) => {
      if (!p.response?.url?.includes("/files/download")) return;
      downloadHits.push({
        requestId: p.requestId,
        url: p.response.url,
        status: p.response.status,
        contentType: p.response.headers["Content-Type"] ?? p.response.headers["content-type"] ?? "",
        disposition: p.response.headers["Content-Disposition"] ?? p.response.headers["content-disposition"] ?? "",
      });
    };
    c.on("Network.responseReceived", onDownload);
    let realDownload = "skipped";
    try {
      const { webSocketDebuggerUrl } = await httpJson("/json/version");
      const b = new CDP(webSocketDebuggerUrl);
      await b.open();
      browserSock = b;
      downloadDir = mkdtempSync(join(tmpdir(), "fmcv-dl-"));
      await b.send("Browser.setDownloadBehavior", {
        behavior: "allow",
        downloadPath: downloadDir,
        eventsEnabled: true,
      });
    } catch (err) {
      log(`  files flow: real CDP download unavailable (${err.message}) — wire bytes still verified`);
      realDownload = "skipped";
    }
    const dlClicked = await evalJs(c, rowBtnExpr("hello.txt", "Download"));
    if (!dlClicked) throw new Error("files flow: Download button missing");
    const dlNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes("Downloaded") ?? false`,
      10000,
      400,
      "download success notice",
    );
    if (!dlNotice) throw new Error("files flow: download success notice missing");
    let dlHit = null;
    for (const deadline = Date.now() + 10000; Date.now() < deadline && !dlHit;) {
      dlHit = downloadHits.find((h) => h.status === 200);
      if (!dlHit) await delay(250);
    }
    if (!dlHit) throw new Error("files flow: no successful /files/download response captured");
    const ctOk = /application\/octet-stream/.test(dlHit.contentType);
    const cdOk = /attachment/.test(dlHit.disposition);
    if (!ctOk || !cdOk) {
      throw new Error(
        `files flow: download headers unexpected (type=${dlHit.contentType} disposition=${dlHit.disposition})`,
      );
    }
    // Saved-to-disk is the strongest evidence of an end-to-end download.
    if (downloadDir) {
      for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
        for (const name of ["hello.txt", "hello (1).txt"]) {
          try {
            if (readFileSync(join(downloadDir, name), "utf8") === content) {
              realDownload = "ok";
              break;
            }
          } catch { /* file not saved (yet) */ }
        }
        if (realDownload === "ok") break;
        await delay(300);
      }
      if (realDownload !== "ok") realDownload = "failed";
    }
    flow.realDownload = realDownload;
    log(`  files flow: download verified (saved-to-disk=${realDownload})`);
    if (realDownload === "failed") {
      throw new Error("files flow: real download did not save expected bytes");
    }

    // Wire fallback (Chrome may not retain a network body for download
    // responses, so verify the endpoint bytes directly in that case).
    let wireBytes;
    if (realDownload === "ok") {
      wireBytes = Buffer.from(content, "utf8");
    } else {
      try {
        const body = await c.send("Network.getResponseBody", { requestId: dlHit.requestId });
        wireBytes = Buffer.from(body.body, body.base64Encoded ? "base64" : "utf8");
      } catch {
        const direct = await fetch(
          `${API}/files/download?scope=${encodeURIComponent(flow.scope)}&path=${encodeURIComponent(file)}`,
        );
        if (!direct.ok) throw new Error(`files flow: direct download fetch HTTP ${direct.status}`);
        wireBytes = Buffer.from(await direct.arrayBuffer());
      }
      if (wireBytes.toString("utf8") !== content) {
        throw new Error(
          `files flow: downloaded bytes mismatch (got ${wireBytes.length}B expected ${content.length}B)`,
        );
      }
    }
    flow.downloadVerified = true;
    flow.downloadHeaders = { contentType: dlHit.contentType, disposition: dlHit.disposition };
    flow.steps.push("downloaded-hello.txt");
    await screenshot(c, "files-download.png");

    // Delete the file through the UI and wait for the row to disappear.
    const delClicked = await evalJs(c, rowBtnExpr("hello.txt", "Delete"));
    if (!delClicked) throw new Error("files flow: Delete button missing");
    const gone = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-name="hello.txt"]`)})`,
      15000,
      500,
      "file deleted from list",
    );
    if (!gone) throw new Error("files flow: hello.txt still listed after delete");
    flow.deletedFileViaUi = true;
    flow.steps.push("deleted-hello.txt");

    // Back to root through the breadcrumb, then delete folder + dotfile.
    const back = await evalJs(c, `(() => {
      const btns = [...document.querySelectorAll('button[class*="crumbLink"]')];
      const b = btns.find((x) => x.textContent.trim() === "root");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!back) throw new Error("files flow: breadcrumb root missing");
    const rootAgain = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)})`,
      15000,
      500,
      "back at root",
    );
    if (!rootAgain) throw new Error("files flow: folder not listed at root");

    for (const name of [folder, dotfile]) {
      const d = await evalJs(c, rowBtnExpr(name, "Delete"));
      if (!d) throw new Error(`files flow: Delete missing for ${name}`);
      const g = await waitFor(
        c,
        `!document.querySelector(${JSON.stringify(`[data-name="${name}"]`)})`,
        15000,
        500,
        `${name} deleted`,
      );
      if (!g) throw new Error(`files flow: ${name} still listed`);
      const noticeAfterDelete = await waitFor(
        c,
        `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Deleted ${name}`)}) ?? false`,
        5000,
        300,
        "delete success notice",
      );
      if (!noticeAfterDelete) throw new Error(`files flow: success notice missing after ${name}`);
      flow.steps.push(`deleted ${name}`);
    }
    await screenshot(c, "files-clean.png");

    flow.result = { created: true, read: true, deleted: true };
    flow.timings.elapsedMs = Date.now() - started;
    log(`  files journey done in ${flow.timings.elapsedMs}ms`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
    if (browserSock) {
      try { browserSock.close(); } catch { /* best-effort */ }
    }
    if (downloadDir) rmSync(downloadDir, { recursive: true, force: true });
  }
}

/** Best-effort server-side cleanup + verification for the files journey. */
async function filesCleanup(flow) {
  if (!flow?.scope || !flow?.folder) return "none";
  const scope = flow.scope;
  const file = flow.file || `${flow.folder}/hello.txt`;
  const dotfile = flow.dotfile;
  const del = async (rel) => {
    const r = await fetch(
      `${API}/files/delete?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(rel)}`,
      { method: "DELETE" },
    );
    if (r.status >= 400 && r.status !== 404) {
      throw new Error(`delete ${rel} -> HTTP ${r.status}`);
    }
  };
  try {
    await del(file);
    await del(flow.folder);
    if (dotfile) await del(dotfile);
    const res = await fetch(`${API}/files/list?scope=${encodeURIComponent(scope)}&path=`);
    if (!res.ok) throw new Error(`list -> HTTP ${res.status}`);
    const body = await res.json();
    const names = (body.entries ?? []).map((e) => e.name);
    const leftovers = names.filter((n) => n === flow.folder || n === dotfile);
    if (leftovers.length) {
      log(`  cleanup: leftover(s) [${leftovers.join(", ")}]`);
      return `error: leftover ${leftovers.join(", ")}`;
    }
    log("  cleanup: files removed, verified clean");
    return "clean";
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
}

/** End-to-end HTML-view journey: create an HTML file through the /files UI,
 *  preview it in the sandboxed in-app iframe (served inline by
 *  /api/files/view), open the same link in a new tab and prove the rendered
 *  document, then delete the fixture through the UI. */
async function htmlFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/files`;
  log(`flow html-view -> ${url}`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], timings: {}, result: null };
  const extraTabs = [];
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "html-view files ready");
    if (!ready) throw new Error("html-view flow: page never loaded");
    const started = Date.now();

    const scoped = await waitFor(
      c,
      `(() => { const s = document.querySelector('select[aria-label="Scope"]'); return !!s && !s.disabled && s.value.startsWith("agent:"); })()`,
      30000,
      600,
      "html-view scope",
    );
    if (!scoped) throw new Error("html-view flow: no agent scope selected");
    flow.scope = await evalJs(c, `document.querySelector('select[aria-label="Scope"]')?.value`);
    await delay(400);

    const stamp = Date.now().toString(36);
    const folder = `browser-e2e-html-${stamp}`;
    const file = `${folder}/view.html`;
    const marker = `html-view-${stamp}`;
    const content = `<!doctype html><html><head><meta charset="utf-8"><title>HTML view E2E ${stamp}</title></head><body><h1 id="marker">${marker}</h1><p>viewed-by-link</p></body></html>`;
    flow.folder = folder;
    flow.file = file;
    flow.marker = marker;
    flow.content = content;

    // Create the HTML file through the UI (parents auto-created).
    const opened = await evalJs(c, jsClick("New file", true));
    if (!opened) throw new Error("html-view flow: New file button missing");
    const panelReady = await waitFor(
      c,
      `!!document.querySelector('input[aria-label="File name"]')`,
      10000,
      400,
      "html-view new-file panel",
    );
    if (!panelReady) throw new Error("html-view flow: new-file panel never appeared");
    await evalJs(c, jsSetInput('input[aria-label="File name"]', file));
    await evalJs(c, jsSetInput('textarea[aria-label="File content"]', content));
    await delay(100);
    const created = await evalJs(c, jsClick("Create", true));
    if (!created) throw new Error("html-view flow: Create button missing");
    const closed = await waitFor(
      c,
      `!document.querySelector('input[aria-label="File name"]')`,
      15000,
      400,
      "html-view create finished",
    );
    if (!closed) throw new Error("html-view flow: create did not complete");
    const createdNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Created ${file}`)}) ?? false`,
      5000,
      300,
      "html-view create notice",
    );
    if (!createdNotice) throw new Error(`html-view flow: success notice missing after ${file}`);
    flow.steps.push("created-view.html");

    const folderRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)})`,
      15000,
      500,
      "html-view folder row",
    );
    if (!folderRow) throw new Error("html-view flow: fixture folder not listed");

    const navInto = await evalJs(
      c,
      `(() => { const b = document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)}).querySelector("button"); if (!b) return false; b.click(); return true; })()`,
    );
    if (!navInto) throw new Error("html-view flow: folder row not clickable");
    const fileRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="view.html"]`)})`,
      15000,
      500,
      "html-view file row",
    );
    if (!fileRow) throw new Error("html-view flow: view.html not listed");

    // Capture the /files/view wire response to assert inline headers.
    const viewHits = [];
    const onView = (p) => {
      if (!p.response?.url?.includes("/files/view")) return;
      const h = p.response.headers ?? {};
      viewHits.push({
        url: p.response.url,
        status: p.response.status,
        contentType: h["content-type"] ?? h["Content-Type"] ?? "",
        disposition: h["content-disposition"] ?? h["Content-Disposition"] ?? "",
        csp: h["content-security-policy"] ?? h["Content-Security-Policy"] ?? "",
        nosniff: h["x-content-type-options"] ?? h["X-Content-Type-Options"] ?? "",
      });
    };
    c.on("Network.responseReceived", onView);

    const viewClicked = await evalJs(c, rowBtnExpr("view.html", "View"));
    if (!viewClicked) throw new Error("html-view flow: View button missing");
    const iframeSeen = await waitFor(
      c,
      `(() => { const f = document.querySelector('iframe[aria-label="HTML preview"]'); return !!f && f.src.includes("/files/view"); })()`,
      15000,
      400,
      "html iframe",
    );
    if (!iframeSeen) throw new Error("html-view flow: HTML iframe never rendered");
    flow.steps.push("iframes-in-app-preview");

    let viewHit = null;
    for (const deadline = Date.now() + 10000; Date.now() < deadline && !viewHit;) {
      viewHit = viewHits.find((h) => h.status === 200);
      if (!viewHit) await delay(250);
    }
    if (!viewHit) throw new Error("html-view flow: no successful /files/view response captured");
    const ctOk = /text\/html/.test(viewHit.contentType);
    const inlineOk = /inline/.test(viewHit.disposition);
    const cspOk = /sandbox/.test(viewHit.csp);
    const nosniffOk = /nosniff/i.test(viewHit.nosniff);
    if (!ctOk || !inlineOk || !cspOk || !nosniffOk) {
      throw new Error(`html-view flow: /files/view headers unexpected (type=${viewHit.contentType} disposition=${viewHit.disposition} csp=${viewHit.csp} nosniff=${viewHit.nosniff})`);
    }
    flow.viewHeaders = { contentType: viewHit.contentType, disposition: viewHit.disposition, csp: viewHit.csp };
    await delay(500);
    await screenshot(c, "files-html-view.png");

    // Both the in-app preview and the new-tab link must point at the
    // same-origin view proxy, so token-protected deployments work without a
    // raw API link (and without the token leaking into the URL).
    const appOrigin = new URL(url).origin;
    const htmlHref = await evalJs(
      c,
      `document.querySelector('a[aria-label="Open HTML in new tab"]')?.getAttribute('href') ?? null`,
    );
    if (!htmlHref || !htmlHref.startsWith(`${appOrigin}/api/files/view`)) {
      throw new Error(`html-view flow: Open in new tab link is not the same-origin proxy (href=${htmlHref ?? "missing"})`);
    }
    flow.proxyHref = htmlHref;

    // "Open in new tab": click the real link with trusted input events (a
    // scripted a.click() is not a user gesture and the popup blocker can eat
    // the tab), then find the resulting page target.
    const tabPt = await evalJs(
      c,
      `(() => { const a = document.querySelector('a[aria-label="Open HTML in new tab"]'); if (!a) return null; const r = a.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    if (!tabPt) throw new Error("html-view flow: Open HTML in new tab link missing");
    await c.send("Input.dispatchMouseEvent", { type: "mousePressed", x: tabPt.x, y: tabPt.y, button: "left", clickCount: 1 });
    await c.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: tabPt.x, y: tabPt.y, button: "left", clickCount: 1 });
    let newTab = null;
    for (const deadline = Date.now() + 10000; Date.now() < deadline && !newTab;) {
      try {
        const targets = await httpJson("/json/list");
        newTab = targets.find(
          (t) => t.type === "page" && (t.url ?? "").includes("/files/view") && t.id !== tab.id && !createdTabs.includes(t.id),
        );
        if (newTab) extraTabs.push(newTab.id);
      } catch { /* CDP list may be briefly unavailable mid-open */ }
      if (!newTab) await delay(300);
    }
    if (!newTab) {
      log("  html-view flow: new tab from click not observed — verifying the proxy link in a fresh tab instead");
      newTab = await openTab(htmlHref);
    }
    const t2 = new CDP(newTab.webSocketDebuggerUrl ?? newTab.wsUrl);
    await t2.open();
    try {
      await t2.send("Page.enable");
      await t2.send("Runtime.enable");
      const bodySeen = await waitFor(
        t2,
        `document.body.innerText.includes(${JSON.stringify(marker)}) && document.body.innerText.includes("viewed-by-link")`,
        20000,
        400,
        "new-tab html render",
      );
      if (!bodySeen) throw new Error("html-view flow: marker never rendered in the new tab");
      const titleOk = await waitFor(
        t2,
        `document.title.includes(${JSON.stringify(`HTML view E2E ${stamp}`)})`,
        10000,
        400,
        "new-tab html title",
      );
      if (!titleOk) throw new Error("html-view flow: new tab title not rendered");
      await screenshot(t2, "files-html-tab.png");
    } finally {
      t2.close();
    }
    flow.newTabVerified = true;
    flow.steps.push("opened-html-in-new-tab");

    // Back in the app: close the in-app viewer, then delete via the UI.
    const viewerClosed = await evalJs(c, jsClick("Close", true));
    if (!viewerClosed) throw new Error("html-view flow: Close button missing");
    const delClicked = await evalJs(c, rowBtnExpr("view.html", "Delete"));
    if (!delClicked) throw new Error("html-view flow: Delete button missing");
    const fileGone = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-name="view.html"]`)})`,
      15000,
      500,
      "view.html deleted",
    );
    if (!fileGone) throw new Error("html-view flow: view.html still listed");
    flow.steps.push("deleted-view.html");

    const back = await evalJs(c, `(() => {
      const btns = [...document.querySelectorAll('button[class*="crumbLink"]')];
      const b = btns.find((x) => x.textContent.trim() === "root");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!back) throw new Error("html-view flow: breadcrumb root missing");
    const folderAgain = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)})`,
      15000,
      500,
      "html-view folder at root",
    );
    if (!folderAgain) throw new Error("html-view flow: fixture folder not listed at root");
    const delFolder = await evalJs(c, rowBtnExpr(folder, "Delete"));
    if (!delFolder) throw new Error("html-view flow: folder Delete missing");
    const folderGone = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-name="${folder}"]`)})`,
      15000,
      500,
      "html-view folder deleted",
    );
    if (!folderGone) throw new Error("html-view flow: fixture folder still listed");
    await screenshot(c, "files-html-clean.png");

    flow.result = { createdViaUi: true, iframeVerified: true, newTabVerified: true, deletedViaUi: true };
    flow.timings.elapsedMs = Date.now() - started;
    log(`  html-view journey done in ${flow.timings.elapsedMs}ms`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
    for (const id of extraTabs) {
      const ok = await fetch(`${BASE}/json/close/${id}`, { method: "GET" })
        .then((r) => r.ok)
        .catch(() => false);
      if (!ok) log(`  warn: could not close html-view tab ${id}`);
    }
  }
}

/** Server-side cleanup + verification for the HTML-view journey. */
async function htmlCleanup(flow) {
  if (!flow?.scope || !flow?.folder) return "none";
  const scope = flow.scope;
  const del = async (rel) => {
    const r = await fetch(
      `${API}/files/delete?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(rel)}`,
      { method: "DELETE" },
    );
    if (r.status >= 400 && r.status !== 404) {
      throw new Error(`delete ${rel} -> HTTP ${r.status}`);
    }
  };
  try {
    await del(flow.file || `${flow.folder}/view.html`);
    await del(flow.folder);
    const res = await fetch(`${API}/files/list?scope=${encodeURIComponent(scope)}&path=`);
    if (!res.ok) throw new Error(`list -> HTTP ${res.status}`);
    const body = await res.json();
    const leftovers = (body.entries ?? []).map((e) => e.name).filter((n) => n === flow.folder);
    if (leftovers.length) {
      log(`  cleanup: html-view leftover(s) [${leftovers.join(", ")}]`);
      return `error: leftover ${leftovers.join(", ")}`;
    }
    log("  cleanup: html-view removed, verified clean");
    return "clean";
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
}

/** PostgreSQL helpers for bucket fixtures. They are only a safety net now:
 *  the DELETE API removes browser-E2E fixtures through the app itself, and
 *  these psql helpers serve as the final DB check / fallback. They require
 *  the docker CLI + the `fmcv-db` container (the app already runs under
 *  docker compose per e2e/README.md). */
function bucketIdByNameViaApi(name) {
  return fetch(`${API}/buckets`)
    .then((res) => {
      if (!res.ok) throw new Error(`list buckets -> HTTP ${res.status}`);
      return res.json();
    })
    .then((rows) =>
      (Array.isArray(rows) ? rows : []).find((b) => b.name === name)?.id ?? null,
    );
}

function bucketRowsByNameLike(pattern) {
  const out = execFileSync(
    "docker",
    ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-F", "|", "-c",
      `SELECT name, "folderType", "folderName" FROM buckets WHERE name LIKE '${pattern}'`],
    { encoding: "utf8", timeout: 15000 },
  );
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, folderType, folderName] = line.split("|");
      return { name, folderType, folderName };
    });
}

function bucketIdByName(name) {
  const safe = String(name ?? "").replace(/'/g, "''");
  const out = execFileSync(
    "docker",
    ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
      `SELECT id FROM buckets WHERE name = '${safe}'`],
    { encoding: "utf8", timeout: 15000 },
  );
  return out.trim() || null;
}

/** Delete the DB rows for one bucket (documents first, then the bucket). */
function deleteBucketRowsFor(bucket) {
  const id = bucketIdByName(bucket);
  if (!id) return "already-gone";
  const safeId = String(id).replace(/'/g, "''");
  execFileSync(
    "docker",
    ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-v", "ON_ERROR_STOP=1", "-c",
      `DELETE FROM "managed_documents" WHERE "bucketId" = '${safeId}'; DELETE FROM "buckets" WHERE id = '${safeId}';`],
    { encoding: "utf8", timeout: 15000 },
  );
  return "deleted";
}

/** End-to-end buckets journey: create (agent folder), duplicate-name 409,
 *  upload (text doc), duplicate-upload 409, download (saved bytes), reload
 *  persistence, then server-side cleanup (files API + DB rows via psql). */
async function bucketsFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/buckets`;
  log(`flow buckets -> ${url}`);
  const { tab, c } = await setupPage(url);
  const tmpDir = mkdtempSync(join(tmpdir(), "fmcv-bucket-"));
  const flow = { steps: [], timings: {}, result: null };
  let downloadDir = null;
  let browserSock = null;
  try {
    wireErrorCapture(c, sink, { allowedStatuses: [409] });
    await c.send("DOM.enable");
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "buckets ready");
    if (!ready) throw new Error("buckets flow: page never loaded");
    const started = Date.now();

    const stamp = Date.now().toString(36);
    const bucket = `browser-e2e-bucket-${stamp}`;
    const docName = `notes-${stamp}.txt`;
    const docBody = `hello from buckets e2e ${stamp}`;
    flow.bucket = bucket;
    flow.docName = docName;
    flow.docBody = docBody;
    const docPath = join(tmpDir, docName);
    writeFileSync(docPath, docBody, "utf8");

    // 1. Create the bucket through the UI, mapped to an agent folder.
    const startCreate = await evalJs(c, jsClick("New bucket", true));
    if (!startCreate) throw new Error("buckets flow: New bucket button missing");
    const formReady = await waitFor(c, `!!document.querySelector('input[aria-label="Bucket name"]')`, 10000, 400, "create form");
    if (!formReady) throw new Error("buckets flow: create form never appeared");
    const folderReady = await waitFor(
      c,
      `(() => { const s = document.querySelector('select[aria-label="Folder name"]'); return !!s && !s.disabled && s.options.length > 0; })()`,
      30000, 600, "folder select",
    );
    if (!folderReady) throw new Error("buckets flow: workspace folders never loaded");
    const typeSel = await evalJs(c, `(() => {
      const s = document.querySelector('select[aria-label="Folder type"]');
      if (!s) return null;
      s.value = "agent";
      s.dispatchEvent(new Event("change", { bubbles: true }));
      return s.value;
    })()`);
    if (typeSel !== "agent") throw new Error("buckets flow: folder type select missing");
    const folderValue = await evalJs(c, `document.querySelector('select[aria-label="Folder name"]')?.value`);
    if (!folderValue) throw new Error("buckets flow: no agent folder available");
    flow.scope = `agent:${folderValue}`;
    await evalJs(c, jsSetInput('input[aria-label="Bucket name"]', bucket));
    await delay(150);
    const created = await evalJs(c, jsClick("Create bucket", true));
    if (!created) throw new Error("buckets flow: Create bucket button missing");
    const rowSeen = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${bucket}"]`)})`, 15000, 500, "bucket row");
    if (!rowSeen) throw new Error("buckets flow: created bucket never listed");
    const createNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Created bucket ${bucket}`)}) ?? false`,
      5000, 300, "create notice",
    );
    if (!createNotice) throw new Error("buckets flow: create success notice missing");
    flow.steps.push("created-bucket");
    await screenshot(c, "buckets-created.png");

    // 2. Repeat the same bucket name: must 409 in-page with a dismissible error.
    await evalJs(c, jsClick("New bucket", true));
    await waitFor(c, `!!document.querySelector('input[aria-label="Bucket name"]')`, 10000, 400, "create form again");
    await evalJs(c, jsSetInput('input[aria-label="Bucket name"]', bucket));
    await delay(150);
    await evalJs(c, jsClick("Create bucket", true));
    const dupError = await waitFor(
      c,
      `document.querySelector('button[class*="errorBanner"]')?.innerText.includes("already exists") ?? false`,
      10000, 400, "duplicate bucket",
    );
    if (!dupError) throw new Error("buckets flow: duplicate bucket name not rejected");
    flow.duplicateRejected = true;
    flow.steps.push("duplicate-rejected");
    await evalJs(c, jsClick("Hide form", true));
    await delay(200);

    // 3. Open the bucket and upload a text document.
    const open = await evalJs(c, `(() => {
      const li = document.querySelector(${JSON.stringify(`[data-name="${bucket}"]`)});
      const b = li && li.querySelector("button");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!open) throw new Error("buckets flow: bucket row not clickable");
    const emptyDocs = await waitFor(c, `document.body.innerText.includes("No documents yet")`, 15000, 500, "empty docs");
    if (!emptyDocs) throw new Error("buckets flow: detail never showed empty docs");
    const inputReady = await waitFor(c, `!!document.querySelector('input[aria-label="Document file"]')`, 10000, 400, "file input");
    if (!inputReady) throw new Error("buckets flow: file input missing");
    const setFile = async () => {
      const { root } = await c.send("DOM.getDocument");
      const qr = await c.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[aria-label="Document file"]' });
      if (!qr.nodeId) throw new Error("buckets flow: upload input node missing");
      await c.send("DOM.setFileInputFiles", { nodeId: qr.nodeId, files: [docPath] });
    };
    await setFile();
    await delay(200);
    const uploadClicked = await evalJs(c, jsClick("Upload", true));
    if (!uploadClicked) throw new Error("buckets flow: Upload button missing");
    const docRow = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${docName}"]`)})`, 15000, 500, "document row");
    if (!docRow) throw new Error("buckets flow: uploaded document not listed");
    const uploadNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Uploaded ${docName}`)}) ?? false`,
      5000, 300, "upload notice",
    );
    if (!uploadNotice) throw new Error("buckets flow: upload success notice missing");
    const kindBadge = await evalJs(c, `document.querySelector(${JSON.stringify(`[data-name="${docName}"] [class*="kindBadge"]`)})?.textContent.trim()`);
    if (kindBadge !== "text") throw new Error(`buckets flow: kind badge wrong (${kindBadge})`);
    flow.uploadedViaUi = true;
    flow.steps.push("uploaded-document");
    await screenshot(c, "buckets-uploaded.png");

    // 4. Duplicate upload must 409 in-page too (documents are immutable).
    await setFile();
    await delay(200);
    await evalJs(c, jsClick("Upload", true));
    const dupUploadError = await waitFor(
      c,
      `document.querySelector('button[class*="errorBanner"]')?.innerText.includes("already exists") ?? false`,
      10000, 400, "duplicate upload",
    );
    if (!dupUploadError) throw new Error("buckets flow: duplicate upload not rejected");
    flow.duplicateUploadRejected = true;
    flow.steps.push("duplicate-upload-rejected");

    // 5. Download the document; verify saved-to-disk bytes when CDP allows.
    let realDownload = "skipped";
    try {
      const { webSocketDebuggerUrl } = await httpJson("/json/version");
      const b = new CDP(webSocketDebuggerUrl);
      await b.open();
      browserSock = b;
      downloadDir = mkdtempSync(join(tmpdir(), "fmcv-bucket-dl-"));
      await b.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir, eventsEnabled: true });
    } catch (err) {
      log(`  buckets flow: real CDP download unavailable (${err.message}) — wire bytes still verified`);
    }
    const dlClicked = await evalJs(c, rowBtnExpr(docName, "Download"));
    if (!dlClicked) throw new Error("buckets flow: Download button missing");
    const dlNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes("Downloaded") ?? false`,
      10000, 400, "download notice",
    );
    if (!dlNotice) throw new Error("buckets flow: download success notice missing");
    if (downloadDir) {
      for (const deadline = Date.now() + 8000; Date.now() < deadline;) {
        try {
          if (readFileSync(join(downloadDir, docName), "utf8") === docBody) {
            realDownload = "ok";
            break;
          }
        } catch { /* not saved yet */ }
        if (realDownload !== "ok") await delay(300);
      }
      if (realDownload !== "ok") realDownload = "failed";
    }
    log(`  buckets flow: download verified (saved-to-disk=${realDownload})`);
    if (realDownload === "failed") throw new Error("buckets flow: real download did not save expected bytes");

    // 6. Reload: the bucket AND its document must persist server-side.
    await c.send("Page.navigate", { url });
    const persistRow = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${bucket}"]`)})`, 15000, 500, "bucket after reload");
    if (!persistRow) throw new Error("buckets flow: bucket missing after reload");
    await evalJs(c, `(() => {
      const li = document.querySelector(${JSON.stringify(`[data-name="${bucket}"]`)});
      const b = li && li.querySelector("button");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    const persistDoc = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${docName}"]`)})`, 15000, 500, "document after reload");
    if (!persistDoc) throw new Error("buckets flow: document missing after reload");
    flow.persistedAfterReload = true;
    flow.steps.push("persisted-after-reload");
    await screenshot(c, "buckets-reload.png");
    await evalJs(c, jsClick("All buckets", false));
    await delay(200);

    // 7. Rename the bucket through the UI: the row keeps working and the
    //    uploaded document must survive under the renamed folder.
    const renamedName = `${bucket}-renamed`;
    const renameClicked = await evalJs(c, rowBtnExpr(bucket, "Rename"));
    if (!renameClicked) throw new Error("buckets flow: Rename button missing");
    const renameInput = await waitFor(
      c,
      `!!document.querySelector('input[aria-label="New bucket name"]')`,
      10000, 400, "rename input",
    );
    if (!renameInput) throw new Error("buckets flow: rename input never appeared");
    const typed = await evalJs(
      c,
      jsSetInput('input[aria-label="New bucket name"]', renamedName),
    );
    if (typed !== renamedName) throw new Error("buckets flow: rename input not editable");
    await delay(150);
    const saved = await evalJs(c, jsClick("Save", true));
    if (!saved) throw new Error("buckets flow: Save button missing");
    const renamedRow = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${renamedName}"]`)})`,
      15000, 500, "renamed bucket row",
    );
    if (!renamedRow) throw new Error("buckets flow: renamed bucket never listed");
    const renameNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify("Renamed bucket")}) ?? false`,
      5000, 300, "rename notice",
    );
    if (!renameNotice) throw new Error("buckets flow: rename success notice missing");
    await evalJs(c, `(() => {
      const li = document.querySelector(${JSON.stringify(`[data-name="${renamedName}"]`)});
      const b = li && li.querySelector("button");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    const renamedDoc = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${docName}"]`)})`,
      15000, 500, "document after rename",
    );
    if (!renamedDoc) throw new Error("buckets flow: document missing after rename");
    flow.renamedBucket = renamedName;
    flow.steps.push("renamed-bucket");
    await screenshot(c, "buckets-renamed.png");
    await evalJs(c, jsClick("All buckets", false));
    await delay(200);

    // 8. Delete the renamed bucket with the two-click confirm (and prove the
    //    server-side DELETE through the UI).
    const deleteArm = await evalJs(c, rowBtnExpr(renamedName, "Delete"));
    if (!deleteArm) throw new Error("buckets flow: Delete button missing");
    const confirmArmed = await waitFor(
      c,
      `!![...document.querySelectorAll(${JSON.stringify(`[data-name="${renamedName}"] button`)})].find((b) => b.textContent.trim() === "Confirm delete")`,
      10000, 400, "confirm delete",
    );
    if (!confirmArmed) throw new Error("buckets flow: delete confirm never armed");
    const confirmed = await evalJs(c, rowBtnExpr(renamedName, "Confirm delete"));
    if (!confirmed) throw new Error("buckets flow: Confirm delete button missing");
    const deleteNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify("Deleted bucket")}) ?? false`,
      10000, 400, "delete notice",
    );
    if (!deleteNotice) throw new Error("buckets flow: delete success notice missing");
    const rowGone = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-name="${renamedName}"]`)})`,
      10000, 400, "row gone",
    );
    if (!rowGone) throw new Error("buckets flow: deleted row still listed");
    flow.steps.push("deleted-bucket");
    await screenshot(c, "buckets-deleted.png");

    flow.result = {
      createdViaUi: true,
      duplicateRejected: true,
      uploadedViaUi: true,
      duplicateUploadRejected: true,
      downloadVerified: true,
      persistedAfterReload: true,
      renamedViaUi: true,
      deletedViaUi: true,
    };
    flow.timings.elapsedMs = Date.now() - started;
    log(`  buckets journey done in ${flow.timings.elapsedMs}ms`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
    if (browserSock) { try { browserSock.close(); } catch { /* best-effort */ } }
    if (downloadDir) rmSync(downloadDir, { recursive: true, force: true });
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Server-side cleanup + verification for the buckets journey. The journey
 *  itself ends with a UI delete, so cleanup deletes any leftover fixture
 *  through the DELETE API (with the psql row check as the final authority on
 *  whether anything still exists in the DB). */
async function bucketsCleanup(flow) {
  if (!flow?.bucket) return "none";
  const detail = { api: null, files: null, db: null, verified: null };
  const names = [...new Set([flow.bucket, flow.renamedBucket].filter(Boolean))];
  try {
    const scope = flow.scope && flow.scope.startsWith("agent:") ? flow.scope : null;
    for (const name of names) {
      const id = await bucketIdByNameViaApi(name);
      if (!id) continue;
      const del = await fetch(`${API}/buckets/${id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete bucket ${name} -> HTTP ${del.status}`);
    }
    detail.api = "clean";
  } catch (err) {
    detail.api = `error: ${err.message}`;
    log(`  cleanup: bucket API FAILED: ${err.message}`);
  }
  try {
    const scope = flow.scope && flow.scope.startsWith("agent:") ? flow.scope : null;
    if (!scope) {
      detail.files = `error: no agent scope (${flow.scope})`;
    } else {
      for (const name of names) {
        const r = await fetch(
          `${API}/files/delete?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(name)}`,
          { method: "DELETE" },
        );
        if (r.status >= 400 && r.status !== 404) {
          throw new Error(`delete folder ${name} -> HTTP ${r.status}`);
        }
      }
      detail.files = "clean";
    }
  } catch (err) {
    detail.files = `error: ${err.message}`;
    log(`  cleanup: bucket files FAILED: ${err.message}`);
  }
  try {
    const dbStates = names.map((name) =>
      deleteBucketRowsFor(name).replace("deleted", "cleaned-up"),
    );
    detail.db =
      dbStates.length > 0 && dbStates.every((s) => s === "already-gone" || s === "cleaned-up")
        ? "clean"
        : dbStates.join(",");
  } catch (err) {
    detail.db = `error: ${err.message}`;
    log(`  cleanup: bucket DB FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/buckets`);
    if (!res.ok) throw new Error(`list -> HTTP ${res.status}`);
    const body = await res.json();
    const leftover = (Array.isArray(body) ? body : []).find((b) => names.includes(b.name));
    detail.verified = leftover ? "leftover" : "clean";
  } catch (err) {
    detail.verified = `error: ${err.message}`;
    log(`  cleanup: bucket verify FAILED: ${err.message}`);
  }
  const ok =
    detail.api === "clean" &&
    detail.files === "clean" &&
    detail.db === "clean" &&
    detail.verified === "clean";
  if (!ok) log(`  cleanup: buckets not clean (${JSON.stringify(detail)})`);
  return ok ? "clean" : `error: ${JSON.stringify(detail)}`;
}


/** Find a cron job by name through the API (used to capture the server id
 *  for cleanup and to verify server-side state). */
async function cronFindByName(name) {
  const res = await fetch(`${API}/cron`);
  if (!res.ok) throw new Error(`list cron -> HTTP ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).find((j) => j.name === name) ?? null;
}

/** End-to-end cron journey: create through the /cron UI, run now (accepting
 *  either terminal status, like the channel flow), expand + collapse the
 *  append-only run history, rename, pause, resume, then delete via the
 *  two-click confirm. Real fixtures only; cron exposes a full CRUD API so
 *  cleanup is a plain idempotent DELETE. */
async function cronFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/cron`;
  log(`flow cron -> ${url}`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], timings: {}, result: null, jobId: null, jobName: null };
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "cron ready");
    if (!ready) throw new Error("cron flow: page never loaded");
    const page = await waitFor(c, `document.body.innerText.includes("Cron Jobs")`, 30000, 600, "cron page");
    if (!page) throw new Error("cron flow: page never rendered");
    const started = Date.now();

    // 0. Scheduler chip reflects the backend mode (Round 82): an API-only
    //    node (E2E_API_ONLY=1, see compose CRON_SCHEDULER_ENABLED=false)
    //    renders the disabled label; an enabled node renders active/standby.
    //    This is the UI proof for the Round 79 API-only switch.
    const apiOnly = process.env.E2E_API_ONLY === "1";
    const chipExpr = apiOnly
      ? `document.body.innerText.includes("Scheduler disabled — API-only") && document.body.innerText.includes("no lease · no background firing")`
      : `document.body.innerText.includes("Scheduler active on this node") || document.body.innerText.includes("Scheduler standby — lease held elsewhere")`;
    const chipSeen = await waitFor(
      c,
      chipExpr,
      10000,
      500,
      `scheduler chip (${apiOnly ? "api-only" : "enabled"})`,
    );
    if (!chipSeen) {
      throw new Error(
        `cron flow: scheduler chip missing in ${apiOnly ? "api-only" : "enabled"} mode`,
      );
    }
    flow.schedulerChip = apiOnly ? "disabled" : "enabled";
    flow.steps.push("scheduler-chip");
    await screenshot(c, apiOnly ? "cron-scheduler-disabled.png" : "cron-scheduler-chip.png");

    const stamp = Date.now().toString(36);
    const jobName = `browser-e2e-cron-${stamp}`;
    const renamed = `${jobName}-renamed`;
    flow.jobName = jobName;

    // 1. Create a job through the UI. Use a yearly schedule so the scheduler
    //    never fires it mid-flow (run-now drives the only execution).
    const openCreate = await evalJs(c, jsClick("New cron job", true));
    if (!openCreate) throw new Error("cron flow: New cron job button missing");
    const formReady = await waitFor(
      c,
      `!!document.querySelector('input[aria-label="Cron job name"]')`,
      10000,
      400,
      "create form",
    );
    if (!formReady) throw new Error("cron flow: create form never appeared");
    await evalJs(c, jsSetInput('input[aria-label="Cron job name"]', jobName));
    await evalJs(c, jsSetInput('input[aria-label="Cron schedule"]', "0 0 1 1 *"));
    await evalJs(c, jsSetInput('textarea[aria-label="Cron prompt"]', "Reply with the single word: ok"));
    await delay(150);
    const created = await evalJs(c, jsClick("Create job", true));
    if (!created) throw new Error("cron flow: Create job button missing");
    const rowSeen = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${jobName}"]`)})`, 15000, 500, "cron row");
    if (!rowSeen) throw new Error("cron flow: created job never listed");
    const createNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Created job ${jobName}`)}) ?? false`,
      5000,
      300,
      "create notice",
    );
    if (!createNotice) throw new Error("cron flow: create success notice missing");
    const nextRunText = await evalJs(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${jobName}"]`)})?.innerText.includes("Next run:") ?? false`,
    );
    if (!nextRunText) throw new Error("cron flow: created row lacks Next run info");
    flow.createdViaUi = true;
    flow.steps.push("created-job");
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      flow.jobId = (await cronFindByName(jobName))?.id ?? null;
      if (flow.jobId) break;
      await delay(300);
    }
    if (!flow.jobId) throw new Error("cron flow: created job not found server-side");
    await screenshot(c, "cron-created.png");

    // 2. Run now: the POST awaits the agent turn server-side, so wait for the
    //    status pill to reach a terminal button label (Done/Failed). Like the
    //    channel flow, either terminal satisfies the page-quality gate; Done
    //    is preferred (the compose backend usually routes to a live LLM).
    const runClicked = await evalJs(c, rowBtnExpr(jobName, "Run now"));
    if (!runClicked) throw new Error("cron flow: Run now button missing");
    const pillExpr = `(() => {
      const pill = document.querySelector(${JSON.stringify(`[data-name="${jobName}"] [class*="statusPill"]`)});
      if (!pill) return null;
      const t = pill.textContent.trim();
      return t === "Done" ? "done" : t === "Failed" ? "failed" : null;
    })()`;
    const runStatus = await waitFor(c, pillExpr, 120000, 1000, "cron run terminal");
    if (!runStatus) throw new Error("cron flow: run now never reached a terminal status");
    flow.runStatus = runStatus;
    flow.runTerminal = true;
    flow.steps.push(`run-${runStatus}`);
    if (runStatus !== "done") {
      log("  note: cron run-now reached [Failed] terminal (live LLM); continuing like the channel flow");
    }
    const runNotice = await waitFor(
      c,
      `document.body.innerText.includes(${JSON.stringify(`Ran ${jobName}`)})`,
      10000,
      500,
      "run notice",
    );
    flow.runNoticeSeen = !!runNotice;
    if (!runNotice) throw new Error("cron flow: run success banner missing");
    await screenshot(c, "cron-run-done.png");

    // 2b. Run history: expand the append-only history list and assert the
    //     terminal run just performed shows status/meta/message (real LLM
    //     answer here, so no stub text), then collapse it again.
    if (!flow.jobId) throw new Error("cron flow: no job id for history");
    const histClicked = await evalJs(c, rowBtnExpr(jobName, "History"));
    if (!histClicked) throw new Error("cron flow: History button missing");
    const runsList = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)})`,
      10000,
      400,
      "run history list",
    );
    if (!runsList) throw new Error("cron flow: run history never rendered");
    const runHistoryStatus = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const pill = box.querySelector('[class*="statusPill"]');
        if (!pill) return null;
        const t = pill.textContent.trim();
        return t === "Done" || t === "Failed" ? t : null;
      })()`,
      10000,
      500,
      "run history status pill",
    );
    const expectedPill = flow.runStatus === "done" ? "Done" : "Failed";
    if (runHistoryStatus !== expectedPill) {
      throw new Error(
        `cron flow: history pill ${JSON.stringify(runHistoryStatus)} != expected ${JSON.stringify(expectedPill)}`,
      );
    }
    const historyRow = await evalJs(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return false;
        const meta = box.querySelector('[class*="runMeta"]');
        const msg = box.querySelector('[class*="rowMessage"]');
        return !!meta && !!msg && msg.textContent.trim().length > 0;
      })()`,
    );
    if (!historyRow) throw new Error("cron flow: run history row missing meta/message");
    flow.historyShown = true;
    flow.steps.push("run-history");

    // 2c. Auto-refresh: with the history list still open, run the job again
    //     and assert the newest terminal row joins the list without
    //     collapsing/reopening the toggle (Round 70).
    const runAgainClicked = await evalJs(c, rowBtnExpr(jobName, "Run now"));
    if (!runAgainClicked) throw new Error("cron flow: second Run now button missing");
    const secondRunRows = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const pills = [...box.querySelectorAll('[class*="statusPill"]')];
        if (pills.length !== 2) return null;
        return pills.every((pill) => {
          const t = pill.textContent.trim();
          return t === "Done" || t === "Failed";
        })
          ? "2-terminal-runs"
          : null;
      })()`,
      120000,
      1000,
      "second run in open history",
    );
    if (secondRunRows !== "2-terminal-runs") {
      throw new Error("cron flow: open history did not auto-refresh with the second run");
    }
    flow.historyAutoRefreshed = true;
    flow.steps.push("history-auto-refresh");
    await screenshot(c, "cron-history-auto.png");

    const hideClicked = await evalJs(c, rowBtnExpr(jobName, "Hide history"));
    if (!hideClicked) throw new Error("cron flow: Hide history button missing");
    const runsHidden = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)})`,
      10000,
      400,
      "run history hidden",
    );
    if (!runsHidden) throw new Error("cron flow: run history did not collapse");
    await screenshot(c, "cron-history.png");

    // 2d. Deep-history paging (Round 72): seed 21 synthetic terminal runs
    //     straight into Postgres so the fixture job holds 23 rows, then
    //     verify the UI pages through the API limit/offset contract with
    //     Older/Newer. Cleanup is free: deleting the job cascades the runs.
    const seeded = (() => {
      const job = String(flow.jobId).replace(/'/g, "''");
      const sql = `INSERT INTO cron_runs (id, "cronJobId", status, message, "startedAt", "createdAt")
        SELECT 'browser-paging-' || '${job}' || '-' || n, '${job}', 'done',
          'synthetic deep-history run ' || n,
          now() - (n || ' minutes')::interval,
          now() - (n || ' minutes')::interval
        FROM generate_series(1, 21) AS n;`;
      execFileSync(
        "docker",
        ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-v", "ON_ERROR_STOP=1", "-c", sql],
        { encoding: "utf8", timeout: 15000 },
      );
      const count = execFileSync(
        "docker",
        ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
          `SELECT count(*) FROM cron_runs WHERE "cronJobId" = '${job}'`],
        { encoding: "utf8", timeout: 15000 },
      ).trim();
      return Number(count);
    })();
    if (seeded !== 23) {
      throw new Error(`cron flow: expected 23 runs after seeding, got ${seeded}`);
    }
    flow.pagingRunsSeeded = seeded;
    const reopenClicked = await evalJs(c, rowBtnExpr(jobName, "History"));
    if (!reopenClicked) throw new Error("cron flow: History button missing after seeding");
    const pagingBox = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return rows === 20 && page === "0" && hasMore === "1" &&
          box.innerText.includes("Page 1")
          ? { rows, page, hasMore }
          : null;
      })()`,
      15000,
      500,
      "deep-history first page",
    );
    if (!pagingBox) throw new Error("cron flow: deep history page 0 did not render 20 rows");

    const olderClicked = await evalJs(c, rowBtnExpr(jobName, "Older"));
    if (!olderClicked) throw new Error("cron flow: Older pager button missing");
    const olderPage = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return rows === 3 && page === "1" && hasMore === "0" &&
          box.innerText.includes("Page 2")
          ? { rows, page, hasMore }
          : null;
      })()`,
      15000,
      500,
      "deep-history older page",
    );
    if (!olderPage) throw new Error("cron flow: deep history page 1 did not render 3 rows");

    const newerClicked = await evalJs(c, rowBtnExpr(jobName, "Newer"));
    if (!newerClicked) throw new Error("cron flow: Newer pager button missing");
    const newerPage = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return rows === 20 && page === "0" && hasMore === "1" &&
          box.innerText.includes("Page 1")
          ? { rows, page, hasMore }
          : null;
      })()`,
      15000,
      500,
      "deep-history newer page",
    );
    if (!newerPage) throw new Error("cron flow: deep history page 0 did not restore after Newer");
    flow.historyPaged = true;
    flow.steps.push("history-paging");
    await screenshot(c, "cron-history-paging.png");

    // 2di. Jump to newest (Round 74): from the oldest 3-row page the pager
    //      offers a one-click return to page 0 instead of clicking Newer
    //      back through many pages; assert the jump lands on page 0 with
    //      the second page still discoverable via Older.
    const olderAgainClicked = await evalJs(c, rowBtnExpr(jobName, "Older"));
    if (!olderAgainClicked) throw new Error("cron flow: Older pager button missing for jump");
    const olderAgainPage = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return page === "1" && hasMore === "0" &&
          box.querySelector('[data-jump-newest]') !== null
          ? "last-page"
          : null;
      })()`,
      15000,
      500,
      "deep-history last page for jump",
    );
    if (olderAgainPage !== "last-page") {
      throw new Error("cron flow: last page did not offer Jump to newest");
    }
    const jumpClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"] [data-jump-newest]`)});
        if (!b) return null;
        b.click();
        return true;
      })()`,
    );
    if (!jumpClicked) throw new Error("cron flow: Jump to newest button missing");
    const jumpedPage = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return rows === 20 && page === "0" && hasMore === "1" &&
          box.querySelector('[data-jump-newest]') === null &&
          box.innerText.includes("Page 1")
          ? "jumped"
          : null;
      })()`,
      15000,
      500,
      "jump to newest",
    );
    if (jumpedPage !== "jumped") {
      throw new Error("cron flow: Jump to newest did not land on page 0");
    }
    flow.historyJumpToNewest = true;
    flow.steps.push("history-jump-to-newest");
    await screenshot(c, "cron-history-jump-to-newest.png");

    // 2dii. Load all runs (Round 75): from page 0 the pager offers a
    //       one-click "Load all runs" that replaces the paged view with the
    //       whole 23-run history in one scroll; assert the label, then
    //       return to the paged view.
    const loadAllClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"] [data-load-all]`)});
        if (!b) return null;
        b.click();
        return true;
      })()`,
    );
    if (!loadAllClicked) throw new Error("cron flow: Load all runs button missing");
    const allRunsBox = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const text = box.innerText;
        return box.querySelector('[data-runs-all]') !== null &&
          rows === 23 &&
          text.includes("All 23 runs") &&
          box.querySelector('[data-paged-view]') !== null
          ? { rows, all: true }
          : null;
      })()`,
      15000,
      500,
      "load all runs",
    );
    if (!allRunsBox) throw new Error("cron flow: load-all view did not render all 23 runs");
    const pagedViewClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"] [data-paged-view]`)});
        if (!b) return null;
        b.click();
        return true;
      })()`,
    );
    if (!pagedViewClicked) throw new Error("cron flow: Paged view button missing in load-all view");
    const pagedBack = await waitFor(
      c,
      `(() => {
        const box = document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)});
        if (!box) return null;
        const rows = box.querySelectorAll('[class*="runRow"]').length;
        const page = box.getAttribute("data-runs-page");
        const hasMore = box.getAttribute("data-runs-has-more");
        return rows === 20 && page === "0" && hasMore === "1" &&
          box.querySelector('[data-load-all]') !== null &&
          box.innerText.includes("Page 1")
          ? "paged"
          : null;
      })()`,
      15000,
      500,
      "paged view after load all",
    );
    if (pagedBack !== "paged") {
      throw new Error("cron flow: Paged view did not restore page 0");
    }
    flow.runHistoryLoadAll = true;
    flow.steps.push("history-load-all");
    await screenshot(c, "cron-history-load-all.png");

    const hideAgainClicked = await evalJs(c, rowBtnExpr(jobName, "Hide history"));
    if (!hideAgainClicked) throw new Error("cron flow: Hide history button missing after paging");
    const runsHiddenAgain = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-runs="${flow.jobId}"]`)})`,
      10000,
      400,
      "run history hidden after paging",
    );
    if (!runsHiddenAgain) throw new Error("cron flow: run history did not collapse after paging");

    // 2e. Cluster overview: the panel must show the default lease group as
    //     active/held and surface this job's fresh run in the throughput
    //     stats (real stack, so the busiest-job name comes from the DB).
    const overviewBox = await waitFor(
      c,
      `!!document.querySelector('[data-testid="cron-overview"]')`,
      10000,
      500,
      "cluster overview",
    );
    if (!overviewBox) throw new Error("cron flow: cluster overview missing");
    // Round 82: an API-only backend (CRON_SCHEDULER_ENABLED=false) has no
    // lease, so the overview gauge chip must instead say "disabled"; the
    // enabled backend must show the default group active/held.
    const overviewLeaseExpr = apiOnly
      ? `(() => {
          const box = document.querySelector('[data-testid="cron-overview"]');
          if (!box) return null;
          const chips = [...box.querySelectorAll('[class*="schedulerChip"]')];
          if (!chips.length) return null;
          return chips.some((chip) => chip.textContent.includes("· disabled ·"))
            ? "disabled"
            : null;
        })()`
      : `(() => {
          const box = document.querySelector('[data-testid="cron-overview"]');
          if (!box) return null;
          const chips = [...box.querySelectorAll('[class*="schedulerChip"]')];
          if (!chips.length) return null;
          return chips.some((chip) => chip.textContent.includes("· active ·"))
            ? "active"
            : null;
        })()`;
    const overviewLease = await waitFor(
      c,
      overviewLeaseExpr,
      10000,
      500,
      `overview lease chip (${apiOnly ? "api-only" : "enabled"})`,
    );
    if (!overviewLease) {
      throw new Error(
        `cron flow: ${apiOnly ? "no disabled" : "no active"} lease chip in overview`,
      );
    }
    // The panel refreshes on a 5 s poll, so wait for the post-run stats to
    // catch up rather than reading whatever the last poll rendered.
    const overviewBody = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const text = box.innerText;
        return text.includes("Runs:") &&
          text.includes("total") &&
          text.includes("in the last hour") &&
          text.includes(${JSON.stringify(jobName)})
          ? "ok"
          : null;
      })()`,
      15000,
      500,
      "overview stats",
    );
    if (overviewBody !== "ok") {
      throw new Error("cron flow: overview stats missing run/job info");
    }
    // Round 71: the panel must surface recent lease transitions (empty on a
    // stack that has never failed over, or acquired/lost entries when it has).
    const overviewTransitions = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const text = box.innerText;
        return text.includes("Transitions:") &&
          (text.includes("none recorded yet") || /(acquired|lost)/.test(text))
          ? "ok"
          : null;
      })()`,
      10000,
      500,
      "overview transitions",
    );
    if (overviewTransitions !== "ok") {
      throw new Error("cron flow: overview transitions line missing");
    }
    flow.overviewSeen = true;
    flow.steps.push("overview");
    await screenshot(c, "cron-overview.png");

    // 2e2. Job-row group badge + per-group list filter (Round 83): every
    //      row shows its schedulerGroup and the toolbar filter narrows
    //      /api/cron to one lease group. Seed one foreign-group job straight
    //      into Postgres so the filter has a second real option to select;
    //      the seeded row is deleted in cronCleanup.
    const groupBadge = await waitFor(
      c,
      `(() => {
        const row = document.querySelector(${JSON.stringify(`[data-name="${jobName}"]`)});
        const badge = row?.querySelector('[data-testid="job-group-badge"]');
        return badge && badge.textContent.trim() === "default" ? "ok" : null;
      })()`,
      10000,
      500,
      "job group badge",
    );
    if (groupBadge !== "ok") throw new Error("cron flow: job group badge missing or not default");
    const foreignName = `browser-e2e-cron-foreign-${Date.now().toString(36)}`;
    const foreignGroup = `e2e-list-${Date.now().toString(36)}`;
    const groupStamp = Date.now().toString(36);
    execFileSync(
      "docker",
      ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO cron_jobs (id, name, schedule, prompt, "taskType", enabled, "schedulerGroup", "nextRunAt", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), '${foreignName}', '0 0 1 1 *', 'foreign lease group list filter', 'agent_turn', true,
                 '${foreignGroup}', now() + interval '1 year', now(), now());`],
      { encoding: "utf8", timeout: 15000 },
    );
    flow.foreignJobGroup = foreignGroup;
    flow.foreignJobName = foreignName;
    const groupFilterSeen = await waitFor(
      c,
      `(() => {
        const sel = document.querySelector('[data-testid="job-group-filter"]');
        if (!sel || sel.tagName !== "SELECT") return null;
        const options = [...sel.options].map((o) => o.value);
        return options.includes(${JSON.stringify(foreignGroup)}) ? "ok" : null;
      })()`,
      10000,
      500,
      "job group filter",
    );
    if (groupFilterSeen !== "ok") throw new Error("cron flow: job group filter missing foreign option");
    const applied = await evalJs(c, `(() => {
      const sel = document.querySelector('[data-testid="job-group-filter"]');
      if (!sel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, ${JSON.stringify(foreignGroup)});
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!applied) throw new Error("cron flow: could not apply foreign group filter");
    const filteredHidden = await waitFor(
      c,
      `!document.querySelector(${JSON.stringify(`[data-name="${jobName}"]`)})`,
      10000,
      500,
      "job hidden under foreign group filter",
    );
    if (!filteredHidden) throw new Error("cron flow: foreign group filter did not hide the job");
    const foreignShown = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${foreignName}"]`)})`,
      10000,
      500,
      "foreign job shown under its group filter",
    );
    if (!foreignShown) throw new Error("cron flow: foreign group job did not appear under filter");
    const resetFilter = await evalJs(c, `(() => {
      const sel = document.querySelector('[data-testid="job-group-filter"]');
      if (!sel) return false;
      Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, "");
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    })()`);
    if (!resetFilter) throw new Error("cron flow: could not reset group filter");
    const restored = await waitFor(
      c,
      `!!document.querySelector(${JSON.stringify(`[data-name="${jobName}"]`)})`,
      10000,
      500,
      "job restored after resetting group filter",
    );
    if (!restored) throw new Error("cron flow: job did not return after resetting group filter");
    flow.groupFilterProven = true;
    flow.steps.push("job-group-filter");

    // 2f. Per-group transition filter (Round 73): seed 13 synthetic events
    //     (Round 76) for a second lease group so the Transitions line gains a
    //     filter control and the depth selector can be proven against a
    //     13-event window; the group button narrows the list and All restores
    //     it. The synthetic rows are deleted in cronCleanup.
    const syncEventId = `browser-e2e-event-${Date.now().toString(36)}`;
    const syncEventGroup = `e2e-${Date.now().toString(36)}`;
    execFileSync(
      "docker",
      ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-v", "ON_ERROR_STOP=1", "-c",
        `INSERT INTO cron_scheduler_events (id, "schedulerGroup", owner, event, "previousOwner", "createdAt")
         SELECT '${syncEventId}-' || n, '${syncEventGroup}', 'replica-x', 'acquired', null,
                now() - ((13 - n) * interval '1 second')
         FROM generate_series(1, 13) AS n;`],
      { encoding: "utf8", timeout: 15000 },
    );
    flow.syntheticEventId = syncEventId;
    flow.syntheticEventGroup = syncEventGroup;
    const filterSeen = await waitFor(
      c,
      `!!document.querySelector('[data-testid="overview-event-filter"]')`,
      15000,
      500,
      "event group filter",
    );
    if (!filterSeen) throw new Error("cron flow: event group filter never appeared");
    const groupClicked = await waitFor(
      c,
      `(() => {
        const b = document.querySelector(${JSON.stringify(
          `[data-testid="overview-event-filter"] [data-event-group="${syncEventGroup}"]`,
        )});
        if (!b) return false;
        b.click();
        return true;
      })()`,
      15000,
      500,
      "event group chip click",
    );
    if (!groupClicked) throw new Error("cron flow: event group button missing");
    const filteredTransitions = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const text = box.innerText;
        return text.includes(${JSON.stringify(`${syncEventGroup} · acquired`)}) &&
          !text.includes("default · acquired")
          ? "filtered"
          : null;
      })()`,
      15000,
      500,
      "filtered transitions",
    );
    if (filteredTransitions !== "filtered") {
      throw new Error("cron flow: event group filter did not narrow transitions");
    }

    // 2fii. Per-group event window clarity (Round 74): the filter chips carry
    //       each group's total transition count and the Transitions line
    //       labels the newest-N-of-M window, so a group with history but no
    //       events on the All-view page is self-explanatory. With 13 seeded
    //       events and the default 10-event window, the e2e group must show
    //       "newest 10 of 13" before the depth selector widens it.
    const windowClarityExpr = `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const win = box.querySelector('[data-event-window]');
        const chip = box.querySelector(
          '[data-testid="overview-event-filter"] [data-event-group="${syncEventGroup}"]',
        );
        if (!win || !chip) return null;
        const chipTotal = Number(chip.getAttribute("data-event-total"));
        const [shown, total] = (win.getAttribute("data-event-window") || ":").split(":").map(Number);
        const label = win.innerText;
        return chipTotal === 13 && shown === 10 && total === 13 &&
          label.includes("newest 10 of 13") &&
          label.includes(" for " + ${JSON.stringify(syncEventGroup)})
          ? "window-clarity"
          : null;
      })()`;
    const windowClarity = await waitFor(
      c,
      windowClarityExpr,
      15000,
      500,
      "per-group event window clarity",
    );
    if (windowClarity !== "window-clarity") {
      const diag = await evalJs(
        c,
        `(() => {
          const box = document.querySelector('[data-testid="cron-overview"]');
          const win = box?.querySelector('[data-event-window]');
          const chips = [...(box?.querySelectorAll(
            '[data-testid="overview-event-filter"] [data-event-group]') || [])]
            .map((b) => b.getAttribute("data-event-group") + ":" + b.getAttribute("data-event-total") + ":" + b.getAttribute("aria-pressed"));
          return JSON.stringify({
            transitionsText: box?.innerText || null,
            winAttr: win?.getAttribute("data-event-window") || null,
            winText: win?.innerText || null,
            chips,
          });
        })()`,
      );
      log("  window-clarity DOM diagnostic:", diag);
      throw new Error("cron flow: per-group event window count/label incorrect");
    }
    flow.eventWindowClarity = true;

    // 2fiib. Load-all transition history (Round 78): with the group selected
    //        at the default 10-event window, the Transitions line offers
    //        "Load all for this group"; clicking it swaps the line to a
    //        paginated full-history pass over /cron/overview/events (all 13
    //        synthetic events, data-complete), and "back to newest 10"
    //        restores the depth-limited window and its label.
    const loadAllBtnSeen = await waitFor(
      c,
      `(() => {
        const b = document.querySelector(
          '[data-testid="overview-events-load-all"]',
        );
        return b && b.getAttribute("data-group") === ${JSON.stringify(syncEventGroup)} &&
          Number(b.getAttribute("data-shown")) === 10 &&
          Number(b.getAttribute("data-total")) === 13
          ? "load-all-btn"
          : null;
      })()`,
      15000,
      500,
      "overview load-all button",
    );
    if (loadAllBtnSeen !== "load-all-btn") {
      throw new Error("cron flow: load-all-transitions button missing at default depth");
    }
    const overviewLoadAllClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector('[data-testid="overview-events-load-all"]');
        if (!b) return false;
        b.click();
        return true;
      })()`,
    );
    if (!overviewLoadAllClicked)
      throw new Error("cron flow: could not click load-all transitions");
    const eventsAll = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        const all = box?.querySelector('[data-testid="overview-events-all"]');
        if (!box || !all) return null;
        const shown = Number(all.getAttribute("data-shown"));
        const total = Number(all.getAttribute("data-total"));
        const complete = all.getAttribute("data-complete") === "true";
        return shown === 13 && total === 13 && complete &&
          box.innerText.includes("all 13 transitions") &&
          box.innerText.includes(" for " + ${JSON.stringify(syncEventGroup)})
          ? "events-all"
          : null;
      })()`,
      15000,
      500,
      "overview load-all event list",
    );
    if (eventsAll !== "events-all") {
      const diag = await evalJs(
        c,
        `(() => {
          const box = document.querySelector('[data-testid="cron-overview"]');
          const all = box?.querySelector('[data-testid="overview-events-all"]');
          return JSON.stringify({
            allAttr: all
              ? [all.getAttribute("data-shown"), all.getAttribute("data-total"), all.getAttribute("data-complete")]
              : null,
            allText: all?.innerText || null,
            winText: box?.innerText || null,
          });
        })()`,
      );
      log("  overview-events-all DOM diagnostic:", diag);
      throw new Error("cron flow: load-all view did not render all events");
    }
    flow.overviewEventsLoadAll = true;
    flow.steps.push("overview-events-load-all");
    await screenshot(c, "cron-overview-events-all.png");
    const backClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector('[data-testid="overview-events-all-back"]');
        if (!b) return false;
        b.click();
        return true;
      })()`,
    );
    if (!backClicked) throw new Error("cron flow: back-to-newest button missing in load-all view");
    const windowRestored = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        const win = box?.querySelector('[data-event-window]');
        if (!box || !win) return null;
        const [shown, total] = (win.getAttribute("data-event-window") || ":").split(":").map(Number);
        const btn = box.querySelector('[data-testid="overview-events-all"]');
        return shown === 10 && total === 13 &&
          win.innerText.includes("newest 10 of 13") &&
          !btn ? "window-restored" : null;
      })()`,
      10000,
      400,
      "depth-limited window restored",
    );
    if (windowRestored !== "window-restored") {
      throw new Error("cron flow: load-all back did not restore the depth-limited window");
    }

    // 2fiii. Transition window depth (Round 76): the Transitions row offers a
    //        depth selector; choosing 50 must refetch the overview and widen
    //        the selected group's window from the default 10 to all 13 seeded
    //        events while the chip total stays group-wide.
    const depthSelectSeen = await waitFor(
      c,
      `!!document.querySelector('[data-testid="overview-event-depth"]')`,
      15000,
      500,
      "event depth selector",
    );
    if (!depthSelectSeen) {
      throw new Error("cron flow: transition depth selector never appeared");
    }
    const depthChanged = await evalJs(
      c,
      `(() => {
        const sel = document.querySelector('[data-testid="overview-event-depth"]');
        if (!sel || ![...sel.options].some((o) => o.value === "50")) return false;
        Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set.call(sel, "50");
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      })()`,
    );
    if (!depthChanged) throw new Error("cron flow: transition depth selector missing option");
    const depthWindowExpr = `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const sel = box.querySelector('[data-testid="overview-event-depth"]');
        const win = box.querySelector('[data-event-window]');
        const chip = box.querySelector(
          '[data-testid="overview-event-filter"] [data-event-group="${syncEventGroup}"]',
        );
        if (!sel || !win || !chip) return null;
        if (sel.value !== "50") return null;
        const chipTotal = Number(chip.getAttribute("data-event-total"));
        const [shown, total] = (win.getAttribute("data-event-window") || ":").split(":").map(Number);
        const label = win.innerText;
        return chipTotal === 13 && shown === 13 && total === 13 &&
          label.includes("newest 13 of 13") &&
          label.includes(" for " + ${JSON.stringify(syncEventGroup)})
          ? "depth-window"
          : null;
      })()`;
    const depthWindow = await waitFor(
      c,
      depthWindowExpr,
      15000,
      500,
      "per-group depth window",
    );
    if (depthWindow !== "depth-window") {
      const diag = await evalJs(
        c,
        `(() => {
          const box = document.querySelector('[data-testid="cron-overview"]');
          const sel = box?.querySelector('[data-testid="overview-event-depth"]');
          const win = box?.querySelector('[data-event-window]');
          const chips = [...(box?.querySelectorAll(
            '[data-testid="overview-event-filter"] [data-event-group]') || [])]
            .map((b) => b.getAttribute("data-event-group") + ":" + b.getAttribute("data-event-total") + ":" + b.getAttribute("aria-pressed"));
          return JSON.stringify({
            selValue: sel?.value ?? null,
            selOptions: sel ? [...sel.options].map((o) => o.value) : null,
            transitionsText: box?.innerText || null,
            winAttr: win?.getAttribute("data-event-window") || null,
            winText: win?.innerText || null,
            chips,
          });
        })()`,
      );
      log("  depth-window DOM diagnostic:", diag);
      throw new Error("cron flow: transition depth selector did not widen the window");
    }
    flow.eventWindowDepth = true;
    flow.steps.push("overview-event-depth");
    await screenshot(c, "cron-overview-event-depth.png");

    const allClicked = await evalJs(
      c,
      `(() => {
        const b = document.querySelector(
          '[data-testid="overview-event-filter"] [data-event-group="all"]',
        );
        if (!b) return false;
        b.click();
        return true;
      })()`,
    );
    if (!allClicked) throw new Error("cron flow: All filter button missing");
    const allTransitions = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const text = box.innerText;
        return text.includes(${JSON.stringify(`${syncEventGroup} · acquired`)}) &&
          text.includes("default · acquired")
          ? "all"
          : null;
      })()`,
      15000,
      500,
      "all transitions restored",
    );
    if (allTransitions !== "all") {
      throw new Error("cron flow: All filter did not restore both groups");
    }

    // Round 74 + Round 76: after All restores, the window label must stay
    // coherent — "newest {shown} of {total}" with the All chip carrying the
    // same total — and the depth-50 selector must survive, so the All view
    // now shows more than the old 10-event window.
    const allWindow = await waitFor(
      c,
      `(() => {
        const box = document.querySelector('[data-testid="cron-overview"]');
        if (!box) return null;
        const allChip = box.querySelector('[data-event-group="all"]');
        const win = box.querySelector('[data-event-window]');
        if (!allChip || !win) return null;
        const total = Number(allChip.getAttribute("data-event-total"));
        const [shown, totalAgain] = (win.getAttribute("data-event-window") || ":").split(":").map(Number);
        return total >= 2 && shown > 10 && totalAgain === total &&
          win.innerText.includes("newest " + shown + " of " + total)
          ? "all-window"
          : null;
      })()`,
      15000,
      500,
      "all-view event window label",
    );
    if (allWindow !== "all-window") {
      throw new Error("cron flow: All-view event window total/label incorrect");
    }
    flow.overviewFiltered = true;
    flow.steps.push("overview-event-filter");
    await screenshot(c, "cron-overview-event-filter.png");

    // 3. Rename through the UI.
    const editClicked = await evalJs(c, rowBtnExpr(jobName, "Edit"));
    if (!editClicked) throw new Error("cron flow: Edit button missing");
    const editTitle = await waitFor(c, `document.body.innerText.includes("Edit ${jobName}")`, 10000, 400, "edit mode");
    if (!editTitle) throw new Error("cron flow: edit mode never opened");
    await evalJs(c, jsSetInput('input[aria-label="Cron job name"]', renamed));
    await delay(150);
    const saveClicked = await evalJs(c, jsClick("Save changes", true));
    if (!saveClicked) throw new Error("cron flow: Save changes button missing");
    const renamedRow = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${renamed}"]`)})`, 15000, 500, "renamed cron row");
    if (!renamedRow) throw new Error("cron flow: renamed job never listed");
    const saveNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Saved job ${renamed}`)}) ?? false`,
      5000,
      400,
      "save notice",
    );
    if (!saveNotice) throw new Error("cron flow: save success notice missing");
    flow.editedViaUi = true;
    flow.steps.push("edited-job");

    // 4. Pause: pill must flip to Paused and the Next run line must say paused.
    const pauseClicked = await evalJs(c, rowBtnExpr(renamed, "Pause"));
    if (!pauseClicked) throw new Error("cron flow: Pause button missing");
    const pausedPill = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${renamed}"] [class*="statusPill"]`)})?.textContent.trim() === "Paused"`,
      10000,
      400,
      "paused pill",
    );
    const pausedNext = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${renamed}"]`)})?.innerText.includes("Next run: paused") ?? false`,
      10000,
      400,
      "paused next run",
    );
    const pauseNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Paused ${renamed}`)}) ?? false`,
      5000,
      400,
      "pause notice",
    );
    flow.paused = !!(pausedPill && pausedNext && pauseNotice);
    if (!flow.paused) throw new Error("cron flow: pause did not take effect");
    flow.steps.push("paused");
    await screenshot(c, "cron-paused.png");

    // 5. Resume: the saved terminal status returns and Next run is a real time again.
    const resumeClicked = await evalJs(c, rowBtnExpr(renamed, "Resume"));
    if (!resumeClicked) throw new Error("cron flow: Resume button missing");
    const resumedState = await waitFor(
      c,
      `(() => {
        const pill = document.querySelector(${JSON.stringify(`[data-name="${renamed}"] [class*="statusPill"]`)});
        const row = document.querySelector(${JSON.stringify(`[data-name="${renamed}"]`)});
        return !!pill && pill.textContent.trim() !== "Paused" && !!row && !row.innerText.includes("Next run: paused");
      })()`,
      15000,
      500,
      "resumed state",
    );
    const resumeNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Resumed ${renamed}`)}) ?? false`,
      5000,
      400,
      "resume notice",
    );
    flow.resumed = !!(resumedState && resumeNotice);
    if (!flow.resumed) throw new Error("cron flow: resume did not take effect");
    flow.steps.push("resumed");

    // 6. Delete via the two-click confirm; the row must disappear from the UI.
    const delClicked = await evalJs(c, rowBtnExpr(renamed, "Delete"));
    if (!delClicked) throw new Error("cron flow: Delete button missing");
    const confirmReady = await waitFor(
      c,
      `(() => {
        const row = document.querySelector(${JSON.stringify(`[data-name="${renamed}"]`)});
        return !!row && [...row.querySelectorAll("button")].some((b) => b.textContent.trim() === "Confirm?");
      })()`,
      5000,
      300,
      "delete confirm",
    );
    if (!confirmReady) throw new Error("cron flow: two-click confirm never armed");
    const confirmClicked = await evalJs(c, rowBtnExpr(renamed, "Confirm?"));
    if (!confirmClicked) throw new Error("cron flow: Confirm? button missing");
    const rowGone = await waitFor(c, `!document.querySelector(${JSON.stringify(`[data-name="${renamed}"]`)})`, 15000, 500, "row deleted");
    if (!rowGone) throw new Error("cron flow: deleted job still listed");
    const deleteNotice = await waitFor(
      c,
      `document.querySelector('button[class*="successBanner"]')?.innerText.includes(${JSON.stringify(`Deleted job ${renamed}`)}) ?? false`,
      5000,
      400,
      "delete notice",
    );
    flow.deletedViaUi = !!deleteNotice;
    if (!flow.deletedViaUi) throw new Error("cron flow: delete success notice missing");
    flow.steps.push("deleted-job");
    await screenshot(c, "cron-deleted.png");

    flow.result = {
      createdViaUi: true,
      runTerminal: true,
      runStatus: flow.runStatus,
      runNoticeSeen: true,
      historyShown: true,
      historyPaged: true,
      historyJumpToNewest: true,
      runHistoryLoadAll: true,
      overviewFiltered: true,
      eventWindowDepth: true,
      editedViaUi: true,
      paused: true,
      resumed: true,
      deletedViaUi: true,
    };
    flow.timings.elapsedMs = Date.now() - started;
    log(`  cron journey done in ${flow.timings.elapsedMs}ms (run status: ${flow.runStatus})`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
  }
}

/** Server-side cleanup + verification for the cron journey: delete the
 *  fixture by id (the API refuses DELETE while running, so retry briefly on
 *  409) and confirm the id is gone. */
async function cronCleanup(flow) {
  if (!flow?.jobId) return "none";
  let detail = null;
  try {
    let deleted = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const del = await fetch(`${API}/cron/${flow.jobId}`, { method: "DELETE" });
      if (del.ok) {
        deleted = true;
        break;
      }
      if (del.status === 404) {
        deleted = true;
        break;
      }
      if (del.status !== 409) throw new Error(`delete -> HTTP ${del.status}`);
      await delay(2000);
    }
    if (!deleted) throw new Error("delete refused while running after retries");
    const check = await fetch(`${API}/cron/${flow.jobId}`);
    detail = check.status === 404 ? "clean" : `leftover (HTTP ${check.status})`;
    // Round 83: remove the foreign-group cron job seeded for the list filter
    // and prove it is gone (the main job was already deleted via the API, but
    // this fixture lives outside the API create flow).
    if (flow.foreignJobName) {
      try {
        execFileSync(
          "docker",
          ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-v", "ON_ERROR_STOP=1", "-c",
            `DELETE FROM cron_jobs WHERE name = '${flow.foreignJobName}'`],
          { encoding: "utf8", timeout: 15000 },
        );
        const left = execFileSync(
          "docker",
          ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
            `SELECT count(*) FROM cron_jobs WHERE name = '${flow.foreignJobName}'`],
          { encoding: "utf8", timeout: 15000 },
        ).trim();
        if (left !== "0" && detail === "clean") {
          detail = `error: foreign job remaining after cleanup (${left})`;
        }
      } catch (err) {
        if (detail === "clean") detail = `error: foreign job cleanup: ${err.message}`;
      }
    }
    // Round 73: remove the synthetic second-group transition events (Round 76
    // seeds 13 rows whose ids share the fixture prefix) and prove none remain.
    if (flow.syntheticEventId) {
      try {
        execFileSync(
          "docker",
          ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
            `DELETE FROM cron_scheduler_events WHERE id LIKE 'browser-e2e-event-%'`],
          { encoding: "utf8", timeout: 15000 },
        );
        const left = execFileSync(
          "docker",
          ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
            `SELECT count(*) FROM cron_scheduler_events WHERE id LIKE 'browser-e2e-event-%'`],
          { encoding: "utf8", timeout: 15000 },
        ).trim();
        if (left !== "0" && detail === "clean") {
          detail = `error: synthetic events remaining after cleanup (${left})`;
        }
      } catch (err) {
        if (detail === "clean") detail = `error: synthetic event cleanup: ${err.message}`;
      }
    }
  } catch (err) {
    detail = `error: ${err.message}`;
    log(`  cleanup: cron FAILED: ${err.message}`);
  }
  if (detail !== "clean") log(`  cleanup: cron not clean (${detail})`);
  return detail;
}


/** Find a skill by name through the API (used to capture the server id for
 *  cleanup and to verify server-side state). */
async function skillsFindByName(name) {
  const res = await fetch(`${API}/skills`);
  if (!res.ok) throw new Error(`list skills -> HTTP ${res.status}`);
  const rows = await res.json();
  return (Array.isArray(rows) ? rows : []).find((sk) => sk.name === name) ?? null;
}

/** End-to-end skills journey: create a skill through the /skills UI with
 *  instructions and install it at the same time, reload and verify it
 *  persists, edit description/content, uninstall (pill flips, record stays),
 *  reinstall, then delete via the two-click confirm. Fixtures only; skills
 *  expose a full CRUD API so cleanup is a plain idempotent DELETE. */
async function skillsFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/skills`;
  log(`flow skills -> ${url}`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], timings: {}, result: null, skillId: null, skillName: null };
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "skills ready");
    if (!ready) throw new Error("skills flow: page never loaded");
    const page = await waitFor(c, `document.body.innerText.includes("Agent Skills")`, 30000, 600, "skills page");
    if (!page) throw new Error("skills flow: page never rendered");
    const started = Date.now();

    const stamp = Date.now().toString(36);
    const skillName = `browser-e2e-skill-${stamp}`;
    const description = `Created by browser E2E ${stamp}`;
    flow.skillName = skillName;

    // 1. Create a skill through the UI, installing it in the same step.
    const openCreate = await evalJs(c, jsClick("+ New Skill", true));
    if (!openCreate) throw new Error("skills flow: + New Skill button missing");
    const formReady = await waitFor(
      c,
      `!!document.querySelector('input[aria-label="Skill name"]')`,
      10000,
      400,
      "create form",
    );
    if (!formReady) throw new Error("skills flow: create form never appeared");
    await evalJs(c, jsSetInput('input[aria-label="Skill name"]', skillName));
    await evalJs(c, jsSetInput('input[aria-label="Skill description"]', description));
    await evalJs(c, jsSetInput('textarea[aria-label="Skill instructions"]', `# E2E skill\n\nReply with the single word: skill-ok\n`));
    const checkClicked = await evalJs(c, `(() => {
      const cb = document.querySelector('input[aria-label="Install skill"]');
      if (!cb || cb.checked) return false;
      cb.click();
      return true;
    })()`);
    if (!checkClicked) throw new Error("skills flow: Install skill checkbox missing");
    await delay(150);
    const created = await evalJs(c, jsClick("Create skill", true));
    if (!created) throw new Error("skills flow: Create skill button missing");
    const rowSeen = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)})`, 15000, 500, "skill row");
    if (!rowSeen) throw new Error("skills flow: created skill never listed");
    const installedPill = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${skillName}"] [class*="pill"]`)})?.textContent.trim() === "Installed"`,
      10000,
      400,
      "installed pill",
    );
    if (!installedPill) throw new Error("skills flow: created skill not installed");
    const createNotice = await waitFor(
      c,
      `document.querySelector('[class*="bannerNotice"]')?.innerText.includes(${JSON.stringify(`Skill "${skillName}" created and installed`)}) ?? false`,
      5000,
      300,
      "create notice",
    );
    if (!createNotice) throw new Error("skills flow: create notice missing");
    flow.createdViaUi = true;
    flow.steps.push("created-installed");
    for (const deadline = Date.now() + 10000; Date.now() < deadline;) {
      flow.skillId = (await skillsFindByName(skillName))?.id ?? null;
      if (flow.skillId) break;
      await delay(300);
    }
    if (!flow.skillId) throw new Error("skills flow: created skill not found server-side");
    await screenshot(c, "skills-created.png");

    // 2. Reload: the skill AND its installed state must persist server-side.
    await c.send("Page.navigate", { url });
    const persistRow = await waitFor(c, `!!document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)})`, 15000, 500, "skill after reload");
    if (!persistRow) throw new Error("skills flow: skill missing after reload");
    const persistPill = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${skillName}"] [class*="pill"]`)})?.textContent.trim() === "Installed"`,
      10000,
      400,
      "installed after reload",
    );
    if (!persistPill) throw new Error("skills flow: installed state lost after reload");
    flow.persistedAfterReload = true;
    flow.steps.push("persisted-after-reload");
    await screenshot(c, "skills-reload.png");

    // 3. Edit description + instructions through the UI (name is immutable
    //    in the form); the updated description must render in the row.
    const editClicked = await evalJs(c, rowBtnExpr(skillName, "Edit"));
    if (!editClicked) throw new Error("skills flow: Edit button missing");
    const editMode = await waitFor(c, `document.body.innerText.includes(${JSON.stringify(`Edit skill "${skillName}"`)})`, 10000, 400, "edit mode");
    if (!editMode) throw new Error("skills flow: edit mode never opened");
    const nameDisabled = await evalJs(c, `document.querySelector('input[aria-label="Skill name"]')?.disabled ?? false`);
    if (!nameDisabled) throw new Error("skills flow: skill name editable in form");
    const newDesc = `${description} (edited)`;
    const newContent = `# E2E skill (edited)\n\nReply with the single word: skill-ok-edited\n`;
    await evalJs(c, jsSetInput('input[aria-label="Skill description"]', newDesc));
    await evalJs(c, jsSetInput('textarea[aria-label="Skill instructions"]', newContent));
    await delay(150);
    const saveClicked = await evalJs(c, jsClick("Save changes", true));
    if (!saveClicked) throw new Error("skills flow: Save changes button missing");
    const editedDesc = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)})?.innerText.includes(${JSON.stringify(newDesc)}) ?? false`,
      15000,
      500,
      "edited description",
    );
    if (!editedDesc) throw new Error("skills flow: edited description never rendered");
    const saveNotice = await waitFor(
      c,
      `document.querySelector('[class*="bannerNotice"]')?.innerText.includes(${JSON.stringify(`Skill "${skillName}" updated`)}) ?? false`,
      5000,
      400,
      "save notice",
    );
    if (!saveNotice) throw new Error("skills flow: save notice missing");
    flow.editedViaUi = true;
    flow.steps.push("edited-skill");
    await screenshot(c, "skills-edited.png");

    // 4. Uninstall: pill flips to Not installed and the record stays listed.
    const uninstallClicked = await evalJs(c, rowBtnExpr(skillName, "Uninstall"));
    if (!uninstallClicked) throw new Error("skills flow: Uninstall button missing");
    const offPill = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${skillName}"] [class*="pill"]`)})?.textContent.trim() === "Not installed"`,
      10000,
      400,
      "not-installed pill",
    );
    if (!offPill) throw new Error("skills flow: uninstall did not flip the pill");
    const uninstallNotice = await waitFor(
      c,
      `document.querySelector('[class*="bannerNotice"]')?.innerText.includes(${JSON.stringify(`Skill "${skillName}" uninstalled`)}) ?? false`,
      5000,
      400,
      "uninstall notice",
    );
    if (!uninstallNotice) throw new Error("skills flow: uninstall notice missing");
    const rowStillThere = await evalJs(c, `!!document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)})`);
    if (!rowStillThere) throw new Error("skills flow: uninstall removed the record (should stay)");
    flow.uninstalledViaUi = true;
    flow.steps.push("uninstalled");

    // 5. Reinstall from the row button: pill flips back to Installed.
    const installClicked = await evalJs(c, rowBtnExpr(skillName, "Install"));
    if (!installClicked) throw new Error("skills flow: Install button missing");
    const onPill = await waitFor(
      c,
      `document.querySelector(${JSON.stringify(`[data-name="${skillName}"] [class*="pill"]`)})?.textContent.trim() === "Installed"`,
      10000,
      400,
      "reinstalled pill",
    );
    if (!onPill) throw new Error("skills flow: reinstall did not flip the pill");
    const installNotice = await waitFor(
      c,
      `document.querySelector('[class*="bannerNotice"]')?.innerText.includes(${JSON.stringify(`Skill "${skillName}" installed`)}) ?? false`,
      5000,
      400,
      "install notice",
    );
    if (!installNotice) throw new Error("skills flow: install notice missing");
    flow.reinstalledViaUi = true;
    flow.steps.push("reinstalled");

    // 6. Delete via the two-click confirm; the row must disappear from the UI.
    const delClicked = await evalJs(c, rowBtnExpr(skillName, "Delete"));
    if (!delClicked) throw new Error("skills flow: Delete button missing");
    const confirmReady = await waitFor(
      c,
      `(() => {
        const row = document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)});
        return !!row && [...row.querySelectorAll("button")].some((b) => b.textContent.trim() === "Confirm delete");
      })()`,
      5000,
      300,
      "delete confirm",
    );
    if (!confirmReady) throw new Error("skills flow: two-click confirm never armed");
    const confirmClicked = await evalJs(c, rowBtnExpr(skillName, "Confirm delete"));
    if (!confirmClicked) throw new Error("skills flow: Confirm delete button missing");
    const rowGone = await waitFor(c, `!document.querySelector(${JSON.stringify(`[data-name="${skillName}"]`)})`, 15000, 500, "row deleted");
    if (!rowGone) throw new Error("skills flow: deleted skill still listed");
    const deleteNotice = await waitFor(
      c,
      `document.querySelector('[class*="bannerNotice"]')?.innerText.includes(${JSON.stringify(`Skill "${skillName}" deleted`)}) ?? false`,
      5000,
      400,
      "delete notice",
    );
    if (!deleteNotice) throw new Error("skills flow: delete notice missing");
    flow.deletedViaUi = true;
    flow.steps.push("deleted-skill");
    await screenshot(c, "skills-deleted.png");

    flow.result = {
      createdViaUi: true,
      installedViaUi: true,
      persistedAfterReload: true,
      editedViaUi: true,
      uninstalledViaUi: true,
      reinstalledViaUi: true,
      deletedViaUi: true,
    };
    flow.timings.elapsedMs = Date.now() - started;
    log(`  skills journey done in ${flow.timings.elapsedMs}ms`);
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
    c.close();
  }
}

/** Server-side cleanup + verification for the skills journey: delete the
 *  fixture by id and confirm the id is gone. */
async function skillsCleanup(flow) {
  if (!flow?.skillId) return "none";
  let detail = null;
  try {
    const del = await fetch(`${API}/skills/${flow.skillId}`, { method: "DELETE" });
    if (!del.ok && del.status !== 404) throw new Error(`delete -> HTTP ${del.status}`);
    const check = await fetch(`${API}/skills/${flow.skillId}`);
    detail = check.status === 404 ? "clean" : `leftover (HTTP ${check.status})`;
  } catch (err) {
    detail = `error: ${err.message}`;
    log(`  cleanup: skills FAILED: ${err.message}`);
  }
  if (detail !== "clean") log(`  cleanup: skills not clean (${detail})`);
  return detail;
}

/* --------------------------------- main --------------------------------- */



/** Pre-run garbage collection: delete rows/folders this script itself creates
 *  that were left behind by an earlier interrupted run (killed tabs, failed
 *  rounds, host restarts). Only fixture names/prefixes are matched — real
 *  user data is never touched. Empty per-channel project folders are pruned by
 *  channel deletion; any still-present fixture folder is reported, not
 *  silently removed (the read-only project API cannot force a delete). */
async function staleSweep() {
  const result = { channels: [], sessions: [], connections: [], crons: [], schedulerEvents: [], buckets: [], skills: [], files: [], projectFolders: [], errors: [] };
  const isFixture = (name) =>
    ["browser-e2e-", "e2e-settings-", "e2e-auto-", "e2e-session-", "e2e-status-", "skill-aware e2e"].some((p) =>
      String(name ?? "").startsWith(p),
    );
  try {
    const res = await fetch(`${API}/channels`);
    if (!res.ok) throw new Error(`list channels -> HTTP ${res.status}`);
    const channels = await res.json();
    for (const ch of Array.isArray(channels) ? channels : []) {
      if (!isFixture(ch.slug ?? ch.name ?? "")) continue;
      const del = await fetch(`${API}/channels/${ch.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete channel #${ch.slug} -> HTTP ${del.status}`);
      result.channels.push(ch.slug ?? ch.id);
    }
    if (result.channels.length) log(`  stale sweep: deleted ${result.channels.length} channel(s) [${result.channels.join(", ")}]`);
  } catch (err) {
    result.errors.push(`channels: ${err.message}`);
    log(`  stale sweep: channels FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/agent/sessions`);
    if (!res.ok) throw new Error(`list sessions -> HTTP ${res.status}`);
    const sessions = await res.json();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (!s?.id) continue;
      const title = String(s.title ?? "");
      if (!isFixture(title) && !title.startsWith("Hello from sessions E2E")) continue;
      const del = await fetch(`${API}/agent/sessions/${s.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete session ${s.id} -> HTTP ${del.status}`);
      result.sessions.push(s.id);
    }
    if (result.sessions.length) log(`  stale sweep: deleted ${result.sessions.length} session(s)`);
  } catch (err) {
    result.errors.push(`sessions: ${err.message}`);
    log(`  stale sweep: sessions FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/connections`);
    if (!res.ok) throw new Error(`list connections -> HTTP ${res.status}`);
    const conns = await res.json();
    for (const c of Array.isArray(conns) ? conns : []) {
      if (!isFixture(c.displayName ?? "")) continue;
      const del = await fetch(`${API}/connections/${c.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete connection #${c.displayName} -> HTTP ${del.status}`);
      result.connections.push(c.displayName ?? c.id);
    }
    if (result.connections.length) log(`  stale sweep: deleted ${result.connections.length} connection(s) [${result.connections.join(", ")}]`);
  } catch (err) {
    result.errors.push(`connections: ${err.message}`);
    log(`  stale sweep: connections FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/cron`);
    if (!res.ok) throw new Error(`list cron -> HTTP ${res.status}`);
    const jobs = await res.json();
    for (const j of Array.isArray(jobs) ? jobs : []) {
      if (!isFixture(j.name ?? "")) continue;
      // A stale run-now from an interrupted run can still be in flight; the
      // API refuses DELETE while running, so wait briefly and retry.
      let deleted = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const del = await fetch(`${API}/cron/${j.id}`, { method: "DELETE" });
        if (del.ok) {
          deleted = true;
          break;
        }
        if (del.status !== 409) throw new Error(`delete cron ${j.name} -> HTTP ${del.status}`);
        await delay(2000);
      }
      if (!deleted) throw new Error(`delete cron ${j.name} -> still running after retries`);
      result.crons.push(j.name);
    }
    if (result.crons.length) {
      log(`  stale sweep: deleted ${result.crons.length} cron job(s) [${result.crons.join(", ")}]`);
    }
  } catch (err) {
    result.errors.push(`cron: ${err.message}`);
    log(`  stale sweep: cron FAILED: ${err.message}`);
  }
  // Round 74: an interrupted run can leave its synthetic cron_scheduler_events
  // row behind (the journey's per-run cleanup never runs after a crash).
  // Prune them with the same psql path the journey uses to seed fixtures.
  try {
    const out = execFileSync(
      "docker",
      ["exec", "fmcv-db", "psql", "-U", "fmcv", "-d", "fmcv", "-tA", "-c",
        `DELETE FROM cron_scheduler_events WHERE id LIKE 'browser-e2e-event-%' RETURNING id`],
      { encoding: "utf8", timeout: 15000 },
    );
    result.schedulerEvents = out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^(DELETE|INSERT|UPDATE|SELECT) \d+$/.test(l));
    if (result.schedulerEvents.length) {
      log(`  stale sweep: deleted ${result.schedulerEvents.length} synthetic event(s) [${result.schedulerEvents.join(", ")}]`);
    }
  } catch (err) {
    result.errors.push(`scheduler events: ${err.message}`);
    log(`  stale sweep: scheduler events FAILED: ${err.message}`);
  }
  try {
    const rows = bucketRowsByNameLike("browser-e2e-bucket-%");
    for (const row of rows) {
      // Prefer the app's own DELETE endpoint; fall back to psql when the
      // deployed backend predates it.
      const id = bucketIdByName(row.name);
      if (id) {
        const del = await fetch(`${API}/buckets/${id}`, { method: "DELETE" });
        if (del.status >= 400 && del.status !== 404) {
          throw new Error(`delete bucket ${row.name} -> HTTP ${del.status}`);
        }
      }
      deleteBucketRowsFor(row.name);
      result.buckets.push(row.name);
    }
    if (result.buckets.length) {
      log(`  stale sweep: deleted ${result.buckets.length} bucket(s) [${result.buckets.join(", ")}]`);
    }
  } catch (err) {
    result.errors.push(`buckets: ${err.message}`);
    log(`  stale sweep: buckets FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/skills`);
    if (!res.ok) throw new Error(`list skills -> HTTP ${res.status}`);
    const skills = await res.json();
    for (const sk of Array.isArray(skills) ? skills : []) {
      if (!isFixture(sk.name ?? "")) continue;
      const del = await fetch(`${API}/skills/${sk.id}`, { method: "DELETE" });
      if (!del.ok) throw new Error(`delete skill ${sk.name} -> HTTP ${del.status}`);
      result.skills.push(sk.name);
    }
    if (result.skills.length) log(`  stale sweep: deleted ${result.skills.length} skill(s) [${result.skills.join(", ")}]`);
  } catch (err) {
    result.errors.push(`skills: ${err.message}`);
    log(`  stale sweep: skills FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/agent/workspaces`);
    if (!res.ok) throw new Error(`workspaces -> HTTP ${res.status}`);
    // Remove file-manager fixtures left by interrupted files/html journeys.
    const ws = await fetch(`${API}/agent/workspaces`);
    if (ws.ok) {
      const wsBody = await ws.json();
      const agent = Array.isArray(wsBody.agents) && wsBody.agents[0]?.name;
      if (agent) {
        const listRes = await fetch(`${API}/files/list?scope=${encodeURIComponent(`agent:${agent}`)}&path=`);
        if (listRes.ok) {
          const scope = `agent:${agent}`;
          const listing = await listRes.json();
          const isFixtureFolder = (n) =>
            String(n).startsWith("browser-e2e-files-") || String(n).startsWith("browser-e2e-html-");
          const isFixtureFile = (n) => String(n).startsWith(".dot-");
          const del = async (rel) => {
            const r = await fetch(
              `${API}/files/delete?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(rel)}`,
              { method: "DELETE" },
            );
            if (r.status >= 400 && r.status !== 404) {
              throw new Error(`delete files fixture ${rel} -> HTTP ${r.status}`);
            }
          };
          // The API refuses to delete a non-empty directory, so empty any
          // fixture folder before removing it (recursively for safety).
          const removeFolder = async (name) => {
            const inner = await fetch(
              `${API}/files/list?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(name)}`,
            );
            if (inner.ok) {
              const innerBody = await inner.json();
              for (const e of innerBody.entries ?? []) {
                if (e.type === "directory") await removeFolder(`${name}/${e.name}`);
                else await del(`${name}/${e.name}`);
              }
            }
            await del(name);
          };
          result.files = [];
          for (const e of listing.entries ?? []) {
            const n = String(e.name ?? "");
            if (isFixtureFile(n)) {
              await del(n);
              result.files.push(n);
            } else if (isFixtureFolder(n)) {
              await removeFolder(n);
              result.files.push(n);
            }
          }
        }
      }
    }
    const body = await res.json();
    const projects = Array.isArray(body.projects) ? body.projects : [];
    for (const pr of projects) {
      const name = String(pr?.name ?? pr ?? "");
      if (isFixture(name)) result.projectFolders.push(name);
    }
    if (result.files.length) {
      log(`  stale sweep: deleted ${result.files.length} files fixture(s) [${result.files.join(", ")}]`);
    }
    if (result.projectFolders.length) {
      log(`  stale sweep: leftover fixture project folder(s) [${result.projectFolders.join(", ")}]`);
    }
  } catch (err) {
    result.errors.push(`workspaces: ${err.message}`);
    log(`  stale sweep: workspaces FAILED: ${err.message}`);
  }
  if (!result.errors.length) log("  stale sweep: clean (no fixture leftovers)");
  return result;
}

async function settingsFlow() {
  const sink = { netFailures: [], httpErrors: [], expectedHttp: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/settings`;
  log(`flow settings -> ${url}`);
  const { tab, c } = await setupPage(url);
  const flow = { steps: [], result: null, fixtureId: null, autoFixtureId: null, statusFixtureId: null };
  let autoUpstream = null;
  let draftUpstream = null;
  let statusUpstream = null;
  try {
    wireErrorCapture(c, sink);

    // Capture the connection PATCH bodies: the edit form must NOT echo
    // `apiKey` back, otherwise the masked preview would overwrite the stored
    // secret on every save.
    const patchBodies = [];
    c.on("Network.requestWillBeSent", (p) => {
      const req = p.request;
      if (req.method === "PATCH" && req.url.includes("/api/connections/")) {
        patchBodies.push(req.postData ?? "");
      }
    });

    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "settings ready");
    if (!ready) throw new Error("settings flow: page never loaded");
    const list = await waitFor(c, `document.body.innerText.includes("Connections (")`, 30000, 600, "connections list");
    if (!list) throw new Error("settings flow: connections list never rendered");

    // Hermetic fixture: a throwaway connection pointing at a dead host/port so
    // the Test probe deterministically exercises the graceful-failure path.
    const connName = `e2e-settings-${Date.now().toString(36)}`;
    const secretKey = "sk-e2e-keepexisting-789";
    const created = await fetch(`${API}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: connName,
        baseUrl: "http://127.0.0.1:9/v1",
        modelName: "ds4-flash",
        contextLength: 128000,
        apiKey: secretKey,
      }),
    });
    if (!created.ok) {
      throw new Error(`settings flow: could not create fixture connection (HTTP ${created.status})`);
    }
    flow.fixtureId = (await created.json()).id;
    flow.steps.push("fixture-created");

    await c.send("Page.navigate", { url });
    const visible = await waitFor(
      c,
      `document.body.innerText.includes(${JSON.stringify(connName)})`,
      30000,
      600,
      "fixture row",
    );
    if (!visible) throw new Error("settings flow: fixture row never rendered");

    // 1. Edit must open with a blank API-key field (masked preview removed).
    const editClicked = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(connName)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!editClicked) throw new Error("settings flow: Edit button missing");
    const editMode = await waitFor(c, `document.body.innerText.includes("Edit Connection")`, 15000, 400, "edit mode");
    const keyInputValue = await evalJs(c, `document.querySelector('input[name="apiKey"]')?.value ?? null`);
    flow.keyBlankOnEdit = !!editMode && keyInputValue === "";
    if (!flow.keyBlankOnEdit) {
      throw new Error(`settings flow: API key not blank on edit (value=${JSON.stringify(keyInputValue)})`);
    }
    flow.steps.push("edit-mode-key-blank");

    // 2. Test-before-save: the form's "Test Connection" probes the entered
    //    values (not the stored row), must fail gracefully against a dead
    //    endpoint, and Cancel must discard the probed URL without saving.
    await evalJs(c, jsSetInput('input[name="baseUrl"]', "http://127.0.0.1:1/v1"));
    await delay(100);
    const formTestClicked = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Test Connection" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!formTestClicked) throw new Error("settings flow: form Test Connection button missing");
    const formTestDone = await waitFor(
      c,
      `document.querySelector('[data-form-test-result]')?.innerText.trim().length > 0`,
      20000,
      500,
      "form test result",
    );
    const formTestText = await evalJs(
      c,
      `document.querySelector('[data-form-test-result]')?.innerText.trim() ?? null`,
    );
    flow.formTestGracefulFailure =
      !!formTestDone &&
      !!formTestText &&
      /Connection failed|timed out|HTTP \d+/.test(formTestText);
    if (!flow.formTestGracefulFailure) {
      throw new Error(`settings flow: no graceful form-test result (${JSON.stringify(formTestText)})`);
    }
    flow.steps.push("form-test-before-save");

    const cancelled = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Cancel");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!cancelled) throw new Error("settings flow: Cancel button missing");
    const addMode = await waitFor(c, `document.body.innerText.includes("Add Connection")`, 15000, 400, "add mode after cancel");
    const storedUrlKept = await waitFor(
      c,
      `document.body.innerText.includes("ds4-flash · http://127.0.0.1:9/v1")`,
      15000,
      400,
      "stored url preserved",
    );
    flow.cancelPreservedUrl = !!addMode && !!storedUrlKept;
    if (!flow.cancelPreservedUrl) {
      throw new Error("settings flow: Cancel did not preserve the stored URL");
    }
    flow.steps.push("form-test-cancel-preserves-url");

    // 3. Rename + save: the wire PATCH must not carry apiKey at all.
    const renamed = `Renamed ${Date.now().toString(36)}`;
    const reopened = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(connName)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!reopened) throw new Error("settings flow: Edit button missing (reopen)");
    const reopenedEdit = await waitFor(c, `document.body.innerText.includes("Edit Connection")`, 15000, 400, "edit mode reopened");
    if (!reopenedEdit) throw new Error("settings flow: edit mode never reopened");
    await evalJs(c, jsSetInput('input[name="displayName"]', renamed));
    await delay(100);
    const submitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!submitted) throw new Error("settings flow: save button not found/enabled");
    const saved = await waitFor(c, `document.body.innerText.includes("Connection updated.")`, 15000, 400, "update notice");
    if (!saved) throw new Error("settings flow: update notice never appeared");
    const namePatchBodies = [...patchBodies];
    flow.patchBodies = namePatchBodies;
    flow.keyNotSentOnPatch =
      namePatchBodies.length > 0 && namePatchBodies.every((body) => !body.includes('"apiKey"'));
    if (!flow.keyNotSentOnPatch) {
      throw new Error(`settings flow: PATCH replayed apiKey (${JSON.stringify(namePatchBodies)})`);
    }
    flow.steps.push("edited-without-key");

    // 4. Clear stored key: an explicit opt-in sends apiKey:"" and removes the
    //    stored secret server-side; a previously saved key must not prevent it.
    const clearedEdit = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(renamed)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!clearedEdit) throw new Error("settings flow: Edit missing for clear-key step");
    const clearEditMode = await waitFor(c, `document.body.innerText.includes("Edit Connection")`, 15000, 400, "edit mode for clear-key");
    if (!clearEditMode) throw new Error("settings flow: edit mode never reopened for clear-key");
    const keyDisabledBeforeCheck = await evalJs(
      c,
      `document.querySelector('input[name="apiKey"]')?.disabled ?? false`,
    );
    const clearChecked = await evalJs(c, `(() => {
      const cb = document.querySelector('input[name="clearKey"]');
      if (!cb || cb.checked) return false;
      cb.click();
      return true;
    })()`);
    if (!clearChecked) throw new Error("settings flow: clear-key checkbox missing");
    const keyDisabledAfterCheck = await waitFor(
      c,
      `document.querySelector('input[name="apiKey"]')?.disabled === true && document.querySelector('input[name="apiKey"]')?.placeholder.includes("Stored key will be removed")`,
      10000,
      300,
      "clear-key disabled state",
    );
    flow.keyDisabledBeforeCheck = keyDisabledBeforeCheck;
    flow.keyDisabledAfterCheck = !!keyDisabledAfterCheck;
    const submitClear = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!submitClear) throw new Error("settings flow: clear-key save button not found/enabled");
    const clearedSaved = await waitFor(c, `document.body.innerText.includes("Connection updated.")`, 15000, 400, "clear-key save notice");
    if (!clearedSaved) throw new Error("settings flow: clear-key save notice never appeared");
    const clearPatch = patchBodies.at(-1) ?? "";
    flow.clearKeySent = clearPatch.includes('"apiKey":""');
    if (!flow.clearKeySent) {
      throw new Error(`settings flow: clear-key PATCH missing apiKey:"" (${JSON.stringify(patchBodies)})`);
    }
    const rowState = await fetch(`${API}/connections/${flow.fixtureId}`).then((r) => r.json());
    flow.keyClearedServerSide = rowState.apiKey == null;
    if (!flow.keyClearedServerSide) {
      throw new Error(`settings flow: stored apiKey not cleared server-side (${JSON.stringify(rowState.apiKey)})`);
    }
    flow.steps.push("cleared-stored-key");

    // 3. Test button: dead upstream must surface as a graceful inline result.
    const testClicked = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(renamed)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Test");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!testClicked) throw new Error("settings flow: Test button missing");
    const result = await waitFor(
      c,
      `[...document.querySelectorAll('[class*="testResult"]')].some((el) => el.innerText.trim().length > 0)`,
      20000,
      500,
      "test result",
    );
    const resultText = await evalJs(
      c,
      `[...document.querySelectorAll('[class*="testResult"]')].map((el) => el.innerText.trim()).join(" | ")`,
    );
    flow.testResultText = resultText;
    flow.testGracefulFailure = !!result && /Connection failed|timed out|HTTP \d+/.test(resultText);
    if (!flow.testGracefulFailure) {
      throw new Error(`settings flow: no graceful test result (${JSON.stringify(resultText)})`);
    }
    flow.steps.push("test-result-rendered");
    await screenshot(c, "settings-test-result.png");

    // 5. Auto-probe on save: creating a connection through the form (against
    //    a hermetic fake upstream) triggers a client-side probe of the saved
    //    row; the row shows the structured status + latency result, and the
    //    save banner reports it — saving is never blocked by the probe.
    const autoName = `e2e-auto-${Date.now().toString(36)}`;
    const autoKey = `sk-e2e-auto-${Date.now().toString(36)}`;
    const autoModel = process.env.E2E_CONN_MODEL || "ds4-flash";
    autoUpstream = await startFakeUpstream({ key: autoKey });
    const autoBaseUrl = `http://${connectionHostIp()}:${autoUpstream.port}/v1`;
    await c.send("Page.navigate", { url });
    // The fixture row (renamed) only renders after the client fetch finishes,
    // so this also guarantees React hydration before the form is filled —
    // otherwise jsSetInput + submit can race the server-rendered shell and the
    // native submit would silently do nothing.
    const autoReady = await waitFor(c, `document.body.innerText.includes("Connections (") && document.body.innerText.includes(${JSON.stringify(renamed)})`, 30000, 600, "auto-probe page hydrated");
    if (!autoReady) throw new Error("settings flow: page never reloaded for auto-probe");
    await evalJs(c, jsSetInput('input[name="displayName"]', autoName));
    await evalJs(c, jsSetInput('input[name="baseUrl"]', autoBaseUrl));
    await evalJs(c, jsSetInput('input[name="modelName"]', autoModel));
    await evalJs(c, jsSetInput('input[name="apiKey"]', autoKey));
    await delay(100);
    const autoSubmitted = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.type === "submit" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!autoSubmitted) throw new Error("settings flow: auto-probe Add button not found/enabled");
    const autoRowSeen = await waitFor(c, `document.body.innerText.includes(${JSON.stringify(autoName)})`, 20000, 500, "auto-probe row");
    if (!autoRowSeen) throw new Error("settings flow: auto-probe fixture row never rendered");
    // The UI never exposes the id; resolve it from the API so cleanup + wire
    // assertions can target the exact fixture.
    const autoRows = await fetch(`${API}/connections`).then((r) => r.json());
    const autoRowRec = autoRows.find((x) => x.displayName === autoName);
    flow.autoFixtureId = autoRowRec ? autoRowRec.id : null;
    if (!flow.autoFixtureId) {
      throw new Error(`settings flow: auto-probe fixture id not found (${JSON.stringify(autoRows)})`);
    }
    const autoProbeSeen = await waitFor(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(autoName)}));
      const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
      if (!r) return false;
      const t = r.innerText;
      return t.includes("Connected") && /HTTP 200/.test(t) && /\\d+ ms/.test(t);
    })()`, 20000, 500, "auto-probe row result");
    flow.autoProbeRowSeen = !!autoProbeSeen;
    if (!flow.autoProbeRowSeen) {
      const snapshot = await evalJs(c, `(() => {
        const rs = [...document.querySelectorAll('[class*="testResult"]')].map((el) => el.innerText.trim());
        return rs.length ? rs.join(" | ") : document.body.innerText.slice(0, 1500);
      })()`);
      throw new Error(`settings flow: saved connection was never auto-probed (snapshot: ${JSON.stringify(snapshot)})`);
    }
    flow.autoProbeRowText = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(autoName)}));
      const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
      return r ? r.innerText.trim() : null;
    })()`);
    const autoBanner = await waitFor(c, `document.body.innerText.includes("Probe:")`, 10000, 300, "auto-probe banner");
    flow.autoProbeBannerSeen = !!autoBanner;
    const autoProbeHit = autoUpstream.received.find(
      (r) => r.method === "POST" && (r.url ?? "").endsWith("/chat/completions"),
    );
    flow.autoProbeUpstreamHit = !!autoProbeHit;
    flow.autoProbeUpstreamAuthOk = autoProbeHit?.authorization === `Bearer ${autoKey}`;
    flow.autoProbeUpstreamModel = autoProbeHit?.body?.model;
    flow.autoProbeUpstreamMaxTokens = autoProbeHit?.body?.max_tokens;
    if (!flow.autoProbeUpstreamHit || !flow.autoProbeUpstreamAuthOk) {
      throw new Error(`settings flow: auto-probe did not hit the fake upstream with the stored key (${JSON.stringify(autoUpstream.received)})`);
    }
    flow.steps.push("auto-probe-on-save");

    // 6. Edit replays the last-known probe until a probed value changes.
    const autoEditClicked = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(autoName)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!autoEditClicked) throw new Error("settings flow: auto-probe Edit button missing");
    const autoEditMode = await waitFor(c, `document.body.innerText.includes("Edit Connection")`, 15000, 400, "auto edit mode");
    if (!autoEditMode) throw new Error("settings flow: auto-probe edit mode never opened");
    const autoEditReplay = await waitFor(c, `(() => {
      const el = document.querySelector('[data-form-test-result]');
      if (!el) return false;
      const t = el.innerText;
      return t.includes("Connected") && /HTTP 200/.test(t) && /\\d+ ms/.test(t);
    })()`, 15000, 400, "auto edit-probe replay");
    flow.autoEditReplaysProbe = !!autoEditReplay;
    if (!flow.autoEditReplaysProbe) {
      throw new Error("settings flow: edit form did not replay the saved probe");
    }
    flow.steps.push("auto-probe-replayed-in-edit");
    await screenshot(c, "settings-auto-probe.png");

    // 7. Fetch Models (stored-key endpoint): still editing the auto fixture
    //    with the stored base URL and a blank key, the button must call
    //    GET /connections/:id/models with the backend credential and write
    //    the provider's deduped list into the Models textarea.
    const fetchStoredClicked = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Fetch Models" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!fetchStoredClicked) throw new Error("settings flow: Fetch Models button missing (stored key)");
    const fetchStoredDone = await waitFor(
      c,
      `document.querySelector('[data-models-fetch-result]')?.innerText.includes("Fetched 2 models") ?? false`,
      20000,
      500,
      "fetch models result (stored key)",
    );
    const fetchStoredNote = await evalJs(
      c,
      `document.querySelector('[data-models-fetch-result]')?.innerText.trim() ?? null`,
    );
    const fetchStoredText = await evalJs(
      c,
      `document.querySelector('textarea[name="models"]')?.value ?? ""`,
    );
    const modelsFetchStoredHit = autoUpstream.received.find(
      (r) => r.method === "GET" && (r.url ?? "").endsWith("/models"),
    );
    flow.modelsFetchStoredKeyOk =
      !!fetchStoredDone &&
      (fetchStoredNote ?? "").includes("Fetched 2 models") &&
      fetchStoredText.includes("probe-model") &&
      fetchStoredText.includes("llama-3.1-70b") &&
      !fetchStoredText.includes("LLAMA-3.1-70B");
    flow.modelsFetchStoredKeyAuthOk =
      !!modelsFetchStoredHit &&
      modelsFetchStoredHit.authorization === `Bearer ${autoKey}`;
    if (!flow.modelsFetchStoredKeyOk || !flow.modelsFetchStoredKeyAuthOk) {
      throw new Error(`settings flow: Fetch Models (stored key) failed (text=${JSON.stringify(fetchStoredText)} note=${JSON.stringify(fetchStoredNote)} wire=${JSON.stringify(modelsFetchStoredHit)})`);
    }
    flow.steps.push("fetch-models-stored-key");

    // 8. Fetch Models (draft endpoint): changing the base URL and entering a
    //    key routes through POST /connections/models/fetch, proving the
    //    entered key is what reaches the provider.
    const draftKey = `sk-e2e-draft-${Date.now().toString(36)}`;
    draftUpstream = await startFakeUpstream({ key: draftKey });
    const draftBaseUrl = `http://${connectionHostIp()}:${draftUpstream.port}/v1`;
    await evalJs(c, jsSetInput('input[name="baseUrl"]', draftBaseUrl));
    await evalJs(c, jsSetInput('input[name="apiKey"]', draftKey));
    await delay(100);
    const fetchDraftClicked = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Fetch Models" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!fetchDraftClicked) throw new Error("settings flow: Fetch Models button missing (draft)");
    const fetchDraftDone = await waitFor(
      c,
      `document.querySelector('[data-models-fetch-result]')?.innerText.includes("Fetched 2 models") ?? false`,
      20000,
      500,
      "fetch models result (draft)",
    );
    const fetchDraftText = await evalJs(
      c,
      `document.querySelector('textarea[name="models"]')?.value ?? ""`,
    );
    const modelsFetchDraftHit = draftUpstream.received.find(
      (r) => r.method === "GET" && (r.url ?? "").endsWith("/models"),
    );
    flow.modelsFetchDraftOk =
      !!fetchDraftDone &&
      fetchDraftText.includes("probe-model") &&
      fetchDraftText.includes("llama-3.1-70b") &&
      !fetchDraftText.includes("LLAMA-3.1-70B");
    flow.modelsFetchDraftAuthOk =
      !!modelsFetchDraftHit &&
      modelsFetchDraftHit.authorization === `Bearer ${draftKey}`;
    if (!flow.modelsFetchDraftOk || !flow.modelsFetchDraftAuthOk) {
      throw new Error(`settings flow: Fetch Models (draft) failed (text=${JSON.stringify(fetchDraftText)} wire=${JSON.stringify(modelsFetchDraftHit)})`);
    }
    flow.steps.push("fetch-models-draft");
    await screenshot(c, "settings-fetch-models.png");

    // 8b. Discard the draft values, then prove Fetch Models fails gracefully
    //    (visible error note, never a crash) against a dead endpoint.
    const cancelDraft = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Cancel");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!cancelDraft) throw new Error("settings flow: Cancel (draft) missing");
    const backToAdd = await waitFor(c, `document.body.innerText.includes("Add Connection")`, 15000, 400, "add mode after draft cancel");
    if (!backToAdd) throw new Error("settings flow: draft cancel never returned to add mode");
    const deadEdit = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(renamed)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Edit");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!deadEdit) throw new Error("settings flow: Edit (dead fixture) missing");
    const deadEditMode = await waitFor(c, `document.body.innerText.includes("Edit Connection")`, 15000, 400, "dead fixture edit mode");
    if (!deadEditMode) throw new Error("settings flow: dead fixture edit mode never opened");
    const deadFetchClicked = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Fetch Models" && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!deadFetchClicked) throw new Error("settings flow: Fetch Models (dead) missing");
    const deadFetchDone = await waitFor(
      c,
      `(() => {
        const el = document.querySelector('[data-models-fetch-result]');
        if (!el) return false;
        const t = el.innerText;
        return /Connection failed|timed out|HTTP \d+/.test(t);
      })()`,
      20000,
      500,
      "fetch models failure note",
    );
    const deadFetchNote = await evalJs(
      c,
      `document.querySelector('[data-models-fetch-result]')?.innerText.trim() ?? null`,
    );
    flow.modelsFetchDeadGraceful = !!deadFetchDone && /Connection failed|timed out|HTTP \d+/.test(deadFetchNote ?? "");
    if (!flow.modelsFetchDeadGraceful) {
      throw new Error(`settings flow: dead Fetch Models did not fail gracefully (${JSON.stringify(deadFetchNote)})`);
    }
    flow.steps.push("fetch-models-dead-graceful");
    const cancelDead = await evalJs(c, `(() => {
      const f = [...document.forms].find((x) => x.querySelector('input[name="displayName"]'));
      const b = f && [...f.querySelectorAll("button")].find((x) => x.textContent.trim() === "Cancel");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!cancelDead) throw new Error("settings flow: Cancel (dead) missing");

    // 9. Probe persistence: the auto-probe must be stored server-side and a
    //    reload must replay it with metrics + a "probed HH:MM" marker.
    const persistedRow = await fetch(`${API}/connections/${flow.autoFixtureId}`).then((r) => r.json());
    flow.autoProbePersistedServerSide =
      persistedRow.lastProbeOk === true &&
      persistedRow.lastProbeStatus === 200 &&
      typeof persistedRow.lastProbeLatencyMs === "number" &&
      persistedRow.lastProbeModel === autoModel &&
      !!persistedRow.lastProbeAt;
    if (!flow.autoProbePersistedServerSide) {
      throw new Error(`settings flow: auto probe not persisted server-side (${JSON.stringify(persistedRow)})`);
    }
    await c.send("Page.navigate", { url });
    const reloadedAutoRow = await waitFor(
      c,
      `(() => {
        const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(autoName)}));
        const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
        if (!r) return false;
        const t = r.innerText;
        return t.includes("Connected") && /HTTP 200/.test(t) && /\\d+ ms/.test(t) && /probed \\d{1,2}:\\d{2}/.test(t);
      })()`,
      30000,
      600,
      "auto probe persisted after reload",
    );
    flow.autoProbePersistedAfterReload = !!reloadedAutoRow;
    flow.autoProbePersistedRowText = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(autoName)}));
      const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
      return r ? r.innerText.trim() : null;
    })()`);
    if (!flow.autoProbePersistedAfterReload) {
      throw new Error(`settings flow: auto probe lost after reload (${JSON.stringify(flow.autoProbePersistedRowText)})`);
    }
    flow.steps.push("probe-persisted-after-reload");

    // 10. Failure-with-status metrics: a probe that got an HTTP answer but
    //    failed must still render metrics (HTTP 401 · N ms) and survive a
    //    reload, proving the last-known result keeps its context.
    const statusKey = `sk-e2e-status-${Date.now().toString(36)}`;
    statusUpstream = await startFakeUpstream({ key: statusKey, chatStatus: 401 });
    const statusName = `e2e-status-${Date.now().toString(36)}`;
    const statusConn = await fetch(`${API}/connections`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: statusName,
        baseUrl: `http://${connectionHostIp()}:${statusUpstream.port}/v1`,
        modelName: autoModel,
        contextLength: 128000,
        apiKey: statusKey,
      }),
    });
    if (!statusConn.ok) {
      throw new Error(`settings flow: could not create failure fixture (HTTP ${statusConn.status})`);
    }
    flow.statusFixtureId = (await statusConn.json()).id;
    await c.send("Page.navigate", { url });
    const statusRowSeen = await waitFor(c, `document.body.innerText.includes(${JSON.stringify(statusName)})`, 30000, 600, "failure fixture row");
    if (!statusRowSeen) throw new Error("settings flow: failure fixture row never rendered");
    const statusTestClicked = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(statusName)}));
      const b = li && [...li.querySelectorAll("button")].find((x) => x.textContent.trim() === "Test");
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!statusTestClicked) throw new Error("settings flow: Test (failure fixture) missing");
    const statusMetricsSeen = await waitFor(
      c,
      `(() => {
        const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(statusName)}));
        const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
        if (!r) return false;
        const t = r.innerText;
        return t.includes("HTTP 401") && /HTTP 401 · \\d+ ms/.test(t);
      })()`,
      20000,
      500,
      "failure-with-status metrics",
    );
    flow.failureWithStatusMetrics = !!statusMetricsSeen;
    if (!flow.failureWithStatusMetrics) {
      const snapshot = await evalJs(c, `(() => {
        const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(statusName)}));
        const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
        return r ? r.innerText.trim() : document.body.innerText.slice(0, 1200);
      })()`);
      throw new Error(`settings flow: failure-with-status metrics missing (${JSON.stringify(snapshot)})`);
    }
    flow.failureWithStatusRowText = await evalJs(c, `(() => {
      const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(statusName)}));
      const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
      return r ? r.innerText.trim() : null;
    })()`);
    const statusPersisted = await fetch(`${API}/connections/${flow.statusFixtureId}`).then((r) => r.json());
    flow.failurePersistedServerSide =
      statusPersisted.lastProbeOk === false &&
      statusPersisted.lastProbeStatus === 401 &&
      typeof statusPersisted.lastProbeLatencyMs === "number" &&
      !!statusPersisted.lastProbeAt;
    if (!flow.failurePersistedServerSide) {
      throw new Error(`settings flow: failed probe not persisted (${JSON.stringify(statusPersisted)})`);
    }
    await c.send("Page.navigate", { url });
    const statusReloadSeen = await waitFor(
      c,
      `(() => {
        const li = [...document.querySelectorAll("li")].find((x) => x.innerText.includes(${JSON.stringify(statusName)}));
        const r = li && [...li.querySelectorAll('[class*="testResult"]')][0];
        if (!r) return false;
        const t = r.innerText;
        return t.includes("HTTP 401") && /probed \\d{1,2}:\\d{2}/.test(t);
      })()`,
      30000,
      600,
      "failure metrics after reload",
    );
    flow.failurePersistedAfterReload = !!statusReloadSeen;
    if (!flow.failurePersistedAfterReload) {
      throw new Error("settings flow: failure metrics lost after reload");
    }
    flow.steps.push("failure-metrics-persisted");
    await screenshot(c, "settings-failed-status-reload.png");

    // 4. Server-side cleanup: drop the fixture and confirm the row disappears.
    await fetch(`${API}/connections/${flow.fixtureId}`, { method: "DELETE" });
    flow.fixtureId = null;
    await c.send("Page.navigate", { url });
    const gone = await waitFor(
      c,
      `!document.body.innerText.includes(${JSON.stringify(renamed)})`,
      15000,
      400,
      "fixture removal",
    );
    flow.cleanup = gone ? "clean" : "leftover";

    // 7. Auto-probe fixture cleanup.
    if (flow.autoFixtureId) {
      await fetch(`${API}/connections/${flow.autoFixtureId}`, { method: "DELETE" }).catch(() => undefined);
      flow.autoFixtureId = null;
    }
    await c.send("Page.navigate", { url });
    const autoGone = await waitFor(
      c,
      `!document.body.innerText.includes(${JSON.stringify(autoName)})`,
      15000,
      400,
      "auto fixture removal",
    );
    flow.autoCleanup = autoGone ? "clean" : "leftover";

    // 13. Failure fixture cleanup.
    if (flow.statusFixtureId) {
      await fetch(`${API}/connections/${flow.statusFixtureId}`, { method: "DELETE" }).catch(() => undefined);
      flow.statusFixtureId = null;
    }
    await c.send("Page.navigate", { url });
    const statusGone = await waitFor(
      c,
      `!document.body.innerText.includes(${JSON.stringify(statusName)})`,
      15000,
      400,
      "failure fixture removal",
    );
    flow.statusCleanup = statusGone ? "clean" : "leftover";

    flow.result = {
      keyBlankOnEdit: flow.keyBlankOnEdit,
      keyNotSentOnPatch: flow.keyNotSentOnPatch,
      formTestGracefulFailure: flow.formTestGracefulFailure,
      cancelPreservedUrl: flow.cancelPreservedUrl,
      clearKeySent: flow.clearKeySent,
      keyClearedServerSide: flow.keyClearedServerSide,
      testGracefulFailure: flow.testGracefulFailure,
      autoProbeRowSeen: flow.autoProbeRowSeen,
      autoProbeBannerSeen: flow.autoProbeBannerSeen,
      autoProbeUpstreamHit: flow.autoProbeUpstreamHit,
      autoProbeUpstreamAuthOk: flow.autoProbeUpstreamAuthOk,
      autoProbeUpstreamModel: flow.autoProbeUpstreamModel,
      autoProbeUpstreamMaxTokens: flow.autoProbeUpstreamMaxTokens,
      autoProbeRowText: flow.autoProbeRowText,
      autoEditReplaysProbe: flow.autoEditReplaysProbe,
      modelsFetchStoredKeyOk: flow.modelsFetchStoredKeyOk,
      modelsFetchStoredKeyAuthOk: flow.modelsFetchStoredKeyAuthOk,
      modelsFetchDraftOk: flow.modelsFetchDraftOk,
      modelsFetchDraftAuthOk: flow.modelsFetchDraftAuthOk,
      modelsFetchDeadGraceful: flow.modelsFetchDeadGraceful,
      autoProbePersistedServerSide: flow.autoProbePersistedServerSide,
      autoProbePersistedAfterReload: flow.autoProbePersistedAfterReload,
      autoProbePersistedRowText: flow.autoProbePersistedRowText,
      failureWithStatusMetrics: flow.failureWithStatusMetrics,
      failureWithStatusRowText: flow.failureWithStatusRowText,
      failurePersistedServerSide: flow.failurePersistedServerSide,
      failurePersistedAfterReload: flow.failurePersistedAfterReload,
      statusCleanup: flow.statusCleanup,
      autoCleanup: flow.autoCleanup,
      cleanup: flow.cleanup,
    };
    return { flow, errors: sink };
  } finally {
    if (flow.fixtureId) {
      await fetch(`${API}/connections/${flow.fixtureId}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (flow.autoFixtureId) {
      await fetch(`${API}/connections/${flow.autoFixtureId}`, { method: "DELETE" }).catch(() => undefined);
    }
    if (flow.statusFixtureId) {
      await fetch(`${API}/connections/${flow.statusFixtureId}`, { method: "DELETE" }).catch(() => undefined);
      flow.statusFixtureId = null;
    }
    for (const up of [autoUpstream, draftUpstream, statusUpstream]) {
      if (up) {
        try {
          up.server.close();
        } catch {
          // socket already closed
        }
      }
    }
    c.close();
  }
}

async function main() {
  const routes = [
    {
      route: "home",
      url: `${APP}/`,
      title: "FMCV Agentic",
      waitText: "Open Agent",
      bodyText: { title: "FMCV Agentic", linkAgent: "Open Agent", linkFiles: "Open Files", linkBuckets: "Open Buckets", linkCron: "Open Cron", linkSkills: "Open Skills", linkSettings: "Open Settings" },
      jsChecks: { navPresent: navChecks.present, navLinks: navChecks.links, activeHome: navActive("/") },
    },
    {
      route: "settings",
      url: `${APP}/settings`,
      title: "Settings - FMCV Agentic",
      waitText: "Connections (",
      bodyText: { title: "Settings", connections: "Connections (" },
      jsChecks: { navPresent: navChecks.present, navLinks: navChecks.links, activeSettings: navActive("/settings") },
    },
    {
      route: "agent",
      url: `${APP}/agent`,
      title: "Agent - FMCV Agentic",
      waitText: "Channels",
      bodyText: { title: "Agent", channelsTab: "Channels" },
      jsChecks: {
        navPresent: navChecks.present,
        navLinks: navChecks.links,
        activeAgent: navActive("/agent"),
        composerPresent: "!!document.querySelector('textarea')",
      },
    },
    {
      route: "files",
      url: `${APP}/files`,
      title: "Files - FMCV Agentic",
      waitText: "New file",
      bodyText: { title: "Files", newFile: "New file", refresh: "Refresh" },
      jsChecks: {
        navPresent: navChecks.present,
        navLinks: navChecks.links,
        activeFiles: navActive("/files"),
        scopeSelect: "!!document.querySelector('select[aria-label=\"Scope\"]')",
      },
    },
    {
      route: "buckets",
      url: `${APP}/buckets`,
      title: "Buckets - FMCV Agentic",
      waitText: "New bucket",
      bodyText: { title: "Buckets", newBucket: "New bucket", readOnly: "Documents are read-only" },
      jsChecks: {
        navPresent: navChecks.present,
        navLinks: navChecks.links,
        activeBuckets: navActive("/buckets"),
        newBucketBtn: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "New bucket")`,
      },
    },
    {
      route: "buckets-dark",
      url: `${APP}/buckets`,
      emulate: "dark",
      title: "Buckets - FMCV Agentic",
      waitText: "New bucket",
      bodyText: { title: "Buckets", newBucket: "New bucket", readOnly: "Documents are read-only" },
      darkChecks: {
        bodyDark: bodyBgDark,
        badgeDark: `getComputedStyle(document.querySelector('[class*="badge"]')).backgroundColor === "rgb(66, 32, 6)"`,
        primaryStaysBlue: `getComputedStyle(document.querySelector('button[class*="btnPrimary"]')).backgroundColor === "rgb(37, 99, 235)"`,
      },
    },
    {
      route: "buckets-mobile",
      shotName: "buckets-mobile.png",
      url: `${APP}/buckets`,
      viewport: { width: 360, height: 640 },
      title: "Buckets - FMCV Agentic",
      waitText: "New bucket",
      bodyText: { title: "Buckets", newBucket: "New bucket" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
      },
    },
    {
      route: "cron",
      url: `${APP}/cron`,
      title: "Cron - FMCV Agentic",
      waitText: "New cron job",
      bodyText: { title: "Cron Jobs", newJob: "New cron job", empty: "No cron jobs yet" },
      jsChecks: {
        navPresent: navChecks.present,
        navLinks: navChecks.links,
        activeCron: navActive("/cron"),
        newJobBtn: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "New cron job")`,
      },
    },
    {
      route: "cron-dark",
      url: `${APP}/cron`,
      emulate: "dark",
      clickBeforeChecks: "New cron job",
      title: "Cron - FMCV Agentic",
      waitText: "New cron job",
      bodyText: { title: "Cron Jobs", newJob: "New cron job" },
      darkChecks: {
        bodyDark: bodyBgDark,
        panelDark: `getComputedStyle(document.querySelector('form[class*="panel"]')).backgroundColor === "rgb(17, 24, 39)"`,
        inputDark: `getComputedStyle(document.querySelector('form[class*="panel"] input')).backgroundColor === "rgb(31, 41, 55)"`,
        primaryStaysBlue: `getComputedStyle(document.querySelector('button[class*="btnPrimary"]')).backgroundColor === "rgb(37, 99, 235)"`,
      },
    },
    {
      route: "cron-mobile",
      shotName: "cron-mobile.png",
      url: `${APP}/cron`,
      viewport: { width: 360, height: 640 },
      title: "Cron - FMCV Agentic",
      waitText: "New cron job",
      bodyText: { title: "Cron Jobs", newJob: "New cron job" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
      },
    },
    {
      route: "skills",
      url: `${APP}/skills`,
      title: "Skills - FMCV Agentic",
      waitText: "Agent Skills",
      bodyText: { title: "Agent Skills", newSkill: "New Skill", subtitle: "read_skill" },
      jsChecks: {
        navPresent: navChecks.present,
        navLinks: navChecks.links,
        activeSkills: navActive("/skills"),
        newSkillBtn: `[...document.querySelectorAll("button")].some((b) => b.textContent.trim() === "+ New Skill")`,
      },
    },
    {
      route: "skills-dark",
      url: `${APP}/skills`,
      emulate: "dark",
      clickBeforeChecks: "+ New Skill",
      panelSelector: "form",
      title: "Skills - FMCV Agentic",
      waitText: "Agent Skills",
      bodyText: { title: "Agent Skills", formTitle: "Create a skill" },
      darkChecks: {
        bodyDark: bodyBgDark,
        formDark: `getComputedStyle(document.querySelector('form')).backgroundColor === "rgb(17, 24, 39)"`,
        inputDark: `getComputedStyle(document.querySelector('form input')).backgroundColor === "rgb(15, 23, 42)"`,
      },
    },
    {
      route: "skills-mobile",
      shotName: "skills-mobile.png",
      url: `${APP}/skills`,
      viewport: { width: 360, height: 640 },
      title: "Skills - FMCV Agentic",
      waitText: "Agent Skills",
      bodyText: { title: "Agent Skills", newSkill: "New Skill" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
      },
    },
    {
      route: "home-dark",
      url: `${APP}/`,
      emulate: "dark",
      title: "FMCV Agentic",
      waitText: "Open Agent",
      bodyText: { title: "FMCV Agentic" },
      darkChecks: {
        bodyDark: bodyBgDark,
        cardDark: `getComputedStyle(document.querySelector('main')).backgroundColor === "rgb(17, 24, 39)"`,
      },
    },
    {
      route: "settings-dark",
      url: `${APP}/settings`,
      emulate: "dark",
      title: "Settings - FMCV Agentic",
      waitText: "Connections (",
      bodyText: { title: "Settings", connections: "Connections (" },
      darkChecks: {
        bodyDark: bodyBgDark,
        cardDark: `getComputedStyle(document.querySelector('form[class*="card"]')).backgroundColor === "rgb(17, 24, 39)"`,
        inputDark: `getComputedStyle(document.querySelector('form[class*="card"] input')).backgroundColor === "rgb(31, 41, 55)"`,
      },
    },
    {
      route: "agent-dark",
      url: `${APP}/agent`,
      emulate: "dark",
      title: "Agent - FMCV Agentic",
      waitText: "Channels",
      bodyText: { title: "Agent", channelsTab: "Channels" },
      darkChecks: {
        bodyDark: bodyBgDark,
        modelSelectDark: `getComputedStyle(document.querySelector('[class*="modelSelect"]')).backgroundColor === "rgb(17, 24, 39)"`,
        inputDark: `getComputedStyle(document.querySelector('textarea')).backgroundColor === "rgb(31, 41, 55)"`,
      },
    },
    {
      route: "files-dark",
      url: `${APP}/files`,
      emulate: "dark",
      title: "Files - FMCV Agentic",
      waitText: "New file",
      bodyText: { title: "Files", newFile: "New file", refresh: "Refresh" },
      darkChecks: {
        bodyDark: bodyBgDark,
        selectDark: `getComputedStyle(document.querySelector('select[aria-label="Scope"]')).backgroundColor === "rgb(17, 24, 39)"`,
        primaryStaysBlue: `getComputedStyle(document.querySelector('button[class*="btnPrimary"]')).backgroundColor === "rgb(37, 99, 235)"`,
      },
    },
    {
      route: "home-mobile",
      shotName: "home-mobile.png",
      url: `${APP}/`,
      viewport: { width: 360, height: 640 },
      emulate: "dark",
      title: "FMCV Agentic",
      waitText: "Open Agent",
      bodyText: { title: "FMCV Agentic" },
      darkChecks: {
        cardDark: `getComputedStyle(document.querySelector('main')).backgroundColor === "rgb(17, 24, 39)"`,
      },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
        ctasFit: `[...document.querySelectorAll('main a')].every(a => { const r = a.getBoundingClientRect(); return r.right <= innerWidth + 1 && r.left >= -1; })`,
      },
    },
    {
      route: "settings-mobile",
      shotName: "settings-mobile.png",
      url: `${APP}/settings`,
      viewport: { width: 360, height: 640 },
      title: "Settings - FMCV Agentic",
      waitText: "Connections (",
      bodyText: { title: "Settings" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
      },
    },
    {
      route: "agent-mobile",
      shotName: "agent-mobile.png",
      url: `${APP}/agent`,
      viewport: { width: 360, height: 640 },
      title: "Agent - FMCV Agentic",
      waitText: "Channels",
      bodyText: { title: "Agent", channelsTab: "Channels" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
        composerVisible,
      },
    },
    {
      route: "files-mobile",
      shotName: "files-mobile.png",
      url: `${APP}/files`,
      viewport: { width: 360, height: 640 },
      title: "Files - FMCV Agentic",
      waitText: "New file",
      bodyText: { title: "Files", newFile: "New file" },
      mobileChecks: {
        noHorizontalOverflow,
        navLinksFit,
        filesRowGrid,
      },
    },
  ];

  const version = await httpJson("/json/version");
  const report = { browser: version.Browser, app: APP, ranAt: new Date().toISOString(), routes: [], flow: null };
  log("browser E2E start");

  try {
    report.staleSweep = await staleSweep();
    for (const r of routes) {
      report.routes.push(await probeRoute(r));
    }
    report.navFlow = await navFlow();
    report.flow = await agentChannelFlow();
    report.flow.cleanup = await agentChannelCleanup(report.flow);
    report.flow.projectPrune = await projectFolderPruneCheck("browser-e2e-");
    report.mobileChannelFlow = await mobileChannelFlow();
    report.mobileChannelFlow.cleanup = await mobileChannelCleanup(report.mobileChannelFlow);

    report.sessionsFlow = await agentSessionsFlow();
    report.sessionsFlow.cleanup = await cleanupSessions(report.sessionsFlow.flow);
    report.filesFlow = await filesFlow();
    report.filesFlow.cleanup = await filesCleanup(report.filesFlow.flow);
    report.htmlFlow = await htmlFlow();
    report.htmlFlow.cleanup = await htmlCleanup(report.htmlFlow.flow);
    report.bucketsFlow = await bucketsFlow();
    report.bucketsFlow.cleanup = await bucketsCleanup(report.bucketsFlow.flow);
    report.cronFlow = await cronFlow();
    report.cronFlow.cleanup = await cronCleanup(report.cronFlow.flow);
    report.skillsFlow = await skillsFlow();
    report.skillsFlow.cleanup = await skillsCleanup(report.skillsFlow.flow);
    report.settingsFlow = await settingsFlow();
    log("browser E2E flows done");
  } finally {
    // Never leave check tabs behind, even when a route failed midway.
    await closeCreatedTabs();
  }

  const failures = [];
  const sweep = report.staleSweep;
  if (!sweep || sweep.errors.length) {
    failures.push(`stale sweep: ${sweep ? sweep.errors.join("; ") : "missing result"}`);
  }
  if (sweep && sweep.projectFolders.length) {
    failures.push(`stale sweep: leftover fixture project folder(s) [${sweep.projectFolders.join(", ")}]`);
  }
  for (const r of report.routes) {
    const missing = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) failures.push(`${r.route}: missing check(s) [${missing.join(", ")}]`);
    const errs = errorCount(r.errors);
    if (errs > 0) failures.push(`${r.route}: ${errs} console/network error(s)`);
  }
  const nf = report.navFlow;
  if (!nf || !nf.flow?.result?.active || nf.flow.steps.length < 7 || !nf.flow.homeActive || !nf.flow.bucketsActive || !nf.flow.cronActive || !nf.flow.skillsActive) {
    failures.push(`nav flow: journey not verified (${JSON.stringify(nf && nf.flow)})`);
  }
  const navErrs = errorCount(nf ? nf.errors : {});
  if (navErrs > 0) failures.push(`nav flow: ${navErrs} console/network error(s)`);

  const f = report.flow;
  if (!terminalOk(f.flow.result)) {
    failures.push(`agent flow: terminal state not achieved (${JSON.stringify(f.flow.result)})`);
  } else if (f.flow.result.error && !f.flow.result.answer) {
    // The agent tool-loop itself reported an error; that is a clean terminal
    // render, not a browser breakage. Note it, but only console/network
    // issues are hard failures for the page-quality gate.
    log(`note: agent run reached [error] terminal (${JSON.stringify(f.flow.result)})`);
  }
  if (f.projectPrune && f.projectPrune.ok === false) {
    failures.push(`agent flow: leftover channel project folder(s) [${f.projectPrune.leftovers.join(", ")}]`);
  }
  if (!f.cleanup || !f.cleanup.includes("deleted") || !f.cleanup.includes("agent-fixture-clean")) {
    failures.push(`agent flow: cleanup not verified (${f.cleanup})`);
  }
  const flowErrs = errorCount(f.errors);
  if (flowErrs > 0) failures.push(`agent flow: ${flowErrs} console/network error(s)`);

  const mfl = report.mobileChannelFlow;
  if (
    !mfl ||
    !mfl.flow.result?.layoutOk ||
    !mfl.flow.result?.memberDebugReachable ||
    !mfl.cleanup?.includes("deleted") ||
    String(mfl.cleanup).includes("project-leftovers")
  ) {
    failures.push("mobile channel flow: responsive dashboard/member debug not verified (" + JSON.stringify(mfl && mfl.flow) + ")");
  }
  const mobileErrs = errorCount(mfl ? mfl.errors : {});
  if (mobileErrs > 0) failures.push("mobile channel flow: " + mobileErrs + " console/network error(s)");

  const sf = report.sessionsFlow;
  if (!sf || !sf.flow.answerSeen || !sf.flow.historySeen) {
    failures.push(`sessions flow: reply/persistence not verified (${JSON.stringify(sf && sf.flow)})`);
  }
  const sfr = sf ? sf.flow.result : null;
  const connWiringOk =
    sfr &&
    sfr.connectionSelected &&
    sfr.modelDeferredToConnection &&
    sfr.connectionNoteShown &&
    sfr.connectionIdSent &&
    sfr.modelOmittedFromConverse &&
    sfr.connListNotCatalog &&
    sfr.connListOptionSeen &&
    sfr.connListModelSentOnConverse &&
    sfr.connListUpstreamHit &&
    sfr.connListUpstreamAuthOk &&
    sfr.connListReplySeen &&
    sfr.connListUpstreamModel === sfr.connListModel &&
    sfr.badgeShown &&
    sfr.serverPinnedConnection &&
    sfr.overrideModelSentOnConverse &&
    sfr.overrideUpstreamHit &&
    sfr.overrideUpstreamModel !== undefined &&
    sfr.overrideUpstreamAuthOk &&
    sfr.overrideReplySeen &&
    sfr.overrideModelPersisted &&
    sfr.connectionCleanup === "deleted";
  if (!connWiringOk) {
    failures.push(`sessions flow: connection picker wiring not verified (${JSON.stringify(sfr)})`);
  }
  if (
    sfr &&
    (!sfr.connectionReplySeen ||
      !sfr.upstreamHit ||
      sfr.upstreamModel !== sfr.fixtureModel ||
      !sfr.upstreamAuthOk ||
      !sfr.upstreamMessageSeen)
  ) {
    failures.push(`sessions flow: saved connection did not drive the upstream turn (${JSON.stringify(sfr)})`);
  }
  const sessErrs = errorCount(sf ? sf.errors : {});
  if (sessErrs > 0) failures.push(`sessions flow: ${sessErrs} console/network error(s)`);

  const ffl = report.filesFlow;
  if (
    !ffl ||
    !ffl.flow.result?.created ||
    !ffl.flow.contentSeen ||
    !ffl.flow.downloadVerified ||
    !ffl.flow.deletedFileViaUi
  ) {
    failures.push(`files flow: create/read/download/delete not verified (${JSON.stringify(ffl && ffl.flow)})`);
  }
  if (ffl && ffl.cleanup !== "clean") {
    failures.push(`files flow: cleanup not verified (${ffl.cleanup})`);
  }
  const filesErrs = errorCount(ffl ? ffl.errors : {});
  if (filesErrs > 0) failures.push(`files flow: ${filesErrs} console/network error(s)`);

  const hfl = report.htmlFlow;
  if (
    !hfl ||
    !hfl.flow.result?.createdViaUi ||
    !hfl.flow.result?.iframeVerified ||
    !hfl.flow.result?.newTabVerified ||
    !hfl.flow.result?.deletedViaUi
  ) {
    failures.push(`html-view flow: create/iframe/new-tab/delete not verified (${JSON.stringify(hfl && hfl.flow)})`);
  }
  if (hfl && hfl.cleanup !== "clean") {
    failures.push(`html-view flow: cleanup not verified (${hfl.cleanup})`);
  }
  const htmlErrs = errorCount(hfl ? hfl.errors : {});
  if (htmlErrs > 0) failures.push(`html-view flow: ${htmlErrs} console/network error(s)`);

  const bfl = report.bucketsFlow;
  if (
    !bfl ||
    !bfl.flow.result?.createdViaUi ||
    !bfl.flow.result?.duplicateRejected ||
    !bfl.flow.result?.uploadedViaUi ||
    !bfl.flow.result?.duplicateUploadRejected ||
    !bfl.flow.result?.downloadVerified ||
    !bfl.flow.result?.persistedAfterReload ||
    !bfl.flow.result?.renamedViaUi ||
    !bfl.flow.result?.deletedViaUi
  ) {
    failures.push(`buckets flow: create/upload/download/reload/rename/delete not verified (${JSON.stringify(bfl && bfl.flow)})`);
  }
  if (bfl && bfl.cleanup !== "clean") {
    failures.push(`buckets flow: cleanup not verified (${bfl.cleanup})`);
  }
  const bucketsErrs = errorCount(bfl ? bfl.errors : {});
  if (bucketsErrs > 0) failures.push(`buckets flow: ${bucketsErrs} console/network error(s)`);

  const cfl = report.cronFlow;
  if (
    !cfl ||
    !cfl.flow.result?.createdViaUi ||
    !cfl.flow.result?.runTerminal ||
    !cfl.flow.result?.editedViaUi ||
    !cfl.flow.result?.paused ||
    !cfl.flow.result?.resumed ||
    !cfl.flow.result?.deletedViaUi
  ) {
    failures.push(`cron flow: create/run/edit/pause/resume/delete not verified (${JSON.stringify(cfl && cfl.flow)})`);
  }
  if (cfl && cfl.cleanup !== "clean") {
    failures.push(`cron flow: cleanup not verified (${cfl.cleanup})`);
  }
  const cronErrs = errorCount(cfl ? cfl.errors : {});
  if (cronErrs > 0) failures.push(`cron flow: ${cronErrs} console/network error(s)`);

  const skfl = report.skillsFlow;
  if (
    !skfl ||
    !skfl.flow.result?.createdViaUi ||
    !skfl.flow.result?.installedViaUi ||
    !skfl.flow.result?.persistedAfterReload ||
    !skfl.flow.result?.editedViaUi ||
    !skfl.flow.result?.uninstalledViaUi ||
    !skfl.flow.result?.reinstalledViaUi ||
    !skfl.flow.result?.deletedViaUi
  ) {
    failures.push(`skills flow: create/install/reload/edit/uninstall/reinstall/delete not verified (${JSON.stringify(skfl && skfl.flow)})`);
  }
  if (skfl && skfl.cleanup !== "clean") {
    failures.push(`skills flow: cleanup not verified (${skfl.cleanup})`);
  }
  const skillsErrs = errorCount(skfl ? skfl.errors : {});
  if (skillsErrs > 0) failures.push(`skills flow: ${skillsErrs} console/network error(s)`);

  const sfl = report.settingsFlow;
  if (
    !sfl ||
    !sfl.flow.result?.keyBlankOnEdit ||
    !sfl.flow.result?.keyNotSentOnPatch ||
    !sfl.flow.result?.formTestGracefulFailure ||
    !sfl.flow.result?.cancelPreservedUrl ||
    !sfl.flow.result?.clearKeySent ||
    !sfl.flow.result?.keyClearedServerSide ||
    !sfl.flow.result?.testGracefulFailure
  ) {
    failures.push(`settings flow: key-safety/test not verified (${JSON.stringify(sfl && sfl.flow)})`);
  }
  if (sfl && sfl.flow.result?.cleanup !== "clean") {
    failures.push(`settings flow: fixture cleanup not verified (${sfl.flow.result.cleanup})`);
  }
  const sflr = sfl && sfl.flow.result;
  if (
    !sflr ||
    !sflr.autoProbeRowSeen ||
    !sflr.autoProbeBannerSeen ||
    !sflr.autoProbeUpstreamHit ||
    !sflr.autoProbeUpstreamAuthOk ||
    sflr.autoProbeUpstreamModel !== (process.env.E2E_CONN_MODEL || "ds4-flash") ||
    sflr.autoProbeUpstreamMaxTokens !== 1 ||
    !sflr.autoEditReplaysProbe ||
    !sflr.modelsFetchStoredKeyOk ||
    !sflr.modelsFetchStoredKeyAuthOk ||
    !sflr.modelsFetchDraftOk ||
    !sflr.modelsFetchDraftAuthOk ||
    !sflr.modelsFetchDeadGraceful ||
    !sflr.autoProbePersistedServerSide ||
    !sflr.autoProbePersistedAfterReload ||
    !sflr.failureWithStatusMetrics ||
    !sflr.failurePersistedServerSide ||
    !sflr.failurePersistedAfterReload ||
    sflr.statusCleanup !== "clean" ||
    sflr.autoCleanup !== "clean"
  ) {
    failures.push(`settings flow: auto-probe/replay/fetch-models/persistence not verified (${JSON.stringify(sflr)})`);
  }
  const settingsErrs = errorCount(sfl ? sfl.errors : {});
  if (settingsErrs > 0) failures.push(`settings flow: ${settingsErrs} console/network error(s)`);

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length
    ? `\nFAILURES:\n  - ${failures.join("\n  - ")}`
    : "\nAll browser E2E checks passed.");
  process.exit(failures.length ? 1 : 0);
}

const watchdog = setTimeout(() => {
  console.error(`browser E2E watchdog: no progress for ${WATCHDOG_MS}ms; aborting`);
  closeCreatedTabs().finally(() => process.exit(1));
}, WATCHDOG_MS);
watchdog.unref();

main()
  .catch((e) => {
    console.error(`browser E2E failed: ${e.stack ?? e.message}`);
    process.exit(1);
  })
  .finally(() => clearTimeout(watchdog));
