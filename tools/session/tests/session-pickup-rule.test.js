'use strict';
/**
 * session-pickup-rule.test.js — phase 13 DoD C: the DERIVED pickup rule (decision Q1/R5: nothing is stored).
 * A track is "picked up" iff a later session (K < J < N) opened STRICTLY after the track settled; a tie is NOT
 * picked up; a live track is never picked up; unreadable tracks never enter the set.
 *   - the worked tables S1 / S2 / S3 of the plan (REAL stores with fabricated timestamps, read back by the real scanner)
 *   - the strict tie, un-seal returning a track to pending, unreadable never entering, the skipped/hollow lists
 *   - nothing is written by the pickup (sha256 of the whole store before == after)
 *
 * Run: node tests/session-pickup-rule.test.js
 */
const { assert, test, done, fs, path } = require('./helpers/harness');
const F = require('./helpers/fixed-multi');
const tt = require('./helpers/three-track');
const T = require('../lib/session-tracks');
const br = require('../tpm-session-boot-read');

const label = (e) => `${e.number}${e.track.track}`;
const srt = (list) => list.map(label).sort();
const pend = (sd, n) => srt(br.computePickup(sd, n).pending);
const done_ = (sd, n) => br.computePickup(sd, n).alreadyPickedUp.map((e) => `${label(e)}<-${e.by}`);

// ── S1 (the PRD sketch) ─────────────────────────────────────────────────────────
test('S1 as 0124: a, b, c of 0123 are all pending (nothing later has opened yet)', () => {
  const sd = F.scratch('pr-s1a-'); F.straggler(sd, 'S1');
  assert.deepStrictEqual(pend(sd, 124), ['0123a', '0123b', '0123c']);
  assert.deepStrictEqual(done_(sd, 124), []);
});
test('S1 as 0125: a is picked up by 0124 (14:10 > 14:02); b and c are STILL pending (14:10 < 15:40 / 16:10); 0124a pending', () => {
  const sd = F.scratch('pr-s1b-'); F.straggler(sd, 'S1');
  assert.deepStrictEqual(pend(sd, 125), ['0123b', '0123c', '0124a']);
  assert.deepStrictEqual(done_(sd, 125), ['0123a<-0124']);
});
test('S1 as 0126 (nobody owns 0125 yet): 0125 is live and shown; b and c are picked up by 0125 (16:30 > 16:10)', () => {
  const sd = F.scratch('pr-s1c-'); F.straggler(sd, 'S1');
  assert.deepStrictEqual(pend(sd, 126), ['0125a']);
  assert.deepStrictEqual(done_(sd, 126).sort(), ['0123a<-0124', '0123b<-0125', '0123c<-0125', '0124a<-0125']);
});

// ── S2 (another sealing order) ──────────────────────────────────────────────────
test('S2 as 0125: a pending (it was live when 0124 opened), b pending, c picked up by 0124, 0124a pending', () => {
  const sd = F.scratch('pr-s2a-'); F.straggler(sd, 'S2');
  assert.deepStrictEqual(pend(sd, 125), ['0123a', '0123b', '0124a']);
  assert.deepStrictEqual(done_(sd, 125), ['0123c<-0124']);
});
test('S2 as 0126: a is picked up by 0125, c by 0124; b, 0124a and 0125a are pending', () => {
  const sd = F.scratch('pr-s2b-'); F.straggler(sd, 'S2');
  assert.deepStrictEqual(pend(sd, 126), ['0123b', '0124a', '0125a']);
  assert.deepStrictEqual(done_(sd, 126).sort(), ['0123a<-0125', '0123c<-0124']);
});

// ── S3 (the tie) ────────────────────────────────────────────────────────────────
test('S3: marker-sealed 14:02:00 and 0124 opens 14:02:00 -> a TIE is NOT picked up (shown for 0124 AND again for 0125); gone for 0126', () => {
  const sd = F.scratch('pr-s3-'); F.straggler(sd, 'S3');
  assert.deepStrictEqual(pend(sd, 124), ['0123a', '0123b']);
  assert.deepStrictEqual(pend(sd, 125), ['0123a', '0123b', '0124a'], 'the tie keeps them pending for 0125 too (a duplicate show is harmless, a hidden handoff is not)');
  assert.deepStrictEqual(pend(sd, 126), ['0125a']);
  assert.deepStrictEqual(done_(sd, 126).sort(), ['0123a<-0125', '0123b<-0125', '0124a<-0125']);
});

// ── pure function over a FABRICATED scan (no files, no clock) ──────────────────────
const trk = (track, o) => Object.assign({ track, record: {}, state: 'sealed', sealedBy: 'self', sealedAt: null, lastWriteAt: null, openedAt: null, superseded: false }, o);
const sess = (number, tracks) => ({ number, tracks, unrecognised: [] });

test('pickupSet is pure: a fabricated scan, strict ">" at the boundary, +1 second flips it', () => {
  const mkScan = (openedJ) => ({ sessions: [sess('0010', [trk('a', { sealedAt: '2026-10-05T10:00:00-07:00', openedAt: '2026-10-05T09:00:00-07:00' })]), sess('0011', [trk('a', { openedAt: openedJ, state: 'sealed', sealedAt: '2026-10-05T12:00:00-07:00' })])] });
  assert.deepStrictEqual(srt(br.pickupSet(mkScan('2026-10-05T10:00:00-07:00'), 12).pending), ['0010a', '0011a'], 'tie -> pending');
  const after = br.pickupSet(mkScan('2026-10-05T10:00:01-07:00'), 12);
  assert.deepStrictEqual(srt(after.pending), ['0011a']);
  assert.deepStrictEqual(after.alreadyPickedUp.map((e) => [label(e), e.by]), [['0010a', '0011']]);
  const before = br.pickupSet(mkScan('2026-10-05T09:59:59-07:00'), 12);
  assert.deepStrictEqual(srt(before.pending), ['0010a', '0011a']);
});

test('a LIVE track is never picked up, however many sessions open after it', () => {
  const scan = { sessions: [
    sess('0001', [trk('a', { state: 'live', sealedBy: null, openedAt: '2026-10-05T08:00:00-07:00' })]),
    sess('0002', [trk('a', { openedAt: '2026-10-05T09:00:00-07:00', sealedAt: '2026-10-05T09:30:00-07:00' })]),
    sess('0003', [trk('a', { openedAt: '2026-10-05T10:00:00-07:00', sealedAt: '2026-10-05T10:30:00-07:00' })]),
  ] };
  assert.deepStrictEqual(srt(br.pickupSet(scan, 4).pending), ['0001a', '0003a']);
});

test('a sealed track whose seal time is unknown is never hidden (treated as never settled)', () => {
  const scan = { sessions: [sess('0001', [trk('a', { sealedAt: null })]), sess('0002', [trk('a', { openedAt: '2026-10-05T09:00:00-07:00', sealedAt: '2026-10-05T09:30:00-07:00' })])] };
  assert.deepStrictEqual(srt(br.pickupSet(scan, 3).pending), ['0001a', '0002a']);
});

test('a legacy left-open record settles at its last write (superseded); a later session opened after it picks it up', () => {
  const scan = { sessions: [
    sess('0001', [trk('a', { state: 'live', sealedBy: null, superseded: true, lastWriteAt: '2026-10-05T08:30:00-07:00', openedAt: '2026-10-05T08:00:00-07:00' })]),
    sess('0002', [trk('a', { openedAt: '2026-10-05T09:00:00-07:00', sealedAt: '2026-10-05T09:30:00-07:00' })]),
  ] };
  const r = br.pickupSet(scan, 3);
  assert.deepStrictEqual(srt(r.pending), ['0002a']);
  assert.deepStrictEqual(r.alreadyPickedUp.map((e) => [label(e), e.by]), [['0001a', '0002']]);
});

test('sessions at or above N are ignored; N = nothing owned means every session is prior', () => {
  const sd = F.scratch('pr-n-'); F.straggler(sd, 'S1');
  assert.ok(!pend(sd, 125).includes('0125a'), 'the caller own session is excluded');
  assert.ok(pend(sd, null).includes('0125a'), 'a caller owning nothing sees every session');
  assert.ok(pend(sd, undefined).includes('0125a'));
});

test('pending comes back in render order: newest session first, tracks a..z', () => {
  const sd = F.scratch('pr-order-'); F.straggler(sd, 'S1');
  assert.deepStrictEqual(br.computePickup(sd, 125).pending.map(label), ['0124a', '0123b', '0123c']);
});

test('unreadable tracks never enter the set; they are listed in skipped (newest first); hollow folders are listed', () => {
  const sd = F.scratch('pr-unr-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), closed: F.at('08:30') }));
  fs.mkdirSync(path.join(sd, 'session-0002'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0002', 'session-0002-b.json'), 'corrupt{');
  F.put(sd, F.mk('0002', 'a', { owner: F.id('b'), opened: F.at('09:00'), closed: F.at('09:30') }));
  fs.mkdirSync(path.join(sd, 'session-0003'), { recursive: true });                       // hollow
  fs.writeFileSync(path.join(sd, 'session-0004.json'), 'ignored');                       // not a folder at all
  fs.mkdirSync(path.join(sd, 'session-0005'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0005', 'session-0005.json'), '{ broken');
  const r = br.computePickup(sd, null);
  assert.deepStrictEqual(srt(r.pending), ['0002a']);
  assert.deepStrictEqual(r.skipped.map((s) => `${s.number}${s.track}:${s.reason}`), ['0005a:corrupt', '0002b:corrupt']);
  assert.deepStrictEqual(r.hollow, ['0003']);
});

test('un-sealing returns a track to pending (live = never settles), and sealing it again settles it', () => {
  const sd = F.scratch('pr-unseal-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), closed: F.at('08:30') }));
  F.marker(sd, '0001', 'a', { at: F.at('08:20'), owner: F.id('a') });
  F.put(sd, F.mk('0002', 'a', { owner: F.id('b'), opened: F.at('09:00'), closed: F.at('09:30') }));
  assert.deepStrictEqual(pend(sd, 3), ['0002a'], 'sealed at 08:20, 0002 opened 09:00 -> 0001 is picked up');
  const T2 = require('../lib/session-tracks');
  T2.unsealTrack(sd, '0001', 'a', { now: F.at('09:40') });
  const p = T2.trackPaths(sd, '0001', 'a');
  assert.ok(!fs.existsSync(p.sealedPath), 'marker gone');
  // the record carries closedAt 08:30 (its own close) so it settles at 08:30: still picked up by 0002 (opened 09:00)
  assert.deepStrictEqual(pend(sd, 3), ['0002a']);
  // make it a never-closed new-shape record: live => pending forever
  const rec = JSON.parse(fs.readFileSync(p.jsonPath, 'utf8')); rec.meta.closedAt = null; fs.writeFileSync(p.jsonPath, JSON.stringify(rec));
  assert.deepStrictEqual(pend(sd, 3), ['0001a', '0002a']);
});

test('the pickup writes NOTHING (sha256 of the whole store before == after), via the real CLI', () => {
  const sd = F.scratch('pr-nowrite-'); F.straggler(sd, 'S2');
  const H = require('./helpers/track-helpers');
  const before = JSON.stringify(tt.shas(sd));
  const r = H.run(H.BOOT_READ, ['--sessions-dir', sd], { id: F.id('f'), pid: 4242 });
  assert.strictEqual(r.code, 0);
  assert.strictEqual(JSON.stringify(tt.shas(sd)), before, 'no file added, changed or removed');
  assert.ok(/PRIOR SESSION 0125/.test(r.stdout));
});

done('session-pickup-rule.test');
