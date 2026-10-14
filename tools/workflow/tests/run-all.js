#!/usr/bin/env node
/**
 * tools/workflow/tests/run-all.js — runs every tools/workflow test suite in one shot.
 *
 * PURPOSE
 *   One entry point for "does the tools/workflow suite pass". Runs each suite as a real subprocess
 *   (so one suite's crash can't corrupt another's process state), prints a per-suite PASS/FAIL line,
 *   and exits non-zero if anything failed. Mirrors tools/session/tests/run-all.js.
 *
 *   Every suite runs against the CANONICAL promoted tools (tools/workflow/tpm-workflow-*.js) — the
 *   suites reference the shipped tool directly, NOT a checked-in copy. (The old per-phase `tools/`
 *   copies + the external mutation-check28.js harness that mutated them were retired 2026-09-14; the
 *   compose suite keeps its own inline mutation check, which now reads canonical + writes its mutant to
 *   a tmp scratch file.)
 *
 * HOW TO RUN
 *   node tools/workflow/tests/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('../../tests/lib/scratch');

// Env isolation (D8): never hand a live session's TPM_PROJECT_ROOT / TPM_HOME to child suites.
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

const SUITES = [
  'tpm-workflow-audit-cost/tests/audit.test.js',
  'tpm-workflow-audit-cost/tests/cost-ledger.test.js',
  'tpm-workflow-compose/tests/compose.test.js',
  'tpm-workflow-doctor/test.js',
  'tpm-workflow-lint/tests/lint-subagent-prompt/test.js',
  'tpm-workflow-scaffold-config/tests/config-resolver/test.js',
  'tpm-workflow-scaffold-config/tests/scaffold-subagent/test.js',
  'tpm-workflow-signoff-gate/test.js',
  'tpm-workflow-root-env/test.js',
  'tpm-workflow-attribution/test.js',
  'tpm-workflow-config-override-e2e/test.js', // #1183 whole-chain config-override smoke
];

function main() {
  ensureRunSlug(); // share one scratch slug across this group's child suites
  let failures = 0;
  for (const rel of SUITES) {
    const p = path.join(__dirname, rel);
    if (!fs.existsSync(p)) {
      process.stderr.write(`✗ MISSING — ${rel}\n`);
      failures += 1;
      continue;
    }
    try {
      const out = execFileSync('node', [p], { encoding: 'utf8', env: cleanEnv() });
      const lastLine = out.trim().split('\n').pop();
      process.stdout.write(`✓ ${rel} — ${lastLine}\n`);
    } catch (err) {
      process.stderr.write(`✗ FAIL — ${rel}\n${err.stdout || ''}${err.stderr || ''}\n`);
      failures += 1;
    }
  }
  process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'} — ${SUITES.length - failures}/${SUITES.length} suites green\n`);
  process.exit(failures ? 1 : 0);
}

main();
