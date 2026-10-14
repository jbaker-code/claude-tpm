#!/usr/bin/env node
/**
 * tpm workflow scaffold (v2, epic-aware) — scaffold epic + phase folders for the
 * claude-tpm workflow module.
 *
 * PURPOSE
 *   The epic-aware scaffolder. It owns the MECHANICS of the numbered-phase folder
 *   layout (per workflow-design.md §"Epics" + §"Design-review fold-in" #4) so the
 *   orchestrator stops hand-scaffolding, hand-numbering folders, and hand-tracking
 *   round lineage. The orchestrator decides WHAT a phase is; this tool owns the
 *   numbering + the skeleton + the per-role/per-round/per-subagent naming.
 *
 *   Layout it produces (append-only; NN is a stable creation-order id, not exec order):
 *
 *     dev/<epic-slug>/
 *     ├── 00-epic-plan/                 ← the ONE mutable cross-phase home
 *     │   ├── epic-plan.md              ← goal · phase map · deliverable
 *     │   ├── punchlist.md              ← running done / pending / cut
 *     │   └── decisions.md              ← decisions + raise-to-user queue
 *     ├── 01-<slug>/                    ← a phase = self-contained work folder
 *     │   ├── plan.md                   ← ONE plan (sentinel stub; orchestrator fills)
 *     │   ├── charter-<role>.md         ← ONE charter per team role (copied from config)
 *     │   ├── spawn-prompt-<role>-r1.md ← per-role, per-round spawn-prompt stub
 *     │   ├── findings/                 ← HANDOFF.md, durable outputs
 *     │   ├── tools/                    ← phase-local scripts
 *     │   ├── tests/                    ← phase-local tests
 *     │   └── tmp/                      ← scratch (per-subagent subfolders)
 *     │       ├── builder-r1/           ← per-subagent scratch (no clobber)
 *     │       └── verifier-r1-v1/       ← verifier M-of-count gets a -v<M> suffix
 *     └── ...                           ← next add-phase → 02-…, append-only
 *
 * SUBCOMMANDS
 *   epic-init <epic-path>
 *       Create <epic-path>/00-epic-plan/ with {epic-plan,punchlist,decisions}.md stubs.
 *       Idempotent-ish: refuses to clobber existing stub files unless --force.
 *
 *   add-phase <epic-path> --slug <slug> --team <team> --pretask-ack <receipt>
 *             [--config <path>] [--charter <path> [--role <role>]] [--force]
 *   add-phases <epic-path> --slugs <a,b,c> --team <team> --pretask-ack <receipt>   # BATCH fan-out
 *       Scaffold N build phases in one call — each --slug becomes the next auto-numbered phase (01-a,
 *       02-b, …), all on the same team + one epic-level pre-task ack. Same flags as add-phase.
 *       PRE-TASK GATE (modes-plan §2): add-phase REFUSES without --pretask-ack <receipt> — a
 *       markdown file (by convention 00-epic-plan/pretask-<phase>.md) carrying an
 *       `**Accepted:** <phrase>` line that records the user's response to the pre-task roster
 *       (`all defaults` or explicit answers). No receipt / no acceptance line → exit 1. This
 *       makes the "present the roster + get the user's OK before scaffolding" step mechanical
 *       instead of honor-system prose (which got skipped twice — session-007). No bypass flag.
 *       Auto-compute the next phase number (max existing NN + 1, zero-padded to 2
 *       digits — mechanically enforces append-only), create NN-<slug>/ with the full
 *       phase skeleton: plan.md (seeded from the config's planTemplateFile if one resolves,
 *       else the built-in stub), per-role charter-<role>.md (copied from the resolved
 *       charterFile, orchestrator-note stripped), per-role spawn-prompt-<role>-r1.md stubs,
 *       findings/ tools/ tests/ tmp/, a per-subagent tmp/<role>-r1[-v<M>]/ scratch folder,
 *       and a comment-only tmp/subagent.env stub (or the consumer override template — see
 *       CONSUMER HOOKS). The team's roster (which roles, how many of each, each role's charter
 *       path) is resolved via tpm-workflow-config-resolver.js.
 *       --charter <path> re-charters ONE role from the given file (routed through dropCharter
 *       so the strip + blocked-name guards apply) — e.g. the mvp opt-down. It re-charters the
 *       --role named role, or the sole role of a single-role team; a multi-role team needs --role.
 *
 *   add-round <phase-path> --role <role> [--count <N>] [--config <path>]
 *             [--charter <path>] [--force]
 *       Append a kickback round for one role: auto-number r<N> (max existing
 *       spawn-prompt-<role>-r*.md + 1), drop spawn-prompt-<role>-r<N>.md and the
 *       per-subagent tmp/<role>-r<N>[-v<M>]/ scratch folder(s). Used for the
 *       verify↔bug-fixer kickback loop that re-runs in the SAME phase folder (fold-in #5).
 *       Also drops charter-<role>.md IF absent — so the loop's `bug-fixer` (in no team's
 *       roster, so uncharted at add-phase) arrives complete: `add-round --role bug-fixer`
 *       yields spawn-prompt-bug-fixer-r<N>.md + charter-bug-fixer.md + tmp/bug-fixer-r<N>/.
 *       A re-check round for a roster role (e.g. verifier) keeps its existing charter.
 *       --charter <path> (re)drops THIS role's charter from the given file (--force to
 *       overwrite an existing one) — the opt-down / charter-swap via the TOOL. Also drops the
 *       tmp/subagent.env stub if the phase lacks one.
 *
 * CONSUMER HOOKS (tightening round, 2026-08-29)
 *   subagent.env override — set config `workflow.subagentEnvTemplate` (or drop
 *       `.claude/claude-tpm/subagent.env.template` at the project root) and the scaffolder copies
 *       THAT into each phase's tmp/subagent.env instead of the comment-only stub. This is where
 *       nbajam/ggaitk populate emulator env.
 *   plan.md template — set config `workflow.planTemplateFile` and add-phase seeds plan.md from it
 *       (with {{PHASE}}/{{PHASE_NAME}}/{{PHASE_SLUG}} expanded) instead of the built-in stub.
 *
 * DEPENDENCIES (copied-in, within-epic reuse — build ON them, don't re-implement)
 *   ./tpm-workflow-config-resolver.js — resolves the team roster + per-role charterFile paths.
 *   ./tpm-workflow-check-filename.js   — guards emitted filenames against the blocked patterns.
 *
 * CONVENTIONS
 *   Zero runtime deps (Node built-ins only). Run via `tpm workflow scaffold …`.
 *   Every subcommand supports --help; the bare tool prints usage. Value flags fail
 *   loudly if their value is missing. This file is ALSO a module (see module.exports)
 *   so the test can drive the pure helpers directly.
 *
 * EXAMPLES
 *   tpm workflow scaffold epic-init dev/my-epic
 *   tpm workflow scaffold add-phase dev/my-epic --slug build-parser --team ship \
 *         --pretask-ack dev/my-epic/00-epic-plan/pretask-01.md
 *   tpm workflow scaffold add-phase dev/my-epic --slug plan-it --team full \
 *         --pretask-ack dev/my-epic/00-epic-plan/pretask-02.md --config ./cfg.json
 *   tpm workflow scaffold add-round dev/my-epic/01-build-parser --role builder
 *   tpm workflow scaffold --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { findRoot } = require('../lib/paths');
const configResolver = require('./tpm-workflow-config-resolver.js');
const { isBlockedFilename } = require('./tpm-workflow-check-filename.js');

// ───────────────────────────────────────────────────────────────────────────
// Small filesystem helpers
// ───────────────────────────────────────────────────────────────────────────

function ensureDir(dir, opts, created) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    if (created) created.push({ kind: 'dir', path: dir });
    if (opts && !opts.quiet) process.stdout.write(`  mkdir:   ${dir}\n`);
  }
  return dir;
}

/**
 * Write a file, guarding its basename against the blocked-filename patterns
 * (report/summary/analysis/findings). A tool that emits a blocked name would
 * hand the orchestrator a file that is server-side rejected — fail loudly here.
 */
function writeFileGuarded(target, content, opts, created, patterns) {
  const check = isBlockedFilename(target, patterns);
  if (check.blocked) {
    throw new Error(
      `refusing to write "${check.basename}": contains blocked pattern "${check.pattern}".`,
    );
  }
  if (fs.existsSync(target) && !(opts && opts.force)) {
    throw new Error(`refusing to overwrite existing file: ${target} (pass --force).`);
  }
  fs.writeFileSync(target, content);
  if (created) created.push({ kind: 'file', path: target });
  if (opts && !opts.quiet) process.stdout.write(`  created: ${target}\n`);
  return target;
}

// ───────────────────────────────────────────────────────────────────────────
// #1183: resolved workflow.folders (tmp/findings/tools/tests names). `resolved` may be undefined
// (add-round when the config can't resolve) -> fall back to the shipped defaults.
function foldersOf(resolved) {
  return (resolved && resolved.folders) || configResolver.getDefaults().folders;
}

/**
 * #1183: resolve an epic-path positional against workflow.devDir. A BARE name (no path separator, not
 * absolute) is prefixed with devDir; anything else (`dev/x`, `sub/x`, `/abs/x`) is returned unchanged.
 */
function resolveBase(arg, devDir) {
  if (typeof arg !== 'string' || !arg) return arg;
  if (path.isAbsolute(arg) || arg.includes('/') || arg.includes('\\')) return arg;
  return path.join(devDir || configResolver.getDefaults().devDir, arg);
}

function devDirFor(configPath) {
  try {
    const r = configResolver.resolveConfig(configPath, {}).resolved;
    return (r && r.devDir) || configResolver.getDefaults().devDir;
  } catch (_e) {
    return configResolver.getDefaults().devDir;
  }
}

// Roster resolution (via tpm-workflow-config-resolver.js) + naming helpers
// ───────────────────────────────────────────────────────────────────────────

/**
 * Resolve a team name to its ordered list of role slots, each carrying the
 * charter path resolved from subagentConfigs.
 * @returns {{roles: Array<{name, count, model, charterFile}>, resolved, projectRoot}}
 */
function resolveTeamRoster(teamName, { configPath, startDir } = {}) {
  const resolution = configResolver.resolveConfig(configPath, { startDir });
  const { resolved, projectRoot } = resolution;

  const team = (resolved.teams || []).find((t) => t.name === teamName);
  if (!team) {
    const names = (resolved.teams || []).map((t) => t.name).join(', ');
    throw new Error(`unknown team "${teamName}". Known teams: ${names || '(none)'}.`);
  }

  const byName = new Map((resolved.subagentConfigs || []).map((sc) => [sc.name, sc]));
  const roles = (team.subagents || []).map((ref) => {
    const sc = byName.get(ref.name) || {};
    return {
      name: ref.name,
      count: typeof ref.count === 'number' && ref.count > 0 ? ref.count : 1,
      model: ref.model || sc.defaultModel || '',
      charterFile: sc.charterFile || '',
    };
  });

  return { roles, resolved, projectRoot };
}

/**
 * Resolve ONE role's charter slot from subagentConfigs (not tied to any team roster).
 * Used by add-round for a role that joins a phase mid-loop — chiefly the verify↔bug-fixer
 * loop's fixer (`bug-fixer`), which is in no team's roster and so never had its charter
 * dropped at add-phase time. Returns a role-shaped object dropCharter understands, plus
 * the resolved projectRoot. Unknown role names still resolve (charterFile ''), so the loop
 * fixer's charter is dropped as a TPM-default placeholder just like any other role.
 * @returns {{role: {name, count, model, charterFile}, projectRoot}}
 */
function resolveRoleCharter(roleName, { configPath, startDir } = {}) {
  const resolution = configResolver.resolveConfig(configPath, { startDir });
  const { resolved, projectRoot } = resolution;
  const sc = (resolved.subagentConfigs || []).find((s) => s.name === roleName) || {};
  return {
    role: {
      name: roleName,
      count: 1,
      model: sc.defaultModel || '',
      charterFile: sc.charterFile || '',
    },
    projectRoot,
  };
}

/** Zero-pad a non-negative integer to at least 2 digits. */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Compute the next append-only phase number for an epic folder: scan its direct
 * children for `NN-*` prefixes (including `00-epic-plan`), take max, +1. Empty /
 * missing epic dir → 1. Returns a Number.
 */
function nextPhaseNumber(epicPath) {
  let max = -1;
  if (fs.existsSync(epicPath)) {
    for (const entry of fs.readdirSync(epicPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const m = /^(\d+)-/.exec(entry.name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  // Floor at 1: a fresh epic (no NN- folders, e.g. add-phase before epic-init) starts at
  // 01, never 00 (which would collide with 00-epic-plan/). (Tightening trivia, 2026-08-30.)
  return Math.max(1, max + 1);
}

/**
 * Compute the next round number for a role within a phase folder: scan for
 * `spawn-prompt-<role>-r<N>.md`, take max N, +1. None → 1. Returns a Number.
 */
function nextRoundNumber(phasePath, role) {
  let max = 0;
  const re = new RegExp(`^spawn-prompt-${escapeRe(role)}-r(\\d+)\\.md$`);
  if (fs.existsSync(phasePath)) {
    for (const name of fs.readdirSync(phasePath)) {
      const m = re.exec(name);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Per-subagent tmp scratch folder names for one role+round, per fold-in #4:
 * `tmp/<role>-r<N>[-v<M>]/`. The verifier (blind M-of-count) ALWAYS gets a
 * `-v<M>` suffix (matching the `verifier-r<N>-v<M>-verdict.md` verdict naming),
 * and any role with count>1 gets one per instance; a lone non-verifier role gets
 * a plain `<role>-r<N>`.
 */
function tmpFolderNames(role, round, count) {
  const c = typeof count === 'number' && count > 0 ? count : 1;
  const perInstance = role === 'verifier' || c > 1;
  if (!perInstance) return [`${role}-r${round}`];
  const out = [];
  for (let m = 1; m <= c; m += 1) out.push(`${role}-r${round}-v${m}`);
  return out;
}

// ───────────────────────────────────────────────────────────────────────────
// Stub content
// ───────────────────────────────────────────────────────────────────────────

function epicPlanStub(epicSlug) {
  return [
    `# Epic — ${epicSlug}`,
    '',
    '> The ONE mutable cross-phase home. ORCHESTRATOR-WRITE-ONLY; all subagents are',
    '> READ-ONLY here. Keep it CHARTER-CLEAN (subagents read this file) — describe WHAT',
    '> each phase delivers, never its internal approach.',
    '',
    '## Goal / deliverable',
    '{{EPIC_GOAL}}',
    '',
    '## Phase map',
    '',
    '| NN | Phase | Team | Parallelism | Status |',
    '|----|-------|------|-------------|--------|',
    '| 00 | epic-plan (this) | — | — | living |',
    '| {{NN}} | {{PHASE}} | {{TEAM}} | {{PARALLELISM}} | {{STATUS}} |',
    '',
    '_Numbered ≠ serial: NN is a stable creation-order id, not an execution order._',
    '',
    '## Deliverable acceptance',
    '{{DELIVERABLE_ACCEPTANCE}}',
    '',
  ].join('\n');
}

function punchlistStub() {
  return [
    '# Punchlist',
    '',
    '> Running ledger — updated after each phase reconciles.',
    '',
    '## Pending',
    '- {{PENDING_ITEM}}',
    '',
    '## Done',
    '',
    '## Cut / deferred',
    '',
  ].join('\n');
}

function decisionsStub() {
  return [
    '# Decisions',
    '',
    '> Human + orchestrator decisions across phases. Doubles as the raise-to-user',
    '> queue. CHARTER-CLEAN (subagents read this file): record WHAT was decided, not how a phase is approached.',
    '',
    '## Log',
    '- {{DECISION}} — {{DATE}}',
    '',
    '## Raise to user',
    '- {{RAISE_ITEM}}',
    '',
  ].join('\n');
}

/**
 * plan.md stub — pure STRUCTURE, no charter, no posture (fold-in / §"Concrete
 * plan.md spec"). Each section carries its fill sentinel; the orchestrator fills
 * them before spawn. Deliberately a STUB — don't over-build.
 */
function planStub(phaseName) {
  return [
    `# Plan — ${phaseName}`,
    '',
    '> Structure only. The charter (posture / definition of done) lives in the',
    '> separate `charter-<role>.md` the spawn-prompt names — never in this file.',
    '',
    '## Scope / motivation',
    '{{MOTIVATION}}',
    '',
    '## Definition of Done',
    '',
    '| Claim | Artifact | Check |',
    '|-------|----------|-------|',
    '| {{DOD}} | | |',
    '',
    '## Task / method',
    '{{TASK_METHOD}}',
    '',
    '## Tools & MCP',
    '{{RELEVANT_TOOLS}}',
    '',
    '## Context — folders to read',
    '{{RELEVANT_FOLDERS}}',
    '',
    '## Deliverables',
    '{{DELIVERABLES}}',
    '',
    '## Constraints',
    '{{SCOPE_BOUNDARY}}',
    '',
    '## Time budget',
    '{{TIME_BUDGET}}',
    '',
    '## When done',
    '{{FINAL_SUMMARY_SHAPE}}',
    '',
  ].join('\n');
}

/**
 * spawn-prompt-<role>-r<N>.md stub. Points at the phase folder, the role's
 * charter file, and plan.md. Deliberately a STUB — the orchestrator composes the
 * real curated reading list + constants.
 */
function spawnPromptStub(role, round, phaseName) {
  return [
    `You are a ${role.toUpperCase()} subagent — ${phaseName}, round r${round}.`,
    '',
    '{{ROLE_ONE_LINER}}',
    '',
    'Working folder (write ONLY inside here; paths may contain spaces, quote them):',
    '`{{PHASE_FOLDER_ABS}}`',
    '',
    'Read, in order:',
    `1. \`charter-${role}.md\` (in your working folder) — your posture / definition of done.`,
    '2. `plan.md` (in your working folder) — the task, the Definition of Done, constraints.',
    '3. {{CURATED_CONTEXT}} — the orchestrator-curated, token-scoped reading list',
    '   (your folder · `00-epic-plan/` summary · the specific prior `findings/HANDOFF.md`s named).',
    '',
    'Step zero (before any doc reads) — source your env in ONE bash call:',
    '```',
    "{{ENV_SOURCE_RITUAL}}",
    '```',
    '',
    'Model: {{MODEL}}',
    '',
    'Deliverable: {{DELIVERABLE}}. Write `findings/HANDOFF.md`.',
    '',
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// subagent.env stub + consumer override (tightening fix #3)
// ───────────────────────────────────────────────────────────────────────────

/**
 * The comment-only `subagent.env` stub the scaffolder drops on every add-phase (and
 * add-round). The whole module's step-zero ritual `source`s this file; the fable review
 * found NOTHING in the documented flow created it, so every worker's step zero aborted the
 * `&&` chain on a missing file (fable-3 #2). A comment-only file `source`s cleanly (no vars),
 * so the ritual always succeeds; the orchestrator overwrites it with real values when a round
 * needs a live system.
 */
function subagentEnvStub() {
  return [
    '# subagent.env — per-subagent environment for this phase.',
    '#',
    '# Comment-only STUB dropped by scaffold-subagent (tightening fix #3). `source` succeeds',
    '# and sets nothing — the expected state when the round needs no live system.',
    '# The ORCHESTRATOR overwrites this with real values (endpoints/handles/keys) when a round',
    '# needs a live system; a project can also seed a fixed template via the consumer override',
    '# (config `workflow.subagentEnvTemplate`, or `.claude/claude-tpm/subagent.env.template`).',
    '',
  ].join('\n');
}

/**
 * Resolve the consumer env-template override, if any. Precedence:
 *   1. config `workflow.subagentEnvTemplate` (relative to projectRoot, or absolute) — if it exists.
 *   2. the conventional path `<projectRoot>/.claude/claude-tpm/subagent.env.template` — if it exists.
 *   3. null → caller falls back to the built-in comment-only stub.
 * This is the EXTENSIBILITY HOOK nbajam/ggaitk use to populate emulator env (fable-2 note in
 * claude-context/dev/tasks.md; fable-3 #2 fix).
 * @returns {{path: string, source: 'config'|'convention'}|null}
 */
function resolveEnvTemplate(resolved, projectRoot) {
  const configured = resolved && resolved.subagentEnvTemplate;
  if (configured) {
    const abs = path.isAbsolute(configured) ? configured : path.join(projectRoot, configured);
    if (fs.existsSync(abs)) return { path: abs, source: 'config' };
  }
  const convention = path.join(projectRoot, '.claude', 'claude-tpm', 'subagent.env.template');
  if (fs.existsSync(convention)) return { path: convention, source: 'convention' };
  return null;
}

/**
 * Drop `<tmpDir>/subagent.env` IF ABSENT (never clobber an env the orchestrator already
 * populated). Copies the consumer override template when one resolves, else the built-in
 * comment-only stub. Returns a note describing what landed (or null if it already existed).
 */
function dropSubagentEnv(tmpDir, resolved, projectRoot, opts, created, patterns) {
  const target = path.join(tmpDir, 'subagent.env');
  if (fs.existsSync(target)) return null;
  const override = resolveEnvTemplate(resolved, projectRoot);
  const content = override ? fs.readFileSync(override.path, 'utf8') : subagentEnvStub();
  writeFileGuarded(target, content, opts, created, patterns);
  return { target, fromTemplate: !!override, source: override ? override.path : null, via: override ? override.source : 'stub' };
}

// ───────────────────────────────────────────────────────────────────────────
// plan.md seeding: configured template (tightening fix #9) or the built-in stub
// ───────────────────────────────────────────────────────────────────────────

/**
 * Expand a configured plan-template's body for one phase. Light, token-only expansion:
 * `{{PHASE}}` / `{{PHASE_NAME}}` / `{{PHASE_SLUG}}` → the phase folder name. A template with
 * none of those tokens is copied through unchanged. (Kept deliberately minimal — the
 * orchestrator fills the rest of the sentinels before spawn, exactly as with the built-in stub.)
 */
function expandPlanTemplate(raw, phaseFolder) {
  return String(raw)
    .replace(/\{\{PHASE_NAME\}\}/g, phaseFolder)
    .replace(/\{\{PHASE_SLUG\}\}/g, phaseFolder)
    .replace(/\{\{PHASE\}\}/g, phaseFolder);
}

/**
 * Resolve the plan.md seed content for a phase. If the resolved config names a
 * `planTemplateFile` that EXISTS on disk (relative to projectRoot, or absolute), seed from
 * THAT (expanded); otherwise the built-in `planStub`. Kills the "dead config" finding
 * (fable-2 #8 / decisions.md — `planTemplateFile` was resolved but never consumed).
 * @returns {{content: string, fromTemplate: boolean, source: string|null}}
 */
function resolvePlanContent(resolved, projectRoot, phaseFolder) {
  const rel = resolved && resolved.planTemplateFile;
  if (rel) {
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (fs.existsSync(abs)) {
      return { content: expandPlanTemplate(fs.readFileSync(abs, 'utf8'), phaseFolder), fromTemplate: true, source: abs };
    }
  }
  return { content: planStub(phaseFolder), fromTemplate: false, source: null };
}

// ───────────────────────────────────────────────────────────────────────────
// Pre-task acknowledgment gate (modes-plan §2 enforcement)
// ───────────────────────────────────────────────────────────────────────────

// The pre-task QUESTIONS gate — present the roster, the user accepts with `all defaults`
// or explicit answers — is a PROSE step in modes-plan §2. Prose ordering got SKIPPED twice
// (session-007) when the round's shape already felt decided, because nothing downstream
// checked it happened, so the skip was silent. This makes a pre-task RECEIPT a hard
// precondition of add-phase (the step that produces the spawn machinery a spawn runs from):
// scaffolding a phase refuses unless a receipt exists AND records the user's acceptance.
// Skipping the questions now fails LOUDLY. Same poka-yoke shape as the pre-spawn lint — it
// can't stop a determined orchestrator (who could hand-write a receipt), only the
// accidental/forgetful path, which is exactly the failure we saw.

// Acceptance landmark, parsed leniently (like the rest of this tool): an `**Accepted:**`
// line (optionally a list item) whose value is present and not a negative/placeholder token.
const ACK_ACCEPT_RE = /^[ \t]*(?:[-*][ \t]+)?\*\*Accepted:\*\*[ \t]*(.+?)[ \t]*$/im;
const ACK_NEGATIVE_RE = /^(no|not|false|pending|none|tbd|n\/?a|todo|fill|\{\{)/i;

/**
 * Validate a pre-task acknowledgment receipt. A receipt is any markdown file carrying an
 * `**Accepted:**` line with a non-negative value — the user's accept phrase / answers,
 * e.g. `**Accepted:** all defaults`. Lenient by design (landmark, not byte offset).
 * @returns {{ok: true, value, path}|{ok: false, reason}}
 */
function readPretaskAck(ackPath, { startDir } = {}) {
  const abs = path.isAbsolute(ackPath) ? ackPath : path.resolve(startDir || process.cwd(), ackPath);
  if (!fs.existsSync(abs)) {
    return { ok: false, reason: `pre-task ack file not found: ${abs}` };
  }
  const m = ACK_ACCEPT_RE.exec(fs.readFileSync(abs, 'utf8'));
  if (!m) {
    return { ok: false, reason: `pre-task ack ${abs} has no "**Accepted:**" line — it must record the user's response (e.g. "**Accepted:** all defaults")` };
  }
  const value = m[1].trim();
  if (!value || ACK_NEGATIVE_RE.test(value)) {
    return { ok: false, reason: `pre-task ack ${abs} acceptance is empty or a placeholder ("${value}") — capture the user's actual accept phrase / answers` };
  }
  return { ok: true, value, path: abs };
}

/**
 * Enforce the gate: throw an actionable error unless a valid receipt is supplied. Called at
 * the very top of add-phase. There is deliberately NO bypass flag — a bypass would just
 * recreate the silent skip this exists to close (--force overwrites files, it does not skip
 * the questions).
 */
function assertPretaskAck(ackPath, { startDir } = {}) {
  if (!ackPath) {
    throw new Error(
      'add-phase requires --pretask-ack <receipt>. Present the pre-task roster and capture the '
      + "user's answers (`all defaults` or explicit) FIRST (modes-plan §2), write them to "
      + 'dev/<epic>/00-epic-plan/pretask-<phase>.md with an "**Accepted:** <phrase>" line, then re-run.',
    );
  }
  const res = readPretaskAck(ackPath, { startDir });
  if (!res.ok) {
    throw new Error(`${res.reason}. (The pre-task questions gate — modes-plan §2 — must run before a phase is scaffolded.)`);
  }
  return res;
}

// ───────────────────────────────────────────────────────────────────────────
// Subcommand: epic-init
// ───────────────────────────────────────────────────────────────────────────

function epicInit(epicPath, opts = {}) {
  const created = [];
  const patterns = opts.patterns;
  ensureDir(epicPath, opts, created);
  const epicPlanDir = ensureDir(path.join(epicPath, '00-epic-plan'), opts, created);
  const epicSlug = path.basename(path.resolve(epicPath));

  writeFileGuarded(path.join(epicPlanDir, 'epic-plan.md'), epicPlanStub(epicSlug), opts, created, patterns);
  writeFileGuarded(path.join(epicPlanDir, 'punchlist.md'), punchlistStub(), opts, created, patterns);
  writeFileGuarded(path.join(epicPlanDir, 'decisions.md'), decisionsStub(), opts, created, patterns);

  return { epicPath: path.resolve(epicPath), epicPlanDir, created };
}

// ───────────────────────────────────────────────────────────────────────────
// Subcommand: add-phase
// ───────────────────────────────────────────────────────────────────────────

function addPhase(epicPath, { slug, team, configPath, startDir, patterns, charter, charterRole, pretaskAck } = {}, opts = {}) {
  if (!slug) throw new Error('add-phase: --slug is required.');
  if (!team) throw new Error('add-phase: --team is required.');
  // Pre-task questions gate (modes-plan §2): refuse to scaffold a phase without a valid
  // pre-task ack receipt. This is the FIRST thing add-phase checks — before any roster
  // resolution or disk write — so a skipped-questions round dies here, loudly.
  const ackNote = assertPretaskAck(pretaskAck, { startDir });
  // --slug is a plain folder name, never a path: reject separators / traversal / absolutes so
  // `--slug ../../OUT` can't write outside the epic. (Path-traversal guard, 2026-08-29.)
  if (slug.includes('/') || slug.includes('\\') || slug.includes('..') || path.isAbsolute(slug)) {
    throw new Error(`add-phase: --slug must be a plain folder name (no "/", "\\", ".." or absolute path) — got "${slug}".`);
  }

  const roster = resolveTeamRoster(team, { configPath, startDir });
  const localPatterns = patterns || roster.resolved.blockedFilenamePatterns;

  // --charter <path> override (tightening fix #5): route a chosen charter (e.g. the mvp
  // opt-down) through dropCharter so the strip + blocked-name guards still apply. Determine
  // WHICH role it re-charters: an explicit --role (--charterRole) wins; otherwise a single-role
  // team is unambiguous; a multi-role team without --role is an error (which of N?).
  const charterAbs = charter
    ? (path.isAbsolute(charter) ? charter : path.resolve(startDir || process.cwd(), charter))
    : null;
  let overrideRoleName = null;
  if (charterAbs) {
    if (charterRole) {
      if (!roster.roles.some((r) => r.name === charterRole)) {
        throw new Error(`add-phase: --charter --role "${charterRole}" is not in team "${team}" (roles: ${roster.roles.map((r) => r.name).join(', ')}).`);
      }
      overrideRoleName = charterRole;
    } else if (roster.roles.length === 1) {
      overrideRoleName = roster.roles[0].name;
    } else {
      throw new Error(`add-phase: --charter needs --role to say which of team "${team}"'s roles it re-charters (roles: ${roster.roles.map((r) => r.name).join(', ')}).`);
    }
  }

  const created = [];
  ensureDir(epicPath, opts, created);

  const n = nextPhaseNumber(epicPath);
  const phaseFolder = `${pad2(n)}-${slug}`;
  const phaseDir = path.join(epicPath, phaseFolder);
  if (fs.existsSync(phaseDir) && !opts.force) {
    throw new Error(`phase folder already exists: ${phaseDir} (pass --force).`);
  }
  ensureDir(phaseDir, opts, created);

  // Standard phase skeleton.
  // #1183: subfolder names come from the resolved workflow.folders (default tmp -> tpm-tmp).
  const folders = foldersOf(roster.resolved);
  ensureDir(path.join(phaseDir, folders.findings), opts, created);
  ensureDir(path.join(phaseDir, folders.tools), opts, created);
  ensureDir(path.join(phaseDir, folders.tests), opts, created);
  const tmpDir = ensureDir(path.join(phaseDir, folders.tmp), opts, created);

  // plan.md — seed from a configured planTemplateFile if one resolves (tightening fix #9),
  // else the built-in stub. Exactly one plan per phase either way.
  const planSeed = resolvePlanContent(roster.resolved, roster.projectRoot, phaseFolder);
  writeFileGuarded(path.join(phaseDir, 'plan.md'), planSeed.content, opts, created, localPatterns);

  // subagent.env comment-only stub (or the consumer override template) — tightening fix #3.
  const envNote = dropSubagentEnv(tmpDir, roster.resolved, roster.projectRoot, opts, created, localPatterns);

  // Per-role: charter (copied) + spawn-prompt stub + per-subagent tmp scratch.
  const charterNotes = [];
  for (const role of roster.roles) {
    const round = nextRoundNumber(phaseDir, role.name); // fresh phase → 1

    // Charter — COPY the resolved charterFile; if none/missing, drop a placeholder
    // stub so the skeleton is always complete (and note it). A --charter override for THIS
    // role swaps in the chosen charterFile (fix #5) — still routed through dropCharter.
    const charterTarget = path.join(phaseDir, `charter-${role.name}.md`);
    const roleForCharter = role.name === overrideRoleName
      ? Object.assign({}, role, { charterFile: charterAbs })
      : role;
    const note = dropCharter(charterTarget, roleForCharter, roster.projectRoot, opts, created, localPatterns);
    if (role.name === overrideRoleName) note.override = true;
    charterNotes.push(note);

    // Spawn-prompt stub (one per role per round).
    writeFileGuarded(
      path.join(phaseDir, `spawn-prompt-${role.name}-r${round}.md`),
      spawnPromptStub(role.name, round, phaseFolder),
      opts,
      created,
      localPatterns,
    );

    // Per-subagent tmp scratch subfolder(s).
    for (const folder of tmpFolderNames(role.name, round, role.count)) {
      ensureDir(path.join(tmpDir, folder), opts, created);
    }
  }

  return { phaseDir: path.resolve(phaseDir), phaseFolder, number: n, roster, charterNotes, planSeed, envNote, ackNote, created };
}

/**
 * Drop `charter-<role>.md` into the phase by copying the role's resolved
 * charterFile. Empty charterFile (TPM default) or a path that doesn't exist →
 * write a placeholder stub instead (skeleton stays complete). Returns a note.
 */
function dropCharter(charterTarget, role, projectRoot, opts, created, patterns) {
  const rel = role.charterFile;
  if (rel) {
    const abs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    if (fs.existsSync(abs)) {
      const raw = fs.readFileSync(abs, 'utf8');
      // Charter secrecy: strip the orchestrator-only `<!-- ORCHESTRATOR NOTE ... -->`
      // block(s) before the charter reaches a worker. This is the strip SENTINEL the
      // design defines (a shipping charter's note names the weaker mvp/research postures);
      // copying verbatim would leak it. The lint's ORCHESTRATOR-NOTE check is the backstop.
      // (Strip bug fix, 2026-08-29 — dropCharter previously copied verbatim.)
      // The regex is CASE-INSENSITIVE + hyphen-tolerant (tightening fix #6, 2026-08-29):
      // it must match the lint's STRIP_RE grammar (/<!--\s*ORCHESTRATOR NOTE\b…-->/i), or a
      // consumer charter carrying `<!-- Orchestrator note … -->` (a natural lowercase spelling,
      // and a REAL posture leak) drops verbatim while the lint FAILs it — the two tools would
      // disagree about what a strip sentinel IS (fable-2 #2).
      const body = raw
        .replace(/<!--\s*ORCHESTRATOR[ -]NOTE\b[\s\S]*?-->\n*/gi, '')
        .replace(/^\n+/, '')
        .replace(/\n{3,}/g, '\n\n');
      writeFileGuarded(charterTarget, body, opts, created, patterns);
      return { role: role.name, source: abs, copied: true, stripped: raw !== body };
    }
    // Configured but missing → FAIL LOUD. We still complete the skeleton so the round can proceed,
    // but a postureless placeholder (no definition of done) must NEVER ship silently — that's how a
    // consumer round shipped 6 empty charters undetected (claude-decant, 2026-09-01).
    process.stderr.write(
      `\n⚠️  charter MISSING for role "${role.name}": ${abs}\n`
      + `    → dropping a POSTURELESS placeholder charter-${role.name}.md (worker gets NO definition of done).\n`
      + `    In a consumer install the default charters live under the BUNDLE; a bare relative charterFile\n`
      + `    resolves at the consumer root instead — see tpm-workflow-config-resolver.js charterHome() (now bundle-anchored).\n\n`,
    );
    const stub = charterPlaceholder(role.name, `configured charterFile not found on disk: ${abs}`);
    writeFileGuarded(charterTarget, stub, opts, created, patterns);
    return { role: role.name, source: abs, copied: false, missing: true };
  }
  // No override → TPM default charter applies; drop a placeholder pointer.
  const stub = charterPlaceholder(role.name, 'no charterFile override in config (TPM default charter for this role applies)');
  writeFileGuarded(charterTarget, stub, opts, created, patterns);
  return { role: role.name, source: null, copied: false };
}

function charterPlaceholder(role, why) {
  return [
    `# Charter — ${role} (placeholder)`,
    '',
    `> ${why}.`,
    '> Replace this file with the resolved charter body before spawn, or point the',
    `> config's subagentConfigs[${role}].charterFile at the real charter and re-run.`,
    '',
    '{{CHARTER_BODY}}',
    '',
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────────
// Subcommand: add-round
// ───────────────────────────────────────────────────────────────────────────

// Batch: scaffold N build phases in ONE call — the parallel-fan-out shape (an epic of N phases). Each
// --slug in the comma-separated list becomes the next auto-numbered phase (01-<a>, 02-<b>, …), all on
// the same --team + the same epic-level --pretask-ack. Saves N hand-invocations of add-phase.
function addPhases(epicPath, { slugs, team, configPath, startDir, patterns, charter, charterRole, pretaskAck } = {}, opts = {}) {
  const list = String(slugs || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new Error('add-phases: --slugs <a,b,c> is required (comma-separated plain folder names).');
  const phases = [];
  for (const slug of list) {
    phases.push(addPhase(epicPath, { slug, team, configPath, startDir, patterns, charter, charterRole, pretaskAck }, opts));
  }
  return { epicPath, phases };
}

function addRound(phasePath, { role, count, patterns, configPath, startDir, charter } = {}, opts = {}) {
  if (!role) throw new Error('add-round: --role is required.');
  if (!fs.existsSync(phasePath)) throw new Error(`add-round: phase folder does not exist: ${phasePath}`);

  // Resolve the config ONCE (best-effort): patterns + the env-template + projectRoot all come
  // from it. A config that can't resolve → undefined patterns (check-filename's defaults) and
  // no env override (built-in stub).
  let resolved;
  let projectRoot = findRoot({ startDir, quiet: true }); // env-aware fallback if the config can't resolve
  try {
    const res = configResolver.resolveConfig(configPath, { startDir });
    resolved = res.resolved;
    projectRoot = res.projectRoot;
  } catch (_e) {
    resolved = undefined;
  }
  const localPatterns = patterns || (resolved && resolved.blockedFilenamePatterns);

  const created = [];
  const round = nextRoundNumber(phasePath, role);
  const phaseName = path.basename(path.resolve(phasePath));

  writeFileGuarded(
    path.join(phasePath, `spawn-prompt-${role}-r${round}.md`),
    spawnPromptStub(role, round, phaseName),
    opts,
    created,
    localPatterns,
  );

  // Charter drop. Two paths:
  //   (a) --charter <path> override (tightening fix #5): (re)drop THIS role's charter from the
  //       chosen file, routed through dropCharter (strip + guards apply). Overwriting an existing
  //       charter-<role>.md needs --force. Lets the orchestrator swap in the mvp opt-down via the
  //       TOOL: `add-round <phase> --role builder --charter <mvp-charter> --force`.
  //   (b) no override: a role that joins mid-loop (chiefly the verify↔bug-fixer loop's `bug-fixer`,
  //       in no team roster) never had its charter dropped at add-phase — drop it now, but only if
  //       ABSENT so a re-check round for a roster role (e.g. verifier) doesn't clobber the copy.
  const charterTarget = path.join(phasePath, `charter-${role}.md`);
  let charterNote = null;
  const charterAbs = charter
    ? (path.isAbsolute(charter) ? charter : path.resolve(startDir || process.cwd(), charter))
    : null;
  if (charterAbs) {
    const roleObj = { name: role, count: 1, model: '', charterFile: charterAbs };
    charterNote = dropCharter(charterTarget, roleObj, projectRoot, opts, created, localPatterns);
    charterNote.override = true;
  } else if (!fs.existsSync(charterTarget)) {
    try {
      const { role: roleObj, projectRoot: pr } = resolveRoleCharter(role, { configPath, startDir });
      charterNote = dropCharter(charterTarget, roleObj, pr, opts, created, localPatterns);
    } catch (_e) {
      charterNote = null; // config unresolvable → skip the charter, keep the round scaffolding
    }
  }

  const tmpDir = ensureDir(path.join(phasePath, foldersOf(resolved).tmp), opts, created);
  // subagent.env comment-only stub (or consumer override) — dropped if absent (fix #3). A
  // re-round in an existing phase usually already has one from add-phase; this covers a phase
  // scaffolded before the stub existed, or a role that joins a bare phase.
  const envNote = dropSubagentEnv(tmpDir, resolved, projectRoot, opts, created, localPatterns);
  for (const folder of tmpFolderNames(role, round, count)) {
    ensureDir(path.join(tmpDir, folder), opts, created);
  }

  return { phasePath: path.resolve(phasePath), role, round, charterNote, envNote, created };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function printHelp() {
  const src = fs.readFileSync(__filename, 'utf8');
  const header = src.match(/\/\*\*([\s\S]*?)\*\//);
  if (header) {
    process.stdout.write(header[1].split('\n').map((l) => l.replace(/^ \*\s?/, '')).join('\n').trim() + '\n');
  }
}

function needValue(flag, argv, i) {
  if (i + 1 >= argv.length) {
    process.stderr.write(`Error: ${flag} requires a value.\n`);
    process.exit(2);
  }
  return argv[i + 1];
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.help = true;
    else if (a === '--force') args.force = true;
    else if (a === '--quiet') args.quiet = true;
    else if (a === '--slug') { args.slug = needValue(a, argv, i); i += 1; }
    else if (a === '--slugs') { args.slugs = needValue(a, argv, i); i += 1; } // add-phases: comma-separated
    else if (a === '--team') { args.team = needValue(a, argv, i); i += 1; }
    else if (a === '--role') { args.role = needValue(a, argv, i); i += 1; }
    else if (a === '--count') { args.count = parseInt(needValue(a, argv, i), 10); i += 1; }
    else if (a === '--config') { args.config = needValue(a, argv, i); i += 1; }
    else if (a === '--charter') { args.charter = needValue(a, argv, i); i += 1; }
    else if (a === '--pretask-ack') { args.pretaskAck = needValue(a, argv, i); i += 1; }
    else if (a.startsWith('--')) { process.stderr.write(`Unknown flag: ${a}\n`); process.exit(2); }
    else args._.push(a);
  }
  return args;
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);

  if (args.help && !args._[0]) { printHelp(); process.exit(0); }
  const sub = args._[0];
  if (!sub) { printHelp(); process.exit(1); }
  if (args.help) { printHelp(); process.exit(0); }

  const opts = { quiet: args.quiet, force: args.force };

  try {
    if (sub === 'epic-init') {
      if (!args._[1]) throw new Error('epic-init: <epic-path> is required.');
      const epicPath = resolveBase(args._[1], devDirFor(args.config));
      const r = epicInit(epicPath, opts);
      process.stdout.write(`\nepic-init complete: ${r.epicPath}\n`);
      process.stdout.write('Next: add-phase <epic-path> --slug <slug> --team <team>\n');
    } else if (sub === 'add-phase') {
      if (!args._[1]) throw new Error('add-phase: <epic-path> is required.');
      const epicPath = resolveBase(args._[1], devDirFor(args.config));
      const r = addPhase(epicPath, {
        slug: args.slug, team: args.team, configPath: args.config, charter: args.charter, charterRole: args.role,
        pretaskAck: args.pretaskAck,
      }, opts);
      process.stdout.write(`\nadd-phase complete: ${r.phaseFolder} (roles: ${r.roster.roles.map((x) => x.name).join(', ')})\n`);
      if (r.ackNote) process.stdout.write(`  pre-task ack ✓ ${r.ackNote.path} ("${r.ackNote.value}")\n`);
      if (r.planSeed && r.planSeed.fromTemplate) process.stdout.write(`  plan.md ← seeded from planTemplateFile ${r.planSeed.source}\n`);
      if (r.envNote) {
        if (r.envNote.fromTemplate) process.stdout.write(`  ${path.basename(path.dirname(r.envNote.target))}/subagent.env ← copied from ${r.envNote.via} template ${r.envNote.source}\n`);
        else process.stdout.write(`  ${path.basename(path.dirname(r.envNote.target))}/subagent.env ← comment-only stub (orchestrator adds real values as needed)\n`);
      }
      for (const n of r.charterNotes) {
        const tag = n.override ? ' [--charter override]' : '';
        if (n.copied) process.stdout.write(`  charter-${n.role}.md ← copied from ${n.source}${tag}\n`);
        else if (n.missing) process.stdout.write(`  charter-${n.role}.md ← PLACEHOLDER (configured file missing: ${n.source})${tag}\n`);
        else process.stdout.write(`  charter-${n.role}.md ← PLACEHOLDER (no override; TPM default charter applies)\n`);
      }
    } else if (sub === 'add-phases') {
      if (!args._[1]) throw new Error('add-phases: <epic-path> is required.');
      const epicPath = resolveBase(args._[1], devDirFor(args.config));
      const r = addPhases(epicPath, {
        slugs: args.slugs, team: args.team, configPath: args.config, charter: args.charter, charterRole: args.role,
        pretaskAck: args.pretaskAck,
      }, opts);
      process.stdout.write(`\nadd-phases complete: ${r.phases.length} phase(s) in ${r.epicPath}\n`);
      for (const p of r.phases) process.stdout.write(`  ${p.phaseFolder} (roles: ${p.roster.roles.map((x) => x.name).join(', ')})\n`);
    } else if (sub === 'add-round') {
      const phasePath = args._[1];
      if (!phasePath) throw new Error('add-round: <phase-path> is required.');
      const r = addRound(phasePath, {
        role: args.role, count: args.count, configPath: args.config, charter: args.charter,
      }, opts);
      process.stdout.write(`\nadd-round complete: spawn-prompt-${r.role}-r${r.round}.md + tmp scratch\n`);
      if (r.envNote) {
        if (r.envNote.fromTemplate) process.stdout.write(`  ${path.basename(path.dirname(r.envNote.target))}/subagent.env ← copied from ${r.envNote.via} template ${r.envNote.source}\n`);
        else process.stdout.write(`  ${path.basename(path.dirname(r.envNote.target))}/subagent.env ← comment-only stub\n`);
      }
      if (r.charterNote) {
        const tag = r.charterNote.override ? ' [--charter override]' : '';
        if (r.charterNote.copied) process.stdout.write(`  charter-${r.charterNote.role}.md ← copied from ${r.charterNote.source}${tag}\n`);
        else if (r.charterNote.missing) process.stdout.write(`  charter-${r.charterNote.role}.md ← PLACEHOLDER (configured file missing: ${r.charterNote.source})${tag}\n`);
        else process.stdout.write(`  charter-${r.charterNote.role}.md ← PLACEHOLDER (no override; TPM default charter applies)\n`);
      }
    } else {
      process.stderr.write(`Unknown subcommand: ${sub}\n`);
      printHelp();
      process.exit(2);
    }
  } catch (err) {
    process.stderr.write(`scaffold-subagent: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveBase,
  epicInit,
  addPhase,
  addPhases,
  addRound,
  resolveTeamRoster,
  resolveRoleCharter,
  readPretaskAck,
  assertPretaskAck,
  nextPhaseNumber,
  nextRoundNumber,
  tmpFolderNames,
  pad2,
  planStub,
  epicPlanStub,
  dropCharter,
  subagentEnvStub,
  resolveEnvTemplate,
  dropSubagentEnv,
  expandPlanTemplate,
  resolvePlanContent,
};
