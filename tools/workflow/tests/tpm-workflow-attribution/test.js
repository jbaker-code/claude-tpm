'use strict';
// Phase 18: session stamps on workflow artifacts (cost-ledger column, signoff tpmSession keys, tpm-session comment).
// Run: node tools/workflow/tests/tpm-workflow-attribution/test.js   (scratch dirs only; env fully scrubbed)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const WF = path.resolve(__dirname, '..', '..');
let pass = 0; let fail = 0;
function check(name, ok, extra) { if (ok) pass++; else { fail++; console.error('FAIL: ' + name + (extra ? ' :: ' + extra : '')); } }
function run(script, args, env, cwd) {
  return spawnSync(process.execPath, [path.join(WF, script), ...args], {
    env: Object.assign({ PATH: process.env.PATH, HOME: path.join(tmp, 'home') }, env || {}), cwd, encoding: 'utf8',
  });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-attr-'));
fs.mkdirSync(path.join(tmp, 'home'), { recursive: true });
const sess = path.join(tmp, 'sessions');
fs.mkdirSync(path.join(sess, 'session-0012'), { recursive: true });
fs.writeFileSync(path.join(sess, 'session-0012', 'session-0012-b.json'), JSON.stringify({ meta: { claudeSessionId: 'fake-id-1' } }));
const withSess = { TPM_SESSIONS_DIR: sess, CLAUDE_CODE_SESSION_ID: 'fake-id-1', CLAUDE_PID: '99999' };
const noSess = { TPM_SESSIONS_DIR: path.join(tmp, 'missing') };

// cost ledger
const d1 = path.join(tmp, 'p1');
let r = run('tpm-workflow-cost-ledger.js', ['--dir', d1, '--agent', 'a', '--tokens', '1k'], withSess);
check('cost append rc 0', r.status === 0);
r = run('tpm-workflow-cost-ledger.js', ['--dir', d1, '--agent', 'b', '--tokens', '1k'], noSess);
check('cost blank rc 0', r.status === 0);
const led = fs.readFileSync(path.join(d1, 'tpm-tmp', 'cost-ledger.md'), 'utf8');
check('10-col header', /\| Notes \| Session \|/.test(led));
check('stamped row', /\| session-0012b \|\n/.test(led));
check('blank row cell', /\| 1,000 \| — \| {2}\| {2}\| {2}\|\n?$/.test(led), JSON.stringify(led.slice(-60)));
check('summary reads 2 rows', /2 subagent/.test(run('tpm-workflow-cost-ledger.js', ['--dir', d1, '--summary'], noSess).stdout));
// old 9-col ledger: header upgraded, old rows untouched, still summarised
const d2 = path.join(tmp, 'p2'); fs.mkdirSync(path.join(d2, 'tpm-tmp'), { recursive: true });
const old = '# Cost ledger\n\n| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes |\n|------|---------------|-------|------|-------|-------:|------:|---------|-------|\n| 2026-01-01 | r | a | b | m | 1,000 | 2 | ok | n |\n';
fs.writeFileSync(path.join(d2, 'tpm-tmp', 'cost-ledger.md'), old);
check('old ledger summary', /1 subagent/.test(run('tpm-workflow-cost-ledger.js', ['--dir', d2, '--summary'], noSess).stdout));
run('tpm-workflow-cost-ledger.js', ['--dir', d2, '--agent', 'z', '--tokens', '2k'], noSess);
const up = fs.readFileSync(path.join(d2, 'tpm-tmp', 'cost-ledger.md'), 'utf8');
check('old header upgraded', /\| Notes \| Session \|\n\|[-:|]+---------\|\n/.test(up));
check('old row untouched', up.includes('| 2026-01-01 | r | a | b | m | 1,000 | 2 | ok | n |\n'));
check('bad --session exit 2', run('tpm-workflow-cost-ledger.js', ['--dir', d2, '--session', 'zz'], noSess).status === 2);

// signoff
const proj = path.join(tmp, 'proj'); fs.mkdirSync(path.join(proj, '.claude', 'claude-tpm'), { recursive: true });
r = run('tpm-workflow-signoff.js', ['questions'], withSess, proj);
check('signoff rc 0', r.status === 0);
const tokFile = (n) => JSON.parse(fs.readFileSync(path.join(proj, 'tpm-tmp', 'tpm-signoff', n), 'utf8'));
let t = tokFile('questions.json');
check('token tpmSession', t.tpmSession === 'session-0012b' && t.tpmSessionVia === 'lookup' && t.session === undefined && t.sessionId === 'fake-id-1');
const proj2 = path.join(tmp, 'proj2'); fs.mkdirSync(path.join(proj2, '.claude', 'claude-tpm'), { recursive: true });
check('signoff blank rc 0', run('tpm-workflow-signoff.js', ['questions'], noSess, proj2).status === 0);
t = JSON.parse(fs.readFileSync(path.join(proj2, 'tpm-tmp', 'tpm-signoff', 'questions.json'), 'utf8'));
check('token keys omitted when blank', !('tpmSession' in t) && !('tpmSessionVia' in t));
check('signoff bad --session exit 2', run('tpm-workflow-signoff.js', ['questions', '--session', 'zz'], noSess, proj2).status === 2);

// compose
const base = ['--role', 'builder', '--phase-dir', 'dev/x/01-a', '--plan', 'plan.md', '--charter', 'charter-builder.md'];
let out = run('tpm-workflow-compose-spawn-prompt.js', base, withSess).stdout.split('\n');
check('marker first', /^<!-- tpm-workflow-spawn phase="dev\/x\/01-a" role="builder" -->$/.test(out[1]));
check('tpm-session comment after marker', out[2] === '<!-- tpm-session session="session-0012b" via="lookup" -->' && out[3] === '');
out = run('tpm-workflow-compose-spawn-prompt.js', base, noSess).stdout.split('\n');
check('no comment when blank', out[2] === '' && !out.some((l) => l.includes('tpm-session')));
check('compose bad --session exit 2', run('tpm-workflow-compose-spawn-prompt.js', base.concat(['--session', 'zz']), noSess).status === 2);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
