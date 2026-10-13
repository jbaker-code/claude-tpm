'use strict';
/**
 * session-lock-forced.test.js — phase 12 DoD H: the session lock under FORCED interleavings (the fs-barrier seam,
 * tools/tests/lib/fs-barrier.js), never real parallel load. Each case parks one real CLI child INSIDE its critical
 * section (right before the atomic rename of the track's JSON record, i.e. after it loaded and mutated), lets a peer
 * run, then releases it. At most 2 children are alive at once; every instance has an explicit CLAUDE_CODE_SESSION_ID
 * and CLAUDE_PID.
 *
 *   H-F1 two writers to ONE track cannot lose an update (B waits behind A; both entries land, seq 1 then 2).
 *   H-F2 MUTATION PROOF: the same scenario against a scratch copy of the tree whose mutate() is a plain call -> B's
 *        update IS lost. This is the evidence that the lock, not luck, prevents it.
 *   H-F6 writers to DIFFERENT sessions do not block each other (the per-folder lock location).
 *   H-F7 (rewritten F5, Q12-3/R3) a sealer takes the same lock: it BLOCKS behind a parked owner write, so after the seal
 *        returns no owner write can land after the marker; the owner's write is on disk, THEN the marker.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tools/session/tests/session-lock-forced.test.js
 */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const barrier = require('../../tests/lib/fs-barrier');
const H = require('./helpers/track-helpers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-lock-forced-'));
const live = new Set();
let seq = 0;
const scratch = (n) => { const d = path.join(root, `${n}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } };
const ho = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };
const trackJson = (sd, n, t) => H.T.trackPaths(sd, n, t).jsonPath;

// The pin point (calibrated by counting, see HANDOFF): the FIRST renameSync whose source is the track's temp JSON
// (`session-0001.json.<pid>.<rand>.tmp`) is persist's canonical write - after the op loaded and mutated the record.
// The lock's own renames (`.lock.new.*` -> `.lock`, release) have other names and never match.
const jsonTmpPattern = (stem) => `${stem}\\.json\\.\\d+\\.[0-9a-z]+\\.tmp$`;

/** Spawn `tpm-session-ops <args>` as instance `id`. `park` = { stem, ready, wait } parks it before its JSON rename. */
function run(script, dir, name, id, args, park) {
  const out = path.join(dir, `${name}.out`); const err = path.join(dir, `${name}.err`);
  const env = H.cleanEnv({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(process.pid) });
  if (park) Object.assign(env, barrier.env({ fn: 'renameSync', pattern: jsonTmpPattern(park.stem), nth: 1, when: 'before', ready: park.ready, wait: park.wait, maxMs: 15000 }));
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 25000);
  let code = null;
  const exited = new Promise((resolve) => child.on('close', (c) => { clearTimeout(timer); live.delete(child); code = c; resolve(c); }));
  return { exited, out, err, exitedNow: () => code !== null, stderr: () => read(err), stdout: () => read(out) };
}

const note = (sd, text, n) => ['note', '--sessions-dir', sd, '--session', n || '1', '--log', '--status', 'NOTE', '--text', text];

/**
 * The lost-update scenario against ops script `opsScript`: A is parked inside its critical section, B (the same
 * Claude instance - e.g. its own subagent) writes the same track meanwhile. Returns what happened.
 */
async function lostUpdateScenario(opsScript, tag) {
  const dir = scratch(tag); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: ho });
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = run(opsScript, dir, 'A', 'idOwner', note(sd, 'entry-A'), { stem: 'session-0001', ready, wait });
  await waitFor(() => fs.existsSync(ready), 10000, 'writer A to park inside its critical section');
  const B = run(opsScript, dir, 'B', 'idOwner', note(sd, 'entry-B'));
  await sleep(400);
  const bExitedWhileParked = B.exitedNow();
  const logWhileParked = JSON.parse(read(trackJson(sd, '0001', 'a'))).log.map((e) => e.text);
  fs.writeFileSync(wait, 'go');
  const [codeA, codeB] = [await A.exited, await B.exited];
  const rec = JSON.parse(read(trackJson(sd, '0001', 'a')));
  return { dir, sd, codeA, codeB, bExitedWhileParked, logWhileParked, log: rec.log, errs: [A.stderr(), B.stderr()] };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);
let passed = 0; let failed = 0;

test('H-F1 two writers to one track cannot lose an update: B WAITS behind the parked A; both entries land (seq 1, 2)', async () => {
  const r = await lostUpdateScenario(H.OPS, 'f1');
  assert.strictEqual(r.bExitedWhileParked, false, 'B must still be waiting for the lock while A is parked');
  assert.deepStrictEqual(r.logWhileParked, [], 'while A is parked neither entry is on disk');
  assert.deepStrictEqual([r.codeA, r.codeB], [0, 0], r.errs.join('|'));
  assert.deepStrictEqual(r.log.map((e) => [e.seq, e.text]), [[1, 'entry-A'], [2, 'entry-B']]);
  assert.deepStrictEqual(fs.readdirSync(path.join(r.sd, 'session-0001')).filter((f) => f.startsWith('.')), [], 'no .lock* left behind');
});

test('H-F2 MUTATION PROOF: with mutate() a plain call the SAME scenario loses B\'s update (so H-F1 passes because of the lock)', async () => {
  // a scratch copy of the product tree whose seam is the pre-phase-12 plain call
  const copy = scratch('f2-tree');
  const NEXT = path.resolve(__dirname, '..', '..', '..');
  const skip = /(^|[\\/])(tests|tmp|safe-to-delete)([\\/]|$)/;   // the product code only; the scenario's tools come from the real tree
  fs.cpSync(path.join(NEXT, 'tools'), path.join(copy, 'tools'), { recursive: true, filter: (src) => !skip.test(path.relative(path.join(NEXT, 'tools'), src)) });
  fs.copyFileSync(path.join(NEXT, 'package.json'), path.join(copy, 'package.json'));
  const target = path.join(copy, 'tools', 'session', 'tpm-session-ops.js');
  const src = read(target);
  const seam = 'function mutate(o, verb, fn) { return withSessionLock(o && o.sessionsDir, o && o.number, verb, fn); }';
  assert.ok(src.includes(seam), 'the mutation target text is present');
  fs.writeFileSync(target, src.replace(seam, 'function mutate(_o, _verb, fn) { return fn(); }'));
  const r = await lostUpdateScenario(target, 'f2');
  assert.strictEqual(r.bExitedWhileParked, true, 'unlocked, B runs straight through while A is parked');
  assert.deepStrictEqual([r.codeA, r.codeB], [0, 0], r.errs.join('|'));
  assert.deepStrictEqual(r.log.map((e) => e.text), ['entry-A'], 'A resumed and overwrote B: B\'s entry is LOST');
});

test('H-F6 writers to DIFFERENT sessions do not block each other: A parked in session 0001, B writes session 0002 and finishes', async () => {
  const dir = scratch('f6'); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: 'idOne', handoff: ho });
  H.putTrack(sd, '0002', 'a', { owner: 'idTwo', handoff: ho });
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = run(H.OPS, dir, 'A', 'idOne', note(sd, 'in-1', '1'), { stem: 'session-0001', ready, wait });
  await waitFor(() => fs.existsSync(ready), 10000, 'A to park');
  const B = run(H.OPS, dir, 'B', 'idTwo', note(sd, 'in-2', '2'));
  assert.strictEqual(await B.exited, 0, B.stderr());
  assert.strictEqual(A.exitedNow(), false, 'A is still parked');
  assert.strictEqual(JSON.parse(read(trackJson(sd, '0002', 'a'))).log.length, 1);
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 0, A.stderr());
});

test('H-F7 (the rewritten F5) a sealer takes the same lock: it BLOCKS behind a parked owner write; the owner\'s write lands, THEN the marker; a later owner write is refused', async () => {
  const dir = scratch('f7'); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: ho });
  const ready = path.join(dir, 'O.ready'); const wait = path.join(dir, 'O.wait');
  const O = run(H.OPS, dir, 'O', 'idOwner', note(sd, 'owner-write'), { stem: 'session-0001', ready, wait });
  await waitFor(() => fs.existsSync(ready), 10000, 'the owner to park inside its critical section');
  const S = run(H.OPS, dir, 'S', 'idSealer', ['close', '--sessions-dir', sd, '--session', '1', '--track', 'a', '--even-if-running']);
  await sleep(500);
  const sealPath = H.T.trackPaths(sd, '0001', 'a').sealedPath;
  assert.strictEqual(S.exitedNow(), false, 'the sealer must be waiting for the lock, not racing the owner');
  assert.strictEqual(fs.existsSync(sealPath), false, 'no marker while the owner\'s write is in flight');
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await O.exited, 0, O.stderr());
  assert.strictEqual(await S.exited, 0, S.stderr());
  const rec = JSON.parse(read(trackJson(sd, '0001', 'a')));
  assert.deepStrictEqual(rec.log.map((e) => e.text), ['owner-write'], 'the owner\'s write is on disk');
  assert.ok(fs.existsSync(sealPath), 'and then the marker landed');
  const again = run(H.OPS, dir, 'O2', 'idOwner', note(sd, 'too late'));
  assert.strictEqual(await again.exited, 1);
  assert.strictEqual(JSON.parse(again.stdout()).code, 'ETRACK_SEALED');
  assert.strictEqual(JSON.parse(read(trackJson(sd, '0001', 'a'))).log.length, 1, 'no owner write landed after the marker');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 6).join('\n         ')}`); }
  }
  for (const c of live) { try { c.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  console.log(`\nsession-lock-forced.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
