'use strict';
/**
 * ops-persist-fault.test.js (P07, verifier concern C2) — the OPS-LAYER mid-persist fault test.
 *
 * io.test.js already proves atomicWriteFileSync is crash-safe in ISOLATION. C2 asks for the same
 * guarantee exercised at the OPS layer: when an fs fault strikes DURING a real op's save (open →
 * mutate-via-model → saveSession → writeEnvelope → atomicWriteFileSync), the pre-existing canonical
 * JSON must be BYTE-UNCHANGED, no partial/orphan file may be left, and the op must throw LOUD (never
 * silently swallow the failure and leave a corrupt/half-written session).
 *
 * All work happens in a THROWAWAY dir (os.tmpdir mkdtemp) — NEVER the live sessions dir. The fault
 * is injected by swapping fs.renameSync / fs.fsyncSync for a throwing stub (withFailingFs); because
 * require('fs') is a cached singleton, io.js sees the override at call time.
 *
 * Run: node tests/ops-persist-fault.test.js
 * Node built-ins only.
 */
const { assert, test, done, withFailingFs } = require('./helpers/harness');
const { NOW, scratch, jsonPath, mdPath, writeTmp, fs } = require('./helpers/e2e-helpers');

const ops = require('../tpm-session-ops');

// Phase 12 (Q11): every mutating op now takes the session lock, and the lock itself renames its prepared directory
// into place. This fault must strike the RECORD write (what this file is about), not the lock's own rename, so the
// stub passes any rename that touches a `.lock*` path through to the real fs.
function withFailingRecordRename(fn) {
  const real = fs.renameSync;
  fs.renameSync = function failingStub(from, to) {
    if (/[\\/]\.lock(?:\.|$|[\\/])/.test(String(from)) || /[\\/]\.lock(?:\.|$|[\\/])/.test(String(to))) return real.apply(this, arguments);
    const e = new Error('injected fs.renameSync failure');
    e.code = 'EIO';
    throw e;
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

function lockResidue(dir) {
  return fs.readdirSync(dir, { recursive: true }).filter((f) => /(^|[\\/])\.lock/.test(String(f)));
}

function tmpFiles(dir) { return fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')); }

// Seed a valid, populated session (handoff + a log entry + a punchlist item) via the ops.
function seed(dir, number) {
  ops.opOpen({ sessionsDir: dir, number, sessionId: `sid-${number}`, tpmVersion: '1.0.0', now: NOW });
  ops.opImportHandoff({ sessionsDir: dir, number, txtFile: writeTmp(dir, 'h.txt', 'seeded where'), next: 'seeded next', now: NOW });
  ops.opNote({ sessionsDir: dir, number, type: 'log', status: 'NOTE', text: 'seed line', now: NOW });
  ops.opPunchlist({ sessionsDir: dir, number, action: 'add', text: 'seed task', slug: 'seed01', now: NOW });
}

test('opNote under a forced RENAME fault: canonical JSON byte-unchanged, .md unchanged, no orphan tmp, loud throw', () => {
  const dir = scratch('tpm-fault-');
  seed(dir, '0021');
  const jsonBefore = fs.readFileSync(jsonPath(dir, 21), 'utf8');
  const mdBefore = fs.readFileSync(mdPath(dir, 21), 'utf8');

  let threw = false;
  withFailingRecordRename(() => {
    try {
      ops.opNote({ sessionsDir: dir, number: '0021', type: 'log', status: 'NOTE', text: 'this must not land', now: NOW });
    } catch (e) {
      threw = true;
      assert.ok(/failed writing/.test(e.message), 'loud throw naming the failed write, got: ' + e.message);
    }
  });

  assert.ok(threw, 'a mid-persist rename fault must throw (never silently swallowed)');
  assert.strictEqual(fs.readFileSync(jsonPath(dir, 21), 'utf8'), jsonBefore, 'canonical JSON is BYTE-UNCHANGED after the fault');
  assert.ok(jsonBefore.indexOf('this must not land') === -1, 'sanity: the aborted note never reached the pre-existing JSON');
  assert.strictEqual(fs.readFileSync(mdPath(dir, 21), 'utf8'), mdBefore, 'derived .md unchanged (JSON write fails FIRST, before md regen)');
  assert.deepStrictEqual(tmpFiles(dir), [], 'no orphaned .tmp left behind');
  assert.deepStrictEqual(lockResidue(dir), [], 'the session lock was RELEASED on the throw (no .lock left behind)');
});

test('opPunchlist under a forced FSYNC fault: canonical JSON byte-unchanged, no orphan tmp, loud throw', () => {
  const dir = scratch('tpm-fault-');
  seed(dir, '0021');
  const jsonBefore = fs.readFileSync(jsonPath(dir, 21), 'utf8');

  let threw = false;
  withFailingFs('fsyncSync', () => {
    try {
      ops.opPunchlist({ sessionsDir: dir, number: '0021', action: 'add', text: 'must not persist', slug: 'nope01', now: NOW });
    } catch (e) {
      threw = true;
      assert.ok(/failed writing/.test(e.message), 'loud throw on an fsync fault, got: ' + e.message);
    }
  });

  assert.ok(threw, 'a mid-persist fsync fault must throw');
  assert.strictEqual(fs.readFileSync(jsonPath(dir, 21), 'utf8'), jsonBefore, 'canonical JSON is BYTE-UNCHANGED after the fsync fault');
  assert.ok(jsonBefore.indexOf('must not persist') === -1, 'sanity: the aborted item never reached the JSON');
  assert.deepStrictEqual(tmpFiles(dir), [], 'no orphaned .tmp left behind');
});

test('MUTATION check: WITHOUT the injected fault the same op persists (the fault test can observe a difference)', () => {
  const dir = scratch('tpm-fault-');
  seed(dir, '0021');
  const rec = ops.opNote({ sessionsDir: dir, number: '0021', type: 'log', status: 'NOTE', text: 'this DOES land', now: NOW });
  assert.strictEqual(rec.log[rec.log.length - 1].text, 'this DOES land', 'op returns the appended entry when no fault');
  assert.ok(fs.readFileSync(jsonPath(dir, 21), 'utf8').indexOf('this DOES land') !== -1, 'the note landed in the canonical JSON');
});

done('ops-persist-fault.test.js');
