'use strict';
/**
 * fs-barrier.js — the interleaving seam: a node PRELOAD (`node -r "<this file>" <script>`) that FORCES one
 * specific interleaving between cooperating processes, so a race (a lock holder parked inside its critical
 * section, a reader paused between two reads) reproduces deterministically — forced interleavings, not
 * real parallel load.
 *
 * It wraps ONE fs function. On the Nth call whose first argument (a path) matches BARRIER_PATTERN it
 *   1. (BARRIER_WHEN=after) lets the real call run first, then
 *   2. creates BARRIER_READY (a file saying "I have arrived at the interesting point"),
 *   3. spin-waits (Atomics.wait, 20 ms steps, BARRIER_MAX_MS cap, default 20 s) until BARRIER_WAIT exists,
 *   4. (BARRIER_WHEN=before, the default) then performs the real call.
 * At process exit it creates BARRIER_DONE, so a peer can be sequenced to run strictly AFTER this process.
 *
 * INERT BY DEFAULT: with neither BARRIER_FN nor BARRIER_PATTERN set it patches nothing, and requiring it
 * from a test process (to use `env()`) changes nothing. It is referenced by NO production file, lives under a
 * `tests/` dir (excluded from the shipped package by package.json `files`), and only `node -r` loads it.
 *
 * Env (FN and PATTERN required to arm it):
 *   BARRIER_FN        fs function name to wrap: readFileSync | existsSync | readdirSync | writeFileSync | mkdirSync ...
 *   BARRIER_PATTERN   JS regex source tested against String(arg0)
 *   BARRIER_NTH       which matching call to stop at (default 1)
 *   BARRIER_WHEN      'before' (default) | 'after' the real call
 *   BARRIER_READY     file to create on arrival
 *   BARRIER_WAIT      file whose existence releases us
 *   BARRIER_DONE      file to create at process exit
 *   BARRIER_MAX_MS    cap on the wait (default 20000); on expiry it writes a line to stderr and continues
 *
 * From a test:  const barrier = require('./tests/lib/fs-barrier');
 *               spawn(node, [script], { env: { ...base, ...barrier.env({ fn, pattern, when, ready, wait, done }) } })
 * `env()` returns the BARRIER_* vars plus NODE_OPTIONS='-r "<abs path>"'. The inner double quotes are REQUIRED
 * when the path contains spaces (this project's does); unquoted gives `Cannot find module '/Volumes/My'`.
 *
 * Known side effect: any node child of the parked process inherits NODE_OPTIONS and so the preload; harmless
 * when BARRIER_PATTERN only matches the one path the test targets. Patching is `fs[FN] = ...` on the shared
 * singleton, so callers must reach fs through the namespace (`fs.readFileSync(...)`), as lib/lock.js does.
 *
 * Test-harness only. Never run against a live store. Zero deps.
 */
const fs = require('fs');

const FN = process.env.BARRIER_FN;
const PAT = process.env.BARRIER_PATTERN ? new RegExp(process.env.BARRIER_PATTERN) : null;
const NTH = parseInt(process.env.BARRIER_NTH || '1', 10);
const WHEN = process.env.BARRIER_WHEN || 'before';
const READY = process.env.BARRIER_READY;
const WAIT = process.env.BARRIER_WAIT;
const DONE = process.env.BARRIER_DONE;
const MAX_MS = parseInt(process.env.BARRIER_MAX_MS || '20000', 10);

const realExists = fs.existsSync;
const realWrite = fs.writeFileSync;

function sleep(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

function rendezvous() {
  if (READY) realWrite(READY, String(process.pid));
  if (WAIT) {
    const t0 = Date.now();
    while (!realExists(WAIT)) {
      if (Date.now() - t0 > MAX_MS) { process.stderr.write('barrier: TIMEOUT waiting for ' + WAIT + '\n'); break; }
      sleep(20);
    }
  }
}

if (FN && PAT && typeof fs[FN] === 'function') {
  const real = fs[FN];
  let n = 0;
  fs[FN] = function patched(...args) {
    if (n < NTH && PAT.test(String(args[0]))) {
      n += 1;
      if (n === NTH) {
        if (WHEN === 'after') {
          const r = real.apply(fs, args);
          rendezvous();
          return r;
        }
        rendezvous();
      }
    }
    return real.apply(fs, args);
  };
}

if (DONE) process.on('exit', () => { try { realWrite(DONE, String(process.pid)); } catch (_e) { /* ignore */ } });

/** barrierEnv({ fn, pattern, nth, when, ready, wait, done, maxMs }) -> env vars to merge into a child's env. */
function barrierEnv(o) {
  const x = o || {};
  const out = { NODE_OPTIONS: '-r "' + __filename + '"' };
  const put = (k, v) => { if (v !== undefined && v !== null) out[k] = String(v); };
  put('BARRIER_FN', x.fn); put('BARRIER_PATTERN', x.pattern); put('BARRIER_NTH', x.nth);
  put('BARRIER_WHEN', x.when); put('BARRIER_READY', x.ready); put('BARRIER_WAIT', x.wait);
  put('BARRIER_DONE', x.done); put('BARRIER_MAX_MS', x.maxMs);
  return out;
}

module.exports = { path: __filename, env: barrierEnv };
