'use strict';
/**
 * task-lock-interleave.test.js — the task store lock across REAL processes, with the interleaving seam
 * (tools/tests/lib/fs-barrier.js) forcing the interleaving (multi-session support, phase 04, DoD rows A, B, C).
 *
 * For EVERY mutating verb: process A runs the verb and is PARKED (by the seam) right after its first read of
 * the store — i.e. inside its critical section. Process B then runs `add` on the same store. The test asserts
 *   - A really holds the lock while parked (lock.inspect: held, owner pid == A's pid);
 *   - B does NOT proceed while A is parked (still running, nothing of B's on disk, B says who it waits for once
 *     its notice delay passes — checked by the dedicated waiting-line case);
 *   - after A is released both exit 0, A's effect landed, B's task exists exactly once, ids are distinct, and
 *     the index rows == the bodies on disk (nothing lost);
 *   - the read verbs (list/show/labels/history) return immediately with correct output while A holds the lock.
 * Then a stale lock left by a SIGKILLed verb is broken loudly by the next verb.
 *
 * Max 2 children alive at once; every child has a hard 20 s kill; every rendezvous polls with a deadline.
 * Children get a minimal env (PATH + what the test passes): no TPM_* / CLAUDE_* of the invoking session.
 * Run: node tools/task/tests/task-lock-interleave.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const lock = require('../../lib/lock');
const barrier = require('../../tests/lib/fs-barrier');
const t = require('../tpm-task.js');
const model = require('../lib/task-model');

const TPMTASK = path.resolve(__dirname, '..', 'tpm-task.js');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-il-'));
const live = new Set();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(15); }
}
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } }
function scratch(name) { const d = path.join(root, name + '-' + (seq++)); fs.mkdirSync(d, { recursive: true }); return d; }

/** Spawn `node tpm-task.js <argv>` with a minimal env; stdout/stderr go to files. */
function run(dir, name, argv, extraEnv) {
  const out = path.join(dir, name + '.out'); const errf = path.join(dir, name + '.err');
  const env = Object.assign({ PATH: process.env.PATH }, extraEnv || {});
  const child = spawn(process.execPath, [TPMTASK, ...argv], { env, cwd: dir, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(errf, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 20000);
  const state = { code: undefined, sig: undefined };
  const exited = new Promise((resolve) => child.on('close', (code, sig) => { clearTimeout(timer); live.delete(child); state.code = code; state.sig = sig; resolve({ code, sig }); }));
  return { child, pid: child.pid, exited, state, out, err: errf };
}

/** Park A after its first read of the index or a body (inside the critical section). */
function parkedEnv(dir) {
  return Object.assign(barrier.env({
    fn: 'readFileSync', pattern: '(tasks-index|task-\\d+)\\.json$', when: 'after',
    ready: path.join(dir, 'A.ready'), wait: path.join(dir, 'A.wait'), maxMs: 15000,
  }), { TPM_LOCK_WAIT_MS: '15000' });
}

/** A fresh store seeded (through the ops, in this process) with the tasks every verb below needs. */
function seedStore() {
  const dir = scratch('store');
  const tasksDir = path.join(dir, 'tasks');
  const add = (h, extra) => t.opAdd(Object.assign({ tasksDir, headline: h }, extra || {}));
  add('base one', { labels: ['x'] });                    // 1000
  add('has open subtask');                               // 1001
  t.opAddSubtask({ tasksDir, id: '1001', text: 'sub A' });
  add('finishable');                                     // 1002
  add('droppable');                                      // 1003
  add('removable');                                      // 1004
  add('to reopen');                                      // 1005
  t.opTransition('finish', { tasksDir, id: '1005' });
  add('to purge');                                       // 1006
  const importFile = path.join(dir, 'patch.json'); fs.writeFileSync(importFile, JSON.stringify({ headline: 'imported headline' }));
  const cfg = path.join(dir, 'config.json'); fs.writeFileSync(cfg, JSON.stringify({ tasks: { allowHardDelete: true } }));
  return { dir, tasksDir, importFile, cfg };
}

/** verb -> { argv for A, assertion that A's effect landed } */
const VERBS = [
  ['add', (s) => ['add', '--tasks-dir', s.tasksDir, '--headline', 'A-added'], (s) => assert.ok(rows(s).some((r) => r.headline === 'A-added'))],
  ['edit', (s) => ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'A-edited'], (s) => assert.strictEqual(model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).headline, 'A-edited')],
  ['import', (s) => ['import', '1000', '--tasks-dir', s.tasksDir, '--file', s.importFile], (s) => assert.strictEqual(model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).headline, 'imported headline')],
  ['add-subtask', (s) => ['add-subtask', '1000', '--tasks-dir', s.tasksDir, '--text', 'new sub'], (s) => assert.strictEqual(model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).subtasks.length, 1)],
  ['check', (s) => ['check', '1001', 'A', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(model.loadTask(model.bodyPathFor(s.tasksDir, '1001')).subtasks[0].state, 'done')],
  ['start', (s) => ['start', '1000', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(state(s, '1000'), 'in-progress')],
  ['finish', (s) => ['finish', '1002', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(state(s, '1002'), 'finished')],
  ['drop', (s) => ['drop', '1003', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(state(s, '1003'), 'dropped')],
  ['remove', (s) => ['remove', '1004', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(state(s, '1004'), 'removed')],
  ['reopen', (s) => ['reopen', '1005', '--tasks-dir', s.tasksDir], (s) => assert.strictEqual(state(s, '1005'), 'open')],
  ['label', (s) => ['label', '1000', 'newlabel', '--tasks-dir', s.tasksDir], (s) => assert.ok(model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).labels.includes('newlabel'))],
  ['unlabel', (s) => ['unlabel', '1000', 'x', '--tasks-dir', s.tasksDir], (s) => assert.ok(!model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).labels.includes('x'))],
  ['remove --hard', (s) => ['remove', '1006', '--hard', '--tasks-dir', s.tasksDir, '--config', s.cfg], (s) => assert.ok(!fs.existsSync(model.bodyPathFor(s.tasksDir, '1006')))],
  ['reindex', (s) => ['reindex', '--tasks-dir', s.tasksDir], (s) => assert.ok(rows(s).length >= 7)],
];
function rows(s) { return JSON.parse(read(path.join(s.tasksDir, 'tasks-index.json'))).tasks; }
function state(s, id) { return model.loadTask(model.bodyPathFor(s.tasksDir, id)).state; }
function bodyIds(s) { return model.listBodyPaths(s.tasksDir).map((p) => /task-(\d+)\.json$/.exec(p)[1]).sort(); }

const cases = []; let passed = 0; let failed = 0;
const test = (name, fn) => cases.push([name, fn]);

for (const [verb, argvFor, landed] of VERBS) {
  test(`A [${verb}] holds the lock while parked; a second writer waits; both finish; nothing is lost`, async () => {
    const s = seedStore();
    const lockDir = path.join(s.tasksDir, '.lock');
    const A = run(s.dir, 'A', argvFor(s), parkedEnv(s.dir));
    await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 10000, 'A to park (stderr: ' + read(A.err) + ')');
    const ins = lock.inspect(lockDir, { env: {} });
    assert.strictEqual(ins.state, 'held', 'A is parked INSIDE the lock');
    assert.strictEqual(ins.owner.pid, A.pid);
    assert.strictEqual(ins.owner.verb, verb, 'the owner record names the verb');
    const before = bodyIds(s).length;
    const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'B-added'], { TPM_LOCK_WAIT_MS: '15000' });
    await sleep(700);
    assert.strictEqual(B.state.code, undefined, 'B has NOT finished while A is parked: ' + read(B.err));
    assert.ok(!rows(s).some((r) => r.headline === 'B-added'), 'B wrote nothing while A holds the lock');
    assert.strictEqual(bodyIds(s).length, verb === 'add' ? before + 0 : before, 'no new body appeared while A is parked');
    fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
    const [ra, rb] = await Promise.all([A.exited, B.exited]);
    assert.deepStrictEqual([ra.code, rb.code], [0, 0], read(A.err) + '\n---\n' + read(B.err));
    landed(s);
    const r = rows(s);
    assert.strictEqual(r.filter((x) => x.headline === 'B-added').length, 1, 'B\'s task exists exactly once');
    const ids = r.map((x) => x.id); assert.strictEqual(new Set(ids).size, ids.length, 'distinct ids in the index');
    assert.deepStrictEqual(ids.slice().sort(), bodyIds(s), 'index rows == bodies on disk (no lost update)');
    assert.ok(!fs.existsSync(lockDir), 'lock released');
    assert.deepStrictEqual(fs.readdirSync(s.tasksDir).filter((n) => n.startsWith('.lock')), [], 'no lock leftovers');
  });
}

test('the waiting writer tells the human who it waits for (pid, host, verb) once its notice delay passes', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'p'], parkedEnv(s.dir));
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 10000, 'A to park');
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'w'], { TPM_LOCK_WAIT_MS: '15000' });
  await waitFor(() => /waiting for lock/.test(read(B.err)), 8000, 'the waiting line (default notice delay 2 s)');
  assert.ok(new RegExp('tpm-task: waiting for lock .*held by pid ' + A.pid + ' on host .*verb edit').test(read(B.err)), read(B.err));
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.deepStrictEqual([ra.code, rb.code], [0, 0]);
});

test('a waiter that runs out of budget fails loud with an actionable message and changes nothing (exit 1)', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'p'], parkedEnv(s.dir));
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 10000, 'A to park');
  const idxBefore = read(path.join(s.tasksDir, 'tasks-index.json'));
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'w'], { TPM_LOCK_WAIT_MS: '400' });
  const rb = await B.exited;
  assert.strictEqual(rb.code, 1);
  const msg = read(B.err);
  assert.ok(/tpm-task: gave up waiting 0 s for lock .*held by pid \d+ on host .*, verb edit/.test(msg), msg);
  assert.ok(/not stale yet/.test(msg) && /Re-run in a moment/.test(msg), msg);
  assert.strictEqual(read(path.join(s.tasksDir, 'tasks-index.json')), idxBefore, 'the failed writer wrote nothing');
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  assert.strictEqual((await A.exited).code, 0);
});

test('read verbs (list, show, labels, history) never wait: they return at once, correct, while A holds the lock', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'p'], parkedEnv(s.dir));
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 10000, 'A to park');
  assert.strictEqual(lock.inspect(path.join(s.tasksDir, '.lock'), { env: {} }).state, 'held');
  const common = { TPM_LOCK_WAIT_MS: '15000' };   // would hang up to 15 s if a read verb took the lock
  const reads = [
    ['list', ['list', '--tasks-dir', s.tasksDir], /1001 \| open \| .*has open subtask/],
    ['show', ['show', '1001', '--tasks-dir', s.tasksDir], /has open subtask/],
    ['labels', ['labels', '--tasks-dir', s.tasksDir], /x \(1\): #1000/],
    ['history', ['history', '1001', '--tasks-dir', s.tasksDir], /create/],
  ];
  for (const [name, argv, re] of reads) {
    const t0 = Date.now();
    const R = run(s.dir, 'R-' + name, argv, common);
    const rr = await R.exited;
    assert.strictEqual(rr.code, 0, name + ': ' + read(R.err));
    assert.ok(Date.now() - t0 < 5000, name + ' returned promptly while the lock was held (' + (Date.now() - t0) + ' ms)');
    assert.ok(re.test(read(R.out)), name + ' output: ' + read(R.out));
  }
  // export too (the export tool is a separate entry point): a read, so it must not wait either
  const E = spawn(process.execPath, [path.join(__dirname, '..', 'tpm-task-export.js'), 'export', '1001', '--tasks-dir', s.tasksDir, '--json'],
    { env: { PATH: process.env.PATH, TPM_LOCK_WAIT_MS: '15000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  live.add(E);
  let eout = ''; E.stdout.on('data', (d) => { eout += d; });
  const t0 = Date.now();
  const ec = await new Promise((resolve) => E.on('close', resolve));
  live.delete(E);
  assert.ok(Date.now() - t0 < 5000, 'export returned promptly');
  assert.strictEqual(ec, 0); assert.ok(/has open subtask/.test(eout), eout);
  fs.writeFileSync(path.join(s.dir, 'A.wait'), 'go');
  assert.strictEqual((await A.exited).code, 0);
});

test('a verb killed mid-write (SIGKILL inside its critical section) leaves a stale lock; the next verb breaks it loudly and proceeds', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'killed'], parkedEnv(s.dir));
  await waitFor(() => fs.existsSync(path.join(s.dir, 'A.ready')), 10000, 'A to park');
  A.child.kill('SIGKILL');
  assert.strictEqual((await A.exited).sig, 'SIGKILL');
  assert.ok(fs.existsSync(path.join(s.tasksDir, '.lock')), 'the dead verb left its lock');
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'after-kill'], { TPM_LOCK_WAIT_MS: '15000' });
  const rb = await B.exited;
  assert.strictEqual(rb.code, 0, read(B.err));
  const err = read(B.err);
  assert.ok(/tpm-task: breaking a stale lock/.test(err) && new RegExp('held by pid ' + A.pid + ' ').test(err) && /is not running/.test(err), err);
  assert.ok(/run `tpm task doctor`; if it reports drift, `tpm task reindex`/.test(err), 'the loud message carries the task-store recovery hint: ' + err);
  assert.ok(rows(s).some((r) => r.headline === 'after-kill'));
  assert.strictEqual(model.loadTask(model.bodyPathFor(s.tasksDir, '1000')).headline, 'base one', 'the killed edit never landed');
  const left = fs.readdirSync(s.tasksDir).filter((n) => n.startsWith('.lock'));
  assert.strictEqual(left.length, 1); assert.ok(/^\.lock\.broken\./.test(left[0]), 'the broken lock is kept for the doctor: ' + left);
  assert.ok(fs.existsSync(path.join(s.tasksDir, left[0], '.gitignore')), 'the kept leftover still ignores itself');
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) {
      failed++; console.log('  FAIL - ' + name + '\n         ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n         '));
    }
  }
  for (const k of live) { try { k.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  console.log(`\ntask-lock-interleave.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
