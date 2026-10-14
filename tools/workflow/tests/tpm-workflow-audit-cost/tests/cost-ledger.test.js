#!/usr/bin/env node
/**
 * cost-ledger.test.js — self-contained tests for tools/cost-ledger.js (v2).
 *
 * PURPOSE. Prove the Definition-of-Done rows for the epic-aware cost ledger
 * against SCRATCH trees under os.tmpdir() — no real dev/ tree is touched.
 *
 * GUARDS.
 *   - legacy flat append -> <dir>/tmp/cost-ledger.md + --summary total
 *   - token parsing (715k / 1.2m / plain) sums correctly
 *   - --epic-path writes/reads <epic>/00-epic-plan/cost-ledger.md (NOT tmp/)
 *   - --rollup sums tokens/calls across phase ledgers + epic ledger, with a
 *     per-phase breakdown + epic grand total
 *   - mutually-exclusive target guard (exit 2), --help exit 0
 *
 * HOW TO RUN.  node tests/cost-ledger.test.js     (exit 0 = all pass)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDefaults } = require('../../../tpm-workflow-config-resolver.js');
const FOLDERS = getDefaults().folders; // #1183: derive expected names from the shipped defaults
const { mkScratch } = require('../../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

// The CANONICAL promoted tool — this suite runs against the shipped tool, not a checked-in copy.
const TOOL = path.join(__dirname, '..', '..', '..', 'tpm-workflow-cost-ledger.js');
let PASS = 0, FAIL = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) { PASS++; } else { FAIL++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function mkscratch() { return mkScratch('ledger-test'); }

/** Run the tool; return {status, stdout, stderr}. Never throws on non-zero. */
function run(args) {
  let status = 0, stdout = '', stderr = '';
  try { stdout = execFileSync('node', [TOOL, ...args], { encoding: 'utf8' }); }
  catch (e) {
    status = e.status === undefined ? 1 : e.status;
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
  }
  return { status, stdout, stderr };
}

// ===========================================================================
// TEST 1 — flat append -> <dir>/tmp/cost-ledger.md + summary total
// ===========================================================================
(function testFlatAppend() {
  console.log('TEST 1: flat append + summary');
  const dir = mkscratch();
  run(['--dir', dir, '--agent', 'w1', '--role', 'worker', '--model', 'opus',
    '--tokens', '715k', '--calls', '198', '--verdict', 'ACCEPT', '--round', 'phase B']);
  run(['--dir', dir, '--agent', 'v1', '--role', 'verifier', '--model', 'sonnet',
    '--tokens', '1.2m', '--calls', '40', '--verdict', 'PASS']);
  const ledger = path.join(dir, FOLDERS.tmp, 'cost-ledger.md');
  ok(fs.existsSync(ledger), 'ledger written to <dir>/<folders.tmp>/cost-ledger.md');
  const body = fs.readFileSync(ledger, 'utf8');
  ok(/\| w1 \|/.test(body) && /\| v1 \|/.test(body), 'both rows present');

  const s = run(['--dir', dir, '--summary']);
  ok(s.status === 0, `summary exits 0 (got ${s.status})`);
  ok(/2 subagent/.test(s.stdout), 'summary counts 2 subagents');
  // 715k + 1.2m = 1,915,000
  ok(/1,915,000/.test(s.stdout), 'summary sums tokens (715k + 1.2m = 1,915,000)');
  ok(/238/.test(s.stdout), 'summary sums calls (198 + 40 = 238)');
})();

// ===========================================================================
// TEST 2 — --epic-path writes/reads <epic>/00-epic-plan/cost-ledger.md (NOT tmp/)
// ===========================================================================
(function testEpicPath() {
  console.log('TEST 2: --epic-path targets 00-epic-plan/');
  const epic = mkscratch();
  run(['--epic-path', epic, '--agent', 'orch', '--role', 'orchestrator',
    '--tokens', '40k', '--calls', '12', '--round', 'epic bookkeeping']);
  const epicLedger = path.join(epic, '00-epic-plan', 'cost-ledger.md');
  const wrongTmp = path.join(epic, FOLDERS.tmp, 'cost-ledger.md');
  ok(fs.existsSync(epicLedger), 'epic ledger at <epic>/00-epic-plan/cost-ledger.md');
  ok(!fs.existsSync(wrongTmp), 'epic ledger NOT written to <epic>/tmp/');
  const s = run(['--epic-path', epic, '--summary']);
  ok(/40,000/.test(s.stdout), 'epic-path summary reads the epic ledger');
})();

// ===========================================================================
// TEST 3 — --rollup aggregates phase ledgers + epic ledger
// ===========================================================================
(function testRollup() {
  console.log('TEST 3: --rollup');
  const epic = mkscratch();
  // epic-level ledger (orchestrator bookkeeping)
  run(['--epic-path', epic, '--agent', 'orch', '--tokens', '40k', '--calls', '10', '--round', 'bookkeeping']);
  // phase 01 ledger: two subagents
  const p01 = path.join(epic, '01-planning');
  run(['--dir', p01, '--agent', 'w1', '--model', 'opus', '--tokens', '100k', '--calls', '50']);
  run(['--dir', p01, '--agent', 'v1', '--model', 'sonnet', '--tokens', '60k', '--calls', '20']);
  // phase 02b ledger (letter-suffixed): one subagent
  const p02b = path.join(epic, '02b-build');
  run(['--dir', p02b, '--agent', 'w2', '--model', 'opus', '--tokens', '200k', '--calls', '80']);
  // a non-phase folder that must be ignored
  fs.mkdirSync(path.join(epic, 'notes'), { recursive: true });

  const r = run(['--rollup', epic]);
  ok(r.status === 0, `rollup exits 0 (got ${r.status})`);
  ok(/Per-phase breakdown/.test(r.stdout), 'rollup prints per-phase breakdown');
  ok(/00-epic-plan:/.test(r.stdout), 'rollup includes the epic-level ledger');
  ok(/01-planning: 2 subagent/.test(r.stdout), 'rollup shows phase 01 with 2 subagents');
  ok(/02b-build: 1 subagent/.test(r.stdout), 'rollup shows letter-suffixed phase 02b');
  // grand total tokens: 40k + 100k + 60k + 200k = 400,000
  ok(/EPIC TOTAL: 4 subagent/.test(r.stdout), 'rollup counts 4 subagents total');
  ok(/400,000/.test(r.stdout), 'rollup sums tokens to 400,000');
  // grand total calls: 10 + 50 + 20 + 80 = 160
  ok(/160/.test(r.stdout), 'rollup sums calls to 160');
})();

// ===========================================================================
// TEST 4 — guards: mutually-exclusive targets, no target, --help
// ===========================================================================
(function testGuards() {
  console.log('TEST 4: guards');
  const noTarget = run(['--agent', 'x', '--tokens', '10k']);
  ok(noTarget.status === 2, `no target exits 2 (got ${noTarget.status})`);

  const both = run(['--dir', '/tmp/x', '--epic-path', '/tmp/y', '--summary']);
  ok(both.status === 2, `--dir + --epic-path exits 2 (got ${both.status})`);

  const help = run(['--help']);
  ok(help.status === 0, `--help exits 0 (got ${help.status})`);
  ok(/tpm workflow cost/.test(help.stdout), '--help prints usage');
})();

// ===========================================================================
// TEST-HARDENING ROUND (28) — cell() pipe-escape (fable-3 #5). A --note / --agent
// carrying a literal `|` must be backslash-escaped so it can't inject an extra
// markdown-table column and corrupt the ledger. Nothing pinned this before; the
// assertion below is the pin. (The external mutation-check28 harness was retired.)
// ===========================================================================
(function testPipeEscape() {
  console.log('TEST 5: cell() pipe-escape');
  const dir = mkscratch();
  run(['--dir', dir, '--agent', 'w|x', '--role', 'worker', '--model', 'opus',
    '--tokens', '10k', '--calls', '5', '--note', 'a|b|c']);
  const ledger = path.join(dir, FOLDERS.tmp, 'cost-ledger.md');
  const body = fs.readFileSync(ledger, 'utf8');
  // The note pipes are backslash-escaped in the emitted row (a\|b\|c), NOT raw.
  ok(/a\\\|b\\\|c/.test(body), 'note pipes are backslash-escaped (a\\|b\\|c), not raw');
  ok(/w\\\|x/.test(body), 'agent pipe is backslash-escaped too (w\\|x)');
  // Decisive: the RAW unescaped sequence must NOT appear anywhere in a cell.
  ok(!/[^\\]a\|b\|c/.test(body) && !/^a\|b\|c/m.test(body), 'the raw unescaped a|b|c never appears');
})();

// ===========================================================================
console.log('');
if (FAIL === 0) { console.log(`cost-ledger.test.js: ALL ${PASS} assertions passed.`); process.exit(0); }
console.error(`cost-ledger.test.js: ${FAIL} FAILED, ${PASS} passed.`);
for (const f of fails) console.error('  - ' + f);
process.exit(1);
