'use strict';
/**
 * session-claim-interleave.test.js — DoD B / F: the atomic claims under FORCED interleavings (the
 * fs-barrier seam, tools/tests/lib/fs-barrier.js), not real parallel load. Each case parks one real
 * `tpm-session-current.js --open` child at a chosen fs call, lets another run, then releases it, and asserts
 * exactly one winner and a named refusal (exit 3) for the loser. At most 2 children alive at once.
 *
 *   I1 two opens, one NUMBER: A parked before mkdir(session-0001); B opens fully; A's mkdir -> EEXIST -> re-gate -> refused.
 *   I2 a stalled creator + a letter race: B parked before its mkdir; A mkdirs then parks before its link; B (EEXIST,
 *      no record, grace elapses) claims track a itself; A's link -> EEXIST -> re-gate -> refused naming B's track.
 *   I3 no partial record: while A is parked before its link, a polling reader sees NO session-0001.json (only the
 *      dot-temp); after release the record is complete and parseable (link of a finished temp, never `wx`).
 *   I4 a same-id double open is not a race: it resumes. (The "link is the claim" mutation proof is in HANDOFF.)
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tests/session-claim-interleave.test.js
 */
const { spawn } = require('child_process');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const barrier = require('../../tests/lib/fs-barrier');
const H = require('./helpers/track-helpers');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-claim-il-'));
const live = new Set();
let seq = 0;
const scratch = (n) => { const d = path.join(root, `${n}-${seq++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`); await sleep(15); }
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } };

/** Spawn `current --open` as Claude instance `id`; optional barrier env. */
function open(dir, sd, name, id, barrierOpts, extraEnv) {
  const out = path.join(dir, `${name}.out`); const err = path.join(dir, `${name}.err`);
  const env = H.cleanEnv(Object.assign({ CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: String(process.pid), TPM_SESSION_CLAIM_GRACE_MS: '300' }, extraEnv || {}));
  if (barrierOpts) Object.assign(env, barrier.env(barrierOpts));
  const child = spawn(process.execPath, [H.CURRENT, '--sessions-dir', sd, '--open'], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 25000);
  const exited = new Promise((resolve) => child.on('close', (code) => { clearTimeout(timer); live.delete(child); resolve(code); }));
  return { exited, out, err, json: () => JSON.parse(read(out)) };
}

const cases = []; let passed = 0; let failed = 0;
const test = (name, fn) => cases.push([name, fn]);

test('I1 two opens, one NUMBER: the parked loser is refused naming the winner; exactly one 0001/a exists', async () => {
  const dir = scratch('i1'); const sd = path.join(dir, 'sessions');
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = open(dir, sd, 'A', 'idA', { fn: 'mkdirSync', pattern: 'session-0001$', when: 'before', ready, wait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(ready), 10000, 'A to park before mkdir');
  const B = open(dir, sd, 'B', 'idB');
  assert.strictEqual(await B.exited, 0, read(B.err));
  assert.deepStrictEqual([B.json().number, B.json().track], ['0001', 'a']);
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 3, `A must be REFUSED, got stderr: ${read(A.err)}`);
  assert.ok(/track a of 0001|session 0001 has an unsealed track/.test(read(A.err)), read(A.err));
  const refusal = A.json();
  assert.strictEqual(refusal.refused, true);
  assert.strictEqual(refusal.code, 'ESESSION_FOREIGN_TRACK');
  assert.deepStrictEqual(refusal.tracks.map((t) => [t.number, t.track]), [['0001', 'a']]);
  const rec = JSON.parse(read(path.join(sd, 'session-0001', 'session-0001.json')));
  assert.strictEqual(rec.meta.claudeSessionId, 'idB', 'the winner\'s record is intact, never overwritten');
  assert.deepStrictEqual(fs.readdirSync(sd).filter((n) => /^session-/.test(n)), ['session-0001'], 'no second session was minted');
});

test('I2 stalled creator + letter race: B claims a after the grace; A\'s link -> EEXIST -> refused naming B\'s track', async () => {
  const dir = scratch('i2'); const sd = path.join(dir, 'sessions');
  const bReady = path.join(dir, 'B.ready'); const bWait = path.join(dir, 'B.wait');
  const aReady = path.join(dir, 'A.ready'); const aWait = path.join(dir, 'A.wait');
  const B = open(dir, sd, 'B', 'idB', { fn: 'mkdirSync', pattern: 'session-0001$', when: 'before', ready: bReady, wait: bWait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(bReady), 10000, 'B to park before mkdir');
  const A = open(dir, sd, 'A', 'idA', { fn: 'linkSync', pattern: '\\.claim\\.[^/]*\\.tmp$', when: 'before', ready: aReady, wait: aWait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(aReady), 10000, 'A to park before link (it already made the folder)');
  assert.ok(fs.statSync(path.join(sd, 'session-0001')).isDirectory(), 'A\'s folder exists but holds no record yet');
  fs.writeFileSync(bWait, 'go');                       // B: mkdir EEXIST, no record, grace, claims a itself
  assert.strictEqual(await B.exited, 0, read(B.err));
  assert.deepStrictEqual([B.json().number, B.json().track], ['0001', 'a']);
  fs.writeFileSync(aWait, 'go');                       // A: link EEXIST -> re-gate -> refused
  assert.strictEqual(await A.exited, 3, `A must be REFUSED, got stderr: ${read(A.err)}`);
  assert.strictEqual(A.json().refused, true);
  assert.deepStrictEqual(A.json().tracks.map((t) => [t.number, t.track]), [['0001', 'a']]);
  assert.strictEqual(JSON.parse(read(path.join(sd, 'session-0001', 'session-0001.json'))).meta.claudeSessionId, 'idB');
  const leftovers = fs.readdirSync(path.join(sd, 'session-0001')).filter((n) => n.endsWith('.tmp'));
  assert.deepStrictEqual(leftovers, [], 'no prepared temp left behind');
});

test('I3 no partial record is ever observable: before the link only a dot-temp exists; after, a complete parseable record', async () => {
  const dir = scratch('i3'); const sd = path.join(dir, 'sessions');
  const ready = path.join(dir, 'A.ready'); const wait = path.join(dir, 'A.wait');
  const A = open(dir, sd, 'A', 'idA', { fn: 'linkSync', pattern: '\\.claim\\.[^/]*\\.tmp$', when: 'before', ready, wait, maxMs: 15000 });
  await waitFor(() => fs.existsSync(ready), 10000, 'A to park before link');
  const folder = path.join(sd, 'session-0001');
  const names = fs.readdirSync(folder);
  assert.ok(!names.includes('session-0001.json'), 'the canonical name does not exist yet (a poller cannot read it empty)');
  const temp = names.find((n) => /^\.session-0001\.json\.claim\..*\.tmp$/.test(n));
  assert.ok(temp, `the prepared temp is a dotfile: ${names}`);
  assert.doesNotThrow(() => JSON.parse(read(path.join(folder, temp))), 'the prepared temp is already COMPLETE');
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await A.exited, 0, read(A.err));
  const rec = JSON.parse(read(path.join(folder, 'session-0001.json')));
  assert.strictEqual(rec.meta.claudeSessionId, 'idA');
  assert.deepStrictEqual(fs.readdirSync(folder).filter((n) => n.startsWith('.')), []);
});

test('I4 a same-number double open by the SAME id is not a race: the second resumes (never a duplicate)', async () => {
  const dir = scratch('i4'); const sd = path.join(dir, 'sessions');
  const A = open(dir, sd, 'A', 'idA');
  assert.strictEqual(await A.exited, 0, read(A.err));
  const A2 = open(dir, sd, 'A2', 'idA');
  assert.strictEqual(await A2.exited, 0, read(A2.err));
  assert.deepStrictEqual([A2.json().number, A2.json().isNew, A2.json().gate], ['0001', false, 'resume']);
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 5).join('\n         ')}`); }
  }
  for (const c of live) { try { c.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  console.log(`\nsession-claim-interleave.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
