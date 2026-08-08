#!/usr/bin/env node
/**
 * verify.mjs — one command for the repo's fast checks (no docker flips).
 *
 * Order:
 *   1. REST docs drift guard (scripts/verify-rest-docs.mjs)
 *   2. test-count drift guard (scripts/verify-test-counts.mjs)
 *   3. backend unit tests (npm test -- --runInBand)
 *   4. backend lint + type check
 *   5. frontend lint + type check
 *
 * Not included (they need external state / docker mode flips and are run
 * explicitly per round): backend API E2E, browser E2E, next build.
 *
 * Exit code 0 = everything green; non-zero stops at the first failure.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const steps = [
  { label: "REST docs guard", cmd: "node", args: ["scripts/verify-rest-docs.mjs"], cwd: root },
  { label: "test-count guard", cmd: "node", args: ["scripts/verify-test-counts.mjs"], cwd: root },
  { label: "backend unit tests", cmd: "npm", args: ["test", "--", "--runInBand"], cwd: join(root, "backend") },
  { label: "backend lint", cmd: "npx", args: ["eslint", "src/**/*.ts", "test/**/*.ts"], cwd: join(root, "backend") },
  { label: "backend type check", cmd: "npx", args: ["tsc", "--noEmit"], cwd: join(root, "backend") },
  { label: "frontend type check", cmd: "npx", args: ["tsc", "--noEmit"], cwd: join(root, "frontend") },
  { label: "frontend lint", cmd: "npx", args: ["eslint", "."], cwd: join(root, "frontend") },
];

for (const step of steps) {
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\nverify FAILED at: ${step.label} (exit ${r.status ?? "signal " + r.signal})`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nverify OK — guards, backend unit/lint/types, frontend lint/types all green.");
process.exit(0);
