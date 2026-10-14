#!/usr/bin/env node
/**
 * test.js — unit test for the tpm-workflow doctor preflight. Zero-dep (node assert). Exercises the
 * pure check functions, charter resolution against the real bundle, and the full runAll (all-green in
 * claude-tpm). Usage: node tools/workflow/tests/doctor/test.js
 *
 * (The doctor no longer checks PreToolUse hook wiring — those hooks are plugin-delivered now — so the
 * former checkGateHook / checkExpandHook tests are gone.)
 */
'use strict';

const assert = require('assert');
const doctor = require('../../tpm-workflow-doctor.js');

let pass = 0; let fail = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); pass += 1; }
  catch (e) { process.stdout.write(`  ✗ ${name}\n      ${e.message}\n`); fail += 1; }
}

check('checkCharters: all default charters resolve under the bundle', () => {
  const r = doctor.checkCharters(doctor.BUNDLE);
  assert.strictEqual(r.ok, true, r.detail);
});
check('runAll: 3 checks, all green in claude-tpm', () => {
  const results = doctor.runAll(doctor.BUNDLE);
  assert.strictEqual(results.length, 3);
  const failed = results.filter(([, r]) => !r.ok);
  assert.strictEqual(failed.length, 0, `failed: ${failed.map(([n]) => n).join(', ')}`);
});
check('checkCompose: composed prompt carries the bare `tpm resolve-home` anchor (doctor accepts it)', () => {
  const r = doctor.checkCompose();
  assert.strictEqual(r.ok, true, r.detail + ' ' + (r.fix || ''));
  assert.ok(/resolve-home anchor/.test(r.detail), r.detail);
});
check('checkSignoffWritable: probes <root>/tpm-tmp/tpm-signoff (#1183), not the legacy tmp/ store', () => {
  const fs = require('fs'); const os = require('os'); const path = require('path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor signoff ')); // space in the path on purpose
  try {
    const r = doctor.checkSignoffWritable(root);
    assert.strictEqual(r.ok, true, r.detail);
    assert.ok(/tpm-tmp\/tpm-signoff/.test(r.detail), r.detail);
    assert.ok(fs.existsSync(path.join(root, 'tpm-tmp', 'tpm-signoff')), 'store dir created at tpm-tmp/tpm-signoff');
    assert.ok(!fs.existsSync(path.join(root, 'tmp')), 'no legacy tmp/ created');
    assert.ok(!fs.existsSync(path.join(root, 'tpm-tmp', 'tpm-signoff', '.doctor-probe')), 'probe cleaned up');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
check('every FAIL result carries a fix (fail-loud contract)', () => {
  const r = doctor.checkSignoffWritable('/dev/null'); // mkdir under a non-directory → guaranteed FAIL
  assert.strictEqual(r.ok, false);
  assert.ok(typeof r.fix === 'string' && r.fix.length > 0);
});

process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
