#!/usr/bin/env node
'use strict';
/**
 * tpm-env-leak-guard.test.js — no test may leak into a REAL environment, and no live Claude session's env may leak INTO a test.
 *
 * (1) RUNNER ISOLATION — every runner (top-level, session, task, consumer, workflow) must clear TPM_PROJECT_ROOT, TPM_HOME and
 *     CLAUDE_PROJECT_DIR before it launches children. Proven DYNAMICALLY: each runner is copied into a temp tree with its
 *     target list replaced by a probe that fails if any of the three vars is set; the runner is run with decoys set → green.
 *     (Control: the same probe run directly with the decoys → red. Bite: a runner copy with the `delete` removed → red.)
 * (2) SOURCE AUDIT — no test source may read the real home (os.homedir(), process.env.HOME), hard-code a real `claude` binary
 *     path, spawn `claude`/`npm`/`npx` by bare name, or reach the network (http/https/net/dns/tls, fetch, curl/wget).
 *     Any test that drives the installer / uninstaller / `tpm plugin|install|uninstall` must also carry a fake `claude` shim.
 *     The audit function is itself proven on synthetic offenders.
 * (3) SENTINEL RUN — the claude-adjacent suites are executed for real with sentinel `claude` / `npm` / `npx` shims first on PATH
 *     (HOME + CLAUDE_CONFIG_DIR in scratch, npm registry pointed nowhere). If any test reaches an AMBIENT claude/npm/npx (i.e. does
 *     not put its own fake first), the sentinel logs it and this test fails. (Tolerated: the installer preflight's read-only
 *     `npm --version` probe — local, no registry, no network.) (This is how the old `claude --version` probe in the
 *     uninstaller's claudeCliAvailable test was caught.)
 *
 * Run: node tools/tests/tpm-env-leak-guard.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch');
const { walk, BUNDLE } = require('./lib/guard-helpers');

const TOOLS = path.join(BUNDLE, 'tools');
const VARS = ['TPM_PROJECT_ROOT', 'TPM_HOME', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'TPM_SESSION_ID'];
const SELF = path.relative(BUNDLE, __filename);

let count = 0;
const pending = [];
function check(name, fn) { fn(); count += 1; process.stdout.write(`  ✓ ${name}\n`); }
process.stdout.write('tpm-env-leak-guard.test.js\n');

// ═══ (1) runner isolation ═════════════════════════════════════════════════════════════════════════════════════════
const PROBE = `#!/usr/bin/env node
const set = ${JSON.stringify(VARS)}.filter((v) => process.env[v] !== undefined);
if (set.length) { console.error('LEAKED into child: ' + set.join(', ')); process.exit(1); }
console.log('probe clean');
`;
const DECOYS = Object.fromEntries(VARS.map((v) => [v, '/nonexistent-decoy-' + v.toLowerCase()]));

/** Copy one runner into <tmp>/tools/<rel dir>/ (+ lib/scratch.js + a bundle marker), target list swapped for a probe. */
function stageRunner(relRunner, kind) {
  const root = mkScratch('runner-stage');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: '@codercowboy/claude-tpm', version: '0.0.0-probe' }));
  fs.mkdirSync(path.join(root, 'tools', 'tests', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(TOOLS, 'tests', 'lib', 'scratch.js'), path.join(root, 'tools', 'tests', 'lib', 'scratch.js'));
  const dest = path.join(root, 'tools', path.dirname(relRunner));
  fs.mkdirSync(dest, { recursive: true });
  let src = fs.readFileSync(path.join(TOOLS, relRunner), 'utf8');
  if (kind === 'glob') { // session/task: enumerate *.test.js in their own dir
    fs.writeFileSync(path.join(dest, 'probe.test.js'), PROBE);
  } else { // top-level / workflow / consumer: a TARGETS/SUITES array → single probe.js
    const re = /const (TARGETS|SUITES) = \[[\s\S]*?\n\];/;
    assert.ok(re.test(src), `${relRunner}: target list not found`);
    src = src.replace(re, 'const $1 = [\'probe.js\'];');
    // the top-level runner resolves its targets against <bundle>/tools; the group runners against their own dir
    fs.writeFileSync(path.join(kind === 'top' ? path.join(root, 'tools') : dest, 'probe.js'), PROBE);
  }
  const runner = path.join(dest, path.basename(relRunner));
  fs.writeFileSync(runner, src);
  return runner;
}
const RUNNERS = [
  ['tests/run-all.js', 'top'], ['session/tests/run-all.js', 'glob'], ['task/tests/run-all.js', 'glob'],
  ['consumer/tests/run-all.js', 'list'], ['workflow/tests/run-all.js', 'list'],
];
const runnerEnv = { PATH: process.env.PATH, ...DECOYS };
const runRunner = (runner, env) => spawnSync('node', [runner], { env, encoding: 'utf8', timeout: 60000 });

check('control: the probe itself detects each decoy (so a green runner means the runner really stripped them)', () => {
  const root = mkScratch('probe-ctl'); const p = path.join(root, 'probe.js'); fs.writeFileSync(p, PROBE);
  assert.strictEqual(spawnSync('node', [p], { env: { PATH: process.env.PATH }, encoding: 'utf8' }).status, 0);
  for (const v of VARS) {
    const r = spawnSync('node', [p], { env: { PATH: process.env.PATH, [v]: '/x' }, encoding: 'utf8' });
    assert.strictEqual(r.status, 1, v); assert.ok(r.stderr.includes(v));
  }
});

for (const [rel, kind] of RUNNERS) {
  check(`runner ${rel}: with TPM_PROJECT_ROOT / TPM_HOME / CLAUDE_PROJECT_DIR set in ITS env, the children see none of them`, () => {
    const r = runRunner(stageRunner(rel, kind), runnerEnv);
    assert.strictEqual(r.status, 0, `${rel} leaked:\n${r.stdout}\n${r.stderr}`);
    assert.ok(/probe clean|1 suites run, 0 failed|PASS|1\/1/.test(r.stdout), r.stdout);
  });
}

check('BITE: a runner copy whose `delete env.<VAR>` lines are removed IS caught (each of the three vars)', () => {
  for (const v of VARS) {
    const runner = stageRunner('tests/run-all.js', 'top');
    const s = fs.readFileSync(runner, 'utf8');
    const t = s.replace(new RegExp(`\\s*delete env\\.${v};[^\\n]*`), '');
    assert.notStrictEqual(t, s, `${v}: delete line not found in the runner`);
    fs.writeFileSync(runner, t);
    const r = runRunner(runner, runnerEnv);
    assert.notStrictEqual(r.status, 0, `${v} no longer stripped, yet the runner stayed green`);
    assert.ok(r.stdout.includes(v) || r.stderr.includes(v), `${v} named in failure: ${r.stdout}${r.stderr}`);
  }
});

// ═══ (2) source audit ═════════════════════════════════════════════════════════════════════════════════════════════
const SHIM_MARKER = /(fake-claude|FAKE_CLAUDE|CLAUDE_SHIM|stubBin|makeFakeClaude|FAKE_NPM|path\.join\([^)]*['"`]claude['"`]\))/;
const DRIVES_INSTALLER = /(tpm-consumer-(install|uninstall)\.js|\[\s*['"`](plugin|install|uninstall)['"`]|tpm-plugin-router)/;
const RULES = [
  [/os\.homedir\s*\(|process\.env\.HOME\b/, 'reads the REAL home dir (use a scratch HOME)'],
  [/\/(\.local\/bin|usr\/local\/bin|opt\/homebrew\/bin)\/claude\b/, 'hard-codes a real claude binary path'],
  [/\b(spawn|spawnSync|execFile|execFileSync|exec|execSync)\(\s*['"`](claude|npx|npm)['"`]/, 'spawns claude/npm/npx by bare name (resolves on the AMBIENT PATH)'],
  [/require\(\s*['"`](node:)?(https?|net|tls|dns|http2|dgram)['"`]\s*\)/, 'requires a network module'],
  [/\bfetch\s*\(|XMLHttpRequest|\b(curl|wget)\s/, 'reaches for the network'],
];
/** Problems in one test source. `allow` = rule indexes this file is explicitly cleared for (documented in ALLOWED). */
function auditSource(rel, text, allow) {
  const out = [];
  const code = text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  RULES.forEach(([re, why], i) => { if (!(allow || []).includes(i) && re.test(code)) out.push(`${rel}: ${why}`); });
  const isRunner = /run-all\.js$/.test(rel);
  if (!isRunner && DRIVES_INSTALLER.test(code) && !SHIM_MARKER.test(code)) out.push(`${rel}: drives the installer/doctor but carries no fake claude shim`);
  return out;
}
// Cleared exceptions (rule indexes), each with the reason:
const ALLOWED = {
  // tpm-package-contents runs the REAL `npm pack --dry-run/--ignore-scripts --offline` on a temp COPY with scratch HOME + cache (no registry, no publish).
  'tools/tests/tpm-package-contents.test.js': [2],
  // the sentinel runner below deliberately spawns / writes shims named claude/npm/npx.
  [`tools/tests/${path.basename(__filename)}`]: [0, 1, 2, 3, 4],
  // the audit's own regex sources live in this file only.
};
const testSources = () => walk(TOOLS, (p) => {
  const rel = path.relative(TOOLS, p).split(path.sep);
  return p.endsWith('.js') && rel.includes('tests') && !rel.includes('fixtures') && !rel.includes('smoke') && !rel.includes('golden');
});

check('AUDIT: no test source reads the real home, hard-codes a real claude path, spawns claude/npm/npx by bare name, or touches the network', () => {
  const files = testSources();
  assert.ok(files.length > 70, `audit too narrow (${files.length} files)`);
  const bad = [];
  for (const f of files) {
    const rel = posix(path.relative(BUNDLE, f));
    bad.push(...auditSource(rel, fs.readFileSync(f, 'utf8'), ALLOWED[rel]));
  }
  assert.deepStrictEqual(bad, []);
});

function posix(p) { return p.split(path.sep).join('/'); }

check('AUDIT: every test that drives the installer / uninstaller / `tpm plugin|install|uninstall` carries a fake claude shim (and there are some)', () => {
  const drivers = testSources().filter((f) => !/run-all\.js$/.test(f) && DRIVES_INSTALLER.test(fs.readFileSync(f, 'utf8')));
  assert.ok(drivers.length >= 4, 'expected the consumer + router tests to match the trigger: ' + drivers.length);
  for (const f of drivers) assert.ok(SHIM_MARKER.test(fs.readFileSync(f, 'utf8')), `${path.relative(BUNDLE, f)} drives the installer without a shim`);
});

check('BITE (audit): synthetic offenders are each flagged; a shimmed installer test and a clean test are not', () => {
  const bad = (src, rel) => auditSource(rel || 'x.test.js', src, []);
  assert.ok(bad("const h = os.homedir();").length);
  assert.ok(bad("fs.readFileSync(process.env.HOME + '/.claude/settings.json')").length);
  assert.ok(bad("spawnSync('claude', ['--version'])").length);
  assert.ok(bad("spawnSync('npx', ['tpm'])").length);
  assert.ok(bad("const x = '/Users/a/.local/bin/claude';").length);
  assert.ok(bad("const https = require('https');").length);
  assert.ok(bad("await fetch('http://x')").length);
  assert.ok(bad("spawnSync('node', ['tools/consumer/tpm-consumer-install.js', dir])").some((m) => /no fake claude shim/.test(m)));
  assert.deepStrictEqual(bad("const shim = path.join(bin, 'claude'); spawnSync('node', ['tpm-consumer-install.js', dir])"), []);
  assert.deepStrictEqual(bad("assert.ok(true);\n// spawnSync('claude', ['x']) appears only in a comment\n * os.homedir() in a doc block"), []);
});

// ═══ (3) sentinel run ═════════════════════════════════════════════════════════════════════════════════════════════
const sentinelDir = mkScratch('sentinel');
const sBin = path.join(sentinelDir, 'bin'); const sHome = path.join(sentinelDir, 'home'); const sLog = path.join(sentinelDir, 'calls.log');
fs.mkdirSync(sBin, { recursive: true }); fs.mkdirSync(path.join(sHome, '.claude'), { recursive: true });
for (const name of ['claude', 'npm', 'npx']) {
  fs.writeFileSync(path.join(sBin, name), `#!/bin/sh\necho "${name} $*" >> "${sLog}"\nexit 0\n`, { mode: 0o755 });
}
const sentinelEnv = {
  PATH: `${sBin}${path.delimiter}${process.env.PATH}`, HOME: sHome, CLAUDE_CONFIG_DIR: path.join(sHome, '.claude'),
  TMPDIR: process.env.TMPDIR || require('os').tmpdir(),
  npm_config_offline: 'true', npm_config_registry: 'http://127.0.0.1:9/', npm_config_cache: path.join(sHome, 'npm-cache'),
};

check('control: the sentinel catches an ambient `claude` call', () => {
  const r = spawnSync('sh', ['-c', 'claude --version; npx something'], { env: sentinelEnv, encoding: 'utf8' });
  assert.strictEqual(r.status, 0);
  const log = fs.readFileSync(sLog, 'utf8');
  assert.ok(/^claude --version$/m.test(log) && /^npx something$/m.test(log), log);
  fs.writeFileSync(sLog, '');
});

const SENTINEL_SUITES = [
  'tests/tpm-router.test.js', 'tests/tpm-bin-shim.test.js', 'tests/tpm-stamp-manifests.test.js', 'tests/tpm-hook-contract.test.js',
  'hooks/tests/tpm-hooks-session-start.test.js',
  'consumer/tests/tpm-consumer-install/test.js', 'consumer/tests/tpm-consumer-uninstall/test.js',
  'consumer/tests/tpm-consumer-doctor/test.js', 'consumer/tests/tpm-consumer-lint-skill-refs/test.js', 'consumer/tests/tpm-consumer-run-all/test.js',
  'workflow/tests/tpm-workflow-doctor/test.js', 'workflow/tests/tpm-workflow-root-env/test.js',
].filter((rel) => fs.existsSync(path.join(TOOLS, rel)));

// children run in parallel (the install suite dominates); results are checked after they all finish
const ran = SENTINEL_SUITES.map((rel) => new Promise((resolve) => {
  const child = spawn('node', [path.join(TOOLS, rel)], { env: { ...sentinelEnv, TPM_TEST_RUN: process.env.TPM_TEST_RUN }, stdio: ['ignore', 'pipe', 'pipe'] }); // cwd stays the invoker's (the bundle is itself a marked project; several suites rely on that)
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 280000);
  child.on('close', (code) => { clearTimeout(timer); resolve({ rel, code, out }); });
}));

Promise.all(ran).then((results) => {
  check(`SENTINEL: ${results.length} claude-adjacent suites ran green under sentinel claude/npm/npx shims`, () => {
    const red = results.filter((r) => r.code !== 0);
    assert.deepStrictEqual(red.map((r) => r.rel), [], red.map((r) => `${r.rel}:\n${r.out.slice(-600)}`).join('\n'));
  });
  check('SENTINEL: not one of them reached an AMBIENT claude / npx / mutating npm (the installer preflight\'s read-only `npm --version` probe is the one tolerated call)', () => {
    const log = (fs.existsSync(sLog) ? fs.readFileSync(sLog, 'utf8') : '').split('\n').filter(Boolean);
    const leaks = log.filter((l) => l !== 'npm --version');
    assert.deepStrictEqual(leaks, [], 'a test called the ambient CLI:\n' + leaks.join('\n'));
  });
  process.stdout.write(`\nPASS — ${count} checks\n`);
}).catch((e) => { console.error(e); process.exit(1); });
