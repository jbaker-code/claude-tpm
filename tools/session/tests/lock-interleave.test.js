'use strict';
/**
 * lock-interleave.test.js — lib/lock.js across REAL processes, using the interleaving seam
 * (tools/tests/lib/fs-barrier.js) to park a lock holder inside its critical section (DoD rows A, B, D).
 *
 * Max 3 children alive at once; every child has a hard 20 s timeout; every rendezvous polls with a deadline.
 * Assertions are on ordering (log order, absence of a log entry), never on durations. Children get a minimal
 * env (PATH + what the test passes) so no TPM_* / CLAUDE_* of the invoking session can reach them.
 *
 * Run: node tools/session/tests/lock-interleave.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const lock = require('../../lib/lock');
const barrier = require('../../tests/lib/fs-barrier');

const LOCKJS = path.resolve(__dirname, '..', '..', 'lib', 'lock.js');
const TOOLS = path.resolve(__dirname, '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-lock-il-'));
const live = new Set();

// ── the child script (written once) ──────────────────────────────────────────────────────────────────────────
const CHILD = path.join(root, 'child.js');
fs.writeFileSync(CHILD, `'use strict';
const lock = require(${JSON.stringify(LOCKJS)});
const fs = require('fs');
const cfg = JSON.parse(process.env.CFG);
const opts = Object.assign({ env: {}, label: 'tpm-test' }, cfg.opts || {});
const log = (s) => fs.appendFileSync(cfg.log, s);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
try {
  if (cfg.mode === 'hold') {
    lock.withLock(cfg.dir, () => { log(cfg.name + ':in\\n'); fs.readFileSync(cfg.marker); log(cfg.name + ':out\\n'); }, opts);
  } else if (cfg.mode === 'exit') {
    lock.withLock(cfg.dir, () => { process.exit(0); }, opts);
  } else if (cfg.mode === 'count') {
    for (let i = 0; i < cfg.cycles; i++) {
      lock.withLock(cfg.dir, () => {
        fs.writeFileSync(cfg.sentinel, String(process.pid), { flag: 'wx' });
        const v = Number(fs.readFileSync(cfg.counter, 'utf8'));
        nap(5);
        fs.writeFileSync(cfg.counter, String(v + 1));
        fs.unlinkSync(cfg.sentinel);
      }, opts);
    }
  } else if (cfg.mode === 'try') {
    lock.acquire(cfg.dir, opts).release();
  }
} catch (e) {
  process.stderr.write('CHILD-ERR ' + (e.code || e.name) + ': ' + e.message + '\\n');
  process.exit(e.code === 'ELOCK_TIMEOUT' ? 3 : 4);
}
`);

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
let seq = 0;
function scratch(name) { const d = path.join(root, name + '-' + (seq++)); fs.mkdirSync(d, { recursive: true }); return d; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, what) {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what); await sleep(15); }
}
function read(f) { try { return fs.readFileSync(f, 'utf8'); } catch (_e) { return ''; } }

/** Spawn the child script with cfg; stdout/stderr go to files. */
function run(dir, name, cfg, extraEnv) {
  const out = path.join(dir, name + '.out'); const errf = path.join(dir, name + '.err');
  const env = Object.assign({ PATH: process.env.PATH, CFG: JSON.stringify(Object.assign({ name }, cfg)) }, extraEnv || {});
  const child = spawn(process.execPath, [CHILD], { env, stdio: ['ignore', fs.openSync(out, 'w'), fs.openSync(errf, 'w')] });
  live.add(child);
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_e) { /* gone */ } }, 20000);
  const exited = new Promise((resolve) => child.on('close', (code, sig) => { clearTimeout(timer); live.delete(child); resolve({ code, sig }); }));
  return { child, pid: child.pid, exited, out, err: errf };
}

function parkedEnv(dir, marker) {
  return barrier.env({
    fn: 'readFileSync', pattern: marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', when: 'after',
    ready: path.join(dir, 'A.ready'), wait: path.join(dir, 'A.wait'), maxMs: 15000,
  });
}

function fixture(name) {
  const dir = scratch(name);
  const marker = path.join(dir, 'marker.txt'); fs.writeFileSync(marker, 'm');
  return { dir, lockDir: path.join(dir, 'store', '.lock'), marker, log: path.join(dir, 'log.txt') };
}

// ── mini async runner (same output shape as the sync harness) ─────────────────────────────────────────────────
const cases = []; let passed = 0; let failed = 0;
const test = (name, fn) => cases.push([name, fn]);

test('L-I1 the seam parks a holder; the lock blocks a second acquirer; they never interleave', async () => {
  const f = fixture('i1');
  const A = run(f.dir, 'A', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log }, parkedEnv(f.dir, f.marker));
  await waitFor(() => fs.existsSync(path.join(f.dir, 'A.ready')), 10000, 'A to park');
  const seenOwner = lock.inspect(f.lockDir, { env: {} });
  assert.strictEqual(seenOwner.state, 'held'); assert.strictEqual(seenOwner.owner.pid, A.pid);
  const B = run(f.dir, 'B', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log, opts: { waitMs: 10000, notifyAfterMs: 100 } });
  await sleep(600);
  assert.strictEqual(read(f.log), 'A:in\n', 'B has not entered its critical section while A is parked');
  assert.ok(new RegExp('waiting for lock .*pid ' + A.pid).test(read(B.err)), 'B says who it waits for: ' + read(B.err));
  fs.writeFileSync(path.join(f.dir, 'A.wait'), 'go');
  const [ra, rb] = await Promise.all([A.exited, B.exited]);
  assert.deepStrictEqual([ra.code, rb.code], [0, 0], read(A.err) + read(B.err));
  assert.strictEqual(read(f.log), 'A:in\nA:out\nB:in\nB:out\n');
  assert.ok(!fs.existsSync(f.lockDir)); assert.deepStrictEqual(fs.readdirSync(path.dirname(f.lockDir)), []);
});

test('L-I2 the seam is inert by default and its NODE_OPTIONS survives a path with a space', async () => {
  // (a) requiring it with no BARRIER_FN changes nothing
  assert.strictEqual(process.env.BARRIER_FN, undefined, 'precondition: run this file with no BARRIER_* set');
  const before = fs.readFileSync;
  delete require.cache[require.resolve('../../tests/lib/fs-barrier')];
  require('../../tests/lib/fs-barrier');
  assert.strictEqual(fs.readFileSync, before);
  // (b) the same holder WITHOUT NODE_OPTIONS runs straight through, even with BARRIER_READY/WAIT present
  const f = fixture('i2');
  const env = { BARRIER_READY: path.join(f.dir, 'A.ready'), BARRIER_WAIT: path.join(f.dir, 'A.wait'), BARRIER_PATTERN: 'marker', BARRIER_FN: 'readFileSync' };
  const t0 = Date.now();
  const A = run(f.dir, 'A', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log }, env);
  const r = await A.exited;
  assert.strictEqual(r.code, 0, read(A.err)); assert.ok(Date.now() - t0 < 5000, 'finished promptly');
  assert.ok(!fs.existsSync(path.join(f.dir, 'A.ready')), 'no rendezvous without the preload');
  assert.strictEqual(read(f.log), 'A:in\nA:out\n'); assert.ok(!fs.existsSync(f.lockDir));
  // (c) env() quotes the path; prove it with a copy under a directory whose name contains a space
  assert.strictEqual(barrier.env({}).NODE_OPTIONS, '-r "' + barrier.path + '"');
  const spaced = path.join(scratch('i2-space'), 'a b'); fs.mkdirSync(spaced);
  const copy = path.join(spaced, 'fs-barrier.js'); fs.copyFileSync(barrier.path, copy);
  const spacedEnv = require(copy).env({ fn: 'readFileSync', pattern: 'target\\.txt$', ready: path.join(f.dir, 'S.ready') });
  assert.strictEqual(spacedEnv.NODE_OPTIONS, '-r "' + fs.realpathSync(copy) + '"');
  assert.ok(/ /.test(copy), 'the fabricated path really contains a space');
  const target = path.join(f.dir, 'target.txt'); fs.writeFileSync(target, 'x');
  const s = spawnSync(process.execPath, ['-e', `require('fs').readFileSync(${JSON.stringify(target)})`], { env: Object.assign({ PATH: process.env.PATH }, spacedEnv), encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(s.status, 0, s.stderr); assert.ok(fs.existsSync(path.join(f.dir, 'S.ready')), 'the preload loaded from the spaced path');
});

test('L-I3 no production file references the seam', async () => {
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name === 'tests' || e.name === 'node_modules' || e.name === 'tmp') continue; walk(full); continue; }
      if (/\.test\.js$/.test(e.name) || !/\.(js|json|sh)$/.test(e.name)) continue;
      const src = fs.readFileSync(full, 'utf8');
      if (/BARRIER|fs-barrier|NODE_OPTIONS/.test(src)) hits.push(path.relative(TOOLS, full));
    }
  })(TOOLS);
  const ALLOWED = []; // pre-existing production mentions of NODE_OPTIONS before this phase: none
  assert.deepStrictEqual(hits.filter((h) => !ALLOWED.includes(h)), []);
});

test('L-I4 a holder that really dies (SIGKILL) is broken exactly once; two waiters then serialise', async () => {
  const f = fixture('i4');
  const A = run(f.dir, 'A', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log }, parkedEnv(f.dir, f.marker));
  await waitFor(() => fs.existsSync(path.join(f.dir, 'A.ready')), 10000, 'A to park');
  A.child.kill('SIGKILL');
  const ra = await A.exited; assert.strictEqual(ra.sig, 'SIGKILL');
  assert.ok(fs.existsSync(f.lockDir), 'the dead holder left its lock behind');
  const o = { waitMs: 15000 };
  const B = run(f.dir, 'B', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log, opts: o });
  const C = run(f.dir, 'C', { mode: 'hold', dir: f.lockDir, marker: f.marker, log: f.log, opts: o });
  const [rb, rc] = await Promise.all([B.exited, C.exited]);
  assert.deepStrictEqual([rb.code, rc.code], [0, 0], read(B.err) + read(C.err));
  const errs = read(B.err) + read(C.err);
  assert.strictEqual((errs.match(/breaking a stale lock/g) || []).length, 1, errs);
  assert.ok(new RegExp('held by pid ' + A.pid + ' ').test(errs) && errs.includes('process ' + A.pid + ' is not running'), errs);
  const logText = read(f.log).replace(/^A:in\n/, ''); // A entered, was parked, and was killed
  assert.ok(logText === 'B:in\nB:out\nC:in\nC:out\n' || logText === 'C:in\nC:out\nB:in\nB:out\n', 'never overlapping: ' + JSON.stringify(logText));
  assert.strictEqual(fs.readdirSync(path.dirname(f.lockDir)).filter((n) => n.startsWith('.lock.broken.')).length, 1);
  assert.ok(!fs.existsSync(f.lockDir));
});

test('L-I5 the exit safety net: process.exit() inside fn still releases the lock', async () => {
  const f = fixture('i5');
  const A = run(f.dir, 'A', { mode: 'exit', dir: f.lockDir, log: f.log });
  const r = await A.exited;
  assert.strictEqual(r.code, 0, read(A.err));
  assert.ok(!fs.existsSync(f.lockDir), 'lock gone after process.exit inside fn');
  assert.deepStrictEqual(fs.readdirSync(path.dirname(f.lockDir)), []);
  assert.strictEqual(read(A.err), '', 'silent');
});

test('L-I6 mutual exclusion under real concurrency: 3 processes x 5 read-sleep-write cycles lose nothing', async () => {
  const f = fixture('i6');
  const counter = path.join(f.dir, 'counter.txt'); fs.writeFileSync(counter, '0');
  const sentinel = path.join(f.dir, 'sentinel');
  const cfg = { mode: 'count', dir: f.lockDir, counter, sentinel, cycles: 5, log: f.log, opts: { waitMs: 20000 } };
  const kids = ['A', 'B', 'C'].map((n) => run(f.dir, n, cfg));
  const rs = await Promise.all(kids.map((k) => k.exited));
  assert.deepStrictEqual(rs.map((r) => r.code), [0, 0, 0], kids.map((k) => read(k.err)).join('\n'));
  assert.strictEqual(read(counter), '15'); assert.ok(!fs.existsSync(sentinel));
  assert.ok(!fs.existsSync(f.lockDir));
});

test('L-I7 a foreign-host lock is not judged by pid: a child acquirer times out and the lock is untouched', async () => {
  const f = fixture('i7');
  const dead = spawnSync(process.execPath, ['-e', '']).pid;
  fs.mkdirSync(f.lockDir, { recursive: true });
  fs.writeFileSync(path.join(f.lockDir, '.gitignore'), '*\n');
  const ownerJson = JSON.stringify({ schema: 1, nonce: 'foreign-nonce', pid: dead, host: 'some-other-host.example', at: require('../../lib/timestamp').nowIsoTz(), startedAt: null, version: null, verb: 'foreign', claudePid: null, claudeSessionId: null }, null, 2) + '\n';
  fs.writeFileSync(path.join(f.lockDir, 'owner.json'), ownerJson);
  const A = run(f.dir, 'A', { mode: 'try', dir: f.lockDir, log: f.log, opts: { waitMs: 800 } });
  const r = await A.exited;
  assert.strictEqual(r.code, 3, read(A.err)); assert.ok(/CHILD-ERR ELOCK_TIMEOUT/.test(read(A.err)));
  assert.strictEqual(read(path.join(f.lockDir, 'owner.json')), ownerJson); assert.ok(!/breaking/.test(read(A.err)));
});

(async () => {
  for (const [name, fn] of cases) {
    try { await fn(); passed++; console.log('  ok   - ' + name); } catch (e) {
      failed++; console.log('  FAIL - ' + name + '\n         ' + String(e && e.stack || e).split('\n').slice(0, 5).join('\n         '));
    }
  }
  for (const k of live) { try { k.kill('SIGKILL'); } catch (_e) { /* gone */ } }
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  console.log(`\nlock-interleave.test.js: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
