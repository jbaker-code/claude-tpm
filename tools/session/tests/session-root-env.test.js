'use strict';
/**
 * session-root-env.test.js — session tools resolve the project from $TPM_PROJECT_ROOT (D8, punchlist 3.2).
 *
 * Real CLI runs from a cwd that is NOT the project. Covers `tpm-session-config.js --sessions-dir`,
 * `--json` (projectRoot), and the verbs that resolve the sessions dir through resolveSessionsDir
 * (`tpm-session-current.js`, `tpm-session-boot-read.js`), plus explicit-beats-env and bad-env fallthrough.
 *
 * Run: node tests/session-root-env.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');

const S = path.join(__dirname, '..');
function run(script, args, cwd, envRoot) {
  const env = { ...process.env };
  delete env.TPM_PROJECT_ROOT;
  delete env.TPM_SESSIONS_DIR;
  if (envRoot !== undefined) env.TPM_PROJECT_ROOT = envRoot;
  const r = spawnSync(process.execPath, [path.join(S, script), ...args], { cwd, env, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
function mkProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
  return root;
}

const base = fs.realpathSync(tmpDir('tpm-session-rootenv-'));
const fixture = mkProject(base, 'fixture');
const other = mkProject(base, 'other');
const unrelated = path.join(base, 'unrelated');
fs.mkdirSync(unrelated);
const fixtureSessions = path.join(fixture, '.claude', 'claude-tpm', 'sessions');
const otherSessions = path.join(other, '.claude', 'claude-tpm', 'sessions');

test('config --sessions-dir from an unrelated cwd + env=fixture → the fixture sessions dir', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir'], unrelated, fixture);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), fixtureSessions);
});

test('config --sessions-dir from a subfolder of ANOTHER project + env=fixture → env wins', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir'], path.join(other, 'sub'), fixture);
  assert.strictEqual(r.stdout.trim(), fixtureSessions);
});

test('env unset: subfolder walk-up finds its own project (unchanged)', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir'], path.join(other, 'sub'));
  assert.strictEqual(r.stdout.trim(), otherSessions);
});

test('bad env value: warns naming TPM_PROJECT_ROOT, falls through to walk-up', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir'], path.join(other, 'sub'), path.join(base, 'nope'));
  assert.strictEqual(r.stdout.trim(), otherSessions);
  assert.ok(r.stderr.includes('TPM_PROJECT_ROOT'), r.stderr);
});

test('explicit --config beats the env (a missing explicit config is a loud error, not an env fallback)', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir', '--config', path.join(other, '.claude', 'claude-tpm', 'x.json')], unrelated, fixture);
  assert.notStrictEqual(r.code, 0);
});

test('session `current --open` from an unrelated cwd + env=fixture writes ONLY under the fixture sessions dir', () => {
  const r = run('tpm-session-current.js', ['--open'], unrelated, fixture);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(fixtureSessions, '.current-session.json')), 'pointer written in the fixture');
  // Tracks store: --open now also creates the session folder + the track-a record (all under the fixture).
  assert.ok(fs.existsSync(path.join(fixtureSessions, 'session-0001', 'session-0001.json')), 'record created in the fixture');
  assert.ok(!fs.existsSync(path.join(unrelated, '.claude')), 'nothing created in the cwd');
  assert.ok(!fs.existsSync(otherSessions), 'the other project is untouched');
});

test('session `boot-read` from an unrelated cwd + env=fixture reads the fixture sessions dir', () => {
  const r = run('tpm-session-boot-read.js', [], unrelated, fixture);
  assert.ok((r.stdout + r.stderr).includes(fixtureSessions), r.stdout + r.stderr);
  assert.ok(!fs.existsSync(path.join(unrelated, '.claude')), 'nothing created in the cwd');
});

test('no env, cwd outside any project: config --sessions-dir WARNS loudly naming the folder it guessed', () => {
  const r = run('tpm-session-config.js', ['--sessions-dir'], unrelated);
  assert.ok(r.stderr.includes('.claude/claude-tpm'), r.stderr);
  assert.ok(r.stderr.includes(unrelated), r.stderr);
});

test('no env, cwd outside any project: `current` refuses (no silent store)', () => {
  const r = run('tpm-session-current.js', ['--state'], unrelated);
  assert.notStrictEqual(r.code, 0);
  assert.ok(!fs.existsSync(path.join(unrelated, '.claude', 'claude-tpm', 'sessions')), 'no sessions dir created');
});

done('session-root-env');
