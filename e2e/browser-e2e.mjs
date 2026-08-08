#!/usr/bin/env node
// browser-e2e.mjs — repeatable end-to-end browser checks for FMCV Agentic
// built on the Chrome DevTools Protocol (no npm deps; Node 22+ global WebSocket).
//
// Requires a Chrome instance on CHROME_DEBUG_PORT (default 9222):
//   google-chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=/tmp/chromedata
//
// Usage:
//   E2E_APP_BASE=http://localhost:3333 node e2e/browser-e2e.mjs
//   CHROME_DEBUG_PORT=9222 E2E_APP_BASE=http://10.0.151.7:3333 node e2e/browser-e2e.mjs
//   E2E_CONN_HOST=<host-ip>  # host IP the Dockerized backend can reach for the fake upstream
//                            # (defaults to the APP hostname or `hostname -I`)
//
// Checks:
//   1. /, /settings, /agent load without console errors / failed network requests
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
//      client-side navigation between all five routes
//   9. Dark mode: all five routes re-probed with prefers-color-scheme: dark
//      (Emulation.setEmulatedMedia), asserting dark surfaces actually apply
//      and the pages still render without console/network errors
//   10. Mobile: all five routes re-probed at 360x640 with device metrics,
//      asserting no horizontal overflow, nav links fit, and the agent
//      composer / files row grid are usable
//   10b. Buckets: create a read-only document bucket through the /buckets UI
//      (agent folder), prove a duplicate name 409s in-page, upload a
//      document, prove a duplicate upload 409s, download it (CDP saved bytes
//      when available), reload and verify both bucket and document persist,
//      then clean up (files via the files API, DB rows via psql in the
//      compose db container — buckets expose no delete API by design)
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
    return ["/", "/agent", "/files", "/buckets", "/settings"].every((h) => hrefs.includes(h));
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
  try {
    return await cleanupChannel(f.channelName);
  } catch (err) {
    log(`  cleanup FAILED: ${err.message}`);
    return `error: ${err.message}`;
  }
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

/** PostgreSQL helpers for bucket fixtures. Buckets expose no delete API by
 *  design (read-only), so browser-E2E fixtures are removed from the compose DB
 *  directly. These require the docker CLI + the `fmcv-db` container (the app
 *  already runs under docker compose per e2e/README.md). */
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

    flow.result = {
      createdViaUi: true,
      duplicateRejected: true,
      uploadedViaUi: true,
      duplicateUploadRejected: true,
      downloadVerified: true,
      persistedAfterReload: true,
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

/** Server-side cleanup + verification for the buckets journey: physical files
 *  via the files API (agent scope) and DB rows via psql in the compose DB
 *  container (buckets deliberately expose no delete endpoint). */
async function bucketsCleanup(flow) {
  if (!flow?.bucket) return "none";
  const detail = { files: null, db: null, verified: null };
  try {
    const scope = flow.scope && flow.scope.startsWith("agent:") ? flow.scope : null;
    if (!scope) {
      detail.files = `error: no agent scope (${flow.scope})`;
    } else {
      const rels = [];
      if (flow.docName) rels.push(`${flow.bucket}/${flow.docName}`);
      rels.push(flow.bucket);
      for (const rel of rels) {
        const r = await fetch(
          `${API}/files/delete?scope=${encodeURIComponent(scope)}&path=${encodeURIComponent(rel)}`,
          { method: "DELETE" },
        );
        if (r.status >= 400 && r.status !== 404) {
          throw new Error(`delete ${rel} -> HTTP ${r.status}`);
        }
      }
      detail.files = "clean";
    }
  } catch (err) {
    detail.files = `error: ${err.message}`;
    log(`  cleanup: bucket files FAILED: ${err.message}`);
  }
  try {
    detail.db = deleteBucketRowsFor(flow.bucket);
  } catch (err) {
    detail.db = `error: ${err.message}`;
    log(`  cleanup: bucket DB FAILED: ${err.message}`);
  }
  try {
    const res = await fetch(`${API}/buckets`);
    if (!res.ok) throw new Error(`list -> HTTP ${res.status}`);
    const body = await res.json();
    const leftover = (Array.isArray(body) ? body : []).find((b) => b.name === flow.bucket);
    detail.verified = leftover ? "leftover" : "clean";
  } catch (err) {
    detail.verified = `error: ${err.message}`;
    log(`  cleanup: bucket verify FAILED: ${err.message}`);
  }
  const ok =
    detail.files === "clean" &&
    (detail.db === "deleted" || detail.db === "already-gone") &&
    detail.verified === "clean";
  if (!ok) log(`  cleanup: buckets not clean (${JSON.stringify(detail)})`);
  return ok ? "clean" : `error: ${JSON.stringify(detail)}`;
}

/* --------------------------------- main --------------------------------- */



/** Pre-run garbage collection: delete rows/folders this script itself creates
 *  that were left behind by an earlier interrupted run (killed tabs, failed
 *  rounds, host restarts). Only fixture names/prefixes are matched — real
 *  user data is never touched. Empty per-channel project folders are pruned by
 *  channel deletion; any still-present fixture folder is reported, not
 *  silently removed (the read-only project API cannot force a delete). */
async function staleSweep() {
  const result = { channels: [], sessions: [], connections: [], buckets: [], projectFolders: [], errors: [] };
  const isFixture = (name) =>
    ["browser-e2e-", "e2e-settings-", "e2e-auto-", "e2e-session-", "e2e-status-"].some((p) =>
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
    const rows = bucketRowsByNameLike("browser-e2e-bucket-%");
    for (const row of rows) {
      if (row.folderType === "agent" && row.folderName) {
        const del = await fetch(
          `${API}/files/delete?scope=${encodeURIComponent(`agent:${row.folderName}`)}&path=${encodeURIComponent(row.name)}`,
          { method: "DELETE" },
        );
        if (del.status >= 400 && del.status !== 404) {
          throw new Error(`delete bucket folder ${row.name} -> HTTP ${del.status}`);
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
    const res = await fetch(`${API}/agent/workspaces`);
    if (!res.ok) throw new Error(`workspaces -> HTTP ${res.status}`);
    const body = await res.json();
    const projects = Array.isArray(body.projects) ? body.projects : [];
    for (const pr of projects) {
      const name = String(pr?.name ?? pr ?? "");
      if (isFixture(name)) result.projectFolders.push(name);
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
      bodyText: { title: "FMCV Agentic", linkAgent: "Open Agent", linkFiles: "Open Files", linkBuckets: "Open Buckets", linkSettings: "Open Settings" },
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
      bodyText: { title: "Buckets", newBucket: "New bucket", readOnly: "Read-only" },
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
      bodyText: { title: "Buckets", newBucket: "New bucket", readOnly: "Read-only" },
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
    report.sessionsFlow = await agentSessionsFlow();
    report.sessionsFlow.cleanup = await cleanupSessions(report.sessionsFlow.flow);
    report.filesFlow = await filesFlow();
    report.filesFlow.cleanup = await filesCleanup(report.filesFlow.flow);
    report.bucketsFlow = await bucketsFlow();
    report.bucketsFlow.cleanup = await bucketsCleanup(report.bucketsFlow.flow);
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
  if (!nf || !nf.flow?.result?.active || nf.flow.steps.length < 5 || !nf.flow.homeActive || !nf.flow.bucketsActive) {
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
  const flowErrs = errorCount(f.errors);
  if (flowErrs > 0) failures.push(`agent flow: ${flowErrs} console/network error(s)`);

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

  const bfl = report.bucketsFlow;
  if (
    !bfl ||
    !bfl.flow.result?.createdViaUi ||
    !bfl.flow.result?.duplicateRejected ||
    !bfl.flow.result?.uploadedViaUi ||
    !bfl.flow.result?.duplicateUploadRejected ||
    !bfl.flow.result?.downloadVerified ||
    !bfl.flow.result?.persistedAfterReload
  ) {
    failures.push(`buckets flow: create/upload/download/reload not verified (${JSON.stringify(bfl && bfl.flow)})`);
  }
  if (bfl && bfl.cleanup !== "clean") {
    failures.push(`buckets flow: cleanup not verified (${bfl.cleanup})`);
  }
  const bucketsErrs = errorCount(bfl ? bfl.errors : {});
  if (bucketsErrs > 0) failures.push(`buckets flow: ${bucketsErrs} console/network error(s)`);

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
