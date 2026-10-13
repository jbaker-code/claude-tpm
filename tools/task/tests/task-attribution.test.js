'use strict';
/**
 * task-attribution.test.js — session attribution on task history events (multi-session support, phase 17).
 * Model stamping (setAttribution / _pushHistory), CLI stamping for EVERY event-writing verb, flags in both
 * positions, the env / lookup rungs with two Claude ids on one store, history text + --json, `list --session`,
 * exit-2 flag validation (store bytes untouched), doctor on attributed / old / mixed stores.
 *
 * ISOLATION: every child gets an EXPLICIT minimal env (PATH + a fake CLAUDE_CODE_SESSION_ID/CLAUDE_PID + a scratch
 * TPM_SESSIONS_DIR); nothing of the invoking session's identity reaches a child. Scratch dirs only.
 * Run: node tools/task/tests/task-attribution.test.js
 */
const { assert, test, done, scratch, bodyJson, indexPath } = require('./helpers/task-e2e-helpers');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const model = require('../lib/task-model');
const TPMTASK = path.resolve(__dirname, '..', 'tpm-task.js');
const DOCTOR = path.resolve(__dirname, '..', 'tpm-task-doctor.js');
const H = require('../../session/tests/helpers/track-helpers');

const ROOT = scratch('tpm-task-attr-');
let seq = 0;
function dirs() {
  const base = path.join(ROOT, 'case-' + (seq++));
  const tasks = path.join(base, 'tasks'); const sessions = path.join(base, 'sessions');
  fs.mkdirSync(base, { recursive: true }); fs.mkdirSync(sessions, { recursive: true });
  return { base, tasks, sessions };
}
/** Run tpm-task.js as a Claude instance; env is EXPLICIT (never inherited). */
function run(d, args, o) {
  const x = o || {};
  const env = { PATH: process.env.PATH };
  if (x.id !== null) env.CLAUDE_CODE_SESSION_ID = x.id || 'idMe';
  if (x.id !== null) env.CLAUDE_PID = String(x.pid || 4242);
  if (x.sessionsDir !== null) env.TPM_SESSIONS_DIR = x.sessionsDir || d.sessions;
  Object.assign(env, x.env || {});
  const argv = x.noTasksDir ? args : args.concat(['--tasks-dir', d.tasks]);
  const r = spawnSync(process.execPath, [TPMTASK, ...argv], { encoding: 'utf8', env, cwd: d.base, timeout: 20000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const ok = (r, msg) => assert.strictEqual(r.code, 0, (msg || '') + ' exit ' + r.code + ' ' + r.stderr);
const evs = (d, id) => bodyJson(d.tasks, id).history;
const last = (d, id) => evs(d, id)[evs(d, id).length - 1];
function seedTrack(d, n, t, owner, extra) { return H.putTrack(d.sessions, n, t, Object.assign({ owner }, extra || {})); }
function firstTask(d, args) { ok(run(d, ['add', '--headline', 'one'].concat(args || [])), 'add'); }

// ── model level ─────────────────────────────────────────────────────────────────────────────────
test('M-1 setAttribution validates; _pushHistory stamps both keys together; unset leaves events byte-identical', () => {
  assert.strictEqual(model.setAttribution({ session: 'session-0001', sessionVia: 'bogus' }), null);
  assert.strictEqual(model.setAttribution({ session: '', sessionVia: 'env' }), null);
  assert.strictEqual(model.setAttribution(null), null);
  const plain = model.openTask({ headline: 'x', id: 5 });
  assert.ok(!('session' in plain.history[0]) && !('sessionVia' in plain.history[0]), 'unset: today\'s event byte for byte');
  assert.deepStrictEqual(Object.keys(plain.history[0]), ['at', 'op']);
  model.setAttribution({ session: 'session-0040b', sessionVia: 'lookup' });
  try {
    let r = model.openTask({ headline: 'y', id: 6 });
    assert.deepStrictEqual(Object.keys(r.history[0]), ['at', 'op', 'session', 'sessionVia']);
    const e = model.appendHistory(r, { op: 'edit', field: 'headline', value: 'z' });
    const ev = e.history[e.history.length - 1];
    assert.strictEqual(ev.session, 'session-0040b'); assert.strictEqual(ev.sessionVia, 'lookup');
    const own = model.appendHistory(r, { op: 'edit', field: 'headline', value: 'z', session: 'session-0001' });
    const oev = own.history[own.history.length - 1];
    assert.strictEqual(oev.session, 'session-0001'); assert.ok(!('sessionVia' in oev), 'a caller-supplied session is never overwritten and gets no via');
    model.setHistoryEnabled(false);
    assert.strictEqual(model.openTask({ headline: 'g', id: 7 }).history.length, 0, 'gate off writes nothing');
  } finally { model.setHistoryEnabled(true); model.setAttribution(null); }
});

// ── CLI stamping: every event-writing verb ─────────────────────────────────────────────────────────
test('C-1 every event-writing verb stamps session + sessionVia (lookup rung), keys together, stored form prefixed', () => {
  const d = dirs(); seedTrack(d, '0040', 'b', 'idMe');
  ok(run(d, ['add', '--headline', 'one']), 'add');
  const want = { session: 'session-0040b', sessionVia: 'lookup' };
  const check = (label, id) => { const e = last(d, id); assert.strictEqual(e.session, want.session, label); assert.strictEqual(e.sessionVia, want.sessionVia, label); };
  check('add', 1000);
  ok(run(d, ['edit', '1000', '--headline', 'two'])); check('edit', 1000);
  ok(run(d, ['add-subtask', '1000', 'A', '--text', 'st'])); check('add-subtask', 1000);
  ok(run(d, ['check', '1000', 'A'])); check('check', 1000);
  ok(run(d, ['label', '1000', 'foo'])); check('label', 1000);
  ok(run(d, ['unlabel', '1000', 'foo'])); check('unlabel', 1000);
  fs.writeFileSync(path.join(d.base, 'imp.json'), JSON.stringify({ headline: 'imported' }));
  ok(run(d, ['import', '1000', '--file', path.join(d.base, 'imp.json')])); check('import', 1000);
  for (const [verb, extra] of [['start', []], ['finish', []], ['reopen', []], ['drop', []], ['reopen', []], ['remove', []], ['reopen', []]]) {
    ok(run(d, [verb, '1000'].concat(extra)), verb); check(verb, 1000);
  }
  for (const e of evs(d, 1000)) {
    assert.strictEqual('session' in e, 'sessionVia' in e, 'both keys or neither');
    assert.ok(e.session.startsWith('session-'), 'never the bare form: ' + e.session);
  }
  assert.ok(!JSON.stringify(evs(d, 1000)).includes('"0040b"'), 'bare form never stored');
});

test('C-2 track a is stored as session-0012 (no letter); a lookup with no match writes NO keys', () => {
  const d = dirs(); seedTrack(d, '0012', 'a', 'idMe');
  firstTask(d);
  assert.strictEqual(last(d, 1000).session, 'session-0012');
  const d2 = dirs();
  ok(run(d2, ['add', '--headline', 'x']));
  assert.deepStrictEqual(Object.keys(last(d2, 1000)), ['at', 'op'], 'blank omits BOTH keys (no null)');
});

test('C-3 flags in BOTH positions, both spellings; explicit flag beats env and lookup', () => {
  const d = dirs(); seedTrack(d, '0040', 'a', 'idMe');
  firstTask(d);
  ok(run(d, ['--session', '12b', 'start', '1000'], { env: { TPM_SESSION_ID: '41' } }));
  assert.deepStrictEqual([last(d, 1000).session, last(d, 1000).sessionVia], ['session-0012b', 'flag']);
  ok(run(d, ['edit', '1000', '--headline', 'q', '--session', '0012', '--track', 'c']));
  assert.strictEqual(last(d, 1000).session, 'session-0012c');
  ok(run(d, ['edit', '1000', '--headline', 'q2', '--track', 'd', '--session', '12']));
  assert.strictEqual(last(d, 1000).session, 'session-0012d');
  ok(run(d, ['edit', '1000', '--headline', 'q3', '--session', 'session-0012b', '--track', 'b']));
  assert.strictEqual(last(d, 1000).session, 'session-0012b');
  ok(run(d, ['edit', '1000', '--headline', 'q4', '--session', '0012'])); assert.strictEqual(last(d, 1000).session, 'session-0012', 'no track given = a');
  ok(run(d, ['edit', '1000', '--headline', 'q5'], { env: { TPM_SESSION_ID: '41b' } }));
  assert.deepStrictEqual([last(d, 1000).session, last(d, 1000).sessionVia], ['session-0041b', 'env'], 'env beats the disagreeing lookup');
  ok(run(d, ['edit', '1000', '--headline', 'q6'], { env: { TPM_SESSION_ID: 'garbage' } }));
  assert.deepStrictEqual([last(d, 1000).session, last(d, 1000).sessionVia], ['session-0040', 'lookup'], 'malformed env is silently unset');
});

test('C-4 two Claude ids, two tracks on ONE store -> events carry session-0040 vs session-0040b', () => {
  const d = dirs(); seedTrack(d, '0040', 'a', 'idA'); seedTrack(d, '0040', 'b', 'idB');
  ok(run(d, ['add', '--headline', 'a'], { id: 'idA', pid: 111 }));
  ok(run(d, ['add', '--headline', 'b'], { id: 'idB', pid: 222 }));
  ok(run(d, ['edit', '1000', '--headline', 'a2'], { id: 'idB', pid: 222 }));
  assert.strictEqual(evs(d, 1000)[0].session, 'session-0040');
  assert.strictEqual(evs(d, 1001)[0].session, 'session-0040b');
  assert.strictEqual(last(d, 1000).session, 'session-0040b');
});

test('C-5 history gate off: no event, no resolution (the sessions dir is never read); gate on reads it (positive control)', () => {
  const d = dirs(); seedTrack(d, '0040', 'a', 'idMe');
  const saved = { id: process.env.CLAUDE_CODE_SESSION_ID, sd: process.env.TPM_SESSIONS_DIR };
  process.env.CLAUDE_CODE_SESSION_ID = 'idMe'; process.env.TPM_SESSIONS_DIR = d.sessions;
  const realReaddir = fs.readdirSync; const realErr = process.stderr.write;
  let reads = 0;
  fs.readdirSync = function spy(p, ...rest) { if (String(p).startsWith(d.sessions)) reads += 1; return realReaddir.call(fs, p, ...rest); };
  process.stderr.write = () => true;
  try {
    const t = require('../tpm-task.js');
    assert.strictEqual(t.main(['--history', 'off', 'add', '--headline', 'x', '--tasks-dir', d.tasks]), 0);
    assert.strictEqual(reads, 0, 'gate off: the sessions dir is not read');
    assert.strictEqual(evs(d, 1000).length, 0, 'gate off: no event');
    assert.strictEqual(t.main(['--history', 'on', 'add', '--headline', 'y', '--tasks-dir', d.tasks]), 0);
    assert.ok(reads > 0, 'gate on: the lookup read the sessions dir');
    assert.strictEqual(last(d, 1001).session, 'session-0040');
  } finally {
    fs.readdirSync = realReaddir; process.stderr.write = realErr;
    for (const [k, v] of [['CLAUDE_CODE_SESSION_ID', saved.id], ['TPM_SESSIONS_DIR', saved.sd]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    model.setHistoryEnabled(true);
  }
});

// ── history rendering ──────────────────────────────────────────────────────────────────────────────
test('H-1 history text shows [session-…] as stored; lines without the key are byte-identical; --json verbatim', () => {
  const d = dirs(); seedTrack(d, '0041', 'a', 'idMe');
  firstTask(d);
  // an old (unattributed) event appended by hand
  const bp = model.bodyPathFor(d.tasks, '1000');
  const rec = JSON.parse(fs.readFileSync(bp, 'utf8'));
  const body = rec.payload || rec;
  (body.history).push({ at: '2026-01-01T00:00:00-07:00', op: 'state', from: 'open', to: 'in-progress' });
  fs.writeFileSync(bp, JSON.stringify(rec, null, 2) + '\n');
  const h = run(d, ['history', '1000']);
  ok(h);
  const lines = h.stdout.trim().split('\n');
  assert.match(lines[0], /^\S+  create  \[session-0041\]$/);
  assert.strictEqual(lines[1], '2026-01-01T00:00:00-07:00  state open → in-progress');
  const j = JSON.parse(run(d, ['history', '1000', '--json']).stdout);
  assert.strictEqual(j[0].session, 'session-0041'); assert.strictEqual(j[0].sessionVia, 'lookup');
  assert.ok(!('session' in j[1]));
});

// ── list --session ───────────────────────────────────────────────────────────────────────────────────
test('L-1 list --session matrix: bare number = all tracks, letter pins, a pins track a, none-match, --label/--state compose', () => {
  const d = dirs();
  ok(run(d, ['add', '--headline', 'T-a', '--label', 'x', '--session', '12']));     // 1000 -> session-0012
  ok(run(d, ['add', '--headline', 'T-b', '--label', 'y', '--session', '12b']));    // 1001 -> session-0012b
  ok(run(d, ['add', '--headline', 'T-c', '--session', '13']));                     // 1002 -> session-0013
  ok(run(d, ['add', '--headline', 'T-none'], { id: null, sessionsDir: null }));    // 1003 -> blank
  ok(run(d, ['edit', '1002', '--headline', 'T-c2', '--session', '12b']));          // 1002 touched by 12b too
  const rows = (args) => (run(d, ['list'].concat(args)).stdout.match(/^\| (\d+) \|/gm) || []).map((s) => s.replace(/\D/g, ''));
  assert.deepStrictEqual(rows(['--session', '12']), ['1000', '1001', '1002']);
  assert.deepStrictEqual(rows(['--session', '0012']), ['1000', '1001', '1002']);
  assert.deepStrictEqual(rows(['--session', '12a']), ['1000']);
  assert.deepStrictEqual(rows(['--session', '12b']), ['1001', '1002']);
  assert.deepStrictEqual(rows(['--session', '12', '--track', 'b']), ['1001', '1002']);
  assert.deepStrictEqual(rows(['--session', 'session-0013']), ['1002']);
  assert.deepStrictEqual(rows(['--session', '99']), []);
  assert.deepStrictEqual(rows(['--session', '12', '--label', 'y']), ['1001']);
  ok(run(d, ['start', '1000', '--session', '12']));
  ok(run(d, ['finish', '1000', '--session', '12']));
  assert.deepStrictEqual(rows(['--session', '12']), ['1001', '1002'], 'default state pool open+in-progress');
  assert.deepStrictEqual(rows(['--session', '12', '--state', 'finished']), ['1000']);
  assert.deepStrictEqual(rows(['--session', '12', '--state', 'all']), ['1000', '1001', '1002']);
  const r = run(d, ['list', '--session', 'junk']); assert.strictEqual(r.code, 2);
});

test('L-2 list --session: nothing extra is stored; an unreadable body is skipped and named on stderr; stdout unaffected', () => {
  const d = dirs();
  ok(run(d, ['add', '--headline', 'A', '--session', '12']));
  ok(run(d, ['add', '--headline', 'B', '--session', '12']));
  const before = fs.readdirSync(d.tasks).sort().join();
  const idxBefore = fs.readFileSync(indexPath(d.tasks), 'utf8');
  const bp = model.bodyPathFor(d.tasks, '1001');
  fs.writeFileSync(bp, '{ truncated');
  const r = run(d, ['list', '--session', '12']);
  ok(r);
  assert.deepStrictEqual((r.stdout.match(/^\| (\d+) \|/gm) || []).map((s) => s.replace(/\D/g, '')), ['1000']);
  assert.match(r.stderr, /tpm-task list: skipped 1 unreadable task\(s\) \(--session needs their history\): #1001/);
  assert.strictEqual(fs.readdirSync(d.tasks).sort().join(), before);
  assert.strictEqual(fs.readFileSync(indexPath(d.tasks), 'utf8'), idxBefore, 'list --session never writes');
  assert.ok(!/session/.test(idxBefore), 'no second copy of the link in the index');
});

// ── exit 2 ─────────────────────────────────────────────────────────────────────────────────────────
test('X-1 malformed / disagreeing / valueless explicit flags exit 2, nothing written, no .lock', () => {
  const d = dirs();
  firstTask(d);
  const snap = () => {
    const out = {};
    (function walk(p) { for (const n of fs.readdirSync(p)) { const f = path.join(p, n); if (fs.statSync(f).isDirectory()) { out[f + '/'] = 1; walk(f); } else out[f] = fs.readFileSync(f, 'utf8'); } }(d.tasks));
    return JSON.stringify(out);
  };
  const before = snap();
  const bad = [
    ['edit', '1000', '--headline', 'z', '--session', 'junk'], ['edit', '1000', '--headline', 'z', '--session', '0012B'],
    ['edit', '1000', '--headline', 'z', '--session', ''], ['edit', '1000', '--headline', 'z', '--session', '0012', '--track', 'B'],
    ['edit', '1000', '--headline', 'z', '--track', 'b'], ['edit', '1000', '--headline', 'z', '--session', '0012b', '--track', 'c'],
    ['edit', '1000', '--headline', 'z', '--session'], ['start', '1000', '--session', '99999'], ['add', '--headline', 'n', '--session', '0'],
    ['list', '--session', 'x'], ['history', '1000', '--track', 'b'], ['--session', 'nope', 'reindex'],
  ];
  for (const a of bad) {
    const r = run(d, a);
    assert.strictEqual(r.code, 2, a.join(' ') + ' -> ' + r.code + ' ' + r.stderr);
    assert.match(r.stderr, /--session|--track/);
    assert.strictEqual(r.stdout.includes('Tasks'), false);
    assert.strictEqual(snap(), before, 'store bytes unchanged after ' + a.join(' '));
    assert.ok(!fs.existsSync(path.join(d.tasks, '.lock')), 'no .lock');
  }
});

// ── doctor (DoD F) ───────────────────────────────────────────────────────────────────────────────────
test('D-1 doctor reports an attributed store, an old-events store and a mixed store all clean', () => {
  const doctor = (d) => spawnSync(process.execPath, [DOCTOR, '--tasks-dir', d.tasks], { encoding: 'utf8', env: { PATH: process.env.PATH }, cwd: d.base });
  const d = dirs();
  ok(run(d, ['add', '--headline', 'attributed', '--session', '12b']));
  let r = doctor(d); assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  ok(run(d, ['add', '--headline', 'old'], { id: null, sessionsDir: null }));    // blank: old-shape events
  assert.deepStrictEqual(Object.keys(evs(d, 1001)[0]), ['at', 'op']);
  r = doctor(d); assert.strictEqual(r.status, 0, 'mixed: ' + r.stdout + r.stderr);
  const d2 = dirs();
  ok(run(d2, ['add', '--headline', 'old only'], { id: null, sessionsDir: null }));
  r = doctor(d2); assert.strictEqual(r.status, 0, 'old only: ' + r.stdout + r.stderr);
});

test('D-2 the migrate seed event stays unattributed (a conversion, not a session act)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tpm-task-migrate.js'), 'utf8');
  assert.ok(!/setAttribution|attribution/.test(src));
});

done('task-attribution.test.js');
