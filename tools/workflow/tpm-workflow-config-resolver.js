#!/usr/bin/env node
/**
 * tpm-workflow-config-resolver.js — the workflow-module config resolver.
 *
 * PURPOSE
 *   Per-suite domain resolver (Tier 2) for the `workflow` section of a project's
 *   `.claude/claude-tpm/config.json`, per docs/config-guide.md §2 and
 *   claude-context/dev/framework-config-design.md §"Config reading". Reads the config file
 *   (if any), merges it over built-in defaults, and hands back the fully RESOLVED workflow
 *   registry (subagentConfigs / teams / charterVariants / verifier / deliverables / etc) so
 *   callers never hand-parse JSON. Absent or partial config is NOT an error — it means "use
 *   the defaults." A config that points at a file that doesn't exist on disk IS an error
 *   (--validate), fails loudly rather than silently at spawn time.
 *
 * INPUTS
 *   --config <path>   Optional. Path to a claude-tpm config.json. Defaults to
 *                      <projectRoot>/.claude/claude-tpm/config.json, where <projectRoot> is
 *                      found by walking up from the current directory looking for a CLAUDE.md
 *                      marker file (falls back to the current directory if no marker is found).
 *                      A default path that doesn't exist is NOT an error — it resolves to
 *                      built-in defaults, same as an explicit --config pointing nowhere... except
 *                      an explicit --config that points nowhere IS a friendly error (the caller
 *                      asked for a specific file; it should exist). See "Missing --config" below.
 *   --json             Emit the resolved `workflow` config as JSON to stdout. Exit 0.
 *   --get <dotted.key> Emit one value out of the resolved config, JSON-stringified, e.g.
 *                      `--get verifier.requireAllPass` or `--get deliverables.tldr`. Exit 0, or
 *                      a friendly error + exit 1 if the path doesn't resolve to anything.
 *   --validate         Confirm every file the resolved config REFERENCES (planTemplateFile,
 *                      subagentEnvTemplate, each subagentConfigs[].charterFile, each
 *                      charterVariants[role]'s alternates[]/addenda[]) exists on disk relative to
 *                      <projectRoot>. Prints "OK" + exit 0 if all exist (or none are referenced); a
 *                      friendly error listing every missing path + exit 1 otherwise.
 *                      NB: the built-in default subagentConfigs[].charterFile paths point at the
 *                      promoted charter homes (claude-context/methodology/workflow-setup/charters/),
 *                      a FORWARD REFERENCE — `--validate` on a tree without those charters is
 *                      EXPECTED to fail until they land at promotion (tightening fix #1).
 *   --help             Print usage and exit 0.
 *   Exactly one of --json / --get / --validate / --help is expected; omitting all of them
 *   prints usage to stderr and exits 1 (nothing to do is treated as a usage error, not a
 *   silent no-op).
 *
 * MISSING --config
 *   An explicitly-passed --config path that does not exist on disk is a friendly error + exit 1
 *   (the caller named a specific file; treat a typo/missing file as a mistake worth surfacing).
 *   The *default* location not existing is NOT an error (that's the normal "no config yet"
 *   case) — it silently resolves to built-in defaults.
 *
 * VERSION AWARENESS
 *   Reads the top-level `version` field (defaults to 1 if absent). This resolver understands
 *   version 1. An unrecognized version prints a warning to stderr (best-effort resolution
 *   continues) rather than hard-failing, since the shape has been stable at version 1.
 *
 * REUSABLE API (this file is also a module)
 *   resolveConfig(configPath, opts)  -> { resolved, projectRoot, configPath, usedDefault }
 *   validateResolved(resolved, projectRoot) -> { ok, missing: [{key, filePath}] }
 *   getDefaults()                    -> the built-in workflow defaults (deep-cloned)
 *   findProjectRoot(startDir)        -> absolute path
 *
 * EXAMPLES
 *   tpm workflow config --json
 *   tpm workflow config --config ./sample-config.json --json
 *   tpm workflow config --get verifier.multiCountMode
 *   tpm workflow config --config ./sample-config.json --validate
 */

'use strict';

const fs = require('fs');
const path = require('path');
// #1133 — shared root resolver (deliberate cross-suite exception; see findProjectRoot below).
const { findRoot } = require('../lib/paths');
// #1152 — the shared layered-config overlay: getDefaults() sources defaults.json (then re-absolutizes
// each subagentConfigs[].charterFile against bundleRoot()), and the USER layer
// ($CLAUDE_TPM_USER_CONFIG) is folded onto the project `workflow` section before the whitelist.
const overlay = require('../lib/tpm-config-overlay');

const SUPPORTED_VERSION = 1;

// ---------------------------------------------------------------------------
// Root resolution. DELIBERATE shared-lib exception (#1133): root/marker
// detection is shared via tools/lib/paths.js so ALL suites (task, session,
// workflow) resolve the project root identically and cannot drift on the
// marker — it keys on the `.claude/claude-tpm/` install footprint. This one
// safety-relevant primitive overrides tool-conventions §6's "no shared tool
// lib" guidance (a scoped, documented break — the convention stays as-is).
// ---------------------------------------------------------------------------
function findProjectRoot(startDir) {
  return findRoot({ startDir });
}

// ---------------------------------------------------------------------------
// Built-in defaults — mirrors docs/config-guide.md §2 "Workflow config".
// charterVariants defaults to {} (empty): the config-guide.md example entry
// (`builder: { alternates: ["charters/mvp.md"] }`) is illustrative of the SHAPE a
// consumer would add, not a file this framework ships by default — defaulting it
// non-empty would make `--validate` fail out of the box on a fresh project before
// charters/mvp.md exists. See findings/HANDOFF.md for this judgment call.
//
// CHARTER HOMES (tightening fix #1, 2026-08-29; relocatable fix, 2026-09-01). Each
// subagentConfigs[].charterFile points at the PROMOTED charter home so "the role's TPM
// default charter" is a real, resolvable, strip-routed file (not the placeholder no-op
// the fable review found). The charters live at
// `claude-context/methodology/workflow-setup/charters/<stem>-charter.md`.
//
// RELOCATABLE: the DEFAULT charter home resolves to an ABSOLUTE path anchored at the
// BUNDLE (this file lives at `<bundle>/tools/workflow/tpm-workflow-config-resolver.js`, so up 2 =
// bundle root — same self-location trick as tools/tpm-home.js).
// Why: a CONSUMER install vendors the bundle under node_modules/@codercowboy/claude-tpm/,
// and scaffold-subagent resolves a RELATIVE charterFile against the CONSUMER's projectRoot
// — where the charters don't exist → a placeholder charter for every phase (found live in
// claude-decant, 2026-09-01). An absolute bundle path hits scaffold-subagent's
// `path.isAbsolute()` short-circuit and resolves correctly in BOTH claude-tpm and any
// consumer. A consumer's OWN config that OVERRIDES charterFile with a relative path still
// resolves against its projectRoot (that's the consumer's charter, by design).
// ---------------------------------------------------------------------------
const CHARTER_HOME = 'claude-context/methodology/workflow-setup/charters';
// Bundle root, self-located from this file's position (`<bundle>/tools/workflow`). Overridable via
// TPM_BUNDLE_ROOT — the same escape hatch as the expand hook's TPM_HOME_OVERRIDE (used by tests, and
// available to a consumer that vendors the bundle somewhere unusual). Read LAZILY so an override set
// after `require` still takes effect.
function bundleRoot() {
  return process.env.TPM_BUNDLE_ROOT || path.resolve(__dirname, '..', '..');
}
function charterHome(stem) {
  return path.join(bundleRoot(), CHARTER_HOME, `${stem}-charter.md`); // absolute; relocatable
}

function getDefaults() {
  // #1152: sourced from the shipped tools/config/defaults.json via the overlay lib (comment keys
  // stripped). The one domain-specific transform stays HERE (not in the generic lib): each
  // subagentConfigs[].charterFile is stored BUNDLE-RELATIVE in defaults.json and re-absolutized against
  // bundleRoot() (honoring $TPM_BUNDLE_ROOT) so this reproduces the former charterHome() absolute paths
  // byte-for-byte — pinned by the config-resolver + scaffold-subagent tests.
  const resolved = overlay.loadDefaults().workflow;
  for (const sc of resolved.subagentConfigs || []) {
    if (sc && typeof sc.charterFile === 'string' && sc.charterFile && !path.isAbsolute(sc.charterFile)) {
      sc.charterFile = path.join(bundleRoot(), sc.charterFile);
    }
  }
  return resolved;
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Merge an array of {name,...} entries: override by name, append new names. */
function mergeByName(defaults, overrides) {
  if (!Array.isArray(overrides)) return deepClone(defaults);
  const result = deepClone(defaults);
  for (const entry of overrides) {
    if (!entry || typeof entry.name !== 'string') continue;
    const idx = result.findIndex((e) => e.name === entry.name);
    if (idx === -1) {
      result.push(deepClone(entry));
    } else {
      result[idx] = Object.assign({}, result[idx], entry);
    }
  }
  return result;
}

/** Shallow-merge plain-object sections (config keys override matching default keys). */
function mergeShallow(defaults, overrides) {
  if (!isPlainObject(overrides)) return deepClone(defaults);
  return Object.assign({}, deepClone(defaults), deepClone(overrides));
}

/**
 * Merge a parsed config.json's `workflow` section over the built-in defaults.
 * @param {object|undefined} rawWorkflow the `workflow` key of a parsed config.json (may be absent)
 * @returns {object} the resolved workflow config
 */
function mergeWorkflowConfig(rawWorkflow) {
  const defaults = getDefaults();
  if (!isPlainObject(rawWorkflow)) {
    return defaults;
  }

  const resolved = deepClone(defaults);

  if (typeof rawWorkflow.enabled === 'boolean') resolved.enabled = rawWorkflow.enabled;
  if (typeof rawWorkflow.planTemplateFile === 'string') {
    resolved.planTemplateFile = rawWorkflow.planTemplateFile;
  }
  if (typeof rawWorkflow.subagentEnvTemplate === 'string') {
    resolved.subagentEnvTemplate = rawWorkflow.subagentEnvTemplate;
  }
  if (typeof rawWorkflow.defaultParallelism === 'string') {
    resolved.defaultParallelism = rawWorkflow.defaultParallelism;
  }
  if (typeof rawWorkflow.verifyLoopCap === 'number') {
    resolved.verifyLoopCap = rawWorkflow.verifyLoopCap;
  }

  // #1183: config-only keys (no flag/env rung). devDir replaces; folders shallow-merges so a consumer can
  // override one folder name (e.g. folders.tmp) and keep the other defaults. Non-string devDir is ignored.
  if (typeof rawWorkflow.devDir === 'string' && rawWorkflow.devDir) resolved.devDir = rawWorkflow.devDir;
  resolved.folders = mergeShallow(defaults.folders, rawWorkflow.folders);

  resolved.subagentConfigs = mergeByName(defaults.subagentConfigs, rawWorkflow.subagentConfigs);
  resolved.teams = mergeByName(defaults.teams, rawWorkflow.teams);
  resolved.deliverables = mergeShallow(defaults.deliverables, rawWorkflow.deliverables);
  resolved.verifier = mergeShallow(defaults.verifier, rawWorkflow.verifier);
  resolved.costLedger = mergeShallow(defaults.costLedger, rawWorkflow.costLedger);

  // charterVariants: keyed by role name, shallow-merged per role.
  if (isPlainObject(rawWorkflow.charterVariants)) {
    resolved.charterVariants = deepClone(defaults.charterVariants);
    for (const role of Object.keys(rawWorkflow.charterVariants)) {
      resolved.charterVariants[role] = Object.assign(
        {},
        resolved.charterVariants[role] || {},
        rawWorkflow.charterVariants[role],
      );
    }
  }

  // blockedFilenamePatterns: array replace (config's full list wins, not merged).
  if (Array.isArray(rawWorkflow.blockedFilenamePatterns) && rawWorkflow.blockedFilenamePatterns.length > 0) {
    resolved.blockedFilenamePatterns = rawWorkflow.blockedFilenamePatterns.map(String);
  }

  return resolved;
}

/**
 * Locate, read, and resolve config.json's `workflow` section.
 * @param {string|undefined} configPathArg explicit --config value, or undefined for the default location
 * @param {object} [opts]
 * @param {string} [opts.startDir] where to start walking up for the project root (default: $TPM_PROJECT_ROOT, else cwd walk-up)
 * @returns {{resolved: object, projectRoot: string, configPath: string, usedDefaultLocation: boolean, configExists: boolean}}
 */
function resolveConfig(configPathArg, opts = {}) {
  // No cwd default: findRoot's precedence is explicit startDir > $TPM_PROJECT_ROOT > cwd walk-up (3.4).
  const projectRoot = findProjectRoot(opts.startDir);
  const usedDefaultLocation = !configPathArg;
  const configPath = configPathArg
    ? path.resolve(configPathArg)
    : path.join(projectRoot, '.claude', 'claude-tpm', 'config.json');

  const configExists = fs.existsSync(configPath);

  if (!configExists) {
    if (!usedDefaultLocation) {
      // Explicit --config pointing at nothing is a mistake worth surfacing loudly.
      // NB: no `config-resolver:` prefix here — main() prepends the CLI prefix on catch;
      // library callers get a clean message. (Doubled-prefix fix, 2026-08-29.)
      const err = new Error(`--config path does not exist: ${configPath}`);
      err.code = 'ENOENT_CONFIG';
      throw err;
    }
    // Default location absent -> normal "no config yet" case. #1152: still fold the USER layer in (DoD C).
    // No user layer => undefined => mergeWorkflowConfig(undefined) === getDefaults().
    const rawMergedNoProject = overlay.overlayUserOnto(undefined, 'workflow', { warn: opts.warn, env: opts.env });
    return { resolved: mergeWorkflowConfig(rawMergedNoProject), projectRoot, configPath, usedDefaultLocation, configExists: false };
  }

  let parsed;
  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    parsed = JSON.parse(raw);
  } catch (err) {
    const wrapped = new Error(`could not parse ${configPath} as JSON: ${err.message}`);
    wrapped.code = 'EBADJSON';
    throw wrapped;
  }

  const version = typeof parsed.version === 'number' ? parsed.version : SUPPORTED_VERSION;
  if (version !== SUPPORTED_VERSION) {
    process.stderr.write(
      `config-resolver: warning — config.json declares version ${version}, this resolver ` +
        `understands version ${SUPPORTED_VERSION}. Resolving best-effort.\n`,
    );
  }

  // #1152: deep-merge the USER layer over the project `workflow` section (user wins) before the whitelist.
  const rawMerged = overlay.overlayUserOnto(parsed.workflow, 'workflow', { warn: opts.warn, env: opts.env });
  const resolved = mergeWorkflowConfig(rawMerged);
  return { resolved, projectRoot, configPath, usedDefaultLocation, configExists: true };
}

/**
 * Validate that every file the resolved config references exists on disk (relative to projectRoot).
 * @param {object} resolved the resolved workflow config
 * @param {string} projectRoot
 * @returns {{ok: boolean, missing: Array<{key: string, filePath: string}>}}
 */
function validateResolved(resolved, projectRoot) {
  const missing = [];

  function check(key, relPath) {
    if (!relPath) return; // "" = no override, nothing to check
    const abs = path.isAbsolute(relPath) ? relPath : path.join(projectRoot, relPath);
    if (!fs.existsSync(abs)) {
      missing.push({ key, filePath: abs });
    }
  }

  check('planTemplateFile', resolved.planTemplateFile);
  check('subagentEnvTemplate', resolved.subagentEnvTemplate);

  for (const sc of resolved.subagentConfigs || []) {
    check(`subagentConfigs[${sc.name}].charterFile`, sc.charterFile);
  }

  for (const role of Object.keys(resolved.charterVariants || {})) {
    const variant = resolved.charterVariants[role] || {};
    for (const alt of variant.alternates || []) {
      check(`charterVariants.${role}.alternates[]`, alt);
    }
    for (const add of variant.addenda || []) {
      check(`charterVariants.${role}.addenda[]`, add);
    }
  }

  return { ok: missing.length === 0, missing };
}

/** Navigate a resolved object by a dotted key path, e.g. "verifier.requireAllPass". */
function getDotted(obj, dottedKey) {
  const parts = dottedKey.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) {
      return { found: false, value: undefined };
    }
    cur = cur[p];
  }
  return { found: true, value: cur };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: tpm workflow config [--config <path>] (--json | --get <dotted.key> | --validate) [--help]',
      '',
      "Resolves the 'workflow' section of a claude-tpm config.json over built-in defaults.",
      'Absent/partial config -> defaults (never an error). A config referencing a missing file',
      'is an error only under --validate.',
      '',
      'Flags:',
      '  --config <path>     Path to config.json. Default: <projectRoot>/.claude/claude-tpm/config.json',
      '  --json               Print the resolved workflow config as JSON.',
      '  --get <dotted.key>   Print one resolved value, e.g. --get verifier.requireAllPass',
      '  --validate           Confirm every referenced file (charters, templates, alternates) exists.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  tpm workflow config --json',
      '  tpm workflow config --config ./sample-config.json --get deliverables.tldr',
      '  tpm workflow config --config ./sample-config.json --validate',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      args.help = true;
    } else if (a === '--json') {
      args.json = true;
    } else if (a === '--validate') {
      args.validate = true;
    } else if (a === '--get') {
      args.get = argv[i + 1];
      i += 1;
    } else if (a === '--config') {
      args.config = argv[i + 1];
      i += 1;
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  if (!args.json && !args.validate && !args.get) {
    process.stderr.write('tpm workflow config: nothing to do — pass one of --json / --get / --validate.\n\n');
    printHelp();
    process.exit(1);
  }

  let resolution;
  try {
    resolution = resolveConfig(args.config);
  } catch (err) {
    process.stderr.write(`config-resolver: ${err.message}\n`);
    process.exit(1);
  }

  const { resolved, projectRoot } = resolution;

  if (args.json) {
    process.stdout.write(`${JSON.stringify(resolved, null, 2)}\n`);
    process.exit(0);
  }

  if (args.get) {
    const { found, value } = getDotted(resolved, args.get);
    if (!found) {
      process.stderr.write(`config-resolver: no such key "${args.get}" in resolved config.\n`);
      process.exit(1);
    }
    process.stdout.write(`${JSON.stringify(value)}\n`);
    process.exit(0);
  }

  if (args.validate) {
    const { ok, missing } = validateResolved(resolved, projectRoot);
    if (ok) {
      process.stdout.write('OK: every file referenced by the resolved config exists.\n');
      process.exit(0);
    }
    process.stderr.write('config-resolver: referenced file(s) do not exist:\n');
    for (const m of missing) {
      process.stderr.write(`  - ${m.key} -> ${m.filePath}\n`);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveConfig,
  validateResolved,
  getDefaults,
  findProjectRoot,
  mergeWorkflowConfig,
  getDotted,
};
