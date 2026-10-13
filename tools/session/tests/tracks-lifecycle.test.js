'use strict';
/**
 * tracks-lifecycle.test.js — DoD A (phase 10): the tracks store's LIFECYCLE guarantees, end to end through the
 * real CLIs (`tpm-session-current.js`, `tpm-session-ops.js`, `tpm-session-boot-read.js`) against scratch stores.
 * Every simulated Claude instance gets an explicit CLAUDE_CODE_SESSION_ID (+ CLAUDE_PID) per child process; the
 * ambient ones are always stripped (H.run -> H.cleanEnv), so a leaked real id cannot change a result.
 * The one genuinely timing-dependent case (the marker landing mid-save) is F5 in tracks-forced-order.test.js.
 *
 *   L1  adopt            L2  adopt of a RUNNING owner needs the override      L3  parallel (letters, clean punchlist)
 *   L4  the third state  L5  own-track close leaves every other record byte-identical
 *   L6  a sealed track's owner is refused on EVERY write verb (the forced mid-save window is F5 in tracks-forced-order)
 *   L7  abandoned seal needs confirmation (+ --confirm alias)             L8  unseal        L9  --seal-and-new
 *   L10 legacy single-record folder                                       L11 no session id: 1 vs 2 unsealed tracks
 *   L12 an older-version reader on a new record (the frozen 0.2.0 boot-read, when present, + schemaVersion unchanged)
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tools/session/tests/tracks-lifecycle.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const H = require('./helpers/track-helpers');
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
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }(dir));
  return out;
}
const runningOwner = () => ({ hostname: HOST, claudePid: MY_PID, claudePidStartedAt: MY_START });
const goneOwner = () => ({ hostname: HOST, claudePid: deadPid(), claudePidStartedAt: MY_START });
const cur = (sd, args, o) => H.run(H.CURRENT, ['--sessions-dir', sd, ...args], o);
const op = (sd, args, o) => H.run(H.OPS, [args[0], '--sessions-dir', sd, ...args.slice(1)], o);
const state = (sd, o) => JSON.parse(cur(sd, ['--state'], o).stdout);
const loadRec = (sd, n, t) => model.loadSession(T.trackPaths(sd, n, t).jsonPath);
const rawRec = (sd, n, t) => JSON.parse(fs.readFileSync(T.trackPaths(sd, n, t).jsonPath, 'utf8'));
const owner = (sd, n, t) => rawRec(sd, n, t).meta.claudeSessionId;

/** track a (idA, running) + track b (idB, gone), both with a handoff + one punchlist item so `close` passes its guard. */
function twoTracks(prefix) {
  const sd = tmpDir(prefix);
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', ident: goneOwner(), handoff: HANDOFF });
  for (const [t, id] of [['a', 'idA'], ['b', 'idB']]) {
    const r = op(sd, ['punchlist', '--session', '1', '--track', t, '--action', 'add', '--text', `item ${t}`], { id, pid: MY_PID });
    assert.strictEqual(r.code, 0, r.stderr);
  }
  return sd;
}

// ── L1 / L2 adopt ─────────────────────────────────────────────────────────────────────────────────────
test('L1 adopt re-points the named unsealed track to the caller; the former owner is then the foreign one', () => {
  const sd = tmpDir('lc-l1-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOld', ident: goneOwner(), handoff: HANDOFF });
  assert.strictEqual(state(sd, { id: 'idNew' }).state, 'foreign-open');
  const r = cur(sd, ['--open', '--adopt', 'a'], { id: 'idNew', pid: MY_PID });
  assert.strictEqual(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepStrictEqual([out.number, out.track, out.gate], ['0001', 'a', 'adopt']);
  assert.strictEqual(owner(sd, '0001', 'a'), 'idNew');
  assert.strictEqual(rawRec(sd, '0001', 'a').handoff.where, 'w', 'adopt keeps the work');
  assert.strictEqual(state(sd, { id: 'idNew' }).state, 'open');
  assert.strictEqual(state(sd, { id: 'idOld' }).state, 'foreign-open', 'the former owner is now the foreign instance');
  const w = op(sd, ['save', '--session', '1'], { id: 'idOld' });
  assert.notStrictEqual(w.code, 0, 'the former owner cannot write the adopted track');
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idNew' }).code, 0);
});

test('L2 adopting a track whose owner process is demonstrably RUNNING needs --even-if-running; refused it writes nothing', () => {
  const sd = tmpDir('lc-l2-');
  H.putTrack(sd, '0001', 'a', { owner: 'idRun', ident: runningOwner(), handoff: HANDOFF });
  // a caller whose pid is NOT the owner's pid (explicit pid 1 stands in for another Claude process)
  const before = snapshot(sd);
  const refused = cur(sd, ['--open', '--adopt', 'a'], { id: 'idNew', pid: 1 });
  assert.notStrictEqual(refused.code, 0, refused.stdout);
  assert.deepStrictEqual(snapshot(sd), before, 'nothing written by the refused adopt');
  assert.strictEqual(owner(sd, '0001', 'a'), 'idRun');
  const ok = cur(sd, ['--open', '--adopt', 'a', '--even-if-running'], { id: 'idNew', pid: 1 });
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.strictEqual(owner(sd, '0001', 'a'), 'idNew');
  assert.ok(Array.isArray(rawRec(sd, '0001', 'a').meta.adoptions) && rawRec(sd, '0001', 'a').meta.adoptions.length === 1, 'the adoption is recorded');
});

// ── L3 parallel ───────────────────────────────────────────────────────────────────────────────────────
test('L3 --parallel claims the next free letter of the session holding the foreign track; its punchlist starts EMPTY; the original is untouched', () => {
  const sd = tmpDir('lc-l3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  const aBefore = fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8');
  const r1 = cur(sd, ['--open', '--parallel'], { id: 'idB', pid: MY_PID });
  assert.strictEqual(r1.code, 0, r1.stderr);
  assert.deepStrictEqual([JSON.parse(r1.stdout).number, JSON.parse(r1.stdout).track, JSON.parse(r1.stdout).gate], ['0001', 'b', 'parallel']);
  const r2 = cur(sd, ['--open', '--parallel'], { id: 'idC', pid: MY_PID });
  assert.strictEqual(JSON.parse(r2.stdout).track, 'c');
  assert.deepStrictEqual(rawRec(sd, '0001', 'b').punchlist, []);
  assert.strictEqual(fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8'), aBefore, 'track a byte-identical');
  assert.strictEqual(state(sd, { id: 'idB' }).track, 'b');
  assert.strictEqual(state(sd, { id: 'idC' }).track, 'c');
});

// ── L4 the third state ────────────────────────────────────────────────────────────────────────────────
test('L4 the third state: a stranger sees foreign-open (not open, not not-opened), composes the OPEN gate, and its write verb is refused', () => {
  const sd = tmpDir('lc-l4-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', ident: runningOwner(), handoff: HANDOFF });
  assert.strictEqual(state(sd, { id: 'idA' }).state, 'open');
  const st = state(sd, { id: 'idStranger' });
  assert.strictEqual(st.state, 'foreign-open');
  assert.strictEqual(st.foreign.length, 1);
  assert.strictEqual(st.foreign[0].track, 'a');
  const none = tmpDir('lc-l4-empty-');
  assert.strictEqual(state(none, { id: 'idStranger' }).state, 'not-opened', 'an empty store is not-opened, a different answer');
  const before = snapshot(sd);
  const w = op(sd, ['save', '--session', '1'], { id: 'idStranger' });
  assert.notStrictEqual(w.code, 0, 'a write verb never lands in the foreign track');
  assert.deepStrictEqual(snapshot(sd), before);
});

// ── L5 own-track close ────────────────────────────────────────────────────────────────────────────────
test('L5 closing your OWN track seals only it: every other file in the folder is byte-identical, the hint stays open', () => {
  const sd = twoTracks('lc-l5-');
  T.writeHint(sd);
  const before = snapshot(sd);
  const r = op(sd, ['close', '--session', '1'], { id: 'idB', pid: MY_PID });
  assert.strictEqual(r.code, 0, r.stderr);
  const after = snapshot(sd);
  const changed = Object.keys(after).filter((f) => after[f] !== before[f]).sort();
  assert.deepStrictEqual(changed, [path.join('session-0001', 'session-0001-b.json'), path.join('session-0001', 'session-0001-b.md')], `only b's own files changed: ${changed}`);
  assert.ok(loadRec(sd, '0001', 'b').meta.closedAt, 'b sealed');
  assert.strictEqual(loadRec(sd, '0001', 'a').meta.closedAt, null, 'a still live');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(sd, '.current-session.json'), 'utf8')).closedAt, null, 'hint stays open while a is live');
  assert.strictEqual(state(sd, { id: 'idA' }).state, 'open');
});

// ── L6 sealed owner refused ───────────────────────────────────────────────────────────────────────────
test('L6 after another instance seals its track, the owner is refused on every write verb (naming the sealer); nothing is written', () => {
  const sd = tmpDir('lc-l6-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', ident: runningOwner(), handoff: HANDOFF });
  const seal = op(sd, ['close', '--session', '1', '--track', 'a', '--even-if-running'], { id: 'idSealer99', pid: MY_PID });
  assert.strictEqual(seal.code, 0, seal.stderr);
  const tf = path.join(tmpDir('lc-l6-in-'), 'in.txt'); fs.writeFileSync(tf, 'text\n');
  const before = snapshot(sd);
  const verbs = [
    ['save', '--session', '1'],
    ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'late'],
    ['punchlist', '--session', '1', '--action', 'add', '--text', 'late'],
    ['import-log', '--session', '1', '--file', tf],
    ['import-punchlist', '--session', '1', '--file', tf],
    ['import-handoff', '--session', '1', '--txt-file', tf, '--next', 'n'],
    ['close', '--session', '1'],
  ];
  for (const v of verbs) {
    const r = op(sd, v, { id: 'idOwner', pid: MY_PID });
    assert.strictEqual(r.code, 1, `${v[0]}: ${r.stderr}`);
    assert.ok(/sealed by another session/.test(r.stderr) && r.stderr.includes('idSealer'), `${v[0]}: ${r.stderr}`);
    assert.strictEqual(JSON.parse(r.stdout).code, 'ETRACK_SEALED');
  }
  assert.deepStrictEqual(snapshot(sd), before, 'no refused verb wrote anything');
});

// ── L7 abandoned seal ─────────────────────────────────────────────────────────────────────────────────
test('L7 the abandoned seal requires confirmation: without the flag exit 4 and NOTHING written; with it (or its --confirm alias) a marker, the record untouched', () => {
  const sd = twoTracks('lc-l7-');
  const before = snapshot(sd);
  const r0 = op(sd, ['close', '--session', '1', '--track', 'b'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r0.code, 4, r0.stderr);
  assert.strictEqual(JSON.parse(r0.stdout).sealed, false);
  assert.ok(/NOTHING was sealed/.test(r0.stderr), r0.stderr);
  assert.deepStrictEqual(snapshot(sd), before, 'the unconfirmed run wrote nothing');
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'b').sealedPath));
  const pb = T.trackPaths(sd, '0001', 'b');
  const jsonBefore = fs.readFileSync(pb.jsonPath, 'utf8');
  const r1 = op(sd, ['close', '--session', '1', '--track', 'b', '--reason', 'train died', '--confirm'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r1.code, 0, r1.stderr);
  const m = JSON.parse(fs.readFileSync(pb.sealedPath, 'utf8'));
  assert.deepStrictEqual([m.kind, m.reason, m.note, m.sealedBy.claudeSessionId], ['seal-marker', 'abandoned', 'train died', 'idZ']);
  assert.strictEqual(fs.readFileSync(pb.jsonPath, 'utf8'), jsonBefore, 'the sealed record is byte-identical');
  assert.strictEqual(T.trackState(sd, '0001', 'b').sealedBy, 'marker');
  assert.strictEqual(T.trackState(sd, '0001', 'a').state, 'live', 'the other track is not sealed');
  // sealing your OWN track this way is refused (use close)
  const own = op(sd, ['close', '--session', '1', '--track', 'a', '--even-if-running'], { id: 'idA', pid: MY_PID });
  assert.notStrictEqual(own.code, 0);
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'a').sealedPath));
});

// ── L8 unseal ─────────────────────────────────────────────────────────────────────────────────────────
test('L8 unseal restores the owner: the marker is renamed to a hidden audit file, writes work again, a second unseal is a no-op', () => {
  const sd = tmpDir('lc-l8-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: HANDOFF });
  T.sealByMarker(sd, '0001', 'a', { by: H.id('idZ'), confirm: true });
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idOwner' }).code, 1);
  const u = op(sd, ['unseal', '--session', '1', '--track', 'a'], { id: 'idOwner' });
  assert.strictEqual(u.code, 0, u.stderr);
  const res = JSON.parse(u.stdout);
  assert.strictEqual(res.unsealed, true);
  assert.ok(fs.existsSync(res.auditPath), 'audit copy kept');
  assert.ok(!fs.existsSync(T.trackPaths(sd, '0001', 'a').sealedPath), 'live marker gone');
  assert.strictEqual(T.trackState(sd, '0001', 'a').state, 'live');
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idOwner' }).code, 0, 'the owner can write again');
  assert.strictEqual(JSON.parse(op(sd, ['unseal', '--session', '1', '--track', 'a'], { id: 'idOwner' }).stdout).already, true);
});

// ── L9 --seal-and-new ─────────────────────────────────────────────────────────────────────────────────
test('L9 --seal-and-new: no flag -> exit 4 writes nothing; with it every foreign track is marker-sealed (records untouched) and the NEXT number opens for the caller', () => {
  const sd = twoTracks('lc-l9-');
  const before = snapshot(sd);
  const r0 = cur(sd, ['--open', '--seal-and-new'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r0.code, 4, r0.stderr);
  assert.strictEqual(JSON.parse(r0.stdout).code, 'ESEAL_NEEDS_CONFIRM');
  assert.deepStrictEqual(snapshot(sd), before);
  const recs = ['a', 'b'].map((t) => fs.readFileSync(T.trackPaths(sd, '0001', t).jsonPath, 'utf8'));
  const r1 = cur(sd, ['--open', '--seal-and-new', '--even-if-running'], { id: 'idZ', pid: MY_PID });
  assert.strictEqual(r1.code, 0, r1.stderr);
  const out = JSON.parse(r1.stdout);
  assert.deepStrictEqual([out.number, out.track, out.gate, out.isNewSession], ['0002', 'a', 'seal-and-new', true]);
  assert.deepStrictEqual(['a', 'b'].map((t) => fs.readFileSync(T.trackPaths(sd, '0001', t).jsonPath, 'utf8')), recs, 'old records byte-identical');
  for (const t of ['a', 'b']) assert.strictEqual(T.trackState(sd, '0001', t).sealedBy, 'marker', t);
  assert.strictEqual(owner(sd, '0002', 'a'), 'idZ');
  assert.strictEqual(state(sd, { id: 'idZ' }).state, 'open');
  assert.strictEqual(op(sd, ['save', '--session', '1'], { id: 'idA' }).code, 1, 'the sealed instance is refused when it next writes');
});

// ── L10 legacy ────────────────────────────────────────────────────────────────────────────────────────
test('L10 a legacy single-record folder (no track metadata) is track a: read unchanged, resumed by its recorded owner, and written in place', () => {
  const sd = tmpDir('lc-l10-');
  const jp = H.putTrack(sd, '0001', 'a', { owner: 'legacy-sid', legacy: true, handoff: HANDOFF });
  assert.strictEqual(rawRec(sd, '0001', 'a').meta.track, undefined, 'fixture really is pre-tracks');
  const before = snapshot(sd);
  const st = state(sd, { id: 'legacy-sid' });
  assert.deepStrictEqual([st.state, st.number, st.track], ['open', '0001', 'a']);
  assert.deepStrictEqual(snapshot(sd), before, 'reading wrote nothing');
  const w = op(sd, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'hi'], { id: 'legacy-sid' });
  assert.strictEqual(w.code, 0, w.stderr);
  assert.ok(rawRec(sd, '0001', 'a').log.some((e) => e.text === 'hi'));
  assert.deepStrictEqual(fs.readdirSync(path.dirname(jp)).filter((n) => /\.json$/.test(n)), ['session-0001.json'], 'still exactly one record (no b minted)');
  // a different instance does not silently join the legacy record either
  assert.strictEqual(cur(sd, ['--open'], { id: 'someoneElse' }).code, 3);
  // a legacy record with NO recorded owner never blocks: any instance resumes it, and nothing is rewritten
  const un = tmpDir('lc-l10-unowned-');
  H.putTrack(un, '0001', 'a', { owner: null, legacy: true, handoff: HANDOFF });
  const unBefore = snapshot(un);
  const r = cur(un, ['--open'], { id: 'anyone' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([JSON.parse(r.stdout).number, JSON.parse(r.stdout).track, JSON.parse(r.stdout).isNew], ['0001', 'a', false]);
  const unAfter = snapshot(un);
  for (const k of Object.keys(unBefore)) if (/session-0001\.(json|md)$/.test(k)) assert.strictEqual(unAfter[k], unBefore[k], k + ' not rewritten by a resume');
});

// ── L11 no session id ─────────────────────────────────────────────────────────────────────────────────
test('L11 no readable session id: ONE unsealed track -> continuity; TWO -> exit 3 asking for --track, and a write verb refuses and writes nothing', () => {
  const one = tmpDir('lc-l11a-');
  H.putTrack(one, '0001', 'a', { owner: 'idA', handoff: HANDOFF });
  const r = cur(one, ['--open'], {});
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([JSON.parse(r.stdout).number, JSON.parse(r.stdout).track], ['0001', 'a']);
  assert.strictEqual(op(one, ['save', '--session', '1'], {}).code, 0, 'a write with one unsealed track lands on it');

  const two = tmpDir('lc-l11b-');
  H.putTrack(two, '0001', 'a', { owner: 'idA', handoff: HANDOFF });
  H.putTrack(two, '0001', 'b', { owner: 'idB', handoff: HANDOFF });
  const before = snapshot(two);
  const r2 = cur(two, ['--open'], {});
  assert.strictEqual(r2.code, 3, r2.stderr);
  assert.ok(/--track/.test(r2.stdout + r2.stderr), 'asks for --track');
  const w = op(two, ['save', '--session', '1'], {});
  assert.notStrictEqual(w.code, 0);
  assert.ok(/--track/.test(w.stdout + w.stderr), w.stderr);
  assert.deepStrictEqual(snapshot(two), before, 'refusals wrote nothing');
  const picked = cur(two, ['--open', '--track', 'b'], {});
  assert.strictEqual(picked.code, 0, picked.stderr);
  assert.strictEqual(JSON.parse(picked.stdout).track, 'b', '--track is the explicit way through');
});

// ── L12 older-version reader ──────────────────────────────────────────────────────────────────────────
test('L12 an older-version reader on a new record: schemaVersion is NOT bumped, and the frozen 0.2.0 boot-read reads a new multi-track store without crashing', () => {
  const sd = tmpDir('lc-l12-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: { where: 'PRIOR-A-WHERE', next: 'n', in_flight: [], must_not_redo: [] }, sealed: true });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: { where: 'PRIOR-B-WHERE', next: 'n', in_flight: [], must_not_redo: [] }, sealed: true });
  const rec = rawRec(sd, '0001', 'b');
  const CURRENT = require('../../lib/version').CURRENT;
  assert.strictEqual(rec.schemaVersion, CURRENT, 'schemaVersion is the shared constant');
  assert.strictEqual(rec.schemaVersion, '1.0.0', 'unchanged from the 0.2.0 release (an old reader must not refuse on version)');
  assert.ok(rec.meta.track === 'b' && rec.meta.claudeSessionId === 'idB' && rec.meta.lastWriter, 'additive meta keys present');
  // the CURRENT reader
  const now = H.run(H.BOOT_READ, ['--sessions-dir', sd], {});
  assert.strictEqual(now.code, 0, now.stderr);
  // the FROZEN 0.2.0 reader (read-only use of the baseline tree); skipped only when the baseline is not on this machine
  const old = path.resolve(__dirname, '..', '..', '..', '..', 'old', 'claude-tpm-0.2.0', 'tools', 'session', 'tpm-session-boot-read.js');
  if (!fs.existsSync(old)) { console.log('       (note: frozen 0.2.0 baseline not found; in-tree schema assertions only)'); return; }
  const r = H.run(old, ['--sessions-dir', sd], {});
  assert.strictEqual(r.code, 0, `the old reader never crashes boot: ${r.stderr}`);
  assert.ok(/PRIOR-A-WHERE/.test(r.stdout), `the old reader still reads track a of the new record:\n${r.stdout}`);
  assert.ok(!/PRIOR-B-WHERE/.test(r.stdout), 'the old reader does not know track b files (it skips them; documented)');
});

done('tracks-lifecycle.test');
