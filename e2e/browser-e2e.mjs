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
//
// Checks:
//   1. /, /settings, /agent load without console errors / failed network requests
//   2. /agent: create a channel, post a message, agent runs to an answer/stop
//   3. Screenshots land in e2e/screenshots/, report printed to stdout + JSON
// Exits non-zero when a main flow fails (quality gate for the round).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOST = process.env.CHROME_DEBUG_HOST || "127.0.0.1";
const PORT = process.env.CHROME_DEBUG_PORT || "9222";
const BASE = `http://${HOST}:${PORT}`;
const APP = (process.env.E2E_APP_BASE || "http://localhost:3333").replace(/\/$/, "");
// Resolve artifact paths relative to this script's directory so the script
// behaves the same no matter where it is invoked from.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(process.env.E2E_SHOT_DIR || resolve(SCRIPT_DIR, "screenshots"));
const REPORT = resolve(process.env.E2E_REPORT || resolve(SCRIPT_DIR, "report.json"));
mkdirSync(SHOT_DIR, { recursive: true });

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/* ----------------------------- CDP client ----------------------------- */

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws.addEventListener("message", (e) => this._onMessage(e));
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
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function httpJson(path, method = "GET") {
  const r = await fetch(`${BASE}${path}`, { method });
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
}
const httpNew = (url) => httpJson(`/json/new?${encodeURIComponent(url)}`, "PUT");

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

/** Build a page expression that calls document.querySelector safely. */
const selExpr = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

async function waitFor(c, expression, timeoutMs, stepMs = 400) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await evalJs(c, expression);
    if (v) return v;
    await delay(stepMs);
  }
  return null;
}

async function screenshot(c, name) {
  const out = resolve(SHOT_DIR, name);
  const r = await c.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(out, Buffer.from(r.data, "base64"));
  return out;
}

/* --------------------------- error collection --------------------------- */

function wireErrorCapture(c, sink) {
  c.on("Network.loadingFailed", (p) => {
    // Aborts caused by navigation away are noise, not app failures.
    if (p.errorText && p.errorText.includes("net::ERR_ABORTED") && p.canceled) return;
    sink.netFailures.push({ url: p.url || "(unknown)", errorText: p.errorText });
  });
  c.on("Network.responseReceived", (p) => {
    if (p.response && p.response.status >= 400 && !/favicon/.test(p.response.url)) {
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
    if (p.entry?.level === "error") sink.logErrors.push(p.entry.text);
  });
}

function errorCount(sink) {
  return sink.netFailures.length + sink.httpErrors.length +
    sink.consoleErrors.length + sink.exceptions.length + sink.logErrors.length;
}

/* ------------------------------ flow steps ------------------------------ */

async function openTab(url) {
  const targets = await httpJson("/json");
  const existing = targets.find((t) => t.type === "page" && t.url.startsWith(url));
  let id, wsUrl;
  if (existing) {
    id = existing.id;
    wsUrl = existing.webSocketDebuggerUrl;
  } else {
    const t = await httpNew(url);
    id = t.id;
    wsUrl = t.webSocketDebuggerUrl;
  }
  return { id, url, wsUrl, created: !existing };
}

async function probeRoute(route) {
  const url = route.url;
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const tab = await openTab(url);
  const c = new CDP(tab.wsUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Log.enable");
  wireErrorCapture(c, sink);
  await c.send("Page.navigate", { url });
  // Wait for document ready + SPA data fetches to settle.
  const ready = await waitFor(c, "document.readyState === 'complete'", 15000);
  if (!ready) throw new Error(`${route}: page never reached readyState complete`);
  await delay(1200);

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
  await screenshot(c, `${route.route}.png`);
  c.close();
  return { route, url, tabInfo: { id: tab.id, created: tab.created }, checks, errors: sink };
}

async function agentChannelFlow() {
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/agent`;
  const tab = await openTab(url);
  const c = new CDP(tab.wsUrl);
  await c.open();
  await c.send("Page.enable");
  await c.send("Runtime.enable");
  await c.send("Network.enable");
  await c.send("Log.enable");
  wireErrorCapture(c, sink);
  await c.send("Page.navigate", { url });
  const ready = await waitFor(c, "document.readyState === 'complete'", 15000);
  if (!ready) throw new Error("agent flow: page never loaded");
  await delay(1500);

  const flow = { steps: [], timings: {}, result: null };

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

  // 2. The channel auto-opens; wait for its composer, then post a message.
  const composerReady = await waitFor(
    c,
    `!!${selExpr('textarea[placeholder*="Post a message"]')}`,
    15000,
  );
  if (!composerReady) throw new Error("agent flow: channel composer never appeared");
  const msg = "Follow the channel brief: write hello_round.md into the channel project with channel_write, then reply hello.";
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
  );
  flow.timings.finishedAt = new Date().toISOString();
  flow.timings.elapsedMs = Date.now() - started;
  if (!terminal) throw new Error("agent flow: no terminal state within 180s");
  const state = await evalJs(c, `(() => {
    const t = document.body.innerText.toUpperCase();
    return { answer: t.includes("[ANSWER]"), stopped: t.includes("[STOPPED]"), error: t.includes("[ERROR]") };
  })()`);
  await delay(500);
  await screenshot(c, "agent-channel-done.png");
  flow.result = state;
  flow.steps.push("terminal-state");
  const feed = await evalJs(c, 'document.querySelector("[class*=\\"channelFeed\\"]")?.innerText ?? "NO FEED"');
  flow.feedSnippet = feed.slice(0, 600);
  c.close();
  return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const routes = [
    { route: "home", url: `${APP}/`, bodyText: { title: "FMCV Agentic", linkAgent: "Open Agent", linkSettings: "Open Settings" } },
    { route: "settings", url: `${APP}/settings`, bodyText: { title: "Settings", connections: "Connections (" } },
    {
      route: "agent",
      url: `${APP}/agent`,
      bodyText: { title: "Agent", channelsTab: "Channels" },
      jsChecks: { composerPresent: "!!document.querySelector('textarea')" },
    },
  ];

  const version = await httpJson("/json/version");
  const report = { browser: version.Browser, app: APP, ranAt: new Date().toISOString(), routes: [], flow: null };

  for (const r of routes) {
    report.routes.push(await probeRoute(r));
  }
  report.flow = await agentChannelFlow();
  const opened = [
    ...report.routes.flatMap((r) => (r.tabInfo.created ? [r.tabInfo.id] : [])),
    ...(report.flow.tabInfo.created ? [report.flow.tabInfo.id] : []),
  ];
  for (const id of opened) {
    await httpJson(`/json/close/${id}`).catch(() => {});
  }

  const failures = [];
  for (const r of report.routes) {
    const missing = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) failures.push(`${r.route}: missing text [${missing.join(", ")}]`);
    const errs = errorCount(r.errors);
    if (errs > 0) failures.push(`${r.route}: ${errs} console/network error(s)`);
  }
  const f = report.flow;
  if (!f.flow.result || (f.flow.result.error && !f.flow.result.answer)) {
    failures.push(`agent flow: terminal state not achieved (${JSON.stringify(f.flow.result)})`);
  }
  const flowErrs = errorCount(f.errors);
  if (flowErrs > 0) failures.push(`agent flow: ${flowErrs} console/network error(s)`);

  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(failures.length
    ? `\nFAILURES:\n  - ${failures.join("\n  - ")}`
    : "\nAll browser E2E checks passed.");
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`browser E2E failed: ${e.stack ?? e.message}`);
  process.exit(1);
});
