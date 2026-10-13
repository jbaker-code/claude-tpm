'use strict';
/**
 * session-open-gate.test.js — phase 08: the informative refusal (liveness evidence), --adopt, --parallel,
 * --next, the named --seal-and-new refusal, the third state `foreign-open` and its routing through the composer,
 * and the no-session-id rule (DoD F). In-process calls inject an identity (a second Claude instance without
 * touching the env); CLI calls play an instance by setting CLAUDE_CODE_SESSION_ID / CLAUDE_PID on that one child.
 * Hermetic (scratch dirs only); exits non-zero on failure.
 * Run: node tests/session-open-gate.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const H = require('./helpers/track-helpers');
const cs = require('../tpm-session-current');
const { processStartedAt } = require('../../lib/identity');
const { T, model } = H;

const HOST = os.hostname();
const MY_PID = process.pid;                       // a real, running process on this host
const MY_START = processStartedAt(MY_PID);       // its real start time (ps, 1 s resolution)

// A pid that is certainly dead: a child that has already exited.
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

function caller(sid, extra) {
  return H.id(sid, Object.assign({ hostname: HOST }, extra || {}));
}

function ownerIdent(extra) {
  return Object.assign({ hostname: HOST, claudePid: MY_PID, claudePidStartedAt: MY_START }, extra || {});
}

function loadRec(sd, number, track) {
  return model.loadSession(T.trackPaths(sd, number, track).jsonPath);
}

function refusal(fn) {
  try { fn(); } catch (e) { return e; }
  assert.fail('expected a refusal, got success');
  return null;
}

// ── A: the informative refusal ────────────────────────────────────────────────────────────────────

test('A1 refusal lists EVERY foreign track: letter, opened, last write, and a liveness line (running / gone / unknown)', () => {
  const sd = tmpDir('gate-a1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: ownerIdent() });                                   // running
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: { hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START } });   // gone
  H.putTrack(sd, '0001', 'c', { owner: 'idC', ident: { hostname: 'some-other-host.example', claudePid: 4242, claudePidStartedAt: MY_START } });
  H.putTrack(sd, '0001', 'd', { owner: 'idD' });                                                        // nothing recorded
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') }));
  assert.strictEqual(e.code, 'ESESSION_FOREIGN_TRACK');
  assert.strictEqual(e.exitCode, 3);
  const msg = e.message;
  for (const letter of ['a', 'b', 'c', 'd']) assert.ok(new RegExp(`track ${letter} of 0001`).test(msg), `track ${letter} listed: ${msg}`);
  assert.strictEqual((msg.match(/opened \d{4}-\d\d-\d\dT/g) || []).length, 4, 'opened time for each');
  assert.strictEqual((msg.match(/last write \d{4}-\d\d-\d\dT/g) || []).length, 4, 'last-write time for each');
  const by = Object.fromEntries(e.details.tracks.map((t) => [t.track, t.liveness]));
  assert.deepStrictEqual([by.a.status, by.a.line], ['running', 'owner process running']);
  assert.deepStrictEqual([by.b.status, by.b.line], ['gone', 'owner process gone']);
  assert.deepStrictEqual([by.c.status, by.c.line], ['unknown', 'unknown (recorded on another host)']);
  assert.strictEqual(by.d.status, 'unknown');
  assert.ok(/owner process running/.test(msg) && /owner process gone/.test(msg) && /unknown \(recorded on another host\)/.test(msg));
});

test('A2 NEVER "gone" for another hostname, even when the pid is certainly dead on this host', () => {
  const sd = tmpDir('gate-a2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: { hostname: 'elsewhere.example', claudePid: deadPid(), claudePidStartedAt: MY_START } });
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') }));
  assert.strictEqual(e.details.tracks[0].liveness.status, 'unknown');
  assert.ok(!/owner process gone/.test(e.message), e.message);
  // a record with a NULL hostname is not "this host" either
  const sd2 = tmpDir('gate-a2b-');
  H.putTrack(sd2, '0001', 'a', { owner: 'idA', ident: { hostname: null, claudePid: deadPid() } });
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd2, identity: caller('idZ') })).details.tracks[0].liveness.status, 'unknown');
});

test('A3 pid + START TIME: a live pid whose recorded start time differs by more than 2 s is "gone" (pid reuse)', () => {
  const sd = tmpDir('gate-a3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: { hostname: HOST, claudePid: MY_PID, claudePidStartedAt: '2001-01-01T00:00:00-07:00' } });
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') }));
  assert.strictEqual(e.details.tracks[0].liveness.status, 'gone');
  assert.ok(/owner process gone/.test(e.message));
  // the same pid with a start time within tolerance stays "running"
  const sd2 = tmpDir('gate-a3b-');
  H.putTrack(sd2, '0001', 'a', { owner: 'idA', ident: ownerIdent() });
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd2, identity: caller('idZ') })).details.tracks[0].liveness.status, 'running');
});

test('A4 livenessOf is pure evidence: injected probes, null owner, no pid', () => {
  const never = () => { throw new Error('must not probe'); };
  assert.strictEqual(T.livenessOf(null, caller('x'), { isAlive: never, startedAt: never }).status, 'unknown');
  assert.strictEqual(T.livenessOf({ claudePid: null, hostname: HOST }, caller('x'), { isAlive: never, startedAt: never }).line, 'unknown (no process id recorded)');
  assert.strictEqual(T.livenessOf({ claudePid: 77, hostname: 'h2' }, caller('x'), { isAlive: never, startedAt: never }).line, 'unknown (recorded on another host)');
  assert.strictEqual(T.livenessOf({ claudePid: 77, hostname: HOST }, caller('x'), { isAlive: () => true, startedAt: () => null }).status, 'running');
  assert.strictEqual(T.livenessOf({ claudePid: 77, hostname: HOST }, caller('x'), { isAlive: () => false, startedAt: never }).status, 'gone');
});

test('A5 "same process, different session id" is PRESENTED as evidence for adopt and never acted on', () => {
  const sd = tmpDir('gate-a5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOld', ident: ownerIdent() });
  const before = snapshot(sd);
  const me = caller('idNew', { claudePid: MY_PID, claudePidStartedAt: MY_START });
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: me }));
  assert.strictEqual(e.details.tracks[0].liveness.sameProcessNewSession, true);
  assert.ok(/same Claude process as yours, but a different Claude session id/.test(e.message) && /--adopt/.test(e.message), e.message);
  assert.deepStrictEqual(snapshot(sd), before, 'nothing written');
  // a different process is NOT flagged
  const e2 = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idNew', { claudePid: deadPid() }) }));
  assert.strictEqual(e2.details.tracks[0].liveness.sameProcessNewSession, false);
  assert.ok(!/same Claude process/.test(e2.message));
});

test('A6 the refusal names the way forward (adopt / parallel / next) and describes seal-and-new (phase 09)', () => {
  const sd = tmpDir('gate-a6-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') }));
  for (const f of ['--adopt <track>', '--parallel', '--next', '--seal-and-new', '--even-if-running']) assert.ok(e.message.includes(f), `${f} in: ${e.message}`);
  assert.ok(/abandoned seal|DEAD/i.test(e.message), 'seal-and-new is described, not "not available"');
  assert.ok(!/not available yet/.test(e.message));
  assert.ok(!/No choice flag exists/.test(e.message), 'the 07 stopgap wording is gone');
});

// ── B: adopt ─────────────────────────────────────────────────────────────────────────────────────

test('B1 adopt re-points the named unsealed track to the caller: id, pid, start time, host, history, adoptions[]', () => {
  const sd = tmpDir('gate-b1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: { hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START } });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: { hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START } });
  const me = caller('idZ', { claudePid: 9999, claudePidStartedAt: '2026-10-07T12:00:00-07:00' });
  const r = cs.openSession({ sessionsDir: sd, identity: me, adopt: 'b' });
  assert.deepStrictEqual([r.number, r.track, r.gate, r.adopted, r.isNew, r.sessionId], ['0001', 'b', 'adopt', true, false, 'idZ']);
  const rec = loadRec(sd, '0001', 'b');
  assert.strictEqual(rec.meta.claudeSessionId, 'idZ');
  assert.deepStrictEqual([rec.meta.claudePid, rec.meta.claudePidStartedAt, rec.meta.hostname], [9999, '2026-10-07T12:00:00-07:00', HOST]);
  assert.deepStrictEqual(rec.meta.sessionIds, ['idB', 'idZ'], 'history keeps the old id, current owner is last');
  assert.strictEqual(rec.meta.adoptions.length, 1);
  assert.strictEqual(rec.meta.adoptions[0].from.claudeSessionId, 'idB');
  assert.strictEqual(rec.meta.adoptions[0].via, 'adopt');
  assert.ok(rec.meta.lastWriter && rec.meta.lastWriter.at);
  assert.strictEqual(rec.meta.schemaVersion, undefined);
  assert.strictEqual(rec.schemaVersion, '1.0.0', 'no schema bump');
  // track a was not touched
  assert.strictEqual(loadRec(sd, '0001', 'a').meta.claudeSessionId, 'idA');
  // the caller now finds it by id; the old owner is shut out (a is theirs, b is not)
  assert.deepStrictEqual(['open', 'b'], [cs.resolveCurrentSession({ sessionsDir: sd, identity: me }).state, cs.resolveCurrentSession({ sessionsDir: sd, identity: me }).track]);
  const old = cs.resolveCurrentSession({ sessionsDir: sd, identity: caller('idB') });
  assert.strictEqual(old.state, 'foreign-open', 'the previous owner no longer owns anything');
  // the hint is kept true
  assert.strictEqual(T.readHint(sd).hint.closedAt, null);
  // the derived .md was regenerated
  assert.ok(fs.readFileSync(T.trackPaths(sd, '0001', 'b').mdPath, 'utf8').length > 0);
});

test('B2 adopt refuses: sealed track, missing track, unreadable track, no caller id — and writes nothing', () => {
  const sd = tmpDir('gate-b2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true });
  H.putTrack(sd, '0001', 'c', { owner: 'idC', ident: { hostname: 'h2', claudePid: 5 } });
  H.putMarker(sd, '0001', 'd');                                    // sealed by marker, no record
  H.putRaw(sd, '0001', 'session-0001-e.json', 'corrupt{');
  const before = snapshot(sd);
  const me = caller('idZ');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'a' })).code, 'EADOPT_SEALED');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'd' })).code, 'EADOPT_SEALED');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'q' })).code, 'EADOPT_NO_TRACK');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'e' })).code, 'EADOPT_UNREADABLE');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: '7' })).code, 'ETRACK_ARG');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller(null), adopt: 'c' })).code, 'EADOPT_NO_ID');
  assert.deepStrictEqual(snapshot(sd), before, 'no refusal wrote anything');
});

test('B3 adopt of a track whose owner process is demonstrably RUNNING needs --even-if-running; it is then recorded', () => {
  const sd = tmpDir('gate-b3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: ownerIdent() });          // alive: this very process, real start time
  const before = snapshot(sd);
  const me = caller('idZ', { claudePid: deadPid() });                          // a DIFFERENT process
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'a' }));
  assert.strictEqual(e.code, 'EADOPT_RUNNING');
  assert.ok(/--even-if-running/.test(e.message));
  assert.deepStrictEqual(snapshot(sd), before, 'refused adopt wrote nothing');
  const r = cs.openSession({ sessionsDir: sd, identity: me, adopt: 'a', evenIfRunning: true });
  assert.strictEqual(r.adopted, true);
  const rec = loadRec(sd, '0001', 'a');
  assert.strictEqual(rec.meta.claudeSessionId, 'idZ');
  assert.strictEqual(rec.meta.adoptions[0].via, 'adopt --even-if-running');
});

test('B4 adopt needs NO override when the owner is not demonstrably running: gone, other host, nothing recorded, or my OWN process (/clear)', () => {
  const cases = [
    ['gone', { hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START }, caller('idZ', { claudePid: deadPid() })],
    ['other host', { hostname: 'h2.example', claudePid: MY_PID, claudePidStartedAt: MY_START }, caller('idZ')],
    ['no pid', {}, caller('idZ')],
    ['own process after /clear', ownerIdent(), caller('idZ', { claudePid: MY_PID, claudePidStartedAt: MY_START })],
  ];
  for (const [name, ident, me] of cases) {
    const sd = tmpDir('gate-b4-');
    H.putTrack(sd, '0001', 'a', { owner: 'idOld', ident });
    const r = cs.openSession({ sessionsDir: sd, identity: me, adopt: 'a' });
    assert.strictEqual(r.adopted, true, name);
    assert.strictEqual(loadRec(sd, '0001', 'a').meta.claudeSessionId, 'idZ', name);
  }
});

test('B5 adopt of a track I already own is idempotent (no write); --session picks the session; letters repeat across sessions', () => {
  const sd = tmpDir('gate-b5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idZ' });
  const before = snapshot(sd);
  const r = cs.openSession({ sessionsDir: sd, identity: caller('idZ'), adopt: 'a' });
  assert.deepStrictEqual([r.adopted, r.gate], [false, 'resume']);
  assert.deepStrictEqual(snapshot(sd).hasOwnProperty('session-0001/session-0001.json'), true);
  const same = Object.keys(before).every((k) => k.endsWith('.current-session.json') || snapshot(sd)[k] === before[k] || k.endsWith('.md'));
  assert.ok(same, 'records unchanged');
  // two unsealed tracks "b" in different sessions; --session selects, default is the highest
  const sd2 = tmpDir('gate-b5b-');
  H.putTrack(sd2, '0001', 'b', { owner: 'idX' });
  H.putTrack(sd2, '0002', 'b', { owner: 'idY' });
  const r2 = cs.openSession({ sessionsDir: sd2, identity: caller('idZ'), adopt: 'b', number: '0001' });
  assert.strictEqual(r2.number, '0001');
  assert.strictEqual(loadRec(sd2, '0002', 'b').meta.claudeSessionId, 'idY');
  const r3 = cs.openSession({ sessionsDir: sd2, identity: caller('idW'), adopt: 'b' });
  assert.strictEqual(r3.number, '0002', 'default: the highest-numbered unsealed candidate');
});

// ── C: parallel ──────────────────────────────────────────────────────────────────────────────────

test('C1 --parallel claims the next free letter in the session holding the foreign track; punchlist starts EMPTY', () => {
  const sd = tmpDir('gate-c1-');
  const p = H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: { where: 'w', next: 'n' } });
  let rec = model.loadSession(p);
  rec = model.addPunchlist(rec, { text: 'an open item on track a' });
  model.saveSession(rec, { jsonPath: p });
  const r = cs.openSession({ sessionsDir: sd, identity: caller('idZ'), parallel: true });
  assert.deepStrictEqual([r.number, r.track, r.gate, r.isNew, r.isNewSession], ['0001', 'b', 'parallel', true, false]);
  const b = loadRec(sd, '0001', 'b');
  assert.deepStrictEqual(b.punchlist, [], 'decision Q6: a new parallel track starts with an empty punchlist');
  assert.deepStrictEqual([b.meta.track, b.meta.claudeSessionId, b.meta.closedAt], ['b', 'idZ', null]);
  assert.strictEqual(loadRec(sd, '0001', 'a').punchlist.length, 1, 'track a untouched');
  assert.ok(fs.existsSync(T.trackPaths(sd, '0001', 'b').mdPath));
  // a third instance gets c; the first still resumes its own a
  const r2 = cs.openSession({ sessionsDir: sd, identity: caller('idY'), parallel: true });
  assert.strictEqual(r2.track, 'c');
  assert.strictEqual(cs.openSession({ sessionsDir: sd, identity: caller('idA') }).track, 'a');
  assert.strictEqual(cs.openSession({ sessionsDir: sd, identity: caller('idZ') }).track, 'b');
  assert.strictEqual(T.readHint(sd).hint.closedAt, null);
});

test('C2 a sealed letter is never reused; the cap is 26 (a-z) and the 27th is ETRACK_CAP', () => {
  const sd = tmpDir('gate-c2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', sealed: true });
  const r = cs.openSession({ sessionsDir: sd, identity: caller('idZ'), parallel: true });
  assert.strictEqual(r.track, 'c', 'b is sealed and stays b');
  const sd2 = tmpDir('gate-c2b-');
  H.putTrack(sd2, '0001', 'a', { owner: 'idA' });
  for (let i = 1; i < 26; i += 1) {
    const x = cs.openSession({ sessionsDir: sd2, identity: caller(`id-${i}`), parallel: true });
    assert.strictEqual(x.track, T.TRACK_LETTERS[i]);
  }
  const e = refusal(() => cs.openSession({ sessionsDir: sd2, identity: caller('id-over'), parallel: true }));
  assert.strictEqual(e.code, 'ETRACK_CAP');
  assert.strictEqual(T.listFolder(sd2, '0001').tracks.length, 26);
});

test('C3 --parallel refusals: no id, nothing to run alongside, I already own a track there; --session overrides the target', () => {
  const sd = tmpDir('gate-c3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller(null), parallel: true })).code, 'EPARALLEL_NO_ID');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idA'), parallel: true })).code, 'EPARALLEL_ALREADY_MINE');
  const none = tmpDir('gate-c3b-');
  H.putTrack(none, '0001', 'a', { owner: 'idA', sealed: true });
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: none, identity: caller('idZ'), parallel: true })).code, 'EPARALLEL_NO_TARGET');
  const empty = tmpDir('gate-c3c-');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: empty, identity: caller('idZ'), parallel: true })).code, 'EPARALLEL_NO_TARGET');
  // target a specific (older) session
  const two = tmpDir('gate-c3d-');
  H.putTrack(two, '0001', 'a', { owner: 'idA' });
  H.putTrack(two, '0002', 'a', { owner: 'idB' });
  assert.strictEqual(cs.openSession({ sessionsDir: two, identity: caller('idZ'), parallel: true }).number, '0002', 'default: highest unsealed session');
  assert.strictEqual(cs.openSession({ sessionsDir: two, identity: caller('idY'), parallel: true, number: '0001' }).number, '0001');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: two, identity: caller('idX'), parallel: true, number: '0099' })).code, 'EPARALLEL_NO_TARGET');
});

// ── --next, --seal-and-new, flag hygiene ────────────────────────────────────────────────────────

test('N1 --next bypasses the foreign refusal and opens the NEXT session number (track a); the other track is untouched', () => {
  const sd = tmpDir('gate-n1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const aBefore = fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') })).code, 'ESESSION_FOREIGN_TRACK');
  const r = cs.openSession({ sessionsDir: sd, identity: caller('idZ'), next: true });
  assert.deepStrictEqual([r.number, r.track, r.gate, r.isNew, r.isNewSession], ['0002', 'a', 'next-session', true, true]);
  assert.strictEqual(loadRec(sd, '0002', 'a').meta.claudeSessionId, 'idZ');
  assert.strictEqual(fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8'), aBefore, 'the older track was not touched');
  // both instances now resume their own; hint is open
  assert.strictEqual(cs.openSession({ sessionsDir: sd, identity: caller('idA') }).number, '0001');
  assert.strictEqual(cs.openSession({ sessionsDir: sd, identity: caller('idZ') }).number, '0002');
  assert.strictEqual(T.readHint(sd).hint.closedAt, null);
  // asking for a next session while already owning an open track is refused (the tool does not pile up sessions)
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ'), next: true }));
  assert.strictEqual(e.code, 'ENEXT_HAVE_OPEN');
});

test('N2 --next from a SEALED track of the same instance while another track is live (the straggler case)', () => {
  const sd = tmpDir('gate-n2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idZ', sealed: true });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ') })).code, 'ESESSION_FOREIGN_TRACK');
  const r = cs.openSession({ sessionsDir: sd, identity: caller('idZ'), next: true });
  assert.deepStrictEqual([r.number, r.track], ['0002', 'a']);
});

test('S1 --seal-and-new without the confirmation flag writes nothing and needs confirmation (ESEAL_NEEDS_CONFIRM, exit 4) - the real behaviour is covered in session-seal.test.js', () => {
  const sd = tmpDir('gate-s1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const before = snapshot(sd);
  const e = refusal(() => cs.openSession({ sessionsDir: sd, identity: caller('idZ'), sealAndNew: true }));
  assert.strictEqual(e.code, 'ESEAL_NEEDS_CONFIRM');
  assert.strictEqual(e.exitCode, 4);
  assert.deepStrictEqual(snapshot(sd), before);
});

test('S2 exactly one choice flag; --even-if-running only with --adopt; --session only with adopt/parallel', () => {
  const sd = tmpDir('gate-s2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const before = snapshot(sd);
  const me = caller('idZ');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, adopt: 'a', parallel: true })).code, 'ETRACK_ARG');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, parallel: true, next: true })).code, 'ETRACK_ARG');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, parallel: true, evenIfRunning: true })).code, 'ETRACK_ARG');
  assert.strictEqual(refusal(() => cs.openSession({ sessionsDir: sd, identity: me, next: true, number: '0001' })).code, 'ETRACK_ARG');
  assert.deepStrictEqual(snapshot(sd), before);
});

// ── D: the third state ──────────────────────────────────────────────────────────────────────────

test('D1 --state reports foreign-open (distinct from open and not-opened) with the foreign tracks and their liveness', () => {
  const sd = tmpDir('gate-d1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: ownerIdent() });
  const st = cs.resolveCurrentSession({ sessionsDir: sd, identity: caller('idZ') });
  assert.strictEqual(st.state, 'foreign-open');
  assert.deepStrictEqual(st.foreign.map((f) => [f.number, f.track, f.liveness.status]), [['0001', 'a', 'running']]);
  assert.strictEqual(st.refusal.code, 'ESESSION_FOREIGN_TRACK');
  assert.strictEqual(st.blocking.length, 1);
  assert.strictEqual(st.number, null);
  // the other two states are still themselves
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: sd, identity: caller('idA') }).state, 'open');
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: tmpDir('gate-d1b-'), identity: caller('idZ') }).state, 'not-opened');
  const sealedOnly = tmpDir('gate-d1c-');
  H.putTrack(sealedOnly, '0001', 'a', { owner: 'idA', sealed: true });
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: sealedOnly, identity: caller('idZ') }).state, 'not-opened');
  // via the CLI, as the skill sees it
  const r = H.run(H.CURRENT, ['--sessions-dir', sd, '--state'], { id: 'idZ' });
  assert.strictEqual(JSON.parse(r.stdout).state, 'foreign-open');
});

test('D2 foreign-open also covers an unreadable-unsealed track and several unowned tracks; a marker-sealed one is not foreign', () => {
  const sd = tmpDir('gate-d2-');
  H.putRaw(sd, '0001', 'session-0001-b.json', 'corrupt{');
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: sd, identity: caller('idZ') }).state, 'foreign-open');
  const un = tmpDir('gate-d2b-');
  H.putTrack(un, '0001', 'a', { owner: null });
  H.putTrack(un, '0001', 'b', { owner: null });
  const st = cs.resolveCurrentSession({ sessionsDir: un, identity: caller('idZ') });
  assert.strictEqual(st.state, 'foreign-open');
  assert.strictEqual(st.blocking.length, 2, 'unowned tracks that block are listed in `blocking`');
  const mk = tmpDir('gate-d2c-');
  H.putTrack(mk, '0001', 'a', { owner: 'idA' });
  H.putMarker(mk, '0001', 'a');
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: mk, identity: caller('idZ') }).state, 'not-opened');
});

// ── E: the composer and the templates ──────────────────────────────────────────────────────────

function composeIn(sd, sid, modeArg) {
  const composeMod = require('../tpm-session-compose');
  const config = require('../../lib/tpm-config-overlay').loadDefaults();
  const root = tmpDir('gate-compose-root-');
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  if (sid) process.env.CLAUDE_CODE_SESSION_ID = sid; else delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    return composeMod.compose(modeArg, { config, projectRoot: root, pickup: 'PICKUP-TEXT', sessionsDir: sd, env: {} });
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
}

test('E1 compose, bare invocation, each state: not-opened -> open; open -> save; foreign-open -> open (the gate), never save', () => {
  const fresh = tmpDir('gate-e1a-');
  const r1 = composeIn(fresh, 'idZ', '');
  assert.strictEqual(r1.mode, 'open');
  assert.ok(/session state "not-opened" → mode: open/.test(r1.text));
  assert.ok(!/Open gate: a session is open/.test(r1.text), 'no gate notice outside the third state');

  const mine = tmpDir('gate-e1b-');
  H.putTrack(mine, '0001', 'a', { owner: 'idZ' });
  const r2 = composeIn(mine, 'idZ', '');
  assert.strictEqual(r2.mode, 'save');
  assert.ok(/session state "open" → mode: save/.test(r2.text));

  const foreign = tmpDir('gate-e1c-');
  H.putTrack(foreign, '0001', 'a', { owner: 'idA' });
  const r3 = composeIn(foreign, 'idZ', '');
  assert.strictEqual(r3.mode, 'open');
  assert.ok(/session state "foreign-open" → mode: open \(open gate\)/.test(r3.text), r3.text.slice(0, 300));
  assert.ok(/Open gate: a session is open, but by ANOTHER Claude instance/.test(r3.text));
  assert.ok(/adopt/.test(r3.text) && /parallel/.test(r3.text) && /next/.test(r3.text), 'the gate question is in the composed output');
  assert.ok(/--adopt <track>/.test(r3.text) && /--parallel/.test(r3.text) && /--next/.test(r3.text), 'the open template carries the gate section');
  assert.ok(/--seal-and-new/.test(r3.text) && /explicit yes/i.test(r3.text), 'seal-and-new is offered, behind an explicit yes');
  assert.ok(!/NOT available yet/.test(r3.text));
  assert.ok(!/## `tpm-session save`/.test(r3.text), 'never the save procedure');
});

test('E2 an EXPLICIT save or close in the third state refuses with a pointer to open; nothing composed from the save/close ritual', () => {
  const foreign = tmpDir('gate-e2-');
  H.putTrack(foreign, '0001', 'a', { owner: 'idA' });
  for (const m of ['save', 'close', 'checkpoint', 'wrap']) {
    const r = composeIn(foreign, 'idZ', m);
    assert.strictEqual(r.refused, true, m);
    assert.ok(/foreign-open/.test(r.text) && /compose --mode open/.test(r.text) && /Nothing was written/.test(r.text), `${m}: ${r.text}`);
    assert.ok(!/save ritual|Step A\.|import-handoff/.test(r.text), `${m}: the ritual is not emitted`);
  }
  // explicit open and info still work in the third state; save/close work for an owner
  assert.strictEqual(composeIn(foreign, 'idZ', 'open').mode, 'open');
  assert.strictEqual(composeIn(foreign, 'idZ', 'info').mode, 'info');
  const mine = tmpDir('gate-e2b-');
  H.putTrack(mine, '0001', 'a', { owner: 'idZ' });
  assert.ok(!composeIn(mine, 'idZ', 'save').refused);
  assert.ok(!composeIn(mine, 'idZ', 'close').refused);
});

test('E3 the state->mode table is explicit: an unknown state falls to open with a LOUD warning, not silence', () => {
  assert.deepStrictEqual(require('../tpm-session-compose').STATE_MODE, { open: 'save', 'not-opened': 'open', 'foreign-open': 'open' });
  const cur = require('../tpm-session-current');
  const orig = cur.resolveCurrentSession;
  cur.resolveCurrentSession = () => ({ state: 'wat' });
  try {
    const r = composeIn(tmpDir('gate-e3-'), 'idZ', '');
    assert.strictEqual(r.mode, 'open');
    assert.ok(r.warnings.some((w) => /session-state-unknown/.test(w) && /wat/.test(w)), JSON.stringify(r.warnings));
    assert.ok(/session-state-unknown/.test(r.text), 'visible in the output');
  } finally {
    cur.resolveCurrentSession = orig;
  }
});

test('E4 the shipped save/close templates and the skill carry the third-state rule (a pointer to open)', () => {
  const dir = path.join(__dirname, '..', 'templates');
  assert.ok(/foreign-open/.test(fs.readFileSync(path.join(dir, 'save.md'), 'utf8')));
  // phase-20: the foreign-open close guidance lives in a conditional fragment (emitted only for multi/foreign-track sessions)
  assert.ok(/foreign-open/.test(fs.readFileSync(path.join(dir, '_close-foreign-gate.md'), 'utf8')));
  assert.ok(/foreign-open/.test(fs.readFileSync(path.join(dir, '..', '..', '..', '.claude', 'skills', 'tpm-session', 'SKILL.md'), 'utf8')));
  const open = fs.readFileSync(path.join(dir, 'open.md'), 'utf8');
  assert.ok(/--adopt <track>/.test(open) && /--parallel/.test(open) && /--next/.test(open) && /--even-if-running/.test(open));
});

// ── F: no Claude session id ─────────────────────────────────────────────────────────────────────

test('F1 no session id: exactly one unsealed track -> continuity (today\'s behaviour); more than one -> exit 3 requiring --track', () => {
  const one = tmpDir('gate-f1a-');
  H.putTrack(one, '0001', 'a', { owner: 'idA' });
  const r1 = H.run(H.CURRENT, ['--sessions-dir', one, '--open'], {});
  assert.strictEqual(r1.code, 0, r1.stderr);
  assert.deepStrictEqual([JSON.parse(r1.stdout).number, JSON.parse(r1.stdout).track, JSON.parse(r1.stdout).gate], ['0001', 'a', 'resume']);
  const two = tmpDir('gate-f1b-');
  H.putTrack(two, '0001', 'a', { owner: 'idA' });
  H.putTrack(two, '0001', 'b', { owner: 'idB' });
  const before = snapshot(two);
  const r2 = H.run(H.CURRENT, ['--sessions-dir', two, '--open'], {});
  assert.strictEqual(r2.code, 3);
  assert.ok(/--track <letter>/.test(r2.stderr), r2.stderr);
  const j = JSON.parse(r2.stdout);
  assert.deepStrictEqual([j.refused, j.code, j.tracks.map((t) => t.track)], [true, 'ESESSION_AMBIGUOUS', ['a', 'b']]);
  assert.deepStrictEqual(snapshot(two), before, 'nothing written');
  // --state is the third state, so a bare invocation can never reach save
  assert.strictEqual(JSON.parse(H.run(H.CURRENT, ['--sessions-dir', two, '--state'], {}).stdout).state, 'foreign-open');
});

test('F2 no session id: the choice flags that need an id are refused; --track is the only way through and is explicit', () => {
  const two = tmpDir('gate-f2-');
  H.putTrack(two, '0001', 'a', { owner: 'idA' });
  H.putTrack(two, '0001', 'b', { owner: 'idB' });
  const before = snapshot(two);
  for (const [flags, code] of [[['--adopt', 'a'], 'EADOPT_NO_ID'], [['--parallel'], 'EPARALLEL_NO_ID']]) {
    const r = H.run(H.CURRENT, ['--sessions-dir', two, '--open', ...flags], {});
    assert.strictEqual(r.code, 1, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout).code, code);
  }
  assert.deepStrictEqual(snapshot(two), before);
  const ok = H.run(H.CURRENT, ['--sessions-dir', two, '--open', '--track', 'b'], {});
  assert.strictEqual(ok.code, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.deepStrictEqual([j.number, j.track, j.explicitTrack], ['0001', 'b', true]);
  const missing = H.run(H.CURRENT, ['--sessions-dir', two, '--open', '--track', 'q'], {});
  assert.strictEqual(missing.code, 1);
  assert.strictEqual(JSON.parse(missing.stdout).code, 'ENO_TRACK');
  // with an id, --track will not take someone else's track
  const owned = H.run(H.CURRENT, ['--sessions-dir', two, '--open', '--track', 'b'], { id: 'idZ' });
  assert.strictEqual(owned.code, 1);
  assert.strictEqual(JSON.parse(owned.stdout).code, 'ENOT_OWNER');
});

test('F3 no session id: a write verb with more than one unsealed track refuses and writes nothing', () => {
  const two = tmpDir('gate-f3-');
  H.putTrack(two, '0001', 'a', { owner: 'idA' });
  H.putTrack(two, '0001', 'b', { owner: 'idB' });
  const before = snapshot(two);
  const r = H.run(H.OPS, ['note', '--sessions-dir', two, '--session', '0001', '--log', '--status', 'X', '--text', 'hi'], {});
  assert.strictEqual(r.code, 1, r.stderr);
  assert.ok(/--track <letter>/.test(r.stderr), r.stderr);
  assert.deepStrictEqual(snapshot(two), before);
});

// ── end to end through the CLI (the /clear story) ───────────────────────────────────────────────

test('X1 CLI story: A opens; after /clear (same pid, new id) B is refused with the /clear evidence, adopts WITHOUT an override, and A is then the foreign one', () => {
  const sd = tmpDir('gate-x1-');
  const pid = MY_PID;
  const a = H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idA', pid });
  assert.strictEqual(a.code, 0, a.stderr);
  const b1 = H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idB', pid });
  assert.strictEqual(b1.code, 3);
  assert.ok(/same Claude process as yours/.test(b1.stderr), b1.stderr);
  assert.strictEqual(JSON.parse(b1.stdout).tracks[0].liveness.sameProcessNewSession, true);
  const b2 = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--adopt', 'a'], { id: 'idB', pid });
  assert.strictEqual(b2.code, 0, b2.stderr);
  const j = JSON.parse(b2.stdout);
  assert.deepStrictEqual([j.number, j.track, j.gate, j.adopted, j.sessionId], ['0001', 'a', 'adopt', true, 'idB']);
  // idempotent for B; A is now refused (its track moved)
  assert.strictEqual(H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idB', pid }).code, 0);
  assert.strictEqual(H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idA', pid: deadPid() }).code, 3);
  // a write verb as B lands in B's track, as A is refused
  const note = ['note', '--sessions-dir', sd, '--session', '0001', '--log', '--status', 'T', '--text', 'x'];
  assert.strictEqual(H.run(H.OPS, note, { id: 'idB', pid }).code, 0);
  assert.strictEqual(H.run(H.OPS, note, { id: 'idA', pid: deadPid() }).code, 1);
});

test('X2 CLI story: parallel then next; --even-if-running through the CLI; --seal-and-new needs the confirmation flag (exit 4)', () => {
  const sd = tmpDir('gate-x2-');
  assert.strictEqual(H.run(H.CURRENT, ['--sessions-dir', sd, '--open'], { id: 'idA', pid: MY_PID }).code, 0);
  const par = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--parallel'], { id: 'idB', pid: deadPid() });
  assert.strictEqual(par.code, 0, par.stderr);
  assert.deepStrictEqual([JSON.parse(par.stdout).track, JSON.parse(par.stdout).gate], ['b', 'parallel']);
  const noOverride = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--adopt', 'a'], { id: 'idC', pid: deadPid() });
  assert.strictEqual(noOverride.code, 1);
  assert.strictEqual(JSON.parse(noOverride.stdout).code, 'EADOPT_RUNNING');
  const withIt = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--adopt', 'a', '--even-if-running'], { id: 'idC', pid: deadPid() });
  assert.strictEqual(withIt.code, 0, withIt.stderr);
  const nxt = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--next'], { id: 'idD', pid: deadPid() });
  assert.strictEqual(nxt.code, 0, nxt.stderr);
  assert.deepStrictEqual([JSON.parse(nxt.stdout).number, JSON.parse(nxt.stdout).gate], ['0002', 'next-session']);
  const sn = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--seal-and-new'], { id: 'idE', pid: deadPid() });
  assert.strictEqual(sn.code, 4);
  assert.strictEqual(JSON.parse(sn.stdout).code, 'ESEAL_NEEDS_CONFIRM');
});

test('X3 three separate processes each claim --parallel in the same session and get three DIFFERENT letters', () => {
  const sd = tmpDir('gate-x3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const script = `const cs=require(${JSON.stringify(path.join(__dirname, '..', 'tpm-session-current'))});
    const r=cs.openSession({sessionsDir:${JSON.stringify(sd)},parallel:true});process.stdout.write(r.track);`;
  const out = ['idB', 'idC', 'idD'].map((sid) => spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: H.cleanEnv({ CLAUDE_CODE_SESSION_ID: sid }) }));
  const letters = out.map((r) => r.stdout).sort();
  assert.deepStrictEqual(letters, ['b', 'c', 'd'], out.map((r) => r.stderr).join('|'));
});

done('session-open-gate.test');
