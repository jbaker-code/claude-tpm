#!/usr/bin/env node
/**
 * tests/config-resolver.test.js — self-contained test for tools/config-resolver.js.
 *
 * PURPOSE
 *   Exercises the reusable module API AND the CLI (as a real subprocess, asserting exit codes +
 *   stdout/stderr). Builds a scratch fake "project" under <bundle>/tmp/scratch (its own
 *   .claude/claude-tpm/ marker dir + config.json, and charter files) so project-root resolution and file
 *   existence checks are fully self-contained — no dependency on the real repo's layout.
 *
 * HOW TO RUN
 *   node tests/config-resolver.test.js
 *   Exits 0 with "ALL PASS" if every assertion holds, else prints the failure(s) and exits 1.
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { mkScratch } = require('../../../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

// The CANONICAL promoted tool at tools/workflow/ (four levels up from this dir) — run against the
// SHIPPED tool, not a checked-in copy (which used to drift).
const TOOL = path.join(__dirname, '..', '..', '..', '..', 'tpm-workflow-config-resolver.js');
const {
  resolveConfig,
  validateResolved,
  getDefaults,
  findProjectRoot,
  mergeWorkflowConfig,
  getDotted,
} = require(TOOL);

let passCount = 0;
function check(label, fn) {
  fn();
  passCount += 1;
  process.stdout.write(`  PASS: ${label}\n`);
}

function runCLI(args, opts = {}) {
  try {
    const stdout = execFileSync('node', [TOOL, ...args], { encoding: 'utf8', ...opts });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}

// --- scratch fake project ---
const root = mkScratch('config-resolver-test');
fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# fake project marker\n');
fs.mkdirSync(path.join(root, 'charters'), { recursive: true });
fs.writeFileSync(path.join(root, 'charters', 'exists.md'), '# a real charter\n');
fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });

// The promoted charter homes the defaults now reference (fix #1 + relocatable fix). Create them under
// `root` so a config that leaves most charterFiles at their wired defaults still `--validate`s OK.
// The defaults are now ABSOLUTE, bundle-anchored paths — so point the resolver's bundle root at `root`
// (via the TPM_BUNDLE_ROOT override) where we create the tree, instead of this file's real position.
process.env.TPM_BUNDLE_ROOT = root;
const HOME_DIR = path.join(root, 'claude-context', 'methodology', 'workflow-setup', 'charters');
fs.mkdirSync(HOME_DIR, { recursive: true });
for (const stem of ['planning', 'shipping', 'test-writer', 'documentarian', 'verifier', 'bug-fixer', 'research']) {
  fs.writeFileSync(path.join(HOME_DIR, `${stem}-charter.md`), `# ${stem} charter\n`);
}

const defaultLocationConfig = {
  version: 1,
  workflow: { deliverables: { tldr: false } },
};
fs.writeFileSync(
  path.join(root, '.claude', 'claude-tpm', 'config.json'),
  JSON.stringify(defaultLocationConfig, null, 2),
);

const validConfigPath = path.join(root, 'config-valid.json');
fs.writeFileSync(
  validConfigPath,
  JSON.stringify(
    {
      version: 1,
      workflow: {
        subagentConfigs: [{ name: 'builder', charterFile: 'charters/exists.md' }],
      },
    },
    null,
    2,
  ),
);

const missingRefConfigPath = path.join(root, 'config-missing-ref.json');
fs.writeFileSync(
  missingRefConfigPath,
  JSON.stringify(
    {
      version: 1,
      workflow: {
        subagentConfigs: [{ name: 'builder', charterFile: 'charters/does-not-exist.md' }],
      },
    },
    null,
    2,
  ),
);

const richConfigPath = path.join(root, 'config-rich.json');
fs.writeFileSync(
  richConfigPath,
  JSON.stringify(
    {
      version: 1,
      workflow: {
        subagentConfigs: [
          { name: 'builder', defaultModel: 'sonnet', retryCount: 3 },
          { name: 'designer', defaultModel: 'opus', charterFile: '' },
        ],
        teams: [{ name: 'solo', subagents: [{ name: 'builder' }] }],
        deliverables: { wiki: false },
        verifier: { multiCountMode: 'scoped-lenses' },
        charterVariants: { builder: { alternates: [], addenda: [] } },
        blockedFilenamePatterns: ['report', 'summary', 'analysis', 'findings', 'draft'],
      },
    },
    null,
    2,
  ),
);

function main() {
  process.stdout.write('config-resolver.test.js\n');

  // --- module API: defaults ---
  check('getDefaults returns the documented default shape', () => {
    const d = getDefaults();
    assert.strictEqual(d.enabled, true);
    // The 7 shipped personas. Per-round opt-downs are handled by charterVariants (config-guide §2),
    // NOT an 8th `mvp` persona — that was a superseded design the old test copy froze.
    assert.strictEqual(d.subagentConfigs.length, 7);
    assert.deepStrictEqual(
      d.subagentConfigs.map((s) => s.name),
      ['planning', 'builder', 'test-writer', 'documentarian', 'verifier', 'bug-fixer', 'researcher'],
    );
    assert.deepStrictEqual(d.teams.map((t) => t.name), ['full', 'ship', 'test', 'docs', 'research', 'build']);
    assert.strictEqual(d.defaultParallelism, 'serial');
    assert.strictEqual(d.verifyLoopCap, 5);
    assert.deepStrictEqual(d.deliverables, { tldr: true, toolFeedback: true, wiki: true });
    assert.deepStrictEqual(d.verifier, { requireAllPass: true, multiCountMode: 'blind-pair', loopFixer: 'bug-fixer' });
    assert.deepStrictEqual(d.blockedFilenamePatterns, ['report', 'summary', 'analysis', 'findings']);
    assert.strictEqual(d.subagentEnvTemplate, '', 'subagentEnvTemplate defaults to "" (fix #3)');
  });

  // --- tightening fix #1 + relocatable fix (2026-09-01): every subagentConfigs[].charterFile is an
  //     ABSOLUTE, bundle-anchored path ending at its promoted charter home (so it resolves whether the
  //     bundle is the repo root or vendored in a consumer's node_modules), never the "" placeholder no-op. ---
  check('fix #1: all 7 default charterFiles are absolute bundle paths ending at the promoted home', () => {
    const path = require('path');
    const d = getDefaults();
    const HOME = 'claude-context/methodology/workflow-setup/charters';
    const wantStem = {
      planning: 'planning', builder: 'shipping', 'test-writer': 'test-writer',
      documentarian: 'documentarian', verifier: 'verifier', 'bug-fixer': 'bug-fixer',
      researcher: 'research',
    };
    for (const sc of d.subagentConfigs) {
      const stem = wantStem[sc.name];
      assert.ok(stem, `unexpected persona ${sc.name}`);
      assert.ok(path.isAbsolute(sc.charterFile), `${sc.name}.charterFile must be ABSOLUTE (relocatable) — got "${sc.charterFile}"`);
      assert.ok(
        sc.charterFile.endsWith(`${HOME}/${stem}-charter.md`),
        `${sc.name}.charterFile must end at ${HOME}/${stem}-charter.md (got "${sc.charterFile}")`,
      );
      assert.notStrictEqual(sc.charterFile, '', `${sc.name}.charterFile must not be the "" placeholder no-op`);
    }
    // builder maps to the SHIPPING charter (not builder-charter.md); researcher → research-charter.md.
    const by = Object.fromEntries(d.subagentConfigs.map((s) => [s.name, s]));
    assert.ok(/shipping-charter\.md$/.test(by.builder.charterFile), 'builder → shipping charter');
    assert.ok(/research-charter\.md$/.test(by.researcher.charterFile), 'researcher → research charter');
  });

  // --- expanded persona / team / loop model (design doc §"Persona / team / loop model") ---
  check('the 3 new personas ship with defaultModel opus, a wired charterFile, and the right retryCount', () => {
    const d = getDefaults();
    const by = Object.fromEntries(d.subagentConfigs.map((s) => [s.name, s]));
    for (const name of ['test-writer', 'documentarian', 'bug-fixer']) {
      assert.ok(by[name], `persona ${name} present`);
      assert.strictEqual(by[name].defaultModel, 'opus', `${name} defaultModel opus`);
      // fix #1: charterFile is now the wired home, no longer the "" placeholder no-op.
      assert.ok(by[name].charterFile.endsWith(`${name}-charter.md`), `${name} charterFile wired to its home`);
    }
    assert.strictEqual(by['test-writer'].retryCount, 1, 'test-writer retryCount 1');
    assert.strictEqual(by['documentarian'].retryCount, 1, 'documentarian retryCount 1');
    assert.strictEqual(by['bug-fixer'].retryCount, 5, 'bug-fixer retryCount 5');
  });

  check('the 2 new teams roster their delivery agent → verifier, in run order', () => {
    const d = getDefaults();
    const byTeam = Object.fromEntries(d.teams.map((t) => [t.name, t.subagents.map((s) => s.name)]));
    assert.deepStrictEqual(byTeam['test'], ['test-writer', 'verifier'], 'test team = test-writer → verifier');
    assert.deepStrictEqual(byTeam['docs'], ['documentarian', 'verifier'], 'docs team = documentarian → verifier');
  });

  check('full is re-rostered to planning→builder→test-writer→documentarian→verifier (array = run order)', () => {
    const full = getDefaults().teams.find((t) => t.name === 'full');
    assert.deepStrictEqual(
      full.subagents.map((s) => s.name),
      ['planning', 'builder', 'test-writer', 'documentarian', 'verifier'],
    );
  });

  check('ship / build / research teams are unchanged by the expansion', () => {
    const byTeam = Object.fromEntries(getDefaults().teams.map((t) => [t.name, t.subagents.map((s) => s.name)]));
    assert.deepStrictEqual(byTeam['ship'], ['builder', 'verifier'], 'ship unchanged');
    assert.deepStrictEqual(byTeam['build'], ['builder'], 'build unchanged');
    assert.deepStrictEqual(byTeam['research'], ['researcher'], 'research unchanged');
  });

  check('verifier.loopFixer defaults to "bug-fixer" and getDotted resolves it', () => {
    const d = getDefaults();
    assert.strictEqual(d.verifier.loopFixer, 'bug-fixer');
    const { found, value } = getDotted(d, 'verifier.loopFixer');
    assert.strictEqual(found, true);
    assert.strictEqual(value, 'bug-fixer');
  });

  check('absent config → loopFixer default survives (resolveConfig with no config)', () => {
    const isolatedRoot = mkScratch('config-resolver-loopfixer');
    fs.mkdirSync(path.join(isolatedRoot, '.claude', 'claude-tpm'), { recursive: true }); // #1133 marker (was CLAUDE.md)
    const { resolved } = resolveConfig(undefined, { startDir: isolatedRoot });
    assert.strictEqual(resolved.verifier.loopFixer, 'bug-fixer');
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });

  check('a child overriding verifier.multiCountMode keeps the loopFixer default (shallow-merge)', () => {
    const resolved = mergeWorkflowConfig({ verifier: { multiCountMode: 'scoped-lenses' } });
    assert.strictEqual(resolved.verifier.loopFixer, 'bug-fixer', 'untouched loopFixer survives the merge');
    assert.strictEqual(resolved.verifier.multiCountMode, 'scoped-lenses');
  });

  check('a child can repoint verifier.loopFixer at its own fixer persona', () => {
    const resolved = mergeWorkflowConfig({ verifier: { loopFixer: 'patcher' } });
    assert.strictEqual(resolved.verifier.loopFixer, 'patcher');
    assert.strictEqual(resolved.verifier.requireAllPass, true, 'other verifier defaults preserved');
  });

  // --- module API: merge semantics ---
  check('mergeWorkflowConfig with undefined -> defaults untouched', () => {
    assert.deepStrictEqual(mergeWorkflowConfig(undefined), getDefaults());
  });

  check('mergeWorkflowConfig overrides an existing subagentConfigs entry by name', () => {
    const resolved = mergeWorkflowConfig({ subagentConfigs: [{ name: 'builder', defaultModel: 'sonnet' }] });
    const builder = resolved.subagentConfigs.find((s) => s.name === 'builder');
    assert.strictEqual(builder.defaultModel, 'sonnet');
    assert.strictEqual(builder.retryCount, 5); // untouched field preserved from default
    assert.ok(/shipping-charter\.md$/.test(builder.charterFile)); // untouched wired charterFile preserved
    assert.strictEqual(resolved.subagentConfigs.length, 7); // no new entry appended (the 7 shipped personas)
  });

  check('mergeWorkflowConfig appends a new-named subagentConfigs entry', () => {
    const resolved = mergeWorkflowConfig({ subagentConfigs: [{ name: 'designer', defaultModel: 'opus' }] });
    assert.strictEqual(resolved.subagentConfigs.length, 8); // the 7 shipped + the appended `designer`
    assert.ok(resolved.subagentConfigs.some((s) => s.name === 'designer'));
  });

  check('mergeWorkflowConfig shallow-merges deliverables (untouched keys survive)', () => {
    const resolved = mergeWorkflowConfig({ deliverables: { wiki: false } });
    assert.deepStrictEqual(resolved.deliverables, { tldr: true, toolFeedback: true, wiki: false });
  });

  check('#1183: defaults carry workflow.folders + workflow.devDir', () => {
    const d = getDefaults();
    assert.deepStrictEqual(d.folders, { tmp: 'tpm-tmp', findings: 'findings', tools: 'tools', tests: 'tests' });
    assert.strictEqual(d.devDir, 'dev');
  });

  check('#1183: mergeWorkflowConfig applies folders.tmp + devDir overrides (not dropped), shallow-merging folders', () => {
    const resolved = mergeWorkflowConfig({ folders: { tmp: 'scratch-x' }, devDir: 'docs/dev' });
    assert.strictEqual(resolved.folders.tmp, 'scratch-x');
    assert.strictEqual(resolved.folders.findings, 'findings');
    assert.strictEqual(resolved.folders.tools, 'tools');
    assert.strictEqual(resolved.folders.tests, 'tests');
    assert.strictEqual(resolved.devDir, 'docs/dev');
    assert.strictEqual(mergeWorkflowConfig({ devDir: 42 }).devDir, 'dev', 'non-string devDir ignored');
  });

  check('#1183: a project config.json override of folders.tmp + devDir flows through resolveConfig', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'tpm-1183-'));
    fs.mkdirSync(path.join(proj, '.claude', 'claude-tpm'), { recursive: true });
    fs.writeFileSync(
      path.join(proj, '.claude', 'claude-tpm', 'config.json'),
      JSON.stringify({ workflow: { folders: { tmp: 'my-tmp' }, devDir: 'work' } }),
    );
    const { resolved } = resolveConfig(undefined, { startDir: proj });
    assert.strictEqual(resolved.folders.tmp, 'my-tmp');
    assert.strictEqual(resolved.folders.findings, 'findings');
    assert.strictEqual(resolved.devDir, 'work');
    fs.rmSync(proj, { recursive: true, force: true });
  });

  check('mergeWorkflowConfig replaces blockedFilenamePatterns wholesale', () => {
    const resolved = mergeWorkflowConfig({ blockedFilenamePatterns: ['draft'] });
    assert.deepStrictEqual(resolved.blockedFilenamePatterns, ['draft']);
  });

  check('fix #3: mergeWorkflowConfig passes through subagentEnvTemplate (string)', () => {
    const resolved = mergeWorkflowConfig({ subagentEnvTemplate: '.claude/claude-tpm/subagent.env.template' });
    assert.strictEqual(resolved.subagentEnvTemplate, '.claude/claude-tpm/subagent.env.template');
    // a non-string is ignored (default '' survives)
    const ignored = mergeWorkflowConfig({ subagentEnvTemplate: 42 });
    assert.strictEqual(ignored.subagentEnvTemplate, '');
  });

  check('mergeWorkflowConfig charterVariants merge per-role', () => {
    const resolved = mergeWorkflowConfig({ charterVariants: { builder: { alternates: ['x.md'] } } });
    assert.deepStrictEqual(resolved.charterVariants.builder.alternates, ['x.md']);
  });

  // --- module API: getDotted ---
  check('getDotted resolves a nested path', () => {
    const { found, value } = getDotted(getDefaults(), 'verifier.requireAllPass');
    assert.strictEqual(found, true);
    assert.strictEqual(value, true);
  });

  check('getDotted reports not-found for a bogus path', () => {
    const { found } = getDotted(getDefaults(), 'nope.nothing');
    assert.strictEqual(found, false);
  });

  // --- module API: findProjectRoot ---
  check('findProjectRoot finds the .claude/claude-tpm marker walking up from a nested dir', () => {
    const nested = path.join(root, 'charters');
    assert.strictEqual(findProjectRoot(nested), root);
  });

  check('findProjectRoot falls back to startDir when no marker exists anywhere up the tree', () => {
    const isolatedRoot = mkScratch('config-resolver-noroot');
    // No .claude/claude-tpm marker is seeded here; findRoot walks up and either hits the bundle's
    // own footprint or bottoms out at startDir — either way it returns a non-empty path, never throws.
    const found = findProjectRoot(isolatedRoot);
    assert.ok(typeof found === 'string' && found.length > 0);
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });

  // --- module API: resolveConfig + validateResolved ---
  check('resolveConfig on a missing default location returns defaults, no throw', () => {
    const isolatedRoot = mkScratch('config-resolver-nodefault');
    fs.mkdirSync(path.join(isolatedRoot, '.claude', 'claude-tpm'), { recursive: true }); // #1133 marker (was CLAUDE.md)
    const { resolved, usedDefaultLocation, configExists } = resolveConfig(undefined, { startDir: isolatedRoot });
    assert.strictEqual(usedDefaultLocation, true);
    assert.strictEqual(configExists, false);
    assert.deepStrictEqual(resolved, getDefaults());
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });

  check('resolveConfig with an explicit missing --config path throws', () => {
    assert.throws(() => resolveConfig(path.join(root, 'nope.json'), { startDir: root }), /does not exist/);
  });

  check('resolveConfig reads and merges an explicit config path', () => {
    const { resolved, configExists } = resolveConfig(richConfigPath, { startDir: root });
    assert.strictEqual(configExists, true);
    assert.strictEqual(resolved.deliverables.wiki, false);
    assert.strictEqual(resolved.verifier.multiCountMode, 'scoped-lenses');
  });

  check('validateResolved passes when referenced charterFile exists', () => {
    const { resolved } = resolveConfig(validConfigPath, { startDir: root });
    const { ok, missing } = validateResolved(resolved, root);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(missing, []);
  });

  check('validateResolved fails when referenced charterFile is missing', () => {
    const { resolved } = resolveConfig(missingRefConfigPath, { startDir: root });
    const { ok, missing } = validateResolved(resolved, root);
    assert.strictEqual(ok, false);
    assert.strictEqual(missing.length, 1);
    assert.ok(/does-not-exist\.md$/.test(missing[0].filePath));
  });

  check('fix #1: validateResolved CHECKS every wired default charter home (relocatable, bundle-anchored)', () => {
    // The default charters are now ABSOLUTE, bundle-anchored (not project-root-relative), so vary the
    // BUNDLE root: point it at a fresh empty dir → all 8 defaults resolve there and are reported MISSING
    // (proving validation CHECKS them, not ignores them); then create them → --validate passes.
    const isolatedRoot = mkScratch('config-resolver-fwd');
    const savedBundle = process.env.TPM_BUNDLE_ROOT;
    try {
      process.env.TPM_BUNDLE_ROOT = isolatedRoot;
      fs.mkdirSync(path.join(isolatedRoot, '.claude', 'claude-tpm'), { recursive: true }); // #1133 marker (was CLAUDE.md)
      const { resolved } = resolveConfig(undefined, { startDir: isolatedRoot });
      const { ok, missing } = validateResolved(resolved, isolatedRoot);
      assert.strictEqual(ok, false, 'bundle has no charters yet → not ok');
      const missKeys = missing.map((m) => m.key);
      for (const role of ['planning', 'builder', 'test-writer', 'documentarian', 'verifier', 'bug-fixer', 'researcher']) {
        assert.ok(missKeys.includes(`subagentConfigs[${role}].charterFile`), `${role} charterFile is validated`);
      }
      for (const stem of ['planning', 'shipping', 'test-writer', 'documentarian', 'verifier', 'bug-fixer', 'research']) {
        const abs = path.join(isolatedRoot, 'claude-context', 'methodology', 'workflow-setup', 'charters', `${stem}-charter.md`);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, `# ${stem} charter\n`);
      }
      const after = validateResolved(resolveConfig(undefined, { startDir: isolatedRoot }).resolved, isolatedRoot);
      assert.strictEqual(after.ok, true, 'once the charters exist under the bundle root, --validate passes');
    } finally {
      if (savedBundle === undefined) delete process.env.TPM_BUNDLE_ROOT; else process.env.TPM_BUNDLE_ROOT = savedBundle;
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  check('fix #3: validateResolved checks a configured subagentEnvTemplate', () => {
    const resolved = mergeWorkflowConfig({ subagentEnvTemplate: 'nope/missing.template', subagentConfigs: [] });
    // strip the charter homes so this asserts ONLY the env-template check
    resolved.subagentConfigs = [];
    const { ok, missing } = validateResolved(resolved, root);
    assert.strictEqual(ok, false);
    assert.ok(missing.some((m) => m.key === 'subagentEnvTemplate'), 'subagentEnvTemplate is validated when set');
  });

  // --- CLI, as a real subprocess, cwd pinned to the scratch project root ---
  check('CLI: --help -> exit 0', () => {
    const r = runCLI(['--help']);
    assert.strictEqual(r.code, 0);
    assert.ok(/Usage:/.test(r.stdout));
  });

  check('CLI: no action flag -> exit 1 usage error', () => {
    const r = runCLI([]);
    assert.strictEqual(r.code, 1);
  });

  check('CLI: --json on a sample config emits resolved config w/ subagentConfigs/teams/charterVariants/deliverables/verifier', () => {
    const r = runCLI(['--config', richConfigPath, '--json'], { cwd: root });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.subagentConfigs));
    assert.ok(Array.isArray(parsed.teams));
    assert.ok(parsed.charterVariants && typeof parsed.charterVariants === 'object');
    assert.ok(parsed.deliverables && parsed.deliverables.wiki === false);
    assert.ok(parsed.verifier && parsed.verifier.multiCountMode === 'scoped-lenses');
    assert.deepStrictEqual(parsed.blockedFilenamePatterns, ['report', 'summary', 'analysis', 'findings', 'draft']);
  });

  check('CLI: absent config (no --config, empty default location) -> built-in defaults', () => {
    const isolatedRoot = mkScratch('config-resolver-cli-nodefault');
    fs.mkdirSync(path.join(isolatedRoot, '.claude', 'claude-tpm'), { recursive: true }); // #1133 marker (was CLAUDE.md)
    const r = runCLI(['--json'], { cwd: isolatedRoot });
    assert.strictEqual(r.code, 0);
    const parsed = JSON.parse(r.stdout);
    assert.deepStrictEqual(parsed, getDefaults());
    fs.rmSync(isolatedRoot, { recursive: true, force: true });
  });

  check('CLI: --config pointing at a real default-location file is picked up implicitly', () => {
    const r = runCLI(['--get', 'deliverables.tldr'], { cwd: root });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout.trim(), 'false'); // set to false in .claude/claude-tpm/config.json above
  });

  check('CLI: --get a valid dotted key -> exit 0, JSON value on stdout', () => {
    const r = runCLI(['--config', richConfigPath, '--get', 'verifier.multiCountMode'], { cwd: root });
    assert.strictEqual(r.code, 0);
    assert.strictEqual(r.stdout.trim(), '"scoped-lenses"');
  });

  check('CLI: --get a bogus dotted key -> friendly error + exit 1', () => {
    const r = runCLI(['--config', richConfigPath, '--get', 'nope.nothing'], { cwd: root });
    assert.strictEqual(r.code, 1);
    assert.ok(r.stderr.length > 0);
  });

  check('CLI: --validate with a missing charterFile -> friendly error + exit 1', () => {
    const r = runCLI(['--config', missingRefConfigPath, '--validate'], { cwd: root });
    assert.strictEqual(r.code, 1);
    assert.ok(/does-not-exist\.md/.test(r.stderr), `expected missing path in stderr, got: ${r.stderr}`);
  });

  check('CLI: --validate with all referenced files present -> OK + exit 0', () => {
    const r = runCLI(['--config', validConfigPath, '--validate'], { cwd: root });
    assert.strictEqual(r.code, 0);
    assert.ok(/OK/.test(r.stdout));
  });

  check('CLI: --config pointing nowhere -> friendly error + exit 1', () => {
    const r = runCLI(['--config', path.join(root, 'does-not-exist.json'), '--json'], { cwd: root });
    assert.strictEqual(r.code, 1);
    assert.ok(/does not exist/.test(r.stderr));
  });

  // =========================================================================
  // TEST-HARDENING ROUND (28) — four guard-neutering mutants the canonical
  // suites left GREEN (fable-2/#4 + fable-3/#5): the unrecognized-version
  // warning, the bad-JSON error path, check-filename's --patterns-beats-config
  // precedence, and — the mvp opt-down's ONLY machine check — --validate over
  // charterVariants.<role>.alternates[]. Each is deliberate-mutation-proved in
  // tests/mutation-check.js.
  // =========================================================================
  const { spawnSync } = require('child_process');

  // ── unrecognized-version warning path (best-effort resolve, warn on stderr) ──
  check('CLI: an unrecognized config version WARNS on stderr but resolves (exit 0)', () => {
    const vPath = path.join(root, 'config-v2.json');
    fs.writeFileSync(vPath, JSON.stringify({ version: 2, workflow: { deliverables: { wiki: false } } }, null, 2));
    // spawnSync so stderr is captured even on a zero-exit (runCLI only keeps stderr on throw).
    const r = spawnSync('node', [TOOL, '--config', vPath, '--json'], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `best-effort resolve should still exit 0, got ${r.status}`);
    assert.ok(/warning/i.test(r.stderr) && /version 2/.test(r.stderr), `expected an unrecognized-version warning on stderr, got: ${JSON.stringify(r.stderr)}`);
    // and the resolve still succeeded (json emitted)
    assert.ok(/"subagentConfigs"/.test(r.stdout), 'best-effort resolve still emits the resolved config');
  });
  check('a SUPPORTED version (1) emits NO version warning (control)', () => {
    const vPath = path.join(root, 'config-v1.json');
    fs.writeFileSync(vPath, JSON.stringify({ version: 1, workflow: {} }, null, 2));
    const r = spawnSync('node', [TOOL, '--config', vPath, '--json'], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.ok(!/version/i.test(r.stderr), `no version warning expected for v1, got: ${JSON.stringify(r.stderr)}`);
  });

  // ── bad-JSON error path (malformed config → friendly error, not silent defaults) ─
  check('CLI: a malformed config JSON is a friendly error + exit 1 (bad-JSON path)', () => {
    const badPath = path.join(root, 'config-bad.json');
    fs.writeFileSync(badPath, '{ "workflow": { not valid json ,,, }');
    const r = runCLI(['--config', badPath, '--json'], { cwd: root });
    assert.strictEqual(r.code, 1, `malformed JSON must exit 1, got ${r.code}`);
    assert.ok(/could not parse/.test(r.stderr), `expected a parse error on stderr, got: ${r.stderr}`);
  });
  check('resolveConfig throws on malformed JSON (bad-JSON path, module API)', () => {
    const badPath = path.join(root, 'config-bad2.json');
    fs.writeFileSync(badPath, '{ nope not json');
    assert.throws(() => resolveConfig(badPath, { startDir: root }), /could not parse/);
  });

  // ── check-filename: --patterns BEATS --config (precedence guard) ──────────────
  // check-filename.js is the blocked-name sibling the scaffolder + lint both use.
  // Its documented precedence is "--patterns wins over --config"; nothing pinned it.
  check('check-filename: --patterns BEATS --config (precedence guard)', () => {
    const CHECK_FILENAME = path.join(__dirname, '..', '..', '..', '..', 'tpm-workflow-check-filename.js');
    // --config lists "notes" (would block), --patterns lists "xyz" (would NOT).
    const cfgBlocksNotes = path.join(root, 'cf-blocks-notes.json');
    fs.writeFileSync(cfgBlocksNotes, JSON.stringify({ workflow: { blockedFilenamePatterns: ['notes'] } }));
    const winsA = spawnSync('node', [CHECK_FILENAME, 'notes.md', '--patterns', 'xyz', '--config', cfgBlocksNotes], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(winsA.status, 0, `--patterns must WIN → notes.md not blocked → exit 0, got ${winsA.status} (${winsA.stderr})`);
    // converse: --patterns lists "notes" (blocks), --config lists only "zzz" (clean).
    const cfgClean = path.join(root, 'cf-clean.json');
    fs.writeFileSync(cfgClean, JSON.stringify({ workflow: { blockedFilenamePatterns: ['zzz'] } }));
    const winsB = spawnSync('node', [CHECK_FILENAME, 'notes.md', '--patterns', 'notes', '--config', cfgClean], { cwd: root, encoding: 'utf8' });
    assert.strictEqual(winsB.status, 1, `--patterns "notes" must block notes.md even with a clean --config → exit 1, got ${winsB.status}`);
  });

  // ── --validate over charterVariants.<role>.alternates[] (mvp opt-down's ONLY
  //    machine check) — a missing alternate must be reported. ──────────────────
  check('--validate CHECKS charterVariants.<role>.alternates[] (the opt-down machine check)', () => {
    // Strip the wired default charter homes so this asserts ONLY the alternates check.
    const resolved = mergeWorkflowConfig({ charterVariants: { builder: { alternates: ['charters/missing-mvp.md'] } } });
    resolved.subagentConfigs = [];
    const { ok, missing } = validateResolved(resolved, root);
    assert.strictEqual(ok, false, 'a missing alternate must make validate not-ok');
    assert.ok(
      missing.some((m) => m.key === 'charterVariants.builder.alternates[]'),
      `alternates[] must be validated; got keys: ${missing.map((m) => m.key).join(', ')}`,
    );
    // control: an EXISTING alternate (charters/exists.md, created above) passes.
    const okResolved = mergeWorkflowConfig({ charterVariants: { builder: { alternates: ['charters/exists.md'] } } });
    okResolved.subagentConfigs = [];
    assert.strictEqual(validateResolved(okResolved, root).ok, true, 'once the alternate exists, validate passes');
  });
  check('--validate also checks charterVariants.<role>.addenda[] (sibling of alternates)', () => {
    const resolved = mergeWorkflowConfig({ charterVariants: { builder: { addenda: ['charters/missing-addendum.md'] } } });
    resolved.subagentConfigs = [];
    const { ok, missing } = validateResolved(resolved, root);
    assert.strictEqual(ok, false);
    assert.ok(missing.some((m) => m.key === 'charterVariants.builder.addenda[]'), 'addenda[] is validated too');
  });

  fs.rmSync(root, { recursive: true, force: true });

  process.stdout.write(`\nALL PASS (${passCount} assertions)\n`);
  process.exit(0);
}

try {
  main();
} catch (err) {
  process.stderr.write(`\nFAIL: ${err.message}\n${err.stack}\n`);
  process.exit(1);
}
