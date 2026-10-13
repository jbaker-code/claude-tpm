'use strict';
/**
 * task-attribution-interleave.test.js — FORCED two-process interleaving for session attribution
 * (multi-session support, phase 19, DoD A / plan Amendment).
 *
 * Two simulated Claude instances (distinct fake CLAUDE_CODE_SESSION_ID + CLAUDE_PID) own two tracks of ONE session
 * (session-0040 = idA, session-0040b = idB) and write task history on ONE store. The fs-barrier seam
 * (tools/tests/lib/fs-barrier.js) PARKS instance A inside the store lock (right after its first read of the index /
 * a body) while instance B runs its verb and must wait for the lock; A is then released. The test asserts
 *   - A really holds the lock while parked and B has NOT finished (the interleaving was actually forced);
 *   - each instance's event carries its OWN session (A: session-0040, B: session-0040b, via lookup) — attribution rides
 *     the #1160 lock correctly: neither stamp is lost, swapped or doubled;
 *   - the index and the bodies survive (index rows == bodies on disk, distinct ids, no .lock left behind).
 * Max 2 children alive; every child has a hard 25 s kill; every rendezvous polls with a deadline.
 * Children get an EXPLICIT env: PATH + a SCRATCH HOME + the fake id/pid + a scratch TPM_SESSIONS_DIR.
 * Run: node tools/task/tests/task-attribution-interleave.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const lock = require('../../lib/lock');
const barrier = require('../../tests/lib/fs-barrier');
const H = require('../../session/tests/helpers/track-helpers');

const TPMTASK = path.resolve(__dirname, '..', 'tpm-task.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-attr-il-'));
const HOME = path.join(root, 'home'); fs.mkdirSync(HOME, { recursive: true });   // SCRATCH home, never the invoking user's home
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) { const t0 = Date.now(); while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(15); } }
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } };

function setup() {
  const dir = path.join(root, 'case-' + (seq++)); const sessions = path.join(dir, 'sessions'); const tasks = path.join(dir, 'tasks');
  fs.mkdirSync(dir, { recursive: true });
  H.putTrack(sessions, '0040', 'a', { owner: 'idA' });
  H.putTrack(sessions, '0040', 'b', { owner: 'idB' });
  return { dir, sessions, tasks };
}
/** Spawn one tpm-task instance with an EXPLICIT env (its own fake Claude id/pid); stdout/stderr to files. */
function run(s, who, argv, extraEnv) {
  const id = who === 'A' ? 'idA' : 'idB'; const pid = who === 'A' ? '1111' : '2222';
  const env = Object.assign({ PATH: process.env.PATH, HOME, CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: pid, TPM_SESSIONS_DIR: s.sessions, TPM_LOCK_WAIT_MS: '15000' }, extraEnv || {});
  const out = path.join(s.dir, who + '.out'); const err = path.join(s.dir, who + '.err');
  const child = spawn(process.execPath, [TPMTASK, ...argv, '--tasks-dir', s.tasks], { env, cwd: s.dir, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(err, 'w')] });
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 25000);
  const state = { code: undefined };
  const exited = new Promise((resolve) => child.on('close', (code) => { clearTimeout(timer); state.code = code; resolve(code); }));
  return { pid: child.pid, state, exited, err };
}
function parkedEnv(s) {
  return barrier.env({ fn: 'readFileSync', pattern: '(tasks-index|task-\\d+)\\.json$', when: 'after', ready: path.join(s.dir, 'A.ready'), wait: path.join(s.dir, 'A.wait'), maxMs: 18000 });
}
const body = (s, id) => { const g = Math.floor(id / 1000) * 1000; const j = JSON.parse(fs.readFileSync(path.join(s.tasks, 'bodies', `${g}-${g + 999}`, `task-${id}.json`), 'utf8')); return j.payload || j; };
const idxRows = (s) => JSON.parse(read(path.join(s.tasks, 'tasks-index.json'))).tasks;
const stampOf = (e) => [e.session, e.sessionVia];

function seedOne(s) { // task 1000 created by instance B's id up front, through the real CLI, no parking
  const r = run(s, 'B', ['add', '--headline', 'seed']);
  return r.exited.then((c) => { assert.strictEqual(c, 0, read(r.err)); });
}
async function parkA(s, argvA) {
  const A = run(s, 'A', argvA, parkedEnv(s));
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 12000, 'A to park (stderr: ' + read(A.err) + ')');
  const ins = lock.inspect(path.join(s.tasks, '.lock'), { env: {} });
  assert.strictEqual(ins.state, 'held', 'A is parked INSIDE the lock');
  assert.strictEqual(ins.owner.pid, A.pid);
  return A;
}
function integrity(s, expectedCount) {
  const rows = idxRows(s);
  const bodies = fs.readdirSync(path.join(s.tasks, 'bodies'), { recursive: true }).filter((f) => /task-\d+\.json$/.test(f));
  assert.strictEqual(rows.length, expectedCount, 'index rows');
  assert.strictEqual(bodies.length, expectedCount, 'bodies on disk');
  assert.strictEqual(new Set(rows.map((r) => r.id)).size, rows.length, 'distinct ids');
  assert.ok(!fs.existsSync(path.join(s.tasks, '.lock')), 'no lock left behind');
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('I-1 A (idA) parked in the lock on `start`, B (idB) `label`s the same task: each event carries its OWN session; nothing lost', async () => {
  const s = setup(); await seedOne(s);
  const A = await parkA(s, ['start', '1000']);
  const B = run(s, 'B', ['label', '1000', 'foo']);
  await sleep(700);
  assert.strictEqual(B.state.code, undefined, 'B is still waiting for the lock while A is parked: ' + read(B.err));
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  const [ca, cb] = await Promise.all([A.exited, B.exited]);
  assert.strictEqual(ca, 0, read(A.err)); assert.strictEqual(cb, 0, read(B.err));
  const h = body(s, 1000).history;
  const startEv = h.find((e) => e.op === 'state' && e.to === 'in-progress');
  const labelEv = h.find((e) => e.op === 'edit' && e.field === 'labels');
  assert.ok(startEv && labelEv, 'both events landed: ' + JSON.stringify(h));
  assert.deepStrictEqual(stampOf(startEv), ['session-0040', 'lookup'], 'A stamped as track a');
  assert.deepStrictEqual(stampOf(labelEv), ['session-0040b', 'lookup'], 'B stamped as track b');
  assert.deepStrictEqual(stampOf(h[0]), ['session-0040b', 'lookup'], 'the seed (B) event is intact');
  assert.strictEqual(h.length, 3, 'exactly create + start + label, none doubled or lost');
  assert.ok(h.indexOf(startEv) < h.indexOf(labelEv), 'A (lock holder) wrote before B');
  integrity(s, 1);
});

test('I-2 A parked in `add`, B `add`s too: two distinct tasks, A\'s create is session-0040, B\'s is session-0040b; index == bodies', async () => {
  const s = setup(); await seedOne(s);   // a non-empty store, so `add` reads the index inside the lock
  const A = await parkA(s, ['add', '--headline', 'from A']);
  const B = run(s, 'B', ['add', '--headline', 'from B']);
  await sleep(700);
  assert.strictEqual(B.state.code, undefined, 'B waits while A holds the lock');
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  const [ca, cb] = await Promise.all([A.exited, B.exited]);
  assert.strictEqual(ca, 0, read(A.err)); assert.strictEqual(cb, 0, read(B.err));
  const rows = idxRows(s);
  const byHead = (h) => rows.find((r) => r.headline === h);
  const a = byHead('from A'); const b = byHead('from B');
  assert.ok(a && b && a.id !== b.id, 'two new tasks, distinct ids (plus the seed)');
  assert.deepStrictEqual(stampOf(body(s, Number(a.id)).history[0]), ['session-0040', 'lookup']);
  assert.deepStrictEqual(stampOf(body(s, Number(b.id)).history[0]), ['session-0040b', 'lookup']);
  integrity(s, 3);
});

test('I-3 the stamps are not cross-contaminated when the roles swap (B holds the lock, A waits)', async () => {
  const s = setup(); await seedOne(s);
  // B (idB) is the lock holder this time: park it, run A behind it
  const parked = run(s, 'B', ['edit', '1000', '--headline', 'B-edit'], parkedEnv(s)); // ready/wait files are shared names; reuse A.ready / A.wait
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 12000, 'B to park (stderr: ' + read(parked.err) + ')');
  const waiter = run(s, 'A', ['edit', '1000', '--headline', 'A-edit']);
  await sleep(700);
  assert.strictEqual(waiter.state.code, undefined, 'A waits: ' + read(waiter.err));
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  const [cp, cw] = await Promise.all([parked.exited, waiter.exited]);
  assert.strictEqual(cp, 0, read(parked.err)); assert.strictEqual(cw, 0, read(waiter.err));
  const edits = body(s, 1000).history.filter((e) => e.op === 'edit');
  assert.strictEqual(edits.length, 2);
  assert.deepStrictEqual([edits[0].value, stampOf(edits[0])], ['B-edit', ['session-0040b', 'lookup']]);
  assert.deepStrictEqual([edits[1].value, stampOf(edits[1])], ['A-edit', ['session-0040', 'lookup']]);
  integrity(s, 1);
});

(async () => {
  let pass = 0; let fail = 0;
  for (const [name, fn] of cases) {
    try { await fn(); pass += 1; console.log('  ok   - ' + name); } catch (e) { fail += 1; console.log('  FAIL - ' + name + '\n         ' + (e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n         ') : e)); }
  }
  console.log(`\ntask-attribution-interleave.test.js: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
