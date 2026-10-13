'use strict';
/**
 * io.js — crash-safe atomic write + fail-loud canonical read (kind-agnostic).
 *
 * Implements two LOCKED store invariants (json-format-spec "Store integrity"):
 *  - Atomic writes: temp file (same dir) -> fsync -> atomic rename. A crash/kill
 *    mid-write can NEVER leave a partial/corrupt canonical file (#1100/#1117).
 *  - Fail-loud reads: an unreadable / invalid-JSON canonical file throws a LOUD error
 *    naming the file + the problem; NEVER returns an empty/default record (#1066).
 *
 * Zero third-party deps; Node built-ins only. Runnable/inspectable via `node <file>`.
 */
const fs = require('fs');
const path = require('path');

/**
 * atomicWriteFileSync(filePath, data, { encoding = 'utf8' }) -> void
 *
 * Writes `data` to a temp file in the SAME directory, fsyncs it to durable storage,
 * then atomically renames it over `filePath`. On ANY error the temp file is unlinked
 * and the error is rethrown, so the pre-existing canonical file is left byte-identical
 * and no orphaned `.tmp` is left behind.
 *
 * tmp name: `${basename}.<pid>.<rand>.tmp` in the target's own directory (so the rename
 * is same-filesystem and therefore atomic).
 */
function atomicWriteFileSync(filePath, data, opts) {
  const encoding = (opts && opts.encoding) || 'utf8';
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const rand = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `${base}.${process.pid}.${rand}.tmp`);

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, null, encoding);
    fs.fsyncSync(fd);        // durability: flush to disk before we expose the file
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, filePath); // atomic swap over the target
  } catch (err) {
    // Roll back: close a still-open fd and remove the partial temp file.
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* best-effort */ }
    }
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
    } catch (_) { /* best-effort cleanup */ }
    const e = new Error(`atomicWriteFileSync: failed writing '${filePath}': ${err.message}`);
    e.cause = err;
    e.code = err.code;
    throw e;
  }
}

/**
 * readCanonicalSync(filePath) -> object
 *
 * Reads + JSON-parses the canonical file. Fail-loud: a missing/unreadable file or a
 * JSON parse error throws an Error naming the FILE and the problem. NEVER returns an
 * empty object or a default record on failure (that would silently erase real state).
 */
function readCanonicalSync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`readCanonicalSync: cannot read canonical file '${filePath}': ${err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`readCanonicalSync: canonical file '${filePath}' is not valid JSON: ${err.message}`);
  }
}

/**
 * exclusiveCreateFileSync(finalPath, data, { encoding = 'utf8' }) -> 'created' | 'exists'
 *
 * EXCLUSIVE create with a COMPLETE file: writes `data` to a temp in the SAME directory, fsyncs it, then
 * `fs.linkSync(tmp, finalPath)` — a hard link fails with EEXIST when `finalPath` exists, so exactly one
 * racing creator wins, and the winner's file is never visible partially written. NOT `wx`: a
 * `wx`-created file is EMPTY until its writer writes, and on the shared mount another process can read
 * it empty for ~1 s (phase-06 claim-probe). `rename` is not exclusive (it replaces).
 *
 * Fallback: when the filesystem has no hard links (ENOTSUP/EPERM/ENOSYS/EOPNOTSUPP/EXDEV) it uses
 * `wx` + write + fsync (non-atomic visibility) and says so once on stderr; readers apply a
 * young-empty re-read rule in that mode.
 *
 * The prepared temp is `.<basename>.claim.<pid>.<rand>.tmp` (leading dot, trailing .tmp) in the target's dir.
 */
let warnedNoHardLinks = false;
function exclusiveCreateFileSync(finalPath, data, opts) {
  const encoding = (opts && opts.encoding) || 'utf8';
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const rand = Math.random().toString(36).slice(2);
  const tmp = path.join(dir, `.${base}.claim.${process.pid}.${rand}.tmp`);
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch (_) { /* best-effort */ } };

  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, data, null, encoding);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } }
    cleanup();
    const e = new Error(`exclusiveCreateFileSync: failed preparing '${finalPath}': ${err.message}`);
    e.cause = err;
    e.code = err.code;
    throw e;
  }

  try {
    fs.linkSync(tmp, finalPath);
    cleanup();
    return 'created';
  } catch (err) {
    if (err && err.code === 'EEXIST') { cleanup(); return 'exists'; }
    if (err && ['ENOTSUP', 'EPERM', 'ENOSYS', 'EOPNOTSUPP', 'EXDEV'].includes(err.code)) {
      try {
        if (!warnedNoHardLinks) {
          warnedNoHardLinks = true;
          process.stderr.write('tpm: warning: filesystem has no hard links; exclusive create fell back to a non-atomic-visibility mode\n');
        }
        let wfd;
        try {
          wfd = fs.openSync(finalPath, 'wx');
        } catch (e2) {
          if (e2 && e2.code === 'EEXIST') { cleanup(); return 'exists'; }
          throw e2;
        }
        try {
          fs.writeSync(wfd, data, null, encoding);
          fs.fsyncSync(wfd);
        } finally {
          fs.closeSync(wfd);
        }
        cleanup();
        return 'created';
      } catch (e3) {
        cleanup();
        const e = new Error(`exclusiveCreateFileSync: failed creating '${finalPath}': ${e3.message}`);
        e.cause = e3;
        e.code = e3.code;
        throw e;
      }
    }
    cleanup();
    const e = new Error(`exclusiveCreateFileSync: failed creating '${finalPath}': ${err.message}`);
    e.cause = err;
    e.code = err.code;
    throw e;
  }
}

module.exports = { atomicWriteFileSync, readCanonicalSync, exclusiveCreateFileSync };
