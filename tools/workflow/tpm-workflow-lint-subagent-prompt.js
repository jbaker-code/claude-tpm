#!/usr/bin/env node
/**
 * tpm workflow lint (v2) - validate a subagent spawn prompt AND catch
 * unresolved template sentinels before a subagent is spawned or a plan/charter
 * is handed to a worker.
 *
 * PURPOSE. Two jobs, one poka-yoke tool:
 *   1. SPAWN-PROMPT LINT (default mode) - the legacy checks: the step-zero
 *      reading chain (manifest-driven), the env-source ritual, the project-root
 *      anchor, the working-folder mention, verifier HARD RULE. Catches an
 *      incomplete brief before the Agent tool spawns a subagent.
 *   2. SENTINEL LINT (the v2 addition) - grep a *finalized* plan / charter /
 *      spawn prompt for template sentinels that must (not) still be there. The
 *      orchestrator greps the template rather than loading it whole (token
 *      savings) and so works from a partial view - this lint is what makes that
 *      partial-read SAFE. Taxonomy (workflow-design.md "The sentinel mechanism"):
 *        - FILL sentinel   `{{PLACEHOLDER}}` - must be filled; survives -> forgot it.
 *        - STRIP sentinel  `<!-- ORCHESTRATOR NOTE ... -->` (any orchestrator-only
 *                          block) - must be stripped before a worker sees it;
 *                          survives in a worker-facing file -> leak.
 *        - REQUIRED sentinel `<!-- required: X -->` - must be present; absent ->
 *                          missed inclusion. (Which markers are required is told
 *                          to the lint via --require.)
 *        - CONFIG-GATED sentinel - a block whose presence must MATCH a config
 *                          flag; present-when-false / absent-or-unfilled-when-true
 *                          -> drift. (Told via --config + --config-gate.)
 *   Plus two structural guards folded in from the design-review:
 *        - CHARTER-FILE-PRESENT - the charter file the spawn prompt NAMES exists
 *          on disk and is non-empty (the charter is the agent's definition of
 *          done; a spawn prompt that names a missing/empty charter is a footgun).
 *        - BLOCKED-FILENAME - a deliverable filename arg does not match a
 *          server-side-blocked pattern (report/summary/analysis/findings), via
 *          the sibling `tpm-workflow-check-filename.js`.
 *
 * PORTABILITY. Zero third-party deps (Node built-ins only). The one local
 * dependency is the sibling `tpm-workflow-check-filename.js` in this same tools/ folder -
 * per the per-suite portability rule, copy the WHOLE folder and it just works.
 *
 * USAGE.
 *   # Full spawn-prompt lint (manifest chain + structural + sentinels):
 *   tpm workflow lint --file draft-prompt.md
 *   tpm workflow lint --file draft.md --manifest path/to/reading-list.md
 *   tpm workflow lint --file draft.md --verifier --verbose
 *
 *   # Sentinel-only scan of a finalized plan / charter (no env ritual, no chain):
 *   tpm workflow lint --file plan.md --sentinels-only --require charter
 *
 *   # Standalone blocked-filename guard (no body needed):
 *   tpm workflow lint --sentinels-only --filename my-findings.md
 *
 * FLAGS.
 *   --file <path>          Read the prompt/plan/charter from a file (default: stdin,
 *                          or empty when stdin is a TTY and no --file given).
 *   --sentinels-only       Run ONLY the sentinel family (fill/strip/required/
 *                          config-gated) + charter-file + blocked-filename. Skips
 *                          the manifest doc-chain and the env/working-folder
 *                          structural checks - use it to lint a finalized plan or
 *                          charter that is not itself a spawn prompt.
 *   --manifest <path>      OPTIONAL override of the subagent reading-list manifest.
 *                          The DEFAULT is the canonical manifest SELF-LOCATED from
 *                          this tool's own bundle (claude-context/methodology/subagent/
 *                          reading-list.md), so a caller normally passes nothing; a
 *                          consumer / future caller may point elsewhere with --manifest.
 *                          An EXPLICIT --manifest that does not exist is a usage error
 *                          -> exit 2. If the manifest is found NOWHERE (no --manifest,
 *                          no consumer copy, and the bundle's own copy missing = a
 *                          broken install) the lint FAILS LOUD -> exit 2 — never a
 *                          silent skip that could pass a chain-less prompt.
 *   --require <name[,..]>  A `<!-- required: <name> -->` marker that MUST be present.
 *                          Repeatable; comma-lists accepted. Absent -> fail.
 *   --filename <name[,..]> A deliverable filename to run through the blocked-filename
 *                          guard. Repeatable; comma-lists accepted. Blocked -> fail.
 *   --require-charter      Require the prompt to NAME a charter file (charter*.md)
 *                          AND that file to exist + be non-empty.
 *   --charter-dir <path>   Directory to resolve a named charter file against
 *                          (default: the directory of --file, else cwd).
 *   --config <path>        A claude-tpm config.json for --config-gate cross-checks.
 *   --config-gate <g>      `<dot.path>=<marker>` : the config boolean at <dot.path>
 *                          must MATCH the presence of literal <marker> in the body.
 *                          Repeatable. Requires --config.
 *   --live-system          Enable the live-system reading block (per-project).
 *   --verifier             Enable verifier checks (chain block + HARD-RULE reminder).
 *   --shipping             Enable shipping-artifact-worker checks.
 *   --resume               Enable the HANDOFF.md read check.
 *   --test-writer          Enable the test-writer persona reading block.
 *   --documentarian        Enable the documentarian persona reading block.
 *   --bug-fixer            Enable the bug-fixer persona reading block. A --bug-fixer
 *                          prompt MUST name the verifier verdict it fixes (a
 *                          verifier-r<N>-v<M>-verdict.md path, or the --verdict path)
 *                          so the verify->fix handoff is mechanical, not freeform.
 *   --verdict <path>       The verdict file a --bug-fixer prompt must reference (its
 *                          basename or full path must appear in the body). Optional;
 *                          without it the prompt must name a *-verdict.md file itself.
 *   --verbose              Print each check's rationale + doc pointer.
 *   --help                 Print this message.
 *
 * OUTPUT.
 *   On PASS: "PASS: prompt looks complete (<N> checks)"
 *   On FAIL: "FAIL: <N> of <M> required directives missing" + per-check list
 *            (each failing sentinel check prints the offending detail).
 *   Exit code: 0 = PASS, 1 = FAIL, 2 = bad CLI usage.
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Sibling dependency (same suite/folder) - per-suite portability rule: this
// file + tpm-workflow-check-filename.js travel together. Build on it; do not re-implement.
const { findRoot } = require('../lib/paths');
const { isBlockedFilename } = require('./tpm-workflow-check-filename.js');

// The library include-token must byte-match the token consumer manifests write
// (`<!-- include: claude-tpm -->` — see tpm-session/SKILL.md + tools/session/templates/open.md + methodology/overview.md).
const LIBRARY_INCLUDE_TOKEN = 'claude-tpm';
const INCLUDE_RE = new RegExp('<!--\\s*include:\\s*' + LIBRARY_INCLUDE_TOKEN + '\\s*-->');

function parseArgs(argv) {
  const opts = {
    file: null,
    sentinelsOnly: false,
    manifest: null,
    require: [],
    filenames: [],
    requireCharter: false,
    charterDir: null,
    config: null,
    configGates: [],
    liveSystem: false,
    verifier: false,
    shipping: false,
    resume: false,
    testWriter: false,
    documentarian: false,
    bugFixer: false,
    verdict: null,
    verbose: false,
  };
  const pushList = (target, val) => {
    if (val == null) return;
    for (const p of String(val).split(',').map(s => s.trim()).filter(Boolean)) target.push(p);
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') opts.file = argv[++i];
    else if (a === '--sentinels-only') opts.sentinelsOnly = true;
    else if (a === '--manifest') opts.manifest = argv[++i];
    else if (a === '--require') pushList(opts.require, argv[++i]);
    else if (a === '--filename') pushList(opts.filenames, argv[++i]);
    else if (a === '--require-charter') opts.requireCharter = true;
    else if (a === '--charter-dir') opts.charterDir = argv[++i];
    else if (a === '--config') opts.config = argv[++i];
    else if (a === '--config-gate') opts.configGates.push(argv[++i]);
    else if (a === '--live-system') opts.liveSystem = true;
    else if (a === '--verifier') opts.verifier = true;
    else if (a === '--shipping') opts.shipping = true;
    else if (a === '--resume') opts.resume = true;
    else if (a === '--test-writer') opts.testWriter = true;
    else if (a === '--documentarian') opts.documentarian = true;
    else if (a === '--bug-fixer') opts.bugFixer = true;
    else if (a === '--verdict') opts.verdict = argv[++i];
    else if (a === '--verbose' || a === '-v') opts.verbose = true;
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    // Accept a bare positional path as --file (matches documented `lint … --sentinels-only plan.md`
    // usage in the plan-template). First non-flag positional only; extras are still errors. (2026-08-29.)
    else if (!a.startsWith('-') && opts.file == null) opts.file = a;
    else { console.error('Unknown arg: ' + a); process.exit(2); }
  }
  return opts;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
}

function readPromptSync(opts) {
  if (opts.file) return fs.readFileSync(path.resolve(opts.file), 'utf8');
  // No --file: read stdin only if something is actually piped in; a TTY means
  // there is no body (e.g. a standalone --filename check) - do NOT block.
  if (process.stdin.isTTY) return '';
  try { return fs.readFileSync(0, 'utf8'); }
  catch (e) { return ''; }
}

// -----------------------------------------------------------------------------
// Manifest-driven doc-chain checks (inherited from legacy, unchanged in spirit).
// -----------------------------------------------------------------------------

function reAny(body, ...res) {
  return res.some(re => re.test(body));
}

const MANIFEST_REL = path.join('claude-context', 'methodology', 'subagent', 'reading-list.md');

function libraryManifest() {
  const p = path.resolve(__dirname, '..', '..', MANIFEST_REL);
  return fs.existsSync(p) ? p : null;
}

/**
 * Locate the manifest to lint against: an explicit --manifest wins, then the
 * invoking project's copy, then the library's own. Returns null if none found
 * --manifest is an optional OVERRIDE; with none given this self-locates the bundle's canonical
 * manifest. The caller (buildManifestChecks) FAILS LOUD if none is found anywhere.
 */
function findManifest(opts) {
  if (opts && opts.manifest) {
    const p = path.resolve(opts.manifest);
    if (!fs.existsSync(p)) {
      // FIX #8 (fable-1): an EXPLICIT --manifest that doesn't exist is a usage
      // error, never a silent skip. Failing OPEN here let a typo'd path drop the
      // entire doc-chain family with a NOTE that even misreported "--manifest was
      // not given". Same rule as config-resolver's explicit-but-missing --config:
      // an explicit path that isn't there fails loudly (exit 2).
      console.error(
        'lint-subagent-prompt: --manifest "' + opts.manifest + '" does not exist ' +
        '(resolved: ' + p + '). An explicit manifest path must exist; ' +
        'omit --manifest to use the self-located canonical manifest (discovery).',
      );
      process.exit(2);
    }
    return p;
  }
  const consumer = path.resolve(findRoot({ quiet: true }), MANIFEST_REL);
  if (fs.existsSync(consumer)) return consumer;
  return libraryManifest();
}

function consumerDocExists(basename) {
  const rel = path.join('claude-context', 'methodology', basename);
  return [
    path.resolve(findRoot({ quiet: true }), rel),
    path.resolve(__dirname, '..', '..', rel),
  ].some(c => fs.existsSync(c));
}

function parseManifest(text, activeManifestPath, opts) {
  const resolveIncludes = !opts || opts.resolveIncludes !== false;
  let libraryBlocks = null;
  if (resolveIncludes && INCLUDE_RE.test(text)) {
    const gp = libraryManifest();
    if (gp && path.resolve(gp) !== path.resolve(activeManifestPath || '')) {
      libraryBlocks = parseManifest(fs.readFileSync(gp, 'utf8'), gp, { resolveIncludes: false });
    }
  }

  const blocks = {};
  const re = /<!--\s*lint:begin\s+([\w-]+)\s*-->([\s\S]*?)<!--\s*lint:end\s*-->/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const docs = [];
    for (const line of m[2].split('\n')) {
      if (INCLUDE_RE.test(line)) {
        for (const base of (libraryBlocks && libraryBlocks[m[1]]) || []) {
          if (!docs.includes(base)) docs.push(base);
        }
        continue;
      }
      const d = /`([^`]*?\.md)`/.exec(line);
      if (!d) continue;
      const base = d[1].split('/').pop();
      if (!docs.includes(base)) docs.push(base);
    }
    blocks[m[1]] = docs;
  }
  return blocks;
}

const stemOf = b => b.replace(/\.md$/, '');

const CANONICAL_IDS = {
  'HANDOFF.md':      'handoff-if-resume',
  'plan.md':         'plan-md-read',
  'verification.md': 'verification-if-shipping-or-verifier',
};
const idFor = (block, doc) => CANONICAL_IDS[doc] || `${block}-${stemOf(doc)}`;

const BLOCK_SPEC = {
  'base':              { applies: () => true,                    id: b => `step-zero-${stemOf(b)}` },
  'working-folder':    { applies: () => true,                    id: b => idFor('working-folder', b) },
  'resume':            { applies: o => o.resume,                 id: b => idFor('resume', b) },
  'shipping':          { applies: o => o.shipping || o.verifier, id: b => idFor('shipping', b) },
  'live-system':       { applies: o => o.liveSystem,             id: b => idFor('live-system', b) },
  'verifier':          { applies: o => o.verifier,               id: b => idFor('verifier', b) },
  // Per-persona follow-on delivery blocks — each gated by its own role flag, exactly
  // as `verifier` maps to `--verifier`. Docs are derived from the manifest block, so
  // the enforced chain and the documented chain cannot drift.
  'test-writer':       { applies: o => o.testWriter,             id: b => idFor('test-writer', b) },
  'documentarian':     { applies: o => o.documentarian,          id: b => idFor('documentarian', b) },
  'bug-fixer':         { applies: o => o.bugFixer,               id: b => idFor('bug-fixer', b) },
  'consumer-optional': { applies: (_o, b) => consumerDocExists(b), id: b => `step-zero-${stemOf(b)}` },
};

function docMatcher(basename) {
  const stem = basename.replace(/\.md$/, '');
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m);
  const parts = stem.split(/[\s_-]+/).filter(Boolean).map(esc);
  return new RegExp(parts.join('[\\s_-]*') + '(\\.md)?', 'i');
}

/** Build the manifest-driven doc-read checks. FAILS LOUD (exit 2) if no manifest is found anywhere. */
function buildManifestChecks(opts) {
  const manifestPath = findManifest(opts);
  if (!manifestPath) {
    // Option A (2026-09-13): the subagent reading-list is REQUIRED for the doc-chain checks and is
    // normally SELF-LOCATED from this tool's own bundle (findManifest -> libraryManifest), so
    // `--manifest` is an optional OVERRIDE, not something a caller must pass. Reaching here means it
    // was found NOWHERE — no --manifest, no consumer copy, and the bundle's own canonical copy is
    // missing — a broken install, never a normal state. FAIL LOUD rather than silently skipping the
    // whole doc-chain family (a silent skip could pass a spawn prompt missing its entire reading chain).
    console.error(
      'lint-subagent-prompt: no subagent reading-list manifest found — checked --manifest (none given), ' +
      'a consumer copy at ' + MANIFEST_REL + ', and the bundle\'s own canonical copy (self-located from ' +
      'this tool). This indicates a broken bundle. Pass --manifest <path> to point at one explicitly.',
    );
    process.exit(2);
  }
  const blocks = parseManifest(fs.readFileSync(manifestPath, 'utf8'), manifestPath);
  const checks = [];
  const byId = new Map();

  for (const [name, docs] of Object.entries(blocks)) {
    const spec = BLOCK_SPEC[name];
    if (!spec) continue;
    for (const doc of docs) {
      const id = spec.id(doc);
      const stem = doc.replace(/\.md$/, '');
      const existing = byId.get(id);
      if (existing) {
        const prev = existing.applies;
        existing.applies = (b, o) => prev(b, o) || spec.applies(o, doc);
        continue;
      }
      const check = {
        id,
        name: name === 'working-folder'
          ? `Working-folder read: ${doc}`
          : `Step-zero read: ${doc}`,
        docPointer: `subagent/reading-list.md, block "${name}"`,
        applies: (_b, o) => spec.applies(o, doc),
        test: body => docMatcher(stem).test(body),
      };
      byId.set(id, check);
      checks.push(check);
    }
  }
  return checks;
}

// -----------------------------------------------------------------------------
// Structural checks (prompt shape, not doc membership) - inherited from legacy.
// Skipped in --sentinels-only mode (a plan/charter is not a spawn prompt).
// -----------------------------------------------------------------------------

// FIX #2 (fable-1): the verifier independence doctrine was RESOLVED as
// "verdict, not repair" — NOT the retired "never touch the live system". A
// verifier now actively drives the artifact with whatever tools/MCP are
// available; the bar is "don't repair what you're checking." So the HARD-RULE
// reminder must key off the CURRENT rule (HARD RULE + a verdict-not-repair
// phrase), never the retired /NEVER.*touch.*live system/. See verification.md.
const VERDICT_NOT_REPAIR_RE = /verdict[, ]|do not (fix|repair)/i;

// FIX #4 (fable-3): a --bug-fixer prompt's scope is EXACTLY the verifier's
// verdict findings; the handoff must be a named artifact, not freeform prose.
// Match a verdict FILE reference (canonical verifier-r<N>-v<M>-verdict.md, or
// any *-verdict.md / verdict.md the prompt names).
const VERDICT_REF_RE = /[\w.\/-]*verdict[\w.\/-]*\.md/i;

function buildStructuralChecks() {
  return [
    {
      id: 'env-source-ritual',
      name: 'Env-source ritual (single-bash-call + cd to project root)',
      docPointer: 'CLAUDE.md "Subagent prompts: required directives"',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /source.*subagent\.env/i, /set -a.*source/i),
    },
    {
      id: 'env-source-project-root-anchor',
      name: 'Env-source cd-to-project-root anchor',
      docPointer: 'CLAUDE.md (project-root anchor)',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /cd .*<[^>]*project[^>]*root[^>]*>/i, /cd .*project root/i, /project-root/i, /project root/i),
    },
    {
      id: 'working-folder-mentioned',
      name: 'Working folder path (dev/<task>/)',
      docPointer: 'CLAUDE.md - working folder must be explicit',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => reAny(body, /dev\//),
    },
    {
      // RELOCATABLE + ANCHOR-FIRST (#1126): a spawned worker resolves a bundle doc only through a
      // mechanism that self-locates the bundle. The token-resolving hooks are retired, so a bare
      // `claude-context/methodology/…` dead-ends at the consumer root AND an un-anchored `%TPM_HOME%/…`
      // read-path is no longer sufficient on its own — nothing resolves the token for the worker. Two
      // resolving forms are accepted: `tpm doc <path>` (self-resolving, bypass-safe), or a
      // `%TPM_HOME%/` / `${TPM_HOME}/` token prefix PAIRED WITH a `tpm resolve-home` anchor
      // instruction (the worker runs it once and resolves the token paths against the printed root).
      id: 'bundle-paths-tokenized',
      name: 'Bundle methodology paths resolve (via `tpm doc`, or %TPM_HOME%/ + a resolve-home anchor)',
      docPointer: 'tpm-doc.js / tpm-home.js (resolve-home) — anchor-first bundle-relative resolution',
      applies: (_b, o) => !o.sentinelsOnly,
      test: body => {
        // No BARE methodology path may survive — each must be prefixed by a token or `tpm doc `.
        if (/(?<!\$\{TPM_HOME\}\/)(?<!%TPM_HOME%\/)(?<!doc )claude-context\/methodology\//.test(body)) return false;
        // A %TPM_HOME%/ (or ${TPM_HOME}/) read-path only resolves once the worker has run the anchor,
        // so whenever that token form is used, the resolve-home anchor instruction must accompany it.
        const usesToken = /(?:%TPM_HOME%|\$\{TPM_HOME\})\/claude-context\/methodology\//.test(body);
        if (usesToken && !/\btpm\s+resolve-home\b/.test(body)) return false;
        return true;
      },
    },
    {
      id: 'verifier-hard-rule',
      name: 'Verifier HARD RULE reminder — independence is verdict-not-repair (--verifier)',
      docPointer: 'verification.md - HARD RULE: a verifier renders a verdict and does NOT repair/build what it checks (retired framing: "never touch the live system")',
      applies: (_b, o) => o.verifier && !o.sentinelsOnly,
      // CURRENT doctrine: HARD RULE present AND a verdict-not-repair phrase. The
      // retired /NEVER.*touch.*live system/ is deliberately no longer accepted.
      test: body => /HARD RULE/i.test(body) && VERDICT_NOT_REPAIR_RE.test(body),
    },
    {
      id: 'bug-fixer-names-verdict',
      name: 'Bug-fixer prompt names the verifier verdict it must fix (--bug-fixer)',
      docPointer: 'verification.md - the verify->bug-fixer handoff is mechanical: the fixer reads the verdict (verifier-r<N>-v<M>-verdict.md), fixes EXACTLY its findings',
      applies: (_b, o) => o.bugFixer && !o.sentinelsOnly,
      test: (body, o) => {
        if (o && o.verdict) {
          const base = path.basename(o.verdict);
          if (body.includes(base) || body.includes(o.verdict)) return true;
        }
        return VERDICT_REF_RE.test(body);
      },
      detail: (_b, o) => {
        const want = (o && o.verdict) ? path.basename(o.verdict) : 'verifier-r<N>-v<M>-verdict.md';
        return `--bug-fixer prompt must name the verdict file it fixes (${want}); the verify->fix handoff must be mechanical, not freeform`;
      },
    },
  ];
}

// -----------------------------------------------------------------------------
// Sentinel-taxonomy checks (the v2 addition) - always applicable.
// -----------------------------------------------------------------------------

// NON-global (safe for repeated .test() - no lastIndex state); *_G are the
// global clones used only for match()/count.
const FILL_RE = /\{\{\s*[^}]*?\s*\}\}/;
const STRIP_RE = /<!--\s*ORCHESTRATOR NOTE\b[\s\S]*?-->/i;
const FILL_RE_G = /\{\{\s*[^}]*?\s*\}\}/g;
const STRIP_RE_G = /<!--\s*ORCHESTRATOR NOTE\b[\s\S]*?-->/gi;
const REQUIRED_MARKER_RE = name =>
  new RegExp('<!--\\s*required:\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, m => '\\' + m) + '\\s*-->', 'i');

function uniq(arr) { return Array.from(new Set(arr)); }

/** Resolve a dot-path like "workflow.deliverables.wiki" out of a parsed object. */
function resolveDotPath(obj, dotPath) {
  return String(dotPath).split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function buildSentinelChecks(opts) {
  const checks = [];

  // FILL sentinel: no surviving {{PLACEHOLDER}}.
  checks.push({
    id: 'fill-sentinel',
    name: 'No surviving FILL sentinel ({{PLACEHOLDER}})',
    docPointer: 'workflow-design.md "The sentinel mechanism" - fill sentinel',
    applies: () => true,
    test: body => !FILL_RE.test(body),
    detail: body => {
      const found = uniq((body.match(FILL_RE_G) || []).map(s => s.trim()));
      return found.length ? `surviving placeholder(s): ${found.join(', ')}` : '';
    },
  });

  // STRIP sentinel: no surviving <!-- ORCHESTRATOR NOTE ... -->.
  checks.push({
    id: 'strip-sentinel',
    name: 'No surviving STRIP sentinel (<!-- ORCHESTRATOR NOTE ... -->)',
    docPointer: 'workflow-design.md "The sentinel mechanism" - strip sentinel',
    applies: () => true,
    test: body => !STRIP_RE.test(body),
    detail: body => {
      const n = (body.match(STRIP_RE_G) || []).length;
      return n ? `${n} un-stripped orchestrator-only block(s) leaked into a worker-facing file` : '';
    },
  });

  // REQUIRED sentinel: each --require <name> marker must be present.
  for (const name of uniq(opts.require)) {
    checks.push({
      id: `required-sentinel-${name}`,
      name: `REQUIRED sentinel present (<!-- required: ${name} -->)`,
      docPointer: 'workflow-design.md "The sentinel mechanism" - required sentinel',
      applies: () => true,
      test: body => REQUIRED_MARKER_RE(name).test(body),
      detail: () => `missing required marker <!-- required: ${name} -->`,
    });
  }

  // CONFIG-GATED sentinel: config boolean at <dot.path> must MATCH marker presence.
  if (opts.configGates.length) {
    let cfg = null;
    if (opts.config) {
      try { cfg = JSON.parse(fs.readFileSync(path.resolve(opts.config), 'utf8')); }
      catch (e) { cfg = null; }
    }
    for (const gate of opts.configGates) {
      const eq = gate.indexOf('=');
      if (eq < 0) { console.error(`--config-gate must be <dot.path>=<marker>, got: ${gate}`); process.exit(2); }
      const dotPath = gate.slice(0, eq).trim();
      const marker = gate.slice(eq + 1);
      checks.push({
        id: `config-gate-${dotPath}`,
        name: `CONFIG-GATED sentinel matches config flag (${dotPath})`,
        docPointer: 'workflow-design.md "The sentinel mechanism" - config-gated sentinel',
        applies: () => true,
        test: body => {
          if (cfg == null) return false; // gate requested but config unreadable => drift/usage
          const flag = !!resolveDotPath(cfg, dotPath);
          const present = body.includes(marker);
          const unfilled = present && /\{\{[^}]*\}\}/.test(marker);
          if (flag) return present && !unfilled;   // must be present + filled
          return !present;                          // must be absent
        },
        detail: body => {
          if (cfg == null) return `config unreadable/absent (${opts.config || 'no --config'}) but gate ${dotPath} requested`;
          const flag = !!resolveDotPath(cfg, dotPath);
          const present = body.includes(marker);
          if (flag && !present) return `flag ${dotPath}=true but marker absent`;
          if (flag && /\{\{[^}]*\}\}/.test(marker) && present) return `flag ${dotPath}=true but marker still an unfilled placeholder`;
          if (!flag && present) return `flag ${dotPath}=false but marker present (should be stripped)`;
          return '';
        },
      });
    }
  }

  return checks;
}

// -----------------------------------------------------------------------------
// Charter-file-present + blocked-filename structural guards (design-review fold-in).
// -----------------------------------------------------------------------------

const CHARTER_REF_RE = /\bcharter[\w-]*\.md\b/i;

// FIX #1 (fable-3): a scaffolder PLACEHOLDER charter is NOT a real charter — the
// worker would spawn with no posture / definition of done at all. The scaffolder
// drops a stub with the fill-marker `{{CHARTER_BODY}}` and a `# Charter — <role>
// (placeholder)` header when config has no charterFile override; nothing in the
// documented flow guarantees a real charter replaces it, and charter-file-present
// only checked exists+non-empty. Both stub markers must FAIL.
const CHARTER_PLACEHOLDER_FILL_RE = /\{\{[A-Z0-9_]+\}\}/i;        // {{CHARTER_BODY}} (case-insensitive)
const CHARTER_PLACEHOLDER_HEADER_RE = /^#.*\(placeholder\)/mi;    // # Charter — builder (placeholder)

/** Resolve the on-disk path of the charter the prompt names (or null if none named). */
function resolveCharterPath(opts, body) {
  const m = (body || '').match(CHARTER_REF_RE);
  if (!m) return null;
  const baseDir = opts.charterDir
    ? path.resolve(opts.charterDir)
    : (opts.file ? path.dirname(path.resolve(opts.file)) : process.cwd());
  return path.join(baseDir, path.basename(m[0]));
}

function buildCharterAndFilenameChecks(opts) {
  const checks = [];

  // CHARTER-FILE-PRESENT: if the prompt names a charter file (or --require-charter),
  // that file must exist on disk, be non-empty, AND not still be a placeholder stub.
  checks.push({
    id: 'charter-file-present',
    name: 'Named charter file exists, is non-empty, and is not a placeholder stub',
    docPointer: 'workflow-design.md - charter is the agent\'s definition of done; a named charter must exist and be real (not a {{CHARTER_BODY}}/(placeholder) stub)',
    applies: body => opts.requireCharter || CHARTER_REF_RE.test(body || ''),
    test: body => {
      const charterPath = resolveCharterPath(opts, body);
      if (!charterPath) return false; // requireCharter set but no charter named -> fail
      try {
        const st = fs.statSync(charterPath);
        if (!(st.isFile() && st.size > 0)) return false;
        // FIX #1: reject a still-placeholder charter (unfilled fill-marker or the
        // scaffolder's "(placeholder)" header).
        const text = fs.readFileSync(charterPath, 'utf8');
        if (CHARTER_PLACEHOLDER_FILL_RE.test(text) || CHARTER_PLACEHOLDER_HEADER_RE.test(text)) return false;
        return true;
      } catch (e) { return false; }
    },
    detail: body => {
      const charterPath = resolveCharterPath(opts, body);
      if (!charterPath) return 'prompt names no charter*.md file (but --require-charter is set)';
      const base = path.basename(charterPath);
      const dir = path.dirname(charterPath);
      try {
        const st = fs.statSync(charterPath);
        if (!(st.isFile() && st.size > 0)) return `charter "${base}" missing or empty under ${dir}`;
        const text = fs.readFileSync(charterPath, 'utf8');
        if (CHARTER_PLACEHOLDER_FILL_RE.test(text)) return `charter "${base}" is still a PLACEHOLDER stub (unfilled {{...}} fill-marker) — land the real charter before spawn`;
        if (CHARTER_PLACEHOLDER_HEADER_RE.test(text)) return `charter "${base}" is still a PLACEHOLDER stub ("(placeholder)" header) — land the real charter before spawn`;
        return '';
      } catch (e) { return `charter "${base}" missing or empty under ${dir}`; }
    },
  });

  // FIX #6 (fable-2): sentinel-lint the DROPPED charter's CONTENTS as a BACKSTOP.
  // The scaffolder's dropCharter strip is CASE-SENSITIVE, so a `<!-- Orchestrator
  // note ... -->` (natural lowercase) leaks verbatim into the worker-facing charter
  // with no machine check in the documented flow. When the lint reads the named
  // charter it also scans it for a surviving strip sentinel, CASE-INSENSITIVELY.
  checks.push({
    id: 'charter-no-strip-sentinel',
    name: 'Named charter carries no un-stripped orchestrator note (case-insensitive backstop)',
    docPointer: 'workflow-design.md "The sentinel mechanism" - strip sentinel; backstop for the scaffolder\'s case-SENSITIVE dropCharter strip',
    applies: body => opts.requireCharter || CHARTER_REF_RE.test(body || ''),
    test: body => {
      const charterPath = resolveCharterPath(opts, body);
      if (!charterPath) return true; // no charter named -> charter-file-present owns that failure
      let text;
      try { text = fs.readFileSync(charterPath, 'utf8'); } catch (e) { return true; } // unreadable -> present-check owns it
      return !STRIP_RE.test(text); // STRIP_RE is /i (case-insensitive)
    },
    detail: body => {
      const charterPath = resolveCharterPath(opts, body);
      if (!charterPath) return '';
      let text;
      try { text = fs.readFileSync(charterPath, 'utf8'); } catch (e) { return ''; }
      const n = (text.match(STRIP_RE_G) || []).length;
      return n
        ? `charter "${path.basename(charterPath)}" has ${n} un-stripped orchestrator note(s) (matched case-insensitively) — the scaffolder's case-sensitive strip missed it; it leaks orchestrator-only content to the worker`
        : '';
    },
  });

  // BLOCKED-FILENAME: each --filename arg must not match a blocked pattern.
  for (const fn of uniq(opts.filenames)) {
    checks.push({
      id: `blocked-filename:${path.basename(fn)}`,
      name: `Deliverable filename not server-side-blocked (${path.basename(fn)})`,
      docPointer: 'tpm-workflow-check-filename.js - report/summary/analysis/findings are blocked',
      applies: () => true,
      test: () => !isBlockedFilename(fn).blocked,
      detail: () => {
        const r = isBlockedFilename(fn);
        return r.blocked ? `"${r.basename}" contains blocked pattern "${r.pattern}"` : '';
      },
    });
  }

  return checks;
}

// -----------------------------------------------------------------------------
// #1182 backstop: the composed prompt carries <!-- tpm-workflow-spawn phase="..." -->.
// The file being linted must live IN that phase folder; a mismatch means the spawn
// prompt was written to the wrong place. Gated: only with --file AND a marker.
// -----------------------------------------------------------------------------

const SPAWN_MARKER_PHASE_RE = /<!--\s*tpm-workflow-spawn\b[^>]*?\bphase="([^"]+)"/;

function realOrResolved(p) {
  const r = path.resolve(p);
  try { return fs.realpathSync(r); } catch (e) { return r; }
}

/** Extract the marker's phase value, or null when there is no marker. */
function markerPhase(body) {
  const m = (body || '').match(SPAWN_MARKER_PHASE_RE);
  return m ? m[1] : null;
}

function buildPhaseLocationChecks(opts) {
  const checks = [];
  checks.push({
    id: 'phase-location-matches-marker',
    name: 'Linted file sits in the phase folder its tpm-workflow-spawn marker declares',
    docPointer: '#1182 - a spawn prompt written to the wrong folder; marker phase="..." must equal dirname(--file)',
    // SKIP cleanly: no --file (stdin) or no marker in the body.
    applies: body => !!opts.file && markerPhase(body) !== null,
    test: body => {
      const phase = markerPhase(body);
      if (phase === null || !opts.file) return true;
      return realOrResolved(phase) === realOrResolved(path.dirname(path.resolve(opts.file)));
    },
    detail: body => {
      const phase = markerPhase(body);
      if (phase === null || !opts.file) return '';
      return `file is in ${path.dirname(path.resolve(opts.file))} but its marker declares phase="${phase}" (${path.resolve(phase)}) - spawn prompt written to the wrong folder`;
    },
  });
  return checks;
}

// -----------------------------------------------------------------------------

function buildChecks(opts) {
  const checks = [];
  if (!opts.sentinelsOnly) {
    checks.push(...buildManifestChecks(opts));
  }
  checks.push(...buildStructuralChecks());
  checks.push(...buildSentinelChecks(opts));
  checks.push(...buildCharterAndFilenameChecks(opts));
  checks.push(...buildPhaseLocationChecks(opts));
  return checks;
}

function main() {
  const opts = parseArgs(process.argv);
  const body = readPromptSync(opts);
  const applicable = buildChecks(opts).filter(c => c.applies(body, opts));
  const failing = applicable.filter(c => !c.test(body, opts));

  if (failing.length === 0) {
    console.log(`PASS: prompt looks complete (${applicable.length} checks)`);
    if (opts.verbose) {
      console.log('');
      for (const c of applicable) console.log(`  ok  ${c.id.padEnd(40)} - ${c.name}`);
    }
    process.exit(0);
  }

  console.log(`FAIL: ${failing.length} of ${applicable.length} required directives missing:`);
  for (const c of failing) {
    console.log(`  X  ${c.id}`);
    console.log(`     ${c.name}`);
    if (typeof c.detail === 'function') {
      const d = c.detail(body, opts);
      if (d) console.log(`     -> ${d}`);
    }
    if (opts.verbose) console.log(`     See: ${c.docPointer}`);
  }
  if (!opts.verbose) console.log('\nRun with --verbose for doc pointers.');
  process.exit(1);
}

if (require.main === module) main();

module.exports = {
  parseArgs,
  buildChecks,
  FILL_RE,
  STRIP_RE,
  REQUIRED_MARKER_RE,
  resolveDotPath,
};
