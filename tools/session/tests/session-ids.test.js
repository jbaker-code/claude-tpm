'use strict';
/**
 * session-ids.test.js — the ONE id grammar (lib/session-ids.js): parse / canonical / track-of / display / multi /
 * prefix / provenance label, plus the model's findItem and nextItemId staying consistent with it.
 * Pure; hermetic; exits non-zero on failure.  Run: node tests/session-ids.test.js
 */
const { assert, test, done } = require('./helpers/harness');
const ids = require('../lib/session-ids');
const model = require('../lib/session-model');

test('S-IDS-1 parse table: both spellings of track a, track letters, # prefix, zero padding; everything else is null', () => {
  const ok = (s, number, track, seq, stored) => assert.deepStrictEqual(ids.parseItemId(s), { number, track, seq, stored }, s);
  ok('123.4', 123, 'a', 4, '123.4');
  ok('123a.4', 123, 'a', 4, '123.4');
  ok('123b.4', 123, 'b', 4, '123b.4');
  ok('#123a.4', 123, 'a', 4, '123.4');
  ok('0123a.4', 123, 'a', 4, '123.4');
  ok('1z.10', 1, 'z', 10, '1z.10');
  for (const bad of ['123A.4', 'abc', '123.', '.4', '123ab.4', '', '1.2.3', ' 1.2', 'exportr', null, undefined, 5]) {
    assert.strictEqual(ids.parseItemId(bad), null, String(bad));
  }
});

test('S-IDS-2 canonicalItemId maps 123a.4 -> 123.4, leaves 123b.4, and leaves non-ids exactly as given', () => {
  assert.strictEqual(ids.canonicalItemId('123a.4'), '123.4');
  assert.strictEqual(ids.canonicalItemId('#123.4'), '123.4');
  assert.strictEqual(ids.canonicalItemId('123b.4'), '123b.4');
  assert.strictEqual(ids.canonicalItemId('abc123'), 'abc123');
  assert.strictEqual(ids.canonicalItemId('123A.4'), '123A.4');
});

test('S-IDS-3 trackOfItemId answers which track an id belongs to (null for a slug)', () => {
  assert.strictEqual(ids.trackOfItemId('123.4'), 'a');
  assert.strictEqual(ids.trackOfItemId('123a.4'), 'a');
  assert.strictEqual(ids.trackOfItemId('123b.4'), 'b');
  assert.strictEqual(ids.trackOfItemId('exportr'), null);
});

test('S-IDS-4 displayItemId: track a gains its letter only in a multi-track session; b..z and non-ids unchanged', () => {
  assert.strictEqual(ids.displayItemId('123.4', true), '123a.4');
  assert.strictEqual(ids.displayItemId('123.4', false), '123.4');
  assert.strictEqual(ids.displayItemId('123b.4', true), '123b.4');
  assert.strictEqual(ids.displayItemId('123b.4', false), '123b.4');
  assert.strictEqual(ids.displayItemId('legacy-x', true), 'legacy-x');
});

test('S-IDS-5 sessionIsMulti: one a -> false; a+b -> true; a lone b -> true; none -> false', () => {
  assert.strictEqual(ids.sessionIsMulti({ tracks: [{ track: 'a' }] }), false);
  assert.strictEqual(ids.sessionIsMulti({ tracks: [{ track: 'a' }, { track: 'b' }] }), true);
  assert.strictEqual(ids.sessionIsMulti({ tracks: [{ track: 'b' }] }), true);
  assert.strictEqual(ids.sessionIsMulti({ tracks: [] }), false);
  assert.strictEqual(ids.sessionIsMulti(null), false);
});

test('S-IDS-6 storedPrefix and the model\'s nextItemId agree on every record shape', () => {
  for (const track of [undefined, 'a', 'b', 'c', 'z']) {
    const rec = { meta: { number: '0021', track }, punchlist: [] };
    const first = model.addPunchlist(rec, { text: 'x' }).punchlist[0].id;
    assert.strictEqual(first, `${ids.storedPrefix('0021', track)}.1`, String(track));
  }
  assert.strictEqual(ids.storedPrefix('0021', 'a'), '21');
  assert.strictEqual(ids.storedPrefix('0021', 'c'), '21c');
});

test('S-IDS-7 fromSessionLabel: track a / absent track / legacy meta keep the bare number; b..z append the letter', () => {
  assert.strictEqual(ids.fromSessionLabel({ number: '0001' }), '0001');
  assert.strictEqual(ids.fromSessionLabel({ number: '0001', track: 'a' }), '0001');
  assert.strictEqual(ids.fromSessionLabel({ number: '0001', track: 'b' }), '0001b');
  assert.strictEqual(ids.fromSessionLabel(null), '');
  assert.strictEqual(ids.fromSessionLabel({}), '');
});

test('S-IDS-8 round trip: canonical(display(x, multi)) === x for tracks a..z and K up to 999', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    for (const k of [1, 9, 10, 99, 100, 999]) {
      const stored = `${ids.storedPrefix(123, letter)}.${k}`;
      assert.strictEqual(ids.canonicalItemId(ids.displayItemId(stored, true)), stored);
      assert.strictEqual(ids.canonicalItemId(ids.displayItemId(stored, false)), stored);
      assert.strictEqual(ids.trackOfItemId(ids.displayItemId(stored, true)), letter);
    }
  }
});

test('S-IDS-9 findItem: exact id/slug FIRST (a legacy id or an id-looking slug keeps working), then the canonical form', () => {
  const rec = {
    meta: { number: '0001', track: 'a' },
    punchlist: [
      { id: '1.1', slug: 'one', text: 't', state: 'open', events: [] },
      { id: 'LEGACY-7', slug: '9.9', text: 't', state: 'open', events: [] },
    ],
  };
  assert.strictEqual(model.findItem(rec, '1.1').slug, 'one');
  assert.strictEqual(model.findItem(rec, '1a.1').slug, 'one');
  assert.strictEqual(model.findItem(rec, '#1a.1').slug, 'one');
  assert.strictEqual(model.findItem(rec, '0001a.1').slug, 'one');
  assert.strictEqual(model.findItem(rec, 'one').id, '1.1');
  assert.strictEqual(model.findItem(rec, 'LEGACY-7').slug, '9.9');
  assert.strictEqual(model.findItem(rec, '9.9').id, 'LEGACY-7', 'a slug that looks like an id is found by the exact match');
  assert.strictEqual(model.findItem(rec, '1b.1'), undefined, 'the id of ANOTHER track never resolves here');
  assert.strictEqual(model.findItem(rec, '2.1'), undefined);
  assert.throws(() => model.closePunchlistItem(rec, 'nonesuch'), /^Error: punchlist op: no item matching 'nonesuch'$/);
});

done('session-ids.test');
