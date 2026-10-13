'use strict';
/**
 * task-attribution-degrade.test.js — DoD B/D: attribution must NEVER get in the way of a task write.
 * Runs the SAME script of every mutating verb under a healthy (attributed) baseline and under each degraded
 * condition — sessions dir deleted, no Claude session id, garbage TPM_SESSION_ID, sessions dir is a FILE, an
 * unreadable sessions dir, corrupt track records, module disabled — and asserts for EVERY step: exit 0 and
 * stdout + stderr BYTE-IDENTICAL to the healthy run, while every event written carries NO session keys.
 *
 * ISOLATION: EXPLICIT minimal child env (PATH + fake CLAUDE_CODE_SESSION_ID/CLAUDE_PID + scratch TPM_SESSIONS_DIR);
 * scratch dirs only. Run: node tools/task/tests/task-attribution-degrade.test.js
 */
const { assert, test, done, scratch, bodyJson } = require('./helpers/task-e2e-helpers');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('../../session/tests/helpers/track-helpers');

const TPMTASK = path.resolve(__dirname, '..', 'tpm-task.js');
const ROOT = scratch('tpm-task-attr-deg-');
const NOW = '2026-10-08T12:00:00-07:00';
let seq = 0;

/** One run of a verb against a fresh-or-continuing store with an explicit env. */
function runner(tasksDir, base, env) {
  return (args) => {
    const r = spawnSync(process.execPath, [TPMTASK, ...args, '--tasks-dir', tasksDir, '--now', NOW],
      { encoding: 'utf8', env: Object.assign({ PATH: process.env.PATH }, env), cwd: base, timeout: 20000 });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  };
}

// every mutating verb, in an order that keeps each step legal (id 1000 first, then 1001)
function steps(base) {
  const imp = path.join(base, 'imp.json');
  fs.writeFileSync(imp, JSON.stringify({ headline: 'imported' }));
  return [
    ['add', '--headline', 'one'], ['add', '--headline', 'two', '--label', 'x'],
    ['edit', '1000', '--headline', 'one!'], ['add-subtask', '1000', 'A', '--text', 'st'], ['check', '1000', 'A'],
    ['label', '1000', 'foo'], ['unlabel', '1000', 'foo'], ['import', '1000', '--file', imp],
    ['start', '1000'], ['finish', '1000'], ['reopen', '1000'], ['drop', '1000'], ['reopen', '1000'], ['remove', '1000'], ['reopen', '1000'],
    ['start', '1001'], ['reindex'],
  ];
}

function script(label, env, prep) {
  const base = path.join(ROOT, label + '-' + (seq++));
  const tasks = path.join(base, 'tasks'); const sessions = path.join(base, 'sessions');
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
  H.putTrack(sessions, '0040', 'b', { owner: 'idMe' });
  if (prep) prep(sessions, base);
  // a marked (empty) project root so tpm's own "no project root" warning does not embed the per-run path
  const proj = path.join(base, 'proj'); fs.mkdirSync(path.join(proj, '.claude', 'claude-tpm'), { recursive: true });
  const run = runner(tasks, base, Object.assign({ TPM_PROJECT_ROOT: proj }, typeof env === 'function' ? env(sessions, base) : env));
  const results = steps(base).map((a) => ({ a, r: run(a) }));
  const events = [];
  for (const id of [1000, 1001]) for (const e of bodyJson(tasks, id).history) events.push(e);
  return { results, events, tasks };
}

const healthyEnv = (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idMe', CLAUDE_PID: '4242', TPM_SESSIONS_DIR: sessions });
const baseline = script('healthy', healthyEnv);

test('B-0 the baseline really is attributed (so the comparison below means something)', () => {
  assert.ok(baseline.events.length > 15);
  for (const e of baseline.events) { assert.strictEqual(e.session, 'session-0040b'); assert.strictEqual(e.sessionVia, 'lookup'); }
  for (const { a, r } of baseline.results) assert.strictEqual(r.code, 0, a.join(' ') + ' ' + r.stderr);
});

function degraded(name, env, prep) {
  test('D ' + name + ': every mutating verb exits 0, stdout+stderr byte-identical to the healthy run, events carry NO session keys', () => {
    const got = script(name.replace(/\W+/g, '-'), env, prep);
    assert.strictEqual(got.results.length, baseline.results.length);
    got.results.forEach(({ a, r }, i) => {
      const b = baseline.results[i].r;
      assert.strictEqual(r.code, 0, a.join(' ') + ' exit ' + r.code + ' ' + r.stderr);
      assert.strictEqual(r.stdout, b.stdout, 'stdout of `' + a.join(' ') + '`');
      assert.strictEqual(r.stderr, b.stderr, 'stderr of `' + a.join(' ') + '`');
    });
    assert.strictEqual(got.events.length, baseline.events.length, 'same number of events written');
    for (const e of got.events) {
      assert.ok(!('session' in e) && !('sessionVia' in e), 'blank omits both keys: ' + JSON.stringify(e));
      assert.deepStrictEqual(Object.keys(e).slice(0, 2), ['at', 'op']);
    }
  });
}

// the DoD D triple
degraded('sessions dir deleted', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idMe', CLAUDE_PID: '4242', TPM_SESSIONS_DIR: path.join(sessions, 'gone') }));
degraded('no Claude session id', (sessions) => ({ TPM_SESSIONS_DIR: sessions }));
degraded('garbage TPM_SESSION_ID', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idMe', CLAUDE_PID: '4242', TPM_SESSIONS_DIR: path.join(sessions, 'gone'), TPM_SESSION_ID: 'not-a-session' }));
// more degraded rows
for (const g of ['4f1c2d3e-aaaa-bbbb-cccc-1234567890ab', '0012B', '99999', '   ']) {
  degraded('garbage TPM_SESSION_ID ' + JSON.stringify(g), (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idMe', TPM_SESSIONS_DIR: path.join(sessions, 'gone'), TPM_SESSION_ID: g }));
}
degraded('sessions dir is a FILE', (sessions, base) => { const f = path.join(base, 'afile'); fs.writeFileSync(f, 'x'); return { CLAUDE_CODE_SESSION_ID: 'idMe', TPM_SESSIONS_DIR: f }; });
degraded('sessions dir unreadable (chmod 000)', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idMe', TPM_SESSIONS_DIR: sessions }),
  (sessions) => { fs.chmodSync(sessions, 0o000); process.on('exit', () => { try { fs.chmodSync(sessions, 0o755); } catch (_e) { /* gone */ } }); });
degraded('only a corrupt track record', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idCorrupt', TPM_SESSIONS_DIR: sessions }),
  (sessions) => { fs.mkdirSync(path.join(sessions, 'session-0099'), { recursive: true }); fs.writeFileSync(path.join(sessions, 'session-0099', 'session-0099.json'), '{"meta":'); });
degraded('only a marker-sealed track', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idSealed', TPM_SESSIONS_DIR: sessions }),
  (sessions) => { H.putTrack(sessions, '0050', 'a', { owner: 'idSealed' }); H.putMarker(sessions, '0050', 'a'); });
degraded('two live tracks of one id in the newest session', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idTwo', TPM_SESSIONS_DIR: sessions }),
  (sessions) => { H.putTrack(sessions, '0060', 'a', { owner: 'idTwo' }); H.putTrack(sessions, '0060', 'b', { owner: 'idTwo' }); });
degraded('a Claude id that owns no track', (sessions) => ({ CLAUDE_CODE_SESSION_ID: 'idStranger', TPM_SESSIONS_DIR: sessions }));

test('D-module project config with the session module disabled -> blank, same output (no TPM_SESSIONS_DIR; project via TPM_PROJECT_ROOT)', () => {
  const base = path.join(ROOT, 'modoff-' + (seq++));
  const cfgDir = path.join(base, 'proj', '.claude', 'claude-tpm');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ session: { enabled: false } }));
  H.putTrack(path.join(cfgDir, 'sessions'), '0040', 'a', { owner: 'idMe' });
  const run = runner(path.join(base, 'tasks'), base, { CLAUDE_CODE_SESSION_ID: 'idMe', TPM_PROJECT_ROOT: path.join(base, 'proj') });
  const r = run(['add', '--headline', 'x']);
  assert.strictEqual(r.code, 0, r.stderr);
  const e = bodyJson(path.join(base, 'tasks'), 1000).history[0];
  assert.ok(!('session' in e), 'module disabled -> blank');
  // control: same project, module enabled -> attributed
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ session: { enabled: true } }));
  const run2 = runner(path.join(base, 'tasks2'), base, { CLAUDE_CODE_SESSION_ID: 'idMe', TPM_PROJECT_ROOT: path.join(base, 'proj') });
  assert.strictEqual(run2(['add', '--headline', 'x']).code, 0);
  assert.strictEqual(bodyJson(path.join(base, 'tasks2'), 1000).history[0].session, 'session-0040');
});

done('task-attribution-degrade.test.js');
