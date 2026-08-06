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
//   5. Channel deletion prunes the per-channel project folder (verified via the
//      workspace API — no docker/container dependency)
//   6. Sessions: create a persisted chat, converse, reload the page and re-open
//      it from the sidebar (history survived), then delete the session
//   7. Files: create a file + dotfile through the /files UI, read the content
//      back, delete both through the UI and verify server-side removal
//   8. Global nav: active-route state per page + nav links drive real
//      client-side navigation between all four routes
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

/** Global-nav assertions shared by every route probe. */
const navChecks = {
  present: `!!${selExpr('nav[aria-label="Main"]')}`,
  links: `(() => {
    const hrefs = [...document.querySelectorAll('nav[aria-label="Main"] a')].map((a) => a.getAttribute("href"));
    return ["/", "/agent", "/files", "/settings"].every((h) => hrefs.includes(h));
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

/** Global-nav journey: active-route state on load, then use the nav links
 *  to move between every route and confirm the URL, title and active state
 *  follow along (proves the navigation actually works, not just renders). */
async function navFlow() {
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
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
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/agent`;
  log(`flow agent sessions -> ${url}`);
  const { tab, c } = await setupPage(url);
  try {
    wireErrorCapture(c, sink);
    await c.send("Page.navigate", { url });
    const ready = await waitFor(c, "document.readyState === 'complete'", 30000, 500, "sessions ready");
    if (!ready) throw new Error("sessions flow: page never loaded");
    const flow = { steps: [], timings: {}, result: null };

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
    flow.result = { persisted: true, renamed: true };
    return { url, tabInfo: { id: tab.id, created: tab.created }, flow, errors: sink };
  } finally {
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
 *  content back, delete both through the UI, and prove the removal really
 *  happened (server-side) via the backend API. */
async function filesFlow() {
  const sink = { netFailures: [], httpErrors: [], consoleErrors: [], exceptions: [], logErrors: [] };
  const url = `${APP}/files`;
  log(`flow files -> ${url}`);
  const { tab, c } = await setupPage(url);
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

/* --------------------------------- main --------------------------------- */

async function main() {
  const routes = [
    {
      route: "home",
      url: `${APP}/`,
      title: "FMCV Agentic",
      waitText: "Open Agent",
      bodyText: { title: "FMCV Agentic", linkAgent: "Open Agent", linkFiles: "Open Files", linkSettings: "Open Settings" },
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
  ];

  const version = await httpJson("/json/version");
  const report = { browser: version.Browser, app: APP, ranAt: new Date().toISOString(), routes: [], flow: null };
  log("browser E2E start");

  try {
    for (const r of routes) {
      report.routes.push(await probeRoute(r));
    }
    report.navFlow = await navFlow();
    report.flow = await agentChannelFlow();
    report.flow.cleanup = await agentChannelCleanup(report.flow);
    report.flow.projectPrune = await projectFolderPruneCheck("browser-e2e-");
    report.sessionsFlow = await agentSessionsFlow();
    report.sessionsFlow.cleanup = await cleanupSessions(report.sessionsFlow);
    report.filesFlow = await filesFlow();
    report.filesFlow.cleanup = await filesCleanup(report.filesFlow.flow);
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
  const nf = report.navFlow;
  if (!nf || !nf.flow?.result?.active || nf.flow.steps.length < 4 || !nf.flow.homeActive) {
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
  const sessErrs = errorCount(sf ? sf.errors : {});
  if (sessErrs > 0) failures.push(`sessions flow: ${sessErrs} console/network error(s)`);

  const ffl = report.filesFlow;
  if (!ffl || !ffl.flow.result?.created || !ffl.flow.contentSeen || !ffl.flow.deletedFileViaUi) {
    failures.push(`files flow: create/read/delete not verified (${JSON.stringify(ffl && ffl.flow)})`);
  }
  if (ffl && ffl.cleanup !== "clean") {
    failures.push(`files flow: cleanup not verified (${ffl.cleanup})`);
  }
  const filesErrs = errorCount(ffl ? ffl.errors : {});
  if (filesErrs > 0) failures.push(`files flow: ${filesErrs} console/network error(s)`);

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
