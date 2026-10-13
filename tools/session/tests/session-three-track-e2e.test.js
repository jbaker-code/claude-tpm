'use strict';
/**
 * session-three-track-e2e.test.js — phase 15 DoD A: the whole multi-track lifecycle, end to end, through the REAL
 * CLIs, playing THREE Claude instances (four, counting the one that opens afterwards) by per-process identity
 * (CLAUDE_CODE_SESSION_ID + CLAUDE_PID set on each child; the ambient values are always stripped).
 *
 *   1. A opens (track a).             2. B tries to open: REFUSED (gate), nothing written; B then opens --parallel (b).
 *   3. C opens --parallel (c).        4. A "/clear"s: same pid, new id -> refused with the /clear evidence, then
 *      ADOPTS track a (A2).           5. each instance saves + adds punchlist items on ITS OWN track.
 *   6. c is ABANDONED-SEALED (confirmation flag first, exit 4 without it); a and b are closed by their owners.
 *   7. instance D (no track) reads the pickup: three correct blocks; then opens session 0002 and carries items
 *      forward from each track, keeping source session + track letter (provenance).
 *   8. the store passes the doctor.
 * Hermetic (scratch dir only); exits non-zero on failure.   Run: node tests/session-three-track-e2e.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const model = require('../lib/session-model');

const DOCTOR = path.join(H.OPS, '..', 'tpm-session-doctor.js');
const SD = tmpDir('tpm-3track-e2e-');
const LIVE_PID = process.pid;             // a real running process: "owner process running"
const DEAD_PID = 2147483000;              // certainly not running
const who = {
  A: { id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', pid: LIVE_PID },
  A2: { id: 'a2a2a2a2-1111-4111-8111-a2a2a2a2a2a2', pid: LIVE_PID },   // A after /clear: same pid, NEW id
  B: { id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', pid: DEAD_PID },
  C: { id: 'cccccccc-3333-4333-8333-cccccccccccc', pid: DEAD_PID + 1 },
  D: { id: 'dddddddd-4444-4444-8444-dddddddddddd', pid: DEAD_PID + 2 },
};
const cur = (w, args) => H.run(H.CURRENT, ['--sessions-dir', SD, ...args], who[w]);
const ops = (w, verb, args) => H.run(H.OPS, [verb, '--sessions-dir', SD, ...args], who[w]);
const rec = (n, t) => model.loadSession(H.T.trackPaths(SD, n, t).jsonPath);
const handoffFile = (name, text) => { const p = path.join(SD, `${name}.txt`); fs.writeFileSync(p, text); return p; };
const dirSha = () => JSON.stringify(require('./helpers/three-track').shas(SD));

test('1-3 A opens track a; B is REFUSED at the gate (nothing written), then claims --parallel b; C claims --parallel c', () => {
  const a = cur('A', ['--open']);
  assert.strictEqual(a.code, 0, a.stderr);
  assert.deepStrictEqual([JSON.parse(a.stdout).number, JSON.parse(a.stdout).track], ['0001', 'a']);

  const before = dirSha();
  const b1 = cur('B', ['--open']);
  assert.strictEqual(b1.code, 3, 'the gate refuses a second instance');
  const j = JSON.parse(b1.stdout);
  assert.strictEqual(j.refused, true);
  assert.strictEqual(j.code, 'ESESSION_FOREIGN_TRACK');
  assert.strictEqual(j.tracks[0].track, 'a');
  assert.strictEqual(j.tracks[0].liveness.status, 'running');
  assert.ok(/Nothing was written/.test(b1.stderr) && /--parallel/.test(b1.stderr) && /--adopt/.test(b1.stderr), b1.stderr);
  assert.strictEqual(dirSha(), before, 'a refusal changes no byte on disk');

  const b2 = cur('B', ['--open', '--parallel']);
  assert.strictEqual(b2.code, 0, b2.stderr);
  assert.deepStrictEqual([JSON.parse(b2.stdout).track, JSON.parse(b2.stdout).gate], ['b', 'parallel']);
  const c = cur('C', ['--open', '--parallel']);
  assert.strictEqual(c.code, 0, c.stderr);
  assert.strictEqual(JSON.parse(c.stdout).track, 'c');
  assert.deepStrictEqual(rec('0001', 'a').meta.claudeSessionId, who.A.id);
  assert.deepStrictEqual(rec('0001', 'b').meta.claudeSessionId, who.B.id);
  assert.deepStrictEqual(rec('0001', 'c').meta.claudeSessionId, who.C.id);
});

test('4 A /clears (same pid, new id): refused WITH the /clear evidence, then ADOPTS track a; the new id owns it', () => {
  const r = cur('A2', ['--open']);
  assert.strictEqual(r.code, 3);
  assert.ok(/same Claude process as yours/.test(r.stderr), r.stderr);
  const trackA = JSON.parse(r.stdout).tracks.find((t) => t.track === 'a');
  assert.strictEqual(trackA.liveness.sameProcessNewSession, true);
  const adopt = cur('A2', ['--open', '--adopt', 'a']);
  assert.strictEqual(adopt.code, 0, adopt.stderr);
  const j = JSON.parse(adopt.stdout);
  assert.deepStrictEqual([j.track, j.gate, j.adopted, j.sessionId], ['a', 'adopt', true, who.A2.id]);
  assert.strictEqual(rec('0001', 'a').meta.claudeSessionId, who.A2.id);
  // the old id is now the stranger: its write is refused
  const stale = ops('A', 'note', ['--session', '1', '--log', '--status', 'NOTE', '--text', 'late']);
  assert.strictEqual(stale.code, 1);
  assert.strictEqual(rec('0001', 'a').log.length, 0, 'nothing landed from the old id');
});

test('5 each instance saves and adds punchlist items on ITS OWN track only (ids carry the letter; a shows as 1a.K)', () => {
  const plan = { A2: ['a', ['alpha-one', 'alpha-two']], B: ['b', ['beta-one']], C: ['c', ['gamma-one']] };
  for (const [w, [track, slugs]] of Object.entries(plan)) {
    for (const s of slugs) {
      const r = ops(w, 'punchlist', ['--session', '1', '--action', 'add', '--text', `${s} text`, '--slug', s]);
      assert.strictEqual(r.code, 0, r.stderr);
    }
    assert.strictEqual(ops(w, 'note', ['--session', '1', '--log', '--status', 'NOTE', '--text', `note from ${track}`]).code, 0);
    assert.strictEqual(ops(w, 'save', ['--session', '1']).code, 0);
  }
  assert.deepStrictEqual(rec('0001', 'a').punchlist.map((i) => i.slug), ['alpha-one', 'alpha-two']);
  assert.deepStrictEqual(rec('0001', 'b').punchlist.map((i) => [i.id, i.slug]), [['1b.1', 'beta-one']]);
  assert.deepStrictEqual(rec('0001', 'c').punchlist.map((i) => [i.id, i.slug]), [['1c.1', 'gamma-one']]);
  assert.deepStrictEqual(rec('0001', 'a').log.map((l) => l.text), ['note from a']);
  assert.deepStrictEqual(rec('0001', 'b').log.map((l) => l.text), ['note from b']);
  // a cross-track item is refused, naming the owner track; nothing changes
  const before = dirSha();
  const x = ops('B', 'punchlist', ['--session', '1', '--action', 'close', '--item', 'gamma-one']);
  assert.strictEqual(x.code, 1);
  assert.ok(/ECROSS_TRACK/.test(x.stdout + x.stderr), x.stdout + x.stderr);
  assert.strictEqual(dirSha(), before);
});

test('6 c is ABANDONED-SEALED (no flag -> exit 4 + nothing sealed); a and b are closed by their owners with handoffs', () => {
  const noFlag = ops('A2', 'close', ['--session', '1', '--track', 'c']);
  assert.strictEqual(noFlag.code, 4);
  assert.strictEqual(fs.existsSync(H.T.trackPaths(SD, '0001', 'c').sealedPath), false, 'nothing sealed without the confirmation flag');
  const seal = ops('A2', 'close', ['--session', '1', '--track', 'c', '--even-if-running', '--reason', 'window closed']);
  assert.strictEqual(seal.code, 0, seal.stderr);
  const marker = JSON.parse(fs.readFileSync(H.T.trackPaths(SD, '0001', 'c').sealedPath, 'utf8'));
  assert.strictEqual(marker.reason, 'abandoned');
  assert.strictEqual(marker.sealedBy.claudeSessionId, who.A2.id);
  // c's owner learns of it: its next write is refused naming who sealed it
  const late = ops('C', 'note', ['--session', '1', '--log', '--status', 'NOTE', '--text', 'too late']);
  assert.strictEqual(late.code, 1);
  assert.ok(/ETRACK_SEALED/.test(late.stdout + late.stderr));

  for (const [w, track] of [['A2', 'a'], ['B', 'b']]) {
    const bare = ops(w, 'close', ['--session', '1']);
    assert.strictEqual(bare.code, 1, 'the close guard refuses without a handoff');
    const f = handoffFile(`h-${track}`, `where we are on ${track}\n`);
    assert.strictEqual(ops(w, 'import-handoff', ['--session', '1', '--txt-file', f, '--next', `next on ${track}`]).code, 0);
    const done_ = ops(w, 'close', ['--session', '1']);
    assert.strictEqual(done_.code, 0, done_.stderr);
    assert.ok(rec('0001', track).meta.closedAt, `track ${track} sealed by its owner`);
  }
  assert.strictEqual(rec('0001', 'c').meta.closedAt, null, 'the abandoned record itself is untouched; the marker is the seal');
});

let pickup = '';
test('7a D (no track) reads the pickup: THREE correct blocks - a sealed by owner, b sealed by owner, c sealed as abandoned', () => {
  const r = H.run(H.BOOT_READ, ['--sessions-dir', SD], who.D);
  assert.strictEqual(r.code, 0, r.stderr);
  pickup = r.stdout.split(SD).join('<SD>');
  assert.ok(/^== PRIOR SESSION 0001 · .*· 3 parallel tracks ==$/m.test(pickup), pickup);
  assert.deepStrictEqual([...pickup.matchAll(/^=== TRACK ([a-z]) · /gm)].map((m) => m[1]), ['a', 'b', 'c']);
  assert.ok(/=== TRACK a · SEALED by its owner /.test(pickup));
  assert.ok(/=== TRACK b · SEALED by its owner /.test(pickup));
  assert.ok(new RegExp(`=== TRACK c · SEALED AS ABANDONED \\S+ by claude ${who.A2.id.slice(0, 8)} \\(abandoned, "window closed"\\); no final handoff was written ===`).test(pickup), pickup);
  assert.ok(/where we are on a\n/.test(pickup) && /next on a\b/.test(pickup), 'a handoff verbatim');
  assert.ok(/where we are on b\n/.test(pickup) && /next on b\b/.test(pickup), 'b handoff verbatim');
  assert.ok(!/STILL LIVE/.test(pickup), 'no track is mislabelled live');
  // the combined list: all 4 open items, tagged by track, ordered
  assert.ok(/^== OPEN PUNCHLIST, ALL TRACKS ABOVE \(4\) ==$/m.test(pickup), pickup);
  const list = pickup.split('== OPEN PUNCHLIST, ALL TRACKS ABOVE (4) ==\n')[1].split('\n');
  assert.ok(list[0].startsWith('#1a.1 [track a]') && list[0].includes('alpha-one'), list[0]);
  assert.ok(list[1].startsWith('#1a.2 [track a]') && list[1].includes('alpha-two'), list[1]);
  assert.ok(list[2].startsWith('#1b.1 [track b]') && list[2].includes('beta-one'), list[2]);
  assert.ok(list[3].startsWith('#1c.1 [track c') && list[3].includes('gamma-one'), list[3]);
  assert.strictEqual(fs.existsSync(path.join(SD, 'session-0002')), false, 'reading the pickup wrote nothing');
});

test('7b D opens session 0002 (nothing is live) and carries one item from EACH track; provenance keeps the source session AND track letter', () => {
  const o = cur('D', ['--open']);
  assert.strictEqual(o.code, 0, o.stderr);
  assert.deepStrictEqual([JSON.parse(o.stdout).number, JSON.parse(o.stdout).track], ['0002', 'a']);
  const srcs = [['a', 'alpha-two', '0001'], ['b', 'beta-one', '0001b'], ['c', 'gamma-one', '0001c']];
  const sourcesBefore = dirSha();
  for (const [t, slug] of srcs) {
    const r = ops('D', 'punchlist', ['--session', '2', '--action', 'carry-in', '--from', H.T.trackPaths(SD, '0001', t).jsonPath, '--item', slug]);
    assert.strictEqual(r.code, 0, `${t}: ${r.stderr}`);
  }
  const r2 = rec('0002', 'a');
  for (const [, slug, label] of srcs) {
    const it = r2.punchlist.find((i) => i.slug === slug);
    assert.ok(it, `${slug} carried`);
    assert.strictEqual(it.state, 'open');
    assert.strictEqual(it.events.find((e) => e.op === 'carry-in').fromSession, label, `${slug} provenance`);
  }
  const md = fs.readFileSync(H.T.trackPaths(SD, '0002', 'a').mdPath, 'utf8');
  for (const label of ['0001', '0001b', '0001c']) assert.ok(md.includes(`carried from ${label}`), `${label} in the .md\n${md}`);
  // the sealed sources are byte-identical: only session 0002 changed
  const after = JSON.parse(dirSha());
  const was = JSON.parse(sourcesBefore);
  for (const k of Object.keys(was)) if (k.startsWith('session-0001')) assert.strictEqual(after[k], was[k], `${k} unchanged by the carry`);
});

test('8 the finished store passes the doctor: exit 0, three session-0001 rows each OK with their sealed state, no drift/mismatch/duplicate', () => {
  const r = H.run(DOCTOR, ['--sessions-dir', SD], {});
  assert.strictEqual(r.code, 0, r.stdout + r.stderr);
  const rows = r.stdout.split('\n').filter((l) => /session-0001\//.test(l));
  assert.strictEqual(rows.length, 3, r.stdout);
  assert.ok(/-b\.json  OK · SEALED by owner/.test(rows[1]) && /session-0001\.json  OK · SEALED by owner/.test(rows[0]), r.stdout);
  assert.ok(/-c\.json  OK · SEALED by marker \(abandoned/.test(rows[2]), r.stdout);
  assert.ok(!/TRACK-MISMATCH|DUPLICATE-TRACK|DRIFT/.test(r.stdout), r.stdout);
  // the only advisory is the live new session 0002 whose owner process is gone (D is a fake instance)
  assert.ok(/session-0002\/session-0002\.json  OK · OWNER-GONE/.test(r.stdout), r.stdout);
});

done('session-three-track-e2e.test');
