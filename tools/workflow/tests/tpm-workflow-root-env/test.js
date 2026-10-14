#!/usr/bin/env node
/**
 * test.js — workflow suite honors the project-root env (3.4) + spawn gate reads the token from
 * $CLAUDE_PROJECT_DIR (2.1). Every child gets an env built FROM SCRATCH (no inherited
 * TPM_PROJECT_ROOT / CLAUDE_PROJECT_DIR / TPM_HOME). Fixtures live under the bundle's tmp/scratch.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('../../../tests/lib/scratch');

const WF = path.resolve(__dirname, '..', '..');
const HOOK = path.join(WF, 'hooks', 'tpm-workflow-gate-spawn.js');
const SIGNOFF = path.join(WF, 'tpm-workflow-signoff.js');
const DOCTOR = path.join(WF, 'tpm-workflow-doctor.js');
const LINT = path.join(WF, 'tpm-workflow-lint-subagent-prompt.js');
const signoff = require(SIGNOFF);

let passed = 0; const failures = [];
const check = (c, m) => { if (c) passed += 1; else { failures.push(m); process.stderr.write(`  ✗ ${m}\n`); } };

function env(extra) { // scratch env: only PATH/HOME-ish basics + explicit extras
  return { PATH: process.env.PATH, ...extra };
}
function run(file, args, { cwd, input, e } = {}) {
  const r = spawnSync('node', [file, ...args], { cwd, input, env: env(e), encoding: 'utf8' });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const base = mkScratch('workflow-root-env');
const mkProj = (n) => {
  const p = path.join(base, n);
  fs.mkdirSync(path.join(p, '.claude', 'claude-tpm'), { recursive: true });
  return fs.realpathSync(p);
};
const proj = mkProj('proj');
const other = mkProj('other');
const sub = path.join(proj, 'a', 'b');
fs.mkdirSync(sub, { recursive: true });
const ROUND = 'dev/x/01-y';
const payload = (cwd) => ({ tool_name: 'Agent', cwd, tool_input: { prompt: `<!-- tpm-workflow-spawn phase="${ROUND}" role="builder" -->` } });
const hook = (pl, e) => run(HOOK, [], { cwd: other, input: JSON.stringify(pl), e });

// ── signoff writer uses the env root ──
let r = run(SIGNOFF, ['questions', '--roster', 'x'], { cwd: sub, e: { TPM_PROJECT_ROOT: proj } });
check(r.code === 0, 'signoff questions (cwd=subfolder, env=proj) exits 0');
r = run(SIGNOFF, ['spawn', '--round', ROUND, '--roster', 'x'], { cwd: sub, e: { TPM_PROJECT_ROOT: proj } });
check(r.code === 0, 'signoff spawn (cwd=subfolder, env=proj) exits 0: ' + r.err);
// #1183: questions token stays at the project root (tpm-tmp/); the spawn token is ROUND-scoped under the phase folder.
check(fs.existsSync(path.join(proj, 'tpm-tmp', 'tpm-signoff', 'questions.json')),
  'questions token written under <proj>/tpm-tmp/tpm-signoff/');
check(fs.existsSync(path.join(proj, ROUND, 'tpm-tmp', 'tpm-signoff', 'spawn.json')),
  'spawn token written under <proj>/<round>/tpm-tmp/tpm-signoff/spawn.json (round-scoped, no hash)');
check(!fs.existsSync(path.join(proj, 'tmp', 'tpm-signoff')), 'no legacy <proj>/tmp/tpm-signoff store created');
check(!fs.existsSync(path.join(sub, 'tpm-tmp')) && !fs.existsSync(path.join(sub, 'tmp')), 'no token store created under the subfolder');

// ── gate reader agrees with the writer ──
// (token is under proj; payload.cwd = subfolder)
r = hook(payload(sub), { CLAUDE_PROJECT_DIR: proj });
check(r.code === 0, 'gate: token under project + payload.cwd=subfolder + CLAUDE_PROJECT_DIR=proj -> ALLOW');
// no CLAUDE_PROJECT_DIR -> payload.cwd (subfolder has no tokens) -> BLOCK (existing behavior)
r = hook(payload(sub), {});
check(r.code === 2, 'gate: no CLAUDE_PROJECT_DIR -> falls back to payload.cwd (subfolder, no token) -> BLOCK');
r = hook(payload(proj), {});
check(r.code === 0, 'gate: no CLAUDE_PROJECT_DIR, payload.cwd=proj (has token) -> ALLOW');
// token only under the subfolder, CLAUDE_PROJECT_DIR=other project w/o token -> BLOCK
const subStore = path.join(sub, 'tpm-tmp', 'tpm-signoff');
fs.mkdirSync(subStore, { recursive: true });
signoff.writeToken('questions', { root: sub });
signoff.writeToken('spawn', { root: sub, round: ROUND });
r = hook(payload(sub), { CLAUDE_PROJECT_DIR: other });
check(r.code === 2, 'gate: token only under subfolder, CLAUDE_PROJECT_DIR=project without it -> BLOCK');
check(/BLOCKED/.test(r.err) && /tpm workflow signoff spawn --round "<phase-dir>" --roster "<one-line>"/.test(r.err)
  && !/npx tpm/.test(r.err), 'gate: BLOCK message uses bare `tpm ... signoff spawn --round ... --roster ...`');
// fail-open: garbage CLAUDE_PROJECT_DIR
r = hook(payload(proj), { CLAUDE_PROJECT_DIR: path.join(base, 'does', 'not', 'exist') });
check(r.code === 0 || r.code === 2, 'gate: non-existent CLAUDE_PROJECT_DIR does not crash (exit 0/2, got ' + r.code + ')');
check(r.code === 2 && /BLOCKED/.test(r.err), 'gate: non-existent CLAUDE_PROJECT_DIR -> no token there -> clean block, no stack trace');
r = run(HOOK, [], { cwd: other, input: 'not json', e: { CLAUDE_PROJECT_DIR: '/nonexistent/zzz' } });
check(r.code === 0, 'gate: malformed stdin + garbage CLAUDE_PROJECT_DIR -> still fail-open');

// ── doctor honors env; flag wins ──
r = run(DOCTOR, ['--json'], { cwd: other, e: { TPM_PROJECT_ROOT: proj } });
let j; try { j = JSON.parse(r.out); } catch (_e) { j = {}; }
check(j.projectRoot === proj, 'doctor: TPM_PROJECT_ROOT used when no flag (got ' + j.projectRoot + ')');
r = run(DOCTOR, ['--json', '--project-root', other], { cwd: sub, e: { TPM_PROJECT_ROOT: proj } });
try { j = JSON.parse(r.out); } catch (_e) { j = {}; }
check(j.projectRoot === other, 'doctor: --project-root flag wins over env');

// ── config-resolver / scaffold resolve the env project from an unrelated cwd ──
const probe = `
const cr = require(${JSON.stringify(path.join(WF, 'tpm-workflow-config-resolver.js'))});
const sc = require(${JSON.stringify(path.join(WF, 'tpm-workflow-scaffold-subagent.js'))});
const out = { cr: cr.resolveConfig(undefined, {}).projectRoot,
  team: sc.resolveTeamRoster('full', {}).projectRoot,
  role: sc.resolveRoleCharter('builder', {}).projectRoot,
  explicit: cr.resolveConfig(undefined, { startDir: ${JSON.stringify(other)} }).projectRoot };
process.stdout.write(JSON.stringify(out));`;
const pr = spawnSync('node', ['-e', probe], { cwd: other, env: env({ TPM_PROJECT_ROOT: proj }), encoding: 'utf8' });
let o; try { o = JSON.parse(pr.stdout); } catch (_e) { o = {}; process.stderr.write(pr.stderr); }
check(o.cr === proj, 'config-resolver: resolveConfig() from unrelated cwd + env -> env project');
check(o.team === proj, 'scaffold: resolveTeamRoster from unrelated cwd + env -> env project');
check(o.role === proj, 'scaffold: resolveRoleCharter from unrelated cwd + env -> env project');
check(o.explicit === other, 'config-resolver: explicit startDir still wins over env');

// ── lint: consumer manifest located via the env project (probe = fixture manifest has one fewer directive) ──
const lp = mkProj('lintproj');
const mdir = path.join(lp, 'claude-context', 'methodology', 'subagent');
fs.mkdirSync(mdir, { recursive: true });
const real = fs.readFileSync(path.join(WF, '..', '..', 'claude-context', 'methodology', 'subagent', 'reading-list.md'), 'utf8').split('\n');
const idx = real.findIndex((l) => /tool-conventions\.md/.test(l) && /^\d+\./.test(l));
if (idx >= 0) real.splice(idx, 1);
fs.writeFileSync(path.join(mdir, 'reading-list.md'), real.join('\n'));
const pf = path.join(base, 'p.md'); fs.writeFileSync(pf, 'hi\n');
const cnt = (x) => { const m = /of (\d+) required/.exec(x.out); return m ? Number(m[1]) : null; };
const lintEnv = run(LINT, [pf], { cwd: other, e: { TPM_PROJECT_ROOT: lp } });
const lintNone = run(LINT, [pf], { cwd: other, e: { TPM_PROJECT_ROOT: proj } });
check(idx >= 0 && cnt(lintEnv) !== null && cnt(lintEnv) === cnt(lintNone) - 1,
  `lint: env project's consumer manifest is picked up (${cnt(lintEnv)} vs ${cnt(lintNone)})`);

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
process.exit(failures.length ? 1 : 0);
