'use strict';
/**
 * session-ops-xtrack.test.js — phase 12 (DoD C, D, E, F): the id normaliser at every id-taking site, writes that land
 * on the caller's OWN track only, a cross-track item change refused BY NAME with nothing written, a missing Claude
 * session id handled, and the read-side track selector. Every simulated Claude instance gets its own explicit
 * CLAUDE_CODE_SESSION_ID / CLAUDE_PID (the ambient ones are stripped by H.cleanEnv). Hermetic; exits non-zero on failure.
 * Run: node tests/session-ops-xtrack.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');
const ops = require('../tpm-session-ops');
const { T, model } = H;

const opsCli = (args, o) => H.run(H.OPS, args, o);
const jsonOf = (sd, n, t) => JSON.parse(fs.readFileSync(T.trackPaths(sd, n, t).jsonPath, 'utf8'));
const ho = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };
const residue = (sd, n) => fs.readdirSync(path.join(sd, `session-${n}`)).filter((f) => f.startsWith('.'));

// A single-track session owned by instance idA with items 1.1 (alpha) and 1.2 (beta).
function oneTrack() {
  const sd = tmpDir('xt-one-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  const A = { id: 'idA', pid: 4101 };
  assert.strictEqual(opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'add', '--text', 'first', '--slug', 'alpha'], A).code, 0);
  assert.strictEqual(opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'add', '--text', 'second', '--slug', 'beta'], A).code, 0);
  return { sd, A };
}

// ── C: ids ───────────────────────────────────────────────────────────────────────────────────

test('W-C1 close --item accepts every spelling of track a\'s id (1.1, 1a.1, #1a.1, 0001a.1) and closes the SAME stored item', () => {
  for (const spelling of ['1.1', '1a.1', '#1a.1', '0001a.1', '01.1']) {
    const { sd, A } = oneTrack();
    const r = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', spelling], A);
    assert.strictEqual(r.code, 0, `${spelling}: ${r.stderr}`);
    const rec = jsonOf(sd, '0001', 'a');
    assert.deepStrictEqual(rec.punchlist.map((i) => [i.id, i.state]), [['1.1', 'done'], ['1.2', 'open']], spelling);
    assert.ok(/closed #1\.1 \[alpha\]/.test(r.stderr), `a single-track session prints the stored form: ${r.stderr}`);
  }
});

test('W-C2 reopen and drop take the same spellings; the stored id stays 1.1', () => {
  const { sd, A } = oneTrack();
  const run = (action, item) => opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', action, '--item', item], A);
  assert.strictEqual(run('close', '1a.2').code, 0);
  assert.strictEqual(run('reopen', '#1a.2').code, 0);
  assert.strictEqual(run('drop', '1a.1').code, 0);
  assert.deepStrictEqual(jsonOf(sd, '0001', 'a').punchlist.map((i) => [i.id, i.state]), [['1.1', 'dropped'], ['1.2', 'open']]);
});

test('W-C3 the slug path is unchanged, and a true miss keeps the old text byte for byte (exit 1)', () => {
  const { sd, A } = oneTrack();
  assert.strictEqual(opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', 'beta'], A).code, 0);
  const miss = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', 'nonesuch'], A);
  assert.strictEqual(miss.code, 1);
  assert.strictEqual(miss.stderr, "tpm-session-ops: punchlist op: no item matching 'nonesuch'\n");
  const missId = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', '7a.9'], A);
  assert.strictEqual(missId.stderr, "tpm-session-ops: punchlist op: no item matching '7a.9'\n", 'an id of ANOTHER session is a plain miss');
});

test('W-C4 add mints 1.K on track a and 1b.K on track b; a multi-track session DISPLAYS track a as 1a.K', () => {
  const sd = tmpDir('xt-c4-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: ho });
  const add = (who, text) => opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'add', '--text', text, '--slug', text], who);
  const ra = add({ id: 'idA', pid: 4101 }, 'fromA');
  const rb = add({ id: 'idB', pid: 4102 }, 'fromB');
  assert.deepStrictEqual(jsonOf(sd, '0001', 'a').punchlist.map((i) => i.id), ['1.1']);
  assert.deepStrictEqual(jsonOf(sd, '0001', 'b').punchlist.map((i) => i.id), ['1b.1']);
  assert.ok(/added #1a\.1 \[fromA\]/.test(ra.stderr), ra.stderr);
  assert.ok(/added #1b\.1 \[fromB\]/.test(rb.stderr), rb.stderr);
  // and the display form closes it again (both spellings resolve to the one stored id)
  const c = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', '1a.1'], { id: 'idA', pid: 4101 });
  assert.ok(/closed #1a\.1 \[fromA\]/.test(c.stderr), c.stderr);
});

test('W-C5 carry-in by 1a.2 / 1.2 from a prior JSON; fromSession is 0001 (from a) and 0001b (from b); the converter renders it', () => {
  const sd = tmpDir('xt-c5-');
  const prior = tmpDir('xt-c5-prior-');
  H.putTrack(prior, '0001', 'a', { owner: 'idP', handoff: ho });
  H.putTrack(prior, '0001', 'b', { owner: 'idQ', handoff: ho });
  const priorA = T.trackPaths(prior, '0001', 'a').jsonPath; const priorB = T.trackPaths(prior, '0001', 'b').jsonPath;
  ops.opPunchlist({ sessionsDir: prior, number: '0001', track: 'a', action: 'add', text: 'A1', slug: 'a1' });
  ops.opPunchlist({ sessionsDir: prior, number: '0001', track: 'a', action: 'add', text: 'A2', slug: 'a2' });
  ops.opPunchlist({ sessionsDir: prior, number: '0001', track: 'b', action: 'add', text: 'B1', slug: 'b1' });
  H.putTrack(sd, '0002', 'a', { owner: 'idN', handoff: ho });
  const N = { id: 'idN', pid: 4103 };
  const carry = (from, item) => opsCli(['punchlist', '--sessions-dir', sd, '--session', '2', '--action', 'carry-in', '--from', from, '--item', item], N);
  assert.strictEqual(carry(priorA, '1a.2').code, 0);
  assert.strictEqual(carry(priorA, '1.1').code, 0);
  const rb = carry(priorB, '1b.1');
  assert.strictEqual(rb.code, 0, rb.stderr);
  const rec = jsonOf(sd, '0002', 'a');
  assert.deepStrictEqual(rec.punchlist.map((i) => [i.id, i.slug]), [['2.1', 'a2'], ['2.2', 'a1'], ['2.3', 'b1']]);
  assert.deepStrictEqual(rec.punchlist.map((i) => i.events[0].fromSession), ['0001', '0001', '0001b']);
  const md = fs.readFileSync(T.trackPaths(sd, '0002', 'a').mdPath, 'utf8');
  assert.ok(/carried from 0001b/.test(md) && /carried from 0001_/.test(md), md);
});

test('W-C7 a slug that LOOKS like an id is found by the exact match first (and a legacy non-id id still works)', () => {
  const sd = tmpDir('xt-c7-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', action: 'add', text: 'odd', slug: '9a.9' });
  const r = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', '9a.9'], { id: 'idA', pid: 4101 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(jsonOf(sd, '0001', 'a').punchlist[0].state, 'done');
});

// ── D: writes go to my own track ─────────────────────────────────────────────────────────────

test('W-D1..D7 each of the seven write verbs, run as instance c in a three-track store, lands on c\'s record only (a and b byte-identical)', () => {
  const C = { id: TT.IDS.c, pid: 4103 };
  const verbs = [
    ['save'],
    ['note', '--log', '--status', 'NOTE', '--text', 'hi'],
    ['punchlist', '--action', 'add', '--text', 'new thing', '--slug', 'newthing'],
    ['import-handoff', '--txt-file', '@txt', '--next', 'go'],
    ['import-log', '--txt-file', '@txt'],
    ['import-punchlist', '--txt-file', '@txt'],
    ['close'],
  ];
  for (const v of verbs) {
    const sd = tmpDir('xt-d-');
    TT.build(sd, '0001');
    const txt = path.join(sd, 'in.txt'); fs.writeFileSync(txt, 'imported line\n');
    const before = TT.shas(path.join(sd, 'session-0001'));
    const args = [v[0], '--sessions-dir', sd, '--session', '1', ...v.slice(1).map((x) => (x === '@txt' ? txt : x))];
    const r = opsCli(args, C);
    assert.strictEqual(r.code, 0, `${v[0]}: ${r.stderr}`);
    const after = TT.shas(path.join(sd, 'session-0001'));
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]).sort();
    assert.ok(changed.length > 0 && changed.every((k) => /^session-0001-c\.(json|md)$/.test(k)), `${v[0]} changed ${JSON.stringify(changed)}`);
  }
});

test('W-D8 programmatic opSave with an identity writes the identity\'s own track, not track a (op-level resolution)', () => {
  const sd = tmpDir('xt-d8-');
  TT.build(sd, '0001');
  const before = TT.shas(path.join(sd, 'session-0001'));
  const rec = ops.opNote({ sessionsDir: sd, number: '0001', identity: H.id(TT.IDS.c), type: 'log', status: 'NOTE', text: 'x' });
  assert.strictEqual(rec.meta.track, 'c');
  const after = TT.shas(path.join(sd, 'session-0001'));
  assert.deepStrictEqual(Object.keys(after).filter((k) => after[k] !== before[k]).sort(), ['session-0001-c.json', 'session-0001-c.md']);
  // ... and a stranger's identity is refused by name instead of silently writing track a
  assert.throws(() => ops.opSave({ sessionsDir: sd, number: '0001', identity: H.id('idStranger') }), (e) => e.code === 'ENOT_OWNER');
});

test('W-D9 the self-closed rung: instance A closed its own track a while c is live; A\'s later write lands on a (no "belongs to another session")', () => {
  const sd = tmpDir('xt-d9-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true, handoff: ho });
  H.putTrack(sd, '0001', 'c', { owner: 'idC', handoff: ho });
  const r = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'after close'], { id: 'idA', pid: 4101 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(jsonOf(sd, '0001', 'a').log.length, 1);
  assert.strictEqual(jsonOf(sd, '0001', 'c').log.length, 0);
  // a TRUE foreign case keeps its text
  const f = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'x'], { id: 'idStranger', pid: 4109 });
  assert.strictEqual(f.code, 1);
  assert.ok(/belong to another Claude session/.test(f.stderr), f.stderr);
});

test('W-D10 two self-sealed tracks of mine and a live foreign one -> ETRACK_AMBIGUOUS naming both, nothing written', () => {
  const sd = tmpDir('xt-d10-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', sealed: true, handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'idA', sealed: true, handoff: ho });
  H.putTrack(sd, '0001', 'c', { owner: 'idC', handoff: ho });
  const before = TT.shas(path.join(sd, 'session-0001'));
  const r = opsCli(['save', '--sessions-dir', sd, '--session', '1'], { id: 'idA', pid: 4101 });
  assert.strictEqual(r.code, 1);
  assert.strictEqual(JSON.parse(r.stdout).code, 'ETRACK_AMBIGUOUS');
  assert.ok(/several tracks of 0001 are yours \(a, b\)/.test(r.stderr), r.stderr);
  assert.deepStrictEqual(TT.shas(path.join(sd, 'session-0001')), before);
});

// ── E: cross-track refusal by name ───────────────────────────────────────────────────────────

function refuse(sd, args, who) {
  const before = TT.shas(path.join(sd, 'session-0001'));
  const r = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', ...args], who);
  const after = TT.shas(path.join(sd, 'session-0001'));
  assert.deepStrictEqual(after, before, `a refused call must change NO file (${args.join(' ')})`);
  assert.deepStrictEqual(residue(sd, '0001'), [], 'no .lock left behind by a refusal');
  return r;
}

test('W-E1 close --item 1b.1 as c: exit 1, ECROSS_TRACK, the message names the item, its slug, track b and my track c', () => {
  const sd = tmpDir('xt-e1-'); TT.build(sd, '0001');
  const r = refuse(sd, ['--action', 'close', '--item', '1b.1'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(r.code, 1);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.code, 'ECROSS_TRACK');
  assert.deepStrictEqual([j.details.ownerTrack, j.details.mineTrack, j.details.item.id, j.details.item.slug], ['b', 'c', '1b.1', 'exportr']);
  for (const tok of ['#1b.1', '[exportr]', 'track b of session 0001', 'bbbbbbbb...', 'not to your track c', 'Nothing was changed', 'ask that instance to close it']) {
    assert.ok(r.stderr.includes(tok), `${tok} in: ${r.stderr}`);
  }
});

test('W-E2/E3 the same by slug, and by 1.2 (track a\'s item) as c; track a is named with its sealed state', () => {
  const sd = tmpDir('xt-e2-'); TT.build(sd, '0001');
  const bySlug = refuse(sd, ['--action', 'close', '--item', 'expdoc'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(JSON.parse(bySlug.stdout).code, 'ECROSS_TRACK');
  assert.ok(bySlug.stderr.includes('#1b.2 [expdoc]'), bySlug.stderr);
  const byA = refuse(sd, ['--action', 'close', '--item', '1.2'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(JSON.parse(byA.stdout).code, 'ECROSS_TRACK');
  assert.ok(byA.stderr.includes('#1a.2 [retry01] belongs to track a of session 0001') && byA.stderr.includes('sealed (closed)'), byA.stderr);
  const byA2 = refuse(sd, ['--action', 'close', '--item', '1a.2'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(JSON.parse(byA2.stdout).code, 'ECROSS_TRACK');
});

test('W-E4 reopen and drop are refused likewise (verb word follows the action)', () => {
  const sd = tmpDir('xt-e4-'); TT.build(sd, '0001');
  const ro = refuse(sd, ['--action', 'reopen', '--item', '1a.1'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(JSON.parse(ro.stdout).code, 'ECROSS_TRACK');
  assert.ok(ro.stderr.includes('ask that instance to reopen it'), ro.stderr);
  const dr = refuse(sd, ['--action', 'drop', '--item', 'exportr'], { id: TT.IDS.c, pid: 4103 });
  assert.ok(dr.stderr.includes('ask that instance to drop it'), dr.stderr);
});

test('W-E5 a track sealed by someone else\'s marker is named as such', () => {
  const sd = tmpDir('xt-e5-'); TT.build(sd, '0001');
  const r = refuse(sd, ['--action', 'close', '--item', 'exportr'], { id: TT.IDS.c, pid: 4103 });
  assert.ok(r.stderr.includes('sealed by marker'), r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).details.ownerState, 'sealed by marker');
});

test('W-E6 the library path refuses the same way, and a LIVE owner is described as live', () => {
  const sd = tmpDir('xt-e6-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: ho });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'b', action: 'add', text: 'theirs', slug: 'theirs' });
  const before = TT.shas(path.join(sd, 'session-0001'));
  assert.throws(() => ops.opPunchlist({ sessionsDir: sd, number: '0001', identity: H.id('idA'), action: 'close', idOrSlug: 'theirs' }),
    (e) => e.code === 'ECROSS_TRACK' && /belongs to track b of session 0001 \(owner idB\.\.\., live\), not to your track a/.test(e.message));
  assert.deepStrictEqual(TT.shas(path.join(sd, 'session-0001')), before);
});

test('W-E7 a true miss keeps the old message; a slug present in MY record resolves to mine even if a sibling has it too', () => {
  const sd = tmpDir('xt-e7-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: ho });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'a', action: 'add', text: 'mine', slug: 'samey' });
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'b', action: 'add', text: 'theirs', slug: 'samey' });
  const before = TT.shas(path.join(sd, 'session-0001'));
  const r = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', 'samey'], { id: 'idA', pid: 4101 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(jsonOf(sd, '0001', 'a').punchlist[0].state, 'done');
  assert.strictEqual(jsonOf(sd, '0001', 'b').punchlist[0].state, 'open', 'the sibling\'s same-named item is untouched');
  assert.notDeepStrictEqual(TT.shas(path.join(sd, 'session-0001'))['session-0001.json'], before['session-0001.json']);
  const miss = opsCli(['punchlist', '--sessions-dir', sd, '--session', '1', '--action', 'close', '--item', 'zzz'], { id: 'idA', pid: 4101 });
  assert.strictEqual(miss.stderr, "tpm-session-ops: punchlist op: no item matching 'zzz'\n");
});

test('W-E8 a slug held by two OTHER tracks is EITEM_AMBIGUOUS (legacy data), nothing written', () => {
  const sd = tmpDir('xt-e8-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'idB', handoff: ho });
  H.putTrack(sd, '0001', 'c', { owner: 'idC', handoff: ho });
  for (const t of ['b', 'c']) ops.opPunchlist({ sessionsDir: sd, number: '0001', track: t, action: 'add', text: 'x', slug: 'dup' });
  const r = refuse(sd, ['--action', 'close', '--item', 'dup'], { id: 'idA', pid: 4101 });
  assert.strictEqual(JSON.parse(r.stdout).code, 'EITEM_AMBIGUOUS');
  assert.ok(/matches items in tracks b, c of session 0001; use the item id/.test(r.stderr), r.stderr);
});

// ── F: a missing Claude session id ───────────────────────────────────────────────────────────

test('W-F1..F4 no Claude id: one unsealed track -> proceeds; two -> ETRACK_AMBIGUOUS (nothing written); --track b proceeds; --track on a marker-sealed b -> ETRACK_SEALED', () => {
  const one = tmpDir('xt-f1-'); H.putTrack(one, '0001', 'a', { owner: 'idA', handoff: ho });
  const f1 = opsCli(['save', '--sessions-dir', one, '--session', '1'], {});
  assert.strictEqual(f1.code, 0, f1.stderr);

  const two = tmpDir('xt-f2-');
  H.putTrack(two, '0001', 'a', { owner: 'idA', handoff: ho }); H.putTrack(two, '0001', 'b', { owner: 'idB', handoff: ho });
  const before = TT.shas(path.join(two, 'session-0001'));
  const f2 = opsCli(['save', '--sessions-dir', two, '--session', '1'], {});
  assert.strictEqual(f2.code, 1);
  assert.strictEqual(JSON.parse(f2.stdout).code, 'ETRACK_AMBIGUOUS');
  assert.ok(/your Claude session id is unreadable and 2 tracks of 0001 are unsealed \(a, b\); pass --track <letter>/.test(f2.stderr), f2.stderr);
  assert.deepStrictEqual(TT.shas(path.join(two, 'session-0001')), before);

  const f3 = opsCli(['note', '--sessions-dir', two, '--session', '1', '--track', 'b', '--log', '--status', 'NOTE', '--text', 'explicit'], {});
  assert.strictEqual(f3.code, 0, f3.stderr);
  assert.strictEqual(jsonOf(two, '0001', 'b').log.length, 1);
  assert.strictEqual(jsonOf(two, '0001', 'a').log.length, 0);

  H.putMarker(two, '0001', 'b');
  const f4 = opsCli(['note', '--sessions-dir', two, '--session', '1', '--track', 'b', '--log', '--status', 'NOTE', '--text', 'x'], {});
  assert.strictEqual(f4.code, 1);
  assert.strictEqual(JSON.parse(f4.stdout).code, 'ETRACK_SEALED');
});

// ── selectors and designators ────────────────────────────────────────────────────────────────

test('SEL-1..6 resolveTrackSelector: a letter, a >=8-char id prefix (case-insensitive), malformed -> ETRACK_SELECTOR, unknown -> ENO_TRACK, ambiguous prefix', () => {
  const sd = tmpDir('xt-sel-');
  H.putTrack(sd, '0001', 'a', { owner: 'aaaaaaaa-1111', handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: 'bbbbbbbb-2222', handoff: ho });
  H.putTrack(sd, '0001', 'c', { owner: 'bbbbbbbb-3333', handoff: ho });
  H.putMarker(sd, '0001', 'b');
  const sel = (x) => T.resolveTrackSelector(sd, '0001', x);
  assert.strictEqual(sel('a'), 'a');
  assert.strictEqual(sel('b'), 'b', 'a sealed track is selectable');
  assert.strictEqual(sel('AAAAAAAA'), 'a');
  assert.strictEqual(sel('aaaaaaaa-1'), 'a');
  assert.throws(() => sel('q'), (e) => e.code === 'ENO_TRACK' && e.message === "session 0001 has no track 'q' (tracks: a, b, c).");
  assert.throws(() => sel('dddddddd'), (e) => e.code === 'ENO_TRACK' && /no track of session 0001 is owned by a Claude session starting 'dddddddd'/.test(e.message));
  for (const bad of ['bbbb', 'B', '', 'abcdefg', 5, null, undefined]) {
    assert.throws(() => sel(bad), (e) => e.code === 'ETRACK_SELECTOR' && e.exitCode === 2, String(bad));
  }
  assert.throws(() => sel('bbbbbbbb'), (e) => e.code === 'ETRACK_SELECTOR_AMBIGUOUS' && /\(b, c\)/.test(e.message));
  assert.strictEqual(sel('bbbbbbbb-2'), 'b');
});

test('SEL-7 --session 0001b is rejected (ESESSION_DESIGNATOR, exit 2) by every verb that takes --session; lists are checked per element', () => {
  const sd = tmpDir('xt-des-'); TT.build(sd, '0001');
  const r = opsCli(['save', '--sessions-dir', sd, '--session', '0001b'], { id: TT.IDS.c, pid: 4103 });
  assert.strictEqual(r.code, 2);
  assert.ok(/--session takes a session number like 0001, not '0001b'; pick the track with --track b\./.test(r.stderr), r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).code, 'ESESSION_DESIGNATOR');
  const exp = H.run(path.join(H.OPS, '..', 'tpm-session-export.js'), ['--sessions-dir', sd, '--session', '0001,0002c'], {});
  assert.strictEqual(exp.code, 2);
  assert.throws(() => T.assertSessionNumber('1,2b'), (e) => e.code === 'ESESSION_DESIGNATOR');
  T.assertSessionNumber('0001,0002'); T.assertSessionNumber(undefined);
});

done('session-ops-xtrack.test');
