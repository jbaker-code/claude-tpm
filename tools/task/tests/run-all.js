'use strict';
/**
 * run-all.js — the task-tooling test entrypoint (mirrors session-tooling/tests/run-all.js).
 *
 * Runs every *.test.js in this dir as its OWN `node <file>` process (so each stays independently
 * runnable, per tool-conventions' ship-tool bar) and aggregates exit codes. Exits 0 only if ALL
 * suites pass; non-zero otherwise. Prints the "N suites run, M failed" summary line.
 *
 * Discovery is FLAT + non-recursive: shared, non-runnable helpers live under `helpers/` and are
 * never picked up (they do not end in `.test.js` at this level).
 *
 * Run: node tests/run-all.js
 * Node built-ins only.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Env isolation (D8): a test run must never inherit the invoking Claude session's TPM_PROJECT_ROOT /
// TPM_HOME — a leaked TPM_PROJECT_ROOT would redirect every tool at that real project. Tests that need
// either set it explicitly in their own child env.
function cleanEnv() {
  const env = { ...process.env };
  delete env.TPM_PROJECT_ROOT;
  delete env.TPM_HOME;
  delete env.CLAUDE_PROJECT_DIR; // the spawn gate reads it; a live session's value must never reach a test
  delete env.CLAUDE_CODE_SESSION_ID; // identity vars: a live session's values must never reach a test (lib/identity.js reads them)
  delete env.CLAUDE_PID;
  delete env.TPM_SESSION_ID;
  return env;
}

const here = __dirname;
const suites = fs.readdirSync(here)
  .filter((f) => f.endsWith('.test.js'))
  .sort();

let failed = 0;
for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  const res = spawnSync(process.execPath, [path.join(here, suite)], { stdio: 'inherit', env: cleanEnv() });
  if (res.status !== 0) failed++;
}

console.log(`\n──────────────────────────────`);
console.log(`${suites.length} suites run, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
