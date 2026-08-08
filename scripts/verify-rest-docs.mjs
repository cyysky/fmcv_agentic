#!/usr/bin/env node
// Route-vs-docs drift guard for the FMCV Agentic README.
//
// Scans every NestJS controller under backend/src for its route decorators,
// normalizes them to `METHOD /api/...` (the app uses the global `/api`
// prefix), and cross-checks the resulting set against the "## REST API"
// tables in README.md. Exits non-zero whenever:
//   - a real route is missing from the docs, or
//   - a documented route no longer exists in code.
//
// Zero dependencies: Node 20+ built-ins only. Run from the repo root:
//   node scripts/verify-rest-docs.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README_PATH = join(ROOT, "README.md");
const CONTROLLERS_DIR = join(ROOT, "backend", "src");

// Real routes that are intentionally not part of the user-facing REST
// reference (e.g. the bare `GET /api` hello probe). Add here deliberately,
// with a comment explaining why the docs omit it.
const INTENTIONALLY_UNDOCUMENTED = new Set(["GET /api"]);

const HTTP_METHODS = new Set(["GET", "POST", "PATCH", "DELETE", "PUT"]);
const DECORATOR_RE =
  /@(Controller|Get|Post|Patch|Delete|Put)\s*\(\s*(?:(['"])([^'"]*)\2)?\s*\)/g;

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function parseControllers() {
  const files = walk(CONTROLLERS_DIR).filter((f) => f.endsWith(".controller.ts"));
  const routes = new Set();

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    let classPrefix = "";
    let parsed = 0;

    for (const match of source.matchAll(DECORATOR_RE)) {
      const decorator = match[1];
      const arg = match[3] ?? "";
      if (decorator === "Controller") {
        classPrefix = arg;
      } else if (HTTP_METHODS.has(decorator.toUpperCase())) {
        parsed += 1;
        const base = `/${classPrefix}/${arg}`.replace(/\/+/g, "/").replace(/\/+$/, "") || "";
        routes.add(`${decorator.toUpperCase()} /api${base}`);
      }
    }

    // Fail loudly on decorators this parser cannot see, so a future
    // refactor can't silently turn the check into a no-op.
    let rawCount = 0;
    for (const _ of source.matchAll(/@(Get|Post|Patch|Delete|Put)\s*\(/g)) rawCount += 1;
    if (rawCount !== parsed) {
      throw new Error(
        `${relative(ROOT, file)}: ${rawCount} method decorator(s) found but only ${parsed} parsed`,
      );
    }
  }

  return routes;
}

function parseReadme() {
  const source = readFileSync(README_PATH, "utf8");
  const routes = new Set();
  for (const [, method, cell] of source.matchAll(/^\|\s*(GET|POST|PATCH|DELETE|PUT)\s+\|\s*([^|\n]+)\s*\|/gm)) {
    const pathMatch = cell.match(/`?(\/api\/[^\s`]+)/);
    if (!pathMatch) {
      throw new Error(`README REST row for ${method} has no /api path: ${cell.trim()}`);
    }
    const path = pathMatch[1].split("?")[0].replace(/\/+$/, "");
    routes.add(`${method.toUpperCase()} ${path}`);
  }
  return routes;
}

function main() {
  const code = [...parseControllers()].sort();
  const docs = [...parseReadme()].sort();
  const documented = new Set(docs);
  const implemented = new Set(code);

  const missingFromDocs = code
    .filter((r) => !documented.has(r) && !INTENTIONALLY_UNDOCUMENTED.has(r))
    .sort();
  const missingFromCode = docs.filter((r) => !implemented.has(r)).sort();

  console.log(`Controllers scanned: routes ${code.length}, docs rows ${docs.length}`);
  if (missingFromDocs.length === 0 && missingFromCode.length === 0) {
    console.log("OK — every REST route is documented and every docs row exists in code.");
    return;
  }

  if (missingFromDocs.length > 0) {
    console.error("Routes missing from README:");
    for (const r of missingFromDocs) console.error(`  - ${r}`);
  }
  if (missingFromCode.length > 0) {
    console.error("Documented routes missing from code:");
    for (const r of missingFromCode) console.error(`  - ${r}`);
  }
  process.exitCode = 1;
}

try {
  main();
} catch (err) {
  console.error(`verify-rest-docs failed: ${err.message}`);
  process.exitCode = 1;
}
