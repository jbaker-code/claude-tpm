'use strict';
/**
 * session-ops-tracks.test.js — the ops side of the tracks store: opOpen never overwrites, write verbs act
 * only on MY track (conservative ownership), `close` touches only its own track's files, every mutating op
 * goes through the single mutate() seam. DoD rows A, C, E, G. Hermetic; exits non-zero on failure.
 * Run: node tests/session-ops-tracks.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const crypto = require('crypto');
const H = require('./helpers/track-helpers');
const ops = require('../tpm-session-ops');
const { T, model } = H;

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const opsCli = (args, o) => H.run(H.OPS, args, o);

test('T-P1 opOpen never overwrites: an existing record of the SAME owner is returned unchanged ("nothing done")', () => {
  const sd = tmpDir('ops-p1-');
  const idn = H.id('sid-1');
  ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-1', identity: idn });
  const jp = ops.sessionPaths(sd, '0001').jsonPath;
  ops.opNote({ sessionsDir: sd, number: '0001', identity: idn, type: 'log', status: 'NOTE', text: 'precious' });
  const before = fs.readFileSync(jp, 'utf8');
  const again = ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-1', identity: idn });
  assert.strictEqual(fs.readFileSync(jp, 'utf8'), before, 'the second open did not destroy the notes');
  assert.strictEqual(again.log.length, 1);
});

test('T-P2 opOpen over ANOTHER session\'s record refuses (ESESSION_EXISTS) and leaves it byte-identical', () => {
  const sd = tmpDir('ops-p2-');
  ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-owner', identity: H.id('sid-owner') });
  const jp = ops.sessionPaths(sd, '0001').jsonPath;
  const before = fs.readFileSync(jp, 'utf8');
  assert.throws(() => ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'sid-intruder', identity: H.id('sid-intruder') }),
    (e) => e.code === 'ESESSION_EXISTS' && /belongs to another session/.test(e.message));
  assert.strictEqual(fs.readFileSync(jp, 'utf8'), before);
  const r = opsCli(['open', '--sessions-dir', sd, '--session', '1', '--session-id', 'sid-intruder'], {});
  assert.strictEqual(r.code, 1);
  assert.ok(/belongs to another session/.test(r.stderr), r.stderr);
});

test('T-P3 opOpen with --track b claims session-NNNN-b.json beside track a; a twice -> idempotent', () => {
  const sd = tmpDir('ops-p3-');
  ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'idA', identity: H.id('idA') });
  const b = ops.opOpen({ sessionsDir: sd, number: '0001', track: 'b', sessionId: 'idB', identity: H.id('idB') });
  assert.strictEqual(b.meta.track, 'b');
  assert.deepStrictEqual(fs.readdirSync(path.join(sd, 'session-0001')).sort(), ['session-0001-b.json', 'session-0001-b.md', 'session-0001.json', 'session-0001.md']);
});

test('T-P4 write verbs (CLI) act on MY track and refuse a track another session owns (ENOT_OWNER, exit 1, file untouched)', () => {
  const sd = tmpDir('ops-p4-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  const a = T.trackPaths(sd, '0001', 'a').jsonPath; const b = T.trackPaths(sd, '0001', 'b').jsonPath;
  const ok = opsCli(['note', '--sessions-dir', sd, '--session', '0001', '--log', '--status', 'NOTE', '--text', 'from B'], { id: 'idB' });
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(b, 'utf8')).log.length, 1, 'B wrote its OWN track');
  const aBefore = sha(a);
  assert.strictEqual(JSON.parse(fs.readFileSync(a, 'utf8')).log.length, 0);
  const bad = opsCli(['note', '--sessions-dir', sd, '--session', '0001', '--track', 'a', '--log', '--status', 'NOTE', '--text', 'trespass'], { id: 'idB' });
  assert.strictEqual(bad.code, 1);
  assert.ok(/belongs to another Claude session/.test(bad.stderr), bad.stderr);
  const stranger = opsCli(['note', '--sessions-dir', sd, '--session', '0001', '--log', '--status', 'NOTE', '--text', 'x'], { id: 'idC' });
  assert.strictEqual(stranger.code, 1);
  assert.ok(/belong to another Claude session/.test(stranger.stderr) && /tpm session current --open/.test(stranger.stderr), stranger.stderr);
  assert.strictEqual(sha(a), aBefore, 'track a never changed');
});

test('T-P5 id unreadable: one unsealed track -> written; two -> ETRACK_AMBIGUOUS asks for --track', () => {
  const sd = tmpDir('ops-p5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  assert.strictEqual(opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'x'], {}).code, 0);
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  const r = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'x'], {});
  assert.strictEqual(r.code, 1);
  assert.ok(/pass --track <letter>/.test(r.stderr), r.stderr);
  const pick = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--track', 'b', '--log', '--status', 'NOTE', '--text', 'y'], {});
  assert.strictEqual(pick.code, 0, pick.stderr);
});

test('T-P6 close seals ONLY its own track: every other file in the folder is byte-identical, the hint stays open', () => {
  const sd = tmpDir('ops-p6-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: { where: 'w', next: 'n' } });
  H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  const idA = H.id('idA');
  ops.opPunchlist({ sessionsDir: sd, number: '0001', track: 'a', identity: idA, action: 'add', text: 'p' });
  T.writeHint(sd);
  const folder = path.join(sd, 'session-0001');
  const others = ['session-0001-b.json', 'session-0001-b.md'].map((n) => [n, sha(path.join(folder, n))]);
  const r = opsCli(['close', '--sessions-dir', sd, '--session', '1'], { id: 'idA' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(JSON.parse(fs.readFileSync(path.join(folder, 'session-0001.json'), 'utf8')).meta.closedAt, 'a is closed');
  for (const [n, h] of others) assert.strictEqual(sha(path.join(folder, n)), h, `${n} untouched`);
  assert.strictEqual(JSON.parse(fs.readFileSync(T.hintPath(sd), 'utf8')).closedAt, null);
});

test('T-P7 EVERY mutating op goes through the single mutate() seam (spy), with its verb name', () => {
  const sd = tmpDir('ops-p7-');
  const idn = H.id('idS');
  const seen = [];
  const real = ops.mutate;
  ops.mutate = (o, verb, fn) => { seen.push(verb); return real(o, verb, fn); };
  const f = path.join(tmpDir('ops-p7f-'), 'in.txt'); fs.writeFileSync(f, 'line one\n');
  try {
    ops.opOpen({ sessionsDir: sd, number: '0001', sessionId: 'idS', identity: idn });
    const base = { sessionsDir: sd, number: '0001', identity: idn };
    ops.opSave(base);
    ops.opNote(Object.assign({ type: 'log', status: 'NOTE', text: 'x' }, base));
    ops.opPunchlist(Object.assign({ action: 'add', text: 'p' }, base));
    ops.opImportHandoff(Object.assign({ txtFile: f, next: 'n' }, base));
    ops.opImportLog(Object.assign({ txtFile: f }, base));
    ops.opImportPunchlist(Object.assign({ file: f }, base));
    ops.opClose(base);
  } finally { ops.mutate = real; }
  assert.deepStrictEqual(seen, ['save', 'note', 'punchlist', 'import-handoff', 'import-log', 'import-punchlist', 'close']);
});

test('T-P8 lone-instance flow (DoD G): open -> save -> note -> punchlist -> handoff -> close -> open again, via the CLIs', () => {
  const sd = tmpDir('ops-p8-');
  const me = { id: 'idLone' };
  const cur = (a) => H.run(H.CURRENT, ['--sessions-dir', sd, ...a], me);
  const o1 = cur(['--open']); assert.strictEqual(o1.code, 0, o1.stderr);
  assert.strictEqual(JSON.parse(o1.stdout).number, '0001');
  const f = path.join(tmpDir('ops-p8f-'), 'h.txt'); fs.writeFileSync(f, 'where we are');
  const step = (args) => { const r = opsCli([...args, '--sessions-dir', sd], me); assert.strictEqual(r.code, 0, `${args[0]}: ${r.stderr}`); return r; };
  step(['save', '--session', '0001']);
  step(['note', '--session', '0001', '--log', '--status', 'NOTE', '--text', 'hello']);
  step(['punchlist', '--session', '0001', '--action', 'add', '--text', 'an item']);
  step(['import-handoff', '--session', '0001', '--txt-file', f, '--next', 'go on']);
  step(['close', '--session', '0001']);
  const seal = cur(['--seal']); assert.strictEqual(seal.code, 0, seal.stderr);
  assert.strictEqual(JSON.parse(seal.stdout).hintClosed, true);
  assert.strictEqual(JSON.parse(cur(['--state']).stdout).state, 'not-opened');
  const o2 = cur(['--open']);
  assert.deepStrictEqual([JSON.parse(o2.stdout).number, JSON.parse(o2.stdout).isNew], ['0002', true]);
  const rec = model.loadSession(T.trackPaths(sd, '0001', 'a').jsonPath);
  assert.ok(rec.meta.closedAt && rec.meta.claudeSessionId === 'idLone' && rec.meta.track === 'a');
});

done('session-ops-tracks.test');
