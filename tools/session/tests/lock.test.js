'use strict';
/**
 * lock.test.js — lib/lock.js, in-process (DoD rows A, B, D-part, F-part).
 *
 * Time is injected (`now` / `sleep` / `stderr` / `procInfo`), never waited on. Every case passes an explicit
 * env + hostname (never the ambient CLAUDE_* / TPM_* of the invoking session). Dead pids come from a child
 * that has already exited. "Foreign" / "stale" holders are crafted lock directories built with the
 * documented on-disk layout. The cross-process cases live in lock-interleave.test.js.
 *
 * Run: node tools/session/tests/lock.test.js
 */
const { assert, test, done, tmpDir, withFailingFs, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');
const lock = require('../../lib/lock');
const { nowIsoTz } = require('../../lib/timestamp');

const HOST = 'H';
const ownStartMs = Date.now() - process.uptime() * 1000;
const DEAD = spawnSync(process.execPath, ['-e', '']).pid;

function lockPath() { return path.join(tmpDir('tpm-lock-'), 'store', '.lock'); }
function parentOf(p) { return path.dirname(p); }

function mkClock(t0) {
  const c = { t: t0 === undefined ? Date.now() : t0, sleeps: [], hook: null };
  c.now = () => c.t;
  c.sleep = (ms) => { c.sleeps.push(ms); c.t += ms; if (c.hook) c.hook(c); };
  return c;
}

/** Common options: injected clock + stderr sink + explicit host/env. `extra` overrides. */
function opts(clk, err, extra) {
  return Object.assign({
    env: {}, hostname: HOST, label: 'tpm-test', now: clk.now, sleep: clk.sleep,
    stderr: (s) => { err.push(s); },
    procInfo: { isAlive: (pid) => pid === process.pid, startedAtMs: () => ownStartMs },
  }, extra || {});
}

/** Build a lock directory with the documented layout. `over` overrides owner fields (null deletes). */
function craft(dir, over, nowMs) {
  const t = nowMs === undefined ? Date.now() : nowMs;
  const o = Object.assign({
    schema: 1, nonce: 'crafted' + Math.random().toString(16).slice(2, 10), pid: process.pid, host: HOST,
    at: nowIsoTz(new Date(t)), startedAt: nowIsoTz(new Date(ownStartMs)), version: '9.9.9', verb: 'crafted-verb',
    claudePid: null, claudeSessionId: null,
  }, over || {});
  for (const k of Object.keys(o)) if (o[k] === null && over && over[k] === null && k in { startedAt: 1, at: 1, nonce: 1 }) delete o[k];
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify(o, null, 2) + '\n');
  return o;
}

function snapshot(dir) {
  const out = {};
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      const full = path.join(d, n); const r = rel ? rel + '/' + n : n;
      if (fs.lstatSync(full).isDirectory()) walk(full, r); else out[r] = fs.readFileSync(full, 'utf8');
    }
  };
  if (fs.lstatSync(dir).isDirectory()) walk(dir, ''); else out['<file>'] = fs.readFileSync(dir, 'utf8');
  return out;
}

function siblings(p) { return fs.readdirSync(parentOf(p)).filter((n) => n !== path.basename(p)); }
function brokenDirs(p) { return fs.readdirSync(parentOf(p)).filter((n) => n.startsWith(path.basename(p) + '.broken.')); }
function ownerOn(p) { return JSON.parse(fs.readFileSync(path.join(p, 'owner.json'), 'utf8')); }
function throws(fn, code) {
  try { fn(); } catch (e) { assert.ok(e instanceof lock.LockError, 'LockError, got ' + (e && e.stack)); assert.strictEqual(e.code, code, e.message); return e; }
  assert.fail('expected ' + code + ' but nothing was thrown');
}

// ───────────────────────────── acquire / release ─────────────────────────────

test('L-A1 acquire creates .lock with exactly .gitignore and a complete owner.json; no .new leftovers', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  const h = lock.acquire(p, opts(clk, err, {
    env: { CLAUDE_CODE_SESSION_ID: 'sess-1234abcd', CLAUDE_PID: '4242' }, verb: 'add', version: '1.2.3',
  }));
  assert.deepStrictEqual(fs.readdirSync(p).sort(), ['.gitignore', 'owner.json']);
  assert.strictEqual(fs.readFileSync(path.join(p, '.gitignore'), 'utf8'), '*\n');
  const o = ownerOn(p);
  assert.strictEqual(o.schema, 1);
  assert.ok(/^[0-9a-f]{24}$/.test(o.nonce), o.nonce);
  assert.strictEqual(o.pid, process.pid);
  assert.strictEqual(o.host, HOST);
  assert.ok(/[+-]\d{2}:\d{2}$/.test(o.at) && Number.isFinite(Date.parse(o.at)), o.at);
  assert.ok(/[+-]\d{2}:\d{2}$/.test(o.startedAt), o.startedAt);
  assert.ok(Math.abs(Date.parse(o.startedAt) - ownStartMs) < 3000);
  assert.strictEqual(o.version, '1.2.3'); assert.strictEqual(o.verb, 'add');
  assert.strictEqual(o.claudePid, 4242); assert.strictEqual(o.claudeSessionId, 'sess-1234abcd');
  assert.strictEqual(h.nonce, o.nonce); assert.strictEqual(h.lockDir, path.resolve(p));
  assert.deepStrictEqual(siblings(p), [], 'no .new.* leftovers');
  assert.deepStrictEqual(err, []);
  h.release();
});

test('L-A2 release removes the lock, leaves no .rel/.new; second release is a no-op; re-acquirable', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  const h = lock.acquire(p, opts(clk, err));
  assert.strictEqual(h.release(), undefined);
  assert.ok(!fs.existsSync(p)); assert.deepStrictEqual(siblings(p), []);
  assert.strictEqual(h.release(), undefined, 'second release is a no-op');
  lock.acquire(p, opts(clk, err)).release();
  assert.deepStrictEqual(err, []);
});

test('L-A3 acquire creates a missing nested parent directory', () => {
  const p = path.join(tmpDir('tpm-lock-'), 'a', 'b', 'c', '.lock'); const err = [];
  lock.acquire(p, opts(mkClock(), err)).release();
  assert.ok(fs.existsSync(path.join(parentOf(p))));
});

test('L-A4 not re-entrant: second acquire of the same path throws ELOCK_REENTRANT at once, never sleeps', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  const h = lock.acquire(p, opts(clk, err));
  throws(() => lock.acquire(p, opts(clk, err)), 'ELOCK_REENTRANT');
  throws(() => lock.tryAcquire(p, opts(clk, err)), 'ELOCK_REENTRANT');
  assert.deepStrictEqual(clk.sleeps, []);
  h.release();
  lock.acquire(p, opts(clk, err)).release();
});

test('L-A5 tryAcquire: null when held, a Handle when free, and it NEVER breaks a stale lock', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, {});
  assert.strictEqual(lock.tryAcquire(p, opts(clk, err)), null);
  fs.rmSync(p, { recursive: true });
  const h = lock.tryAcquire(p, opts(clk, err)); assert.ok(h && h.nonce); h.release();
  const dead = craft(p, { pid: DEAD, at: nowIsoTz(new Date(clk.t - 3600000)) });
  const before = snapshot(p);
  assert.strictEqual(lock.tryAcquire(p, opts(clk, err)), null);
  assert.deepStrictEqual(snapshot(p), before, 'stale lock untouched'); assert.strictEqual(dead.pid, DEAD);
  assert.deepStrictEqual(err, [], 'no stderr'); assert.deepStrictEqual(brokenDirs(p), []);
});

test('L-A6 un-committable by construction: .gitignore and owner.json are in the prepared dir BEFORE the rename', () => {
  const p = lockPath(); const err = []; const seen = [];
  const real = fs.renameSync;
  fs.renameSync = function spy(src, dst) { if (dst === path.resolve(p)) seen.push(fs.readdirSync(src).sort()); return real.apply(fs, arguments); };
  let h;
  try { h = lock.acquire(p, opts(mkClock(), err)); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(seen, [['.gitignore', 'owner.json']]);
  assert.deepStrictEqual(fs.readdirSync(p).sort(), ['.gitignore', 'owner.json']);
  h.release();
});

test('L-A7 a failing rename throws ELOCK_IO (with cause) and leaves no .new leftover', () => {
  const p = lockPath(); const err = [];
  let e;
  withFailingFs('renameSync', () => { e = throws(() => lock.acquire(p, opts(mkClock(), err)), 'ELOCK_IO'); });
  assert.ok(e.cause && e.cause.code === 'EIO');
  assert.deepStrictEqual(siblings(p), []); assert.ok(!fs.existsSync(p));
  withFailingFs('renameSync', () => { throws(() => lock.tryAcquire(p, opts(mkClock(), err)), 'ELOCK_IO'); });
  assert.deepStrictEqual(siblings(p), []);
});

test('L-A8 env overrides: TPM_LOCK_WAIT_MS / TPM_LOCK_STALE_MS apply; an option beats env; garbage is ignored', () => {
  const p = lockPath(); const err = [];
  craft(p, {}); // live, fresh
  // wait override
  let clk = mkClock();
  throws(() => lock.acquire(p, opts(clk, err, { env: { TPM_LOCK_WAIT_MS: '0' } })), 'ELOCK_TIMEOUT');
  assert.deepStrictEqual(clk.sleeps, []);
  clk = mkClock();
  throws(() => lock.acquire(p, opts(clk, err, { env: { TPM_LOCK_WAIT_MS: '0' }, waitMs: 100 })), 'ELOCK_TIMEOUT');
  assert.ok(clk.sleeps.length >= 1, 'explicit waitMs beats env wait 0');
  // stale override: a 2 s old live lock is stale under STALE_MS=1000
  const q = lockPath(); craft(q, {}, Date.now() - 2000);
  clk = mkClock();
  lock.acquire(q, opts(clk, err, { env: { TPM_LOCK_STALE_MS: '1000' } })).release();
  assert.ok(err.join('').includes('breaking a stale lock'));
  const r = lockPath(); craft(r, {}, Date.now() - 2000);
  throws(() => lock.acquire(r, opts(mkClock(), [], { env: { TPM_LOCK_STALE_MS: '1000' }, staleMs: 60000, waitMs: 100 })), 'ELOCK_TIMEOUT');
  // garbage values -> defaults (30 s stale, 45 s wait)
  for (const bad of ['abc', '-5', '0', '1.5', '', ' ']) {
    const g = lockPath(); craft(g, {}, Date.now() - 2000);
    const c2 = mkClock();
    const e = throws(() => lock.acquire(g, opts(c2, [], { env: { TPM_LOCK_STALE_MS: bad, TPM_LOCK_WAIT_MS: bad === '0' ? 'x' : bad } , waitMs: 200 })), 'ELOCK_TIMEOUT');
    assert.ok(/not stale yet \(stale after 30 s\)/.test(e.message), bad + ': ' + e.message);
  }
});

// ───────────────────────────── withLock ─────────────────────────────

test('L-W1 withLock returns fn\'s value, passes the Handle, and the lock is gone afterwards', () => {
  const p = lockPath(); let inside;
  const v = lock.withLock(p, (h) => { inside = fs.existsSync(path.join(p, 'owner.json')); return { got: h.nonce }; }, opts(mkClock(), []));
  assert.ok(inside); assert.ok(/^[0-9a-f]{24}$/.test(v.got)); assert.ok(!fs.existsSync(p)); assert.deepStrictEqual(siblings(p), []);
});

test('L-W2 withLock releases when fn throws and rethrows the SAME error object', () => {
  const p = lockPath(); const boom = new Error('boom');
  let caught;
  try { lock.withLock(p, () => { throw boom; }, opts(mkClock(), [])); } catch (e) { caught = e; }
  assert.strictEqual(caught, boom); assert.ok(!fs.existsSync(p)); assert.deepStrictEqual(siblings(p), []);
  lock.acquire(p, opts(mkClock(), [])).release(); // and it is acquirable again
});

test('L-W3 async fn: lock released + ELOCK_ARG; non-function fn: ELOCK_ARG and nothing touched', () => {
  const p = lockPath();
  const e = throws(() => lock.withLock(p, () => Promise.resolve(1), opts(mkClock(), [])), 'ELOCK_ARG');
  assert.ok(/synchronous/.test(e.message)); assert.ok(!fs.existsSync(p));
  const q = path.join(tmpDir('tpm-lock-'), 'never', '.lock');
  throws(() => lock.withLock(q, 'nope', opts(mkClock(), [])), 'ELOCK_ARG');
  assert.ok(!fs.existsSync(path.dirname(q)), 'nothing created');
  throws(() => lock.acquire('', opts(mkClock(), [])), 'ELOCK_ARG');
  throws(() => lock.acquire(null, opts(mkClock(), [])), 'ELOCK_ARG');
});

// ───────────────────────────── contention ─────────────────────────────

test('L-C1 wait-then-proceed: sleeps 3 times within [pollMin,pollMax], prints the waiting line once, then wins', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, {});
  clk.hook = (c) => { if (c.sleeps.length === 3) fs.rmSync(p, { recursive: true }); };
  const h = lock.acquire(p, opts(clk, err, { notifyAfterMs: 0 }));
  assert.strictEqual(clk.sleeps.length, 3);
  for (const s of clk.sleeps) assert.ok(s >= 20 && s <= 50, 'poll ' + s);
  const waiting = err.filter((x) => x.includes('waiting for lock'));
  assert.strictEqual(waiting.length, 1);
  assert.ok(/held by pid \d+ on host H, verb crafted-verb/.test(waiting[0]), waiting[0]);
  assert.strictEqual(ownerOn(p).pid, process.pid); h.release();
});

test('L-C2 fail loud: a live fresh holder -> ELOCK_TIMEOUT naming the holder; the lock is untouched', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  const o = craft(p, {}); const before = snapshot(p);
  const e = throws(() => lock.acquire(p, opts(clk, err, { waitMs: 200 })), 'ELOCK_TIMEOUT');
  for (const tok of [`pid ${process.pid}`, 'host H', 'verb crafted-verb', 'not stale yet', 'tpm-test:', 'gave up waiting']) assert.ok(e.message.includes(tok), tok + ' in ' + e.message);
  assert.strictEqual(e.owner.nonce, o.nonce); assert.strictEqual(e.lockDir, path.resolve(p));
  assert.deepStrictEqual(snapshot(p), before); assert.deepStrictEqual(brokenDirs(p), []);
  assert.deepStrictEqual(siblings(p), [], 'no .new leftovers after a timeout');
});

test('L-C3 a lock younger than staleMs held by a live pid is never broken, however many polls', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, {});
  throws(() => lock.acquire(p, opts(clk, err, { waitMs: 20000 })), 'ELOCK_TIMEOUT');
  assert.ok(clk.sleeps.length > 300, 'many polls: ' + clk.sleeps.length);
  assert.ok(!err.join('').includes('breaking'), 'no break'); assert.deepStrictEqual(brokenDirs(p), []);
});

test('L-C4 waitMs:0 makes exactly one attempt and times out without sleeping', () => {
  const p = lockPath(); const clk = mkClock();
  craft(p, {});
  throws(() => lock.acquire(p, opts(clk, [], { waitMs: 0 })), 'ELOCK_TIMEOUT');
  assert.deepStrictEqual(clk.sleeps, []);
  fs.rmSync(p, { recursive: true });
  lock.acquire(p, opts(clk, [], { waitMs: 0 })).release(); // free lock: still acquirable with waitMs 0
});

// ───────────────────────────── stale rules ─────────────────────────────

test('L-S1 dead holder (same host): broken after confirmMs of the same verdict; named on stderr; kept as .broken.*; we hold it', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  const o = craft(p, { pid: DEAD });
  const h = lock.acquire(p, opts(clk, err));
  const text = err.join('');
  assert.ok(text.includes('breaking a stale lock'), text);
  assert.ok(text.includes(`pid ${DEAD}`) && text.includes('host H'), text);
  assert.ok(text.includes(`reason: process ${DEAD} is not running`), text);
  assert.strictEqual(brokenDirs(p).length, 1);
  assert.strictEqual(ownerOn(path.join(parentOf(p), brokenDirs(p)[0])).nonce, o.nonce);
  assert.strictEqual(ownerOn(p).pid, process.pid); assert.notStrictEqual(ownerOn(p).nonce, o.nonce);
  assert.ok(clk.sleeps.length >= 2, 'at least two confirming polls: ' + clk.sleeps.length);
  h.release();
});

test('L-S2 reused pid (live pid, start time an hour off): broken after confirmMs, reason says reused', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, { pid: process.pid });
  const h = lock.acquire(p, opts(clk, err, { procInfo: { isAlive: () => true, startedAtMs: () => ownStartMs + 3600000 } }));
  assert.ok(/reason: process \d+ was reused/.test(err.join('')), err.join(''));
  assert.ok(clk.sleeps.length >= 2); h.release();
});

test('L-S3 live holder with matching start, fresh: NOT broken; start time probed at most once per nonce', () => {
  const p = lockPath(); const clk = mkClock(); const err = []; let probes = 0;
  craft(p, {});
  throws(() => lock.acquire(p, opts(clk, err, { waitMs: 600, procInfo: { isAlive: () => true, startedAtMs: () => { probes++; return ownStartMs; } } })), 'ELOCK_TIMEOUT');
  assert.ok(clk.sleeps.length >= 5); assert.strictEqual(probes, 1); assert.ok(!err.join('').includes('breaking'));
});

test('L-S4 live holder older than staleMs: broken at once (no confirm delay) with the age reason', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, {}, clk.t - 40000);
  const h = lock.acquire(p, opts(clk, err));
  assert.deepStrictEqual(clk.sleeps, [], 'no waiting at all');
  assert.ok(/reason: held for 4\d s \(stale after 30 s\)/.test(err.join('')), err.join(''));
  h.release();
});

test('L-S5 foreign host, pid of an exited process, fresh: NOT broken, liveness never consulted', () => {
  const p = lockPath(); const clk = mkClock(); let alive = 0;
  craft(p, { host: 'OTHER', pid: DEAD }); const before = snapshot(p);
  throws(() => lock.acquire(p, opts(clk, [], { waitMs: 400, procInfo: { isAlive: () => { alive++; return false; }, startedAtMs: () => null } })), 'ELOCK_TIMEOUT');
  assert.strictEqual(alive, 0); assert.deepStrictEqual(snapshot(p), before);
});

test('L-S6 foreign host older than staleMs: broken, stderr names the foreign host', () => {
  const p = lockPath(); const clk = mkClock(); const err = [];
  craft(p, { host: 'OTHER', pid: DEAD }, clk.t - 45000);
  lock.acquire(p, opts(clk, err)).release();
  assert.ok(/held by pid \d+ on host OTHER/.test(err.join('')), err.join(''));
  assert.ok(/reason: held for 4\d s/.test(err.join('')));
});

test('L-S7 an owner record that is missing / empty / invalid is NEVER stale, however old; timeout says remove by hand', () => {
  const old = new Date(Date.now() - 365 * 86400000);
  const variants = {
    'owner.json missing': (p) => { craft(p, {}); fs.rmSync(path.join(p, 'owner.json')); },
    'owner.json empty': (p) => { craft(p, {}); fs.writeFileSync(path.join(p, 'owner.json'), ''); },
    'owner.json "{"': (p) => { craft(p, {}); fs.writeFileSync(path.join(p, 'owner.json'), '{'); },
    'owner.json "{}"': (p) => { craft(p, {}); fs.writeFileSync(path.join(p, 'owner.json'), '{}'); },
    'pid 0': (p) => { craft(p, { pid: 0, at: nowIsoTz(old) }); },
    'unparseable at': (p) => { craft(p, { at: 'yesterday-ish' }); },
    '.lock is a plain file': (p) => { fs.mkdirSync(parentOf(p), { recursive: true }); fs.writeFileSync(p, 'x'); },
  };
  for (const [name, build] of Object.entries(variants)) {
    const p = lockPath(); build(p);
    try { fs.utimesSync(p, old, old); } catch (_e) { /* ignore */ }
    const before = snapshot(p); const err = [];
    const e = throws(() => lock.acquire(p, opts(mkClock(), err, { waitMs: 150 })), 'ELOCK_TIMEOUT');
    assert.ok(/cannot be judged stale/.test(e.message) && /by hand/.test(e.message), name + ': ' + e.message);
    assert.deepStrictEqual(snapshot(p), before, name + ': untouched'); assert.deepStrictEqual(brokenDirs(p), [], name);
    assert.ok(!err.join('').includes('breaking'), name);
    assert.strictEqual(lock.inspect(p, opts(mkClock(), [])).state, 'incomplete', name);
    assert.strictEqual(lock.tryAcquire(p, opts(mkClock(), [])), null, name);
  }
});

test('L-S8 breakLock ABA: a lock swapped in right before the rename is put back, loudly; an impossible restore says so', () => {
  const p = lockPath(); const err = [];
  // pre-check: a different nonce already on disk is left alone, silently, with no rename at all
  const fresh = craft(p, { nonce: 'fresh-nonce' });
  assert.deepStrictEqual(lock.breakLock(p, 'judged-nonce', 'because', opts(mkClock(), err)), { broken: false, restored: false });
  assert.strictEqual(ownerOn(p).nonce, fresh.nonce); assert.deepStrictEqual(brokenDirs(p), []); assert.deepStrictEqual(err, []);
  // ABA proper: the judged lock is swapped for a fresh one between the pre-check and the rename
  const swapIn = (nonce) => { fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify(Object.assign(ownerOn(p), { nonce }))); };
  const real = fs.renameSync; let n = 0;
  fs.renameSync = function spy(src, dst) { if (n++ === 0 && src === path.resolve(p)) swapIn('swapped-nonce'); return real.apply(fs, arguments); };
  let r;
  try { r = lock.breakLock(p, fresh.nonce, 'because', opts(mkClock(), err)); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(r, { broken: false, restored: true });
  assert.strictEqual(ownerOn(p).nonce, 'swapped-nonce'); assert.deepStrictEqual(brokenDirs(p), []);
  assert.ok(/displaced a lock that was not the stale one/.test(err.join('')) && /put it back/.test(err.join('')), err.join(''));
  // restore impossible: a new lock appears at the final name right after the aside rename
  const err2 = []; let raced = 0; n = 0;
  fs.renameSync = function spy(src, dst) {
    if (n++ === 0 && src === path.resolve(p)) swapIn('swapped-again');
    const rv = real.apply(fs, arguments);
    if (!raced && src === path.resolve(p)) { raced = 1; craft(p, { nonce: 'newcomer' }); }
    return rv;
  };
  let r2;
  try { r2 = lock.breakLock(p, 'swapped-nonce', 'because', opts(mkClock(), err2)); } finally { fs.renameSync = real; }
  assert.deepStrictEqual(r2, { broken: false, restored: false });
  assert.ok(/could not put it back/.test(err2.join('')), err2.join(''));
  assert.strictEqual(ownerOn(p).nonce, 'newcomer');
  // and the plain case: matching nonce breaks; vanished lock is a quiet no-op
  const q = lockPath(); const o = craft(q, { pid: DEAD }); const err3 = [];
  assert.deepStrictEqual(lock.breakLock(q, o.nonce, 'dead', opts(mkClock(), err3)), { broken: true, restored: false });
  assert.ok(!fs.existsSync(q) && brokenDirs(q).length === 1);
  assert.deepStrictEqual(lock.breakLock(q, o.nonce, 'dead', opts(mkClock(), [])), { broken: false, restored: false });
});

test('L-S9 clock skew: a future-dated foreign lock is broken once THIS waiter has observed it for staleMs, not before', () => {
  const p = lockPath(); const clk = mkClock(); const err = []; const t0 = clk.t; let brokeAt = null;
  craft(p, { host: 'OTHER' }, clk.t + 3600000);
  const h = lock.acquire(p, opts(clk, err, { waitMs: 60000, stderr: (s) => { err.push(s); if (brokeAt === null && s.includes('breaking')) brokeAt = clk.t - t0; } }));
  assert.ok(brokeAt !== null && brokeAt >= 30000 && brokeAt < 30100, 'broke at +' + brokeAt + ' ms');
  h.release();
});

test('L-S10 confirmation: a dead verdict must hold for confirmMs on the SAME nonce', () => {
  // (b) fixed 25 ms polls: no break at +75, a break at +100
  let p = lockPath(); let clk = mkClock(); const t0 = clk.t; let at = null;
  craft(p, { pid: DEAD });
  lock.acquire(p, opts(clk, [], { pollMinMs: 25, pollMaxMs: 25, confirmMs: 100, stderr: (s) => { if (at === null && s.includes('breaking')) at = clk.t - t0; } })).release();
  assert.strictEqual(at, 100, 'broke at +' + at);
  // (a) the nonce changes to a live holder between polls: pending verdict discarded, nothing broken
  p = lockPath(); clk = mkClock(); const err = [];
  craft(p, { pid: DEAD });
  clk.hook = (c) => { if (c.sleeps.length === 1) { fs.rmSync(p, { recursive: true }); craft(p, { pid: process.pid, nonce: 'live-newcomer' }, c.t); } };
  throws(() => lock.acquire(p, opts(clk, err, { waitMs: 400, confirmMs: 100 })), 'ELOCK_TIMEOUT');
  assert.ok(!err.join('').includes('breaking')); assert.strictEqual(ownerOn(p).nonce, 'live-newcomer');
});

test('L-S11 inspect shares the rule: none / held / stale / incomplete, leftovers and gitignore reported', () => {
  const clk = mkClock(); const o = () => opts(clk, []);
  const p = lockPath();
  assert.strictEqual(lock.inspect(p, o()).state, 'none');
  craft(p, {});
  let r = lock.inspect(p, o());
  assert.strictEqual(r.state, 'held'); assert.strictEqual(r.stale.stale, false); assert.strictEqual(r.gitignore, true);
  assert.strictEqual(r.owner.pid, process.pid); assert.ok(r.ageMs >= 0 && r.ageMs < 5000);
  fs.rmSync(p, { recursive: true }); craft(p, { pid: DEAD });
  r = lock.inspect(p, o()); assert.strictEqual(r.state, 'stale'); assert.strictEqual(r.stale.reason, 'dead');
  fs.rmSync(p, { recursive: true }); craft(p, { host: 'OTHER' }, clk.t - 60000);
  r = lock.inspect(p, o()); assert.strictEqual(r.state, 'stale'); assert.strictEqual(r.stale.reason, 'old');
  fs.rmSync(path.join(p, '.gitignore')); fs.rmSync(path.join(p, 'owner.json'));
  r = lock.inspect(p, o()); assert.strictEqual(r.state, 'incomplete'); assert.strictEqual(r.gitignore, false); assert.strictEqual(r.owner, null);
  const base = path.basename(p);
  for (const n of ['.new.1.aa', '.rel.1.bb', '.broken.1.2']) fs.mkdirSync(p + n);
  fs.mkdirSync(path.join(parentOf(p), 'unrelated'));
  assert.deepStrictEqual(lock.inspect(p, o()).leftovers, [base + '.broken.1.2', base + '.new.1.aa', base + '.rel.1.bb']);
  assert.strictEqual(lock.isStale(craft(lockPath(), { pid: DEAD }), { nowMs: clk.t, staleMs: 30000, hostname: HOST, procInfo: o().procInfo }).reason, 'dead');
});

// ───────────────────────────── loss detection ─────────────────────────────

function stealNonce(p) { // replace the owner record behind a held lock with a different holder
  const o = ownerOn(p); o.nonce = 'thief-' + o.nonce.slice(6); o.pid = process.pid + 1; fs.writeFileSync(path.join(p, 'owner.json'), JSON.stringify(o)); return o;
}

test('L-R1 loss detection: release throws ELOCK_LOST, prints the lost block, leaves the foreign lock alone', () => {
  const p = lockPath(); const err = [];
  const h = lock.acquire(p, opts(mkClock(), err, { lostHint: 'run the doctor' }));
  const thief = stealNonce(p);
  const e = throws(() => h.release(), 'ELOCK_LOST');
  assert.ok(/lost the lock/.test(e.message) && /run the doctor/.test(e.message) && /held by pid/.test(e.message), e.message);
  assert.ok(err.join('').includes('lost the lock')); assert.strictEqual(ownerOn(p).nonce, thief.nonce, 'foreign lock not removed');
  assert.strictEqual(h.release(), undefined, 'idempotent after loss');
  // withLock: fn succeeded -> ELOCK_LOST surfaces; fn threw -> the original error wins, lost block still printed
  fs.rmSync(p, { recursive: true }); const err2 = [];
  throws(() => lock.withLock(p, () => { stealNonce(p); return 1; }, opts(mkClock(), err2)), 'ELOCK_LOST');
  assert.ok(err2.join('').includes('lost the lock'));
  fs.rmSync(p, { recursive: true }); const err3 = []; const boom = new Error('fn failed'); let caught;
  try { lock.withLock(p, () => { stealNonce(p); throw boom; }, opts(mkClock(), err3)); } catch (x) { caught = x; }
  assert.strictEqual(caught, boom); assert.ok(err3.join('').includes('lost the lock'));
});

test('L-R2 release when the lock directory is already gone -> ELOCK_LOST (absent)', () => {
  const p = lockPath(); const err = [];
  const h = lock.acquire(p, opts(mkClock(), err));
  fs.rmSync(p, { recursive: true });
  const e = throws(() => h.release(), 'ELOCK_LOST');
  assert.ok(/absent/.test(e.message), e.message);
});

// ───────────────────────────── contract ─────────────────────────────

test('L-M1 message contract: tokens of every stderr block / error message, label and lostHint echoed', () => {
  const p = lockPath(); const err = []; const clk = mkClock();
  craft(p, { pid: DEAD });
  lock.acquire(p, opts(clk, err, { lostHint: 'HINT-TEXT', notifyAfterMs: 0 })).release();
  const t = err.join('');
  for (const tok of ['tpm-test: breaking a stale lock', 'held by pid', 'taken ', 'reason: ', 'moved to ', 'HINT-TEXT']) assert.ok(t.includes(tok), tok + ' in ' + t);
  for (const block of err) assert.ok(block.endsWith('\n'), 'each block ends with a newline');
  const q = lockPath(); craft(q, {});
  const w = []; throws(() => lock.acquire(q, opts(mkClock(), w, { waitMs: 100, notifyAfterMs: 0 })), 'ELOCK_TIMEOUT');
  assert.ok(w.some((b) => /^tpm-test: waiting for lock .* \(held by pid \d+ on host H, verb crafted-verb, version 9\.9\.9, for \d+ s\)\n$/.test(b)), w.join('|'));
  const re = throws(() => { const a = lock.acquire(lockPath(), opts(mkClock(), [])); lock.acquire(a.lockDir, opts(mkClock(), [])); }, 'ELOCK_REENTRANT');
  assert.ok(/not re-entrant/.test(re.message) && /^tpm-test:/.test(re.message));
  const io = withFailingFs('renameSync', () => throws(() => lock.acquire(lockPath(), opts(mkClock(), [])), 'ELOCK_IO'));
  assert.ok(/^tpm-test: cannot take lock .*: injected fs\.renameSync failure$/.test(io.message), io.message);
  const lost = lockPath(); const h = lock.acquire(lost, opts(mkClock(), [], { lostHint: 'HINT2' })); stealNonce(lost);
  const le = throws(() => h.release(), 'ELOCK_LOST'); assert.ok(/HINT2/.test(le.message));
});

test('L-M2 CODES is frozen with the five codes; LockError carries name, code, lockDir, owner', () => {
  assert.ok(Object.isFrozen(lock.CODES) && Object.isFrozen(lock.DEFAULTS));
  assert.deepStrictEqual(Object.keys(lock.CODES).sort(), ['ELOCK_ARG', 'ELOCK_IO', 'ELOCK_LOST', 'ELOCK_REENTRANT', 'ELOCK_TIMEOUT']);
  for (const [k, v] of Object.entries(lock.CODES)) assert.strictEqual(k, v);
  assert.strictEqual(lock.DEFAULTS.waitMs, 45000); assert.strictEqual(lock.DEFAULTS.staleMs, 30000);
  const e = new lock.LockError('ELOCK_ARG', 'm', { lockDir: '/x', owner: { a: 1 } });
  assert.ok(e instanceof Error); assert.strictEqual(e.name, 'LockError'); assert.strictEqual(e.code, 'ELOCK_ARG');
  assert.strictEqual(e.lockDir, '/x'); assert.deepStrictEqual(e.owner, { a: 1 });
});

test('L-X1 import hygiene: no tools/session|task|workflow imports, no third-party modules, no destructured fs', () => {
  for (const f of ['lock.js', 'identity.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      assert.ok(['fs', 'os', 'path', 'crypto', 'child_process', './timestamp', './identity'].includes(r), f + ' requires ' + r);
      assert.ok(!/(session|task|workflow)/.test(r), f + ' requires ' + r);
    }
    assert.ok(!/const\s*\{[^}]*\}\s*=\s*require\(\s*['"]fs['"]\s*\)/.test(src), f + ' destructures fs');
    assert.ok(!/(from|import)\s+['"]/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')), f + ' uses ESM import');
  }
});

done('lock.test.js');
