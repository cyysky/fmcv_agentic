#!/usr/bin/env node
/**
 * verify-test-counts.mjs — keep the README "Testing" section honest without
 * re-running Jest.
 *
 * Checks:
 *   1. backend unit suites   = *.spec.ts files under backend/src
 *   2. backend API e2e suites = *.e2e-spec.ts files under backend/test
 *   3. README "Testing" reports exactly those two suite counts
 *   4. the README Testing section carries no exact per-test counts (the
 *      stale-number form this guard replaces)
 *
 * Exit code 0 = all good; non-zero = a message naming the mismatch.
 */
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unitRoot = join(root, "backend", "src");
const e2eDir = join(root, "backend", "test");
const readmePath = join(root, "README.md");

function collectSpecs(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectSpecs(full));
    else if (entry.isFile() && entry.name.endsWith(".spec.ts")) out.push(full);
  }
  return out;
}

const unitSuites = collectSpecs(unitRoot).length;
const e2eSuites = readdirSync(e2eDir).filter((f) => f.endsWith(".e2e-spec.ts")).length;

const readme = readFileSync(readmePath, "utf8");
const testStart = readme.indexOf("## Testing");
if (testStart < 0) {
  console.error("FAIL — README.md has no '## Testing' section");
  process.exit(1);
}
const after = readme.indexOf("\n## ", testStart + 10);
const testing = readme.slice(testStart, after > 0 ? after : readme.length);

const problems = [];

function reportedCount(claimRe, label) {
  const m = testing.match(claimRe);
  if (!m) {
    problems.push(`README Testing section is missing the "${label}" suite claim`);
    return null;
  }
  return Number(m[2] ?? m[1]);
}

const unitClaim = /\*\*Unit:\s*([0-9]+)(?:\s*tests?\s*\/\s*([0-9]+)\s*suites?)?/i;
const e2eClaim = /\*\*API\s+E2E:\s*([0-9]+)(?:\s*tests?\s*\/\s*([0-9]+)\s*suites?)?/i;

const unitReported = reportedCount(unitClaim, "Unit");
if (unitReported !== null && unitReported !== unitSuites) {
  problems.push(`Unit suite count drift: README says ${unitReported}, found ${unitSuites} spec files under backend/src`);
}
const e2eReported = reportedCount(e2eClaim, "API E2E");
if (e2eReported !== null && e2eReported !== e2eSuites) {
  problems.push(`API E2E suite count drift: README says ${e2eReported}, found ${e2eSuites} e2e-spec files under backend/test`);
}

// The exact per-test forms that drift (e.g. "181 tests / 14 suites",
// "cron jobs (14: ...)", "app health (5), ...").
const staleForms = [
  [/\b[0-9]+\s+tests?\s*\/\s*[0-9]+\s+suites?\b/i, "exact 'N tests / M suites' count"],
  [/\([0-9]+\s*:/, "per-suite '(N:' test count"],
  [/\([0-9]+\)\s*[,;\n]/, "bare '(N)' count"],
];
for (const [re, what] of staleForms) {
  const line = testing.split("\n").find((l) => re.test(l));
  if (line) {
    problems.push(`README Testing section still carries a stale ${what}: "${line.trim()}"`);
  }
}

for (const line of testing.split("\n")) {
  if (/^#/.test(line)) continue;
  if (/suites? counts|spec files|no exact per-test|drift/.test(line) && /verify-test-counts/.test(readme)) continue;
}

if (problems.length) {
  console.error("FAIL — README test-count drift guard:\n  " + problems.join("\n  "));
  process.exit(1);
}

console.log(`Test-count guard OK — unit ${unitSuites} suites / API E2E ${e2eSuites} suites, README matches`);
process.exit(0);
