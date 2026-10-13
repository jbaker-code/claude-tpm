'use strict';
/**
 * task-lock-forced.test.js — the DURABLE forced-interleaving suite for the task-store lock (multi-session
 * support, phase 05, DoD row A) plus cross-process coverage of the phase-04 folds (reindex fail-loud +
 * --drop-unreadable, the lastWriter stamp written under the lock + the doctor's older/unstamped flag, the
 * reader ENOENT-retry).
 *
 * Every race is FORCED, never raced: the interleaving seam (tools/tests/lib/fs-barrier.js, a `node -r` preload)
 * parks one process INSIDE its critical section while the test starts the second, so the outcome is the same on
 * every run. Max 3 child processes alive at once, each with a hard 20 s kill; every case is a few seconds.
 * Children get a minimal env (PATH + what the test passes): no TPM_* / CLAUDE_* of the invoking session, and all
 * stores are os.tmpdir scratch.
 *
 * Mutation hooks (used only to PROVE these tests can fail — see phase 05 findings/HANDOFF.md): the tools under
 * test are located through TPM_TASK_UNDER_TEST / TPM_DOCTOR_UNDER_TEST (absolute paths of a scratch COPY of
 * tpm-task.js / tpm-task-doctor.js with one line broken). Unset = the real product files.
 *
 * Run: node tools/task/tests/task-lock-forced.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const barrier = require('../../tests/lib/fs-barrier');
const t = require('../tpm-task.js');

const TPMTASK = process.env.TPM_TASK_UNDER_TEST || path.resolve(__dirname, '..', 'tpm-task.js');
const DOCTOR = process.env.TPM_DOCTOR_UNDER_TEST || path.resolve(__dirname, '..', 'tpm-task-doctor.js');
const PKG_VERSION = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', '..', 'package.json'), 'utf8')).version;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-task-forced-'));
const live = new Set();
let seq = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(15); }
}
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } }
function scratch(name) { const d = path.join(root, name + '-' + (seq++)); fs.mkdirSync(d, { recursive: true }); return d; }

/** Spawn `node <script> <argv>` with a minimal env; stdout/stderr go to files. */
function run(dir, name, argv, extraEnv, script) {
  const out = path.join(dir, name + '.out'); const errf = path.join(dir, name + '.err');
  const env = Object.assign({ PATH: process.env.PATH }, extraEnv || {});
  const child = spawn(process.execPath, [script || TPMTASK, ...argv], { env, cwd: dir, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(errf, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 20000);
  const state = { code: undefined, sig: undefined };
  const exited = new Promise((resolve) => child.on('close', (code, sig) => { clearTimeout(timer); live.delete(child); state.code = code; state.sig = sig; resolve({ code, sig }); }));
  return { child, pid: child.pid, exited, state, out, err: errf };
}
const stdout = (p) => read(p.out);
const stderr = (p) => read(p.err);

/** Park the process at the first fs `fn` call on a path matching `pattern` (before|after the real call). */
function parkEnv(dir, tag, fn, pattern, when) {
  return Object.assign(barrier.env({
    fn, pattern, when, ready: path.join(dir, tag + '.ready'), wait: path.join(dir, tag + '.wait'), maxMs: 15000,
  }), { TPM_LOCK_WAIT_MS: '15000' });
}
const FIRST_READ = '(tasks-index|task-\\d+)\\.json$';
const parkedAfterRead = (dir, tag) => parkEnv(dir, tag, 'readFileSync', FIRST_READ, 'after');
const parkedBeforeIndexWrite = (dir, tag) => parkEnv(dir, tag, 'openSync', 'tasks-index\\.json\\.\\d+\\.[a-z0-9]+\\.tmp$', 'before');
const parked = (dir, tag) => fs.existsSync(path.join(dir, tag + '.ready'));
const release = (dir, tag) => fs.writeFileSync(path.join(dir, tag + '.wait'), 'go');

/** A scratch store seeded through the ops in this process: #1000 (label x), #1001. */
function seedStore() {
  const dir = scratch('store');
  const tasksDir = path.join(dir, 'tasks');
  t.opAdd({ tasksDir, headline: 'base one', labels: ['x'] });
  t.opAdd({ tasksDir, headline: 'base two' });
  return { dir, tasksDir };
}
const indexFile = (s) => path.join(s.tasksDir, 'tasks-index.json');
const index = (s) => JSON.parse(read(indexFile(s)));
const rows = (s) => index(s).tasks;
const bodyFile = (s, id) => path.join(s.tasksDir, 'bodies', Math.floor(Number(id) / 1000) * 1000 + '-' + (Math.floor(Number(id) / 1000) * 1000 + 999), 'task-' + id + '.json');
const body = (s, id) => JSON.parse(read(bodyFile(s, id)));
function bodyIds(s) {
  const out = [];
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) { if (!e.name.startsWith('.lock')) walk(f); } else if (/^task-\d+\.json$/.test(e.name)) out.push(e.name.replace(/\D/g, '')); } })(path.join(s.tasksDir, 'bodies'));
  return out.sort();
}
const strays = (s) => fs.readdirSync(s.tasksDir).filter((n) => n.startsWith('.lock'));
/** Row ids the index lists vs the bodies on disk: equal means nothing was lost and nothing is duplicated. */
function assertConsistent(s) {
  const ids = rows(s).map((r) => String(r.id));
  assert.strictEqual(new Set(ids).size, ids.length, 'distinct ids in the index: ' + ids);
  assert.deepStrictEqual(ids.slice().sort(), bodyIds(s), 'index rows == bodies on disk (no lost update)');
  const nid = Number(index(s).nextId);
  assert.ok(ids.every((i) => Number(i) < nid), 'nextId ' + nid + ' is above every row');
}
function lockInspect(s) {
  const f = path.join(s.tasksDir, '.lock', 'owner.json');
  try { return JSON.parse(read(f)); } catch (_e) { return null; }
}
/** Craft a lock directory by the documented layout (owner.json + .gitignore). */
function craftLock(s, over) {
  const lockDir = path.join(s.tasksDir, '.lock');
  const owner = Object.assign({ schema: 1, nonce: 'crafted-nonce-0001', pid: 2147483000, host: 'other-host.example', at: new Date().toISOString(), startedAt: null, version: '0.1.0', verb: 'crafted', claudePid: null, claudeSessionId: null }, over || {});
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner, null, 2) + '\n');
  return { lockDir, owner };
}

const cases = []; let passed = 0; let failed = 0;
const test = (name, fn) => cases.push([name, fn]);

// ── A1: duplicate id on simultaneous add ─────────────────────────────────────────────────────────────────────
test('A1 duplicate id: two simultaneous adds, A parked right after reading the index -> B waits, then BOTH tasks exist under distinct ids', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['add', '--tasks-dir', s.tasksDir, '--headline', 'A-added'], parkedAfterRead(s.dir, 'A'));
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park (stderr: ' + stderr(A) + ')');
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'B-added'], { TPM_LOCK_WAIT_MS: '15000' });
  await sleep(700);
  assert.strictEqual(B.state.code, undefined, 'B must still be waiting for the lock while A is inside its read-modify-write: ' + stderr(B));
  assert.ok(!rows(s).some((r) => r.headline === 'B-added'), 'B has written nothing yet');
  release(s.dir, 'A');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.deepStrictEqual([ra.code, rb.code], [0, 0], stderr(A) + '\n---\n' + stderr(B));
  const a = rows(s).filter((r) => r.headline === 'A-added'); const b = rows(s).filter((r) => r.headline === 'B-added');
  assert.strictEqual(a.length, 1); assert.strictEqual(b.length, 1);
  assert.notStrictEqual(a[0].id, b[0].id, 'the two adds got DIFFERENT ids');
  assert.strictEqual(rows(s).length, 4);
  assertConsistent(s);
  assert.deepStrictEqual(strays(s), [], 'lock released, no leftovers');
});

// ── A2: lost index update on simultaneous edit of two DIFFERENT tasks ───────────────────────────────────────
test('A2 lost index update: simultaneous edits of two different tasks both land in the bodies AND in the index rows', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'edited-by-A'], parkedAfterRead(s.dir, 'A'));
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park (stderr: ' + stderr(A) + ')');
  const B = run(s.dir, 'B', ['edit', '1001', '--tasks-dir', s.tasksDir, '--headline', 'edited-by-B'], { TPM_LOCK_WAIT_MS: '15000' });
  await sleep(700);
  assert.strictEqual(B.state.code, undefined, 'B waits for A\'s lock even though it edits a different task: ' + stderr(B));
  release(s.dir, 'A');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.deepStrictEqual([ra.code, rb.code], [0, 0], stderr(A) + '\n---\n' + stderr(B));
  assert.strictEqual(body(s, 1000).headline, 'edited-by-A');
  assert.strictEqual(body(s, 1001).headline, 'edited-by-B');
  const byId = Object.fromEntries(rows(s).map((r) => [String(r.id), r.headline]));
  assert.strictEqual(byId['1000'], 'edited-by-A', 'A\'s edit survives in the index row (B did not overwrite the index with a stale copy)');
  assert.strictEqual(byId['1001'], 'edited-by-B', 'B\'s edit survives in the index row');
  assertConsistent(s);
  assert.deepStrictEqual(strays(s), []);
});

// ── A3: import while another add runs ────────────────────────────────────────────────────────────────────────
test('A3 import vs add: an import (read-modify-write of one task, the only import this tool has) parked mid-write does not lose a concurrent add; ids stay contiguous', async () => {
  const s = seedStore();
  const patch = path.join(s.dir, 'patch.json'); fs.writeFileSync(patch, JSON.stringify({ headline: 'imported headline', summary: 'imported summary' }));
  const A = run(s.dir, 'A', ['import', '1000', '--tasks-dir', s.tasksDir, '--file', patch], parkedAfterRead(s.dir, 'A'));
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park (stderr: ' + stderr(A) + ')');
  assert.strictEqual((lockInspect(s) || {}).verb, 'import', 'the lock owner names the import');
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'added-during-import'], { TPM_LOCK_WAIT_MS: '15000' });
  await sleep(700);
  assert.strictEqual(B.state.code, undefined, 'the add waits for the import: ' + stderr(B));
  release(s.dir, 'A');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.deepStrictEqual([ra.code, rb.code], [0, 0], stderr(A) + '\n---\n' + stderr(B));
  assert.strictEqual(body(s, 1000).headline, 'imported headline');
  assert.ok(rows(s).some((r) => r.headline === 'imported headline'), 'the import is in the index row');
  assert.ok(rows(s).some((r) => r.headline === 'added-during-import'), 'the add is in the index');
  assert.deepStrictEqual(rows(s).map((r) => Number(r.id)).sort(), [1000, 1001, 1002], 'a contiguous block: no id skipped or reused');
  assertConsistent(s);
});

// ── A4: stale-lock break, raced by two waiters ───────────────────────────────────────────────────────────────
test('A4 stale-lock break: a long-held foreign lock is broken by exactly ONE of two simultaneous waiters; both adds succeed with distinct ids; the old lock is kept', async () => {
  const s = seedStore();
  const old = new Date(Date.now() - 3600 * 1000).toISOString();
  const { owner } = craftLock(s, { host: 'other-host.example', at: old, nonce: 'old-foreign-nonce' });
  const env = { TPM_LOCK_WAIT_MS: '15000' };
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'B-after-break'], env);
  const C = run(s.dir, 'C', ['add', '--tasks-dir', s.tasksDir, '--headline', 'C-after-break'], env);
  const [rb, rc] = await Promise.all([B.exited, C.exited]);
  assert.deepStrictEqual([rb.code, rc.code], [0, 0], stderr(B) + '\n---\n' + stderr(C));
  const breaks = (stderr(B) + stderr(C)).match(/breaking a stale lock/g) || [];
  assert.strictEqual(breaks.length, 1, 'exactly one waiter broke the lock: ' + stderr(B) + stderr(C));
  assert.ok(new RegExp('pid ' + owner.pid + ' on host ' + owner.host.replace(/\./g, '\\.')).test(stderr(B) + stderr(C)), 'the loud message names the holder');
  assert.ok(rows(s).some((r) => r.headline === 'B-after-break') && rows(s).some((r) => r.headline === 'C-after-break'));
  assertConsistent(s);
  const left = strays(s);
  assert.strictEqual(left.length, 1, 'only the broken lock is kept: ' + left);
  assert.ok(/^\.lock\.broken\./.test(left[0]));
  assert.strictEqual(JSON.parse(read(path.join(s.tasksDir, left[0], 'owner.json'))).nonce, 'old-foreign-nonce', 'the kept leftover is the broken lock');
});

// ── A5: lock released when a verb throws ─────────────────────────────────────────────────────────────────────
test('A5 release on throw: a verb that THROWS inside its critical section (parked first, so a waiter is queued behind it) releases the lock; the waiter proceeds without breaking anything', async () => {
  const s = seedStore();
  t.opAddSubtask({ tasksDir: s.tasksDir, id: '1001', text: 'sub A' });
  const A = run(s.dir, 'A', ['check', '1001', 'ZZ', '--tasks-dir', s.tasksDir], parkedAfterRead(s.dir, 'A'));   // no subtask ZZ -> throws after the read
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park (stderr: ' + stderr(A) + ')');
  assert.ok(lockInspect(s), 'A holds the lock when it parks');
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'after-throw'], { TPM_LOCK_WAIT_MS: '4000' });
  await sleep(500);
  assert.strictEqual(B.state.code, undefined, 'B waits behind A');
  release(s.dir, 'A');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.notStrictEqual(ra.code, 0, 'A failed (the throw): ' + stderr(A));
  assert.strictEqual(rb.code, 0, 'B proceeded: ' + stderr(B));
  assert.ok(!/breaking a stale lock/.test(stderr(B)), 'B did not have to BREAK a leaked lock: the thrower released it itself: ' + stderr(B));
  assert.deepStrictEqual(strays(s), [], 'no lock and no .lock.broken leftover');
  assert.ok(rows(s).some((r) => r.headline === 'after-throw'));
  assertConsistent(s);
  // and a plain throw with no waiter (missing id) leaves nothing either
  const C = run(s.dir, 'C', ['edit', '9999', '--tasks-dir', s.tasksDir, '--headline', 'x'], {});
  assert.notStrictEqual((await C.exited).code, 0);
  assert.deepStrictEqual(strays(s), []);
});

// ── A6: read verbs unblocked ─────────────────────────────────────────────────────────────────────────────────
test('A6 read verbs are unblocked: list, show and labels return promptly and correct while a writer holds the lock (even with a 15 s wait budget)', async () => {
  const s = seedStore();
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'pending'], parkedAfterRead(s.dir, 'A'));
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park (stderr: ' + stderr(A) + ')');
  assert.ok(lockInspect(s), 'the lock is held');
  for (const [name, argv, re] of [
    ['list', ['list', '--tasks-dir', s.tasksDir], /1001 \| open \| .*base two/],
    ['show', ['show', '1001', '--tasks-dir', s.tasksDir], /base two/],
    ['labels', ['labels', '--tasks-dir', s.tasksDir], /x \(1\): #1000/],
  ]) {
    const t0 = Date.now();
    const R = run(s.dir, 'R-' + name, argv, { TPM_LOCK_WAIT_MS: '15000' });
    const rr = await R.exited;
    assert.strictEqual(rr.code, 0, name + ': ' + stderr(R));
    assert.ok(Date.now() - t0 < 5000, name + ' did not wait for the lock (' + (Date.now() - t0) + ' ms)');
    assert.ok(re.test(stdout(R)), name + ' output: ' + stdout(R));
    assert.ok(!/waiting for lock/.test(stderr(R)), name + ' never announces a lock wait');
  }
  release(s.dir, 'A');
  assert.strictEqual((await A.exited).code, 0);
});

// ── A7: a lock from another host is not judged dead ──────────────────────────────────────────────────────────
test('A7 foreign host: a FRESH lock owned by an unrelated host whose pid is not running here is NOT broken (the verb gives up, store untouched); the same lock aged past the stale limit IS broken', async () => {
  const s = seedStore();
  const { lockDir } = craftLock(s, { host: 'other-host.example', pid: 2147483000, at: new Date().toISOString(), nonce: 'foreign-fresh' });
  const before = read(indexFile(s));
  const B = run(s.dir, 'B', ['add', '--tasks-dir', s.tasksDir, '--headline', 'blocked'], { TPM_LOCK_WAIT_MS: '1500' });
  const rb = await B.exited;
  assert.strictEqual(rb.code, 1, stderr(B));
  assert.ok(/gave up waiting/.test(stderr(B)) && /other-host\.example/.test(stderr(B)) && /not stale yet/.test(stderr(B)), stderr(B));
  assert.ok(!/breaking a stale lock/.test(stderr(B)), 'a foreign-host lock is never judged by its pid');
  assert.strictEqual(JSON.parse(read(path.join(lockDir, 'owner.json'))).nonce, 'foreign-fresh', 'the foreign lock is still in place, untouched');
  assert.strictEqual(read(indexFile(s)), before, 'the failed writer wrote nothing');
  assert.deepStrictEqual(strays(s), ['.lock']);
  // control: age the same lock past the stale limit and the next verb breaks it (so the test above discriminates)
  const o = JSON.parse(read(path.join(lockDir, 'owner.json'))); o.at = new Date(Date.now() - 3600 * 1000).toISOString();
  fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(o));
  const C = run(s.dir, 'C', ['add', '--tasks-dir', s.tasksDir, '--headline', 'unblocked'], { TPM_LOCK_WAIT_MS: '15000' });
  assert.strictEqual((await C.exited).code, 0, stderr(C));
  assert.ok(/breaking a stale lock/.test(stderr(C)), stderr(C));
  assert.ok(rows(s).some((r) => r.headline === 'unblocked'));
});

// ── F1: reindex fails loud on an unknown-newer body; --drop-unreadable is the only discard ───────────────────
test('F1 reindex fail-loud: an unknown-newer body makes `reindex` exit non-zero naming it and write NOTHING; --drop-unreadable discards only that row, lists it, keeps the file', async () => {
  const s = seedStore();
  const b = body(s, 1001); b.schemaVersion = '9.0.0';
  fs.writeFileSync(bodyFile(s, 1001), JSON.stringify(b, null, 2) + '\n');
  const before = read(indexFile(s));
  const R = run(s.dir, 'R', ['reindex', '--tasks-dir', s.tasksDir], {});
  const rr = await R.exited;
  assert.strictEqual(rr.code, 1, 'refused: ' + stderr(R));
  assert.ok(/1001/.test(stderr(R)) && /task-1001\.json/.test(stderr(R)), 'names the unreadable body: ' + stderr(R));
  assert.strictEqual(read(indexFile(s)), before, 'a refused reindex writes nothing: the old row stays');
  assert.ok(rows(s).some((r) => String(r.id) === '1001'));
  assert.deepStrictEqual(strays(s), [], 'the refusal released the lock');
  const D = run(s.dir, 'D', ['reindex', '--drop-unreadable', '--tasks-dir', s.tasksDir], {});
  assert.strictEqual((await D.exited).code, 0, stderr(D));
  assert.ok(/DROPPED 1 unreadable/.test(stderr(D)) && /1001/.test(stderr(D)), stderr(D));
  assert.deepStrictEqual(rows(s).map((r) => String(r.id)), ['1000'], 'only the unreadable row was dropped');
  assert.ok(fs.existsSync(bodyFile(s, 1001)), 'the body file stays on disk');
  assert.ok(Number(index(s).nextId) >= 1002, 'the nextId floor is kept, so the dropped id is never reused: ' + index(s).nextId);
});

// ── F2: the lastWriter stamp is written under the lock ───────────────────────────────────────────────────────
test('F2 lastWriter under the lock: a verb parked just before its index write holds the lock and has NOT stamped yet; the stamp lands in that same write, with the tool version; reads never stamp', async () => {
  const s = seedStore();
  const i0 = index(s); delete i0.lastWriter; fs.writeFileSync(indexFile(s), JSON.stringify(i0, null, 2) + '\n');
  const L = run(s.dir, 'L', ['list', '--tasks-dir', s.tasksDir], {});
  assert.strictEqual((await L.exited).code, 0);
  assert.strictEqual(index(s).lastWriter, undefined, 'a read verb never stamps');
  const A = run(s.dir, 'A', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'stamped'], parkedBeforeIndexWrite(s.dir, 'A'));
  await waitFor(() => parked(s.dir, 'A'), 10000, 'A to park before its index write (stderr: ' + stderr(A) + ')');
  const own = lockInspect(s);
  assert.ok(own && own.pid === A.pid && own.verb === 'edit', 'A holds the lock at the moment it is about to write the index');
  assert.strictEqual(own.version, PKG_VERSION, 'the owner record carries the tool version');
  assert.strictEqual(index(s).lastWriter, undefined, 'the stamp is not on disk before the (locked) index write');
  release(s.dir, 'A');
  assert.strictEqual((await A.exited).code, 0, stderr(A));
  const lw = index(s).lastWriter;
  assert.ok(lw && lw.version === PKG_VERSION, 'lastWriter.version is the running tool version: ' + JSON.stringify(lw));
  assert.ok(Number.isFinite(Date.parse(lw.at)), 'lastWriter.at is a timestamp: ' + lw.at);
  assert.strictEqual(rows(s).find((r) => String(r.id) === '1000').headline, 'stamped');
  assert.deepStrictEqual(strays(s), []);
});

// ── F3: the doctor flags older / unstamped writers ───────────────────────────────────────────────────────────
test('F3 doctor writer flag: UNSTAMPED and OLDER stores are flagged (advisory, exit 0); a store the current tool wrote is silent', async () => {
  const s = seedStore();
  const setLW = (lw) => { const i = index(s); if (lw === undefined) delete i.lastWriter; else i.lastWriter = lw; fs.writeFileSync(indexFile(s), JSON.stringify(i, null, 2) + '\n'); };
  const doc = async (name) => { const D = run(s.dir, name, ['--tasks-dir', s.tasksDir], {}, DOCTOR); const r = await D.exited; return { code: r.code, out: stdout(D), err: stderr(D) }; };
  setLW(undefined);
  let r = await doc('d1');
  assert.strictEqual(r.code, 0, 'advisory only: ' + r.out + r.err);
  assert.ok(/Last writer: UNSTAMPED/.test(r.out), r.out);
  setLW({ version: '0.0.1', at: '2026-01-01T00:00:00-07:00' });
  r = await doc('d2');
  assert.strictEqual(r.code, 0);
  assert.ok(/Last writer: OLDER/.test(r.out) && /0\.0\.1/.test(r.out), r.out);
  const W = run(s.dir, 'W', ['edit', '1000', '--tasks-dir', s.tasksDir, '--headline', 'restamp'], {});
  assert.strictEqual((await W.exited).code, 0, stderr(W));
  r = await doc('d3');
  assert.strictEqual(r.code, 0);
  assert.ok(!/Last writer/.test(r.out), 'after the current tool writes, the doctor is silent about the writer: ' + r.out);
});

// ── F4: the reader ENOENT-retry, through the real CLI ────────────────────────────────────────────────────────
test('F4 reader ENOENT-retry: a lock-free reader that hits the rename-over gap (transient ENOENT on a file that EXISTS) retries and succeeds; a stranded name fails loud and bounded', async () => {
  const s = seedStore();
  const shim = (name, fails) => {
    const f = path.join(s.dir, name + '.js');
    fs.writeFileSync(f, [
      "const fs = require('fs'); const real = fs.readFileSync; let fails = " + fails + ";",
      "fs.readFileSync = function (p) { if (/tasks-index\\.json$/.test(String(p)) && fails-- > 0) { const e = new Error(\"ENOENT: no such file or directory, open '\" + p + \"'\"); e.code = 'ENOENT'; throw e; } return real.apply(this, arguments); };",
    ].join('\n'));
    return { NODE_OPTIONS: '-r "' + f + '"' };
  };
  const ok = run(s.dir, 'ok', ['list', '--tasks-dir', s.tasksDir], shim('gap2', 2));
  assert.strictEqual((await ok.exited).code, 0, 'two transient misses are survived: ' + stderr(ok));
  assert.ok(/base two/.test(stdout(ok)), stdout(ok));
  const shown = run(s.dir, 'shown', ['show', '1001', '--tasks-dir', s.tasksDir], shim('gap3', 3));
  assert.strictEqual((await shown.exited).code, 0, 'three transient misses (the bound) are survived: ' + stderr(shown));
  const stranded = run(s.dir, 'stranded', ['list', '--tasks-dir', s.tasksDir], shim('gapInf', 1000000));
  const rs = await stranded.exited;
  assert.notStrictEqual(rs.code, 0, 'a name that never opens fails');
  assert.ok(/cannot read canonical file .*tasks-index\.json.*ENOENT/.test(stderr(stranded)), 'loud, naming the file: ' + stderr(stranded));
  const missing = run(s.dir, 'missing', ['edit', '4242', '--tasks-dir', s.tasksDir, '--headline', 'x'], {});
  assert.notStrictEqual((await missing.exited).code, 0, 'a genuinely missing task fails: ' + stderr(missing));
  assert.ok(/cannot read canonical file .*task-4242\.json/.test(stderr(missing)), stderr(missing));
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) {
      failed++; console.log('  FAIL - ' + name + '\n         ' + String(e && e.stack || e).split('\n').slice(0, 6).join('\n         '));
    }
  }
  for (const k of live) { try { k.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  console.log(`\ntask-lock-forced.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
