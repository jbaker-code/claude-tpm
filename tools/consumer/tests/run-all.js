#!/usr/bin/env node
/**
 * tests/consumer/run-all.js — runs every tools/consumer test suite in one shot.
 *
 * PURPOSE
 *   One entry point for "does the tools/consumer suite pass". Runs each suite as a real subprocess
 *   (so one suite's crash can't corrupt another's process state), prints a per-suite PASS/FAIL line,
 *   and exits non-zero if anything failed. Mirrors tools/session/tests/run-all.js.
 *
 *   None of these suites spawn the real `claude`/`npm` binaries — they drive the tools' pure helpers
 *   and (for arg flag-guards) child-process the tool — so this is safe to run anywhere.
 *
 * HOW TO RUN
 *   node tools/consumer/tests/run-all.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('../../tests/lib/scratch');

const SUITES = [
  'tpm-consumer-install/test.js',
  'tpm-consumer-install/test-legacy-helpers.js',
  'tpm-consumer-doctor/test.js',
  'tpm-consumer-uninstall/test.js',
  'tpm-consumer-lint-skill-refs/test.js',
  'tpm-consumer-run-all/test.js',
  'tpm-consumer-observe/test.js',
  'tpm-consumer-voice/test.js',
  // expand-hook/{unit,content-unit}.js retired in #1126 — the %TPM_HOME% resolution hooks they tested
  // were removed (anchor-first resolution via `npx tpm resolve-home` replaced them).
];

// Env isolation (D8): a test run must never inherit the invoking Claude session's TPM_PROJECT_ROOT /
// TPM_HOME — a leaked TPM_PROJECT_ROOT would redirect every tool at that real project. Tests that need
// either set it explicitly in their own child env. (Same strip as the other tools/*/tests/run-all.js.)
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

// `suites` is overridable (paths relative to this dir, or absolute) so the isolation test can run a probe.
function main(suites) {
  const SUITES_RUN = suites || SUITES;
  ensureRunSlug(); // share one scratch slug across this group's child suites
  let failures = 0;
  for (const rel of SUITES_RUN) {
    const p = path.resolve(__dirname, rel);
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
  process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'} — ${SUITES_RUN.length - failures}/${SUITES_RUN.length} suites green\n`);
  process.exit(failures ? 1 : 0);
}

if (require.main === module) main();

module.exports = { main, cleanEnv, SUITES };
