'use strict';
/**
 * session-lock-wrap.test.js — phase 12 DoD H (Q11): every mutating session verb runs its whole read-modify-write
 * under the shared tools/lib/ lock, at <sessionsDir>/session-NNNN/.lock. This file covers the wiring that needs no
 * interleaving: the unit, the seam, release on throw, stale-break, timeout, no residue, single-instance bytes, and
 * the static guard that every mutating op goes through the seam. The two-writers-cannot-lose-an-update proof is in
 * session-lock-forced.test.js. Hermetic; exits non-zero on failure.  Run: node tests/session-lock-wrap.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');
const os = require('os');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');
const baseline = require('./helpers/baseline-scenario');
const ops = require('../tpm-session-ops');
const sessionLock = require('../lib/session-lock');
const { nowIsoTz } = require('../../lib/timestamp');
const { T } = H;

const ho = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };
const opsCli = (args, o) => H.run(H.OPS, args, o);
const lockDir = (sd, n) => path.join(sd, `session-${n || '0001'}`, '.lock');
const dots = (sd, n) => fs.readdirSync(path.join(sd, `session-${n || '0001'}`)).filter((f) => f.startsWith('.'));
const one = (owner) => { const sd = tmpDir('lw-'); H.putTrack(sd, '0001', 'a', { owner: owner || 'idA', handoff: ho }); return sd; };

function plantLock(sd, over) {
  const d = lockDir(sd);
  fs.mkdirSync(d, { recursive: true });
  const owner = Object.assign({ schema: 1, nonce: `planted${Math.random().toString(16).slice(2, 8)}`, pid: process.pid, host: os.hostname(), at: nowIsoTz(), startedAt: null, version: null, verb: 'planted', claudePid: null, claudeSessionId: null }, over || {});
  fs.writeFileSync(path.join(d, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(d, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`);
  return d;
}

test('H-U1 lockDirFor is <sessionsDir>/session-NNNN/.lock; withSessionLock returns fn\'s value and holds the lock only while fn runs', () => {
  const sd = one();
  assert.strictEqual(sessionLock.lockDirFor(sd, 1), lockDir(sd));
  let seen;
  const v = sessionLock.withSessionLock(sd, '0001', 'unit', () => { seen = fs.existsSync(lockDir(sd)); return 42; });
  assert.strictEqual(v, 42);
  assert.strictEqual(seen, true, 'the lock exists while fn runs');
  assert.deepStrictEqual(dots(sd), [], 'and is gone afterwards');
});

test('H-U2 a missing sessionsDir/number, or a session folder that does not exist, runs fn UNLOCKED and creates nothing', () => {
  const sd = tmpDir('lw-u2-');
  for (const args of [[undefined, '0001'], [sd, undefined], [sd, ''], [sd, '0009']]) {
    assert.strictEqual(sessionLock.withSessionLock(args[0], args[1], 'unit', () => 'ran'), 'ran');
  }
  assert.deepStrictEqual(fs.readdirSync(sd), [], 'a typo\'d --session never creates a stray folder');
  const r = opsCli(['save', '--sessions-dir', sd, '--session', '9'], { id: 'idA' });
  assert.strictEqual(r.code, 1);
  assert.deepStrictEqual(fs.readdirSync(sd), []);
});

test('H-U3 mutate is the late-bound seam: a spy sees (o, verb, fn) for every mutating op', () => {
  const sd = one();
  const real = ops.mutate;
  const seen = [];
  ops.mutate = (o, verb, fn) => { seen.push(verb); return real(o, verb, fn); };
  try {
    const o = { sessionsDir: sd, number: '0001', identity: H.id('idA') };
    ops.opSave(o);
    ops.opNote(Object.assign({ type: 'log', status: 'NOTE', text: 'x' }, o));
    ops.opPunchlist(Object.assign({ action: 'add', text: 'x' }, o));
    const txt = path.join(sd, 'in.txt'); fs.writeFileSync(txt, 'line\n');
    ops.opImportHandoff(Object.assign({ txtFile: txt, next: 'n' }, o));
    ops.opImportLog(Object.assign({ txtFile: txt }, o));
    ops.opImportPunchlist(Object.assign({ file: txt }, o));
    ops.opClose(o);
  } finally { ops.mutate = real; }
  assert.deepStrictEqual(seen, ['save', 'note', 'punchlist', 'import-handoff', 'import-log', 'import-punchlist', 'close']);
});

test('H-F3 released on throw: a close refused by the close guard leaves no .lock, and the next verb proceeds at once', () => {
  const sd = tmpDir('lw-f3-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA' });     // no handoff, no punchlist: the close guard refuses
  const refused = opsCli(['close', '--sessions-dir', sd, '--session', '1'], { id: 'idA', pid: 4101 });
  assert.strictEqual(refused.code, 1);
  assert.ok(/refusing to close session/.test(refused.stderr), refused.stderr);
  assert.deepStrictEqual(dots(sd), [], 'no lock left behind');
  const t0 = Date.now();
  const ok = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'next'], { id: 'idA', pid: 4101 });
  assert.strictEqual(ok.code, 0, ok.stderr);
  assert.ok(Date.now() - t0 < 5000);
  // and in-process: a throwing fn releases
  assert.throws(() => sessionLock.withSessionLock(sd, '0001', 'unit', () => { throw new Error('boom'); }), /boom/);
  assert.deepStrictEqual(dots(sd), []);
});

test('H-F4 stale-break: a lock whose holder is dead on this host is broken after the confirm poll; the 4-line block is on stderr; the verb succeeds', () => {
  const sd = one();
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  plantLock(sd, { pid: dead });
  const r = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'after the break'], { id: 'idA', pid: 4101 });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(/breaking a stale lock/.test(r.stderr), r.stderr);
  assert.ok(/tpm-session: /.test(r.stderr), 'the wiring labels its lines tpm-session');
  assert.strictEqual(JSON.parse(fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8')).log.length, 1);
  assert.deepStrictEqual(dots(sd).filter((f) => f === '.lock' || f.startsWith('.lock.new')), [], 'the lock itself is released');
});

test('H-F5 timeout: a held, live, fresh lock + TPM_LOCK_WAIT_MS=300 -> exit 1 within ~1 s with the ELOCK_TIMEOUT text; nothing written', () => {
  const sd = one();
  plantLock(sd);                                          // the holder is this very (live) test process
  const before = TT.shas(path.join(sd, 'session-0001'));
  const t0 = Date.now();
  const r = opsCli(['note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'never'], { id: 'idA', pid: 4101, env: { TPM_LOCK_WAIT_MS: '300' } });
  assert.strictEqual(r.code, 1);
  assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  assert.ok(/^tpm-session-ops: tpm-session: gave up waiting/.test(r.stderr) || /gave up waiting/.test(r.stderr), r.stderr);
  assert.strictEqual(r.stdout, '', 'a LockError is not a TrackError: no JSON on stdout');
  assert.deepStrictEqual(TT.shas(path.join(sd, 'session-0001')), before, 'nothing was written (the planted lock itself is untouched)');
});

test('H-P1 no .lock* residue after any of the seven verbs, a refusal, or a seal/unseal', () => {
  const sd = tmpDir('lw-p1-'); TT.build(sd, '0001');
  const C = { id: TT.IDS.c, pid: 4103 };
  const txt = path.join(sd, 'in.txt'); fs.writeFileSync(txt, 'line\n');
  const calls = [
    ['save'], ['note', '--log', '--status', 'NOTE', '--text', 'x'], ['punchlist', '--action', 'add', '--text', 't', '--slug', 'tt'],
    ['punchlist', '--action', 'close', '--item', '1b.1'],                                            // refused (ECROSS_TRACK)
    ['import-handoff', '--txt-file', txt, '--next', 'n'], ['import-log', '--txt-file', txt], ['import-punchlist', '--txt-file', txt], ['close'],
  ];
  for (const c of calls) {
    opsCli([c[0], '--sessions-dir', sd, '--session', '1', ...c.slice(1)], C);
    assert.deepStrictEqual(dots(sd), [], `after ${c.join(' ')}`);
  }
  // the abandoned seal and the unseal go through the lock too and leave nothing behind
  H.putTrack(sd, '0001', 'd', { owner: 'idD', handoff: ho });
  opsCli(['close', '--sessions-dir', sd, '--session', '1', '--track', 'd', '--even-if-running'], C);
  assert.deepStrictEqual(dots(sd), []);
  opsCli(['unseal', '--sessions-dir', sd, '--session', '1', '--track', 'd'], { id: 'idD', pid: 4104 });
  assert.deepStrictEqual(dots(sd).filter((f) => f.startsWith('.lock')), []);
});

test('H-P2 single-instance behaviour unchanged: the baseline transcript (stdout, stderr, exit of every verb) is byte-identical', () => {
  assert.strictEqual(baseline.transcript(), fs.readFileSync(path.join(__dirname, 'golden', 'single-track-baseline.txt'), 'utf8'));
});

test('H-P4 a loop of 100 saves finishes (informational timing, generous bound); no lock written to stderr when uncontended', () => {
  const sd = one();
  const t0 = Date.now();
  for (let i = 0; i < 100; i += 1) ops.opSave({ sessionsDir: sd, number: '0001', identity: H.id('idA') });
  const ms = Date.now() - t0;
  console.log(`         (100 saves in ${ms} ms)`);
  assert.ok(ms < 60000);
  assert.deepStrictEqual(dots(sd), []);
});

test('H-A adopt takes the session lock and re-reads the record under it: adopting while another writer holds the lock waits (then times out here)', () => {
  const sd = tmpDir('lw-a-');
  H.putTrack(sd, '0001', 'a', { owner: 'idOld', handoff: ho, ident: { claudePid: 999999 } });
  plantLock(sd);
  const before = TT.shas(path.join(sd, 'session-0001'));
  const r = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--adopt', 'a'], { id: 'idNew', pid: 4105, env: { TPM_LOCK_WAIT_MS: '300' } });
  assert.notStrictEqual(r.code, 0, 'adopt could not take the lock');
  assert.ok(/gave up waiting|lock/i.test(r.stderr + r.stdout), r.stderr + r.stdout);
  assert.deepStrictEqual(TT.shas(path.join(sd, 'session-0001')), before);
  fs.rmSync(lockDir(sd), { recursive: true, force: true });
  const ok = H.run(H.CURRENT, ['--sessions-dir', sd, '--open', '--adopt', 'a'], { id: 'idNew', pid: 4105 });
  assert.strictEqual(ok.code, 0, ok.stderr + ok.stdout);
  assert.strictEqual(JSON.parse(fs.readFileSync(T.trackPaths(sd, '0001', 'a').jsonPath, 'utf8')).meta.claudeSessionId, 'idNew');
  assert.deepStrictEqual(dots(sd), []);
});

test('H-G static guard: every runMutating( caller in ops.js is in the known list, and each op named there routes through the seam', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tpm-session-ops.js'), 'utf8');
  const callers = [...src.matchAll(/runMutating\(o, '([a-z-]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(callers, ['close', 'import-handoff', 'import-log', 'import-punchlist', 'note', 'punchlist', 'save', 'seal-abandoned', 'unseal'].sort());
  // every op* that writes a record calls ownTrack inside its locked body (the one "which track is mine")
  const own = [...src.matchAll(/ownTrack\(o\)/g)].length;
  assert.ok(own >= 8, `ownTrack(o) call sites: ${own}`);
  // and nothing else in the ops file opens a record for write outside a runMutating body
  assert.strictEqual([...src.matchAll(/loadForWrite\(/g)].length, 1 + 7, 'loadForWrite: its definition + the seven locked bodies');
});

done('session-lock-wrap.test');
