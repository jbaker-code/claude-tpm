#!/usr/bin/env node
'use strict';
/**
 * tpm-hook-contract.test.js — the hooks.json → process contract, end to end at unit level.
 *
 * Takes the EXACT `command` strings Claude Code will run from hooks/hooks.json, substitutes ${CLAUDE_PLUGIN_ROOT}
 * the way the harness does (the literal token inside the already-quoted command), and runs them through `sh -c`
 * with a realistic stdin payload + the env Claude Code provides — so a refactor of the hook scripts, the router, the
 * `node "<root>/tools/tpm.js" hooks <verb>` command form, or the hooks.json wiring all show up here.
 *
 *   SessionStart  → appends the right export lines to $CLAUDE_ENV_FILE, prints NOTHING (stdout can become model context)
 *   PreToolUse    → gate-spawn: ordinary Agent allowed silently; marked round spawn blocked (exit 2, stderr names the
 *                   bare-`tpm` fix) until a signoff exists; allowed after; fail-open on garbage
 * The plugin root is the real bundle (its path contains a SPACE here — which is exactly why the command quotes it)
 * and, separately, a SYMLINK to it (TPM_HOME must then be the realpath).
 *
 * Run: node tools/tests/tpm-hook-contract.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch');
const { BUNDLE, runTpm, makeFakeClaude, safeEnv } = require('./lib/guard-helpers');

const MANIFEST = JSON.parse(fs.readFileSync(path.join(BUNDLE, 'hooks', 'hooks.json'), 'utf8'));

/** The {matcher, command} entries for an event, straight from the shipped manifest. */
function entries(event) {
  const out = [];
  for (const g of MANIFEST.hooks[event] || []) for (const h of g.hooks || []) out.push({ matcher: g.matcher, type: h.type, command: h.command });
  return out;
}
const only = (event) => { const e = entries(event); assert.strictEqual(e.length, 1, `exactly one ${event} hook`); return e[0]; };

/** Run a hooks.json command string the way the harness does: ${CLAUDE_PLUGIN_ROOT} expanded, then a shell. */
function runCommand(command, pluginRoot, env, stdin) {
  const expanded = command.split('${CLAUDE_PLUGIN_ROOT}').join(pluginRoot);
  assert.ok(!expanded.includes('${'), 'no unexpanded ${…} left in the command: ' + expanded);
  const full = { PATH: env.PATH, ...env, CLAUDE_PLUGIN_ROOT: pluginRoot };
  const r = spawnSync('sh', ['-c', expanded], { env: full, input: stdin, encoding: 'utf8', timeout: 30000 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

let count = 0;
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-hook-contract.test.js\n');

const work = mkScratch('hook-contract');
const proj = path.join(work, 'my proj'); fs.mkdirSync(path.join(proj, '.claude', 'claude-tpm'), { recursive: true });
const sub = path.join(proj, 'src', 'deep'); fs.mkdirSync(sub, { recursive: true });
const link = path.join(work, 'plugin-link'); fs.symlinkSync(BUNDLE, link);
const fake = makeFakeClaude('hook-contract');
// base env: from scratch (no inherited TPM_*/CLAUDE_*), fake claude on PATH, temp HOME
const base = safeEnv(fake);

// ── manifest shape the harness relies on ──
check('hooks.json: SessionStart (no matcher) + PreToolUse matcher "Agent|Task" → each ONE `node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks <verb>` command', () => {
  const ss = only('SessionStart'); const pt = only('PreToolUse');
  assert.strictEqual(ss.type, 'command'); assert.strictEqual(pt.type, 'command');
  assert.strictEqual(ss.matcher, undefined);
  assert.strictEqual(pt.matcher, 'Agent|Task');
  assert.strictEqual(ss.command, 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks session-start');
  assert.strictEqual(pt.command, 'node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks gate-spawn');
});

// ── SessionStart ──
const SS_PAYLOAD = JSON.stringify({
  session_id: 'abc123-session', transcript_path: path.join(work, 'transcript.jsonl'), cwd: proj,
  hook_event_name: 'SessionStart', source: 'startup', model: 'claude-sonnet-5-5',
});

check('SessionStart: exact hooks.json command + realistic payload/env → both export lines appended, stdout EMPTY, exit 0', () => {
  const envFile = path.join(work, 'env-1.sh');
  const r = runCommand(only('SessionStart').command, BUNDLE, { ...base, CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: proj }, SS_PAYLOAD);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, '', 'stdout must stay empty — it can become model context');
  assert.strictEqual(r.err, '', 'stderr stays quiet too');
  const lines = fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean);
  assert.deepStrictEqual(lines, [
    `export TPM_PROJECT_ROOT='${proj}'`,
    `export TPM_HOME='${fs.realpathSync(BUNDLE)}'`,
  ]);
  // …and sourcing them yields exactly the project (space in the path survives) and the bundle
  const src = spawnSync('bash', ['-c', `source "${envFile}"; printf '%s\\n%s' "$TPM_PROJECT_ROOT" "$TPM_HOME"`], { encoding: 'utf8', env: { PATH: base.PATH } });
  assert.strictEqual(src.stdout, `${proj}\n${fs.realpathSync(BUNDLE)}`);
});

check('SessionStart: plugin root reached via a SYMLINK → TPM_HOME is the realpath; a second run is idempotent', () => {
  const envFile = path.join(work, 'env-2.sh');
  const env = { ...base, CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: proj };
  assert.strictEqual(runCommand(only('SessionStart').command, link, env, SS_PAYLOAD).status, 0);
  assert.strictEqual(runCommand(only('SessionStart').command, link, env, SS_PAYLOAD).status, 0);
  const lines = fs.readFileSync(envFile, 'utf8').split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2, 'no duplicate lines on a re-run: ' + lines.join(' | '));
  assert.ok(lines.includes(`export TPM_HOME='${fs.realpathSync(BUNDLE)}'`), 'realpath, not the link: ' + lines.join(' | '));
});

check('SessionStart: a user-set TPM_PROJECT_ROOT wins (that line skipped); no CLAUDE_ENV_FILE → silent exit 0, nothing created', () => {
  const envFile = path.join(work, 'env-3.sh');
  const r = runCommand(only('SessionStart').command, BUNDLE,
    { ...base, CLAUDE_ENV_FILE: envFile, CLAUDE_PROJECT_DIR: proj, TPM_PROJECT_ROOT: '/user/override' }, SS_PAYLOAD);
  assert.strictEqual(r.status, 0);
  const t = fs.readFileSync(envFile, 'utf8');
  assert.ok(!/TPM_PROJECT_ROOT/.test(t) && /TPM_HOME/.test(t), t);
  const none = runCommand(only('SessionStart').command, BUNDLE, { ...base, CLAUDE_PROJECT_DIR: proj }, SS_PAYLOAD);
  assert.strictEqual(none.status, 0); assert.strictEqual(none.out, '');
});

// ── gate-spawn ──
const ROUND = 'dev/demo-epic/01-build';
const marked = (extra) => JSON.stringify({
  session_id: 'abc123-session', cwd: sub, hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { description: 'build it', subagent_type: 'general-purpose',
    prompt: `<!-- tpm-workflow-spawn phase="${ROUND}" role="builder" -->\nDo the thing.`, ...extra },
});
const plain = JSON.stringify({ session_id: 'abc123-session', cwd: sub, hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: { description: 'look around', prompt: 'Find where the config is loaded.' } });
const gateEnv = { ...base, CLAUDE_PROJECT_DIR: proj };

check('gate-spawn: ordinary (unmarked) Agent call → allowed (exit 0), stdout+stderr empty', () => {
  const r = runCommand(only('PreToolUse').command, BUNDLE, gateEnv, plain);
  assert.deepStrictEqual([r.status, r.out, r.err], [0, '', '']);
});

check('gate-spawn: non-Agent tool (Bash) → allowed silently', () => {
  const r = runCommand(only('PreToolUse').command, BUNDLE, gateEnv, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: sub }));
  assert.deepStrictEqual([r.status, r.out, r.err], [0, '', '']);
});

check('gate-spawn: marked round spawn, NO signoff → BLOCK exit 2; reason on stderr (stdout empty) names the bare-`tpm` fix', () => {
  const r = runCommand(only('PreToolUse').command, BUNDLE, gateEnv, marked());
  assert.strictEqual(r.status, 2, r.err);
  assert.strictEqual(r.out, '', 'blocking reason goes to stderr only');
  assert.ok(/BLOCKED/.test(r.err));
  assert.ok(/tpm workflow signoff spawn --round "<phase-dir>" --roster "<one-line>"/.test(r.err), r.err);
  assert.ok(!/npx tpm/.test(r.err), 'the model-facing reason must say bare `tpm`');
});

check('gate-spawn: after the signoff is recorded (from a SUBFOLDER, root via TPM_PROJECT_ROOT) the same call is ALLOWED; a different round is still blocked', () => {
  const env = safeEnv(fake, { TPM_PROJECT_ROOT: proj });
  const q = runTpm(BUNDLE, ['workflow', 'signoff', 'questions', '--roster', 'x'], { cwd: sub, env });
  const s = runTpm(BUNDLE, ['workflow', 'signoff', 'spawn', '--round', ROUND, '--roster', 'x'], { cwd: sub, env });
  assert.strictEqual(q.status, 0, q.all); assert.strictEqual(s.status, 0, s.all);
  assert.ok(fs.existsSync(path.join(proj, 'tpm-tmp', 'tpm-signoff', 'questions.json')), 'questions token landed under the PROJECT root tpm-tmp, not the subfolder');
  assert.ok(fs.existsSync(path.join(proj, ROUND, 'tpm-tmp', 'tpm-signoff', 'spawn.json')), 'spawn token landed round-scoped under the PROJECT root');
  assert.ok(!fs.existsSync(path.join(sub, 'tpm-tmp')) && !fs.existsSync(path.join(sub, 'tmp')));
  const ok = runCommand(only('PreToolUse').command, BUNDLE, gateEnv, marked());
  assert.deepStrictEqual([ok.status, ok.out, ok.err], [0, '', '']);
  const other = marked().replace(ROUND, 'dev/demo-epic/02-other');
  assert.strictEqual(runCommand(only('PreToolUse').command, BUNDLE, gateEnv, other).status, 2, 'token is round-bound');
});

check('gate-spawn: fail-open — empty / garbage stdin → exit 0 and silent', () => {
  for (const junk of ['', 'not json {{{', '[]']) {
    const r = runCommand(only('PreToolUse').command, BUNDLE, gateEnv, junk);
    assert.deepStrictEqual([r.status, r.out], [0, ''], `stdin ${JSON.stringify(junk)}: ${r.err}`);
  }
});

check('both commands also run through a SYMLINKED plugin root (the quoted path survives spaces and links)', () => {
  assert.strictEqual(runCommand(only('PreToolUse').command, link, gateEnv, plain).status, 0);
  assert.strictEqual(runCommand(only('PreToolUse').command, link, gateEnv, marked()).status, 0, 'token from the previous check applies');
});

process.stdout.write(`\nPASS — ${count} checks\n`);
