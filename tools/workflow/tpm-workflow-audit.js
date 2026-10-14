#!/usr/bin/env node
/**
 * tpm-workflow-audit.js (v2 — epic-aware) — walk `dev/` and audit each top-level entry
 * against the canonical layouts documented in
 * `claude-context/methodology/project-workspace.md` and the epic model in
 * `workflow-design.md` §"Epics".
 *
 * TWO shapes are recognized and classified automatically:
 *
 *   • EPIC  — a folder that contains a `00-epic-plan/` subfolder. Its children
 *     are numbered PHASE folders (`NN[-letter]-<slug>/`, append-only lineage).
 *     Epic-specific checks:
 *       - numbering integrity: every phase folder starts with a `NN-` token
 *         (digits + optional lowercase-letter suffix, e.g. 02, 02b); no two
 *         phases share the same token (duplicate); malformed names flagged.
 *         Monotonic with gaps is fine (append-only never renumbers).
 *       - one-plan-one-charter: each phase folder (NOT `00-epic-plan`) must have
 *         EXACTLY ONE `plan*.md` and AT LEAST ONE `charter-*.md` (a phase can
 *         legitimately carry several role charters — builder + verifier).
 *       - epic-plan charter-cleanliness: no file under `00-epic-plan/` may leak
 *         a charter/posture marker (`## The one rule`, `<!-- ORCHESTRATOR NOTE`,
 *         a `# Charter —` heading) — the 00 folder is worker-READ, must stay
 *         charter-clean (workflow-design.md §"…must be charter-clean").
 *
 *   • FLAT  — a classic `dev/<task>/` leaf (plan.md + findings/ …). The LEGACY
 *     flat-task audit is preserved verbatim: plan/findings presence, scratch
 *     dirs wrongly nested under findings/, stray files at the task root.
 *
 * Ported/extended from the legacy `audit.js` (2026-08-27). Read-only against
 * the task tree; only writes the one report file you point it at.
 *
 * Usage:
 *   tpm workflow audit --out <path-to-output.md> [--tasks-root <dir>] [--strict]
 *
 * Flags:
 *   --out <path>        Output markdown file. REQUIRED (no default).
 *   --tasks-root <dir>  Task tree to scan (default: work). Use a scratch tree
 *                       for testing so the real dev/ tree isn't required.
 *   --strict            Exit 3 (instead of 0) if ANY epic/phase violation is
 *                       found. The report is still written. Useful in CI/tests.
 *   --help, -h          Print usage and exit 0.
 *
 * Exit codes:
 *   0  audit ran, output written (and, under --strict, no violations)
 *   1  usage error (missing --out, unknown arg, IO failure)
 *   3  --strict only: audit ran but found at least one violation
 */
'use strict';

const fs = require('fs');
const path = require('path');
// #1183: devDir + the subfolder names (tmp/findings/tools/tests) come from the resolved workflow config.
const configResolver = require('./tpm-workflow-config-resolver.js');

const argv = process.argv.slice(2);
let OUT_PATH = null;
let TASKS_ROOT_ARG = null;
let STRICT = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--out') OUT_PATH = argv[++i];
  else if (argv[i] === '--tasks-root') TASKS_ROOT_ARG = argv[++i];
  else if (argv[i] === '--strict') STRICT = true;
  else if (argv[i] === '--help' || argv[i] === '-h') {
    console.log('usage: tpm workflow audit --out <path-to-output.md> [--tasks-root <dir>] [--strict]');
    console.log('  Classifies each top-level entry as EPIC (has 00-epic-plan/) or FLAT task.');
    console.log('  EPIC checks: numbering integrity, one-plan-one-charter per phase, 00-epic-plan charter-cleanliness.');
    console.log('  FLAT checks: legacy plan/findings presence, scratch-in-findings, stray files.');
    console.log('  --strict exits 3 if any violation is found.');
    process.exit(0);
  } else { console.error(`unknown arg: ${argv[i]}`); process.exit(1); }
}
if (!OUT_PATH) {
  console.error('Error: --out <path-to-output.md> is required (no default).');
  process.exit(1);
}

let WF;
try { WF = configResolver.resolveConfig(undefined, {}).resolved; }
catch (_e) { WF = configResolver.getDefaults(); }
const F = WF.folders;
const ROOT = TASKS_ROOT_ARG || WF.devDir;

// --- shared layout constants (from the legacy tool) ---------------------------
// Internal dirs a leaf owns — don't recurse into these looking for sub-tasks.
const INTERNAL_DIRS = [F.findings, F.tools, 'assets', F.tmp, F.tests];
// Allowed entries directly at a task root.
const ROOT_SPEC = ['plan.md', 'README.md', 'assets', F.tools, F.findings, F.tmp, F.tests];
// Recognized standard dirs inside findings/ (durable). `docs` is the legacy
// pre-2026-07-07 numbered-docs subfolder, still valid where present.
const FINDINGS_STD_DIRS = ['deliverables', 'verification', 'captures', 'docs'];
// Scratch-shaped dirs that must NOT live under findings/ (belong in the task's scratch folder, F.tmp).
const FINDINGS_SCRATCH_DIRS = [F.tmp, 'scratch', 'research'];

// --- epic constants -----------------------------------------------------------
const EPIC_PLAN_DIR = '00-epic-plan';
// A phase folder token: one-or-more digits + optional lowercase letters, then '-'.
// e.g. "01-foo" -> "01", "02b-bar" -> "02b". Case-insensitive on the letters.
const PHASE_RE = /^(\d+[a-z]*)-/i;
// Files that count as a "plan" / "charter" inside a phase folder.
const PLAN_RE = /^plan.*\.md$/i;
const CHARTER_RE = /^charter.*\.md$/i;
// Charter/posture leak markers that must never appear under 00-epic-plan/.
// Anchored so the plain WORD "charter" (used legitimately in an epic plan) does
// NOT trip them — only an actual pasted charter heading / orchestrator note.
const POSTURE_MARKERS = [
  { label: '## The one rule (charter section)', re: /^\s*#{1,6}\s+The one rule\s*$/im },
  { label: '<!-- ORCHESTRATOR NOTE (orchestrator-only inline note)', re: /<!--\s*ORCHESTRATOR NOTE/i },
  { label: '# Charter — (pasted charter heading)', re: /^\s*#\s+Charter\s*[—-]/im },
];

function listFlat(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith('.'))
    .map(e => ({ name: e.name, isDir: e.isDirectory() }));
}

function isLeaf(dir) {
  return [F.findings, F.tools, 'plan.md', 'README.md'].some(p => fs.existsSync(path.join(dir, p)));
}

function isEpic(dir) {
  return fs.existsSync(path.join(dir, EPIC_PLAN_DIR)) &&
    fs.statSync(path.join(dir, EPIC_PLAN_DIR)).isDirectory();
}

// Legacy flat-task discovery (unchanged) — used for the non-epic subtree only.
function findLeaves(dir, leaves = [], groupings = []) {
  if (isLeaf(dir)) {
    leaves.push(dir);
    for (const e of listFlat(dir)) {
      if (e.isDir && !INTERNAL_DIRS.includes(e.name)) {
        findLeaves(path.join(dir, e.name), leaves, groupings);
      }
    }
  } else {
    const children = listFlat(dir).filter(e => e.isDir);
    if (children.length > 0) {
      groupings.push(dir);
      for (const e of children) findLeaves(path.join(dir, e.name), leaves, groupings);
    }
  }
  return { leaves, groupings };
}

function classifyRootEntry(name, isDir) {
  if (ROOT_SPEC.includes(name)) return 'spec';
  if (/^readme.*\.md$/i.test(name)) return 'spec-variant-readme';
  if (/^plan.*\.md$/i.test(name)) return 'spec-variant-plan';
  if (/^charter.*\.md$/i.test(name)) return 'spec-variant-charter';
  if (/^spawn-prompt.*\.md$/i.test(name)) return 'spec-variant-spawn-prompt';
  if (/\.md$/i.test(name)) return 'extra-md-at-root';
  if (/\.js$/i.test(name)) return 'script-loose-at-root';
  if (/\.json$/i.test(name)) return 'json-loose-at-root';
  if (isDir) return 'extra-dir-at-root';
  return 'other-file-at-root';
}

function checkFindings(taskDir) {
  const findings = path.join(taskDir, F.findings);
  if (!fs.existsSync(findings)) return { exists: false };
  const r = {
    exists: true, hasReadme: false, hasQuestions: false, hasHandoff: false,
    stdDirs: [], scratchDirs: [], unexpectedDirs: [],
  };
  for (const e of listFlat(findings)) {
    if (!e.isDir) {
      if (e.name === 'README.md') r.hasReadme = true;
      else if (e.name === 'questions.md') r.hasQuestions = true;
      else if (e.name === 'HANDOFF.md') r.hasHandoff = true;
    } else if (FINDINGS_STD_DIRS.includes(e.name) || /^verifier\d+-findings$/.test(e.name)) {
      r.stdDirs.push(e.name);
    } else if (FINDINGS_SCRATCH_DIRS.includes(e.name)) {
      r.scratchDirs.push(e.name);       // real drift — scratch under findings/
    } else {
      r.unexpectedDirs.push(e.name);
    }
  }
  return r;
}

// --- report accumulator -------------------------------------------------------
let out = '';
const log = (s = '') => { out += s + '\n'; };
const violations = [];              // machine-checkable list of hard flags
function flag(msg) { violations.push(msg); log('- ❌ FLAG: ' + msg); }

// --- epic auditing ------------------------------------------------------------
function auditEpic(epicDir) {
  log('### `' + epicDir + '`');
  log('- classified: **EPIC** (has `' + EPIC_PLAN_DIR + '/`)');

  const entries = listFlat(epicDir).filter(e => e.isDir);
  const phases = [];        // {name, token}
  for (const e of entries) {
    if (e.name === EPIC_PLAN_DIR) continue;
    const m = e.name.match(PHASE_RE);
    if (!m) {
      flag(`malformed phase folder \`${epicDir}/${e.name}\` — does not start with a \`NN-\` number token`);
      continue;
    }
    phases.push({ name: e.name, token: m[1].toLowerCase() });
  }

  // numbering integrity: duplicate tokens
  const byToken = {};
  for (const p of phases) (byToken[p.token] = byToken[p.token] || []).push(p.name);
  for (const [tok, names] of Object.entries(byToken)) {
    if (names.length > 1) {
      flag(`duplicate phase number \`${tok}\` in \`${epicDir}\` — ${names.map(n => '`' + n + '`').join(', ')}`);
    }
  }

  const ordered = phases.slice().sort((a, b) =>
    a.token.localeCompare(b.token, undefined, { numeric: true }));
  log('- phases (' + phases.length + '): ' +
    (ordered.length ? ordered.map(p => '`' + p.name + '`').join(', ') : '(none)'));
  log('- numbering: monotonic append-only, gaps OK — ' +
    (Object.values(byToken).every(n => n.length === 1) ? '✓ no duplicates' : '✗ duplicate token(s)'));

  // one-plan-one-charter per phase
  for (const p of ordered) {
    const dir = path.join(epicDir, p.name);
    const files = listFlat(dir).filter(e => !e.isDir);
    const plans = files.filter(e => PLAN_RE.test(e.name)).map(e => e.name);
    const charters = files.filter(e => CHARTER_RE.test(e.name)).map(e => e.name);
    const f = checkFindings(dir);
    let ok = true;
    if (plans.length === 0) { flag(`phase \`${p.name}\` has NO plan.md`); ok = false; }
    else if (plans.length > 1) { flag(`phase \`${p.name}\` has 2+ plan files: ${plans.map(n => '`' + n + '`').join(', ')}`); ok = false; }
    if (charters.length === 0) { flag(`phase \`${p.name}\` has NO charter-*.md`); ok = false; }
    if (f.exists && f.scratchDirs.length) { flag(`phase \`${p.name}\` has scratch dir(s) inside findings/: ${f.scratchDirs.join(', ')}`); ok = false; }
    log(`  - \`${p.name}\`: plan=${plans.length} charter=${charters.length}` +
      (charters.length ? ' (' + charters.join(', ') + ')' : '') +
      (ok ? ' ✓' : ' ✗'));
  }

  // epic-plan charter-cleanliness
  const planDir = path.join(epicDir, EPIC_PLAN_DIR);
  const mdFiles = listFlat(planDir).filter(e => !e.isDir && /\.md$/i.test(e.name));
  let leaks = 0;
  for (const e of mdFiles) {
    let text = '';
    try { text = fs.readFileSync(path.join(planDir, e.name), 'utf8'); } catch (_) { continue; }
    const hits = POSTURE_MARKERS.filter(m => m.re.test(text)).map(m => m.label);
    if (hits.length) {
      leaks++;
      flag(`charter/posture leak in \`${epicDir}/${EPIC_PLAN_DIR}/${e.name}\` — ${hits.join('; ')}`);
    }
  }
  log(`- \`${EPIC_PLAN_DIR}/\` charter-cleanliness: ` +
    (leaks === 0 ? `✓ clean (${mdFiles.length} md file(s) scanned)` : `✗ ${leaks} leak(s)`));
  log();
}

// --- flat-task auditing (legacy, preserved) -----------------------------------
function auditFlatLeaf(leaf) {
  log('### `' + leaf + '`');
  log('- classified: **flat task**');
  const top = listFlat(leaf);
  const have = {
    plan: top.some(e => e.name === 'plan.md'),
    readme: top.some(e => e.name === 'README.md'),
    assets: top.some(e => e.isDir && e.name === 'assets'),
    tools: top.some(e => e.isDir && e.name === F.tools),
    findings: top.some(e => e.isDir && e.name === F.findings),
    tmp: top.some(e => e.isDir && e.name === F.tmp),
  };
  const f = checkFindings(leaf);
  const stray = top.filter(e => !['spec', 'spec-variant-readme', 'spec-variant-plan',
    'spec-variant-charter', 'spec-variant-spawn-prompt'].includes(classifyRootEntry(e.name, e.isDir)));

  log('- root: plan=' + (have.plan ? '✓' : '✗') + ' findings=' + (have.findings ? '✓' : '✗') +
      ' | README=' + (have.readme ? '✓' : '-') + ' tools=' + (have.tools ? '✓' : '-') +
      ' assets=' + (have.assets ? '✓' : '-') + ' tmp=' + (have.tmp ? '✓' : '-'));
  if (f.exists) {
    log('- findings/: README=' + (f.hasReadme ? '✓' : '-') + ' questions=' + (f.hasQuestions ? '✓' : '-') +
        ' HANDOFF=' + (f.hasHandoff ? '✓' : '-') +
        (f.stdDirs.length ? ' | subdirs: ' + f.stdDirs.map(s => '`' + s + '/`').join(', ') : ''));
    if (f.scratchDirs.length) log('- ⚠ scratch dirs inside findings/ (move to task `' + F.tmp + '/`): ' + f.scratchDirs.map(s => '`' + s + '/`').join(', '));
    if (f.unexpectedDirs.length) log('- unexpected dirs under findings/: ' + f.unexpectedDirs.map(s => '`' + s + '/`').join(', '));
  }
  if (stray.length) {
    log('- stray at task root:');
    for (const s of stray) log('  - `' + s.name + (s.isDir ? '/' : '') + '` — ' + classifyRootEntry(s.name, s.isDir));
  }
  log();

  return {
    missingPlan: !have.plan,
    missingFindings: !have.findings,
    findingsScratch: f.exists && f.scratchDirs.length > 0,
    anyStray: stray.length > 0,
    fully: have.plan && have.findings && (!f.exists || f.scratchDirs.length === 0) && stray.length === 0,
  };
}

// --- main walk ----------------------------------------------------------------
if (!fs.existsSync(ROOT)) {
  console.error(`Error: tasks-root not found: ${ROOT}`);
  process.exit(1);
}

log('# Task-folder adherence audit (v2 — epic-aware)');
log();
log('Generated against `project-workspace.md` (flat) + `workflow-design.md` §"Epics" (epic layout).');
log();
log('Legend: ✓ present · ✗ missing · - optional · ❌ FLAG = a hard violation.');
log();

// Partition top-level children into epics vs. everything-else.
const topChildren = listFlat(ROOT).filter(e => e.isDir);
const epics = [];
const nonEpicRoots = [];
for (const e of topChildren) {
  const p = path.join(ROOT, e.name);
  if (isEpic(p)) epics.push(p); else nonEpicRoots.push(p);
}

log('## Epics');
log();
if (!epics.length) log('_(none)_\n');
for (const ep of epics) auditEpic(ep);

// Flat tasks: run the legacy leaf discovery over the non-epic subtree.
let flatLeaves = [];
let flatGroupings = [];
for (const r of nonEpicRoots) {
  const { leaves, groupings } = findLeaves(r);
  flatLeaves = flatLeaves.concat(leaves);
  flatGroupings = flatGroupings.concat(groupings);
}
// Also handle the case where ROOT itself is a single flat task.
if (!epics.length && !nonEpicRoots.length && isLeaf(ROOT)) {
  const { leaves, groupings } = findLeaves(ROOT);
  flatLeaves = leaves; flatGroupings = groupings;
}

log('## Flat tasks (legacy `dev/<task>/` layout)');
log();
if (!flatLeaves.length) log('_(none)_\n');
const summary = { fullySpecd: 0, missingPlan: 0, missingFindings: 0, findingsScratch: 0, anyStray: 0 };
for (const leaf of flatLeaves) {
  const r = auditFlatLeaf(leaf);
  if (r.missingPlan) summary.missingPlan++;
  if (r.missingFindings) summary.missingFindings++;
  if (r.findingsScratch) summary.findingsScratch++;
  if (r.anyStray) summary.anyStray++;
  if (r.fully) summary.fullySpecd++;
}

if (flatGroupings.length) {
  log('## Intermediate grouping folders (contain sub-tasks; no plan/findings of their own)');
  log();
  for (const g of flatGroupings) {
    const children = listFlat(g).filter(e => e.isDir).map(e => e.name);
    const hasReadme = listFlat(g).some(e => e.name === 'README.md');
    log(`- \`${g}/\` — README=${hasReadme ? '✓' : '- (optional)'} — children: ${children.map(c => '`' + c + '/`').join(', ')}`);
  }
  log();
}

log('## Tally');
log();
log(`- Epics: **${epics.length}**`);
log(`- Flat leaf tasks: **${flatLeaves.length}**`);
log(`- Fully-adherent flat leaves (plan + findings, no findings-scratch, no stray): **${summary.fullySpecd}** / ${flatLeaves.length}`);
log(`- Flat leaves missing \`plan.md\`: ${summary.missingPlan}`);
log(`- Flat leaves missing \`findings/\`: ${summary.missingFindings}`);
log(`- Flat leaves with scratch dirs inside \`findings/\` (drift): ${summary.findingsScratch}`);
log(`- Flat leaves with stray files/dirs at task root: ${summary.anyStray}`);
log(`- **Epic/phase violations flagged: ${violations.length}**`);
if (violations.length) {
  log();
  log('### Violations');
  log();
  for (const v of violations) log('- ' + v);
}

try {
  fs.mkdirSync(path.dirname(path.resolve(OUT_PATH)), { recursive: true });
  fs.writeFileSync(OUT_PATH, out);
} catch (e) {
  console.error('IO failure writing --out: ' + e.message);
  process.exit(1);
}
console.log('Written to ' + OUT_PATH + ' (' + out.split('\n').length + ' lines)');
console.log('Summary:', JSON.stringify({
  epics: epics.length, flatLeaves: flatLeaves.length, violations: violations.length, ...summary,
}, null, 2));

if (STRICT && violations.length) process.exit(3);
