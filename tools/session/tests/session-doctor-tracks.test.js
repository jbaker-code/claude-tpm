'use strict';
/**
 * session-doctor-tracks.test.js — phase 14 DoD B: the doctor understands tracks (report-only).
 *  - no false DRIFT on tracks b/c (each record is paired with ITS OWN .md); a folder with only -b is not "old-format";
 *  - a healthy multi-track session reports clean (--strict exit 0);
 *  - stale unsealed track (configurable age) and unsealed track whose owner process is gone, each with the seal hint;
 *  - seal marker without a record; two records claiming one track; file name vs meta.track;
 *  - `.lock*` leftovers flagged, a `.sealed` marker is not an "unchecked record", `session-notes.md` stays silent;
 *  - sealed-ness comes from trackState (a marker-sealed track whose record says "open" is informational, not an advisory);
 *  - STRICTLY read-only (sha256 of the whole store before == after).
 * Run: node tests/session-doctor-tracks.test.js
 */
const os = require('os');
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');
const doctor = require('../tpm-session-doctor');

const TOOL = path.join(H.OPS, '..', 'tpm-session-doctor.js');
const HOST = os.hostname();
const NOW_MS = Date.parse('2026-10-08T12:00:00-07:00');
const run = (sd, extra) => doctor.runDoctor(Object.assign({ sessionsDir: sd, strict: true, now: NOW_MS, isAlive: () => true, startedAt: () => null, hostname: HOST }, extra || {}));
const jp = (sd, t) => H.T.trackPaths(sd, '0001', t).jsonPath;
const edit = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n'); };
const issuesOf = (rep, file) => (rep.results.find((r) => r.file.endsWith(file)) || { issues: [] }).issues.map((i) => i.code);

test('B-1 healthy three-track session: clean, exit 0 even with --strict, no false DRIFT on b/c, every track has a row', () => {
  const sd = tmpDir('dt-1-'); TT.build(sd, '0001');
  const rep = run(sd);
  assert.strictEqual(rep.exitCode, 0, JSON.stringify(rep.results.map((r) => r.issues)));
  assert.deepStrictEqual(rep.results.map((r) => [path.basename(r.file), r.track, r.state, r.drift.status]), [
    ['session-0001.json', 'a', 'sealed-self', 'OK'], ['session-0001-b.json', 'b', 'sealed-marker', 'OK'], ['session-0001-c.json', 'c', 'live', 'OK'],
  ]);
  assert.strictEqual(rep.summary.drift, 0);
  assert.strictEqual(rep.summary.trackAdvisories, 0, 'the stale-.md note on the marker-sealed track is informational');
  assert.deepStrictEqual(issuesOf(rep, 'session-0001-b.json'), ['MARKER-STALE-RECORD']);
});

test('B-2 a track c hand-edited out of sync with its OWN .md IS a drift (the pairing is real, not blanket)', () => {
  const sd = tmpDir('dt-2-'); TT.build(sd, '0001');
  edit(jp(sd, 'c'), (j) => { j.handoff.next = 'changed behind the .md'; });
  const rep = run(sd);
  assert.deepStrictEqual(rep.results.filter((r) => r.drift.status === 'DRIFT').map((r) => r.track), ['c']);
});

test('B-3 folder holding only -b / -c: current-format, not old-format (no false "not auto-migratable")', () => {
  const sd = tmpDir('dt-3-'); H.putTrack(sd, '0001', 'b', { owner: 'idB' }); H.putTrack(sd, '0001', 'c', { owner: 'idC' });
  const rep = run(sd);
  assert.strictEqual(rep.oldFormat.length, 0); assert.strictEqual(rep.results.length, 2);
});

test('B-4 stale unsealed track: flagged past the configurable age WITH the seal hint; a larger limit clears it; sealed tracks never stale', () => {
  const sd = tmpDir('dt-4-'); TT.build(sd, '0001');
  const later = NOW_MS + 5 * 24 * 3600 * 1000;
  const rep = run(sd, { now: later });
  assert.strictEqual(rep.exitCode, 2);
  assert.deepStrictEqual(rep.results.filter((r) => r.issues.some((i) => i.code === 'STALE')).map((r) => r.track), ['c']);
  const stale = rep.results.find((r) => r.track === 'c').issues.find((i) => i.code === 'STALE');
  assert.ok(/tpm session close --session 0001 --track c --confirm/.test(stale.message), stale.message);
  assert.strictEqual(run(sd, { now: later, staleMs: 10 * 24 * 3600 * 1000 }).exitCode, 0, 'limit is configurable');
});

test('B-5 unsealed track whose owner process is gone: flagged with the hint; running or unknown is not', () => {
  const sd = tmpDir('dt-5-'); TT.build(sd, '0001');
  edit(jp(sd, 'c'), (j) => { j.meta.claudePid = 4242; j.meta.hostname = HOST; });
  const gone = run(sd, { isAlive: () => false });
  assert.deepStrictEqual(gone.results.filter((r) => r.issues.some((i) => i.code === 'OWNER-GONE')).map((r) => r.track), ['c']);
  assert.ok(/--track c --confirm/.test(gone.results[2].issues.find((i) => i.code === 'OWNER-GONE').message));
  assert.ok(!issuesOf(run(sd, { isAlive: () => true }), 'session-0001-c.json').includes('OWNER-GONE'));
  edit(jp(sd, 'c'), (j) => { j.meta.hostname = 'another-host'; });
  assert.ok(!issuesOf(run(sd, { isAlive: () => false }), 'session-0001-c.json').includes('OWNER-GONE'), 'another host is never judged by pid');
  assert.strictEqual(run(sd, { isAlive: () => false }).summary.ownerGone, 0);
});

test('B-6 a seal marker with no record, and an unreadable marker, are reported (the track still reads as sealed)', () => {
  const sd = tmpDir('dt-6-'); TT.build(sd, '0001');
  H.putMarker(sd, '0001', 'd', undefined);                       // no session-0001-d.json
  H.putMarker(sd, '0001', 'c', '{ nope');                        // c: record present, marker garbage
  const rep = run(sd);
  const d = rep.results.find((r) => r.track === 'd');
  assert.ok(d && d.validate.status === 'NO-RECORD' && d.issues.some((i) => i.code === 'MARKER-WITHOUT-RECORD'));
  assert.ok(issuesOf(rep, 'session-0001-c.json').includes('MARKER-UNREADABLE'));
  assert.strictEqual(rep.exitCode, 2);
  assert.strictEqual(rep.results.find((r) => r.track === 'c').state, 'sealed-marker', 'a marker that exists wins');
});

test('B-7 two records claiming one track: a stray session-0001-a.json beside track a, and b whose meta says c', () => {
  const sd = tmpDir('dt-7-'); TT.build(sd, '0001');
  fs.copyFileSync(jp(sd, 'a'), jp(sd, 'a').replace(/\.json$/, '-a.json'));
  edit(jp(sd, 'b'), (j) => { j.meta.track = 'c'; });
  const rep = run(sd);
  assert.ok(rep.notes.some((n) => n.code === 'DUPLICATE-TRACK' && /session-0001-a\.json/.test(n.message)), JSON.stringify(rep.notes));
  // one fault -> one finding: b's TRACK-MISMATCH carries the collision with c; neither row also prints DUPLICATE-TRACK
  const bIs = issuesOf(rep, 'session-0001-b.json'); const cIs = issuesOf(rep, 'session-0001-c.json');
  assert.ok(bIs.includes('TRACK-MISMATCH') && !bIs.includes('DUPLICATE-TRACK') && !cIs.includes('DUPLICATE-TRACK'), JSON.stringify({ bIs, cIs }));
  assert.ok(rep.results.find((r) => r.track === 'b').issues.find((i) => i.code === 'TRACK-MISMATCH').message.includes('session-0001-c.json'));
});

test('B-8 file name vs meta.track disagree -> TRACK-MISMATCH; an absent meta.track on a b..z file too; track a without meta.track (legacy) is fine', () => {
  const sd = tmpDir('dt-8-'); TT.build(sd, '0001');
  edit(jp(sd, 'c'), (j) => { j.meta.track = 'b'; });
  assert.ok(issuesOf(run(sd), 'session-0001-c.json').includes('TRACK-MISMATCH'));
  edit(jp(sd, 'c'), (j) => { delete j.meta.track; });
  assert.ok(issuesOf(run(sd), 'session-0001-c.json').includes('TRACK-MISMATCH'));
  const legacy = tmpDir('dt-8b-'); H.putTrack(legacy, '0001', 'a', { owner: 'idA', legacy: true });
  assert.ok(!issuesOf(run(legacy), 'session-0001.json').includes('TRACK-MISMATCH'));
});

test('B-9 .lock leftovers flagged; root dot-dirs are skipped (not old-format); .sealed and session-notes.md are not "unchecked records"', () => {
  const sd = tmpDir('dt-9-'); TT.build(sd, '0001');
  fs.mkdirSync(path.join(sd, '.lock')); fs.mkdirSync(path.join(sd, '.lock.broken.1.2'));
  fs.writeFileSync(path.join(sd, '.lock.broken.1.2', 'note.md'), 'x');   // a dot-dir with markup would read as an old-format session if it were not skipped
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-notes.md'), 'x');
  let rep = run(sd);
  assert.strictEqual(rep.exitCode, 0, JSON.stringify(rep.notes)); assert.strictEqual(rep.oldFormat.length, 0);
  fs.mkdirSync(path.join(sd, 'session-0001', '.lock.broken.123.456'));
  rep = run(sd);
  assert.ok(rep.notes.some((n) => n.code === 'LOCK-LEFTOVER' && /\.lock\.broken\.123\.456/.test(n.message)));
  assert.strictEqual(rep.exitCode, 2);
  const r = H.run(TOOL, ['--sessions-dir', sd]);
  assert.ok(!/not checked by this version/.test(r.stderr), 'the old advisory is gone: ' + r.stderr);
});

test('B-10 a mis-named session-0001-xx.json is surfaced; a stale *.tmp is a leftover', () => {
  const sd = tmpDir('dt-10-'); TT.build(sd, '0001');
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-xx.json'), '{}');
  const tmp = path.join(sd, 'session-0001', '.session-0001-b.claim.1.tmp'); fs.writeFileSync(tmp, 'x');
  const old = new Date(NOW_MS - 3600000); fs.utimesSync(tmp, old, old);
  const rep = run(sd);
  assert.ok(rep.notes.some((n) => n.code === 'UNRECOGNISED' && /session-0001-xx\.json/.test(n.message)));
  assert.ok(rep.notes.some((n) => n.code === 'LEFTOVER-TMP'));
});

test('B-11 --track narrows (letter / id prefix); malformed exits 2; no match exits 1', () => {
  const sd = tmpDir('dt-11-'); TT.build(sd, '0001');
  const j = (a) => { const r = H.run(TOOL, ['--sessions-dir', sd, '--json', ...a]); return { code: r.code, rep: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr }; };
  assert.deepStrictEqual(j(['--track', 'b']).rep.results.map((r) => r.track), ['b']);
  assert.deepStrictEqual(j(['--track', 'cccccccc']).rep.results.map((r) => r.track), ['c']);
  assert.strictEqual(j(['--track', 'xx']).code, 2);
  assert.strictEqual(j(['--track', 'q']).code, 1);
});

test('B-12 CLI: --stale-after parses and rejects junk; human output shows the state and the hint', () => {
  const sd = tmpDir('dt-12-'); TT.build(sd, '0001');
  const bad = H.run(TOOL, ['--sessions-dir', sd, '--stale-after', 'soon']);
  assert.strictEqual(bad.code, 2);
  edit(jp(sd, 'c'), (j) => { j.meta.openedAt = '2026-09-01T00:00:00-07:00'; j.meta.lastWriter.at = '2026-09-01T00:00:00-07:00'; j.handoff.updatedAt = '2026-09-01T00:00:00-07:00'; });
  const r = H.run(TOOL, ['--sessions-dir', sd, '--stale-after', '2d', '--strict']);
  assert.strictEqual(r.code, 2);
  assert.ok(/session-0001-c\.json  OK · live · owner cccccccc.*STALE:.*tpm session close --session 0001 --track c --confirm/.test(r.stdout), r.stdout);
  assert.ok(/SEALED by marker \(abandoned 2026-10-07T11:00:00-07:00\)/.test(r.stdout));
});

test('B-13 single-track store: a healthy lone track prints exactly today\'s line, no state text', () => {
  const sd = tmpDir('dt-13-'); H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true });
  const out = doctor.renderHuman(run(sd, { strict: false }));
  assert.ok(/^  session-0001\/session-0001\.json  OK$/m.test(out), out);
  assert.ok(/1 session\(s\) · 1 valid/.test(out));
});

test('B-14 STRICTLY read-only: every report over a messy store leaves the whole store byte-identical', () => {
  const sd = tmpDir('dt-14-'); TT.build(sd, '0001');
  H.putMarker(sd, '0001', 'd', undefined); fs.mkdirSync(path.join(sd, 'session-0001', '.lock.broken.1.2'));
  const before = TT.shas(sd);
  run(sd, { now: NOW_MS + 9e9 }); H.run(TOOL, ['--sessions-dir', sd, '--json', '--strict']); H.run(TOOL, ['--sessions-dir', sd, '--track', 'b']);
  assert.deepStrictEqual(TT.shas(sd), before);
});

test('B-15 a hint that disagrees with the tracks is an informational note (non-authoritative; never an advisory)', () => {
  const sd = tmpDir('dt-15-'); TT.build(sd, '0001');
  fs.writeFileSync(path.join(sd, '.current-session.json'), JSON.stringify({ sessionId: 'x', number: '0001', openedAt: '2026-10-08T00:00:00.000Z', closedAt: '2026-10-08T01:00:00.000Z' }));
  const rep = run(sd);
  assert.ok(rep.notes.some((n) => n.code === 'HINT-DISAGREES' && n.severity === 'info'), JSON.stringify(rep.notes));
  assert.strictEqual(rep.exitCode, 0);
});

done('session-doctor-tracks.test.js');
