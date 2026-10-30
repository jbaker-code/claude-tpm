#!/usr/bin/env node
/**
 * test.js — #1183 config-override END-TO-END smoke. One crafted consumer config overrides
 * workflow.folders.tmp ('scratchy') and workflow.devDir ('work'); the override must flow through the full
 * chain: (a) composer emission (single-quoted), (b) scaffolder bare-epic base resolution, (c) signoff store.
 * The crafted root contains a SPACE (guards the #1184 interlock); every path is path.join-built.
 *
 * #1188: signoffDir() now resolves workflow.folders.tmp, so assertion (c) REQUIRES the override folder.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('../../../tests/lib/scratch');

const WF = path.resolve(__dirname, '..', '..');
const COMPOSE = path.join(WF, 'tpm-workflow-compose-spawn-prompt.js');
const SCAFFOLD = path.join(WF, 'tpm-workflow-scaffold-subagent.js');
const signoff = require(path.join(WF, 'tpm-workflow-signoff.js'));

let passed = 0; const failures = [];
const check = (c, m) => { if (c) { passed += 1; console.log(`  ok   ${m}`); } else { failures.push(m); console.log(`  FAIL ${m}`); } };
const cleanEnv = () => ({ PATH: process.env.PATH });
function run(file, args, cwd) {
  const r = spawnSync('node', [file, ...args], { cwd, env: cleanEnv(), encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const TMP = 'scratchy';
const DEV = 'work';
const root = path.join(mkScratch('cfg-override-e2e'), 'my consumer proj'); // SPACE in the root
fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
fs.writeFileSync(path.join(root, '.claude', 'claude-tpm', 'config.json'),
  JSON.stringify({ workflow: { folders: { tmp: TMP }, devDir: DEV } }));

console.log('#1183 config-override e2e smoke\n');

// (a) composer emits the overridden tmp name, single-quoted, in step-zero + Constraints.
const phaseDir = path.join(DEV, 'my epic', '01-x');
const c = run(COMPOSE, ['--role', 'builder', '--phase-dir', phaseDir, '--plan', 'plan.md',
  '--charter', 'charter-builder.md', '--project-root', root], root);
check(c.code === 0, '(a) composer exits 0');
check(c.out.includes(`source '${path.join(phaseDir, TMP, 'subagent.env')}'`), '(a) step-zero source line uses overridden tmp, single-quoted');
// Step-zero env dump is commented out in the composer (auto-mode classifier blocks whole-env dumps to disk). Re-enable if the dump returns:
// check(c.out.includes(`> '${path.join(phaseDir, TMP, 'worker-env.md')}'`), '(a) worker-env line uses overridden tmp, single-quoted');
check(c.out.includes(`scratch → \`${TMP}/builder/\``), '(a) Constraints scratch line uses overridden tmp');
check(!c.out.includes('tpm-tmp'), '(a) no default tpm-tmp leaks into the composed prompt');

// (b) scaffolder: BARE epic name lands under the overridden devDir; an explicit path is honored as-is.
const s = run(SCAFFOLD, ['epic-init', 'foo', '--quiet'], root);
check(s.code === 0, `(b) epic-init foo exits 0 ${s.err}`);
check(fs.existsSync(path.join(root, DEV, 'foo', '00-epic-plan', 'epic-plan.md')), '(b) bare "foo" -> <root>/work/foo');
check(!fs.existsSync(path.join(root, 'foo')), '(b) bare "foo" did NOT land at the root');
check(!fs.existsSync(path.join(root, 'dev', 'foo')), '(b) bare "foo" did NOT land under default dev/');
const s2 = run(SCAFFOLD, ['epic-init', path.join('elsewhere', 'bar'), '--quiet'], root);
check(s2.code === 0 && fs.existsSync(path.join(root, 'elsewhere', 'bar', '00-epic-plan')) && !fs.existsSync(path.join(root, DEV, 'elsewhere')),
  '(b) explicit separator path honored, not double-prefixed');

// (c) signoff store: round-scoped under the round folder, space-safe, path.join-built.
const round = path.join(DEV, 'foo', '01-x');
const dir = signoff.signoffDir(root, round);
check(dir === path.join(root, round, TMP, 'tpm-signoff'),
  '(c) signoff store is round-scoped under the OVERRIDE folder: <root>/<round>/scratchy/tpm-signoff');
check(!dir.includes(path.sep + 'tpm-tmp' + path.sep), '(c) store is NOT at the default tpm-tmp under an override config');
check(dir.startsWith(path.join(root, DEV, 'foo')) && dir.includes('my consumer proj'), '(c) store resolves under the (spaced) root and the overridden devDir round');
signoff.writeToken('questions', { roster: 'smoke', root });
signoff.writeToken('spawn', { roster: 'smoke', root, round });
check(fs.existsSync(path.join(dir, 'spawn.json')) && signoff.isFresh('spawn', { root, round }).fresh !== false, '(c) spawn token written + read back at the store');
check(fs.existsSync(path.join(root, TMP, 'tpm-signoff', 'questions.json')), '(c) questions token at <root>/scratchy/tpm-signoff/questions.json');

console.log(`\n${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);
