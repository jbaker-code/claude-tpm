#!/usr/bin/env node
/**
 * lint.test.js - self-contained tests for lint-subagent-prompt.js (v2).
 *
 * Covers every DoD row for the linter:
 *   - keeps the legacy manifest/reading-chain + env-ritual + working-folder checks
 *   - flags a surviving FILL sentinel  ({{PLACEHOLDER}})            -> exit 1
 *   - flags an un-stripped STRIP sentinel (<!-- ORCHESTRATOR NOTE -->) -> exit 1
 *   - flags a missing REQUIRED sentinel (<!-- required: X -->)      -> exit 1
 *   - flags a BLOCKED filename (via check-filename)                 -> exit 1
 *   - passes a CLEAN file (filled, stripped, required-present)      -> exit 0
 *   - charter-file-present + config-gated + --help                  (extras)
 *   - per-persona role flags --test-writer / --documentarian /
 *     --bug-fixer: a compliant prompt PASSes, dropping a required block
 *     read FAILs naming it, and the same prompt without the flag PASSes
 *     (block is flag-gated, like --verifier)                        -> DoD 15
 *   - MUTATION: dropping a read from the manifest block removes the
 *     requirement (proves the enforced chain is manifest-derived)   -> DoD 15
 *
 * PLUS the 23-tighten-lint fable-review fixes (negative-path coverage):
 *   - FIX#1 charter-file-present FAILs a PLACEHOLDER charter ({{CHARTER_BODY}}
 *     fill-marker / "(placeholder)" header); a real charter still passes.
 *   - FIX#6 charter-no-strip-sentinel FAILs a leaked <!-- Orchestrator note -->
 *     in the named charter, matched CASE-INSENSITIVELY (backstop for the
 *     scaffolder's case-sensitive strip).
 *   - FIX#2 verifier-hard-rule keys off the CURRENT doctrine (HARD RULE +
 *     verdict-not-repair); the retired "never touch the live system" framing
 *     no longer satisfies it.
 *   - FIX#4 a --bug-fixer prompt must NAME its verdict (verifier-r<N>-v<M>-
 *     verdict.md, or a --verdict path); check is flag-gated.
 *   - FIX#8 an explicit nonexistent --manifest EXITS 2 (fail loud).
 * Each guard's load-bearing-ness is separately proved in the sibling
 * mutation-check.js (mutate the guard -> the catch disappears).
 *
 * HOW TO RUN:  node tests/lint-subagent-prompt/test.js   (exit 0 = all pass)
 *              node tests/lint-subagent-prompt/mutation-check.js  (the mutation proofs)
 * Scratch fixtures are written under <bundle>/tmp/scratch/<run-slug>/ (shared helper; never findings/).
 */

'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { mkScratch } = require('../../../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

// This test lives at <phase-root>/tests/lint-subagent-prompt/test.js, so the
// phase root is two levels up (per the per-suite tests/<tool>/test.js layout).
const ROOT = path.resolve(__dirname, '..', '..');
// Canonical promoted tool at tools/workflow/ (two levels up from this phase dir) — run against the
// SHIPPED tool, not a checked-in copy.
const CANON = path.resolve(ROOT, '..', '..');
const LINT = path.join(CANON, 'tpm-workflow-lint-subagent-prompt.js');
const SCRATCH = mkScratch('lint'); // <bundle>/tmp/scratch/<run-slug>/lint-XXXXXX (created)

let passed = 0;
let failed = 0;
function check(desc, cond, extra) {
  if (cond) { passed++; console.log(`  ok   ${desc}`); }
  else { failed++; console.log(`  FAIL ${desc}${extra ? '\n       ' + extra : ''}`); }
}

/** Run the linter; return { code, stdout, stderr }. Never throws on nonzero. */
function runLint(args, opts) {
  try {
    const stdout = execFileSync('node', [LINT, ...args], {
      encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], input: (opts && opts.input) || '',
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: (e.stdout || '').toString(), stderr: (e.stderr || '').toString() };
  }
}

function write(name, body) {
  const p = path.join(SCRATCH, name);
  fs.writeFileSync(p, body);
  return p;
}

// A minimal manifest fixture so the legacy doc-chain checks have something to
// parse (proves DoD row 1: v2 keeps the manifest-driven reading-chain checks).
const manifestPath = write('reading-list.md', [
  '# subagent reading list (fixture)',
  '<!-- lint:begin base -->',
  '- `subagent/handbook.md` — the worker handbook.',
  '<!-- lint:end -->',
  '<!-- lint:begin working-folder -->',
  '- `project-workspace.md` — the write-boundary + folder layout.',
  '<!-- lint:end -->',
  '<!-- lint:begin test-writer -->',
  '- `tool-conventions.md` — the ship-tool tests bar.',
  '- `HANDOFF.md` — the artifact under test.',
  '<!-- lint:end -->',
  '<!-- lint:begin documentarian -->',
  '- `tool-conventions.md` — the <tool>.md bar.',
  '- `HANDOFF.md` — the artifact to document.',
  '<!-- lint:end -->',
  '<!-- lint:begin bug-fixer -->',
  '- `verification.md` — the verifier verdict + reproducibility bar.',
  '- `HANDOFF.md` — the artifact under fix.',
  '<!-- lint:end -->',
].join('\n'));

// A charter file on disk for the charter-file-present check.
write('charter-builder.md', '# Charter\nDo it well.\n');

// A config for the config-gated check.
const cfgPath = write('config.json', JSON.stringify({ workflow: { deliverables: { wiki: false } } }));

console.log('lint-subagent-prompt.js (v2) tests\n');

// ---------------------------------------------------------------------------
// DoD row 1 — legacy manifest/reading-chain + env-ritual + working-folder checks
// still run. A full, valid spawn prompt (with those directives) passes.
// ---------------------------------------------------------------------------
const cleanPrompt = [
  'You are a BUILDER subagent for the demo epic.',
  '',
  'Working folder: `dev/demo/01-thing/`',
  '',
  'Step zero: cd to the project root, then `set -a && source dev/demo/01-thing/tmp/subagent.env && set +a`.',
  '',
  'Read, in order:',
  '1. Your charter: `charter-builder.md`.',
  '2. subagent handbook.',
  '3. project workspace (the working folder layout).',
  '',
  '<!-- required: charter -->',
  '',
  'Do the task. Return a one-paragraph summary.',
].join('\n');
const cleanPromptPath = write('clean-prompt.md', cleanPrompt);

let r = runLint(['--file', cleanPromptPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--verbose']);
check('CLEAN full spawn prompt passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}\n${r.stderr}`);
check('  ... and the manifest doc-chain checks actually ran (step-zero-handbook seen)',
  /step-zero-handbook/.test(r.stdout), r.stdout);
check('  ... and env-source-ritual check ran', /env-source-ritual/.test(r.stdout), r.stdout);
check('  ... and working-folder check ran', /working-folder-mentioned/.test(r.stdout), r.stdout);

// Prove the manifest checks FAIL when a required read is missing (chain is live).
const missingReadPrompt = cleanPrompt.replace('3. project workspace (the working folder layout).', '3. (nothing)');
const missingReadPath = write('missing-read.md', missingReadPrompt);
r = runLint(['--file', missingReadPath, '--manifest', manifestPath, '--charter-dir', SCRATCH]);
check('Missing a manifest-listed read fails (exit 1) — chain is enforced', r.code === 1, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// DoD row 2 — surviving FILL sentinel {{PLACEHOLDER}} -> error + nonzero exit
// ---------------------------------------------------------------------------
const fillDirty = write('fill-dirty.md', '# Plan\nScope: {{MOTIVATION}}\n<!-- required: charter -->\n');
r = runLint(['--file', fillDirty, '--sentinels-only', '--require', 'charter']);
check('Surviving FILL sentinel fails (exit 1)', r.code === 1, `code=${r.code}\n${r.stdout}`);
check('  ... names the fill-sentinel check + the placeholder', /fill-sentinel/.test(r.stdout) && /MOTIVATION/.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
// DoD row 3 — un-stripped STRIP sentinel <!-- ORCHESTRATOR NOTE ... --> -> error
// ---------------------------------------------------------------------------
const stripDirty = write('strip-dirty.md', '# Plan\n<!-- ORCHESTRATOR NOTE: fill DoD before spawn -->\nDo the thing.\n<!-- required: charter -->\n');
r = runLint(['--file', stripDirty, '--sentinels-only', '--require', 'charter']);
check('Un-stripped STRIP sentinel fails (exit 1)', r.code === 1, `code=${r.code}\n${r.stdout}`);
check('  ... names the strip-sentinel check', /strip-sentinel/.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
// DoD row 4 — missing REQUIRED sentinel <!-- required: X --> -> error
// ---------------------------------------------------------------------------
const reqMissing = write('req-missing.md', '# Plan\nAll filled, nothing to strip.\n');
r = runLint(['--file', reqMissing, '--sentinels-only', '--require', 'charter']);
check('Missing REQUIRED sentinel fails (exit 1)', r.code === 1, `code=${r.code}\n${r.stdout}`);
check('  ... names the required-sentinel check for "charter"', /required-sentinel-charter/.test(r.stdout), r.stdout);

// ---------------------------------------------------------------------------
// DoD row 5 — BLOCKED filename (via check-filename) -> error
// ---------------------------------------------------------------------------
r = runLint(['--sentinels-only', '--filename', 'my-findings.md']);
check('BLOCKED filename fails (exit 1)', r.code === 1, `code=${r.code}\n${r.stdout}`);
check('  ... names the blocked-filename check + pattern', /blocked-filename/.test(r.stdout) && /findings/.test(r.stdout), r.stdout);
// A clean filename passes.
r = runLint(['--sentinels-only', '--filename', 'plan.md']);
check('Clean filename passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// DoD row 6 — CLEAN file (filled, stripped, required-present) -> OK exit 0
// ---------------------------------------------------------------------------
const cleanPlan = write('clean-plan.md', '# Plan\nScope: build the thing.\nDoD: table here.\n<!-- required: charter -->\n');
r = runLint(['--file', cleanPlan, '--sentinels-only', '--require', 'charter']);
check('CLEAN plan (sentinels-only) passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}\n${r.stderr}`);

// ---------------------------------------------------------------------------
// Extra — charter-file-present: named-but-missing charter fails; present passes.
// ---------------------------------------------------------------------------
const namesMissingCharter = write('names-missing-charter.md', 'Read `charter-nonexistent.md`.\n<!-- required: charter -->\n');
r = runLint(['--file', namesMissingCharter, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('Named-but-missing charter file fails (exit 1)', r.code === 1 && /charter-file-present/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

const namesPresentCharter = write('names-present-charter.md', 'Read `charter-builder.md`.\n<!-- required: charter -->\n');
r = runLint(['--file', namesPresentCharter, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('Named-and-present charter file passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// Extra — config-gated: flag=false but marker present -> drift (exit 1).
// ---------------------------------------------------------------------------
const gatedDirty = write('gated-dirty.md', '# Plan\n## Wiki deliverable\nsome wiki content\n<!-- required: charter -->\n');
r = runLint(['--file', gatedDirty, '--sentinels-only', '--require', 'charter', '--config', cfgPath, '--config-gate', 'workflow.deliverables.wiki=## Wiki deliverable']);
check('Config-gated drift (flag false, marker present) fails (exit 1)', r.code === 1 && /config-gate/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
// Flag false + marker absent -> matches -> pass.
const gatedClean = write('gated-clean.md', '# Plan\nno wiki here\n<!-- required: charter -->\n');
r = runLint(['--file', gatedClean, '--sentinels-only', '--require', 'charter', '--config', cfgPath, '--config-gate', 'workflow.deliverables.wiki=## Wiki deliverable']);
check('Config-gated match (flag false, marker absent) passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// DoD (15-lint-reading-list) — per-persona role flags: --test-writer /
// --documentarian / --bug-fixer each require their manifest block's reads.
// A compliant persona prompt PASSes; dropping a required read FAILs, naming it.
// The requirement is DERIVED from the manifest block (mutate the manifest ->
// requirement disappears), so the documented chain and enforced chain can't drift.
// ---------------------------------------------------------------------------

// Charter files on disk for each persona (charter-file-present check).
write('charter-test-writer.md', '# Charter\nWrite real tests.\n');
write('charter-documentarian.md', '# Charter\nDocument it.\n');
write('charter-bug-fixer.md', '# Charter\nFix the reported findings.\n');

// Build a valid persona spawn prompt that names the given step-zero reads. Omit a
// read by leaving it out of `reads` to produce the "bad" (non-compliant) variant.
function personaPrompt({ role, charter, folder, reads, extra }) {
  return [
    `You are a ${role.toUpperCase()} subagent for the demo epic.`,
    '',
    `Working folder: \`dev/demo/${folder}/\``,
    '',
    `Step zero: cd to the project root, then \`set -a && source dev/demo/${folder}/tmp/subagent.env && set +a\`.`,
    '',
    'Read, in order:',
    `1. Your charter: \`${charter}\`.`,
    ...reads.map((d, i) => `${i + 2}. \`${d}\` — a required read.`),
    ...(extra || []),
    '',
    '<!-- required: charter -->',
    '',
    'Do the task. Return a one-paragraph summary.',
  ].join('\n');
}

// The per-persona block reads a compliant prompt must carry (base + working-folder
// + the persona block), matching the fixture manifest above.
const BASE_READS = ['shared-conventions.md', 'subagent/handbook.md', 'project-workspace.md', 'plan.md'];
const PERSONAS = [
  { flag: '--test-writer',   role: 'test-writer',   charter: 'charter-test-writer.md',   folder: '02-tests',
    blockReads: ['tool-conventions.md', 'HANDOFF.md'], dropForBad: 'tool-conventions.md', badCheck: /test-writer-tool-conventions/ },
  { flag: '--documentarian', role: 'documentarian', charter: 'charter-documentarian.md', folder: '03-docs',
    blockReads: ['tool-conventions.md', 'HANDOFF.md'], dropForBad: 'tool-conventions.md', badCheck: /documentarian-tool-conventions/ },
  // bug-fixer prompts must also NAME the verdict they fix (fix #4), else the new
  // bug-fixer-names-verdict structural check FAILs them — give both variants one.
  { flag: '--bug-fixer',     role: 'bug-fixer',     charter: 'charter-bug-fixer.md',     folder: '04-fix',
    blockReads: ['verification.md', 'HANDOFF.md'], dropForBad: 'verification.md', badCheck: /verification-if-shipping-or-verifier/,
    extra: ['Read the verifier verdict `verifier-r1-v1-verdict.md` — fix EXACTLY its findings.'] },
];

for (const p of PERSONAS) {
  const goodReads = [...BASE_READS, ...p.blockReads];
  const goodPath = write(`${p.role}-good.md`, personaPrompt({ role: p.role, charter: p.charter, folder: p.folder, reads: goodReads, extra: p.extra }));
  r = runLint(['--file', goodPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', p.flag]);
  check(`${p.flag} compliant persona prompt passes (exit 0)`, r.code === 0, `code=${r.code}\n${r.stdout}\n${r.stderr}`);

  // Bad: drop one required block read -> must FAIL naming the missing directive.
  const badReads = goodReads.filter(d => d !== p.dropForBad);
  const badPath = write(`${p.role}-bad.md`, personaPrompt({ role: p.role, charter: p.charter, folder: p.folder, reads: badReads, extra: p.extra }));
  r = runLint(['--file', badPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', p.flag]);
  check(`${p.flag} non-compliant prompt (dropped ${p.dropForBad}) fails (exit 1)`, r.code === 1, `code=${r.code}\n${r.stdout}`);
  check(`  ... and names the missing ${p.dropForBad} directive`, p.badCheck.test(r.stdout), r.stdout);

  // Control: the SAME non-compliant prompt WITHOUT the persona flag -> the block
  // is not active, so its reads are not required -> passes. Proves the reads are
  // gated by the role flag (like --verifier), not required of every prompt.
  r = runLint(['--file', badPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
  check(`  ... same prompt WITHOUT ${p.flag} passes (block is flag-gated)`, r.code === 0, `code=${r.code}\n${r.stdout}`);
}

// ---------------------------------------------------------------------------
// Mutation check (in-suite): the enforcement is DERIVED from the manifest, not
// hardcoded. Remove `tool-conventions.md` from the test-writer block of a mutated
// manifest and the previously-FAILing bad prompt now PASSes under --test-writer
// -> proves dropping the manifest directive drops the enforcement (and, inversely,
// that with the directive present the test above genuinely goes red).
// ---------------------------------------------------------------------------
const mutatedManifest = write('reading-list-mutated.md', [
  '# subagent reading list (fixture, test-writer block mutated)',
  '<!-- lint:begin base -->',
  '- `subagent/handbook.md` — the worker handbook.',
  '<!-- lint:end -->',
  '<!-- lint:begin working-folder -->',
  '- `project-workspace.md` — the write-boundary + folder layout.',
  '<!-- lint:end -->',
  '<!-- lint:begin test-writer -->',
  '- `HANDOFF.md` — the artifact under test.',   // tool-conventions.md DROPPED
  '<!-- lint:end -->',
].join('\n'));
const twBadPath = path.join(SCRATCH, 'test-writer-bad.md');  // the bad prompt from the loop
r = runLint(['--file', twBadPath, '--manifest', mutatedManifest, '--charter-dir', SCRATCH, '--require', 'charter', '--test-writer']);
check('MUTATION: dropping tool-conventions.md from the manifest block removes the requirement (bad prompt now passes)',
  r.code === 0, `code=${r.code}\n${r.stdout}`);

// ===========================================================================
// 23-tighten-lint — the 5 hardening fixes from the fable review.
// ===========================================================================

// ---------------------------------------------------------------------------
// FIX #1 — charter-file-present FAILs a PLACEHOLDER charter (the scaffolder stub
// with a {{CHARTER_BODY}} fill-marker and/or a "# Charter — <role> (placeholder)"
// header). A worker spawned against a placeholder charter has no posture at all.
// Lifted from fable-3's demo (scratch/fable-3/demo-fixes/…PLACEHOLDER-FIX.js) +
// the real scaffolder stub shape (scratch/fable-3/sandbox/…/00-t/charter-builder.md).
// ---------------------------------------------------------------------------
write('charter-placeholder-full.md', '# Charter — builder (placeholder)\n\n> replace before spawn\n\n{{CHARTER_BODY}}\n');
write('charter-placeholder-fillonly.md', '# Charter\n\nDo the thing.\n\n{{CHARTER_BODY}}\n');
write('charter-placeholder-headeronly.md', '# Charter — verifier (placeholder)\n\nA body with no braces at all.\n');

for (const cf of ['charter-placeholder-full.md', 'charter-placeholder-fillonly.md', 'charter-placeholder-headeronly.md']) {
  const pPath = write(`names-${cf}`, `Read \`${cf}\`.\n<!-- required: charter -->\n`);
  r = runLint(['--file', pPath, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
  check(`FIX#1 placeholder charter (${cf}) fails (exit 1) + names charter-file-present`,
    r.code === 1 && /charter-file-present/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
  check(`  ... detail flags it as a PLACEHOLDER`, /PLACEHOLDER/i.test(r.stdout), r.stdout);
}
// A REAL charter still passes charter-file-present (charter-builder.md = clean).
const realCharterPrompt = write('names-real-charter.md', 'Read `charter-builder.md`.\n<!-- required: charter -->\n');
r = runLint(['--file', realCharterPrompt, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('FIX#1 a REAL (non-placeholder) charter still passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// FIX #6 — the lint sentinel-lints the DROPPED charter's CONTENTS, matched
// CASE-INSENSITIVELY, as a backstop for the scaffolder's case-SENSITIVE strip.
// A natural lowercase `<!-- Orchestrator note … -->` leaks verbatim otherwise.
// Lifted from fable-2's repro (scratch/fable-2/sandbox/proj/…).
// ---------------------------------------------------------------------------
write('charter-leaky-lower.md', '# Charter — builder\n\nDo it well.\n\n<!-- Orchestrator note: use the weaker mvp charter instead -->\n');
write('charter-leaky-upper.md', '# Charter — builder\n\nDo it well.\n\n<!-- ORCHESTRATOR NOTE: pick opus -->\n');
for (const cf of ['charter-leaky-lower.md', 'charter-leaky-upper.md']) {
  const pPath = write(`names-${cf}`, `Read \`${cf}\`.\n<!-- required: charter -->\n`);
  r = runLint(['--file', pPath, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
  check(`FIX#6 leaked orchestrator note in charter (${cf}) fails (exit 1) + names charter-no-strip-sentinel`,
    r.code === 1 && /charter-no-strip-sentinel/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
}
// A clean charter (no note) passes the strip backstop.
r = runLint(['--file', realCharterPrompt, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('FIX#6 a clean charter passes the strip backstop (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// FIX #2 — verifier-hard-rule reconciled to CURRENT doctrine (verdict-not-repair).
// The retired /NEVER.*touch.*live system/ framing is NO LONGER accepted; the
// check now keys off HARD RULE + a verdict-not-repair phrase.
// ---------------------------------------------------------------------------
write('charter-verifier.md', '# Charter — verifier\nRender a verdict.\n');
function verifierPrompt(hardRuleLine) {
  return [
    'You are a VERIFIER subagent for the demo epic.',
    '',
    'Working folder: `dev/demo/05-verify/`',
    '',
    'Step zero: cd to the project root, then `set -a && source dev/demo/05-verify/tmp/subagent.env && set +a`.',
    '',
    'Read, in order:',
    '1. Your charter: `charter-verifier.md`.',
    '2. subagent handbook.',
    '3. project workspace (the working folder layout).',
    '',
    hardRuleLine,
    '',
    '<!-- required: charter -->',
    '',
    'Render your verdict.',
  ].join('\n');
}
const vArgs = ['--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--verifier'];

const vGood = write('verifier-current.md', verifierPrompt('HARD RULE: you render a verdict; do not fix or repair what you check.'));
r = runLint(['--file', vGood, ...vArgs]);
check('FIX#2 verifier prompt in CURRENT doctrine (HARD RULE + verdict-not-repair) passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}\n${r.stderr}`);

const vRetired = write('verifier-retired.md', verifierPrompt('You must NEVER touch the live system under test.'));
r = runLint(['--file', vRetired, ...vArgs]);
check('FIX#2 RETIRED "never touch the live system" framing is NO LONGER accepted (exit 1) + names verifier-hard-rule',
  r.code === 1 && /verifier-hard-rule/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

const vNoVerdict = write('verifier-hardrule-noverdict.md', verifierPrompt('HARD RULE: inspect on-disk artifacts only.'));
r = runLint(['--file', vNoVerdict, ...vArgs]);
check('FIX#2 HARD RULE present but NO verdict-not-repair phrase still fails (exit 1)',
  r.code === 1 && /verifier-hard-rule/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// A "verdict," phrasing (comma) also satisfies the current rule.
const vVerdictComma = write('verifier-verdict-comma.md', verifierPrompt('HARD RULE: deliver your verdict, and change nothing.'));
r = runLint(['--file', vVerdictComma, ...vArgs]);
check('FIX#2 "verdict," phrasing satisfies the current rule (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// FIX #4 — a --bug-fixer prompt must NAME its verdict file. The verify->fix
// handoff is mechanical, not freeform. Lifted from fable-3 #3.
// ---------------------------------------------------------------------------
const BF_READS = [...BASE_READS, 'verification.md', 'HANDOFF.md'];
// (a) bug-fixer WITHOUT any verdict reference -> FAIL, names bug-fixer-names-verdict.
const bfNoVerdict = write('bugfixer-noverdict.md', personaPrompt({ role: 'bug-fixer', charter: 'charter-bug-fixer.md', folder: '04-fix', reads: BF_READS }));
r = runLint(['--file', bfNoVerdict, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--bug-fixer']);
check('FIX#4 bug-fixer prompt with NO verdict reference fails (exit 1) + names bug-fixer-names-verdict',
  r.code === 1 && /bug-fixer-names-verdict/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
// Control: same prompt WITHOUT --bug-fixer -> the check is flag-gated -> passes.
r = runLint(['--file', bfNoVerdict, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
check('  ... same prompt WITHOUT --bug-fixer passes (check is flag-gated)', r.code === 0, `code=${r.code}\n${r.stdout}`);
// (b) canonical verifier-r<N>-v<M>-verdict.md reference -> passes (no --verdict needed).
const bfCanonical = write('bugfixer-canonical.md', personaPrompt({ role: 'bug-fixer', charter: 'charter-bug-fixer.md', folder: '04-fix', reads: BF_READS, extra: ['Fix per `verifier-r2-v1-verdict.md`.'] }));
r = runLint(['--file', bfCanonical, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--bug-fixer']);
check('FIX#4 canonical verifier-r<N>-v<M>-verdict.md reference passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);
// (c) --verdict supplies a NON-canonical path; body names it -> passes only via --verdict.
const bfCustom = write('bugfixer-custom.md', personaPrompt({ role: 'bug-fixer', charter: 'charter-bug-fixer.md', folder: '04-fix', reads: BF_READS, extra: ['Read `round7-checkpoint.md` for the failures to fix.'] }));
r = runLint(['--file', bfCustom, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--bug-fixer', '--verdict', 'round7-checkpoint.md']);
check('FIX#4 a --verdict-supplied path named in the body passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);
// ... and WITHOUT --verdict, that same non-canonical name does NOT satisfy the check.
r = runLint(['--file', bfCustom, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter', '--bug-fixer']);
check('FIX#4 a non-canonical name without --verdict fails (exit 1)', r.code === 1 && /bug-fixer-names-verdict/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// FIX #8 — an explicit --manifest that doesn't exist EXITS 2 (fail loud), never
// a silent skip. Lifted from fable-1's demo + repro (a typo'd relative path).
// ---------------------------------------------------------------------------
r = runLint(['--file', cleanPromptPath, '--manifest', path.join(SCRATCH, 'no-such-manifest-xyz.md'), '--charter-dir', SCRATCH, '--require', 'charter']);
check('FIX#8 explicit nonexistent --manifest (absolute) exits 2', r.code === 2, `code=${r.code}\n${r.stdout}\n${r.stderr}`);
check('  ... stderr explains the manifest does not exist', /does not exist/.test(r.stderr), r.stderr);
// A typo'd RELATIVE path (fable-1's exact repro) also exits 2.
r = runLint(['--file', cleanPromptPath, '--manifest', 'reading-lst.md', '--charter-dir', SCRATCH, '--require', 'charter']);
check('FIX#8 typo\'d relative --manifest also exits 2 (does not fail open)', r.code === 2, `code=${r.code}\n${r.stderr}`);
// A VALID explicit --manifest still lints normally (happy path unbroken).
r = runLint(['--file', cleanPromptPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
check('FIX#8 a VALID explicit --manifest still lints (exit 0, not 2)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ===========================================================================
// TEST-HARDENING ROUND (28) — four guard-neutering mutants the canonical suite
// left GREEN (fable-2 #4). Each guard was confirmed to RUN, but never to FAIL:
//   L1 empty-charter (st.size > 0)   L2 env-source-ritual   L3 working-folder
//   L4 FILL-marker regex catching a LOWERCASE {{fill}} (uppercase-only survivor)
// One killing negative-path assertion each. (The external mutation-check28
// harness that proved these was retired; the assertions remain.)
// ===========================================================================

// ── L1: empty-charter — a 0-byte charter FAILs charter-file-present ──────────
write('charter-empty.md', ''); // 0 bytes on disk
const emptyCharterPrompt = write('names-empty-charter.md', 'Read `charter-empty.md`.\n<!-- required: charter -->\n');
r = runLint(['--file', emptyCharterPrompt, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('L1 empty-charter: a 0-byte charter FAILs charter-file-present (exit 1)',
  r.code === 1 && /charter-file-present/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
// control: the same-shaped prompt naming a NON-empty real charter passes.
const nonEmptyCharterPrompt = write('names-nonempty-charter.md', 'Read `charter-builder.md`.\n<!-- required: charter -->\n');
r = runLint(['--file', nonEmptyCharterPrompt, '--sentinels-only', '--require', 'charter', '--charter-dir', SCRATCH]);
check('L1 empty-charter: a non-empty charter still passes (control, exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ── L2: env-source-ritual — a prompt lacking the source-subagent.env ritual ──
// Crafted so ONLY env-source-ritual fails: it keeps the working-folder path,
// the project-root anchor, the doc-chain, and the charter — but drops the
// `source … subagent.env` / `set -a … source` step-zero line.
const envlessPrompt = [
  'You are a BUILDER subagent for the demo epic.',
  '',
  'Working folder: `dev/demo/01-thing/`',
  '',
  'Step zero: cd to the project root (the env-source details are omitted here).',
  '',
  'Read, in order:',
  '1. Your charter: `charter-builder.md`.',
  '2. subagent handbook.',
  '3. project workspace (the working folder layout).',
  '',
  '<!-- required: charter -->',
  '',
  'Do the task. Return a one-paragraph summary.',
].join('\n');
const envlessPath = write('envless-prompt.md', envlessPrompt);
r = runLint(['--file', envlessPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
check('L2 env-source-ritual: a prompt with NO source-subagent.env ritual FAILs (exit 1)',
  r.code === 1 && /env-source-ritual/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// ── L3: working-folder-mentioned — a prompt with no dev/<task>/ path ────────
// Crafted so ONLY working-folder-mentioned fails: it keeps the env ritual, the
// project-root anchor, the doc-chain and the charter, but uses a `scratch/` path
// so no `dev/` token appears anywhere.
const noWorkPrompt = [
  'You are a BUILDER subagent for the demo epic.',
  '',
  'Working folder: `scratch/demo/01-thing/`',
  '',
  'Step zero: cd to the project root, then `set -a && source scratch/demo/01-thing/tmp/subagent.env && set +a`.',
  '',
  'Read, in order:',
  '1. Your charter: `charter-builder.md`.',
  '2. subagent handbook.',
  '3. project workspace (the working folder layout).',
  '',
  '<!-- required: charter -->',
  '',
  'Do the task. Return a one-paragraph summary.',
].join('\n');
const noWorkPath = write('no-work-folder-prompt.md', noWorkPrompt);
r = runLint(['--file', noWorkPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
check('L3 working-folder-mentioned: a prompt with no dev/<task>/ path FAILs (exit 1)',
  r.code === 1 && /working-folder-mentioned/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
// control: adding a dev/ path back makes the SAME prompt pass.
const withWorkPath = write('with-work-folder-prompt.md', noWorkPrompt.replace(/scratch\//g, 'dev/'));
r = runLint(['--file', withWorkPath, '--manifest', manifestPath, '--charter-dir', SCRATCH, '--require', 'charter']);
check('L3 working-folder-mentioned: restoring a dev/ path passes (control, exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);

// ── L4: FILL-marker regex must catch a LOWERCASE {{fill}} (uppercase-only gap) ─
// The general fill-sentinel FILL_RE must not be uppercase-only: a lowercase
// {{task_context}} that the orchestrator forgot to fill is just as dangerous.
const lowerFill = write('fill-lower.md', '# Plan\nScope: {{task_context}}\n<!-- required: charter -->\n');
r = runLint(['--file', lowerFill, '--sentinels-only', '--require', 'charter']);
check('L4 fill-sentinel: a LOWERCASE {{task_context}} fill marker is flagged (exit 1)',
  r.code === 1 && /fill-sentinel/.test(r.stdout) && /task_context/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
// control: a mixed-case {{Fill_Me}} is also caught (regex is case-agnostic).
const mixedFill = write('fill-mixed.md', '# Plan\nScope: {{Fill_Me}}\n<!-- required: charter -->\n');
r = runLint(['--file', mixedFill, '--sentinels-only', '--require', 'charter']);
check('L4 fill-sentinel: a mixed-case {{Fill_Me}} marker is also flagged (control, exit 1)',
  r.code === 1 && /fill-sentinel/.test(r.stdout), `code=${r.code}\n${r.stdout}`);

// ---------------------------------------------------------------------------
// #1182 backstop — phase-location-matches-marker: dirname(--file) must equal the
// <!-- tpm-workflow-spawn phase="..." --> marker's phase folder.
// ---------------------------------------------------------------------------
{
  const phaseDir = path.join(SCRATCH, 'phase-a');
  const otherDir = path.join(SCRATCH, 'phase-b');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.mkdirSync(otherDir, { recursive: true });
  const marked = ph => `<!-- tpm-workflow-spawn phase="${ph}" role="builder" -->\n# Plan\nNo fill markers here.\n`;
  // PASS on match (absolute marker, absolute --file)
  const okFile = path.join(phaseDir, 'spawn.md');
  fs.writeFileSync(okFile, marked(phaseDir));
  r = runLint(['--file', okFile, '--sentinels-only']);
  check('#1182 phase-location: file inside its declared phase folder passes (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);
  // PASS on match with a cwd-relative marker + relative --file
  const rel = path.relative(process.cwd(), phaseDir);
  fs.writeFileSync(okFile, marked(rel));
  r = runLint(['--file', path.join(rel, 'spawn.md'), '--sentinels-only']);
  check('#1182 phase-location: relative marker + relative --file compare equal (exit 0)', r.code === 0, `code=${r.code}\n${r.stdout}`);
  // FAIL on mismatch, naming both
  const badFile = path.join(otherDir, 'spawn.md');
  fs.writeFileSync(badFile, marked(phaseDir));
  r = runLint(['--file', badFile, '--sentinels-only']);
  check('#1182 phase-location: file in the WRONG folder FAILs naming both paths (exit 1)',
    r.code === 1 && /phase-location-matches-marker/.test(r.stdout) && r.stdout.includes(otherDir) && r.stdout.includes(path.basename(phaseDir)),
    `code=${r.code}\n${r.stdout}`);
  // SKIP: no marker
  const noMarker = path.join(otherDir, 'nomarker.md');
  fs.writeFileSync(noMarker, '# Plan\nNo marker.\n');
  r = runLint(['--file', noMarker, '--sentinels-only']);
  check('#1182 phase-location: marker-less file skips the check (exit 0)', r.code === 0 && !/phase-location/.test(r.stdout), `code=${r.code}\n${r.stdout}`);
  // SKIP: stdin (no --file) with a mismatching marker must not crash or FAIL on this check
  try {
    const out = execFileSync(process.execPath, [LINT, '--sentinels-only', '--verbose'], { input: marked('dev/nowhere/x'), encoding: 'utf8' });
    check('#1182 phase-location: stdin input skips the check (no crash)', !/phase-location/.test(out), out);
  } catch (e) {
    check('#1182 phase-location: stdin input skips the check (no crash)', !/phase-location/.test(String(e.stdout)), String(e.stdout) + String(e.stderr));
  }
}

// ---------------------------------------------------------------------------
// Extra — --help exits 0.
// ---------------------------------------------------------------------------
r = runLint(['--help']);
check('--help exits 0 and prints usage', r.code === 0 && /USAGE/.test(r.stdout), `code=${r.code}`);

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
