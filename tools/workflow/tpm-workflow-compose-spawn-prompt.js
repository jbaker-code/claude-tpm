#!/usr/bin/env node
/**
 * tpm workflow compose - mechanically emit the standard subagent
 * spawn-prompt boilerplate so the orchestrator supplies only the ONE
 * task-specific bit (a `{{TASK_CONTEXT}}` fill sentinel it fills in before
 * spawning). A token-saver + a consistency guard: every prompt gets the same
 * working-folder line, read-order, constraints block, and return-shape without
 * the orchestrator retyping them.
 *
 * ROLE-CONDITIONAL posture (the fix that replaced the builder-default). The
 * charter FILE owns a role's full posture; compose does NOT restate it - but the
 * read-order framing and the return-shape it emits MUST match that posture, or a
 * prompt ends up carrying charter A next to a return-shape from charter B. So
 * compose keys both off `--role` (see ROLE_PROFILES):
 *   - builder / test-writer / documentarian -> "deliver the artifact" family
 *     (tailored: test-writer -> the tests + a mutation-check; documentarian ->
 *     the docs, every claim run-verified);
 *   - verifier -> "report a VERDICT, not a repair" + a HARD RULE line + the
 *     verdict-file return-shape;
 *   - planning / researcher -> "do NOT build; deliver a plan / knowledge" (NOT
 *     "the built artifact + passing checks");
 *   - bug-fixer -> the verdict file becomes read-order item 1 (via --verdict)
 *     and the return-shape is "fix exactly the findings, nothing beyond them";
 *   - any other (consumer-added) role -> a posture-NEUTRAL cue + return-shape
 *     that defers entirely to the charter (never the builder default).
 *
 * The emitted `{{TASK_CONTEXT}}` is a real FILL sentinel: run the output back
 * through `tpm workflow lint --sentinels-only` and it will FLAG the
 * unfilled placeholder until the orchestrator fills it. That is the poka-yoke
 * loop working as intended.
 *
 * USAGE.
 *   tpm workflow compose --role builder \
 *     --phase-dir 'dev/epic/02b-lint-compose' \
 *     --plan plan.md --charter charter-builder.md
 *
 *   # bug-fixer: --verdict is REQUIRED and becomes read-order item 1:
 *   tpm workflow compose --role bug-fixer --phase-dir <p> \
 *     --plan plan.md --charter charter-bug-fixer.md \
 *     --verdict findings/verifier-r1-v1-verdict.md
 *
 *   # with optional round/model/env-ritual + write to a file:
 *   tpm workflow compose --role verifier --phase-dir <p> \
 *     --plan plan.md --charter charter-verifier.md --round 1 --variant 1 \
 *     --model opus --project-root '/abs/repo/root' --out spawn-prompt-verifier-r1-v1.md
 *
 * FLAGS (no hardcoded defaults for REQUIRED inputs - omitting one fails loudly).
 *   --role <name>        REQUIRED. builder | verifier | test-writer |
 *                        documentarian | planning | researcher | bug-fixer |
 *                        <any> (free text; unknown roles get a neutral posture).
 *   --phase-dir <path>   REQUIRED. The subagent's working folder (write boundary).
 *   --plan <file>        REQUIRED. Plan filename inside the phase dir (e.g. plan.md).
 *   --charter <file>     REQUIRED. Charter filename inside the phase dir.
 *   --verdict <path>     REQUIRED for --role bug-fixer; ignored for other roles.
 *                        The verifier verdict file the fixer's scope IS - it
 *                        becomes read-order item 1 ("the findings you fix are
 *                        EXACTLY these"), making the verify->fix handoff a named
 *                        artifact instead of freeform TASK_CONTEXT prose.
 *   --round <N>          Optional. Kickback round number (r<N>) for scratch/naming.
 *   --variant <M>        Optional. Verifier variant (v<M>); only meaningful with a round.
 *   --model <name>       Optional. Named in a trailing note (the Agent call sets it).
 *   --epic <label>       Optional. Epic/lineage label mentioned in the header.
 *   --project-root <p>   Optional. If given, emits the env-source ritual (step zero)
 *                        with the task folder derived from --phase-dir.
 *   --out <path>         Optional. Write to a file instead of stdout. A relative path is resolved
 *                        against --phase-dir (a bare name lands in the phase folder); a path that
 *                        resolves outside the phase dir is refused (exit 2, nothing written).
 *   --session <ref>      Optional. Attribute the prompt to a session (0012b, or 0012 with --track b); default: auto-resolved.
 *   --track <letter>     Optional. Track letter a-z, used with --session.
 *   --help               Print this message.
 *
 * OUTPUT. The composed prompt to stdout (or --out). Exit 0 on success, 2 on a
 * usage error (missing required flag / unknown arg).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Role-conditional posture table. Each profile supplies:
//   charterCue  - the read-order line-1 framing (must MATCH the charter's
//                 posture; the charter file owns the detail, this is the cue).
//   returnShape - the Return-shape sentence (a fn of the identity slug, since
//                 the verifier verdict filename derives from it).
//   hardRule    - (verifier only) an extra HARD RULE line so a composed verifier
//                 prompt carries verdict-not-repair independence explicitly.
// A role not in this table falls through to NEUTRAL_PROFILE (never the builder
// default) so a consumer-added role is not silently told to "ship the artifact".
// ---------------------------------------------------------------------------

const ARTIFACT_RETURN =
  'your deliverable = the built artifact + its passing checks on disk, plus `findings/HANDOFF.md`. ' +
  'Return a one-paragraph summary: what landed, the exact commands you ran + their results, ' +
  'the `findings/HANDOFF.md` path, and any caveat.';

const ROLE_PROFILES = {
  builder: {
    charterCue: "your posture / definition of done — deliver the artifact; walk the plan's Definition-of-Done table and don't stop until every row is true.",
    returnShape: () => ARTIFACT_RETURN,
  },
  'test-writer': {
    charterCue: "your posture / definition of done — deliver the artifact's TESTS; walk the plan's Definition-of-Done table and don't stop until the suite would actually go red when the artifact breaks.",
    returnShape: () =>
      'your deliverable = the test suite + its green-run and mutation-check evidence on disk, plus `findings/HANDOFF.md`. ' +
      'Return a one-paragraph summary: the tests you added, the exact commands you ran + their results (including the mutation probe that proves a test can fail), ' +
      'the `findings/HANDOFF.md` path, and any caveat.',
  },
  documentarian: {
    charterCue: "your posture / definition of done — deliver the DOCS; every claim you write is one you ran and watched come true against the real artifact.",
    returnShape: () =>
      'your deliverable = the documentation on disk, every claim verified against the running artifact, plus `findings/HANDOFF.md`. ' +
      'Return a one-paragraph summary: the doc you wrote, the exact commands you ran to verify its claims + their results, ' +
      'the `findings/HANDOFF.md` path, and any caveat.',
  },
  verifier: {
    charterCue: "your posture / definition of done — report a VERDICT, not a repair; walk the plan's Definition-of-Done table row by row and adversarially attack each claim.",
    hardRule:
      'HARD RULE — you report a VERDICT, you do not repair: never fix or build the artifact you are verifying. ' +
      'Exercise it adversarially with whatever tools are available, but any fix belongs to a different round.',
    returnShape: (slug) =>
      'your verdict to `findings/' + slug + '-verdict.md` (per-row PASS/FAIL + exact command + observed result; overall PASS/FAIL; concerns), ' +
      'and a short summary: overall verdict + any FAIL/concern. Do NOT modify the tool or tests.',
  },
  planning: {
    charterCue: "your posture / definition of done — do NOT build; deliver a plan proposal + risk map. Read the plan below for scope, not as work to execute.",
    returnShape: () =>
      'your deliverable = a plan proposal + risk map written to `findings/` (NOT a built artifact, NOT passing checks), plus `findings/HANDOFF.md`. ' +
      'Return a one-paragraph summary: the plan you propose, the key risks / open questions, the `findings/` path, and any caveat.',
  },
  researcher: {
    charterCue: "your posture / definition of done — do NOT build; deliver knowledge. Read the plan below for the questions to answer, not as work to execute.",
    returnShape: () =>
      'your deliverable = your findings written to `findings/` (knowledge, NOT a built artifact), plus `findings/HANDOFF.md`. ' +
      'Return a one-paragraph summary: what you found, the evidence behind it, the `findings/` path, and any caveat.',
  },
  'bug-fixer': {
    charterCue: "your posture / definition of done — fix exactly the verdict's findings, every one and nothing beyond them.",
    returnShape: () =>
      "your deliverable = the targeted fixes on the real artifact + re-run evidence that each verdict finding is closed, on disk, plus `findings/HANDOFF.md`. " +
      "Touch nothing beyond the verdict's findings. " +
      "`findings/HANDOFF.md` already holds the prior agents' content: ADD your own section headed `## Bug-fixer r<N>` at the END of it " +
      "and leave everything above untouched - never overwrite or rewrite the existing HANDOFF (if none exists yet, create it). " +
      'Return a one-paragraph summary: each finding and how you closed it, the exact commands you ran + their results, ' +
      'the `findings/HANDOFF.md` path, and any caveat.',
  },
};

// Neutral fallback for any role not in the table - defers to the charter,
// never asserts the builder "built artifact + passing checks" shape.
const NEUTRAL_PROFILE = {
  charterCue: "your posture / definition of done — the charter is authoritative; do exactly what it defines, no more and no less.",
  returnShape: () =>
    "your deliverable is whatever your charter and the plan's Deliverables section define — produce it on disk, plus `findings/HANDOFF.md`. " +
    'Return a one-paragraph summary: what landed, the exact commands you ran + their results, ' +
    'the `findings/HANDOFF.md` path, and any caveat.',
};

function profileFor(role) {
  return ROLE_PROFILES[String(role).toLowerCase()] || NEUTRAL_PROFILE;
}

function printHelp() {
  console.log(fs.readFileSync(__filename, 'utf8').match(/\/\*\*[\s\S]*?\*\//)[0]);
}

function parseArgs(argv) {
  const opts = {
    role: null, phaseDir: null, plan: null, charter: null, verdict: null,
    round: null, variant: null, model: null, epic: null,
    projectRoot: null, out: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--role') opts.role = argv[++i];
    else if (a === '--phase-dir') opts.phaseDir = argv[++i];
    else if (a === '--plan') opts.plan = argv[++i];
    else if (a === '--charter') opts.charter = argv[++i];
    else if (a === '--verdict') opts.verdict = argv[++i];
    else if (a === '--round') opts.round = argv[++i];
    else if (a === '--variant') opts.variant = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--epic') opts.epic = argv[++i];
    else if (a === '--project-root') opts.projectRoot = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
    else if (a === '--session') opts.session = argv[++i];
    else if (a === '--track') opts.track = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error('Unknown arg: ' + a); process.exit(2); }
  }
  if (opts.session !== undefined || opts.track !== undefined) {
    const x = require('../lib/attribution').parseExplicit({ session: opts.session, track: opts.track });
    if (!x.ok) { console.error(x.error); process.exit(2); }
    opts.explicitSession = x.ref;
  }
  return opts;
}

function requireFlag(opts, key, flag) {
  if (!opts[key]) {
    console.error(`Missing required flag ${flag}. Run --help for usage.`);
    process.exit(2);
  }
}

/** Identity slug for scratch/naming: <role>-r<N>[-v<M>], falling back to <role>. */
function identitySlug(opts) {
  let s = String(opts.role).toLowerCase();
  if (opts.round) {
    s += `-r${opts.round}`;
    if (opts.variant) s += `-v${opts.variant}`;
  }
  return s;
}

function compose(opts) {
  const role = String(opts.role);
  const ROLE = role.toUpperCase();
  const isBugFixer = role.toLowerCase() === 'bug-fixer';
  const profile = profileFor(role);
  const phaseDir = opts.phaseDir;
  const slug = identitySlug(opts);
  const epicNote = opts.epic ? ` of the ${opts.epic}` : '';
  const L = [];

  L.push(`You are a ${ROLE} subagent${epicNote}.`);
  // Marker the spawn-gate hook (tools/workflow/hooks/tpm-workflow-gate-spawn.js) keys off: a positive, unambiguous
  // signal that this IS a tpm-workflow round spawn (so an ordinary agent is never false-gated), carrying
  // the round identity (the phase folder) that the user's "kick it off" sign-off token must match.
  // Harmless to the subagent — it's an HTML comment.
  L.push(`<!-- tpm-workflow-spawn phase="${phaseDir}" role="${role}" -->`);
  // Phase 18: a SEPARATE informational comment (NEVER an attribute of the marker — tpm-workflow-doctor's regex is strict).
  // Omitted when no session resolves. Never throws.
  try {
    const att = require('../lib/attribution');
    const f = att.toEventFields(att.resolveAttribution({ explicit: opts.explicitSession || null }));
    if (f.session) L.push(`<!-- tpm-session session="${f.session}" via="${f.sessionVia}" -->`);
  } catch (_e) { /* stamping never blocks */ }
  L.push('');
  L.push('Working folder (write ONLY inside here; quote paths — they contain spaces):');
  L.push('`' + phaseDir + '`');
  L.push('');

  // Optional env-source ritual (step zero) when a project root is supplied.
  if (opts.projectRoot) {
    const taskRel = phaseDir; // the working folder, relative to the project root
    L.push('Step zero — source the task env (ONE bash call, anchored at the project root):');
    L.push('```');
    L.push(`cd '${opts.projectRoot}' && \\`);
    L.push(`  set -a && source '${taskRel}/tmp/subagent.env' && set +a && \\`);
    L.push(`  env | sort > '${taskRel}/tmp/worker-env.md'`);
    L.push('```');
    L.push('');
  }

  // Read-order. For a bug-fixer the verifier's verdict is item 1 (the findings
  // it fixes ARE the verdict) - a named artifact, not freeform TASK_CONTEXT.
  L.push('Read, in order:');
  let n = 1;
  if (isBugFixer) {
    L.push(`${n++}. The verifier's verdict: \`${opts.verdict}\` — the findings you fix are EXACTLY these; every one, and nothing beyond them.`);
  }
  L.push(`${n++}. Your charter: \`${opts.charter}\` — ${profile.charterCue}`);
  L.push(`${n++}. Your plan: \`${opts.plan}\` — the task, the Definition of Done, the specs, the constraints.`);
  L.push(`${n++}. The curated context files the plan's "Context" section names.`);
  // ANCHOR-FIRST resolution (#1126): the token-resolving hooks are retired, so the worker resolves
  // %TPM_HOME% itself — run `tpm resolve-home` once (self-locating, bypass-safe), treat the printed
  // absolute path AS %TPM_HOME%, then resolve each %TPM_HOME%/… methodology path against it. Bare paths
  // dead-end at the consumer root; the anchor keeps the chain resolvable in a consumer install too.
  // Shell-inert spelling `%TPM_HOME%` (not `${TPM_HOME}`, which bash would expand to empty on a command line).
  L.push('Also always read your base methodology chain (always-on conventions). FIRST run `tpm resolve-home` — its printed absolute path IS `%TPM_HOME%` (the claude-tpm bundle root). THEN read each of these, resolving `%TPM_HOME%` against that path: `%TPM_HOME%/claude-context/methodology/project-workspace.md`, `%TPM_HOME%/claude-context/methodology/subagent/handbook.md`, `%TPM_HOME%/claude-context/methodology/shared-conventions.md`, `%TPM_HOME%/claude-context/methodology/tool-conventions.md`, `%TPM_HOME%/claude-context/methodology/troubleshooting.md`, `%TPM_HOME%/claude-context/methodology/verification.md`.');
  L.push('');

  // Verifier carries an explicit HARD RULE independence line (verdict-not-repair).
  if (profile.hardRule) {
    L.push(profile.hardRule);
    L.push('');
  }

  // The single task-specific fill sentinel the orchestrator supplies.
  L.push('Task for this round:');
  L.push('{{TASK_CONTEXT}}');
  L.push('');

  // Constraints (standing boilerplate).
  L.push(`Constraints: write ONLY inside the working folder above; zero external deps; portable \`node <file>\`; scratch → \`tmp/${slug}/\`; never name a file report/summary/analysis/findings (server-side blocked).`);
  L.push('');

  // Return-shape (role-conditional - matches the charter posture above).
  L.push('Return-shape: ' + profile.returnShape(slug));

  if (opts.model) {
    L.push('');
    L.push(`(Model for this spawn: ${opts.model} — set it on the Agent call.)`);
  }
  L.push('');
  return L.join('\n');
}

function main() {
  const opts = parseArgs(process.argv);
  requireFlag(opts, 'role', '--role');
  requireFlag(opts, 'phaseDir', '--phase-dir');
  requireFlag(opts, 'plan', '--plan');
  requireFlag(opts, 'charter', '--charter');
  // The verify->fix handoff is only mechanical if the fixer's scope is named:
  // --verdict is mandatory for a bug-fixer, so a fixer can never be spawned
  // without the verdict file it exists to fix.
  if (String(opts.role).toLowerCase() === 'bug-fixer') {
    requireFlag(opts, 'verdict', '--verdict');
  }

  const text = compose(opts);
  if (opts.out) {
    // #1182: a RELATIVE --out resolves against the phase dir (not cwd), so a bare basename lands in the
    // phase folder. An --out that escapes the phase dir is refused (fail loud, nothing written).
    const phaseAbs = path.resolve(opts.phaseDir);
    const outAbs = path.resolve(phaseAbs, opts.out);
    const rel = path.relative(phaseAbs, outAbs);
    if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      console.error(`Refusing --out: "${opts.out}" resolves to ${outAbs}, which is outside the phase dir ${phaseAbs}. ` +
        'Pass a path inside the phase folder (e.g. --out spawn-prompt-builder-r1.md or --out tmp/<file>), or omit --out for stdout.');
      process.exit(2);
    }
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, text);
    console.error(`Wrote spawn prompt to ${outAbs}`);
  } else {
    process.stdout.write(text);
  }
  process.exit(0);
}

if (require.main === module) main();

module.exports = { parseArgs, compose, identitySlug, profileFor, ROLE_PROFILES, NEUTRAL_PROFILE };
