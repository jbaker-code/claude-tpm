'use strict';
/**
 * lock.js — a directory lock for the file-backed stores (kind-agnostic, synchronous).
 *
 * Several Claude sessions can run tpm verbs against one store at once. This serialises their writes: one
 * holder at a time, everyone else waits (bounded), a dead holder's lock is broken LOUDLY, and nothing is ever
 * silently lost. The lock is a DIRECTORY (`<parent>/.lock`) taken by an atomic rename — no `flock`, no
 * advisory locking, no third-party code.
 *
 * API  (lockDir = the FINAL lock path, e.g. `<tasksDir>/.lock`; its parent is created if missing)
 *   acquire(lockDir, opts?)      -> Handle         waits (polls) up to waitMs; throws LockError
 *   tryAcquire(lockDir, opts?)   -> Handle | null  ONE attempt, never waits, never breaks a stale lock
 *   withLock(lockDir, fn, opts?) -> fn's value     acquire, run fn(handle) SYNCHRONOUSLY, always release
 *   inspect(lockDir, opts?)      -> { state, owner, ageMs, stale, leftovers, gitignore }   read-only (doctor)
 *   readOwner(lockDir, opts?)    -> { status: 'absent'|'ok'|'incomplete', owner }           read-only
 *   isStale(owner, ctx)          -> { stale, reason: 'dead'|'reused'|'old'|null, detail }   THE stale rule
 *   breakLock(lockDir, expectedNonce, reason, opts?) -> { broken, restored }
 *   LockError (code, lockDir, owner, cause), CODES, DEFAULTS
 *   Handle = { lockDir, nonce, owner, release() }   release() is idempotent; may throw ELOCK_LOST
 *
 * Options (all optional): waitMs 45000 · staleMs 30000 · pollMinMs/pollMaxMs 20/50 (jittered) · confirmMs 100 ·
 *   notifyAfterMs 2000 · pidTolMs 2000 · verb · version (the caller's tpm version -> payload `version`) ·
 *   label 'tpm-lock' (stderr prefix) · lostHint · env · hostname · now · sleep · stderr · procInfo.
 *   Env overrides (when the option is absent): TPM_LOCK_WAIT_MS (>= 0), TPM_LOCK_STALE_MS (> 0); anything
 *   else is ignored. Precedence: explicit option > env > default.
 *
 * On disk
 *   <parent>/.lock/               the held lock; only ever exists NON-empty
 *     .gitignore                  "*\n" — the directory ignores itself, so it can never be committed
 *     owner.json                  { schema, nonce, pid, host, at, startedAt, version, verb, claudePid, claudeSessionId }
 *   <parent>/.lock.new.<pid>.<rand>/     an acquirer's preparation dir, renamed to .lock on success
 *   <parent>/.lock.rel.<pid>.<rand>/     a released lock mid-deletion
 *   <parent>/.lock.broken.<pid>.<ms>/    a broken stale lock, KEPT for the doctor
 *
 * Acquire = build a fully prepared directory (.gitignore, then owner.json), then rename it onto `.lock`.
 * A rename onto a non-empty directory fails (ENOTEMPTY), so exactly one racer wins and the lock never exists
 * without its owner record. Release and break are renames too (rename aside, then check the nonce), so there
 * is no window in which a half-removed lock looks held. A breaker re-reads the nonce just before it renames, and
 * checks it again after, so it can only displace a freshly taken lock in a microsecond window (and then puts it back).
 *
 * Stale rules (isStale; first match wins; an owner record that is missing/empty/invalid is NEVER stale):
 *   1. same host and the pid is not running              -> 'dead'    (broken after confirmMs of the same verdict)
 *   2. same host, pid running but its start time differs from the recorded startedAt by > pidTolMs -> 'reused'
 *   3. any host, held >= staleMs (or observed that long by this waiter, which defends against clock skew) -> 'old'
 *   A different host is never judged by pid. A lock younger than staleMs held by a live pid is never broken.
 *   Every break writes a block to stderr naming the previous holder and why. The holder re-checks its nonce at
 *   release and reports ELOCK_LOST if its lock was taken from under it.
 *
 * Guarantees: withLock releases even when fn throws (the original error is rethrown unchanged); the lock is not
 * re-entrant (ELOCK_REENTRANT at once, not a 45 s hang); a best-effort `process.on('exit')` hook releases a lock
 * still held when the process calls process.exit() (no signal handlers are installed; SIGKILL leaves the lock
 * for the dead-pid rule). A tampered lock with no readable owner is never auto-broken: acquirers time out with
 * a message saying how to remove it by hand. Hostnames are compared exactly (a renamed host is treated as foreign
 * and falls back to the age rule).
 *
 * Callers branch on err.code, never on message text. fs is always called through the `fs.` namespace so the
 * fault-injection harness and the test-only interleaving preload (under tools/tests/lib/) see every call.
 * Zero third-party deps; Node built-ins only. Self-check: `node tools/lib/lock.js`.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { nowIsoTz } = require('./timestamp');
const identity = require('./identity');

const CODES = Object.freeze({
  ELOCK_ARG: 'ELOCK_ARG',
  ELOCK_REENTRANT: 'ELOCK_REENTRANT',
  ELOCK_TIMEOUT: 'ELOCK_TIMEOUT',
  ELOCK_LOST: 'ELOCK_LOST',
  ELOCK_IO: 'ELOCK_IO',
});

const DEFAULTS = Object.freeze({
  waitMs: 45000,
  staleMs: 30000,
  pollMinMs: 20,
  pollMaxMs: 50,
  confirmMs: 100,
  notifyAfterMs: 2000,
  pidTolMs: 2000,
  readRetries: 3,
  readRetryMs: 20,
  label: 'tpm-lock',
  lostHint: 'check the protected store with its doctor, and rebuild it if it reports drift',
});

class LockError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'LockError';
    this.code = code;
    this.lockDir = (extra && extra.lockDir) || null;
    this.owner = (extra && extra.owner) || null;
    if (extra && extra.cause) this.cause = extra.cause;
  }
}

const CONTENDED = new Set(['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES', 'EBUSY', 'ENOTDIR']);

// ───────────────────────────── small helpers ─────────────────────────────

function realSleep(ms) {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function envInt(env, key, allowZero) {
  const v = env && typeof env === 'object' ? env[key] : undefined;
  if (typeof v !== 'string' || !/^\d+$/.test(v.trim())) return undefined;
  const n = Number(v.trim());
  if (!Number.isSafeInteger(n)) return undefined;
  return n > 0 || (allowZero && n === 0) ? n : undefined;
}

function numOpt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
}

function defaultProcInfo() {
  return {
    isAlive: identity.isProcessAlive,
    startedAtMs(pid) {
      const s = identity.processStartedAt(pid);
      const ms = s ? Date.parse(s) : NaN;
      return Number.isFinite(ms) ? ms : null;
    },
  };
}

/** Merge options over defaults/env into one resolved settings object. */
function resolve(opts) {
  const o = opts || {};
  const env = o.env !== undefined ? o.env : process.env;
  const pick = (k, fallback) => { const v = numOpt(o[k]); return v !== undefined ? v : fallback; };
  const waitEnv = envInt(env, 'TPM_LOCK_WAIT_MS', true);
  const staleEnv = envInt(env, 'TPM_LOCK_STALE_MS', false);
  const procInfo = o.procInfo || {};
  const dflt = defaultProcInfo();
  return {
    waitMs: pick('waitMs', waitEnv !== undefined ? waitEnv : DEFAULTS.waitMs),
    staleMs: pick('staleMs', staleEnv !== undefined ? staleEnv : DEFAULTS.staleMs),
    pollMinMs: pick('pollMinMs', DEFAULTS.pollMinMs),
    pollMaxMs: pick('pollMaxMs', DEFAULTS.pollMaxMs),
    confirmMs: pick('confirmMs', DEFAULTS.confirmMs),
    notifyAfterMs: pick('notifyAfterMs', DEFAULTS.notifyAfterMs),
    pidTolMs: pick('pidTolMs', DEFAULTS.pidTolMs),
    readRetries: pick('readRetries', DEFAULTS.readRetries),
    readRetryMs: pick('readRetryMs', DEFAULTS.readRetryMs),
    verb: typeof o.verb === 'string' ? o.verb : null,
    version: typeof o.version === 'string' ? o.version : null,
    label: typeof o.label === 'string' && o.label ? o.label : DEFAULTS.label,
    lostHint: typeof o.lostHint === 'string' && o.lostHint ? o.lostHint : DEFAULTS.lostHint,
    env,
    hostname: typeof o.hostname === 'string' && o.hostname ? o.hostname : safeHostname(),
    now: typeof o.now === 'function' ? o.now : Date.now,
    sleep: typeof o.sleep === 'function' ? o.sleep : realSleep,
    stderr: typeof o.stderr === 'function' ? o.stderr : (s) => { process.stderr.write(s); },
    procInfo: {
      isAlive: typeof procInfo.isAlive === 'function' ? procInfo.isAlive : dflt.isAlive,
      startedAtMs: typeof procInfo.startedAtMs === 'function' ? procInfo.startedAtMs : dflt.startedAtMs,
    },
  };
}

function safeHostname() {
  try { return os.hostname() || 'unknown-host'; } catch (_e) { return 'unknown-host'; }
}

function rand() { return crypto.randomBytes(4).toString('hex'); }

function ownerFile(dir) { return path.join(dir, 'owner.json'); }

function validOwner(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && typeof x.nonce === 'string' && x.nonce.length > 0
    && Number.isSafeInteger(x.pid) && x.pid > 1
    && typeof x.host === 'string' && x.host.length > 0
    && typeof x.at === 'string' && Number.isFinite(Date.parse(x.at));
}

function who(owner) {
  if (!owner) return 'an unknown holder';
  let s = `pid ${owner.pid} on host ${owner.host}`;
  if (owner.verb) s += `, verb ${owner.verb}`;
  if (owner.version) s += `, version ${owner.version}`;
  if (typeof owner.claudeSessionId === 'string' && owner.claudeSessionId) {
    s += `, claude session ${owner.claudeSessionId.slice(0, 8)}`;
  }
  return s;
}

function ageSec(owner, nowMs) {
  const t = owner ? Date.parse(owner.at) : NaN;
  return Number.isFinite(t) ? Math.max(0, Math.floor((nowMs - t) / 1000)) : 0;
}

function ioError(s, lockDir, cause) {
  return new LockError(CODES.ELOCK_IO,
    `${s.label}: cannot take lock ${lockDir}: ${cause && cause.message ? cause.message : cause}`,
    { lockDir, cause });
}

// ───────────────────────────── reading ─────────────────────────────

/** One read attempt: { status, owner }. */
function readOnce(lockDir) {
  let st;
  try {
    st = fs.lstatSync(lockDir);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { status: 'absent', owner: null };
    return { status: 'incomplete', owner: null };
  }
  if (!st.isDirectory()) return { status: 'incomplete', owner: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerFile(lockDir), 'utf8'));
    if (validOwner(parsed)) return { status: 'ok', owner: parsed };
  } catch (_e) { /* fall through: incomplete */ }
  return { status: 'incomplete', owner: null };
}

function readOwner(lockDir, opts) {
  const s = resolve(opts);
  let r = readOnce(lockDir);
  // Cross-process read lag and the stranded-name ENOENT hazard are absorbed by a short private retry,
  // only while the result is not 'ok' (and never when the directory is simply absent).
  for (let i = 0; i < s.readRetries && r.status === 'incomplete'; i++) {
    realSleep(s.readRetryMs);
    r = readOnce(lockDir);
  }
  return r;
}

// ───────────────────────────── the stale rule ─────────────────────────────

function isStale(owner, ctx) {
  const c = ctx || {};
  const procInfo = c.procInfo || defaultProcInfo();
  const staleMs = typeof c.staleMs === 'number' ? c.staleMs : DEFAULTS.staleMs;
  const pidTolMs = typeof c.pidTolMs === 'number' ? c.pidTolMs : DEFAULTS.pidTolMs;
  const nowMs = typeof c.nowMs === 'number' ? c.nowMs : Date.now();
  const ageMs = Math.max(nowMs - Date.parse(owner.at), typeof c.observedAgeMs === 'number' ? c.observedAgeMs : 0);
  const sameHost = owner.host === c.hostname;

  if (sameHost) {
    if (!procInfo.isAlive(owner.pid)) {
      return { stale: true, reason: 'dead', detail: `process ${owner.pid} is not running` };
    }
    if (ageMs < staleMs) {
      const recorded = typeof owner.startedAt === 'string' ? Date.parse(owner.startedAt) : NaN;
      if (Number.isFinite(recorded)) {
        const actual = procInfo.startedAtMs(owner.pid);
        if (typeof actual === 'number' && Number.isFinite(actual) && Math.abs(recorded - actual) > pidTolMs) {
          return {
            stale: true, reason: 'reused',
            detail: `process ${owner.pid} was reused (started ${nowIsoTz(new Date(actual))}, the lock expects ${owner.startedAt})`,
          };
        }
      }
    }
  }
  if (ageMs >= staleMs) {
    return { stale: true, reason: 'old', detail: `held for ${Math.floor(ageMs / 1000)} s (stale after ${Math.floor(staleMs / 1000)} s)` };
  }
  return { stale: false, reason: null, detail: '' };
}

// ───────────────────────────── held-set + exit net ─────────────────────────────

const held = new Map(); // resolved lockDir -> Handle-internal
let exitHookInstalled = false;

function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const h of Array.from(held.values())) {
      try { h._release(true); } catch (_e) { /* best effort, silent */ }
    }
  });
}

// ───────────────────────────── preparing / acquiring ─────────────────────────────

function buildOwner(s) {
  const ident = identity.readIdentity({ env: s.env, hostname: s.hostname, withStartTime: false });
  return {
    schema: 1,
    nonce: crypto.randomBytes(12).toString('hex'),
    pid: process.pid,
    host: s.hostname,
    at: nowIsoTz(new Date(s.now())),
    startedAt: nowIsoTz(new Date(Date.now() - process.uptime() * 1000)),
    version: s.version,
    verb: s.verb,
    claudePid: ident.claudePid,
    claudeSessionId: ident.claudeSessionId,
  };
}

/** Build `<base>.new.<pid>.<rand>` holding .gitignore then owner.json. Returns { dir, owner }. */
function prepare(lockDir, s) {
  const dir = `${lockDir}.new.${process.pid}.${rand()}`;
  const owner = buildOwner(s);
  try {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), '*\n');
    fs.writeFileSync(ownerFile(dir), JSON.stringify(owner, null, 2) + '\n');
  } catch (e) {
    removeTree(dir);
    throw ioError(s, lockDir, e);
  }
  return { dir, owner };
}

function removeTree(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
}

function pathExists(p) {
  try { fs.lstatSync(p); return true; } catch (_e) { return false; }
}

function makeHandle(lockDir, owner, s) {
  const handle = {
    lockDir, nonce: owner.nonce, owner, released: false,
    release() { return handle._release(false); },
    _release(quiet) {
      if (handle.released) return undefined;
      handle.released = true;
      held.delete(lockDir);
      return doRelease(handle, s, quiet);
    },
  };
  Object.defineProperty(handle, 'released', { enumerable: false, writable: true, value: false });
  Object.defineProperty(handle, '_release', { enumerable: false });
  return handle;
}

function lostMessage(s, lockDir, nowState) {
  return `${s.label}: lost the lock ${lockDir} before release (now ${nowState}). `
    + `The protected store may be inconsistent: ${s.lostHint}.`;
}

function doRelease(handle, s, quiet) {
  const lockDir = handle.lockDir;
  const lost = (state, owner) => {
    const msg = lostMessage(s, lockDir, state);
    if (!quiet) s.stderr(msg + '\n');
    throw new LockError(CODES.ELOCK_LOST, msg, { lockDir, owner: owner || null });
  };
  const r = readOwner(lockDir, s);
  if (r.status === 'absent') lost('absent');
  if (r.status !== 'ok') lost('unreadable');
  if (r.owner.nonce !== handle.nonce) lost(`held by ${who(r.owner)}`, r.owner);
  const rel = `${lockDir}.rel.${process.pid}.${rand()}`;
  try {
    fs.renameSync(lockDir, rel);
  } catch (e) {
    if (e && e.code === 'ENOENT') lost('absent');
    throw new LockError(CODES.ELOCK_IO, `${s.label}: cannot release lock ${lockDir}: ${e.message}`, { lockDir, cause: e });
  }
  const after = readOwner(rel, s);
  if (after.status === 'ok' && after.owner.nonce === handle.nonce) {
    removeTree(rel);
    return undefined;
  }
  // ABA: what we moved aside was not ours. Put it back if we can, then report the loss.
  try { fs.renameSync(rel, lockDir); } catch (_e) { /* leave it aside for the doctor */ }
  return lost(after.status === 'ok' ? `held by ${who(after.owner)}` : 'unreadable', after.owner);
}

/** One attempt to move a prepared dir onto lockDir. Returns 'won' | 'contended' | 'gone'. Throws ELOCK_IO. */
function tryRename(prep, lockDir, s) {
  try {
    fs.renameSync(prep.dir, lockDir);
    return 'won';
  } catch (e) {
    if (e && CONTENDED.has(e.code)) return pathExists(lockDir) ? 'contended' : 'gone';
    removeTree(prep.dir);
    throw ioError(s, lockDir, e);
  }
}

function checkArgs(lockDir) {
  if (typeof lockDir !== 'string' || !lockDir) {
    throw new LockError(CODES.ELOCK_ARG, 'tpm-lock: lock: lockDir must be a non-empty string', { lockDir: null });
  }
  return path.resolve(lockDir);
}

function checkReentrant(dir, s) {
  if (held.has(dir)) {
    throw new LockError(CODES.ELOCK_REENTRANT,
      `${s.label}: lock ${dir} is already held by this process; the lock is not re-entrant`, { lockDir: dir });
  }
}

function ensureParent(dir, s) {
  try { fs.mkdirSync(path.dirname(dir), { recursive: true }); } catch (e) { throw ioError(s, dir, e); }
}

function finishWin(dir, prep, s) {
  const h = makeHandle(dir, prep.owner, s);
  held.set(dir, h);
  installExitHook();
  return h;
}

function tryAcquire(lockDir, opts) {
  const dir = checkArgs(lockDir);
  const s = resolve(opts);
  checkReentrant(dir, s);
  ensureParent(dir, s);
  if (pathExists(dir)) return null;
  const prep = prepare(dir, s);
  try {
    return tryRename(prep, dir, s) === 'won' ? finishWin(dir, prep, s) : null;
  } finally {
    if (pathExists(prep.dir)) removeTree(prep.dir);
  }
}

function acquire(lockDir, opts) {
  const dir = checkArgs(lockDir);
  const s = resolve(opts);
  checkReentrant(dir, s);
  ensureParent(dir, s);

  const start = s.now();
  const deadline = start + s.waitMs;
  let prep = null;
  let notified = false;
  let spins = 0;
  const seen = { nonce: null, firstSeenMs: 0, verdictSinceMs: null, memo: null };
  const procInfo = {
    isAlive: (pid) => s.procInfo.isAlive(pid),
    startedAtMs: (pid) => {
      if (!seen.memo) seen.memo = { v: s.procInfo.startedAtMs(pid) };
      return seen.memo.v;
    },
  };

  try {
    for (;;) {
      const r = readOwner(dir, s);

      if (r.status === 'absent') {
        if (prep === null) prep = prepare(dir, s);
        const res = tryRename(prep, dir, s);
        if (res === 'won') {
          const won = prep;
          prep = null;
          return finishWin(dir, won, s);
        }
        if (res === 'gone') {
          if (++spins > 5) {
            removeTree(prep.dir);
            throw ioError(s, dir, new Error('the lock directory could not be created and does not exist'));
          }
          continue;
        }
        // contended: someone took it between our read and our rename. Drop the preparation dir (its `at`
        // would be stale by the time the lock frees up) and fall through to wait.
        removeTree(prep.dir);
        prep = null;
      } else if (r.status === 'ok') {
        spins = 0;
        const nowMs = s.now();
        if (seen.nonce !== r.owner.nonce) {
          seen.nonce = r.owner.nonce; seen.firstSeenMs = nowMs; seen.verdictSinceMs = null; seen.memo = null;
        }
        const v = isStale(r.owner, {
          nowMs, staleMs: s.staleMs, hostname: s.hostname, procInfo, pidTolMs: s.pidTolMs,
          observedAgeMs: nowMs - seen.firstSeenMs,
        });
        if (!v.stale) {
          seen.verdictSinceMs = null;
        } else if (v.reason === 'old') {
          breakLock(dir, r.owner.nonce, v.detail, s);
          continue;
        } else {
          if (seen.verdictSinceMs === null) seen.verdictSinceMs = nowMs;
          if (nowMs - seen.verdictSinceMs >= s.confirmMs) {
            breakLock(dir, r.owner.nonce, v.detail, s);
            seen.nonce = null;
            continue;
          }
        }
      } else {
        spins = 0;
        seen.nonce = null; // incomplete: never stale evidence, just wait
      }

      const nowMs = s.now();
      if (nowMs >= deadline) throw timeoutError(dir, s);
      if (!notified && nowMs - start >= s.notifyAfterMs) {
        notified = true;
        const cur = readOwner(dir, { ...s, readRetries: 0 });
        const detail = cur.status === 'ok'
          ? `held by ${who(cur.owner)}, for ${ageSec(cur.owner, nowMs)} s`
          : 'owner record not readable yet';
        s.stderr(`${s.label}: waiting for lock ${dir} (${detail})\n`);
      }
      const span = s.pollMaxMs - s.pollMinMs;
      s.sleep(s.pollMinMs + Math.floor(Math.random() * (span + 1)));
    }
  } finally {
    if (prep !== null) removeTree(prep.dir);
  }
}

function timeoutError(dir, s) {
  const r = readOwner(dir, s);
  const secs = Math.floor(s.waitMs / 1000);
  if (r.status === 'ok') {
    const o = r.owner;
    return new LockError(CODES.ELOCK_TIMEOUT,
      `${s.label}: gave up waiting ${secs} s for lock ${dir}, held by ${who(o)}, taken ${o.at} `
      + `(${ageSec(o, s.now())} s ago). It is not stale yet (stale after ${Math.floor(s.staleMs / 1000)} s). Re-run in a moment.`,
      { lockDir: dir, owner: o });
  }
  return new LockError(CODES.ELOCK_TIMEOUT,
    `${s.label}: gave up waiting ${secs} s for lock ${dir}: its owner record is missing or unreadable, so it cannot be judged stale. `
    + `If no tpm process is running, remove (or move aside) the directory ${dir} by hand.`,
    { lockDir: dir });
}

// ───────────────────────────── breaking ─────────────────────────────

function breakLock(lockDir, expectedNonce, reason, opts) {
  const s = resolve(opts);
  const dir = path.resolve(lockDir);
  const aside = `${dir}.broken.${process.pid}.${s.now()}`;
  // Narrow the displace-a-fresh-lock window: if the lock on disk is plainly not the one we judged, leave it.
  const pre = readOnce(dir);
  if (pre.status === 'ok' && pre.owner.nonce !== expectedNonce) return { broken: false, restored: false };
  try {
    fs.renameSync(dir, aside);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { broken: false, restored: false };
    throw new LockError(CODES.ELOCK_IO, `${s.label}: cannot break lock ${dir}: ${e.message}`, { lockDir: dir, cause: e });
  }
  const r = readOwner(aside, s);
  if (r.status === 'ok' && r.owner.nonce === expectedNonce) {
    s.stderr(`${s.label}: breaking a stale lock ${dir}\n`
      + `  held by ${who(r.owner)}, taken ${r.owner.at} (${ageSec(r.owner, s.now())} s ago)\n`
      + `  reason: ${reason}\n`
      + `  moved to ${path.basename(aside)}; its write may be incomplete: ${s.lostHint}.\n`);
    return { broken: true, restored: false };
  }
  // ABA: we displaced a lock that was not the one we judged. Try to put it back.
  let restored = false;
  try { fs.renameSync(aside, dir); restored = true; } catch (_e) { restored = false; }
  s.stderr(`${s.label}: displaced a lock that was not the stale one (${dir}, now held by ${who(r.owner)}); `
    + `${restored ? 'put it back' : 'could not put it back'}. Its holder will report the loss at release.\n`);
  return { broken: false, restored };
}

// ───────────────────────────── withLock ─────────────────────────────

function withLock(lockDir, fn, opts) {
  if (typeof fn !== 'function') {
    throw new LockError(CODES.ELOCK_ARG, `${resolve(opts).label}: lock: withLock fn must be a function`, { lockDir: null });
  }
  const h = acquire(lockDir, opts);
  let result;
  try {
    result = fn(h);
  } catch (e) {
    try { h.release(); } catch (_e) { /* the lost-lock block is already on stderr; the fn error wins */ }
    throw e;
  }
  if (result && typeof result.then === 'function') {
    try { h.release(); } catch (_e) { /* reported on stderr */ }
    throw new LockError(CODES.ELOCK_ARG,
      `${resolve(opts).label}: lock: withLock fn must be synchronous (it returned a Promise; the lock would have been released early)`,
      { lockDir: path.resolve(lockDir) });
  }
  h.release();
  return result;
}

// ───────────────────────────── inspect (doctor) ─────────────────────────────

function inspect(lockDir, opts) {
  const s = resolve(opts);
  const dir = path.resolve(lockDir);
  const base = path.basename(dir);
  const r = readOwner(dir, s);
  const out = { state: 'none', owner: null, ageMs: null, stale: null, leftovers: [], gitignore: false };
  try {
    out.leftovers = fs.readdirSync(path.dirname(dir))
      .filter((n) => n.startsWith(`${base}.new.`) || n.startsWith(`${base}.rel.`) || n.startsWith(`${base}.broken.`))
      .sort();
  } catch (_e) { /* parent missing: no leftovers */ }
  if (r.status === 'absent') return out;
  out.gitignore = pathExists(path.join(dir, '.gitignore'));
  if (r.status !== 'ok') { out.state = 'incomplete'; return out; }
  const nowMs = s.now();
  out.owner = r.owner;
  out.ageMs = nowMs - Date.parse(r.owner.at);
  out.stale = isStale(r.owner, { nowMs, staleMs: s.staleMs, hostname: s.hostname, procInfo: s.procInfo, pidTolMs: s.pidTolMs });
  out.state = out.stale.stale ? 'stale' : 'held';
  return out;
}

module.exports = {
  acquire, tryAcquire, withLock, inspect, readOwner, isStale, breakLock, LockError, CODES, DEFAULTS,
};

if (require.main === module) {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-lock-self-')), 'x', '.lock');
  let ok = false;
  try {
    withLock(dir, (h) => { ok = fs.existsSync(path.join(h.lockDir, 'owner.json')); }, { env: {} });
    ok = ok && !fs.existsSync(dir);
    removeTree(path.dirname(path.dirname(dir)));
  } catch (e) {
    process.stderr.write(`lock.js self-check FAILED: ${e.message}\n`);
    process.exit(1);
  }
  if (!ok) { process.stderr.write('lock.js self-check FAILED\n'); process.exit(1); }
  process.stdout.write('lock.js OK (acquire, owner record, release)\n');
}
