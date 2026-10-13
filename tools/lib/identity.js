'use strict';
/**
 * identity.js — who is running this tool? (kind-agnostic, never throws, never prints)
 *
 * Reads the Claude Code identity the harness hands every Bash call and the machine's host name, and
 * offers two small process helpers the directory lock (`lock.js`) builds on. Attribution only: every
 * value is `null` when unavailable and NOTHING here ever blocks work (decision D11).
 *
 * API
 *   readIdentity(opts?)          -> { claudeSessionId, claudePid, claudePidStartedAt, hostname }
 *   processStartedAt(pid, opts?) -> string | null   local-offset ISO (nowIsoTz form) of the process start, from `ps`
 *   isProcessAlive(pid)          -> boolean         `process.kill(pid, 0)`; EPERM counts as alive
 *
 *   readIdentity opts:    { env = process.env, hostname = os.hostname(), withStartTime = true, run = spawnSync }
 *   processStartedAt opts: { env = process.env, run = spawnSync }
 *
 * Sources (the ONLY two env vars read):
 *   claudeSessionId   CLAUDE_CODE_SESSION_ID, trimmed; blank -> null (not format-validated)
 *   claudePid         CLAUDE_PID: /^\d+$/ after trim, a safe integer > 1; anything else -> null
 *   claudePidStartedAt  `ps -o lstart= -p <claudePid>` (LC_ALL=C) re-formatted with nowIsoTz; null when the
 *                       pid is not running, `ps` is unavailable, or `withStartTime` is false. 1 s resolution.
 *   hostname          opts.hostname if a non-blank string, else os.hostname(); blank/throws -> null
 *
 * Guarantees: never throws (every body is guarded, including a throwing `run` or a non-object `env`);
 * never writes to stdout/stderr (the `ps` child's output is piped and discarded); no side effects; the
 * caller's `env` object is never mutated. Windows has no `ps`: `processStartedAt` returns null there.
 *
 * Zero third-party deps; Node built-ins only. Self-check: `node tools/lib/identity.js`.
 */
const os = require('os');
const childProcess = require('child_process');
const { nowIsoTz } = require('./timestamp');

function envObject(env) {
  return env !== null && typeof env === 'object' ? env : {};
}

function validPid(pid) {
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1;
}

function isProcessAlive(pid) {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

function processStartedAt(pid, opts) {
  try {
    if (!validPid(pid)) return null;
    const o = opts || {};
    const run = typeof o.run === 'function' ? o.run : childProcess.spawnSync;
    const env = { ...envObject(o.env === undefined ? process.env : o.env), LC_ALL: 'C' };
    const r = run('ps', ['-o', 'lstart=', '-p', String(pid)], {
      env, encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
    const text = r.stdout.trim();
    if (!text) return null;
    const ms = new Date(text).getTime();
    if (!Number.isFinite(ms)) return null;
    return nowIsoTz(new Date(ms));
  } catch (_e) {
    return null;
  }
}

function readIdentity(opts) {
  const o = opts || {};
  const out = { claudeSessionId: null, claudePid: null, claudePidStartedAt: null, hostname: null };
  try {
    const env = envObject(o.env === undefined ? process.env : o.env);
    if (typeof env.CLAUDE_CODE_SESSION_ID === 'string') {
      const s = env.CLAUDE_CODE_SESSION_ID.trim();
      if (s) out.claudeSessionId = s;
    }
    if (typeof env.CLAUDE_PID === 'string' || typeof env.CLAUDE_PID === 'number') {
      const t = String(env.CLAUDE_PID).trim();
      if (/^\d+$/.test(t)) {
        const n = Number(t);
        if (Number.isSafeInteger(n) && n > 1) out.claudePid = n;
      }
    }
    if (out.claudePid !== null && o.withStartTime !== false) {
      out.claudePidStartedAt = processStartedAt(out.claudePid, { env, run: o.run });
    }
  } catch (_e) { /* leave whatever we have; never throw */ }
  try {
    const h = o.hostname !== undefined ? o.hostname : os.hostname();
    if (typeof h === 'string' && h.trim()) out.hostname = h;
  } catch (_e) { /* null */ }
  return out;
}

module.exports = { readIdentity, processStartedAt, isProcessAlive };

if (require.main === module) {
  const id = readIdentity({ withStartTime: false });
  const self = processStartedAt(process.pid);
  if (!isProcessAlive(process.pid) || isProcessAlive(0) || typeof id !== 'object') {
    process.stderr.write('identity.js self-check FAILED\n');
    process.exit(1);
  }
  process.stdout.write(`identity.js OK (hostname=${id.hostname}, own start=${self})\n`);
}
