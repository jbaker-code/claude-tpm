'use strict';
/**
 * session-lock.js — the session store's write lock (Q11): every mutating session verb runs its whole
 * read-modify-write under the shared `tools/lib/lock.js` directory lock.
 *
 *   lockDirFor(sessionsDir, number)                    -> <sessionsDir>/session-NNNN/.lock
 *   withSessionLock(sessionsDir, number, verb, fn)     -> fn()'s value
 *
 * Where the lock lives: INSIDE the session folder, not at the sessions root. The doctor treats every root-level
 * subdirectory as a session candidate (a root `.lock` or a kept `.lock.broken.*` would be reported as an old-format
 * folder forever), and `T.listFolder` already skips dot-names inside a session folder. It is also narrower: writers
 * to different sessions never wait for each other, while every writer to one track (an instance and its own
 * subagents) and the cross-track inputs of one session are serialised.
 *
 * A missing sessionsDir/number, or a session folder that does not exist, runs `fn()` UNLOCKED: it fails with its
 * own normal error and a typo'd `--session` never creates a stray folder. The lock is not re-entrant: no locked
 * body may call another locking op (the second acquire throws ELOCK_REENTRANT at once).
 *
 * `lockLib` is reached through the module object (not destructured) so fault injection and test seams see it.
 */
const fs = require('fs');
const path = require('path');
const lockLib = require('../../lib/lock');
const { tpmVersion } = require('../../lib/tpm-version');

function padNumber(number) {
  const n = Number(number);
  return Number.isFinite(n) ? String(n).padStart(4, '0') : String(number == null ? '' : number);
}

function lockDirFor(sessionsDir, number) {
  return path.join(sessionsDir, `session-${padNumber(number)}`, '.lock');
}

function withSessionLock(sessionsDir, number, verb, fn) {
  if (!sessionsDir || number === undefined || number === null || String(number) === '') return fn();
  let folderExists = false;
  try { folderExists = fs.statSync(path.join(sessionsDir, `session-${padNumber(number)}`)).isDirectory(); } catch (_e) { folderExists = false; }
  if (!folderExists) return fn();
  return lockLib.withLock(lockDirFor(sessionsDir, number), fn, {
    verb,
    version: tpmVersion(),
    label: 'tpm-session',
    lostHint: 'run `tpm session doctor` and re-read the track record and its .md',
  });
}

module.exports = { lockDirFor, withSessionLock };
