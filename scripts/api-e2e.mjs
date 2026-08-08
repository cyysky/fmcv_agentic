#!/usr/bin/env node
/**
 * api-e2e.mjs — run the backend API E2E suite against real Postgres with the
 * cron scheduler safely disabled, then restore the live backend.
 *
 * Why the flip (README Testing): the live backend's scheduler shares the
 * database and can steal the suite's jobs / persist real (non-stub) results,
 * making the stub-based assertions flaky.
 *
 * Steps:
 *   1. docker compose up -d --force-recreate backend (CRON_SCHEDULER_ENABLED=false)
 *   2. wait until /api/cron/scheduler reports enabled:false
 *   3. cd backend && npm run test:e2e
 *   4. docker compose up -d --force-recreate backend (normal enabled mode)
 *   5. wait until /api/cron/scheduler reports enabled:true
 *   6. exit 0 only when the suite passed AND the backend is enabled again
 *      (restore runs even when the suite fails or the flip errors)
 */
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const backendDir = join(root, "backend");
const API = process.env.E2E_API_BASE || "http://localhost:5555/api";

const delay = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function schedulerState() {
  try {
    const out = execFileSync("curl", ["-s", `${API}/cron/scheduler`], { encoding: "utf8", timeout: 5000 });
    if (out.includes('"enabled":true')) return "enabled";
    if (out.includes('"enabled":false')) return "disabled";
    return "unknown";
  } catch {
    return "down";
  }
}

function waitForState(want, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    if (schedulerState() === want) return true;
    delay(750);
  }
  return false;
}

function flip(mode) {
  const env = mode === "disabled" ? { ...process.env, CRON_SCHEDULER_ENABLED: "false" } : process.env;
  execFileSync("docker", ["compose", "up", "-d", "--force-recreate", "backend"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
}

const failures = [];

console.log("=== api-e2e: backend -> API-only mode ===");
try {
  flip("disabled");
  if (!waitForState("disabled")) failures.push("backend did not reach API-only mode in time");
} catch (err) {
  failures.push(`mode flip to API-only failed: ${err.message}`);
}

let suiteStatus = null;
if (failures.length === 0) {
  const r = spawnSync("npm", ["run", "test:e2e"], {
    cwd: backendDir,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  suiteStatus = r.status;
  if (suiteStatus !== 0) failures.push(`API E2E suite failed (exit ${suiteStatus ?? "signal " + r.signal})`);
}

console.log("=== api-e2e: restore backend -> enabled mode ===");
try {
  flip("enabled");
  if (!waitForState("enabled")) failures.push("backend did not return to enabled mode in time");
} catch (err) {
  failures.push(`restore to enabled mode failed: ${err.message}`);
}

if (failures.length) {
  console.error(`\napi-e2e FAILED:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
console.log("\napi-e2e OK — API E2E suite green and backend restored to enabled mode.");
process.exit(0);
