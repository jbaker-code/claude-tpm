'use strict';
/**
 * session-meta-additive.test.js — DoD C / D: per-track info rides in ADDITIVE `meta` keys with NO
 * schemaVersion bump; the B2 stamp is meta.lastWriter {version, at}; old writers' keys survive; the model stays
 * byte-stable unless the stamp is asked for. Fixtures: tests/fixtures/tracks/*, golden: golden/session-0021-b.expected.md.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tests/session-meta-additive.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');
const { validatePayload } = require('../lib/session-schema');
const { CURRENT } = require('../../lib/version');
const ops = require('../tpm-session-ops');
const { tpmVersion } = require('../../lib/tpm-version');

const FIX = path.join(__dirname, 'fixtures', 'tracks');
const GOLD = path.join(__dirname, 'golden');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(FIX, n), 'utf8'));

test('T-D1 the new meta keys validate; a bad track / pid / lastWriter is rejected (loudly, by name)', () => {
  for (const f of ['session-0021.json', 'session-0021-newmeta.json', 'session-0021-b.json', 'session-0021-unknown.json']) {
    assert.doesNotThrow(() => validatePayload(fx(f)), f);
  }
  assert.throws(() => validatePayload(fx('session-0021-badtrack.json')), /meta\.track must be one letter a-z/);
  const bad = (mut) => { const r = fx('session-0021-newmeta.json'); mut(r.meta); return () => validatePayload(r); };
  assert.throws(bad((m) => { m.claudePid = 1; }), /meta\.claudePid/);
  assert.throws(bad((m) => { m.claudePid = '4242'; }), /meta\.claudePid/);
  assert.throws(bad((m) => { m.claudePidStartedAt = 'yesterday'; }), /claudePidStartedAt/);
  assert.throws(bad((m) => { m.hostname = 5; }), /meta\.hostname/);
  assert.throws(bad((m) => { m.lastWriter = { version: 3, at: '2026-09-19T13:36:00-07:00' }; }), /lastWriter\.version/);
  assert.throws(bad((m) => { m.lastWriter = { version: '1', at: 'x' }; }), /lastWriter\.at/);
  assert.doesNotThrow(bad((m) => { m.claudePid = null; m.claudeSessionId = null; m.hostname = null; m.claudePidStartedAt = null; }), 'nulls are always fine');
});

test('T-D2 unknown meta + top-level keys survive load -> mutate -> save (the old-writer simulation)', () => {
  const dir = tmpDir('add-d2-');
  const jp = path.join(dir, 'session-0021.json');
  fs.writeFileSync(jp, JSON.stringify(fx('session-0021-unknown.json')));
  let rec = model.loadSession(jp);
  rec = model.appendLog(rec, { type: 'log', status: 'NOTE', text: 'old writer touched it' });
  model.saveSession(rec, { jsonPath: jp });
  const back = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.deepStrictEqual(back.meta.futureKey, { x: 1 });
  assert.deepStrictEqual(back.extraTop, { keep: 'me' });
  assert.strictEqual(back.meta.track, 'a');
});

test('T-D3 schemaVersion is STILL the shared CURRENT after open / save / close (no bump, task store unaffected)', () => {
  const sd = tmpDir('add-d3-');
  const idn = H.id('sid-d3');
  ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-d3', identity: idn });
  ops.opNote({ sessionsDir: sd, number: '0001', identity: idn, type: 'log', status: 'NOTE', text: 'x' });
  const jp = ops.sessionPaths(sd, '0001').jsonPath;
  assert.strictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')).schemaVersion, CURRENT);
  assert.strictEqual(CURRENT, '1.0.0');
  H.T.claimTrack(sd, '0002', { identity: idn });
  assert.strictEqual(JSON.parse(fs.readFileSync(ops.sessionPaths(sd, '0002').jsonPath, 'utf8')).schemaVersion, '1.0.0');
});

test('T-D4 saveSession WITHOUT the lastWriter option is byte-stable (the unconditional-stamp guard)', () => {
  const dir = tmpDir('add-d4-');
  const jp = path.join(dir, 's.json');
  const rec = fx('session-0021.json');
  const saved = model.saveSession(rec, { jsonPath: jp });
  assert.strictEqual(saved.meta.lastWriter, undefined, 'the model never stamps by itself');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')).meta, rec.meta);
  const stamped = model.saveSession(rec, { jsonPath: jp, lastWriter: { version: '9.9.9' } });
  assert.strictEqual(stamped.meta.lastWriter.version, '9.9.9');
  assert.ok(/^\d{4}-\d\d-\d\dT.*[+-]\d\d:\d\d$/.test(stamped.meta.lastWriter.at));
  assert.strictEqual(rec.meta.lastWriter, undefined, 'the caller\'s record is not mutated');
});

test('T-D5 every op persists meta.lastWriter.version from tools/lib/tpm-version.js (the B2 stamp, not meta.tpmVersion)', () => {
  const sd = tmpDir('add-d5-');
  const idn = H.id('sid-d5');
  ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-d5', identity: idn, tpmVersion: '0.0.0' });
  const rec = ops.opNote({ sessionsDir: sd, number: '0001', identity: idn, type: 'log', status: 'NOTE', text: 'n' });
  assert.strictEqual(rec.meta.lastWriter.version, tpmVersion());
  assert.ok(tpmVersion() && tpmVersion() !== '0.0.0');
  assert.strictEqual(rec.meta.tpmVersion, '0.0.0', 'meta.tpmVersion keeps its (unusable) meaning; the stamp is separate');
  const jp = ops.sessionPaths(sd, '0001').jsonPath;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')).meta.lastWriter, rec.meta.lastWriter);
});

test('T-D5b a legacy record gains meta.track on its first save by the new tool (ending its supersession-by-age)', () => {
  const sd = tmpDir('add-d5b-');
  const jp = H.putTrack(sd, '0001', 'a', { legacy: true, owner: 'sid-old' });
  assert.strictEqual(JSON.parse(fs.readFileSync(jp, 'utf8')).meta.track, undefined);
  ops.opNote({ sessionsDir: sd, number: '0001', identity: H.id('sid-old'), type: 'log', status: 'NOTE', text: 'n' });
  const after = JSON.parse(fs.readFileSync(jp, 'utf8'));
  assert.strictEqual(after.meta.track, 'a');
  assert.strictEqual(after.meta.claudeSessionId, 'sid-old', 'owner evidence filled for the caller that IS the owner');
});

test('T-D5c touchOwner: fills a NULL owner, refreshes pid when the owner resumed in a new process, NEVER replaces a non-null owner', () => {
  const rec = () => ({ meta: { number: '0001', sessionIds: [], claudeSessionId: null, claudePid: 1111, hostname: 'h' } });
  const full = { claudeSessionId: 'me', claudePid: 2222, claudePidStartedAt: '2026-10-07T10:00:00-07:00', hostname: 'h2' };
  const a = ops.touchOwner(rec(), 'a', { claudeSessionId: 'me', claudePid: 2222 }, () => full).meta;
  assert.deepStrictEqual([a.claudeSessionId, a.claudePid, a.hostname], ['me', 2222, 'h2']);
  const owned = { meta: { number: '0001', sessionIds: ['x'], claudeSessionId: 'x', claudePid: 7, hostname: 'hx' } };
  const b = ops.touchOwner(JSON.parse(JSON.stringify(owned)), 'a', { claudeSessionId: 'intruder', claudePid: 8 }, () => full).meta;
  assert.deepStrictEqual([b.claudeSessionId, b.claudePid, b.hostname], ['x', 7, 'hx'], 'a foreign caller changes nothing');
  const c = ops.touchOwner(JSON.parse(JSON.stringify(owned)), 'a', { claudeSessionId: null, claudePid: 8 }, () => full).meta;
  assert.deepStrictEqual([c.claudeSessionId, c.claudePid], ['x', 7], 'a caller with no id changes nothing');
});

test('T-D6 nextItemId is track-aware: a -> 123.N (unchanged), b -> 123b.N, no collision between tracks', () => {
  let a = model.openTrack({ number: '0123', track: 'a', identity: H.id('x') });
  let b = model.openTrack({ number: '0123', track: 'b', identity: H.id('y') });
  a = model.addPunchlist(a, { text: 'one' }); a = model.addPunchlist(a, { text: 'two' });
  b = model.addPunchlist(b, { text: 'one' });
  assert.deepStrictEqual(a.punchlist.map((i) => i.id), ['123.1', '123.2']);
  assert.deepStrictEqual(b.punchlist.map((i) => i.id), ['123b.1']);
  const legacy = model.addPunchlist(model.openSession({ number: '0123', sessionId: 'z' }), { text: 'x' });
  assert.strictEqual(legacy.punchlist[0].id, '123.1', 'legacy/no-track records mint exactly as before');
  b = model.addPunchlist(b, { text: 'two' });
  assert.strictEqual(b.punchlist[1].id, '123b.2');
});

test('T-D7 converter: track a / absent is byte-identical (the committed golden); track b names its own file + track', () => {
  const GOLDEN_NOW = '2026-09-19T13:36:00-07:00';
  const base = JSON.parse(fs.readFileSync(path.join(GOLD, 'session-0021.fixture.json'), 'utf8'));
  assert.strictEqual(render(base, { now: GOLDEN_NOW }), fs.readFileSync(path.join(GOLD, 'session-0021.expected.md'), 'utf8'));
  const b = render(fx('session-0021-b.json'), { now: GOLDEN_NOW });
  assert.strictEqual(b, fs.readFileSync(path.join(GOLD, 'session-0021-b.expected.md'), 'utf8'));
  assert.ok(/^# Session 0021 · 2026-09-19 · track b/.test(b) && /Generated from `session-0021-b\.json`/.test(b));
  const a = render(fx('session-0021-newmeta.json'), { now: GOLDEN_NOW });
  assert.ok(/^# Session 0021 · 2026-09-19\n/.test(a) && /`session-0021\.json`/.test(a), 'explicit track a renders as the unsuffixed name');
});

test('T-D8 openTrack: all-null identity opens; a carried-in prior is explicit only (a claimed track never inherits items)', () => {
  const r = model.openTrack({ number: 7, track: 'c', identity: {} });
  assert.deepStrictEqual([r.meta.track, r.meta.claudeSessionId, r.meta.claudePid, r.meta.hostname, r.meta.sessionIds, r.punchlist], ['c', null, null, null, [], []]);
  assert.throws(() => model.openTrack({ number: 7, track: 'C' }), /one letter a-z/);
  assert.doesNotThrow(() => model.validateRecord(r));
});

done('session-meta-additive.test');
