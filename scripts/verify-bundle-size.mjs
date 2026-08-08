#!/usr/bin/env node
/**
 * verify-bundle-size.mjs — frontend first-load bundle budget guard.
 *
 * Reads Next.js 16 (Turbopack) route-bundle-stats.json, written by
 * `next build` (so run this via `node scripts/verify.mjs --build`), and
 * fails when any route's uncompressed first-load JS exceeds the budget.
 *
 * Current baseline: every route pays a ~460-513 KB Next/React framework
 * baseline (shared chunks, ~156 KB gzipped); per-route app code is already
 * well split (about 9-34 KB plus sub-1 KB edge chunks). This guard exists
 * to catch accidental bloat, not
 * to police the framework baseline. Override the budget with
 * FMCV_BUNDLE_BUDGET_BYTES (default 600000).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const statsPath = join(root, "frontend", ".next", "diagnostics", "route-bundle-stats.json");
const budget = Number(process.env.FMCV_BUNDLE_BUDGET_BYTES ?? 600_000);
if (!Number.isFinite(budget) || budget <= 0) {
  console.error("verify-bundle-size: FMCV_BUNDLE_BUDGET_BYTES must be a positive number");
  process.exit(2);
}

if (!existsSync(statsPath)) {
  console.error(
    `verify-bundle-size: ${statsPath} not found — run \`node scripts/verify.mjs --build\`` +
      " (frontend `next build`) first",
  );
  process.exit(2);
}

const rows = JSON.parse(readFileSync(statsPath, "utf8"));
if (!Array.isArray(rows) || rows.length === 0) {
  console.error("verify-bundle-size: route-bundle-stats.json contains no route rows");
  process.exit(2);
}

let worst = 0;
let worstRoute = "";
for (const r of rows) {
  const bytes = Number(r.firstLoadUncompressedJsBytes) || 0;
  if (bytes > worst) {
    worst = bytes;
    worstRoute = String(r.route);
  }
  const kb = String(Math.round(bytes / 1024)).padStart(4);
  const status = bytes > budget ? "OVER BUDGET" : "ok";
  console.log(`  ${String(r.route).padEnd(10)} ${kb} KB  ${String(r.firstLoadChunkPaths?.length ?? "?").padStart(2)} chunks  ${status}`);
}

const worstKb = (worst / 1024).toFixed(0);
const budgetKb = (budget / 1024).toFixed(0);
if (worst > budget) {
  console.error(
    `verify-bundle-size FAILED: largest first-load ${worstKb} KB (${worstRoute}) exceeds budget ${budgetKb} KB. ` +
      `Re-run with FMCV_BUNDLE_BUDGET_BYTES to raise it deliberately.`,
  );
  process.exit(1);
}
console.log(`verify-bundle-size OK — largest first-load ${worstKb} KB (${worstRoute}) within budget ${budgetKb} KB`);
process.exit(0);
