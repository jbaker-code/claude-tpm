'use strict';
/**
 * session-info-tracks.test.js — phase 14 DoD A: `current --state` (what `info` and the footer print) lists EVERY track of the
 * caller's session: owner, opened / last write, sealed state (from trackState, never closedAt) and which one is the caller's;
 * a single-track session's output is unchanged (no `tracks` key); `--track` narrows or errors. Reads only.
 * Run: node tests/session-info-tracks.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');

const state = (sd, who, extra) => {
  const r = H.run(H.CURRENT, ['--sessions-dir', sd, '--state', ...(extra || [])], who ? { id: who } : {});
  return { code: r.code, out: r.stdout ? JSON.parse(r.stdout) : null, stderr: r.stderr };
};

test('A-1 three tracks, caller is c: all three listed, a sealed-self, b sealed-marker (record closedAt is null), c live and mine', () => {
  const sd = tmpDir('info-1-'); TT.build(sd, '0001');
  const before = TT.shas(sd);
  const { code, out } = state(sd, TT.IDS.c);
  assert.strictEqual(code, 0);
  assert.strictEqual(out.state, 'open'); assert.strictEqual(out.track, 'c');
  assert.deepStrictEqual(out.tracks.map((t) => [t.track, t.state, t.mine, t.owner]), [
    ['a', 'sealed-self', false, 'aaaaaaaa'], ['b', 'sealed-marker', false, 'bbbbbbbb'], ['c', 'live', true, 'cccccccc'],
  ]);
  for (const t of out.tracks) { assert.ok(t.openedAt, 'openedAt'); assert.ok(t.lastWriteAt, 'lastWriteAt'); }
  assert.ok(out.tracks[0].sealedAt && out.tracks[1].sealedAt === '2026-10-07T11:00:00-07:00' && out.tracks[2].sealedAt === null);
  assert.deepStrictEqual(TT.shas(sd), before, 'info writes nothing');
});

test('A-2 a stranger gets foreign-open and the blocking session tracks, none of them mine', () => {
  const sd = tmpDir('info-2-'); TT.build(sd, '0001');
  // stranger: c is a foreign live track -> foreign-open, and the blocking session tracks are still listed
  const s = state(sd, 'zzzzzzzz-0000-4000-8000-zzzzzzzzzzzz').out;
  assert.strictEqual(s.state, 'foreign-open');
  assert.strictEqual(s.tracksOfSession, '0001');
  assert.ok(s.tracks.length === 3 && s.tracks.every((t) => t.mine === false));
});

test('A-3 single-track session: no `tracks` key (output unchanged)', () => {
  const sd = tmpDir('info-3-'); H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const out = state(sd, 'idA').out;
  assert.strictEqual(out.state, 'open');
  assert.ok(!('tracks' in out) && !('tracksOfSession' in out), Object.keys(out).join(','));
  const none = tmpDir('info-3b-');
  assert.ok(!('tracks' in state(none, 'idA').out));
});

test('A-4 --track narrows to one row (letter or Claude id prefix); malformed / unknown is an error and prints no state', () => {
  const sd = tmpDir('info-4-'); TT.build(sd, '0001');
  assert.deepStrictEqual(state(sd, TT.IDS.c, ['--track', 'b']).out.tracks.map((t) => t.track), ['b']);
  assert.deepStrictEqual(state(sd, TT.IDS.c, ['--track', 'bbbbbbbb']).out.tracks.map((t) => t.track), ['b']);
  const bad = state(sd, TT.IDS.c, ['--track', 'bbbb']);
  assert.strictEqual(bad.code, 2); assert.ok(/not a track/.test(bad.stderr));
  const q = state(sd, TT.IDS.c, ['--track', 'q']);
  assert.strictEqual(q.code, 1); assert.ok(/no track 'q'/.test(q.stderr));
});

test('A-5 an unreadable sibling is listed as unreadable (with a reason), never dropped', () => {
  const sd = tmpDir('info-5-'); TT.build(sd, '0001');
  fs.writeFileSync(H.T.trackPaths(sd, '0001', 'b').jsonPath.replace(/-b\.json$/, '-d.json'), '{ not json');
  const out = state(sd, TT.IDS.c).out;
  const d = out.tracks.find((t) => t.track === 'd');
  assert.ok(d && d.state === 'unreadable' && d.reason, JSON.stringify(out.tracks));
});

test('A-6 the info template tells the model to print the tracks list', () => {
  const t = fs.readFileSync(path.join(__dirname, '..', 'templates', 'info.md'), 'utf8');
  assert.ok(/`tracks` array/.test(t) && /mine: true/.test(t));
});

done('session-info-tracks.test.js');
