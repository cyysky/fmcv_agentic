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
 * Flags:
 *   --build    also run backend `nest build` + frontend `next build`
 *   --api-e2e  also run the API E2E suite via scripts/api-e2e.mjs (it flips
 *              the backend to API-only mode and restores it to enabled)
 * Not included by default (need external state / longer runs): browser E2E.
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

if (process.argv.includes("--build")) {
  steps.push({ label: "backend build (nest)", cmd: "npm", args: ["run", "build"], cwd: join(root, "backend") });
  steps.push({ label: "frontend build (next)", cmd: "npm", args: ["run", "build"], cwd: join(root, "frontend") });
}
if (process.argv.includes("--api-e2e")) {
  steps.push({ label: "backend API E2E (flip + restore)", cmd: "node", args: ["scripts/api-e2e.mjs"], cwd: root });
}

for (const step of steps) {
  process.stdout.write(`\n=== ${step.label} ===\n`);
  const r = spawnSync(step.cmd, step.args, { cwd: step.cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`\nverify FAILED at: ${step.label} (exit ${r.status ?? "signal " + r.signal})`);
    process.exit(r.status ?? 1);
  }
}
console.log("\nverify OK — all requested checks green.");
process.exit(0);
