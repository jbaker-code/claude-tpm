'use strict';
/**
 * session-verbs-harden.test.js — phase 15 DoD B: the focused verb matrix of the multi-track verbs train, through the
 * REAL CLIs (a clean env, an explicit fake CLAUDE_CODE_SESSION_ID / CLAUDE_PID per simulated instance), plus the
 * carried items of the phase-15 builder and the phase-12/13 verifier verdicts:
 *
 *   X   cross-track refusal for EVERY write verb (explicit --track of another's track, and no --track as a stranger);
 *       --track narrowing to one's own track; per-track id minting; the missing-session-id rule
 *   P   the late-sealing pickup rule, driven through `boot-read` in four orderings
 *   R   boot-read `--track` with no value is a usage error (exit 2); `--track a` still narrows, exit 0, read-only
 *   M   migrate: with no --now the handoff.updatedAt is the source's real last-write time; an injected --now still wins
 *   D   doctor: one fault -> one finding (TRACK-MISMATCH names the collider, no DUPLICATE-TRACK); a collision with no
 *       mismatched claimant keeps DUPLICATE-TRACK; the stray session-NNNN-a.json note is untouched
 *   U   `unseal` under a FORCED interleaving: it waits behind a lock holder (the fs-barrier seam)
 *   C   `compose` for a caller with NO Claude session id
 * Run: node tests/session-verbs-harden.test.js     (async cases run one after another; at most 2 children alive)
 */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const barrier = require('../../tests/lib/fs-barrier');
const H = require('./helpers/track-helpers');
const F = require('./helpers/fixed-multi');
const tt = require('./helpers/three-track');
const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');
const doctor = require('../tpm-session-doctor');
const compose = require('../tpm-session-compose');

const MIGRATE = path.join(H.OPS, '..', 'tpm-session-migrate.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-verbs-harden-'));
let seq = 0;
const scratch = (n) => { const d = path.join(root, `${n}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } };
const sha = (d) => JSON.stringify(tt.shas(d));
const ho = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const ID = { a: F.id('a'), b: F.id('b'), c: F.id('c'), z: F.id('z') };
const DEAD = 2147483000;
const ops = (sd, who, verb, args) => H.run(H.OPS, [verb, '--sessions-dir', sd, ...args], { id: ID[who], pid: DEAD });

/** A store with TWO live tracks, each with one open item: a (owner a) and b (owner b). Returns { sd, file }. */
function liveTwo(tag) {
  const sd = scratch(tag);
  for (const t of ['a', 'b']) {
    const jp = H.putTrack(sd, '0001', t, { owner: ID[t], handoff: ho });
    let rec = model.loadSession(jp);
    rec = model.addPunchlist(rec, { text: `item of ${t}`, slug: `item-${t}` });
    const p = H.T.trackPaths(sd, '0001', t);
    model.saveSession(rec, { jsonPath: p.jsonPath, mdPath: p.mdPath, render: (r) => render(r, { now: H.NOW }) });
  }
  const file = path.join(sd, 'in.txt'); fs.writeFileSync(file, 'imported\n');
  return { sd, file };
}
function writeVerbs(sd, file, target) {
  const prior = H.T.trackPaths(sd, '0001', target).jsonPath;
  return {
    save: ['save'],
    note: ['note', '--log', '--status', 'NOTE', '--text', 'x'],
    'punchlist add': ['punchlist', '--action', 'add', '--text', 'intruder'],
    'punchlist close': ['punchlist', '--action', 'close', '--item', `item-${target}`],
    'punchlist reopen': ['punchlist', '--action', 'reopen', '--item', `item-${target}`],
    'punchlist drop': ['punchlist', '--action', 'drop', '--item', `item-${target}`],
    'punchlist carry-in': ['punchlist', '--action', 'carry-in', '--from', prior, '--item', `item-${target}`],
    'import-handoff': ['import-handoff', '--txt-file', file, '--next', 'n'],
    'import-log': ['import-log', '--txt-file', file],
    'import-punchlist': ['import-punchlist', '--txt-file', file],
    close: ['close'],
  };
}

// ── X: cross-track refusal, narrowing, minting, the missing-id rule ─────────────────────────────────────────────
test('X1 every write verb as instance b with an explicit --track a (a is live and a\'s): refused ENOT_OWNER, exit 1, the whole store byte-identical', () => {
  const { sd, file } = liveTwo('x1');
  const before = sha(sd);
  for (const [name, a] of Object.entries(writeVerbs(sd, file, 'a'))) {
    const r = ops(sd, 'b', a[0], ['--session', '1', '--track', 'a', ...a.slice(1)]);
    if (name === 'close') {
      // `close --track <other>` is the abandoned-seal path: without the confirmation flag it only PRINTS the plan (exit 4)
      assert.strictEqual(r.code, 4, `${name}: ${r.stdout}${r.stderr}`);
      assert.strictEqual(JSON.parse(r.stdout).sealed, false);
      assert.strictEqual(sha(sd), before, 'nothing sealed without the confirmation flag');
      continue;
    }
    assert.strictEqual(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.refused, j.code], [true, 'ENOT_OWNER'], name);
    assert.ok(/belongs to another Claude session/.test(j.message), `${name}: ${j.message}`);
    assert.strictEqual(sha(sd), before, `${name}: a refusal changes no byte`);
  }
});

test('X2 every write verb as a STRANGER with no --track (two foreign live tracks): refused, exit 1, nothing written', () => {
  const { sd, file } = liveTwo('x2');
  const before = sha(sd);
  for (const [name, a] of Object.entries(writeVerbs(sd, file, 'a'))) {
    const r = ops(sd, 'z', a[0], ['--session', '1', ...a.slice(1)]);
    assert.strictEqual(r.code, 1, `${name}: ${r.stdout}${r.stderr}`);
    const j = JSON.parse(r.stdout);
    assert.deepStrictEqual([j.refused, j.code], [true, 'ENOT_OWNER'], name);
    assert.ok(/track a \(aaaaaaaa\.\.\.\), track b \(bbbbbbbb\.\.\.\) of 0001 belong to another Claude session/.test(j.message), `${name}: ${j.message}`);
    assert.strictEqual(sha(sd), before, `${name}: nothing written`);
  }
});

test('X3 --track narrows to the caller\'s OWN track: the same verbs succeed with --track b as b, and only b\'s files change', () => {
  const { sd, file } = liveTwo('x3');
  const aBefore = sha(path.join(sd, 'session-0001')); const aJson = read(H.T.trackPaths(sd, '0001', 'a').jsonPath);
  for (const [name, a] of Object.entries(writeVerbs(sd, file, 'b'))) {
    if (name === 'close') continue;                     // closes b; asserted last
    if (name === 'punchlist carry-in') continue;        // a carry-in needs a prior session; covered by the e2e
    const r = ops(sd, 'b', a[0], ['--session', '1', '--track', 'b', ...a.slice(1)]);
    assert.strictEqual(r.code, 0, `${name}: ${r.stdout}${r.stderr}`);
  }
  assert.strictEqual(read(H.T.trackPaths(sd, '0001', 'a').jsonPath), aJson, 'track a never moved');
  assert.notStrictEqual(sha(path.join(sd, 'session-0001')), aBefore);
  const closed = ops(sd, 'b', 'close', ['--session', '1', '--track', 'b']);
  assert.strictEqual(closed.code, 0, closed.stderr);
  assert.ok(model.loadSession(H.T.trackPaths(sd, '0001', 'b').jsonPath).meta.closedAt, 'b closed');
  assert.strictEqual(model.loadSession(H.T.trackPaths(sd, '0001', 'a').jsonPath).meta.closedAt, null, 'a still open');
});

test('X4 per-track id minting: a mints 1.K (shown 1a.K once tracks exist), b mints 1b.K, c mints 1c.K; each counter is independent', () => {
  const sd = scratch('x4');
  for (const t of ['a', 'b', 'c']) H.putTrack(sd, '0001', t, { owner: ID[t], handoff: ho });
  const add = (w, n) => { for (let i = 0; i < n; i += 1) assert.strictEqual(ops(sd, w, 'punchlist', ['--session', '1', '--action', 'add', '--text', `${w}${i}`]).code, 0); };
  add('a', 2); add('b', 3); add('c', 1); add('a', 1);
  const ids = (t) => model.loadSession(H.T.trackPaths(sd, '0001', t).jsonPath).punchlist.map((i) => i.id);
  assert.deepStrictEqual(ids('a'), ['1.1', '1.2', '1.3']);
  assert.deepStrictEqual(ids('b'), ['1b.1', '1b.2', '1b.3']);
  assert.deepStrictEqual(ids('c'), ['1c.1']);
  const m = ops(sd, 'a', 'punchlist', ['--session', '1', '--action', 'add', '--text', 'next']);
  assert.ok(/added #1a\.4/.test(m.stderr), m.stderr);   // display form: a multi-track session shows track a as 1a.K
});

test('X5 the missing-session-id rule: no id + ONE unsealed track -> proceeds on it; TWO -> ETRACK_AMBIGUOUS asking for --track, nothing written; --track b proceeds', () => {
  const noId = (sd, args) => H.run(H.OPS, [...args.slice(0, 1), '--sessions-dir', sd, ...args.slice(1)], {});
  const one = scratch('x5a'); H.putTrack(one, '0001', 'a', { owner: ID.a, handoff: ho });
  const r1 = noId(one, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'continuity']);
  assert.strictEqual(r1.code, 0, r1.stdout + r1.stderr);
  assert.deepStrictEqual(model.loadSession(H.T.trackPaths(one, '0001', 'a').jsonPath).log.map((l) => l.text), ['continuity']);

  const { sd } = liveTwo('x5b');
  const before = sha(sd);
  const r2 = noId(sd, ['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'x']);
  assert.strictEqual(r2.code, 1);
  const j = JSON.parse(r2.stdout);
  assert.strictEqual(j.code, 'ETRACK_AMBIGUOUS');
  assert.ok(/pass --track <letter>/.test(j.message), j.message);
  assert.strictEqual(sha(sd), before, 'nothing written');
  const r3 = noId(sd, ['note', '--session', '1', '--track', 'b', '--log', '--status', 'NOTE', '--text', 'explicit']);
  assert.strictEqual(r3.code, 0, r3.stdout + r3.stderr);
  assert.deepStrictEqual(model.loadSession(H.T.trackPaths(sd, '0001', 'b').jsonPath).log.map((l) => l.text), ['explicit']);
});

// ── P: the late-sealing pickup rule, through boot-read ─────────────────────────────────────────────────────────
const blocks = (out) => {
  const res = []; let cur = null;
  for (const l of out.split('\n')) {
    const s = /^== PRIOR SESSION (\d{4}) /.exec(l); if (s) cur = s[1];
    const t = /^=== TRACK ([a-z]) · (.*?)(?: \d{4}-|;| ===)/.exec(l); if (t && cur) res.push(`${cur}${t[1]}`);
  }
  return res;
};
const bootAs = (sd, c) => { const r = H.run(H.BOOT_READ, ['--sessions-dir', sd], { id: F.id(c), pid: 77001 }); assert.strictEqual(r.code, 0, r.stderr); return r.stdout; };

test('P1 ordering S1 (a closes, 0124 opens, b and c close later): as the owner of 0125, a is picked up by 0124; b and c are STILL pending', () => {
  const sd = F.scratch('ph-p1-'); F.straggler(sd, 'S1');
  const before = sha(sd);
  assert.deepStrictEqual(blocks(bootAs(sd, 'e')), ['0124a', '0123b', '0123c']);
  assert.strictEqual(sha(sd), before, 'the pickup writes nothing');
});
test('P2 ordering S2 (c closes BEFORE 0124 opens; a was live when it opened): c picked up by 0124; a is picked up by 0125; b pending', () => {
  const sd = F.scratch('ph-p2-'); F.straggler(sd, 'S2');
  assert.deepStrictEqual(blocks(bootAs(sd, 'f')), ['0125a', '0124a', '0123b']);
});
test('P3 ordering S3 (marker-seals at 14:02:00, 0124 opens at 14:02:00): a TIE is not a pickup - both abandoned tracks are still shown', () => {
  const sd = F.scratch('ph-p3-'); F.straggler(sd, 'S3');
  const out = bootAs(sd, 'e');
  assert.deepStrictEqual(blocks(out), ['0124a', '0123a', '0123b']);
  assert.ok(/TRACK a · SEALED AS ABANDONED/.test(out) && /TRACK b · SEALED AS ABANDONED/.test(out));
});
test('P4 ordering "sealed late": b is live while 0124 opens; sealing b AFTER that does not hide it from 0125 (live -> sealed), and it is shown as abandoned', () => {
  const sd = F.scratch('ph-p4-');
  F.put(sd, F.mk('0123', 'a', { owner: F.id('a'), opened: F.at('09:00'), closed: F.at('14:02'), items: ['a item'] }));
  F.put(sd, F.mk('0123', 'b', { owner: F.id('b'), opened: F.at('09:05'), items: ['b item'] }));
  F.put(sd, F.mk('0124', 'a', { owner: F.id('d'), opened: F.at('14:10'), closed: F.at('14:50'), items: [] }));
  let out = bootAs(sd, 'e');
  assert.deepStrictEqual(blocks(out), ['0124a', '0123b'], 'a is picked up by 0124; the live b is never picked up');
  assert.ok(/TRACK b · STILL LIVE/.test(out));
  F.marker(sd, '0123', 'b', { at: F.at('15:00'), by: F.id('d'), reason: 'abandoned', owner: F.id('b') });
  out = bootAs(sd, 'e');
  assert.deepStrictEqual(blocks(out), ['0124a', '0123b'], '0124 opened (14:10) before the seal (15:00): still pending');
  assert.ok(/TRACK b · SEALED AS ABANDONED 2026-10-05T15:00:00-07:00/.test(out), out);
  assert.ok(!/STILL LIVE/.test(out));
  // once a session opens AFTER the late seal, b is finally picked up
  F.put(sd, F.mk('0125', 'a', { owner: F.id('f'), opened: F.at('15:30'), closed: F.at('15:40'), items: [] }));
  const last = bootAs(sd, 'g');
  assert.ok(/^== PRIOR SESSION 0125 /m.test(last) && !/PRIOR SESSION 012[34]/.test(last), `0125 opened after the seal: 0123a, 0123b and 0124a are settled; only 0125 remains\n${last}`);
});

// ── R: boot-read --track usage ─────────────────────────────────────────────────────────────────────────────────
test('R1 boot-read --track with NO value: end of args, and the next token starting with "-" -> usage error on stderr, exit 2, empty stdout, store untouched', () => {
  const sd = F.scratch('ph-r1-'); F.threeTrack(sd);
  const before = sha(sd);
  for (const args of [['--sessions-dir', sd, '--track'], ['--track', '--sessions-dir', sd], ['--sessions-dir', sd, '--track', '-x']]) {
    const r = H.run(H.BOOT_READ, args, { id: F.id('d'), pid: 77001 });
    assert.strictEqual(r.code, 2, `${args.join(' ')}: exit ${r.code} ${r.stdout}${r.stderr}`);
    assert.strictEqual(r.stdout, '', 'no pickup printed on a usage error');
    assert.ok(/--track/.test(r.stderr) && /(needs|requires|missing|usage)/i.test(r.stderr), r.stderr);
  }
  assert.strictEqual(sha(sd), before);
});
test('R2 boot-read --track a still narrows to track a, exits 0 and is read-only', () => {
  const sd = F.scratch('ph-r2-'); F.threeTrack(sd);
  const before = sha(sd);
  const r = H.run(H.BOOT_READ, ['--sessions-dir', sd, '--track', 'a'], { id: F.id('d'), pid: 77001 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual([...r.stdout.matchAll(/^=== TRACK ([a-z]) · /gm)].map((m) => m[1]), ['a']);
  assert.strictEqual(sha(sd), before);
});
test('R3 boot-read exits 0 with a corrupt track (the others still print)', () => {
  const sd = F.scratch('ph-r3-'); F.threeTrack(sd);
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-c.json'), '{ nope');
  const r = H.run(H.BOOT_READ, ['--sessions-dir', sd], { id: F.id('d'), pid: 77001 });
  assert.strictEqual(r.code, 0);
  assert.ok(/TRACK c · UNREADABLE/.test(r.stdout) && /TRACK a · SEALED/.test(r.stdout));
});

// ── M: migrate handoff.updatedAt ───────────────────────────────────────────────────────────────────────────────
test('M1 migrate with NO --now carries the source\'s REAL last-write time (not now); the record\'s updatedAt predates the run', () => {
  const FIX = path.join(__dirname, 'fixtures', 'legacy');
  for (const [name, want] of [['session-0021', '2026-09-19T21:44:19-07:00'], ['session-0007-clean', '2026-09-10T10:00:00-07:00'], ['session-0009-sidecar', '2026-09-11T18:30:00-07:00']]) {
    const out = scratch('m1');
    const r = H.run(MIGRATE, ['--in', path.join(FIX, name), '--out-dir', out], {});
    assert.strictEqual(r.code, 0, r.stderr + r.stdout);
    const num = name.match(/\d{4}/)[0];
    const rec = JSON.parse(read(path.join(out, `session-${num}`, `session-${num}.json`)));
    assert.strictEqual(rec.handoff.updatedAt, want, name);
    assert.ok(/handoff\.updatedAt = latest real source timestamp/.test(r.stdout + r.stderr), 'the output says which time was used');
  }
});
test('M2 migrate with an injected --now: --now still wins (this is why the golden is byte-identical)', () => {
  const FIX = path.join(__dirname, 'fixtures', 'legacy');
  const NOW = '2026-09-19T22:00:00-07:00';
  const out = scratch('m2');
  const r = H.run(MIGRATE, ['--in', path.join(FIX, 'session-0021'), '--out-dir', out, '--now', NOW], {});
  assert.strictEqual(r.code, 0, r.stderr);
  const rec = JSON.parse(read(path.join(out, 'session-0021', 'session-0021.json')));
  assert.strictEqual(rec.handoff.updatedAt, NOW);
  assert.strictEqual(read(path.join(out, 'session-0021', 'session-0021.json')), read(path.join(FIX, 'session-0021.expected.json')), 'byte-identical to the frozen golden');
  assert.ok(!/latest real source timestamp/.test(r.stdout + r.stderr));
});

// ── D: doctor de-dup ───────────────────────────────────────────────────────────────────────────────────────────
const dRun = (sd) => doctor.runDoctor({ sessionsDir: sd, strict: true, now: Date.parse('2026-10-08T12:00:00-07:00'), isAlive: () => true, startedAt: () => null, hostname: os.hostname() });
const jp = (sd, t) => H.T.trackPaths(sd, '0001', t).jsonPath;
const edit = (f, fn) => { const j = JSON.parse(read(f)); fn(j); fs.writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`); };
const issues = (rep, file) => (rep.results.find((r) => r.file.endsWith(file)) || { issues: [] }).issues;

test('D1 a claim collision where one claimant\'s name/meta disagree prints ONE TRACK-MISMATCH naming the collider, and NO DUPLICATE-TRACK on either row', () => {
  const sd = scratch('d1'); tt.build(sd, '0001');
  edit(jp(sd, 'b'), (j) => { j.meta.track = 'c'; });              // b claims c; c claims c
  const rep = dRun(sd);
  const b = issues(rep, 'session-0001-b.json'); const c = issues(rep, 'session-0001-c.json');
  const mm = b.filter((i) => i.code === 'TRACK-MISMATCH');
  assert.strictEqual(mm.length, 1, JSON.stringify(b));
  assert.ok(/collides with session-0001-c\.json/.test(mm[0].message) && /track c/.test(mm[0].message), mm[0].message);
  assert.ok(![...b, ...c].some((i) => i.code === 'DUPLICATE-TRACK'), JSON.stringify({ b, c }));
  assert.ok(!c.some((i) => i.code === 'TRACK-MISMATCH'), 'the honest claimant is not blamed');
  const all = JSON.stringify(rep);
  assert.strictEqual((all.match(/DUPLICATE-TRACK/g) || []).length, 0, 'one root cause, one finding: no DUPLICATE-TRACK anywhere');
});
test('D2 a collision with NO mismatched claimant still prints DUPLICATE-TRACK, and no TRACK-MISMATCH (the stray session-0001-a.json beside track a)', () => {
  const sd = scratch('d2'); tt.build(sd, '0001');
  fs.copyFileSync(jp(sd, 'a'), jp(sd, 'a').replace(/\.json$/, '-a.json'));
  const rep = dRun(sd);
  const dup = rep.notes.filter((n) => n.code === 'DUPLICATE-TRACK');
  assert.strictEqual(dup.length, 1, JSON.stringify(rep.notes));
  assert.ok(/session-0001-a\.json/.test(dup[0].message) && /both claim track a/.test(dup[0].message), dup[0].message);
  assert.ok(!JSON.stringify(rep.results).includes('TRACK-MISMATCH'), 'no mismatch anywhere');
  assert.notStrictEqual(rep.exitCode, 0, 'it is still a finding under --strict');
});
test('D3 mismatch + the stray copy of a: BOTH faults are reported (the de-dup swallows nothing genuine): TRACK-MISMATCH on b AND the stray-a DUPLICATE-TRACK note', () => {
  const sd = scratch('d3'); tt.build(sd, '0001');
  fs.copyFileSync(jp(sd, 'a'), jp(sd, 'a').replace(/\.json$/, '-a.json'));
  edit(jp(sd, 'b'), (j) => { j.meta.track = 'c'; });
  const rep = dRun(sd);
  assert.ok(issues(rep, 'session-0001-b.json').some((i) => i.code === 'TRACK-MISMATCH'));
  assert.ok(rep.notes.some((n) => n.code === 'DUPLICATE-TRACK' && /session-0001-a\.json/.test(n.message)), JSON.stringify(rep.notes));
  assert.ok(!issues(rep, 'session-0001-c.json').some((i) => i.code === 'DUPLICATE-TRACK'));
});
test('D4 two mismatched claimants of one track: each row gets exactly one TRACK-MISMATCH naming the OTHER claimant; no DUPLICATE-TRACK', () => {
  const sd = scratch('d4'); tt.build(sd, '0001');
  edit(jp(sd, 'a'), (j) => { j.meta.track = 'c'; });              // a and b both claim c, and so does c
  edit(jp(sd, 'b'), (j) => { j.meta.track = 'c'; });
  const rep = dRun(sd);
  const a = issues(rep, 'session-0001.json').filter((i) => i.code === 'TRACK-MISMATCH');
  const b = issues(rep, 'session-0001-b.json').filter((i) => i.code === 'TRACK-MISMATCH');
  assert.strictEqual(a.length, 1); assert.strictEqual(b.length, 1);
  assert.ok(/session-0001-b\.json/.test(a[0].message) && /session-0001-c\.json/.test(a[0].message), a[0].message);
  assert.ok(/session-0001\.json/.test(b[0].message) && /session-0001-c\.json/.test(b[0].message), b[0].message);
  assert.strictEqual((JSON.stringify(rep).match(/DUPLICATE-TRACK/g) || []).length, 0);
});
test('D5 CLI: the de-duplicated doctor prints one TRACK-MISMATCH line for the mismatched row and never the word DUPLICATE-TRACK; exit is non-zero', () => {
  const sd = scratch('d5'); tt.build(sd, '0001');
  edit(jp(sd, 'b'), (j) => { j.meta.track = 'c'; });
  const r = H.run(path.join(H.OPS, '..', 'tpm-session-doctor.js'), ['--sessions-dir', sd, '--strict'], {});
  assert.notStrictEqual(r.code, 0);
  assert.strictEqual((r.stdout.match(/TRACK-MISMATCH/g) || []).length, 1, r.stdout);
  assert.ok(!/DUPLICATE-TRACK/.test(r.stdout), r.stdout);
});

// ── U: unseal under a forced interleaving ──────────────────────────────────────────────────────────────────────
const live = new Set();
const jsonTmpPattern = (stem) => `${stem}\\.json\\.\\d+\\.[0-9a-z]+\\.tmp$`;
function spawnOps(dir, name, id, args, park) {
  const out = path.join(dir, `${name}.out`); const err = path.join(dir, `${name}.err`);
  const env = H.cleanEnv({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(process.pid) });
  if (park) Object.assign(env, barrier.env({ fn: 'renameSync', pattern: jsonTmpPattern(park.stem), nth: 1, when: 'before', ready: park.ready, wait: park.wait, maxMs: 15000 }));
  const child = spawn(process.execPath, [H.OPS, ...args], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 25000);
  let code = null;
  const exited = new Promise((resolve) => child.on('close', (c) => { clearTimeout(timer); live.delete(child); code = c; resolve(c); }));
  return { exited, exitedNow: () => code !== null, stderr: () => read(err), stdout: () => read(out) };
}
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}

test('U1 unseal takes the session lock: parked behind a lock holder (a track-a write parked in its critical section) it WAITS - marker still in place - and completes once the holder releases', async () => {
  const dir = scratch('u1'); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: ID.a, handoff: ho });
  H.putTrack(sd, '0001', 'b', { owner: ID.b, handoff: ho });
  const sealed = H.putMarker(sd, '0001', 'b');
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = spawnOps(dir, 'A', ID.a, ['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'holder'], { stem: 'session-0001', ready, wait });
  await waitFor(() => fs.existsSync(ready), 10000, 'the lock holder to park inside its critical section');
  const U = spawnOps(dir, 'U', ID.b, ['unseal', '--sessions-dir', sd, '--session', '1', '--track', 'b']);
  await sleep(600);
  assert.strictEqual(U.exitedNow(), false, 'unseal must be waiting for the lock held by the parked writer, not racing it');
  assert.strictEqual(fs.existsSync(sealed), true, 'the marker is still in place while the lock is held');
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 0, A.stderr());
  assert.strictEqual(await U.exited, 0, U.stderr());
  assert.strictEqual(fs.existsSync(sealed), false, 'the marker moved once the lock was free');
  assert.ok(fs.readdirSync(path.join(sd, 'session-0001')).some((f) => /^\.session-0001-b\.sealed\.unsealed-/.test(f)), 'the audit file exists');
  assert.deepStrictEqual(model.loadSession(H.T.trackPaths(sd, '0001', 'a').jsonPath).log.map((l) => l.text), ['holder'], 'the holder\'s write landed intact');
  assert.ok(/un-sealed/.test(U.stderr()), U.stderr());
});

// ── C: compose for a caller with NO Claude session id ─────────────────────────────────────────────────────────
function project(prefix, build) {
  const r = scratch(prefix);
  fs.mkdirSync(path.join(r, '.claude', 'claude-tpm'), { recursive: true });
  const sd = path.join(r, '.claude', 'claude-tpm', 'sessions');
  build(sd);
  return { r, sd };
}
const CFG = { session: { enabled: true, notes: { enabled: true } }, tasks: { enabled: false } };
const composeNoId = (p, mode) => compose.compose(mode, { config: CFG, projectRoot: p.r, sessionsDir: p.sd, env: {} });

test('C1 compose open for a caller with NO id on a three-track prior: the per-track blocks + the several-instances line are there; nothing is excluded as "yours"; no emergency', () => {
  const p = project('c1', (sd) => F.threeTrack(sd));
  const before = sha(p.sd);
  const r = composeNoId(p, 'open');
  assert.strictEqual(r.emergency, false);
  assert.ok(/SEVERAL Claude instances ran in parallel \(3 track blocks below\)/.test(r.text), r.text.slice(0, 600));
  for (const t of ['a', 'b', 'c']) assert.ok(r.text.includes(`=== TRACK ${t} · `), `track ${t}`);
  assert.ok(r.text.includes('== OPEN PUNCHLIST, ALL TRACKS ABOVE (4) =='));
  assert.strictEqual(sha(p.sd), before, 'compose is read-only');
});
test('C2 compose bare (auto) with NO id: one unsealed track -> continuity (save); two unsealed tracks -> the OPEN GATE, never save; empty store -> open', () => {
  const one = project('c2a', (sd) => F.threeTrack(sd));
  const auto1 = composeNoId(one, 'auto');
  assert.strictEqual(auto1.mode, 'save', auto1.text.slice(0, 200));
  const two = project('c2b', (sd) => { for (const l of ['a', 'b']) F.put(sd, F.mk('0001', l, { owner: F.id(l), opened: F.at(`08:0${l === 'a' ? 0 : 1}`), items: [`x${l}`] })); });
  const auto2 = composeNoId(two, 'auto');
  assert.strictEqual(auto2.mode, 'open', auto2.text.slice(0, 200));
  assert.ok(/state "foreign-open"/.test(auto2.text) && /Open gate/.test(auto2.text) && /Do NOT save or write/.test(auto2.text), auto2.text.slice(0, 500));
  const empty = project('c2c', () => {});
  assert.strictEqual(composeNoId(empty, 'auto').mode, 'open');
});
test('C3 an EXPLICIT save or close with NO id on two unsealed tracks is refused with a pointer to open; nothing composed from the ritual, nothing written', () => {
  const two = project('c3', (sd) => { for (const l of ['a', 'b']) F.put(sd, F.mk('0001', l, { owner: F.id(l), opened: F.at(`08:0${l === 'a' ? 0 : 1}`), items: [`x${l}`] })); });
  const before = sha(two.sd);
  for (const mode of ['save', 'close']) {
    const r = composeNoId(two, mode);
    assert.ok(/Cannot run `tpm-session (save|close)`/.test(r.text) && /Nothing was written/.test(r.text) && /compose --mode open/.test(r.text), r.text.slice(0, 400));
    assert.ok(!/FIXED 3-step ritual/.test(r.text), 'the save ritual is not composed');
  }
  assert.strictEqual(sha(two.sd), before);
});

(async () => {
  let passed = 0; let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 6).join('\n         ')}`); }
  }
  for (const c of live) { try { c.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  console.log(`\nsession-verbs-harden.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
