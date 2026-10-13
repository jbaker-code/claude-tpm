'use strict';
/**
 * tracks-forced-order.test.js — DoD A (phase 10): the tracks store's CLAIM guarantees under FORCED
 * interleavings (the fs-barrier seam, tools/tests/lib/fs-barrier.js), never real parallel load. Each case
 * parks one real CLI child at a chosen fs call, lets a peer run to completion, then releases it. At most 2
 * children are alive at once. Every simulated Claude instance gets an explicit CLAUDE_CODE_SESSION_ID and
 * CLAUDE_PID (the ambient ones are stripped by H.cleanEnv).
 *
 *   F1 two opens forced to the SAME NUMBER: the parked loser is refused (exit 3) naming the winner; one session folder.
 *   F2 two `--parallel` claims forced to the SAME LETTER: the parked one's link hits EEXIST and it takes the NEXT letter;
 *      the two instances end on different letters and neither record is overwritten.
 *   F3 second instance REFUSED, not joined: while A sits mid-claim, a later B never ends up inside A's track; the loser's
 *      refusal writes nothing (the store is byte-identical before/after the refused call).
 *   F4 a loser that was refused can then choose --parallel and gets a track of its own (the refusal is recoverable).
 *   F5 a sealed track's owner is refused on write in the load-to-write window (a marker lands while its save is parked).
 *      PHASE 12 (Q11/R3): seal and unseal now run under the session lock, so through the CLI the sealer WAITS for a parked
 *      owner write instead of landing in that window (that behaviour is session-lock-forced.test.js H-F7). F5 therefore
 *      lands the marker through the LIBRARY (T.sealByMarker, no lock): it still proves persist()'s own marker re-check
 *      (the defence in depth, mutation M10) against a marker that arrives by any path that does not take the lock.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tools/session/tests/tracks-forced-order.test.js
 */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const barrier = require('../../tests/lib/fs-barrier');
const H = require('./helpers/track-helpers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-forced-order-'));
const live = new Set();
let seq = 0;
const scratch = (n) => { const d = path.join(root, `${n}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } };
/** name -> contents of every file under dir (recursive); used to prove a refused call wrote NOTHING. */
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  }(dir));
  return out;
}

/** Spawn `current <args>` as Claude instance `id` (pid `pid`); optional barrier env. */
function cur(dir, sd, name, id, args, barrierOpts) {
  const out = path.join(dir, `${name}.out`); const err = path.join(dir, `${name}.err`);
  const env = H.cleanEnv({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(process.pid), TPM_SESSION_CLAIM_GRACE_MS: '300' });
  if (barrierOpts) Object.assign(env, barrier.env(barrierOpts));
  const child = spawn(process.execPath, [H.CURRENT, '--sessions-dir', sd, ...args], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 25000);
  const exited = new Promise((resolve) => child.on('close', (code) => { clearTimeout(timer); live.delete(child); resolve(code); }));
  return { exited, out, err, json: () => JSON.parse(read(out)) };
}
const trackFile = (sd, n, t) => path.join(sd, `session-${n}`, t === 'a' ? `session-${n}.json` : `session-${n}-${t}.json`);

const cases = []; let passed = 0; let failed = 0;
const test = (name, fn) => cases.push([name, fn]);

test('F1 two opens forced to the same NUMBER: the parked loser is refused naming the winner; one folder, one record', async () => {
  const dir = scratch('f1'); const sd = path.join(dir, 'sessions');
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = cur(dir, sd, 'A', 'idA', ['--open'], { fn: 'mkdirSync', pattern: 'session-0001$', when: 'before', ready, wait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(ready), 10000, 'A to park before mkdir(session-0001)');
  const B = cur(dir, sd, 'B', 'idB', ['--open']);
  assert.strictEqual(await B.exited, 0, read(B.err));
  assert.deepStrictEqual([B.json().number, B.json().track, B.json().isNew], ['0001', 'a', true]);
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 3, `A must be REFUSED, stderr: ${read(A.err)}`);
  assert.strictEqual(A.json().refused, true);
  assert.deepStrictEqual(A.json().tracks.map((t) => [t.number, t.track]), [['0001', 'a']]);
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'a'))).meta.claudeSessionId, 'idB', 'the winner\'s record is intact');
  assert.deepStrictEqual(fs.readdirSync(sd).filter((n) => /^session-/.test(n)), ['session-0001'], 'no second session folder');
  assert.deepStrictEqual(fs.readdirSync(path.join(sd, 'session-0001')).filter((n) => /session-0001-/.test(n)), [], 'no second track was minted either');
});

test('F2 two --parallel claims forced to the same LETTER: the parked one falls through to the next letter; both survive', async () => {
  const dir = scratch('f2'); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: 'idX' });
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  // A parks right before it publishes track b (link of its prepared session-0001-b.json temp).
  const A = cur(dir, sd, 'A', 'idA', ['--open', '--parallel'], { fn: 'linkSync', pattern: '\\.session-0001-b\\.json\\.claim\\.[^/]*\\.tmp$', when: 'before', ready, wait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(ready), 10000, 'A to park before linking track b');
  assert.ok(!fs.existsSync(trackFile(sd, '0001', 'b')), 'b is not yet published (A is parked)');
  const B = cur(dir, sd, 'B', 'idB', ['--open', '--parallel']);
  assert.strictEqual(await B.exited, 0, read(B.err));
  assert.strictEqual(B.json().track, 'b', 'B won letter b');
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 0, `A must succeed on the NEXT letter: ${read(A.err)}`);
  assert.strictEqual(A.json().track, 'c', 'A\'s link hit EEXIST on b and took c');
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'b'))).meta.claudeSessionId, 'idB', 'b still belongs to B (never overwritten)');
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'c'))).meta.claudeSessionId, 'idA');
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'a'))).meta.claudeSessionId, 'idX', 'the original track is untouched');
  assert.deepStrictEqual(fs.readdirSync(path.join(sd, 'session-0001')).filter((n) => n.endsWith('.tmp')), [], 'no prepared temp left behind');
});

test('F3 a second instance is REFUSED, never joined: the refusal writes nothing and the foreign record keeps its owner', async () => {
  const dir = scratch('f3'); const sd = path.join(dir, 'sessions');
  const A = cur(dir, sd, 'A', 'idA', ['--open']);
  assert.strictEqual(await A.exited, 0, read(A.err));
  const before = snapshot(sd);
  const B = cur(dir, sd, 'B', 'idB', ['--open']);
  assert.strictEqual(await B.exited, 3, `B must be refused: ${read(B.err)}`);
  assert.strictEqual(B.json().refused, true);
  assert.strictEqual(B.json().code, 'ESESSION_FOREIGN_TRACK');
  assert.deepStrictEqual(snapshot(sd), before, 'a refused open writes NOTHING (records, md, hint all byte-identical)');
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'a'))).meta.claudeSessionId, 'idA', 'A still owns track a');
  // and B did not silently land in A's track: B\'s own --state is the third state, not "open"
  const st = cur(dir, sd, 'Bs', 'idB', ['--state']);
  assert.strictEqual(await st.exited, 0, read(st.err));
  assert.strictEqual(st.json().state, 'foreign-open');
});

test('F4 the refusal is recoverable: after it, --parallel gives the refused instance a track of its own beside the original', async () => {
  const dir = scratch('f4'); const sd = path.join(dir, 'sessions');
  assert.strictEqual(await cur(dir, sd, 'A', 'idA', ['--open']).exited, 0);
  assert.strictEqual(await cur(dir, sd, 'B1', 'idB', ['--open']).exited, 3);
  const B = cur(dir, sd, 'B2', 'idB', ['--open', '--parallel']);
  assert.strictEqual(await B.exited, 0, read(B.err));
  assert.deepStrictEqual([B.json().number, B.json().track, B.json().gate], ['0001', 'b', 'parallel']);
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'a'))).meta.claudeSessionId, 'idA');
  assert.strictEqual(JSON.parse(read(trackFile(sd, '0001', 'b'))).meta.claudeSessionId, 'idB');
});

test('F5 (persist re-check, defence in depth) a sealed track\'s owner is refused on write even in the load-to-write window: a marker lands while its save is parked; it writes nothing', async () => {
  const dir = scratch('f5'); const sd = path.join(dir, 'sessions');
  H.putTrack(sd, '0001', 'a', { owner: 'idOwner', handoff: { where: 'w', next: 'n', in_flight: [], must_not_redo: [] } });
  const ready = path.join(dir, 'O.ready'); const wait = path.join(dir, 'O.wait');
  // persist()'s own marker check is the LAST existsSync(<track>.sealed) of a save: park right before it.
  const env = H.cleanEnv({ CLAUDE_CODE_SESSION_ID: 'idOwner', CLAUDE_PID: String(process.pid) });
  Object.assign(env, barrier.env({ fn: 'existsSync', pattern: 'session-0001\\.sealed$', nth: 3, when: 'before', ready, wait, maxMs: 15000 }));
  const out = path.join(dir, 'O.out'); const err = path.join(dir, 'O.err');
  const child = spawn(process.execPath, [H.OPS, 'save', '--sessions-dir', sd, '--session', '1'], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  live.add(child);
  const exited = new Promise((resolve) => child.on('close', (code) => { live.delete(child); resolve(code); }));
  await waitFor(() => fs.existsSync(ready), 10000, 'the owner to park before its persist-time marker check');
  const jsonBefore = read(trackFile(sd, '0001', 'a'));
  H.T.sealByMarker(sd, '0001', 'a', { by: H.id('idZ'), confirm: true });          // the sealer lands while the owner is parked
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await exited, 1, `the parked save must refuse: ${read(err)}`);
  assert.strictEqual(JSON.parse(read(out)).code, 'ETRACK_SEALED');
  assert.strictEqual(read(trackFile(sd, '0001', 'a')), jsonBefore, 'the record was not rewritten');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 5).join('\n         ')}`); }
  }
  for (const c of live) { try { c.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  console.log(`\ntracks-forced-order.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
