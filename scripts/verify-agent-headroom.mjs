#!/usr/bin/env node
/**
 * verify-agent-headroom.mjs — /agent first-load headroom guard.
 *
 * Reads Next.js 16 (Turbopack) route-bundle-stats.json, written by
 * `next build` (so run this via `node scripts/verify.mjs --build`), and
 * fails when the agent route's uncompressed first-load bytes exceed the
 * framework baseline by more than a budgeted amount.
 *
 * Why this exists (Round 99): the absolute bundle-size guard (600 KB) still
 * allowed the agent-specific page chunk to creep because the shared
 * Next/React framework dominates every route. The honest metric is the
 * delta between `/agent` and the smallest shared-chunk baseline route:
 * Round 99 measured 34,250 bytes (33 KB) — one 33,934 B page chunk plus a
 * 316 B utility chunk. That remaining code is the chat composer, trace
 * viewer, and header pickers, all first-load by design; the threshold
 * (default 45,000 B) gives ~10 KB of headroom before a split is warranted.
 *
 * Override the budget with FMCV_AGENT_HEADROOM_BUDGET_BYTES (default 45000).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statsPath = join(root, "frontend", ".next", "diagnostics", "route-bundle-stats.json");
const budget = Number(process.env.FMCV_AGENT_HEADROOM_BUDGET_BYTES ?? 45_000);
if (!Number.isFinite(budget) || budget <= 0) {
  console.error("verify-agent-headroom: FMCV_AGENT_HEADROOM_BUDGET_BYTES must be a positive number");
  process.exit(2);
}

if (!existsSync(statsPath)) {
  console.error(
    `verify-agent-headroom: ${statsPath} not found — run \`node scripts/verify.mjs --build\`` +
      " (frontend `next build`) first",
  );
  process.exit(2);
}

const rows = JSON.parse(readFileSync(statsPath, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("verify-agent-headroom: route-bundle-stats.json contains no route rows");
  process.exit(2);
}

const byRoute = (r) => (String(r?.route ?? "") === "/agent" ? r : null);
const agent = rows.find(byRoute) ?? null;
if (!agent) {
  console.error("verify-agent-headroom: no `/agent` row in route-bundle-stats.json");
  process.exit(2);
}

// Baseline: the smallest non-agent route, which is the shared-framework
// floor every route pays (all routes share the same 6 core chunks).
const peers = rows.filter((r) => r.route !== "/agent");
if (peers.length === 0) {
  console.error("verify-agent-headroom: no baseline route to compare against");
  process.exit(2);
}
const baseline = peers.reduce((min, r) =>
  (Number(r.firstLoadUncompressedJsBytes) || 0) < (Number(min.firstLoadUncompressedJsBytes) || 0) ? r : min,
);

const agentBytes = Number(agent.firstLoadUncompressedJsBytes) || 0;
const baselineBytes = Number(baseline.firstLoadUncompressedJsBytes) || 0;
const delta = agentBytes - baselineBytes;
const agentChunks = new Set(agent.firstLoadChunkPaths ?? []);
const baselineChunks = new Set(baseline.firstLoadChunkPaths ?? []);
const extras = [...agentChunks].filter((c) => !baselineChunks.has(c)).sort();

console.log(
  `  /agent        ${String(Math.round(agentBytes / 1024)).padStart(4)} KB  ${agent.firstLoadChunkPaths?.length ?? "?"} chunks`,
);
console.log(
  `  baseline ${String(baseline.route).padEnd(11)} ${String(Math.round(baselineBytes / 1024)).padStart(4)} KB  ${baseline.firstLoadChunkPaths?.length ?? "?"} chunks`,
);
console.log(`  agent-specific delta: ${delta} bytes (${(delta / 1024).toFixed(1)} KB)`);
for (const c of extras) {
  let size = "?";
  try {
    size = String(statSync(join(root, "frontend", c)).size);
  } catch {
    // chunk may be a virtual entry without a physical file — show size unknown
  }
  console.log(`    + ${c.split("/").pop()} ${size} B`);
}

const deltaKb = (delta / 1024).toFixed(1);
const budgetKb = (budget / 1024).toFixed(0);
if (delta > budget) {
  console.error(
    `verify-agent-headroom FAILED: /agent is ${deltaKb} KB above the baseline route (${baseline.route}), ` +
      `exceeding budget ${budgetKb} KB. Split or trim another first-load block, ` +
      `or re-run with FMCV_AGENT_HEADROOM_BUDGET_BYTES to raise it deliberately.`,
  );
  process.exit(1);
}
console.log(`verify-agent-headroom OK — agent-specific first-load ${deltaKb} KB within budget ${budgetKb} KB`);
process.exit(0);
