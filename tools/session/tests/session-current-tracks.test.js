'use strict';
/**
 * session-current-tracks.test.js — resolution by Claude session id, the open gate's refusal of a foreign
 * unsealed track, the kept-true hint, the track-aware --seal, supersession, the O-3 upgrade aid. DoD E, F.
 * In-process calls use an INJECTED identity (a second Claude instance without touching the env); CLI calls
 * play an instance by setting CLAUDE_CODE_SESSION_ID on that one child. Hermetic; exits non-zero on failure.
 * Run: node tests/session-current-tracks.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const crypto = require('crypto');
const H = require('./helpers/track-helpers');
const cs = require('../tpm-session-current');
const { T, model } = H;

// A snapshot of every file under dir -> sha256, to prove "nothing was written".
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  };
  walk(dir);
  return out;
}

test('T-R1 resolve by Claude session id: the unsealed track whose owner id equals mine (state, number, track)', () => {
  const sd = tmpDir('cur-r1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const s = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.deepStrictEqual([s.state, s.number, s.track, s.sessionId], ['open', '0001', 'a', 'idA']);
  const o = cs.openSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.deepStrictEqual([o.number, o.track, o.isNew, o.resumed, o.gate], ['0001', 'a', false, true, 'resume']);
});

test('T-R2 two ids, two tracks of one session: each finds its OWN (a vs b), by id, not by order', () => {
  const sd = tmpDir('cur-r2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  const a = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idA') });
  const b = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idB') });
  assert.deepStrictEqual([a.state, a.track, b.state, b.track], ['open', 'a', 'open', 'b']);
  assert.strictEqual(path.basename(cs.openSession({ sessionsDir: sd, identity: H.id('idB') }).recordPath), 'session-0001-b.json');
  assert.deepStrictEqual(b.foreign.map((f) => f.track), ['a'], 'the other instance\'s track is listed as foreign');
});

test('T-R3 (DoD F) a foreign unsealed track is NEVER silently joined: exit 3, names it, JSON on stdout, nothing written', () => {
  const sd = tmpDir('cur-r3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  T.writeHint(sd);
  const before = snapshot(sd);
  const r = H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idZ' });
  assert.strictEqual(r.code, 3, r.stderr);
  assert.ok(/another Claude session/.test(r.stderr) && /track a of 0001/.test(r.stderr), r.stderr);
  assert.ok(/idA/.test(r.stderr.slice(0, 400)) || /owner idA/.test(r.stderr), 'owner shown (first 8 chars of its id)');
  const j = JSON.parse(r.stdout);
  assert.deepStrictEqual([j.refused, j.code, j.tracks.map((t) => [t.number, t.track]), Array.isArray(j.skipped)], [true, 'ESESSION_FOREIGN_TRACK', [['0001', 'a']], true]);
  assert.deepStrictEqual(snapshot(sd), before, 'nothing was written, not even the hint');
  const st = JSON.parse(H.run(H.CURRENT, ['--sessions-dir', sd, '--state'], { id: 'idZ' }).stdout);
  assert.strictEqual(st.state, 'foreign-open', '--state never reports the foreign track as mine: it is the third state, foreign-open');
  assert.strictEqual(st.number, null);
});

test('T-R4 caller id UNREADABLE: exactly one unsealed track -> resumed; two -> ESESSION_AMBIGUOUS (exit 3)', () => {
  const one = tmpDir('cur-r4-');
  H.putTrack(one, '0001', 'a', { owner: 'idA' });
  assert.strictEqual(cs.openSession({ sessionsDir: one, identity: H.id(null) }).number, '0001');
  const two = tmpDir('cur-r4b-');
  H.putTrack(two, '0001', 'a', { owner: 'idA' });
  H.putTrack(two, '0001', 'b', { owner: 'idB' });
  assert.throws(() => cs.openSession({ sessionsDir: two, identity: H.id(null) }), (e) => e.code === 'ESESSION_AMBIGUOUS' && e.exitCode === 3);
  const r = H.run(H.CURRENT, ['--sessions-dir', two, '--open'], {});
  assert.strictEqual(r.code, 3);
  assert.strictEqual(JSON.parse(r.stdout).code, 'ESESSION_AMBIGUOUS');
});

test('T-R5 a record with NO owner id never blocks: a single unowned track is resumed (and not rewritten)', () => {
  const sd = tmpDir('cur-r5-');
  const jp = H.putTrack(sd, '0001', 'a', { owner: null });
  const before = fs.readFileSync(jp, 'utf8');
  const o = cs.openSession({ sessionsDir: sd, identity: H.id('idNew') });
  assert.deepStrictEqual([o.number, o.isNew], ['0001', false]);
  assert.strictEqual(fs.readFileSync(jp, 'utf8'), before, 'open itself does not claim the unowned record');
});

test('T-R6 an unreadable-but-unsealed track BLOCKS an open and is listed (never silently skipped)', () => {
  const sd = tmpDir('cur-r6-');
  H.putRaw(sd, '0001', 'session-0001-b.json', 'corrupt{');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true });
  const st = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.strictEqual(st.state, 'foreign-open', 'an unreadable-unsealed track blocks: the third state');
  assert.deepStrictEqual(st.skipped.map((s) => [s.number, s.track, s.reason]), [['0001', 'b', 'corrupt']]);
  assert.deepStrictEqual(st.foreign.map((f) => [f.track, f.state, f.reason]), [['b', 'unreadable', 'corrupt']]);
  assert.throws(() => cs.openSession({ sessionsDir: sd, identity: H.id('idA') }), (e) => e.code === 'ESESSION_FOREIGN_TRACK' && /unreadable/.test(e.message));
});

test('T-R7 a marker-sealed track does NOT block: the open allocates a new session', () => {
  const sd = tmpDir('cur-r7-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  H.putMarker(sd, '0001', 'a');
  const o = cs.openSession({ sessionsDir: sd, identity: H.id('idZ') });
  assert.deepStrictEqual([o.number, o.track, o.isNew, o.gate], ['0002', 'a', true, 'new-session']);
});

test('T-R8 (DoD E) --seal with a track still live leaves the hint OPEN; once all are sealed it closes', () => {
  const sd = tmpDir('cur-r8-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  T.writeHint(sd);
  const s1 = cs.sealSession({ sessionsDir: sd });
  assert.deepStrictEqual([s1.hintClosed, s1.closedAt, s1.unsealed], [false, null, [{ number: '0001', track: 'b' }]]);
  assert.strictEqual(JSON.parse(fs.readFileSync(T.hintPath(sd), 'utf8')).closedAt, null, 'the kept pointer stays TRUE');
  model.saveSession(model.closeSession(model.loadSession(T.trackPaths(sd, '0001', 'b').jsonPath)), { jsonPath: T.trackPaths(sd, '0001', 'b').jsonPath });
  const s2 = cs.sealSession({ sessionsDir: sd });
  assert.strictEqual(s2.hintClosed, true);
  assert.ok(JSON.parse(fs.readFileSync(T.hintPath(sd), 'utf8')).closedAt);
});

test('T-R8b the hint keeps its four-key shape and `close` (opClose) refreshes it when track a closes while b is live', () => {
  const sd = tmpDir('cur-r8b-');
  const ops = require('../tpm-session-ops');
  const idA = H.id('idA');
  const o = cs.openSession({ sessionsDir: sd, identity: idA });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  ops.opNote({ sessionsDir: sd, number: '0001', track: 'a', identity: idA, type: 'log', status: 'NOTE', text: 'hi' });
  ops.opImportHandoff({ sessionsDir: sd, number: '0001', track: 'a', identity: idA, jsonFile: (() => { const f = path.join(tmpDir('hf-'), 'h.json'); fs.writeFileSync(f, JSON.stringify({ where: 'w', next: 'n' })); return f; })() });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'a', identity: idA, action: 'add', text: 'x' });
  ops.opClose({ sessionsDir: sd, number: '0001', track: 'a', identity: idA });
  const hint = JSON.parse(fs.readFileSync(T.hintPath(sd), 'utf8'));
  assert.deepStrictEqual(Object.keys(hint).sort(), ['closedAt', 'number', 'openedAt', 'sessionId']);
  assert.strictEqual(hint.closedAt, null, 'track a closed but b is live -> the hint stays open (the close.md:16 bug)');
  assert.strictEqual(o.number, '0001');
});

test('T-R9 a legacy unsealed record BELOW the newest session is superseded: it does not block --open', () => {
  const sd = tmpDir('cur-r9-');
  H.putTrack(sd, '0001', 'a', { legacy: true, owner: 'old-id' });         // never `close`d, pre-tracks
  H.putTrack(sd, '0002', 'a', { owner: 'x', sealed: true });
  const st = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idNew') });
  assert.deepStrictEqual(st.superseded.map((s) => s.number), ['0001']);
  assert.strictEqual(st.foreign.length, 0);
  const o = cs.openSession({ sessionsDir: sd, identity: H.id('idNew') });
  assert.deepStrictEqual([o.number, o.isNew], ['0003', true]);
});

test('T-R10 O-3: an OPEN hint naming this caller, whose folder holds no track file, gets its record in the SAME number', () => {
  const sd = tmpDir('cur-r10-');
  fs.mkdirSync(path.join(sd, 'session-0005'), { recursive: true });       // pointer-only session (old boot flaw)
  fs.writeFileSync(T.hintPath(sd), JSON.stringify({ sessionId: 'idA', number: '0005', openedAt: '2026-10-07T17:00:00.000Z', closedAt: null }));
  const o = cs.openSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.deepStrictEqual([o.number, o.track, o.isNew], ['0005', 'a', true]);
  assert.ok(fs.existsSync(path.join(sd, 'session-0005', 'session-0005.json')));
  assert.deepStrictEqual(fs.readdirSync(sd).filter((n) => /^session-/.test(n)), ['session-0005'], 'no second number minted');
  // ...and the aid is one-way: a hint naming SOMEONE ELSE is not used.
  const sd2 = tmpDir('cur-r10b-');
  fs.mkdirSync(path.join(sd2, 'session-0005'), { recursive: true });
  fs.writeFileSync(T.hintPath(sd2), JSON.stringify({ sessionId: 'idOther', number: '0005', openedAt: '2026-10-07T17:00:00.000Z', closedAt: null }));
  assert.strictEqual(cs.openSession({ sessionsDir: sd2, identity: H.id('idA') }).number, '0006');
});

test('T-R11 a corrupt hint is ignored by --state and repaired by --open; it never decides', () => {
  const sd = tmpDir('cur-r11-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  fs.writeFileSync(T.hintPath(sd), '{ not json');
  const st = JSON.parse(H.run(H.CURRENT, ['--sessions-dir', sd, '--state'], { id: 'idA' }).stdout);
  assert.deepStrictEqual([st.state, st.number, st.hint.present, st.hint.ok], ['open', '0001', true, false]);
  const o = H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idA' });
  assert.strictEqual(o.code, 0, o.stderr);
  assert.strictEqual(T.readHint(sd).ok, true, 'repaired from the tracks');
  // a hint that LIES (says closed while a track is live, or names another number) changes nothing
  fs.writeFileSync(T.hintPath(sd), JSON.stringify({ sessionId: 'zzz', number: '0099', openedAt: '2026-10-07T17:00:00.000Z', closedAt: '2026-10-07T18:00:00.000Z' }));
  const st2 = cs.resolveCurrentSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.deepStrictEqual([st2.state, st2.number, st2.hint.agreesWithTracks], ['open', '0001', false]);
});

test('T-R12 compose: a bare invocation with a foreign-only store routes to OPEN (the refusing path), never to save', () => {
  const sd = tmpDir('cur-r12-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const composeMod = require('../tpm-session-compose');
  const root = tmpDir('cur-r12-root-');
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'idZ';
  try {
    const config = require('../../lib/tpm-config-overlay').loadDefaults();
    const r = composeMod.compose('', { config, projectRoot: root, pickup: 'PICKUP-TEXT', sessionsDir: sd, env: {} });
    assert.strictEqual(r.mode, 'open');
    assert.ok(!r.warnings.some((w) => /session-state-unreadable/.test(w)), 'a refusal-state store is not an unreadable one');
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

test('T-R13 --open creates the record exactly once and writes the kept-true hint; a repeat is idempotent', () => {
  const sd = tmpDir('cur-r13-');
  const a = cs.openSession({ sessionsDir: sd, identity: H.id('idA') });
  const hint1 = fs.readFileSync(T.hintPath(sd), 'utf8');
  const rec1 = fs.readFileSync(a.recordPath, 'utf8');
  const b = cs.openSession({ sessionsDir: sd, identity: H.id('idA') });
  assert.deepStrictEqual([b.isNew, b.number], [false, '0001']);
  assert.strictEqual(fs.readFileSync(T.hintPath(sd), 'utf8'), hint1);
  assert.strictEqual(fs.readFileSync(a.recordPath, 'utf8'), rec1, 'a resumed open never rewrites the record');
  assert.strictEqual(JSON.parse(hint1).closedAt, null);
});

done('session-current-tracks.test');
