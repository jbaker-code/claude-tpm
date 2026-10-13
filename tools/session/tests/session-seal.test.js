'use strict';
/**
 * session-seal.test.js — phase 09: own-track close, a session sealed when every track is, the abandoned seal of
 * ANOTHER instance's track (a `.sealed` marker; confirmation always required; no handoff fabricated; who/when
 * recorded), the live owner's loud refusal after being sealed + the un-seal path, `current --open --seal-and-new`,
 * the skill text that asks first, and the "one trackState" guarantee. In-process calls inject an identity; CLI calls
 * play a Claude instance by setting CLAUDE_CODE_SESSION_ID / CLAUDE_PID on that one child. Hermetic (scratch dirs);
 * exits non-zero on failure.
 * Run: node tests/session-seal.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const H = require('./helpers/track-helpers');
const cs = require('../tpm-session-current');
const ops = require('../tpm-session-ops');
const { processStartedAt } = require('../../lib/identity');
const { T, model } = H;

const HOST = os.hostname();
const MY_PID = process.pid;
const MY_START = processStartedAt(MY_PID);
const HANDOFF = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(r.stdout);
}
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
const caller = (sid, extra) => H.id(sid, Object.assign({ hostname: HOST }, extra || {}));
const runningOwner = () => ({ hostname: HOST, claudePid: MY_PID, claudePidStartedAt: MY_START });
const goneOwner = () => ({ hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START });
const cur = (sd, args, o) => H.run(H.CURRENT, ['--sessions-dir', sd, ...args], o);
const op = (sd, args, o) => H.run(H.OPS, [args[0], '--sessions-dir', sd, ...args.slice(1)], o);
const state = (sd, o) => JSON.parse(cur(sd, ['--state'], o).stdout);
const loadRec = (sd, n, t) => model.loadSession(T.trackPaths(sd, n, t).jsonPath);
const refusal = (fn) => { try { fn(); } catch (e) { return e; } assert.fail('expected a refusal'); return null; };

// A real store: track a owned by idA (a live pid), track b owned by idB (a dead pid), both saved with content.
function twoTracks(prefix) {
  const sd = tmpDir(prefix);
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: goneOwner(), handoff: HANDOFF });
  return sd;
}

// ── A: close seals only the caller's track ─────────────────────────────────────────────────────────

test('A1 close by the owner of track b seals b; every other record in the folder is byte-identical; the guard still applies', () => {
  const sd = twoTracks('seal-a1-');
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'b', action: 'add', text: 'x', identity: caller('idB') });
  const before = snapshot(sd);
  const r = op(sd, ['close', '--session', '1'], { id: 'idB' });
  assert.strictEqual(r.code, 0, r.stderr);
  const after = snapshot(sd);
  for (const f of Object.keys(before)) {
    if (/session-0001-b\.(json|md)$/.test(f) || f === '.current-session.json') continue;
    assert.strictEqual(after[f], before[f], `${f} unchanged`);
  }
  assert.ok(loadRec(sd, '0001', 'b').meta.closedAt, 'b sealed');
  assert.strictEqual(loadRec(sd, '0001', 'a').meta.closedAt, null, 'a not sealed');
  // the guard: track a has a handoff but no punchlist item -> refuses, nothing written
  const snap2 = snapshot(sd);
  const g = op(sd, ['close', '--session', '1'], { id: 'idA' });
  assert.strictEqual(g.code, 1);
  assert.ok(/missing a punchlist/.test(g.stderr), g.stderr);
  assert.deepStrictEqual(snapshot(sd), snap2);
});

// ── B: a session is sealed when every track is ─────────────────────────────────────────────────────

test('B1 a sealed + b unsealed: open for b\'s owner, foreign-open for everyone else (incl. a\'s owner); both sealed: not-opened and the next open allocates a new number', () => {
  const sd = tmpDir('seal-b1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF, sealed: true });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: runningOwner(), handoff: HANDOFF });
  assert.strictEqual(state(sd, { id: 'idB' }).state, 'open');
  assert.strictEqual(state(sd, { id: 'idB' }).track, 'b');
  assert.strictEqual(state(sd, { id: 'idA' }).state, 'foreign-open');
  assert.strictEqual(state(sd, { id: 'idZ' }).state, 'foreign-open');
  const sum = T.sessionSummary(sd, '0001');
  assert.strictEqual(sum.sealed, false);
  assert.deepStrictEqual(sum.unsealed.map((s) => s.track), ['b']);
  // now seal b (by marker this time - the same answer from the same function)
  T.sealByMarker(sd, '0001', 'b', { by: caller('idZ'), confirm: true });
  const sum2 = T.sessionSummary(sd, '0001');
  assert.strictEqual(sum2.sealed, true);
  for (const id of ['idA', 'idB', 'idZ']) assert.strictEqual(state(sd, { id }).state, 'not-opened', id);
  const o = cur(sd, ['--open'], { id: 'idZ' });
  assert.strictEqual(o.code, 0, o.stderr);
  assert.deepStrictEqual([JSON.parse(o.stdout).number, JSON.parse(o.stdout).track], ['0002', 'a']);
});

// ── C: the abandoned seal ──────────────────────────────────────────────────────────────────────────

test('C1 without the confirmation flag: prints what would be sealed (track, last write, liveness), exits 4, writes NOTHING', () => {
  const sd = twoTracks('seal-c1-');
  const before = snapshot(sd);
  const r = op(sd, ['close', '--session', '1', '--track', 'b'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r.code, 4, r.stderr);
  assert.deepStrictEqual(snapshot(sd), before);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.sealed, false);
  assert.strictEqual(out.plan.track, 'b');
  assert.ok(out.plan.lastWriteAt, 'last write shown');
  assert.strictEqual(out.plan.liveness, 'gone');
  assert.ok(/owner process gone/.test(r.stderr) && /last write/.test(r.stderr) && /NOTHING was sealed/.test(r.stderr), r.stderr);
});

test('C2 with --even-if-running: a marker is written (who/when/owner/last save), the record + md are byte-identical, no handoff fabricated, the hint is refreshed', () => {
  const sd = tmpDir('seal-c2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  // track b: NO handoff at all - the abandoned seal must not invent one
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: goneOwner() });
  cur(sd, ['--state'], { id: 'idA' });
  T.writeHint(sd);
  const p = T.trackPaths(sd, '0001', 'b');
  const jsonBefore = fs.readFileSync(p.jsonPath, 'utf8');
  const mdBefore = fs.readFileSync(p.mdPath, 'utf8');
  const r = op(sd, ['close', '--session', '1', '--track', 'b', '--reason', 'train died', '--even-if-running'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(p.jsonPath, 'utf8'), jsonBefore, 'record untouched');
  assert.strictEqual(fs.readFileSync(p.mdPath, 'utf8'), mdBefore, 'md untouched');
  assert.strictEqual(loadRec(sd, '0001', 'b').handoff, null, 'no handoff fabricated');
  assert.strictEqual(loadRec(sd, '0001', 'b').meta.closedAt, null, 'the record itself is never stamped (Q2)');
  const m = JSON.parse(fs.readFileSync(p.sealedPath, 'utf8'));
  assert.strictEqual(m.kind, 'seal-marker');
  assert.strictEqual(m.reason, 'abandoned');
  assert.strictEqual(m.note, 'train died');
  assert.strictEqual(m.track, 'b');
  assert.strictEqual(m.sealedBy.claudeSessionId, 'idZ');
  assert.strictEqual(m.sealedBy.claudePid, MY_PID);
  assert.strictEqual(m.ownerAtSeal.claudeSessionId, 'idB');
  assert.ok(/^\d{4}-\d\d-\d\dT.*([+-]\d\d:\d\d|Z)$/.test(m.sealedAt), m.sealedAt);
  assert.ok(m.lastSaveSeen, 'last save seen recorded');
  const st = T.trackState(sd, '0001', 'b');
  assert.deepStrictEqual([st.state, st.sealedBy, st.sealedAt], ['sealed', 'marker', m.sealedAt]);
  assert.ok(T.readHint(sd).hint, 'hint still readable');
  // idempotent
  const again = op(sd, ['close', '--session', '1', '--track', 'b', '--even-if-running'], { id: 'idY', pid: MY_PID });
  assert.strictEqual(again.code, 0);
  assert.strictEqual(JSON.parse(again.stdout).already, true);
  assert.strictEqual(JSON.parse(fs.readFileSync(p.sealedPath, 'utf8')).sealedBy.claudeSessionId, 'idZ', 'first sealer kept');
});

test('C3 NO own-pid exemption: a RUNNING owner (even the caller\'s own process under a new session id) still needs the flag', () => {
  const sd = tmpDir('seal-c3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  const before = snapshot(sd);
  const r = op(sd, ['close', '--session', '1', '--track', 'a'], { id: 'idNew', pid: MY_PID });   // same pid = the /clear shape
  assert.strictEqual(r.code, 4);
  assert.strictEqual(JSON.parse(r.stdout).plan.liveness, 'running');
  assert.deepStrictEqual(snapshot(sd), before);
  assert.strictEqual(op(sd, ['close', '--session', '1', '--track', 'a', '--even-if-running'], { id: 'idNew', pid: MY_PID }).code, 0);
});

test('C4 refusals: own track (ESEAL_SELF, use close), missing track, bad letter; --even-if-running / --reason on an ordinary close', () => {
  const sd = twoTracks('seal-c4-');
  const self = refusal(() => T.sealByMarker(sd, '0001', 'a', { by: caller('idA'), confirm: true }));
  assert.strictEqual(self.code, 'ESEAL_SELF');
  assert.strictEqual(refusal(() => T.sealByMarker(sd, '0001', 'q', { by: caller('idZ'), confirm: true })).code, 'ENO_TRACK');
  assert.strictEqual(refusal(() => T.sealByMarker(sd, '0001', 'Q', { by: caller('idZ'), confirm: true })).code, 'ETRACK_ARG');
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'a').sealedPath));
  const before = snapshot(sd);
  const r = op(sd, ['close', '--session', '1', '--even-if-running'], { id: 'idA' });   // own track, ordinary close + stray flag
  assert.strictEqual(r.code, 1);
  assert.ok(/only apply to/.test(r.stderr), r.stderr);
  assert.deepStrictEqual(snapshot(sd), before);
});

test('C5 an unreadable (corrupt) track can be sealed by marker; a track the owner already closed needs no marker', () => {
  const sd = tmpDir('seal-c5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: HANDOFF, sealed: true });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: goneOwner() });
  fs.writeFileSync(T.trackPaths(sd, '0001', 'b').jsonPath, '{ not json');
  assert.strictEqual(T.trackState(sd, '0001', 'b').state, 'unreadable');
  const r = T.sealByMarker(sd, '0001', 'b', { by: caller('idZ'), confirm: true });
  assert.strictEqual(r.sealed, true);
  assert.strictEqual(T.trackState(sd, '0001', 'b').sealedBy, 'marker');
  assert.strictEqual(fs.readFileSync(T.trackPaths(sd, '0001', 'b').jsonPath, 'utf8'), '{ not json', 'broken record left exactly as it was');
  const r2 = T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });
  assert.deepStrictEqual([r2.sealed, r2.already], [true, true]);
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'a').sealedPath), 'no marker over a self-closed track');
});

// ── D: the live owner finds out loudly; un-seal ───────────────────────────────────────────────────

test('D1 after its track is sealed by someone else, the owner\'s next save / note / punchlist / import-* refuses naming who sealed it and when; earlier work intact', () => {
  const sd = tmpDir('seal-d1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', ident: runningOwner(), handoff: HANDOFF });
  ops.opNote({ sessionsDir: sd, number: '0001', track: 'a', type: 'log', status: 'NOTE', text: 'precious', identity: caller('idOwner') });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'a', action: 'add', text: 'item', identity: caller('idOwner') });
  const seal = op(sd, ['close', '--session', '1', '--track', 'a', '--even-if-running'], { id: 'idSealer12345', pid: MY_PID });
  assert.strictEqual(seal.code, 0, seal.stderr);
  const marker = JSON.parse(fs.readFileSync(T.trackPaths(sd, '0001', 'a').sealedPath, 'utf8'));
  const before = snapshot(sd);
  const tf = path.join(tmpDir('seal-d1-in-'), 'in.txt');
  fs.writeFileSync(tf, 'text\n');
  const attempts = [
    ['save', '--session', '1'],
    ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'late'],
    ['punchlist', '--session', '1', '--action', 'add', '--text', 'late'],
    ['import-log', '--session', '1', '--file', tf],
    ['import-punchlist', '--session', '1', '--file', tf],
    ['import-handoff', '--session', '1', '--txt-file', tf, '--next', 'n'],
    ['close', '--session', '1'],
    ['save', '--session', '1', '--track', 'a'],
  ];
  for (const a of attempts) {
    const r = op(sd, a, { id: 'idOwner', pid: MY_PID });
    assert.strictEqual(r.code, 1, `${a[0]}: ${r.stderr}`);
    assert.ok(/sealed by another session/.test(r.stderr), a[0] + ': ' + r.stderr);
    assert.ok(r.stderr.includes('idSealer'), 'names the sealer: ' + r.stderr);
    assert.ok(r.stderr.includes(marker.sealedAt), 'names when: ' + r.stderr);
    assert.ok(/tpm session unseal --session 0001 --track a/.test(r.stderr), 'documents the un-seal path');
    assert.strictEqual(JSON.parse(r.stdout).code, 'ETRACK_SEALED');
  }
  assert.deepStrictEqual(snapshot(sd), before, 'nothing written by any refused verb');
  const rec = loadRec(sd, '0001', 'a');
  assert.ok(rec.log.some((e) => e.text === 'precious'), 'earlier note kept');
  assert.strictEqual(rec.punchlist.length, 1, 'earlier punchlist kept');
  // the programmatic API refuses too (not just the CLI)
  assert.strictEqual(refusal(() => ops.opNote({ sessionsDir: sd, number: '0001', track: 'a', type: 'log', status: 'NOTE', text: 'x', identity: caller('idOwner') })).code, 'ETRACK_SEALED');
});

test('D2 un-seal restores the owner: marker moved to a hidden audit file, writes work again, nothing lost; un-sealing again is a no-op', () => {
  const sd = tmpDir('seal-d2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: HANDOFF });
  T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idOwner' }).code, 1);
  const u = op(sd, ['unseal', '--session', '1', '--track', 'a'], { id: 'idOwner' });
  assert.strictEqual(u.code, 0, u.stderr);
  const out = JSON.parse(u.stdout);
  assert.strictEqual(out.unsealed, true);
  assert.ok(fs.existsSync(out.auditPath) && path.basename(out.auditPath).startsWith('.session-0001.sealed.unsealed-'), out.auditPath);
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'a').sealedPath));
  assert.strictEqual(T.trackState(sd, '0001', 'a').state, 'live');
  assert.strictEqual(T.listFolder(sd, '0001').unrecognised.length, 0, 'the audit file is not noise');
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idOwner' }).code, 0);
  assert.strictEqual(op(sd, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'back'], { id: 'idOwner' }).code, 0);
  const u2 = op(sd, ['unseal', '--session', '1', '--track', 'a'], { id: 'idOwner' });
  assert.strictEqual(u2.code, 0);
  assert.strictEqual(JSON.parse(u2.stdout).already, true);
  // the manual path: mv the marker away
  T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });
  fs.renameSync(T.trackPaths(sd, '0001', 'a').sealedPath, path.join(tmpDir('seal-d2-mv-'), 'x'));
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idOwner' }).code, 0);
});

test('D5 the persist step itself refuses when a marker lands between the load and the write (race window): nothing is written', () => {
  const sd = tmpDir('seal-d5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: HANDOFF });
  const loaded = loadRec(sd, '0001', 'a');                  // the owner loaded before the seal ...
  T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });   // ... the sealer lands ...
  const before = snapshot(sd);
  const e = refusal(() => ops.persist(loaded, { sessionsDir: sd, number: '0001', track: 'a', identity: caller('idOwner') }));   // ... the write refuses
  assert.strictEqual(e.code, 'ETRACK_SEALED');
  assert.deepStrictEqual(snapshot(sd), before);
});

test('D3 Q-C7: closing your OWN track never refuses your own later writes (only a track sealed by someone else is guarded)', () => {
  const sd = tmpDir('seal-d3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: HANDOFF });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'a', action: 'add', text: 'i', identity: caller('idOwner') });
  assert.strictEqual(op(sd, ['close', '--session', '1'], { id: 'idOwner' }).code, 0);
  assert.strictEqual(T.trackState(sd, '0001', 'a').sealedBy, 'self');
  const r = op(sd, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'after close'], { id: 'idOwner' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(refusal(() => T.unsealTrack(sd, '0001', 'a')).code, 'EUNSEAL_NOT_MARKER');
});

test('D4 without --track, a write verb by the sealed track\'s owner finds the marker even beside live foreign tracks', () => {
  const sd = twoTracks('seal-d4-');
  T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });
  const r = op(sd, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'x'], { id: 'idA' });
  assert.strictEqual(r.code, 1);
  assert.ok(/sealed by another session/.test(r.stderr), r.stderr);
  assert.ok(!/ETRACK_AMBIGUOUS|belong to another Claude session/.test(r.stderr), r.stderr);
});

// ── E: --seal-and-new ──────────────────────────────────────────────────────────────────────────────

test('E1 --seal-and-new without the flag: exit 4, the tracks it would seal are listed, nothing written', () => {
  const sd = twoTracks('seal-e1-');
  const before = snapshot(sd);
  const r = cur(sd, ['--open', '--seal-and-new'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r.code, 4, r.stderr);
  assert.deepStrictEqual(snapshot(sd), before);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.code, 'ESEAL_NEEDS_CONFIRM');
  assert.deepStrictEqual(out.details.plans.map((p) => p.track), ['a', 'b']);
  assert.deepStrictEqual(out.details.plans.map((p) => p.liveness), ['running', 'gone']);
  assert.ok(/track a/.test(r.stderr) && /track b/.test(r.stderr) && /owner process running/.test(r.stderr), r.stderr);
});

test('E2 --seal-and-new --even-if-running: every foreign unsealed track is marker-sealed (records untouched), the next number is opened for the caller, owners find out', () => {
  const sd = twoTracks('seal-e2-');
  const pa = T.trackPaths(sd, '0001', 'a');
  const pb = T.trackPaths(sd, '0001', 'b');
  const jb = [fs.readFileSync(pa.jsonPath, 'utf8'), fs.readFileSync(pb.jsonPath, 'utf8')];
  const r = cur(sd, ['--open', '--seal-and-new', '--even-if-running'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual([out.number, out.track, out.gate, out.isNewSession], ['0002', 'a', 'seal-and-new', true]);
  assert.deepStrictEqual(out.sealed.map((s) => `${s.number}${s.track}`), ['0001a', '0001b']);
  assert.deepStrictEqual([fs.readFileSync(pa.jsonPath, 'utf8'), fs.readFileSync(pb.jsonPath, 'utf8')], jb, 'records byte-identical');
  for (const p of [pa, pb]) {
    const m = JSON.parse(fs.readFileSync(p.sealedPath, 'utf8'));
    assert.deepStrictEqual([m.reason, m.sealedBy.claudeSessionId], ['seal-and-new', 'idZ']);
  }
  assert.strictEqual(loadRec(sd, '0002', 'a').meta.claudeSessionId, 'idZ');
  assert.strictEqual(state(sd, { id: 'idZ' }).state, 'open');
  assert.strictEqual(state(sd, { id: 'idA' }).state, 'foreign-open', 'idA now sees only Z\'s session');
  const w = op(sd, ['save', '--session', '1'], { id: 'idA' });
  assert.strictEqual(w.code, 1);
  assert.ok(/sealed by another session/.test(w.stderr), w.stderr);
  // idempotent re-run: Z owns an unsealed track now
  assert.strictEqual(JSON.parse(cur(sd, ['--open', '--seal-and-new', '--even-if-running'], { id: 'idZ', pid: MY_PID }).stdout).code, 'ESEAL_HAVE_OPEN');
});

test('E3 --seal-and-new refusals: no session id; caller owns an unsealed track; stray flags; nothing to seal just opens the next session', () => {
  const sd = twoTracks('seal-e3-');
  const before = snapshot(sd);
  const noId = cur(sd, ['--open', '--seal-and-new', '--even-if-running'], {});
  assert.strictEqual(noId.code, 1);
  assert.strictEqual(JSON.parse(noId.stdout).code, 'ESEAL_NO_ID');
  const mine = cur(sd, ['--open', '--seal-and-new', '--even-if-running'], { id: 'idA', pid: MY_PID });
  assert.strictEqual(JSON.parse(mine.stdout).code, 'ESEAL_HAVE_OPEN');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ'), sealAndNew: true, adopt: 'a', evenIfRunning: true })).code, 'ETRACK_ARG');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ'), evenIfRunning: true })).code, 'ETRACK_ARG');
  assert.deepStrictEqual(snapshot(sd), before);
  const empty = tmpDir('seal-e3b-');
  const r = cur(empty, ['--open', '--seal-and-new'], { id: 'idZ' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([JSON.parse(r.stdout).number, JSON.parse(r.stdout).sealed], ['0001', []]);
});

test('E4 --confirm is an accepted alias of --even-if-running on both surfaces', () => {
  const sd = twoTracks('seal-e4-');
  assert.strictEqual(op(sd, ['close', '--session', '1', '--track', 'b', '--confirm'], { id: 'idZ' }).code, 0);
  assert.strictEqual(cur(sd, ['--open', '--seal-and-new', '--confirm'], { id: 'idZ' }).code, 0);
});

// ── F: the skill asks before any abandoned seal ────────────────────────────────────────────────────

test('F1 close and open skill text: show the evidence, ask, explicit yes before the confirmation flag; the first run has no flag', () => {
  const root = path.join(__dirname, '..', '..', '..');
  // phase-20: the multi-track seal guidance moved into a conditional fragment injected into close.md
  const close = fs.readFileSync(path.join(root, 'tools', 'session', 'templates', 'close.md'), 'utf8')
    + fs.readFileSync(path.join(root, 'tools', 'session', 'templates', '_close-multitrack.md'), 'utf8');
  const open = fs.readFileSync(path.join(root, 'tools', 'session', 'templates', 'open.md'), 'utf8');
  const skill = fs.readFileSync(path.join(root, '.claude', 'skills', 'tpm-session', 'SKILL.md'), 'utf8');
  for (const [name, text] of [['close.md', close], ['open.md', open]]) {
    assert.ok(/explicit yes/i.test(text), `${name}: explicit yes`);
    assert.ok(/--even-if-running/.test(text), `${name}: names the confirmation flag`);
    assert.ok(/evidence/i.test(text), `${name}: show the evidence`);
    assert.ok(/WITHOUT/.test(text) && /exits? `?4/.test(text), `${name}: run without the flag first (exit 4)`);
    assert.ok(/owner process running/.test(text), `${name}: call out a running owner`);
    assert.ok(!/NOT available yet/.test(text), `${name}: no stale "not available"`);
  }
  assert.ok(/explicit yes/i.test(skill) && /even-if-running/.test(skill));
  assert.ok(/unseal/.test(close) && /unseal/.test(open));
});

test('F2 the composed output carries the same instruction (foreign-open -> open gate; close mode)', () => {
  const composeMod = require('../tpm-session-compose');
  const config = require('../../lib/tpm-config-overlay').loadDefaults();
  const root = tmpDir('seal-f2-root-');
  const sd = tmpDir('seal-f2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  // a foreign track present -> multi-track guidance is emitted in close (phase-20 conditionalized)
  const closeText = composeMod.compose('close', { config, projectRoot: root, pickup: 'P', sessionsDir: sd, env: {} }).text;
  assert.ok(/explicit yes/i.test(closeText) && /--track <letter>/.test(closeText) && /ETRACK_SEALED/.test(closeText));
  const leanText = composeMod.compose('close', { config, projectRoot: root, pickup: 'P', sessionsDir: '/nonexistent', env: {} }).text;
  assert.ok(!/explicit yes/i.test(leanText) && leanText.length < 9000, 'lone single-track close stays lean');
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = 'idZ';
  let gate;
  try { gate = composeMod.compose('', { config, projectRoot: root, pickup: 'P', sessionsDir: sd, env: {} }).text; } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
  assert.ok(/seal-and-new/.test(gate) && /explicit yes/i.test(gate));
});

// ── G: one answer to "is this track sealed" ────────────────────────────────────────────────────────

test('G1 the marker beats the record: trackState says sealed(marker) even when the record also carries no closedAt, and every reader agrees', () => {
  const sd = twoTracks('seal-g1-');
  T.sealByMarker(sd, '0001', 'b', { by: caller('idZ'), confirm: true });
  const st = T.trackState(sd, '0001', 'b');
  assert.deepStrictEqual([st.state, st.sealedBy], ['sealed', 'marker']);
  assert.ok(!T.isUnsealed(st));
  assert.deepStrictEqual(T.unsealedTracks(T.scanSessions(sd)).map((s) => s.track), ['a'], 'scan');
  assert.deepStrictEqual(T.sessionSummary(sd, '0001').unsealed.map((s) => s.track), ['a'], 'summary');
  assert.strictEqual(state(sd, { id: 'idB' }).state, 'foreign-open', 'gate: B has no unsealed track left');
  const br = H.run(H.BOOT_READ, ['--sessions-dir', sd], { id: 'idB' });
  assert.strictEqual(br.code, 0);
  // the hint: kept true (closedAt null while a is unsealed), then closed when a seals too
  T.writeHint(sd);
  assert.strictEqual(T.readHint(sd).hint.closedAt, null);
  T.sealByMarker(sd, '0001', 'a', { by: caller('idZ'), confirm: true });
  assert.ok(T.readHint(sd).hint.closedAt, 'hint closed once every track is sealed');
});

test('G2 static: no source file other than session-tracks.js decides "sealed" (no `.closedAt` reads outside the allow-list; `.sealed` existence only in tracks + the ops write guard)', () => {
  const dir = path.join(__dirname, '..');
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'tests' || e.name === 'templates') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(dir);
  // meta.closedAt is WRITTEN by the model (closeSession), VALIDATED by the schema, RENDERED by the converter,
  // BUILT by migrate, and READ to decide sealed-ness ONLY inside trackState (session-tracks.js).
  const allowClosedAt = new Set(['lib/session-tracks.js', 'lib/session-model.js', 'lib/session-schema.js', 'lib/session-converter.js', 'tpm-session-migrate.js', 'tpm-session-current.js',
    'lib/session-collate.js']);   // phase 12: collate only QUOTES "meta.closedAt" in a stderr note (checked below), it never reads it
  const bad = [];
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\\/g, '/');
    const src = fs.readFileSync(f, 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    if (/\bmeta\.closedAt\b|\brecord\.meta\.closedAt|\.closedAt\b/.test(src) && !allowClosedAt.has(rel)) bad.push(`${rel}: reads closedAt`);
    if (/existsSync\([^)]*sealed/i.test(src) && !['lib/session-tracks.js', 'tpm-session-ops.js'].includes(rel)) bad.push(`${rel}: checks the marker file`);
    if (/\.sealed['"`]/.test(src) && !['lib/session-tracks.js'].includes(rel)) bad.push(`${rel}: names the marker file`);
  }
  assert.deepStrictEqual(bad, []);
  // collate (phase 12) reads state ONLY from trackState: the one place the words appear is the quoted stderr note
  const colSrc = fs.readFileSync(path.join(dir, 'lib', 'session-collate.js'), 'utf8').split('\n')
    .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l) && !/the marker is authoritative/.test(l)).join('\n');
  assert.ok(!/closedAt/.test(colSrc.replace(/const \{ closedAt \} = ts;[^\n]*/, '')), 'collate never reads closedAt to decide anything');
  // current.js only touches the HINT's closedAt (a derived, non-authoritative file), never a record's
  const curSrc = fs.readFileSync(path.join(dir, 'tpm-session-current.js'), 'utf8');
  assert.ok(!/record\.meta\.closedAt|\.meta\.closedAt/.test(curSrc.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')));
});

done('session-seal');
