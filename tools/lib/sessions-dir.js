'use strict';
/**
 * sessions-dir.js — where are the tpm session tracks? (the QUIET twin of the session suite's resolver)
 *
 * `tools/session/tpm-session-config.js#resolveSessionsDir` cannot be imported from outside the session suite
 * (suite isolation) and it FAILS LOUD / warns on stderr outside a project, both wrong for attribution, which
 * must never get in the way of a write. This resolver NEVER throws, NEVER prints, and returns `null` for
 * "cannot resolve / not applicable".
 *
 * API
 *   resolveSessionsDirQuiet({ sessionsDir, env, startDir } = {}) -> string | null
 *
 * Order (mirrors the loud resolver's rungs):
 *   1. opts.sessionsDir (non-empty string)           -> path.resolve of it
 *   2. env.TPM_SESSIONS_DIR (non-empty string)       -> path.resolve of it
 *   3. project root via findRoot({quiet:true}); no `.claude/claude-tpm/` marker there -> null (outside a project)
 *   4. project config.json `session` section, USER layer folded on top (CLAUDE_TPM_USER_CONFIG, user wins):
 *      `session.enabled === false` -> null; dir = session.notes.sessionsDir, else legacy flat session.sessionsDir
 *   5. default `<root>/.claude/claude-tpm/sessions` (existence is NOT required)
 *
 * Imports only ./paths and ./tpm-config-overlay. Node built-ins only.
 */
const fs = require('fs');
const path = require('path');
const { findRoot } = require('./paths');
const overlay = require('./tpm-config-overlay');

const MARKER = path.join('.claude', 'claude-tpm');

function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
function nonEmptyStr(x) { return typeof x === 'string' && x.trim() !== ''; }

function dirOf(section) {
  if (!isObj(section)) return null;
  if (isObj(section.notes) && nonEmptyStr(section.notes.sessionsDir)) return section.notes.sessionsDir;
  if (nonEmptyStr(section.sessionsDir)) return section.sessionsDir;
  return null;
}

function resolveSessionsDirQuiet(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    const env = o.env !== undefined && o.env !== null && typeof o.env === 'object' ? o.env : process.env;
    if (nonEmptyStr(o.sessionsDir)) return path.resolve(o.sessionsDir);
    if (nonEmptyStr(env.TPM_SESSIONS_DIR)) return path.resolve(env.TPM_SESSIONS_DIR);

    const root = findRoot({ startDir: o.startDir, quiet: true });
    if (!root || !fs.existsSync(path.join(root, MARKER))) return null;

    let proj;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(root, MARKER, 'config.json'), 'utf8'));
      if (isObj(parsed) && isObj(parsed.session)) proj = parsed.session;
    } catch (_e) { proj = undefined; }
    let user;
    try { user = overlay.resolveUserSection('session', { env, warn: () => {} }); } catch (_e) { user = undefined; }

    let enabled = true;
    if (isObj(proj) && typeof proj.enabled === 'boolean') enabled = proj.enabled;
    if (isObj(user) && typeof user.enabled === 'boolean') enabled = user.enabled;
    if (enabled === false) return null;

    const dir = dirOf(user) || dirOf(proj) || path.join('.claude', 'claude-tpm', 'sessions');
    return path.isAbsolute(dir) ? dir : path.join(root, dir);
  } catch (_e) {
    return null;
  }
}

module.exports = { resolveSessionsDirQuiet };

if (require.main === module) {
  const r = resolveSessionsDirQuiet({ sessionsDir: '/tmp/x' });
  if (r !== path.resolve('/tmp/x')) { process.stderr.write('sessions-dir.js self-check FAILED\n'); process.exit(1); }
  process.stdout.write('sessions-dir.js OK\n');
}
