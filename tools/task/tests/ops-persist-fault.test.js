'use strict';
/**
 * ops-persist-fault.test.js (P08) — the OPS-LAYER mid-persist fault test for the task tooling.
 *
 * The shared base io.js is already crash-safe in isolation (session io.test.js). This asserts the
 * SAME guarantee at the TASK ops layer: when an fs fault strikes DURING a real verb's save
 * (loadCurrent → mutate-via-model → saveTask → writeEnvelope → atomicWriteFileSync), the
 * pre-existing canonical task JSON must be BYTE-UNCHANGED, its derived body .md must be unchanged
 * (the JSON write fails FIRST, before md/index regen), no partial/orphan .tmp may be left ANYWHERE
 * under the store (bodies live in bodies/<bucket>/), and the op must throw LOUD — never silently
 * swallow the failure and leave a corrupt/half-written store.
 *
 * The fault is injected by swapping fs.renameSync / fs.fsyncSync for a throwing stub (withFailingFs);
 * require('fs') is a cached singleton, so io.js sees the override at call time. Everything runs in a
 * THROWAWAY dir — NEVER the live store. Node built-ins only.
 *
 * Run: node tests/ops-persist-fault.test.js  (also via run-all).
 */
const {
  assert, test, done, withFailingFs, scratch,
  bodyPath, bodyMdPath, tmpOrphans, fs,
} = require('./helpers/task-e2e-helpers');

const t = require('../tpm-task.js');

// The ops now hold the store lock (a rename-based directory lock, tools/lib/lock.js) for their whole
// read-modify-write. A blanket renameSync fault would therefore strike the LOCK ACQUIRE (ELOCK_IO) before the
// persist this suite targets. withFailingFsAfterLock fails renameSync ONLY for non-lock paths (a rename whose
// source or destination basename starts with `.lock`), so the fault still lands mid-persist, inside the lock.
function withFailingFsAfterLock(fn) {
  const real = fs.renameSync;
  fs.renameSync = function failingStub(from, to) {
    const isLock = [from, to].some((p) => /^\.lock(\.|$)/.test(require('path').basename(String(p))));
    if (isLock) return real.apply(this, arguments);
    const e = new Error('injected fs.renameSync failure');
    e.code = 'EIO';
    throw e;
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

// Seed a valid, populated task (headline + a summary + two subtasks, one checked) via the ops.
function seed(dir) {
  t.opAdd({ tasksDir: dir, headline: 'seeded task', summary: 'seed summary', labels: ['x'] }); // -> id 1000
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'first subtask' });   // key A
  t.opCheck({ tasksDir: dir, id: '1000', key: 'A' });                     // A -> done
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'second subtask' });  // key B (open)
  return '1000';
}

test('opEdit under a forced RENAME fault: canonical JSON byte-unchanged, body .md unchanged, no orphan .tmp, loud throw', () => {
  const dir = scratch('tpm-task-fault-');
  const id = seed(dir);
  const jsonBefore = fs.readFileSync(bodyPath(dir, id), 'utf8');
  const mdBefore = fs.readFileSync(bodyMdPath(dir, id), 'utf8');

  let threw = false;
  withFailingFsAfterLock(() => {
    try {
      t.opEdit({ tasksDir: dir, id, headline: 'THIS MUST NOT LAND' });
    } catch (e) {
      threw = true;
      assert.ok(/failed writing/.test(e.message), 'loud throw naming the failed write, got: ' + e.message);
    }
  });

  assert.ok(threw, 'a mid-persist rename fault must throw (never silently swallowed)');
  assert.strictEqual(fs.readFileSync(bodyPath(dir, id), 'utf8'), jsonBefore, 'canonical JSON is BYTE-UNCHANGED after the fault');
  assert.ok(jsonBefore.indexOf('THIS MUST NOT LAND') === -1, 'sanity: the aborted edit never reached the pre-existing JSON');
  assert.strictEqual(fs.readFileSync(bodyMdPath(dir, id), 'utf8'), mdBefore, 'derived body .md unchanged (JSON write fails FIRST)');
  assert.deepStrictEqual(tmpOrphans(dir), [], 'no orphaned .tmp left behind anywhere under the store');
});

test('opCheck under a forced FSYNC fault: canonical JSON byte-unchanged, no orphan .tmp, loud throw', () => {
  const dir = scratch('tpm-task-fault-');
  const id = seed(dir);
  const jsonBefore = fs.readFileSync(bodyPath(dir, id), 'utf8');

  let threw = false;
  withFailingFs('fsyncSync', () => {
    try {
      t.opCheck({ tasksDir: dir, id, key: 'B' });   // would flip B -> done
    } catch (e) {
      threw = true;
      assert.ok(/failed writing/.test(e.message), 'loud throw on an fsync fault, got: ' + e.message);
    }
  });

  assert.ok(threw, 'a mid-persist fsync fault must throw');
  const jsonAfter = fs.readFileSync(bodyPath(dir, id), 'utf8');
  assert.strictEqual(jsonAfter, jsonBefore, 'canonical JSON is BYTE-UNCHANGED after the fsync fault');
  // B was open before; the aborted check must not have flipped it on disk.
  const disk = JSON.parse(jsonAfter);
  assert.strictEqual(disk.subtasks.find((s) => s.key === 'B').state, 'open', 'the aborted check never reached disk (B still open)');
  assert.deepStrictEqual(tmpOrphans(dir), [], 'no orphaned .tmp left behind');
});

test('MUTATION check: WITHOUT the injected fault the SAME op persists (the fault test observes a real difference)', () => {
  const dir = scratch('tpm-task-fault-');
  const id = seed(dir);
  const rec = t.opCheck({ tasksDir: dir, id, key: 'B' });   // same op as the fsync case, no fault
  assert.strictEqual(rec.subtasks.find((s) => s.key === 'B').state, 'done', 'op returns B as done when there is no fault');
  const disk = JSON.parse(fs.readFileSync(bodyPath(dir, id), 'utf8'));
  assert.strictEqual(disk.subtasks.find((s) => s.key === 'B').state, 'done', 'the check landed in the canonical JSON');
});

done('ops-persist-fault.test.js');
