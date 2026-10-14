#!/usr/bin/env node
/**
 * tpm workflow signoff — the two-token user-sign-off ledger for tpm-workflow kickoffs.
 *
 * WHY
 *   Kicking off a workflow round spawns subagents = real work + tokens. Prose rules
 *   ("the user directs every kickoff") are bypassable — the model can rationalize a
 *   rambly turn into a "go". This tool makes the sign-off a DETERMINISTIC ARTIFACT the
 *   PreToolUse spawn-gate hook (hooks/tpm-workflow-gate-spawn.js) can verify — code, not judgment.
 *
 * TWO TOKENS (Jason's model — they are DIFFERENT events):
 *   1. "questions"  — the user was shown the pre-task roster/questions and ANSWERED them.
 *                     Gates SCAFFOLDING (scaffold-subagent add-phase can require it).
 *   2. "spawn"      — the user was asked "kick it off now?" and EXPLICITLY confirmed.
 *                     Gates the SPAWN ITSELF (the hook checks THIS one, and it must be FRESH).
 *   The second is the critical one: answering questions, or a rambly "process what I'm
 *   saying" turn, is NOT a spawn confirmation. A "spawn" token requires a "questions" token to
 *   EXIST (Gate A happened) — existence, NOT freshness, since Gate A → Gate B spans human latency;
 *   the freshness that matters is on the "spawn" token, checked by the hook right before the spawn.
 *
 * Tokens are small JSON files under <projectRoot>/tpm-tmp/tpm-signoff/ (questions + round-less spawn), or for a
 * round-scoped spawn token <projectRoot>/<round>/tpm-tmp/tpm-signoff/spawn.json (#1183). Each carries a
 * timestamp (freshness is the load-bearing check — a stale "go" doesn't authorize a new
 * round) + the session id + a one-line roster description (so a token for round A can't be
 * silently reused to wave through a different round B).
 *
 * USAGE
 *   tpm workflow signoff questions --roster "<one-line>"                    # token 1 (after the user answers)
 *   tpm workflow signoff spawn --round "<phase-dir>" --roster "<one-line>"  # token 2 (after an explicit "kick it off")
 *       --round is the phase-folder path the kickoff authorizes; the hook matches it to the spawn's
 *       `tpm-workflow-spawn phase=…` marker so one round's "go" can't authorize a different round.
 *       Spawn tokens are ROUND-SCOPED (`<round>/tpm-tmp/tpm-signoff/spawn.json`), so a PARALLEL FAN-OUT (an epic of N
 *       phases) can hold N fresh per-phase tokens at once — one `spawn --round <phase>` per phase, or
 *       one epic-level token (`--round <epic-path>`) with every phase marker set to `phase="<epic-path>"`.
 *   tpm workflow signoff check --gate spawn|questions [--roster "…"] [--round "…"] [--max-age <sec>]
 *                                                          # exit 0 if a FRESH matching token exists, else 1
 *       --session <ref> / --track <letter>  (questions|spawn) attribute the token to a session (0012b, or 0012 --track b); default: auto-resolved
 *   tpm workflow signoff status                                 # print both tokens' freshness (human-readable)
 *   tpm workflow signoff clear [--round "<phase-dir>"]          # no --round: clear project-root questions + spawn; --round: clear ONLY that round's spawn token
 *   tpm workflow signoff --help
 *
 * CONVENTIONS: zero deps (Node built-ins only). Run via `tpm workflow signoff …`. Also a module
 * (module.exports) so the hook + tests drive the pure helpers directly.
 *
 * DEFAULT FRESHNESS: 1800s (30 min). Long enough for a round's spawns to follow one
 * confirmation; short enough that yesterday's "go" can't authorize today's round.
 */

'use strict';

const fs = require('fs');
const path = require('path');
// #1133 — shared root resolver (deliberate cross-suite exception; see findProjectRoot below).
const { findRoot } = require('../lib/paths');
// Phase 18 — informational session stamp (shared resolver; never throws, never blocks). Keys tpmSession/tpmSessionVia, NOT `session`.
const { resolveAttribution, toEventFields, parseExplicit } = require('../lib/attribution');

const DEFAULT_MAX_AGE_SEC = 1800; // 30 min
const GATES = ['questions', 'spawn'];

// ── project root: shared resolver keyed on the .claude/claude-tpm footprint ──
// #1133 — deliberate cross-suite shared-lib exception (see tools/lib/paths.js);
// keeps signoff-token placement aligned with the task/session resolvers.
function findProjectRoot(startDir) {
  return findRoot({ startDir });
}

// #1188 — the configured scratch-folder name (workflow.folders.tmp, default `tpm-tmp`), resolved from `root`.
// Mirrors the composer's resolveTmpName. NEVER throws: the gate hook calls signoffDir on every spawn.
function resolveTmpName(root) {
  try {
    const cr = require('./tpm-workflow-config-resolver.js');
    const r = cr.resolveConfig(undefined, { startDir: root || undefined }).resolved;
    if (r && r.folders && typeof r.folders.tmp === 'string' && r.folders.tmp) return r.folders.tmp;
    return cr.getDefaults().folders.tmp;
  } catch (_e) {
    return 'tpm-tmp';
  }
}

// #1183 D1 — the store lives under the per-work-folder `tpm-tmp`. With a `round` (the phase-folder path the
// kickoff authorizes) it is ROUND-SCOPED: <root>/<round>/tpm-tmp/tpm-signoff. Without one it is the project-root
// store <root>/tpm-tmp/tpm-signoff. Clean break: NO legacy `tmp/` fallback. path.resolve so a relative OR
// absolute round both resolve correctly under a space-bearing root.
function signoffDir(root, round) {
  const r = root || findProjectRoot();
  const rd = (round || '').trim();
  const tmp = resolveTmpName(r);
  if (rd) return path.join(path.resolve(r, rd), tmp, 'tpm-signoff');
  return path.join(r, tmp, 'tpm-signoff');
}
// #1183 D2 — token split. The "questions" token is single and stays at the PROJECT ROOT (`questions.json`; Gate A
// gates scaffolding, which runs before the phase folder exists). The "spawn" token is ROUND-SCOPED: it lives in the
// round's own `tpm-tmp/tpm-signoff/spawn.json` — the directory IS the scope, so the old sha1-of-round filename is
// gone — and a PARALLEL FAN-OUT still holds N fresh per-phase tokens at once (one dir per phase). A round-less
// spawn write falls back to the project-root `spawn.json` (back-compat).
function tokenPath(gate, root, round) {
  if (gate === 'spawn' && round) return path.join(signoffDir(root, round), 'spawn.json');
  return path.join(signoffDir(root), `${gate}.json`);
}

// ── write a token ───────────────────────────────────────────────────────────
function writeToken(gate, { roster, root, now, round, explicit } = {}) {
  if (!GATES.includes(gate)) throw new Error(`unknown gate "${gate}" (expected: ${GATES.join(', ')}).`);
  const r = root || findProjectRoot();
  // "spawn" requires that a "questions" token EXISTS — you cannot confirm a kickoff for a roster the
  // user was never shown + answered. NOTE: existence, NOT freshness. Gate A → Gate B legitimately spans
  // human latency (the user may answer the roster, wander off, and confirm the spawn an hour later — this
  // very check was mis-tuned as "fresh" and blocked a real Gate-B "go" 105 min after Gate A). The freshness
  // that matters lives on the "spawn" token itself (written seconds before the spawn, verified by the hook).
  if (gate === 'spawn') {
    const q = readToken('questions', { root: r });
    if (!q.ok) {
      throw new Error('cannot write a "spawn" token: no "questions" token exists (Gate A never happened — '
        + 'the roster was not presented + answered). Present the roster + capture the user\'s answers first, '
        + 'THEN get an explicit "kick it off".');
    }
  }
  const roundNorm = (round || '').trim() || null;
  const dir = path.dirname(tokenPath(gate, r, roundNorm));
  fs.mkdirSync(dir, { recursive: true });
  const nowMs = now || Date.now();
  const token = {
    gate,
    tsSec: Math.floor(nowMs / 1000),
    // NOTE: iso is informational; freshness math uses tsSec. (new Date().toISOString() is fine
    // in a normal node process — this is NOT the workflow-script sandbox.)
    iso: new Date(nowMs).toISOString(),
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    roster: (roster || '').trim() || null,
    // round = the phase-folder path (e.g. "dev/<epic>/<NN-slug>") this "kick it off" authorizes. The
    // hook matches it against the `tpm-workflow-spawn phase=…` MARKER that compose-spawn-prompt stamps into
    // every real round spawn, so a token for round A can't wave through round B (verifier concern #1).
    round: roundNorm,
  };
  // Informational only (nothing reads these; isFresh compares sessionId, never tpmSession). Blank -> keys omitted.
  try {
    const f = toEventFields(resolveAttribution({ explicit }));
    if (f.session) { token.tpmSession = f.session; token.tpmSessionVia = f.sessionVia; }
  } catch (_e) { /* stamping never blocks */ }
  fs.writeFileSync(tokenPath(gate, r, roundNorm), JSON.stringify(token, null, 2) + '\n');
  return token;
}

// ── read a token (raw) ──────────────────────────────────────────────────────
function readToken(gate, { root, round } = {}) {
  try {
    const raw = fs.readFileSync(tokenPath(gate, root, round), 'utf8');
    const token = JSON.parse(raw);
    return { ok: true, token };
  } catch (_e) {
    return { ok: false, token: null };
  }
}

/**
 * Is there a FRESH token for this gate? Freshness = (now - token.tsSec) <= maxAge.
 * Optional roster match: if `roster` is given, the token's roster must equal it (so a
 * confirmation for round A can't wave through round B). Optional session match: if the
 * caller has a sessionId and the token has one, they must match.
 * @returns {{ok, reason, token, ageSec}}
 */
function isFresh(gate, { root, maxAge = DEFAULT_MAX_AGE_SEC, roster, now, sessionId, round } = {}) {
  const res = readToken(gate, { root, round });
  if (!res.ok) return { ok: false, reason: `no "${gate}" sign-off token on disk`, token: null };
  const t = res.token;
  const nowSec = Math.floor((now || Date.now()) / 1000);
  const ageSec = nowSec - (t.tsSec || 0);
  if (ageSec > maxAge) {
    return { ok: false, reason: `"${gate}" sign-off is STALE (${ageSec}s old > ${maxAge}s max)`, token: t, ageSec };
  }
  if (ageSec < 0) {
    return { ok: false, reason: `"${gate}" sign-off timestamp is in the future (clock skew?)`, token: t, ageSec };
  }
  if (roster && (t.roster || '') !== roster) {
    return { ok: false, reason: `"${gate}" sign-off is for a DIFFERENT roster ("${t.roster}" ≠ "${roster}")`, token: t, ageSec };
  }
  if (round && (t.round || '') !== round) {
    return { ok: false, reason: `"${gate}" sign-off is for a DIFFERENT round ("${t.round}" ≠ "${round}")`, token: t, ageSec };
  }
  const sid = sessionId || process.env.CLAUDE_CODE_SESSION_ID;
  if (sid && t.sessionId && t.sessionId !== sid) {
    return { ok: false, reason: `"${gate}" sign-off is from a DIFFERENT session`, token: t, ageSec };
  }
  return { ok: true, reason: 'fresh', token: t, ageSec };
}

// Remove sign-off tokens. Round-aware (#1183 D2): with an explicit `round`, clear ONLY that round's spawn token
// (its round-scoped dir) — no dev/** scan. Without a round, clear the PROJECT-ROOT store: questions.json + spawn.json.
function clearTokens({ root, round } = {}) {
  const removed = [];
  const rd = (round || '').trim();
  const dir = signoffDir(root, rd || undefined);
  const names = rd ? ['spawn.json'] : ['questions.json', 'spawn.json'];
  for (const f of names) {
    try { fs.unlinkSync(path.join(dir, f)); removed.push(f.replace(/\.json$/, '')); } catch (_e) { /* absent -> ignore */ }
  }
  return removed;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === '-h' || x === '--help') a.help = true;
    else if (x === '--roster') { a.roster = argv[i + 1]; i += 1; }
    else if (x === '--round') { a.round = argv[i + 1]; i += 1; }
    else if (x === '--session') { a.session = argv[i + 1]; i += 1; }
    else if (x === '--track') { a.track = argv[i + 1]; i += 1; }
    else if (x === '--gate') { a.gate = argv[i + 1]; i += 1; }
    else if (x === '--max-age') { a.maxAge = parseInt(argv[i + 1], 10); i += 1; }
    else if (x.startsWith('--')) { process.stderr.write(`Unknown flag: ${x}\n`); process.exit(2); }
    else a._.push(x);
  }
  return a;
}

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const m = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (m) process.stdout.write(m[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args._[0]) { printHelp(); process.exit(args.help ? 0 : 1); }
  const cmd = args._[0];
  let explicit = null;
  if (args.session !== undefined || args.track !== undefined) {
    const x = parseExplicit({ session: args.session, track: args.track });
    if (!x.ok) { process.stderr.write(`signoff: ${x.error}\n`); process.exit(2); }
    explicit = x.ref;
  }
  try {
    if (cmd === 'questions' || cmd === 'spawn') {
      const t = writeToken(cmd, { roster: args.roster, round: args.round, explicit });
      process.stdout.write(`✓ wrote "${cmd}" sign-off token (${t.iso})${t.round ? ` for round: ${t.round}` : ''}${t.roster ? ` — ${t.roster}` : ''}\n`);
    } else if (cmd === 'check') {
      const gate = args.gate;
      if (!GATES.includes(gate)) { process.stderr.write(`check: --gate must be one of ${GATES.join(', ')}\n`); process.exit(2); }
      const res = isFresh(gate, { maxAge: args.maxAge || DEFAULT_MAX_AGE_SEC, roster: args.roster, round: args.round });
      if (res.ok) { process.stdout.write(`OK: fresh "${gate}" sign-off (${res.ageSec}s old)\n`); process.exit(0); }
      process.stderr.write(`DENY: ${res.reason}\n`); process.exit(1);
    } else if (cmd === 'status') {
      for (const gate of GATES) {
        const res = isFresh(gate, {});
        process.stdout.write(`${gate.padEnd(10)} ${res.ok ? `FRESH (${res.ageSec}s)` : `— ${res.reason}`}\n`);
      }
    } else if (cmd === 'clear') {
      const removed = clearTokens({ round: args.round });
      process.stdout.write(`cleared: ${removed.length ? removed.join(', ') : '(none)'}\n`);
    } else {
      process.stderr.write(`Unknown command: ${cmd}\n`); printHelp(); process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`signoff: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  findProjectRoot, signoffDir, tokenPath, writeToken, readToken, isFresh, clearTokens,
  DEFAULT_MAX_AGE_SEC, GATES,
};
