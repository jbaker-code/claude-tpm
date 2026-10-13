'use strict';
/**
 * session-current.test.js — the RESTORED current-session pointer + allocator (#1123 Stage C gap-fix).
 *
 * tpm-session-current.js owns "is a session open, and which number?" + allocating the next
 * `session-NNNN`. Restored from safe-to-delete (Stage A over-removed it). This suite pins the
 * claims the skill's bare-invocation state check + the open ritual depend on: allocation (highest
 * existing +1, padded-4, counting 3-digit legacy folders too), idempotent open, seal → not-opened,
 * and graceful degradation with $CLAUDE_CODE_SESSION_ID unset.
 *
 * Zero deps; hermetic (fresh OS-tmp sandbox per case). Exits non-zero on any failure.
 *
 * Run: node tests/session-current.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');

const cs = require('../tpm-session-current');
const TOOL = path.join(__dirname, '..', 'tpm-session-current.js');

function runCli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ── allocateNextNumber ──────────────────────────────────────────────────────────

test('allocateNextNumber returns "0001" (padded-4) on a non-existent sessionsDir', () => {
  const sessionsDir = path.join(tmpDir('cur-empty-'), 'sessions'); // deliberately not created
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir }), '0001');
});

test('allocateNextNumber = highest existing session-NNNN + 1, zero-padded to 4', () => {
  const dir = tmpDir('cur-existing-');
  for (const n of ['session-0001', 'session-0002', 'session-0007']) fs.mkdirSync(path.join(dir, n), { recursive: true });
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir: dir }), '0008');
});

test('allocateNextNumber counts a 3-digit legacy session-019 → next is "0020", not a restart at 0001', () => {
  const dir = tmpDir('cur-continuity-');
  fs.mkdirSync(path.join(dir, 'session-019'), { recursive: true });
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir: dir }), '0020');
});

test('allocateNextNumber ignores non-matching names + non-directory entries', () => {
  const dir = tmpDir('cur-noise-');
  fs.mkdirSync(path.join(dir, 'session-0003'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'not-a-session'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'session-0010'), 'a FILE, not a dir');
  assert.strictEqual(cs.allocateNextNumber({ sessionsDir: dir }), '0004');
});

// ── resolve / open / seal ─────────────────────────────────────────────────────

test('resolveCurrentSession reports not-opened when no pointer exists', () => {
  const r = cs.resolveCurrentSession({ sessionsDir: tmpDir('cur-nopointer-') });
  assert.strictEqual(r.state, 'not-opened');
  assert.strictEqual(r.number, null);
});

test('openSession on an empty dir allocates "0001", writes the pointer, isNew:true', () => {
  const dir = tmpDir('cur-open-');
  const r = cs.openSession({ sessionsDir: dir });
  assert.strictEqual(r.number, '0001');
  assert.strictEqual(r.isNew, true);
  assert.ok(fs.existsSync(path.join(dir, '.current-session.json')), 'pointer must be written');
});

test('openSession is idempotent — a second call returns the SAME number + isNew:false', () => {
  const dir = tmpDir('cur-idem-');
  const first = cs.openSession({ sessionsDir: dir });
  const second = cs.openSession({ sessionsDir: dir });
  assert.strictEqual(second.number, first.number);
  assert.strictEqual(second.isNew, false);
});

// Test helper: seal the lone record the way `close` does (stamp meta.closedAt on the track's own record).
function closeRecord(recordPath) {
  const model = require('../lib/session-model');
  model.saveSession(model.closeSession(model.loadSession(recordPath)), { jsonPath: recordPath });
}

test('sealSession stamps closedAt and flips resolveCurrentSession back to not-opened', () => {
  const dir = tmpDir('cur-seal-');
  const opened = cs.openSession({ sessionsDir: dir });
  closeRecord(opened.recordPath);   // tracks store: --seal closes the hint only when no track is unsealed
  const sealed = cs.sealSession({ sessionsDir: dir });
  assert.strictEqual(sealed.number, opened.number);
  assert.ok(sealed.closedAt, 'closedAt stamped');
  assert.strictEqual(cs.resolveCurrentSession({ sessionsDir: dir }).state, 'not-opened');
});

test('--open now creates the session FOLDER and the track-a RECORD (the documented boot flaw: record never created)', () => {
  const dir = tmpDir('cur-open-creates-');
  const r = cs.openSession({ sessionsDir: dir });
  assert.ok(fs.existsSync(path.join(dir, 'session-0001', 'session-0001.json')), 'record created, track a unsuffixed');
  assert.ok(fs.existsSync(path.join(dir, 'session-0001', 'session-0001.md')), 'derived md created');
  assert.strictEqual(r.track, 'a');
  assert.strictEqual(r.recordPath, path.join(dir, 'session-0001', 'session-0001.json'));
});

test('--seal while a track is still unsealed leaves the HINT open (DoD E: no blind stamp)', () => {
  const dir = tmpDir('cur-seal-open-');
  cs.openSession({ sessionsDir: dir });
  const sealed = cs.sealSession({ sessionsDir: dir });
  assert.strictEqual(sealed.hintClosed, false);
  assert.strictEqual(sealed.closedAt, null);
  assert.deepStrictEqual(sealed.unsealed, [{ number: '0001', track: 'a' }]);
  const hint = JSON.parse(fs.readFileSync(path.join(dir, '.current-session.json'), 'utf8'));
  assert.strictEqual(hint.closedAt, null);
});

test('sealSession throws ENOTHING_OPEN when nothing is open', () => {
  const dir = tmpDir('cur-seal-nothing-');
  assert.throws(() => cs.sealSession({ sessionsDir: dir }), (err) => err.code === 'ENOTHING_OPEN');
});

test('graceful degradation — open with $CLAUDE_CODE_SESSION_ID unset records sessionId:null', () => {
  const dir = tmpDir('cur-degrade-');
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  delete process.env.CLAUDE_CODE_SESSION_ID;
  try {
    const r = cs.openSession({ sessionsDir: dir });
    assert.strictEqual(r.sessionId, null);
    assert.strictEqual(r.isNew, true);
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID;
    else process.env.CLAUDE_CODE_SESSION_ID = prev;
  }
});

// ── CLI surface (subprocess, real exit codes) ────────────────────────────────────

test('CLI --next-number prints the allocation with NO side effect', () => {
  const dir = tmpDir('cur-cli-next-');
  const r = runCli(['--sessions-dir', dir, '--next-number']);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stdout.trim(), '0001');
  assert.ok(!fs.existsSync(path.join(dir, '.current-session.json')), '--next-number must not write a pointer');
});

test('CLI --open then --seal then --state round-trips to not-opened', () => {
  const dir = tmpDir('cur-cli-life-');
  const opened = runCli(['--sessions-dir', dir, '--open']);
  assert.strictEqual(opened.code, 0);
  closeRecord(JSON.parse(opened.stdout).recordPath);
  assert.strictEqual(runCli(['--sessions-dir', dir, '--seal']).code, 0);
  const stateR = runCli(['--sessions-dir', dir, '--state']);
  assert.strictEqual(JSON.parse(stateR.stdout).state, 'not-opened');
});

test('CLI exits 1 with no side effect when --sessions-dir is omitted OUTSIDE a project', () => {
  // Run from a bare dir with NO `.claude/claude-tpm/` marker up-tree so the resolver must refuse
  // (post marker-swap, the repo root carries the marker and would resolve the safe default instead).
  const outside = tmpDir('cur-no-marker-');
  const raw = spawnSync(process.execPath, [TOOL, '--state'], { encoding: 'utf8', cwd: outside });
  const r = { code: raw.status, stdout: raw.stdout || '', stderr: raw.stderr || '' };
  assert.strictEqual(r.code, 1);
  assert.ok(/--sessions-dir is required/.test(r.stderr));
});

done('session-current.test');
