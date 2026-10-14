#!/usr/bin/env node
/**
 * test.js — signoff.js (two-token ledger) + hooks/gate-spawn.js (PreToolUse spawn gate).
 * Zero-dep. `node test.js` → exit 0 all-pass. Sandboxes tokens under os.tmpdir() (never the
 * real tmp/tpm-signoff/). Drives the hook as a CHILD PROCESS with mock stdin payloads and
 * asserts its EXIT CODE (0 allow / 2 block) — i.e. it tests the actual harness contract.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkScratch } = require('../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

const signoff = require('../../tpm-workflow-signoff.js');
const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'tpm-workflow-gate-spawn.js');

let passed = 0; const failures = [];
const check = (c, m) => { if (c) passed += 1; else { failures.push(m); process.stderr.write(`  ✗ ${m}\n`); } };

// run the hook with a mock payload; return its exit code (0 allow, 2 block)
function runHook(payload) {
  // env without CLAUDE_PROJECT_DIR / TPM_PROJECT_ROOT: payload.cwd is the root under test (a live session's would win)
  const env = { ...process.env }; delete env.CLAUDE_PROJECT_DIR; delete env.TPM_PROJECT_ROOT;
  try { execFileSync('node', [HOOK], { input: JSON.stringify(payload), stdio: ['pipe', 'pipe', 'pipe'], env }); return 0; }
  catch (e) { return e.status; }
}
const ROUND = 'dev/x/01-y';
// a REAL composed round spawn carries the marker (what the hook keys off now):
const wfInput = { prompt: `You are a BUILDER subagent.\n<!-- tpm-workflow-spawn phase="${ROUND}" role="builder" -->\nRead charter-builder.md` };
// the #2 false-positive case: an ordinary agent whose prompt MENTIONS a charter + dev/ path but has NO
// marker → must NOT be gated (the old content-sniff would have blocked this).
const nonWfInput = { prompt: 'Go read charter-builder.md under dev/foo and summarize it.' };
const wfPayload = (cwd) => ({ tool_name: 'Agent', cwd, tool_input: wfInput });

const root = mkScratch('signoff-test');
// #1183: spawn tokens are round-scoped, so "clear everything" = the project-root store + each round's store.
const ROUNDS = [ROUND, 'dev/fanout/AA-a', 'dev/fanout/BB-b', 'dev/OTHER/02-z'];
const clearAll = () => { signoff.clearTokens({ root }); for (const r of ROUNDS) signoff.clearTokens({ root, round: r }); };
try {
  // ── #1183 store locations: signoffDir(root, round) ─────────────────────────
  check(signoff.signoffDir(root) === path.join(root, 'tpm-tmp', 'tpm-signoff'), 'signoffDir(root): project-root <root>/tpm-tmp/tpm-signoff (moved from tmp/)');
  check(signoff.signoffDir(root, ROUND) === path.join(root, ROUND, 'tpm-tmp', 'tpm-signoff'), 'signoffDir(root, round): round-scoped <root>/<round>/tpm-tmp/tpm-signoff');
  check(signoff.tokenPath('questions', root, ROUND) === path.join(root, 'tpm-tmp', 'tpm-signoff', 'questions.json'), 'questions token stays at the PROJECT root even when a round is given');
  check(signoff.tokenPath('spawn', root, ROUND) === path.join(root, ROUND, 'tpm-tmp', 'tpm-signoff', 'spawn.json'), 'spawn token is round-scoped with NO sha1 hash in the filename');

  // ── signoff: spawn REQUIRES a fresh questions token first ──────────────────
  let threw = false;
  try { signoff.writeToken('spawn', { root, roster: 'r' }); } catch (_e) { threw = true; }
  check(threw, 'signoff: writing a "spawn" token with no "questions" token throws (Gate B needs Gate A)');

  // ── questions → then spawn is allowed ──────────────────────────────────────
  signoff.writeToken('questions', { root, roster: 'round-1' });
  check(signoff.isFresh('questions', { root }).ok, 'signoff: fresh questions token reads back fresh');
  signoff.writeToken('spawn', { root, roster: 'round-1' });
  check(signoff.isFresh('spawn', { root }).ok, 'signoff: spawn token (after questions) reads back fresh');

  // ── REGRESSION (live-caught 2026-09-01): a STALE questions token must STILL allow writing a spawn
  //    token — Gate A → Gate B spans human latency; existence, not freshness, gates the spawn write. ──
  clearAll();
  fs.mkdirSync(signoff.signoffDir(root), { recursive: true });
  fs.writeFileSync(signoff.tokenPath('questions', root),   // questions answered ~2h ago
    JSON.stringify({ gate: 'questions', tsSec: Math.floor(Date.now() / 1000) - 7200, roster: 'round-1' }) + '\n');
  let staleQOk = true;
  try { signoff.writeToken('spawn', { root, roster: 'round-1' }); } catch (_e) { staleQOk = false; }
  check(staleQOk, 'signoff: a STALE questions token still allows writing a spawn token (existence, not freshness)');
  clearAll();
  signoff.writeToken('questions', { root, roster: 'round-1' }); // restore BOTH tokens for the checks below
  signoff.writeToken('spawn', { root, roster: 'round-1', round: ROUND }); // round matches wfInput's marker

  // ── staleness: an old token is NOT fresh ───────────────────────────────────
  // (spawn tokens are keyed by round now, so read with the SAME round the token was written for)
  const stale = signoff.isFresh('spawn', { root, round: ROUND, now: Date.now() + 2000 * 1000, maxAge: 1800 });
  check(!stale.ok && /STALE/.test(stale.reason), 'signoff: a token older than maxAge is STALE');

  // ── roster mismatch: a token for round A doesn't wave through round B ───────
  const mismatch = signoff.isFresh('spawn', { root, round: ROUND, roster: 'round-2' });
  check(!mismatch.ok && /DIFFERENT roster/.test(mismatch.reason), 'signoff: roster mismatch is rejected');

  // ── FAN-OUT (fix #3, 2026-09-01): spawn tokens are keyed BY ROUND, so N per-phase tokens coexist ──
  // (before this, a single spawn.json was overwritten → only the last round could spawn).
  signoff.writeToken('spawn', { root, roster: 'r', round: 'dev/fanout/AA-a' });
  signoff.writeToken('spawn', { root, roster: 'r', round: 'dev/fanout/BB-b' });
  check(
    signoff.isFresh('spawn', { root, round: 'dev/fanout/AA-a' }).ok
    && signoff.isFresh('spawn', { root, round: 'dev/fanout/BB-b' }).ok
    && signoff.isFresh('spawn', { root, round: ROUND }).ok,
    'signoff: multiple per-round spawn tokens coexist (parallel fan-out)',
  );

  // round isolation: a token for round A is NOT fresh for round B (different dir) and the files live in separate dirs
  check(!signoff.isFresh('spawn', { root, round: 'dev/never/99-none' }).ok, 'signoff: a spawn token for one round is NOT seen for a different round');
  check(fs.existsSync(path.join(root, 'dev/fanout/AA-a', 'tpm-tmp', 'tpm-signoff', 'spawn.json'))
    && fs.existsSync(path.join(root, 'dev/fanout/BB-b', 'tpm-tmp', 'tpm-signoff', 'spawn.json')), 'signoff: each round holds its own spawn.json in its own tpm-tmp/tpm-signoff');

  // ── round-aware clearTokens (#1183 D2): clears ONLY the named round's spawn token, no dev/** scan ──
  check(signoff.clearTokens({ root, round: 'dev/fanout/AA-a' }).join() === 'spawn', 'clearTokens({round}) removes that round\'s spawn token');
  check(!signoff.isFresh('spawn', { root, round: 'dev/fanout/AA-a' }).ok, 'clearTokens({round}): the cleared round is no longer fresh');
  check(signoff.isFresh('spawn', { root, round: 'dev/fanout/BB-b' }).ok && signoff.isFresh('spawn', { root, round: ROUND }).ok
    && signoff.isFresh('questions', { root }).ok, 'clearTokens({round}): sibling rounds + the project-root questions token survive');
  check(signoff.clearTokens({ root, round: 'dev/fanout/AA-a' }).length === 0, 'clearTokens({round}) on an already-cleared round removes nothing (no throw)');
  const rootRemoved = signoff.clearTokens({ root });
  check(rootRemoved.includes('questions') && !signoff.isFresh('questions', { root }).ok
    && signoff.isFresh('spawn', { root, round: ROUND }).ok, 'clearTokens({}) clears the project-root store only; round-scoped tokens are untouched (no dev/** scan)');
  signoff.writeToken('questions', { root, roster: 'round-1' }); // restore Gate A for the hook checks below

  // ── HOOK: workflow spawn + fresh token → ALLOW (exit 0) ────────────────────
  check(runHook(wfPayload(root)) === 0, 'hook: workflow spawn WITH a fresh spawn token → exit 0 (allow)');

  // ── HOOK: workflow spawn, NO fresh token → BLOCK (exit 2) ───────────────────
  clearAll();
  check(runHook(wfPayload(root)) === 2, 'hook: workflow spawn with NO spawn token → exit 2 (BLOCK)');

  // ── HOOK: workflow spawn, token present but STALE → BLOCK ───────────────────
  signoff.writeToken('questions', { root, roster: 'r', now: Date.now() - 4000 * 1000 });
  // write a spawn token directly (bypass the questions-freshness guard) with an old ts:
  fs.mkdirSync(signoff.signoffDir(root, ROUND), { recursive: true });
  fs.writeFileSync(signoff.tokenPath('spawn', root, ROUND),
    JSON.stringify({ gate: 'spawn', tsSec: Math.floor(Date.now() / 1000) - 4000, roster: 'r', round: ROUND }) + '\n');
  check(runHook(wfPayload(root)) === 2, 'hook: workflow spawn with a STALE spawn token → exit 2 (BLOCK)');

  // ── HOOK: MARKER present but token is for a DIFFERENT round → BLOCK (round-binding, #1) ──
  clearAll();
  signoff.writeToken('questions', { root });
  signoff.writeToken('spawn', { root, round: 'dev/OTHER/02-z' }); // token authorizes a different round
  check(runHook(wfPayload(root)) === 2, 'hook: marker round ≠ token round → exit 2 (BLOCK — one round\'s go can\'t wave through another)');
  // and a matching round → ALLOW
  signoff.writeToken('spawn', { root, round: ROUND });
  check(runHook(wfPayload(root)) === 0, 'hook: marker round == token round → exit 0 (allow)');

  // ── HOOK: NON-workflow agent → ALLOW regardless of tokens ──────────────────
  clearAll();
  check(runHook({ tool_name: 'Agent', cwd: root, tool_input: nonWfInput }) === 0,
    'hook: a plain agent that MENTIONS charter/work but has NO marker → exit 0 (allow) — #2 false-positive gone');

  // ── HOOK: non-Agent tool → ALLOW ───────────────────────────────────────────
  check(runHook({ tool_name: 'Bash', cwd: root, tool_input: { command: 'ls' } }) === 0,
    'hook: a non-Agent tool → exit 0 (allow)');

  // ── HOOK: garbage stdin → FAIL-OPEN (allow) ────────────────────────────────
  let failOpen = 0;
  try { execFileSync('node', [HOOK], { input: 'not json{{{', stdio: ['pipe', 'pipe', 'pipe'] }); }
  catch (e) { failOpen = e.status; }
  check(failOpen === 0, 'hook: malformed stdin → exit 0 (FAIL-OPEN — a hook bug never bricks spawning)');

  // ── COVERAGE (verifier concern #3, 2026-09-01): pin the fail-open + boundary behaviors the
  //    verifier confirmed correct-but-unpinned. ──
  for (const bad of ['', '   ', 'null', '42', 'false', '"a string"', '[]']) {
    let code = 0;
    try { execFileSync('node', [HOOK], { input: bad, stdio: ['pipe', 'pipe', 'pipe'] }); } catch (e) { code = e.status; }
    check(code === 0, `hook: bad/edge stdin ${JSON.stringify(bad)} → exit 0 (fail-open)`);
  }
  // exact-maxAge boundary + one-past
  clearAll();
  signoff.writeToken('questions', { root, roster: 'r' });
  const t0 = Math.floor(Date.now() / 1000);
  fs.writeFileSync(signoff.tokenPath('spawn', root), JSON.stringify({ gate: 'spawn', tsSec: t0, roster: 'r' }) + '\n');
  check(signoff.isFresh('spawn', { root, now: (t0 + 1800) * 1000, maxAge: 1800 }).ok,
    'signoff: a token EXACTLY maxAge old is still fresh (strict > boundary)');
  check(!signoff.isFresh('spawn', { root, now: (t0 + 1801) * 1000, maxAge: 1800 }).ok,
    'signoff: one second past maxAge is STALE');
  // clock skew (future-dated token)
  const skew = signoff.isFresh('spawn', { root, now: (t0 - 100) * 1000, maxAge: 1800 });
  check(!skew.ok && /future/.test(skew.reason), 'signoff: a future-dated token (clock skew) is rejected');
  // session binding
  fs.writeFileSync(signoff.tokenPath('spawn', root), JSON.stringify({ gate: 'spawn', tsSec: t0, roster: 'r', sessionId: 'SESS-A' }) + '\n');
  const sMiss = signoff.isFresh('spawn', { root, sessionId: 'SESS-B' });
  check(!sMiss.ok && /DIFFERENT session/.test(sMiss.reason), 'signoff: a token from a DIFFERENT session is rejected when sessionId supplied');
  check(signoff.isFresh('spawn', { root, sessionId: 'SESS-A' }).ok, 'signoff: matching sessionId is accepted');
  // Task-tool path (handled like Agent)
  clearAll();
  check(runHook({ tool_name: 'Task', cwd: root, tool_input: wfInput }) === 2,
    'hook: a Task-tool workflow spawn with no token → exit 2 (Task handled like Agent)');

  process.stdout.write(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed\n`);
  process.exit(failures.length ? 1 : 0);
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
}
