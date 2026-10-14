#!/usr/bin/env node
/**
 * audit.test.js — self-contained tests for tools/audit.js (v2, epic-aware).
 *
 * PURPOSE. Prove every Definition-of-Done row for the epic-aware audit against
 * SCRATCH `dev/` trees built under os.tmpdir() — the real dev/ tree is never
 * touched.
 *
 * GUARDS.
 *   - epic vs flat classification
 *   - numbering integrity (duplicate NN / malformed; monotonic-with-gaps passes)
 *   - one-plan-one-charter per phase (0 or 2+ plans; missing charter)
 *   - 00-epic-plan charter-cleanliness (posture-marker leak flagged; word
 *     "charter" used legitimately does NOT trip it)
 *   - legacy flat-task checks preserved (scratch-in-findings, stray-at-root)
 *   - --strict exit code (0 clean / 3 dirty), --help exit 0
 *
 * HOW TO RUN.  node tests/audit.test.js     (exit 0 = all pass)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getDefaults } = require('../../../tpm-workflow-config-resolver.js');
const FOLDERS = getDefaults().folders; // #1183: derive expected names from the shipped defaults
const { mkScratch } = require('../../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

// The CANONICAL promoted tool (tools/workflow/tpm-workflow-audit.js) — this suite runs against the
// shipped tool, not a checked-in copy (which used to drift). __dirname = tests/<phase>/tests.
const TOOL = path.join(__dirname, '..', '..', '..', 'tpm-workflow-audit.js');
let PASS = 0, FAIL = 0;
const fails = [];

function ok(cond, msg) {
  if (cond) { PASS++; }
  else { FAIL++; fails.push(msg); console.error('  ✗ ' + msg); }
}

function mkscratch() {
  return mkScratch('audit-test');
}
function write(p, s) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); }
function mkdir(p) { fs.mkdirSync(p, { recursive: true }); }

/** Run audit; return {status, stdout, stderr, report}. Never throws on non-zero. */
function runAudit(root, extra = []) {
  const out = path.join(root, '_out.md');
  let status = 0, stdout = '', stderr = '';
  try {
    stdout = execFileSync('node', [TOOL, '--out', out, '--tasks-root', root, ...extra],
      { encoding: 'utf8' });
  } catch (e) {
    status = e.status === undefined ? 1 : e.status;
    stdout = (e.stdout || '').toString();
    stderr = (e.stderr || '').toString();
  }
  const report = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  return { status, stdout, stderr, report };
}

// A minimal clean phase folder.
function cleanPhase(root, name, charters = ['charter-builder.md']) {
  const d = path.join(root, name);
  write(path.join(d, 'plan.md'), '# Plan\n');
  for (const c of charters) write(path.join(d, c), '# Charter\n');
  mkdir(path.join(d, FOLDERS.findings));
}
// A clean 00-epic-plan (uses the word "charter" legitimately — must NOT trip).
function cleanEpicPlan(root) {
  write(path.join(root, '00-epic-plan', 'epic-plan.md'),
    '# Epic Plan\n\nCharters staged in tmp/. Each phase gets exactly one charter.\n' +
    '- 02 — build tools (charter-as-sibling).\n');
  write(path.join(root, '00-epic-plan', 'punchlist.md'), '# Punchlist\n- [x] done\n');
  write(path.join(root, '00-epic-plan', 'decisions.md'), '# Decisions\n');
}

// ===========================================================================
// TEST 1 — clean epic + clean flat task: classified correctly, zero violations
// ===========================================================================
(function testCleanClassification() {
  console.log('TEST 1: clean epic + flat task classification');
  const root = mkscratch();
  const epic = path.join(root, 'my-epic');
  cleanEpicPlan(epic);
  cleanPhase(epic, '01-planning');
  cleanPhase(epic, '02-build-a', ['charter-builder.md', 'charter-verifier.md']); // multi-charter OK
  cleanPhase(epic, '02b-build-b'); // letter-suffixed number is valid
  cleanPhase(epic, '04-verify');   // gap (03 skipped) is OK
  // a flat task sibling
  const flat = path.join(root, 'flat-task');
  write(path.join(flat, 'plan.md'), '# Plan\n');
  mkdir(path.join(flat, FOLDERS.findings));

  const r = runAudit(root, ['--strict']);
  ok(r.status === 0, `clean tree --strict should exit 0, got ${r.status} (stderr: ${r.stderr})`);
  ok(/classified: \*\*EPIC\*\*/.test(r.report), 'epic classified as EPIC');
  ok(/classified: \*\*flat task\*\*/.test(r.report), 'flat task classified as flat');
  ok(/Epic\/phase violations flagged: 0/.test(r.report), 'zero violations on clean tree');
  ok(!/❌ FLAG:/.test(r.report), 'no FLAG lines on clean tree');
  ok(/`02b-build-b`/.test(r.report), 'letter-suffixed phase 02b listed');
})();

// ===========================================================================
// TEST 2 — numbering integrity: duplicate token + malformed folder flagged
// ===========================================================================
(function testNumbering() {
  console.log('TEST 2: numbering integrity');
  const root = mkscratch();
  const epic = path.join(root, 'dup-epic');
  cleanEpicPlan(epic);
  cleanPhase(epic, '01-a');
  cleanPhase(epic, '03-first');   // token 03
  cleanPhase(epic, '03-second');  // token 03 again -> DUPLICATE
  cleanPhase(epic, 'phase-x');    // no NN- prefix -> MALFORMED

  const r = runAudit(root, ['--strict']);
  ok(r.status === 3, `dirty numbering --strict should exit 3, got ${r.status}`);
  ok(/duplicate phase number `03`/.test(r.report), 'duplicate token 03 flagged');
  ok(/malformed phase folder.*phase-x/.test(r.report), 'malformed folder phase-x flagged');
})();

// ===========================================================================
// TEST 3 — one-plan-one-charter per phase
// ===========================================================================
(function testPlanCharter() {
  console.log('TEST 3: one-plan-one-charter');
  const root = mkscratch();
  const epic = path.join(root, 'pc-epic');
  cleanEpicPlan(epic);
  // 01: no charter
  const p1 = path.join(epic, '01-nocharter');
  write(path.join(p1, 'plan.md'), '# Plan\n');
  // 02: two plans
  const p2 = path.join(epic, '02-twoplans');
  write(path.join(p2, 'plan.md'), '# Plan\n');
  write(path.join(p2, 'plan-v2.md'), '# Plan v2\n');
  write(path.join(p2, 'charter-builder.md'), '# Charter\n');
  // 03: no plan
  const p3 = path.join(epic, '03-noplan');
  write(path.join(p3, 'charter-builder.md'), '# Charter\n');
  // 04: clean (control — must NOT be flagged)
  cleanPhase(epic, '04-clean');

  const r = runAudit(root, ['--strict']);
  ok(r.status === 3, `dirty plan/charter --strict should exit 3, got ${r.status}`);
  ok(/phase `01-nocharter` has NO charter/.test(r.report), 'missing charter flagged');
  ok(/phase `02-twoplans` has 2\+ plan files/.test(r.report), '2+ plans flagged');
  ok(/phase `03-noplan` has NO plan.md/.test(r.report), 'missing plan flagged');
  ok(!/phase `04-clean` has/.test(r.report), 'clean phase not flagged');
})();

// ===========================================================================
// TEST 4 — 00-epic-plan charter-cleanliness
// ===========================================================================
(function testCharterClean() {
  console.log('TEST 4: 00-epic-plan charter-cleanliness');
  // 4a: leak — a posture marker pasted into the epic plan
  const rootBad = mkscratch();
  const epicBad = path.join(rootBad, 'leak-epic');
  write(path.join(epicBad, '00-epic-plan', 'epic-plan.md'),
    '# Epic Plan\n\n## The one rule\n\nYou do not stop until done.\n');
  write(path.join(epicBad, '00-epic-plan', 'notes.md'),
    'orchestrator picks. <!-- ORCHESTRATOR NOTE: phase 04 is a verify round -->\n');
  cleanPhase(epicBad, '01-a');
  const rb = runAudit(rootBad, ['--strict']);
  ok(rb.status === 3, `leak --strict should exit 3, got ${rb.status}`);
  ok(/charter\/posture leak.*epic-plan\.md/.test(rb.report), 'The-one-rule leak flagged');
  ok(/charter\/posture leak.*notes\.md/.test(rb.report), 'ORCHESTRATOR NOTE leak flagged');

  // 4b: clean — the WORD "charter" used legitimately must NOT trip the check
  const rootOk = mkscratch();
  const epicOk = path.join(rootOk, 'clean-epic');
  cleanEpicPlan(epicOk);   // mentions "charter" several times, no posture markers
  cleanPhase(epicOk, '01-a');
  const ro = runAudit(rootOk, ['--strict']);
  ok(ro.status === 0, `legit "charter" wording should NOT trip cleanliness (exit ${ro.status})`);
  ok(/charter-cleanliness: ✓ clean/.test(ro.report), 'clean epic-plan reported clean');
})();

// ===========================================================================
// TEST 5 — legacy flat-task checks preserved
// ===========================================================================
(function testLegacyFlat() {
  console.log('TEST 5: legacy flat-task checks preserved');
  const root = mkscratch();
  const flat = path.join(root, 'legacy-task');
  write(path.join(flat, 'plan.md'), '# Plan\n');
  mkdir(path.join(flat, FOLDERS.findings));
  mkdir(path.join(flat, FOLDERS.findings, FOLDERS.tmp));        // scratch under findings/ -> drift
  write(path.join(flat, 'stray-note.md'), 'x');     // stray md at task root
  write(path.join(flat, FOLDERS.findings, '01-result.md'), 'ok'); // legit findings file (not flagged)

  const r = runAudit(root);
  ok(r.status === 0, `legacy audit runs (exit ${r.status})`);
  ok(/scratch dirs inside findings/.test(r.report), 'scratch-in-findings drift reported');
  ok(/stray at task root/.test(r.report) && /stray-note\.md/.test(r.report), 'stray root file reported');
  ok(/classified: \*\*flat task\*\*/.test(r.report), 'classified flat');
})();

// ===========================================================================
// TEST 6 — --help exits 0
// ===========================================================================
(function testHelp() {
  console.log('TEST 6: --help');
  let status = 0, stdout = '';
  try { stdout = execFileSync('node', [TOOL, '--help'], { encoding: 'utf8' }); }
  catch (e) { status = e.status; }
  ok(status === 0, `--help exits 0 (got ${status})`);
  ok(/usage: tpm workflow audit/.test(stdout), '--help prints usage');
})();

// ===========================================================================
// TEST-HARDENING ROUND (28) — two guard-neutering mutants the canonical suite
// left GREEN (fable-3 #5): the `# Charter —` posture marker (1 of 3 cleanliness
// markers; TEST 4 exercises only the other two) and the EPIC-phase
// scratch-in-findings flag (TEST 5 covers FLAT only). (The external
// mutation-check28 harness that proved these was retired; the assertions remain.)
// ===========================================================================

// TEST 7 — 00-epic-plan cleanliness: a pasted `# Charter —` HEADING leaks
(function testCharterHeadingLeak() {
  console.log('TEST 7: `# Charter —` heading leak in 00-epic-plan');
  const root = mkscratch();
  const epic = path.join(root, 'charterhdg-epic');
  // epic-plan.md clean; the leak is a SEPARATE pasted charter heading (marker #3),
  // NOT "## The one rule" (marker #1) or "<!-- ORCHESTRATOR NOTE" (marker #2).
  write(path.join(epic, '00-epic-plan', 'epic-plan.md'), '# Epic Plan\n\nGoal here.\n');
  write(path.join(epic, '00-epic-plan', 'stray-charter.md'),
    '# Charter — builder\n\nSHIP IT. Do not stop until done.\n');
  cleanPhase(epic, '01-a');
  const r = runAudit(root, ['--strict']);
  ok(r.status === 3, `# Charter — heading leak --strict should exit 3, got ${r.status}`);
  ok(/charter\/posture leak.*stray-charter\.md/.test(r.report), '`# Charter —` heading leak flagged');
  ok(/pasted charter heading/.test(r.report), '... names the pasted-charter-heading marker specifically');
})();

// TEST 8 — EPIC-phase scratch-in-findings (distinct from the FLAT case in TEST 5)
(function testEpicPhaseScratchInFindings() {
  console.log('TEST 8: EPIC-phase scratch-in-findings');
  const root = mkscratch();
  const epic = path.join(root, 'scratch-epic');
  cleanEpicPlan(epic);
  // a well-formed epic phase (plan + charter) BUT with a scratch dir under findings/.
  const p = path.join(epic, '01-drift');
  write(path.join(p, 'plan.md'), '# Plan\n');
  write(path.join(p, 'charter-builder.md'), '# Charter\n');
  mkdir(path.join(p, FOLDERS.findings, FOLDERS.tmp)); // scratch under findings/ -> drift
  const r = runAudit(root, ['--strict']);
  ok(r.status === 3, `epic-phase findings-scratch --strict should exit 3, got ${r.status}`);
  ok(/phase `01-drift` has scratch dir\(s\) inside findings\//.test(r.report),
    'epic-phase scratch-in-findings flagged');
  // control: the same epic phase WITHOUT the scratch dir is clean (exit 0).
  const root2 = mkscratch();
  const epic2 = path.join(root2, 'clean-scratch-epic');
  cleanEpicPlan(epic2);
  cleanPhase(epic2, '01-drift');
  const r2 = runAudit(root2, ['--strict']);
  ok(r2.status === 0, `clean epic phase (no findings-scratch) should exit 0, got ${r2.status}`);
})();

// ===========================================================================
console.log('');
if (FAIL === 0) { console.log(`audit.test.js: ALL ${PASS} assertions passed.`); process.exit(0); }
console.error(`audit.test.js: ${FAIL} FAILED, ${PASS} passed.`);
for (const f of fails) console.error('  - ' + f);
process.exit(1);
