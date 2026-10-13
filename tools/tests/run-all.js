#!/usr/bin/env node
/**
 * tools/tests/run-all.js — the TOP-LEVEL test aggregator (the `npm test` entry point).
 *
 * PURPOSE
 *   One command to run every claude-tpm test suite: each per-suite group's run-all (session / task /
 *   consumer / workflow) plus the standalone top-level + misc tests. Each target runs as a real
 *   subprocess so one failure can't corrupt another's process state; prints a per-target PASS/FAIL
 *   line and exits non-zero if anything failed.
 *
 *   (Replaces the old `npm test` = mutation-check28.js, which was a single-round mutation harness that
 *   mutated checked-in tool COPIES — both retired 2026-09-14 in favor of suites that run against the
 *   canonical shipped tools. See tools/workflow/tests/run-all.js.)
 *
 * HOW TO RUN
 *   node tools/tests/run-all.js   (or: npm test)
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { ensureRunSlug } = require('./lib/scratch');

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

// <bundle>/tools/tests/run-all.js → <bundle>/tools
const TOOLS = path.resolve(__dirname, '..');

// Group run-alls (each fans out to its own suite set) + standalone suites with no group runner.
const TARGETS = [
  'session/tests/run-all.js',
  'task/tests/run-all.js',
  'consumer/tests/run-all.js',
  'workflow/tests/run-all.js',
  'hooks/tests/tpm-hooks-session-start.test.js',
  'config/tests/tpm-config-router.test.js',
  'config/tests/tpm-config-router-hardening.test.js',
  'config/tests/tpm-hygiene-config.test.js',
  'tests/tpm-router.test.js',
  'tests/tpm-bin-shim.test.js',
  'tests/tpm-stamp-manifests.test.js',
  'tests/tpm-home-doc.test.js',
  'tests/tpm-home-env-guard.test.js',
  'tests/tpm-findroot-env.test.js',
  'tests/tpm-scratch-location.test.js',
  'tests/tpm-reading-list.test.js',
  'tests/tpm-workflow-lint-selflocate.test.js',
  'tests/tpm-template.test.js',
  'tests/tpm-template-hardening.test.js',
  'tests/tpm-render-cli.test.js',
  // final-stage cross-cutting guards (fb2): regressions the per-phase tests can't see
  'tests/tpm-runner-registration.test.js',
  'tests/tpm-shipped-content.test.js',
  'tests/tpm-hook-contract.test.js',
  'tests/tpm-package-contents.test.js',
  'tests/tpm-doc-examples.test.js',
  'tests/tpm-npx-regression-guard.test.js',
  'tests/tpm-env-leak-guard.test.js',
  'tests/tpm-attribution-lockin.test.js',
  'misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js',
];

function main() {
  // One scratch slug for the WHOLE run — child suites inherit TPM_TEST_RUN, so every test's output
  // lands under one <os.tmpdir()>/tpm-tests/<slug>/ folder (outside the bundle).
  const slug = ensureRunSlug();
  process.stdout.write(`test scratch → ${path.join(os.tmpdir(), 'tpm-tests', slug)}/\n`);
  let failures = 0;
  for (const rel of TARGETS) {
    const p = path.join(TOOLS, rel);
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
  process.stdout.write(`\n${failures ? 'FAIL' : 'PASS'} — ${TARGETS.length - failures}/${TARGETS.length} targets green\n`);
  process.exit(failures ? 1 : 0);
}

main();
