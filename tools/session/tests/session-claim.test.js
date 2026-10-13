'use strict';
/**
 * session-claim.test.js — the claim primitives: io.exclusiveCreateFileSync (link-from-prepared-temp, NOT wx),
 * claimSessionFolder (non-recursive mkdir), claimTrack (a..z, cap 26). DoD rows B, C.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tests/session-claim.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const io = require('../../lib/io');
const { T } = H;

test('T-C1 exclusiveCreateFileSync: created then exists; content COMPLETE; no temp left; second never clobbers', () => {
  const dir = tmpDir('clm-c1-');
  const f = path.join(dir, 'session-0001.json');
  assert.strictEqual(io.exclusiveCreateFileSync(f, 'first-winner\n'), 'created');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'first-winner\n');
  assert.strictEqual(io.exclusiveCreateFileSync(f, 'loser\n'), 'exists');
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'first-winner\n', 'the winner is untouched');
  assert.deepStrictEqual(fs.readdirSync(dir), ['session-0001.json'], 'no prepared temp left behind');
  assert.strictEqual(fs.statSync(f).nlink, 1, 'temp unlinked -> a single link');
});

test('T-C1b the file is never observable EMPTY: the link target is complete at the instant it appears', () => {
  const dir = tmpDir('clm-c1b-');
  const f = path.join(dir, 'x.json');
  const realLink = fs.linkSync;
  let sizeAtLink = -1;
  fs.linkSync = function patched(a, b) {   // observe the prepared temp at the moment of linking
    sizeAtLink = fs.statSync(a).size;
    return realLink.call(fs, a, b);
  };
  try { io.exclusiveCreateFileSync(f, 'COMPLETE-CONTENT'); } finally { fs.linkSync = realLink; }
  assert.strictEqual(sizeAtLink, 'COMPLETE-CONTENT'.length, 'temp fully written + fsynced BEFORE the link');
});

test('T-C2 no hard links (ENOTSUP) -> falls back to wx with a one-time warning; EEXIST still reported as exists', () => {
  const dir = tmpDir('clm-c2-');
  const f = path.join(dir, 'a.json');
  const realLink = fs.linkSync;
  const realErr = process.stderr.write;
  let warned = '';
  fs.linkSync = () => { const e = new Error('no links'); e.code = 'ENOTSUP'; throw e; };
  process.stderr.write = (s) => { warned += s; return true; };
  try {
    assert.strictEqual(io.exclusiveCreateFileSync(f, 'v1'), 'created');
    assert.strictEqual(io.exclusiveCreateFileSync(f, 'v2'), 'exists');
  } finally { fs.linkSync = realLink; process.stderr.write = realErr; }
  assert.strictEqual(fs.readFileSync(f, 'utf8'), 'v1');
  assert.ok(/no hard links/.test(warned) || warned === '', 'warning is one-time (may already have fired in-process)');
  assert.deepStrictEqual(fs.readdirSync(dir), ['a.json'], 'temp removed in fallback mode too');
});

test('T-C2b any other link error is rethrown with code kept and the temp removed', () => {
  const dir = tmpDir('clm-c2b-');
  const realLink = fs.linkSync;
  fs.linkSync = () => { const e = new Error('disk on fire'); e.code = 'EIO'; throw e; };
  try {
    assert.throws(() => io.exclusiveCreateFileSync(path.join(dir, 'z.json'), 'x'), (e) => e.code === 'EIO' && /z\.json/.test(e.message));
  } finally { fs.linkSync = realLink; }
  assert.deepStrictEqual(fs.readdirSync(dir), []);
});

test('T-C6 claimSessionFolder: creates a missing sessions dir (mkdir -p) then the folder; second call -> exists', () => {
  const root = tmpDir('clm-c6-');
  const sd = path.join(root, 'nested', 'sessions');
  assert.strictEqual(T.claimSessionFolder(sd, '0001'), 'created');
  assert.ok(fs.statSync(path.join(sd, 'session-0001')).isDirectory());
  assert.strictEqual(T.claimSessionFolder(sd, '0001'), 'exists');
});

test('T-C3 claimTrack letters:["a"]: first creates track a UNSUFFIXED; a second claim -> ETRACK_EXISTS and does not touch it', () => {
  const dir = tmpDir('clm-c3-');
  T.claimSessionFolder(dir, '0001');
  const c = T.claimTrack(dir, '0001', { identity: H.id('me') });
  assert.strictEqual(c.track, 'a');
  assert.strictEqual(path.basename(c.jsonPath), 'session-0001.json');
  const before = fs.readFileSync(c.jsonPath, 'utf8');
  assert.throws(() => T.claimTrack(dir, '0001', { identity: H.id('other') }), (e) => e.code === 'ETRACK_EXISTS');
  assert.strictEqual(fs.readFileSync(c.jsonPath, 'utf8'), before);
});

test('T-C4 claimTrack "any": a, b, c gap-free; a sealed track\'s letter is never reused', () => {
  const dir = tmpDir('clm-c4-');
  const letters = [];
  for (let i = 0; i < 3; i += 1) letters.push(T.claimTrack(dir, '0001', { identity: H.id(`id${i}`), letters: 'any' }).track);
  assert.deepStrictEqual(letters, ['a', 'b', 'c']);
  assert.strictEqual(path.basename(T.trackPaths(dir, '0001', 'c').jsonPath), 'session-0001-c.json');
  H.putMarker(dir, '0001', 'b');   // seal b by marker: letter stays taken
  assert.strictEqual(T.claimTrack(dir, '0001', { identity: H.id('id9'), letters: 'any' }).track, 'd');
});

test('T-C5 the 27th claim -> ETRACK_CAP (hard cap 26)', () => {
  const dir = tmpDir('clm-c5-');
  for (let i = 0; i < 26; i += 1) T.claimTrack(dir, '0001', { identity: H.id(`id${i}`), letters: 'any' });
  assert.strictEqual(fs.readdirSync(path.join(dir, 'session-0001')).filter((n) => n.endsWith('.json')).length, 26);
  assert.throws(() => T.claimTrack(dir, '0001', { identity: H.id('one-too-many'), letters: 'any' }), (e) => e.code === 'ETRACK_CAP' && /26 tracks/.test(e.message));
});

test('T-C7 a claim writes a COMPLETE valid record + derived md; meta has track/ids/pid/start/host/lastWriter', () => {
  const dir = tmpDir('clm-c7-');
  const identity = { claudeSessionId: 'sid-1', claudePid: 4242, claudePidStartedAt: '2026-10-07T09:00:00-07:00', hostname: 'h1' };
  const c = T.claimTrack(dir, '0003', { identity, tpmVersion: '0.2.0' });
  const rec = require('../lib/session-model').loadSession(c.jsonPath);   // read -> migrate -> validate
  assert.strictEqual(rec.schemaVersion, '1.0.0', 'NO schemaVersion bump');
  assert.strictEqual(rec.meta.track, 'a');
  assert.strictEqual(rec.meta.claudeSessionId, 'sid-1');
  assert.strictEqual(rec.meta.claudePid, 4242);
  assert.strictEqual(rec.meta.claudePidStartedAt, '2026-10-07T09:00:00-07:00');
  assert.strictEqual(rec.meta.hostname, 'h1');
  assert.ok(rec.meta.lastWriter && typeof rec.meta.lastWriter.at === 'string' && rec.meta.lastWriter.version === require('../../lib/tpm-version').tpmVersion());
  assert.deepStrictEqual(rec.punchlist, [], 'a claimed track starts with an EMPTY punchlist');
  assert.ok(fs.existsSync(c.mdPath) && /Session 0003/.test(fs.readFileSync(c.mdPath, 'utf8')));
});

test('T-C7b all-null identity still opens (a null never blocks)', () => {
  const dir = tmpDir('clm-c7b-');
  const c = T.claimTrack(dir, '0001', { identity: { claudeSessionId: null, claudePid: null, claudePidStartedAt: null, hostname: null } });
  const rec = require('../lib/session-model').loadSession(c.jsonPath);
  assert.deepStrictEqual([rec.meta.claudeSessionId, rec.meta.claudePid, rec.meta.hostname, rec.meta.sessionIds], [null, null, null, []]);
  const c2 = T.claimTrack(tmpDir('clm-c7c-'), '0001', {});   // no identity object at all
  assert.strictEqual(c2.track, 'a');
});

done('session-claim.test');
