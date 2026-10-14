#!/usr/bin/env node
/**
 * tpm-workflow-doctor.js — a fail-loud PREFLIGHT for the workflow install seams. Every check here corresponds to a
 * way a real `/tpm-workflow` fan-out silently broke in a consumer (claude-decant, 2026-09-01): charters
 * resolving to placeholders, compose emitting bare bundle paths, signoff not writable. Each of those was
 * a 5-second red line that instead cost a whole round. This is the operational form of the "fail loud,
 * name the missing thing" hygiene in claude-context/dev/gating-and-failure-patterns.md.
 *
 * (The PreToolUse hook — gate-spawn — is delivered by the plugin's hooks/hooks.json, auto-discovered on
 * enable, so this doctor no longer checks for hook wiring in settings.json. The %TPM_HOME% resolution
 * hooks were retired in #1126 — resolution is anchor-first via `tpm resolve-home`.)
 *
 * Runs in claude-tpm OR in a consumer install (it self-locates the bundle from this file's position).
 *
 * USAGE:  tpm workflow doctor [--project-root <dir>] [--json]
 * EXIT:   0 = all checks pass, 1 = at least one FAIL (prints the fix for each).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');
// #1133 — shared root resolver (deliberate cross-suite exception; see findProjectRoot below).
const { findRoot } = require('../lib/paths');

const BUNDLE = path.resolve(__dirname, '..', '..'); // <bundle>/tools/workflow → <bundle>

// Root resolution shared via tools/lib/paths.js so all suites resolve identically
// (keys on the `.claude/claude-tpm/` install footprint). #1133 — a scoped, documented
// break of tool-conventions §6's "no shared tool lib" guidance for this one primitive.
function findProjectRoot(startDir) {
  return findRoot({ startDir });
}

// ── the checks (each returns { ok, detail, fix }) ────────────────────────────

function checkCharters(projectRoot) {
  let resolved;
  try { resolved = require('./tpm-workflow-config-resolver.js').resolveConfig(undefined, { startDir: projectRoot }).resolved; }
  catch (e) { return { ok: false, detail: `config-resolver threw: ${e.message}`, fix: 'fix the config / config.json JSON.' }; }
  const configured = resolved.subagentConfigs.filter((sc) => sc.charterFile);
  const missing = configured.filter((sc) => !fs.existsSync(sc.charterFile));
  if (missing.length) {
    return {
      ok: false,
      detail: `${missing.length}/${configured.length} default charter(s) DO NOT resolve (e.g. ${missing[0].name} → ${missing[0].charterFile})`,
      fix: 'default charters live under the BUNDLE — config-resolver.charterHome() self-locates it; a bare/relative charterFile resolves at the project root instead. Run `tpm-workflow-config-resolver.js --validate`.',
    };
  }
  return { ok: true, detail: `all ${configured.length} default charters resolve on disk` };
}

function checkSignoffWritable(projectRoot) {
  try {
    const d = require('./tpm-workflow-signoff.js').signoffDir(projectRoot);
    const rel = path.relative(projectRoot, d).split(path.sep).join('/');
    fs.mkdirSync(d, { recursive: true });
    const probe = path.join(d, '.doctor-probe');
    fs.writeFileSync(probe, 'x'); fs.unlinkSync(probe);
    return { ok: true, detail: `signoff store (${rel}) is writable` };
  } catch (e) {
    return { ok: false, detail: `cannot write the signoff store: ${e.message}`, fix: 'ensure the configured tmp folder (workflow.folders.tmp) is writable — signoff tokens gate spawns.' };
  }
}

function checkCompose() {
  const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'doctor-compose-'));
  try {
    fs.writeFileSync(path.join(tmp, 'plan.md'), '# plan\n');
    fs.writeFileSync(path.join(tmp, 'charter.md'), '# charter\n');
    const out = cp.execFileSync('node', [
      path.join(BUNDLE, 'tools', 'workflow', 'tpm-workflow-compose-spawn-prompt.js'),
      '--role', 'builder', '--phase-dir', 'dev/doctor/01-probe',
      '--plan', path.join(tmp, 'plan.md'), '--charter', path.join(tmp, 'charter.md'),
    ], { encoding: 'utf8' });
    const hasMarker = /<!--\s*tpm-workflow-spawn\s+phase="[^"]+"\s+role="[^"]+"\s*-->/.test(out);
    const hasAnchor = /\btpm\s+resolve-home\b/.test(out);
    const hasToken = out.includes('%TPM_HOME%/claude-context/methodology');
    if (!hasMarker) return { ok: false, detail: 'compose output has NO well-formed quoted spawn-gate marker', fix: 'compose must emit `<!-- tpm-workflow-spawn phase="…" role="…" -->` (the gate keys off it).' };
    if (!hasAnchor) return { ok: false, detail: 'compose does NOT emit the resolve-home anchor instruction', fix: 'compose must tell the worker to run `tpm resolve-home` first — its output IS %TPM_HOME% (anchor-first doctrine).' };
    if (!hasToken) return { ok: false, detail: 'compose emits BARE methodology paths (not %TPM_HOME%/…)', fix: 'emit the base-chain paths as %TPM_HOME%/… so the worker resolves them against the resolve-home anchor.' };
    return { ok: true, detail: 'compose emits the quoted gate marker + resolve-home anchor + %TPM_HOME%/ methodology paths' };
  } catch (e) {
    return { ok: false, detail: `compose failed to run: ${String(e.message).split('\n')[0]}`, fix: 'compose needs --role --phase-dir --plan --charter; run it with all required flags.' };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runAll(projectRoot) {
  return [
    ['charters resolve', checkCharters(projectRoot)],
    ['signoff store writable', checkSignoffWritable(projectRoot)],
    ['compose emits marker + tokens', checkCompose()],
  ];
}

function main(argv) {
  let projectRoot = null; let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project-root') projectRoot = argv[++i];
    else if (argv[i] === '--json') json = true;
    else if (argv[i] === '-h' || argv[i] === '--help') {
      process.stdout.write('usage: tpm workflow doctor [--project-root <dir>] [--json]\n'); process.exit(0);
    }
  }
  projectRoot = findProjectRoot(projectRoot);
  const results = runAll(projectRoot);
  const failed = results.filter(([, r]) => !r.ok);
  if (json) {
    process.stdout.write(JSON.stringify({ projectRoot, bundle: BUNDLE, ok: failed.length === 0, checks: results.map(([name, r]) => ({ name, ...r })) }, null, 2) + '\n');
  } else {
    process.stdout.write(`tpm-workflow doctor — project: ${projectRoot}\n                      bundle:  ${BUNDLE}\n\n`);
    for (const [name, r] of results) {
      process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${name}\n      ${r.detail}\n`);
      if (!r.ok && r.fix) process.stdout.write(`      → fix: ${r.fix}\n`);
    }
    process.stdout.write(`\n${failed.length === 0 ? '✓ all preflight checks pass' : `✗ ${failed.length} check(s) FAILED — fix before spawning a round`}\n`);
  }
  process.exit(failed.length ? 1 : 0);
}

if (require.main === module) main(process.argv.slice(2));
module.exports = { runAll, checkCharters, checkSignoffWritable, checkCompose, findProjectRoot, BUNDLE };
