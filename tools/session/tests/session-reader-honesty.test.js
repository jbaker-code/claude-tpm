'use strict';
/**
 * session-reader-honesty.test.js — DoD H (decision B1(a)): a reader that meets a track record it cannot
 * parse LISTS it (count + names + reason) and never silently drops it; `boot-read` never says
 * "this looks like the first session" over a skipped record. Hermetic; exits non-zero on failure.
 * Run: node tests/session-reader-honesty.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');

const FIRST = /looks like the first session/;
const boot = (sd, id) => H.run(H.BOOT_READ, ['--sessions-dir', sd], id ? { id } : {});

test('T-H1 fixture: one UNREADABLE track b beside a good lower session -> prior shown AND the skipped record listed', () => {
  const sd = tmpDir('hon-h1-');
  H.putTrack(sd, '0006', 'a', { owner: 'x', sealed: true, handoff: { where: 'GOOD-LOWER', next: 'n' } });
  H.putTrack(sd, '0007', 'a', { owner: 'x', sealed: true, handoff: { where: 'GOOD-7', next: 'n' } });
  H.putRaw(sd, '0007', 'session-0007-b.json', 'corrupt{');
  H.putRaw(sd, '0008', 'session-0008.json', '{ broken');
  const r = boot(sd);
  assert.strictEqual(r.code, 0);
  assert.ok(/PRIOR SESSION 0007/.test(r.stdout) && /GOOD-7/.test(r.stdout));
  assert.ok(/note: 1 newer record\(s\) were skipped \(unreadable\): 0008 \(corrupt\)/.test(r.stdout), r.stdout);
  // phase 13: every track of a shown session is rendered, so the unreadable b is its OWN block saying where to read (no longer "not shown by this reader version")
  assert.ok(/=== TRACK b · UNREADABLE \(corrupt\) ===\nread this file directly: .*session-0007-b\.json/.test(r.stdout), 'the unreadable track is announced in its own block, not hidden');
  assert.ok(!/not shown by this reader version/.test(r.stdout));
  assert.ok(!FIRST.test(r.stdout));
});

test('T-H2 ONLY unreadable records: "no prior session found" is kept but with count + names + reason, never "first session"', () => {
  const sd = tmpDir('hon-h2-');
  H.putRaw(sd, '0009', 'session-0009.json', 'x{');
  H.putTrack(sd, '0008', 'b', { owner: 'x' });
  const f = path.join(sd, 'session-0008', 'session-0008-b.json');
  const rec = JSON.parse(fs.readFileSync(f, 'utf8')); rec.schemaVersion = '9.0.0'; fs.writeFileSync(f, JSON.stringify(rec));
  const r = boot(sd);
  assert.ok(/boot-read: no prior session found/.test(r.stdout));
  assert.ok(/2 record\(s\) could not be read and were skipped: 0009 \(corrupt\), 0008 track b \(newer-schema\)/.test(r.stdout), r.stdout);
  assert.ok(/NOT necessarily the first session/.test(r.stdout) && !FIRST.test(r.stdout));
});

test('T-H3 "first session" is said ONLY when nothing was skipped and no folder was hollow', () => {
  assert.ok(FIRST.test(boot(tmpDir('hon-h3-')).stdout), 'a genuinely empty store still says so');
  const hollow = tmpDir('hon-h3b-');
  fs.mkdirSync(path.join(hollow, 'session-0003'), { recursive: true });   // folder with no record at all
  const r = boot(hollow);
  assert.ok(!FIRST.test(r.stdout) && /1 session folder\(s\) held no readable record/.test(r.stdout), r.stdout);
});

test('T-H4 a corrupt hint file does not hide anything and boot-read still exits 0', () => {
  const sd = tmpDir('hon-h4-');
  H.putTrack(sd, '0001', 'a', { owner: 'x', sealed: true, handoff: { where: 'W1', next: 'n' } });
  fs.writeFileSync(path.join(sd, '.current-session.json'), '{ nope');
  const r = boot(sd);
  assert.strictEqual(r.code, 0);
  assert.ok(/PRIOR SESSION 0001/.test(r.stdout));
});

test('T-H5 the resolver listing: --state returns skipped[] and unrecognised[] (a hand-made -a file is NOT track a)', () => {
  const sd = tmpDir('hon-h5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true });
  H.putRaw(sd, '0001', 'session-0001-a.json', '{}');
  H.putRaw(sd, '0001', 'session-0001-c.json', 'bad{');
  const st = JSON.parse(H.run(H.CURRENT, ['--sessions-dir', sd, '--state'], { id: 'idA' }).stdout);
  assert.deepStrictEqual(st.skipped.map((s) => [s.number, s.track, s.reason]), [['0001', 'c', 'corrupt']]);
  assert.deepStrictEqual(st.unrecognised.map((u) => u.file), ['session-0001-a.json']);
});

test('T-H6 doctor CHECKS track files (phase 14: the "not checked by this version" advisory is gone) and export INCLUDES them (phase 12)', () => {
  const sd = tmpDir('hon-h6-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true, handoff: { where: 'w', next: 'n' } });
  const doctor = path.join(__dirname, '..', 'tpm-session-doctor.js');
  const plain = H.run(doctor, ['--sessions-dir', sd], {});
  assert.ok(!/track record file/.test(plain.stderr), 'no track files -> no advisory');
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  const withB = H.run(doctor, ['--sessions-dir', sd], {});
  // phase 14: the doctor reads every track, so the advisory is gone and track b has its own row
  assert.ok(!/not checked by this version/.test(withB.stderr), withB.stderr);
  assert.ok(/session-0001\/session-0001-b\.json  OK/.test(withB.stdout), withB.stdout);
  const exp = H.run(path.join(__dirname, '..', 'tpm-session-export.js'), ['--sessions-dir', sd, '--session', '1', '--style', 'json'], {});
  assert.strictEqual(exp.code, 0, exp.stderr);
  // phase 12: export reads every track, so the "not included by this version" advisory is gone and track b is in the output
  assert.ok(!/not included by this version/.test(exp.stderr), exp.stderr);
  const arr = JSON.parse(exp.stdout);
  assert.deepStrictEqual(arr.map((r) => r.meta.track || 'a'), ['a', 'b']);
});

done('session-reader-honesty.test');
