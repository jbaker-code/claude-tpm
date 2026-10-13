'use strict';
/**
 * session-collate.test.js — phase 12 (DoD A, B, G): the converter's additive options leave every default byte
 * unchanged; `review` / `export` print the MERGED, track-attributed view of a multi-track session (state from
 * trackState, never the .md or closedAt); `--track` narrows (a letter or a >=8-char Claude id); a single-track
 * session's output is BYTE-IDENTICAL to the pre-phase-12 baseline; no read verb writes. Hermetic; exits non-zero.
 * Run: node tests/session-collate.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');
const baseline = require('./helpers/baseline-scenario');
const { render } = require('../lib/session-converter');
const model = require('../lib/session-model');
const exporter = require('../tpm-session-export');
const collate = require('../lib/session-collate');
const { T } = H;

const EXPORT = path.join(H.OPS, '..', 'tpm-session-export.js');
const NOW = '2026-10-08T00:30:00-07:00';
const exp = (sd, args, o) => H.run(EXPORT, ['--sessions-dir', sd, ...args], o);
const GOLDEN = path.join(__dirname, 'golden');

// timestamps, hashes, dates and ages come from the real clock when the fixture is built: normalise them
function norm(text) {
  return text
    .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[-+]\d\d:\d\d/g, '<TS>')
    .replace(/generated from: [0-9a-f]{12}/g, 'generated from: <H>')
    .replace(/Session (\d{4}) · \d{4}-\d\d-\d\d/g, 'Session $1 · <DATE>')
    .replace(/_\(\d+[mhd] ago\)_/g, '_(<AGE>)_')
    .replace(/_\(closed \d\d:\d\d\)_/g, '_(closed <T>)_');
}

// ── the converter's additive options ─────────────────────────────────────────────────────────

const FIX = JSON.parse(fs.readFileSync(path.join(GOLDEN, 'session-0021.fixture.json'), 'utf8'));

test('C-1 render(r,{now}) is byte-identical with every new option undefined/false, and equals the stored golden', () => {
  const plain = render(FIX, { now: '2026-09-19T13:36:00-07:00' });
  assert.strictEqual(render(FIX, { now: '2026-09-19T13:36:00-07:00', displayId: undefined, stateWord: undefined, trackLabel: false }), plain);
  assert.strictEqual(render(FIX, { now: '2026-09-19T13:36:00-07:00', stateWord: '' }), plain, 'an empty stateWord is ignored');
  assert.strictEqual(plain, fs.readFileSync(path.join(GOLDEN, 'session-0021.expected.md'), 'utf8'));
});

function itemRecord() {
  let r = model.openTrack({ number: '0007', track: 'a', identity: H.id('idA'), tpmVersion: '0.2.0', lastWriterVersion: '0.2.0-dev' });
  r = model.addPunchlist(r, { text: 'open one', slug: 'o1' });
  r = model.addPunchlist(r, { text: 'done one', slug: 'd1' });
  return model.closePunchlistItem(r, 'd1');
}

test('C-2 displayId hits ONLY the two id print sites; the banner hash is unchanged', () => {
  const r = itemRecord();
  const a = render(r, { now: NOW });
  const b = render(r, { now: NOW, displayId: (id) => id.replace('.', 'a.') });
  const la = a.split('\n'); const lb = b.split('\n');
  assert.strictEqual(la.length, lb.length);
  const diff = la.map((l, i) => [l, lb[i]]).filter(([x, y]) => x !== y);
  assert.strictEqual(diff.length, 2, JSON.stringify(diff));
  assert.ok(diff.every(([x, y]) => /`#7\.\d`/.test(x) && /`#7a\.\d`/.test(y)));
  assert.strictEqual(a.match(/generated from: ([0-9a-f]{12})/)[1], b.match(/generated from: ([0-9a-f]{12})/)[1]);
});

test('C-3 stateWord replaces only the banner word', () => {
  const r = itemRecord();
  const a = render(r, { now: NOW });
  const b = render(r, { now: NOW, stateWord: 'sealed by marker (abandoned)' });
  assert.strictEqual(b, a.replace('**open**', '**sealed by marker (abandoned)**'));
});

test('C-4 trackLabel names track a/absent in the title only; b..z (already labelled) are not doubled', () => {
  const a = itemRecord();
  assert.ok(render(a, { now: NOW, trackLabel: true }).startsWith('# Session 0007 · '));
  assert.ok(/^# Session 0007 · \S+ · track a\n/.test(render(a, { now: NOW, trackLabel: true })));
  assert.ok(!/ · track a\n/.test(render(a, { now: NOW })));
  const b = model.openTrack({ number: '0007', track: 'b', identity: H.id('idB'), tpmVersion: '0.2.0', lastWriterVersion: '0.2.0-dev' });
  assert.strictEqual(render(b, { now: NOW, trackLabel: true }), render(b, { now: NOW }));
  assert.ok(/ · track b\n/.test(render(b, { now: NOW })));
});

// ── the merged read ──────────────────────────────────────────────────────────────────────────

test('COL-1 three tracks (a closed by owner, b sealed by marker, c live): the merged review equals the golden shape', () => {
  const sd = tmpDir('col-1-'); TT.build(sd, '0001');
  const r = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stderr, '', 'a three-track read has no stderr noise');
  const got = norm(r.stdout);
  const gp = path.join(GOLDEN, 'review-3track.expected.txt');
  if (!fs.existsSync(gp)) fs.writeFileSync(gp, got);
  assert.strictEqual(got, fs.readFileSync(gp, 'utf8'));
  // the properties the golden stands for, stated outright
  assert.ok(got.startsWith('# Session 0001 · 3 parallel tracks\n\n| track | state | owner | opened | last write |'));
  assert.ok(got.includes('| a | sealed (closed) | aaaaaaaa |') && got.includes('| b | sealed (abandoned) | bbbbbbbb |') && got.includes('| c | live | cccccccc |'));
  assert.ok(got.includes('`#1a.2` fix flaky retry test') && got.includes('`#1b.1` port the exporter') && got.includes('`#1c.1` benchmark the lock'));
  assert.ok(got.includes('## Open punchlist, all tracks (4)'));
  assert.ok(got.includes('4. `#1c.1` [track c] benchmark the lock'));
});

test('COL-2 b\'s banner says "sealed by marker (abandoned)" while its record has closedAt:null and its .md says open; nothing on disk changes', () => {
  const sd = tmpDir('col-2-'); TT.build(sd, '0001');
  const rec = JSON.parse(fs.readFileSync(T.trackPaths(sd, '0001', 'b').jsonPath, 'utf8'));
  assert.strictEqual(rec.meta.closedAt, null);
  assert.ok(/\*\*open\*\*/.test(fs.readFileSync(T.trackPaths(sd, '0001', 'b').mdPath, 'utf8')));
  const before = TT.shas(path.join(sd, 'session-0001'));
  const r = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  assert.ok(/id bbbbbbbb….*\n/.test(r.stdout) && /\*\*sealed by marker \(abandoned\)\*\*/.test(r.stdout));
  assert.ok(!/session 0001 · \*\*open\*\* · schema 1\.0\.0 · id bbbbbbbb/.test(r.stdout), 'b is not shown as open');
  assert.deepStrictEqual(TT.shas(path.join(sd, 'session-0001')), before, 'a read writes NOTHING (every file sha256 equal)');
});

test('COL-3 --track b / bbbbbbbb / bbbbbbbb-2 narrow to track b; B, bbbb -> exit 2; q and dddddddd -> exit 1', () => {
  const sd = tmpDir('col-3-'); TT.build(sd, '0001');
  const only = (args) => {
    const r = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW, ...args]);
    assert.strictEqual(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith('# Session 0001 · '), r.stdout.slice(0, 60));
    assert.ok(/ · track b\n/.test(r.stdout) && !/track c\n/.test(r.stdout) && !/parallel tracks/.test(r.stdout) && !/all tracks/.test(r.stdout));
    assert.ok(r.stdout.includes('`#1b.1`') && !r.stdout.includes('`#1c.1`'));
    return r.stdout;
  };
  const byLetter = only(['--track', 'b']);
  assert.strictEqual(only(['--track', 'bbbbbbbb']), byLetter);
  assert.strictEqual(only(['--track', 'BBBBBBBB-22']), byLetter);
  for (const bad of ['B', 'bbbb', 'abcdefg']) {
    const r = exp(sd, ['--session', '1', '--track', bad]);
    assert.strictEqual(r.code, 2, bad);
    assert.ok(/is not a track: give one letter a-z or at least 8 characters of a Claude session id\. Nothing was read\./.test(r.stderr), r.stderr);
    assert.strictEqual(r.stdout, '');
  }
  for (const missing of ['q', 'dddddddd']) {
    const r = exp(sd, ['--session', '1', '--track', missing]);
    assert.strictEqual(r.code, 1, missing);
    assert.strictEqual(r.stdout, '', 'an unknown value is an error, never an empty result');
  }
});

test('COL-4 --track a prints #1a.2 on a multi-track session and #1.2 on a single-track session', () => {
  const sd = tmpDir('col-4-'); TT.build(sd, '0001');
  const multi = exp(sd, ['--session', '1', '--style', 'human', '--track', 'a', '--now', NOW]);
  assert.ok(multi.stdout.includes('`#1a.2`') && !multi.stdout.includes('`#1.2`'));
  const one = tmpDir('col-4b-');
  H.putTrack(one, '0001', 'a', { owner: 'idA', handoff: { where: 'w', next: 'n', in_flight: [], must_not_redo: [] } });
  require('../tpm-session-ops').opPunchlist({ sessionsDir: one, number: '0001', action: 'add', text: 'x', slug: 'x1' });
  const single = exp(one, ['--session', '1', '--style', 'human', '--track', 'a', '--now', NOW]);
  assert.ok(single.stdout.includes('`#1.1`') && !single.stdout.includes('1a.1'), single.stdout);
});

test('COL-5 a SINGLE-track session: every read verb and every write verb prints the pre-phase-12 bytes (golden/single-track-baseline.txt)', () => {
  const got = baseline.transcript();
  assert.strictEqual(got, fs.readFileSync(path.join(GOLDEN, 'single-track-baseline.txt'), 'utf8'));
});

test('COL-6 JSON: one record -> bare envelope; three tracks -> bare array a,b,c; one marker note per marker-sealed track', () => {
  const sd = tmpDir('col-6-'); TT.build(sd, '0001');
  const r = exp(sd, ['--session', '1', '--style', 'json']);
  assert.strictEqual(r.code, 0, r.stderr);
  const arr = JSON.parse(r.stdout);
  assert.ok(Array.isArray(arr));
  assert.deepStrictEqual(arr.map((x) => x.meta.track), ['a', 'b', 'c']);
  assert.strictEqual(arr[1].meta.closedAt, null, 'records are the on-disk envelopes verbatim (no state injected)');
  assert.strictEqual(r.stderr, 'note: track b of 0001 is sealed by a marker (abandoned); its JSON record still says meta.closedAt = null - the marker is authoritative\n');
  const one = exp(sd, ['--session', '1', '--style', 'json', '--track', 'c']);
  assert.ok(!Array.isArray(JSON.parse(one.stdout)) && JSON.parse(one.stdout).meta.track === 'c');
  assert.strictEqual(one.stderr, '');
  const single = tmpDir('col-6b-'); H.putTrack(single, '0001', 'a', { owner: 'idA' });
  assert.ok(!Array.isArray(JSON.parse(exp(single, ['--session', '1', '--style', 'json']).stdout)));
});

test('COL-7 --combine per-file --out writes session-0001.md (merged) and session-0001.json, -b.json, -c.json; nothing overwritten', () => {
  const sd = tmpDir('col-7-'); TT.build(sd, '0001');
  const out = tmpDir('col-7-out-');
  const r = exp(sd, ['--session', '1', '--style', 'both', '--combine', 'per-file', '--out', out, '--now', NOW]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['session-0001-b.json', 'session-0001-c.json', 'session-0001.json', 'session-0001.md']);
  assert.ok(fs.readFileSync(path.join(out, 'session-0001.md'), 'utf8').startsWith('# Session 0001 · 3 parallel tracks'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(out, 'session-0001-b.json'), 'utf8')).meta.track, 'b');
  // narrowed human is named for its track
  const out2 = tmpDir('col-7b-');
  exp(sd, ['--session', '1', '--style', 'human', '--track', 'c', '--out', out2, '--now', NOW]);
  assert.deepStrictEqual(fs.readdirSync(out2), ['session-0001-c.md']);
});

test('COL-8 --last counts SESSIONS, newest first, each expanded to its tracks; --session 1,2 mixes single and multi', () => {
  const sd = tmpDir('col-8-'); TT.build(sd, '0001');
  H.putTrack(sd, '0002', 'a', { owner: 'idX', handoff: { where: 'w2', next: 'n2', in_flight: [], must_not_redo: [] } });
  const last1 = JSON.parse(exp(sd, ['--last', '1', '--style', 'json']).stdout);
  assert.strictEqual(last1.meta.number, '0002', '--last 1 is the newest SESSION (a single record -> bare envelope)');
  const last2 = JSON.parse(exp(sd, ['--last', '2', '--style', 'json']).stdout);
  assert.deepStrictEqual(last2.map((r) => `${r.meta.number}${r.meta.track || 'a'}`), ['0002a', '0001a', '0001b', '0001c']);
  const both = exp(sd, ['--session', '1,2', '--style', 'human', '--now', NOW]).stdout;
  assert.ok(both.indexOf('# Session 0001 · 3 parallel tracks') >= 0 && both.indexOf('# Session 0002 · ') > both.indexOf('## Open punchlist, all tracks'));
  const lib = exporter.exportSessions({ sessionsDir: sd, last: 2, styles: ['json'], combine: 'one-file' });
  assert.strictEqual(lib.outputs.length, 1);
  assert.strictEqual(lib.outputs[0].suggestedName, 'sessions-last-2.json', 'the combined name counts sessions');
});

test('COL-9 an unreadable track b: a table row, the 3-line block, the other tracks print, exit 0; JSON skips it with a stderr note', () => {
  const sd = tmpDir('col-9-'); TT.build(sd, '0001');
  const bj = T.trackPaths(sd, '0001', 'b').jsonPath;
  fs.writeFileSync(bj, '{"truncated": ');
  fs.unlinkSync(T.trackPaths(sd, '0001', 'b').sealedPath);
  const r = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/\| b \| unreadable \(corrupt\) \| unowned \| - \| [^|]+\|/.test(r.stdout), r.stdout.slice(0, 600));
  assert.ok(/# Session 0001 · track b — UNREADABLE\n\n> The record session-0001-b\.json cannot be read \(corrupt: .+\)\. Read the file directly: .*session-0001-b\.json\n/.test(r.stdout), r.stdout);
  assert.ok(r.stdout.includes('`#1c.1` benchmark the lock') && r.stdout.includes('`#1a.2`'));
  const j = exp(sd, ['--session', '1', '--style', 'json']);
  assert.strictEqual(j.code, 0);
  assert.deepStrictEqual(JSON.parse(j.stdout).map((x) => x.meta.track), ['a', 'c']);
  assert.ok(/note: track b of 0001 is unreadable \(corrupt\); not exported/.test(j.stderr), j.stderr);
});

test('COL-10 a folder holding ONLY track b uses the merged layout: "1 track (track b)", ids shown as stored (1b.K)', () => {
  const sd = tmpDir('col-10-');
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: { where: 'w', next: 'n', in_flight: [], must_not_redo: [] } });
  require('../tpm-session-ops').opPunchlist({ sessionsDir: sd, number: '0001', track: 'b', action: 'add', text: 'only b', slug: 'onlyb' });
  const r = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.startsWith('# Session 0001 · 1 track (track b)\n\n| track |'), r.stdout.slice(0, 80));
  assert.ok(r.stdout.includes('`#1b.1` only b'));
});

test('COL-11 a lone track a sealed by a marker: stdout equals today\'s, stderr carries the "marker is authoritative" note', () => {
  const sd = tmpDir('col-11-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: { where: 'w', next: 'n', in_flight: [], must_not_redo: [] } });
  const plain = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  H.putMarker(sd, '0001', 'a', { schema: 1, kind: 'seal-marker', sealedAt: '2026-10-07T11:00:00-07:00', reason: 'abandoned', note: 'dead train', sealedBy: { claudeSessionId: 'zzzzzzzz-9' } });
  const sealed = exp(sd, ['--session', '1', '--style', 'human', '--now', NOW]);
  assert.strictEqual(sealed.stdout, plain.stdout, 'stdout is byte-identical');
  assert.strictEqual(plain.stderr, '');
  assert.strictEqual(sealed.stderr, 'note: track a of session 0001 was SEALED AS ABANDONED 2026-10-07T11:00:00-07:00 by claude zzzzzzzz (abandoned, "dead train"); its JSON record and .md still read "open" - the marker is authoritative\n');
});

test('COL-12 the export "not included by this version" advisory is gone', () => {
  const sd = tmpDir('col-12-'); TT.build(sd, '0001');
  assert.ok(!/not included by this version/.test(exp(sd, ['--session', '1', '--style', 'json']).stderr));
});

test('COL-14 no read verb writes: sha256 of the whole store before == after, for every read shape', () => {
  const sd = tmpDir('col-14-'); TT.build(sd, '0001');
  const before = TT.shas(sd);
  for (const args of [['--session', '1', '--style', 'human'], ['--session', '1', '--style', 'json'], ['--last', '1', '--style', 'both'], ['--session', '1', '--track', 'b'], ['--session', '1', '--track', 'bbbbbbbb', '--style', 'human'], ['--session', '1', '--track', 'q']]) {
    exp(sd, [...args, '--now', NOW]);
  }
  assert.deepStrictEqual(TT.shas(sd), before);
});

test('COL-16 collateSession reads state from trackState: the overlay words, the table cells, no I/O beyond reads', () => {
  const sd = tmpDir('col-16-'); TT.build(sd, '0001');
  const col = collate.collateSession(sd, '0001');
  assert.strictEqual(col.multi, true);
  assert.deepStrictEqual(col.tracks.map((t) => [t.track, collate.stateWordOf(t), collate.stateCellOf(t)]), [
    ['a', 'closed', 'sealed (closed)'], ['b', 'sealed by marker (abandoned)', 'sealed (abandoned)'], ['c', 'open', 'live'],
  ]);
  assert.strictEqual(collate.collateSession(sd, '0001', { track: 'c' }).narrowed, 'c');
});

done('session-collate.test');
