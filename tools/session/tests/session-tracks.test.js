'use strict';
/**
 * session-tracks.test.js — naming, trackState (the ONE "is it sealed" answer), ownership, scanning,
 * supersession, the derived hint, and write-track resolution (lib/session-tracks.js). DoD rows A, C, E.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tests/session-tracks.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const { T } = H;

// ── T-N: naming ──
test('T-N1 naming table: track a unsuffixed, b..z suffixed, round-trip through parseTrackFile', () => {
  const dir = tmpDir('trk-n1-');
  const a = T.trackPaths(dir, '21', 'a');
  const b = T.trackPaths(dir, '0021', 'b');
  assert.strictEqual(path.basename(a.jsonPath), 'session-0021.json');
  assert.strictEqual(path.basename(a.mdPath), 'session-0021.md');
  assert.strictEqual(path.basename(a.sealedPath), 'session-0021.sealed');
  assert.strictEqual(path.basename(b.jsonPath), 'session-0021-b.json');
  assert.strictEqual(path.basename(b.mdPath), 'session-0021-b.md');
  assert.strictEqual(path.basename(b.sealedPath), 'session-0021-b.sealed');
  assert.deepStrictEqual(T.parseTrackFile('session-0021.json'), { number: '0021', track: 'a', ext: 'json' });
  assert.deepStrictEqual(T.parseTrackFile('session-0021-z.sealed'), { number: '0021', track: 'z', ext: 'sealed' });
  assert.throws(() => T.trackPaths(dir, '0021', 'B'), (e) => e.code === 'ETRACK_ARG');
  assert.throws(() => T.trackPaths(dir, '0021', 'bb'), (e) => e.code === 'ETRACK_ARG');
});

test('T-N2 "-a", "-B", "-bb", ".bak" and a wrong-number file are UNRECOGNISED (reported), never a track', () => {
  const dir = tmpDir('trk-n2-');
  H.putTrack(dir, '0021', 'a');
  for (const n of ['session-0021-a.json', 'session-0021-B.json', 'session-0021-bb.json', 'session-0021-b.json.bak', 'session-0022-b.json']) H.putRaw(dir, '0021', n, '{}');
  const lf = T.listFolder(dir, '0021');
  assert.deepStrictEqual(lf.tracks.map((t) => t.track), ['a'], 'only the real track a is a track');
  const bad = lf.unrecognised.map((u) => u.file).sort();
  assert.deepStrictEqual(bad, ['session-0021-B.json', 'session-0021-a.json', 'session-0021-b.json.bak', 'session-0021-bb.json', 'session-0022-b.json']);
  assert.ok(/-a is not allowed/.test(lf.unrecognised.find((u) => u.file === 'session-0021-a.json').why));
  assert.ok(/does not match folder/.test(lf.unrecognised.find((u) => u.file === 'session-0022-b.json').why));
});

test('T-N3 a folder with only the original single record is read as track a, no migration, nothing written', () => {
  const dir = tmpDir('trk-n3-');
  const jp = H.putTrack(dir, '0007', 'a', { legacy: true, owner: 'sid-old' });
  const before = fs.readFileSync(jp, 'utf8');
  const st = T.trackState(dir, '0007', 'a');
  assert.strictEqual(st.track, 'a');
  assert.strictEqual(st.state, 'live');
  assert.strictEqual(st.record.meta.track, undefined, 'legacy record has no meta.track');
  assert.strictEqual(fs.readFileSync(jp, 'utf8'), before, 'reading never rewrites');
});

// ── T-S: trackState ──
test('T-S1 trackState: live / sealed-self / marker wins / marker without record / unreadable marker still sealed', () => {
  const dir = tmpDir('trk-s1-');
  H.putTrack(dir, '0001', 'a', { owner: 'x' });
  assert.deepStrictEqual([T.trackState(dir, '0001', 'a').state, T.trackState(dir, '0001', 'a').sealedBy], ['live', null]);
  H.putTrack(dir, '0002', 'a', { owner: 'x', sealed: true });
  assert.deepStrictEqual([T.trackState(dir, '0002', 'a').state, T.trackState(dir, '0002', 'a').sealedBy], ['sealed', 'self']);
  H.putTrack(dir, '0003', 'b', { owner: 'x' });
  H.putMarker(dir, '0003', 'b');
  const m = T.trackState(dir, '0003', 'b');
  assert.deepStrictEqual([m.state, m.sealedBy], ['sealed', 'marker'], 'a marker beats a live record');
  assert.strictEqual(m.sealedAt, '2026-10-07T11:00:00-07:00');
  H.putMarker(dir, '0004', 'c');
  const orphan = T.trackState(dir, '0004', 'c');
  assert.deepStrictEqual([orphan.state, orphan.sealedBy, orphan.record], ['sealed', 'marker', null]);
  assert.ok(orphan.warnings.includes('marker-without-record'));
  H.putTrack(dir, '0005', 'a', { owner: 'x' });
  H.putMarker(dir, '0005', 'a', 'not json {{');
  const bad = T.trackState(dir, '0005', 'a');
  assert.strictEqual(bad.state, 'sealed');
  assert.ok(bad.warnings.includes('marker-unreadable'), 'alarm, not wedge');
  assert.strictEqual(T.trackState(dir, '0099', 'a'), null, 'no files = not a track');
});

test('T-S1b unreadable reasons: corrupt / newer-schema / invalid; never throws', () => {
  const dir = tmpDir('trk-s1b-');
  H.putRaw(dir, '0001', 'session-0001.json', 'not json{');
  const jp = H.putTrack(dir, '0002', 'a', { owner: 'x' });
  const rec = JSON.parse(fs.readFileSync(jp, 'utf8')); rec.schemaVersion = '9.0.0';
  fs.writeFileSync(jp, JSON.stringify(rec));
  const jp3 = H.putTrack(dir, '0003', 'b', { owner: 'x' });
  const r3 = JSON.parse(fs.readFileSync(jp3, 'utf8')); r3.meta.track = 'B';
  fs.writeFileSync(jp3, JSON.stringify(r3));
  assert.strictEqual(T.trackState(dir, '0001', 'a').reason, 'corrupt');
  assert.strictEqual(T.trackState(dir, '0002', 'a').reason, 'newer-schema');
  const inv = T.trackState(dir, '0003', 'b');
  assert.deepStrictEqual([inv.state, inv.reason], ['unreadable', 'invalid']);
});

test('T-S2 filename wins over meta.track: a hand-copied record gets a track-mismatch warning', () => {
  const dir = tmpDir('trk-s2-');
  const jp = H.putTrack(dir, '0001', 'b', { owner: 'x' });
  const copy = path.join(path.dirname(jp), 'session-0001-c.json');
  fs.copyFileSync(jp, copy);
  const st = T.trackState(dir, '0001', 'c');
  assert.strictEqual(st.track, 'c');
  assert.ok(st.warnings.includes('track-mismatch'));
});

// ── T-O: ownership ──
test('T-O1 ownerOf: meta.claudeSessionId vs legacy sessionIds (LAST entry) vs none', () => {
  assert.deepStrictEqual(T.ownerOf({ claudeSessionId: 'me', sessionIds: ['old'] }).claudeSessionId, 'me');
  assert.strictEqual(T.ownerOf({ claudeSessionId: null, sessionIds: ['old'] }).claudeSessionId, null, 'explicit null owner is null, not the history');
  const leg = T.ownerOf({ sessionIds: ['first', 'last'] });
  assert.deepStrictEqual([leg.claudeSessionId, leg.source], ['last', 'legacy-sessionIds']);
  assert.deepStrictEqual([T.ownerOf({ sessionIds: [] }).claudeSessionId, T.ownerOf({ sessionIds: [] }).source], [null, 'none']);
});

test('T-O2 matching is by the CURRENT owner, never the sessionIds history', () => {
  const dir = tmpDir('trk-o2-');
  const jp = H.putTrack(dir, '0001', 'a', { owner: 'current-id' });
  const rec = JSON.parse(fs.readFileSync(jp, 'utf8')); rec.meta.sessionIds = ['history-id', 'current-id']; fs.writeFileSync(jp, JSON.stringify(rec));
  const scan = T.scanSessions(dir);
  const c = T.classify(T.unsealedTracks(scan), 'history-id');
  assert.strictEqual(c.mine.length, 0, 'an id only in the history is NOT mine');
  assert.strictEqual(c.other.length, 1);
  assert.strictEqual(T.classify(T.unsealedTracks(scan), 'current-id').mine.length, 1);
});

// ── T-X: supersession ──
test('T-X1 legacy unsealed record below the highest session is superseded; a new-shape one is NOT', () => {
  const dir = tmpDir('trk-x1-');
  H.putTrack(dir, '0001', 'a', { legacy: true, owner: 'old' });          // legacy, unsealed, lower
  H.putTrack(dir, '0002', 'a', { owner: 'new-lower' });                   // new-shape, unsealed, lower
  H.putTrack(dir, '0003', 'a', { owner: 'newest' });
  const scan = T.scanSessions(dir);
  assert.deepStrictEqual(scan.superseded.map((s) => s.number), ['0001']);
  const unsealed = T.unsealedTracks(scan).map((s) => s.number);
  assert.deepStrictEqual(unsealed, ['0002', '0003'], 'superseded is not unsealed-live; new-shape tracks are explicit');
  const hi = tmpDir('trk-x1b-');
  H.putTrack(hi, '0001', 'a', { legacy: true, owner: 'old' });
  assert.strictEqual(T.scanSessions(hi).superseded.length, 0, 'the HIGHEST session is never superseded');
});

// ── T-W: window ──
test('T-W1 window scans the newest N (+ extraNumbers); mode all scans every folder', () => {
  const dir = tmpDir('trk-w1-');
  for (let i = 1; i <= 5; i += 1) H.putTrack(dir, String(i).padStart(4, '0'), 'a', { owner: 'x', sealed: true });
  const w = T.scanSessions(dir, { windowSize: 2 });
  assert.deepStrictEqual(w.sessions.map((s) => s.number), ['0004', '0005']);
  const e = T.scanSessions(dir, { windowSize: 2, extraNumbers: ['0001'] });
  assert.deepStrictEqual(e.sessions.map((s) => s.number), ['0001', '0004', '0005']);
  assert.strictEqual(T.scanSessions(dir, { mode: 'all', windowSize: 2 }).sessions.length, 5);
});

// ── T-H: the derived hint ──
test('T-H1 deriveHint: a closed + b live -> open on that number; all closed -> closed; none -> null', () => {
  const dir = tmpDir('trk-h1-');
  assert.strictEqual(T.deriveHint(dir), null);
  H.putTrack(dir, '0001', 'a', { owner: 'x', sealed: true });
  H.putTrack(dir, '0001', 'b', { owner: 'y' });
  const open = T.deriveHint(dir);
  assert.deepStrictEqual([open.number, open.closedAt], ['0001', null]);
  H.putMarker(dir, '0001', 'b');
  const closed = T.deriveHint(dir);
  assert.strictEqual(closed.number, '0001');
  assert.ok(closed.closedAt, 'closed once every track is sealed (marker counts)');
  assert.deepStrictEqual(Object.keys(closed).sort(), ['closedAt', 'number', 'openedAt', 'sessionId'], 'old readers see exactly the four keys');
});

test('T-H2 writeHint is atomic, idempotent (byte-identical -> no rewrite), and corrupt hints never throw readHint', () => {
  const dir = tmpDir('trk-h2-');
  H.putTrack(dir, '0001', 'a', { owner: 'x' });
  const w1 = T.writeHint(dir);
  assert.strictEqual(w1.written, true);
  const w2 = T.writeHint(dir);
  assert.strictEqual(w2.written, false, 'unchanged -> not rewritten');
  fs.writeFileSync(T.hintPath(dir), '{ corrupt');
  const r = T.readHint(dir);
  assert.deepStrictEqual([r.present, r.ok], [true, false]);
  assert.strictEqual(T.writeHint(dir).written, true, 'a corrupt hint is repaired from the tracks');
  assert.strictEqual(T.readHint(dir).ok, true);
});

// ── write-track resolution ──
test('T-W2 resolveWriteTrack: mine wins; foreign-only -> ENOT_OWNER; null id + 1 unsealed -> it; null id + 2 -> ambiguous', () => {
  const dir = tmpDir('trk-w2-');
  H.putTrack(dir, '0001', 'a', { owner: 'idA' });
  H.putTrack(dir, '0001', 'b', { owner: 'idB' });
  const r = (identity, track) => T.resolveWriteTrack({ sessionsDir: dir, number: '0001', identity, track });
  assert.strictEqual(r(H.id('idB')).track, 'b');
  assert.strictEqual(r(H.id('idA')).track, 'a');
  assert.throws(() => r(H.id('idC')), (e) => e.code === 'ENOT_OWNER' && /belong to another Claude session/.test(e.message));
  assert.throws(() => r(H.id(null)), (e) => e.code === 'ETRACK_AMBIGUOUS');
  assert.strictEqual(r(H.id('idA'), 'a').track, 'a');
  assert.throws(() => r(H.id('idA'), 'b'), (e) => e.code === 'ENOT_OWNER');
  assert.throws(() => r(H.id('idA'), 'q'), (e) => e.code === 'ENO_TRACK');
  assert.throws(() => r(H.id('idA'), 'Q'), (e) => e.code === 'ETRACK_ARG');
  const one = tmpDir('trk-w2b-');
  H.putTrack(one, '0001', 'a', { owner: 'idA' });
  assert.strictEqual(T.resolveWriteTrack({ sessionsDir: one, number: '0001', identity: H.id(null) }).track, 'a');
});

test('T-W3 resolveWriteTrack: an all-sealed lone track still resolves (close-then-note keeps working); empty folder -> a', () => {
  const dir = tmpDir('trk-w3-');
  H.putTrack(dir, '0001', 'a', { owner: 'idA', sealed: true });
  assert.strictEqual(T.resolveWriteTrack({ sessionsDir: dir, number: '0001', identity: H.id('idA') }).track, 'a');
  assert.strictEqual(T.resolveWriteTrack({ sessionsDir: dir, number: '0042', identity: H.id('idA') }).track, 'a');
});

done('session-tracks.test');
