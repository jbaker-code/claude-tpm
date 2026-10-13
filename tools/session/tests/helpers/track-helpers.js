'use strict';
/**
 * track-helpers.js — shared builders for the tracks-store tests: write a REAL track record (and optionally a
 * seal marker) into a scratch sessions dir, and run the CLIs as a specific "Claude instance" with an explicit
 * env (ambient CLAUDE_CODE_SESSION_ID / CLAUDE_PID are always stripped).
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const model = require('../../lib/session-model');
const { render } = require('../../lib/session-converter');
const T = require('../../lib/session-tracks');

const NOW = '2026-10-07T10:00:00-07:00';

function id(claudeSessionId, extra) {
  return Object.assign({ claudeSessionId, claudePid: null, claudePidStartedAt: null, hostname: null }, extra || {});
}

/**
 * putTrack(sessionsDir, number, track, { owner, sealed, legacy, handoff, md }) -> jsonPath
 *   owner   Claude session id (string|null)           sealed  true -> meta.closedAt stamped
 *   ident   extra identity fields for the owner ({ claudePid, claudePidStartedAt, hostname })
 *   legacy  true -> a pre-tracks record (no meta.track / claude* keys; sessionIds carries the owner)
 */
function putTrack(sessionsDir, number, track, spec) {
  const s = spec || {};
  const p = T.trackPaths(sessionsDir, number, track);
  fs.mkdirSync(p.folder, { recursive: true });
  let rec;
  if (s.legacy) {
    rec = model.openSession({ number, sessionId: s.owner || 'legacy-sid', tpmVersion: '0.2.0' });
    if (s.owner === null) rec.meta.sessionIds = [];
  } else {
    rec = model.openTrack({ number, track, identity: id(s.owner === undefined ? null : s.owner, s.ident), tpmVersion: '0.2.0', lastWriterVersion: '0.2.0-dev' });
  }
  if (s.handoff) rec = model.importHandoff(rec, s.handoff);
  if (s.sealed) rec = model.closeSession(rec);
  model.saveSession(rec, { jsonPath: p.jsonPath, mdPath: p.mdPath, render: (r) => render(r, { now: NOW }) });
  return p.jsonPath;
}

function putMarker(sessionsDir, number, track, body) {
  const p = T.trackPaths(sessionsDir, number, track);
  fs.mkdirSync(p.folder, { recursive: true });
  fs.writeFileSync(p.sealedPath, typeof body === 'string' ? body : `${JSON.stringify(body || { schema: 1, kind: 'seal-marker', sealedAt: '2026-10-07T11:00:00-07:00', reason: 'abandoned' }, null, 2)}\n`);
  return p.sealedPath;
}

function putRaw(sessionsDir, number, name, text) {
  const folder = T.trackPaths(sessionsDir, number, 'a').folder;
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, name), text);
}

function cleanEnv(extra) {
  const env = Object.assign({}, process.env);
  for (const k of ['TPM_HOME', 'TPM_PROJECT_ROOT', 'CLAUDE_PROJECT_DIR', 'TPM_SESSIONS_DIR', 'TPM_TASKS_DIR', 'TPM_DEFAULTS_FILE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID']) delete env[k];
  return Object.assign(env, extra || {});
}

/** run(scriptPath, args, { id, pid, env }) -> { code, stdout, stderr }  — plays Claude instance `id`. */
function run(script, args, o) {
  const x = o || {};
  const extra = Object.assign({}, x.env || {});
  if (x.id) extra.CLAUDE_CODE_SESSION_ID = x.id;
  if (x.pid) extra.CLAUDE_PID = String(x.pid);
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: cleanEnv(extra), cwd: x.cwd });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const TOOLS = path.join(__dirname, '..', '..');
const CURRENT = path.join(TOOLS, 'tpm-session-current.js');
const OPS = path.join(TOOLS, 'tpm-session-ops.js');
const BOOT_READ = path.join(TOOLS, 'tpm-session-boot-read.js');

module.exports = { NOW, id, putTrack, putMarker, putRaw, cleanEnv, run, CURRENT, OPS, BOOT_READ, T, model };
