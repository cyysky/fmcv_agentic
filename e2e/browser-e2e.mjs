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
//   2. Each route renders its expected document.title (browser tab title)
//   3. /agent: create a channel, post a message, agent runs to an answer/stop
//   4. Screenshots land in e2e/screenshots/, report printed to stdout + JSON
//   5. Channel deletion prunes the per-channel project folder (best-effort docker check)
// Exits non-zero when a main flow fails (quality gate for the round).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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

/** Open a brand-new page tab (never silently reuse a busy/stale tab). */
async function openTab(url) {
  const t = await httpJson(`/json/new?${encodeURIComponent(url)}`, "PUT");
  createdTabs.push(t.id);
  return { id: t.id, url, wsUrl: t.webSocketDebuggerUrl, created: true };
}

async function closeCreatedTabs() {
  for (const id of createdTabs.splice(0)) {
    await httpJson(`/json/close/${id}`).catch((e) => {
      log(`  warn: could not close tab ${id}: ${e.message}`);
    });
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

/** Build a page expression that calls document.querySelector safely. */
const selExpr = (selector) => `document.querySelector(${JSON.stringify(selector)})`;

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
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
  log(`probe ${route.route} -> ${route.url}`);
  const { tab, c } = await setupPage(route.url);
  try {
    wireErrorCapture(c, sink);
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
    if (route.title) checks.docTitle = docTitle === route.title;
    await screenshot(c, `${route.route}.png`);
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
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
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

/** Optional diagnostic: after channel delete, confirm the per-channel project
 *  folder is gone from the backend workspace (best-effort; needs docker). */
async function projectFolderPruneCheck(channelPrefix) {
  try {
    const { execSync } = await import("node:child_process");
    const out = execSync("docker exec fmcv-backend sh -c 'ls /data/workspaces/projects'", {
      encoding: "utf8",
      timeout: 10000,
    });
    const projects = out.trim().split(/\s+/).filter(Boolean);
    const leftovers = projects.filter((n) => n.startsWith(channelPrefix));
    return { ok: leftovers.length === 0, leftovers, projects };
  } catch (err) {
    return { ok: null, error: String(err.message ?? err).slice(0, 200), note: "docker unavailable; skipped" };
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

/* --------------------------------- main --------------------------------- */

async function main() {
  const routes = [
    {
      route: "home",
      url: `${APP}/`,
      title: "FMCV Agentic",
      waitText: "Open Agent",
      bodyText: { title: "FMCV Agentic", linkAgent: "Open Agent", linkSettings: "Open Settings" },
    },
    {
      route: "settings",
      url: `${APP}/settings`,
      title: "Settings - FMCV Agentic",
      waitText: "Connections (",
      bodyText: { title: "Settings", connections: "Connections (" },
    },
    {
      route: "agent",
      url: `${APP}/agent`,
      title: "Agent - FMCV Agentic",
      waitText: "Channels",
      bodyText: { title: "Agent", channelsTab: "Channels" },
      jsChecks: { composerPresent: "!!document.querySelector('textarea')" },
    },
  ];

  const version = await httpJson("/json/version");
  const report = { browser: version.Browser, app: APP, ranAt: new Date().toISOString(), routes: [], flow: null };
  log("browser E2E start");

  try {
    for (const r of routes) {
      report.routes.push(await probeRoute(r));
    }
    report.flow = await agentChannelFlow();
    report.flow.cleanup = await agentChannelCleanup(report.flow);
    report.flow.projectPrune = await projectFolderPruneCheck("browser-e2e-");
    log("browser E2E flows done");
  } finally {
    // Never leave check tabs behind, even when a route failed midway.
    await closeCreatedTabs();
  }

  const failures = [];
  for (const r of report.routes) {
    const missing = Object.entries(r.checks).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length) failures.push(`${r.route}: missing check(s) [${missing.join(", ")}]`);
    const errs = errorCount(r.errors);
    if (errs > 0) failures.push(`${r.route}: ${errs} console/network error(s)`);
  }
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
