# `tpm-workflow-compose-spawn-prompt.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Mechanically emit the standard subagent spawn-prompt boilerplate so the orchestrator supplies
only the one task-specific bit — a `{{TASK_CONTEXT}}` fill sentinel it fills in before
spawning. A token-saver and a consistency guard: every prompt gets the same working-folder
line, read-order (charter THEN plan), constraints block, and a **role-conditional** return-shape
without the orchestrator retyping them.

> Reference doc for the **canonical tool** at
> `dev/workflow-module-build/25-tighten-compose/tools/compose-spawn-prompt.js`. Every flag,
> exit code, and example below was run against that file and observed to behave as shown.

---

## Purpose

Emit a ready-to-fill spawn prompt with a fixed skeleton:

- a `You are a <ROLE> subagent` header (with an optional epic label);
- the working-folder line (write-boundary reminder);
- an optional **step-zero env-source ritual** (only when `--project-root` is given);
- the read-order — **charter first** (definition of done), **then plan**, then the curated
  context files the plan's "Context" section names (a **bug-fixer** gets the verdict file as
  read-order item 1 — see the role table);
- a `Task for this round:` line holding the single `{{TASK_CONTEXT}}` fill sentinel;
- the standing constraints block (write-only-here, zero deps, scratch folder, blocked names);
- a **role-conditional** read-order cue and return-shape (see the table below) — the charter
  file owns a role's full posture, but the cue and return-shape compose emits must MATCH it;
- an optional trailing model note.

The emitted `{{TASK_CONTEXT}}` is a **real FILL sentinel**: run the output back through
`lint-subagent-prompt.js --sentinels-only` and it FLAGs the unfilled placeholder until the
orchestrator fills it. That is the intended poka-yoke loop between the two tools.

**Portability.** Node built-ins only, zero third-party deps.

---

## Session attribution (the `tpm-session` comment)

Right after the `<!-- tpm-workflow-spawn … -->` marker, compose emits a SEPARATE comment naming the tpm session that composed
the prompt (never an attribute of the marker itself, whose format the doctor and the spawn gate match strictly):

```
You are a BUILDER subagent.
<!-- tpm-workflow-spawn phase="dev/e/01-x" role="builder" -->
<!-- tpm-session session="session-0012b" via="lookup" -->
```

Resolution is the shared resolver's order: `--session`/`--track` flag (`via="flag"`), then `TPM_SESSION_ID` (`"env"`), then a
lookup of `CLAUDE_CODE_SESSION_ID` against the session tracks (`TPM_SESSIONS_DIR` or the project's sessions folder; `"lookup"`),
then blank. When nothing resolves the comment line is omitted entirely, and a failure to resolve never blocks the compose.
`--session 12 --track c` gives `<!-- tpm-session session="session-0012c" via="flag" -->`; a malformed or disagreeing flag
(`--session zz`) exits `2`. Verified by composing against a scratch sessions folder with a fake Claude id.

## Role-conditional posture (read-order cue + return-shape)

`compose` keys both the read-order line-1 cue AND the return-shape off `--role`, so a composed
prompt never carries charter A next to a return-shape from charter B. (Before this fix, compose
was role-blind: it injected the **builder** cue — *"don't stop until every row is true"* — and the
**builder** return-shape — *"the built artifact + passing checks"* — into every non-verifier role,
contradicting a planner's or researcher's charter, and even a verifier's read-order.)

| `--role` | Read-order cue (line 1) | Return-shape |
|---|---|---|
| `builder` | deliver the artifact; walk the DoD, don't stop until every row is true | the built artifact + passing checks + `HANDOFF.md` |
| `test-writer` | deliver the artifact's TESTS; don't stop until the suite would go **red** when the artifact breaks | the test suite + green-run **and mutation-check** evidence + `HANDOFF.md` |
| `documentarian` | deliver the DOCS; every claim is one you ran and watched come true | the documentation, every claim **verified against the running artifact** + `HANDOFF.md` |
| `verifier` | report a **VERDICT, not a repair**; adversarially attack each DoD claim (+ an explicit **HARD RULE** line) | the `findings/<slug>-verdict.md` verdict file (per-row PASS/FAIL) — **not** an artifact |
| `planning` | **do NOT build**; deliver a plan proposal + risk map | a plan proposal + risk map to `findings/` — **not** a built artifact |
| `researcher` | **do NOT build**; deliver knowledge | your findings to `findings/` (knowledge) — **not** a built artifact |
| `bug-fixer` | **the verdict file is read-order item 1** (via `--verdict`); fix exactly its findings, nothing beyond | the targeted fixes + re-run evidence each finding is closed; touch nothing beyond the findings; APPEND a `## Bug-fixer r<N>` section to `findings/HANDOFF.md` (never overwrite it) |
| *(any other role)* | neutral: *"the charter is authoritative; do exactly what it defines"* | *"whatever your charter and the plan's Deliverables define"* — never the builder default |

A consumer-added role (`--role wizard`) falls through to the **neutral** row: it is never
silently told to "ship the built artifact", because compose does not know its posture — the
charter does.

### The verifier's HARD RULE line

A composed `--role verifier` prompt now carries an explicit independence line —
*"HARD RULE — you report a VERDICT, you do not repair: never fix or build the artifact you are
verifying…"*. This is verdict-not-repair (the current doctrine — exercising the artifact with
live tools is REQUIRED, only repairing it is banned), and it makes a composed verifier prompt
**pass** `lint-subagent-prompt.js --file … --verifier` (the `verifier-hard-rule` check). Before
this round a composed verifier prompt FAILed that check.

---

## Usage

```bash
tpm workflow compose --role builder \
  --phase-dir 'dev/epic/02b-lint-compose' \
  --plan plan.md --charter charter-builder.md

# bug-fixer: --verdict is REQUIRED and becomes read-order item 1:
tpm workflow compose --role bug-fixer --phase-dir <p> \
  --plan plan.md --charter charter-bug-fixer.md \
  --verdict findings/verifier-r1-v1-verdict.md

# with optional round/model/env-ritual + write to a file:
tpm workflow compose --role verifier --phase-dir <p> \
  --plan plan.md --charter charter-verifier.md --round 1 --variant 2 \
  --model opus --project-root '/abs/repo/root' --out spawn-prompt-verifier-r1-v2.md
```

The four required flags have no defaults — omit one and it fails loudly with exit `2` (and
`--verdict` is a fifth required flag *when* `--role bug-fixer`).

---

## Flags

| Flag | Required | Effect |
|---|---|---|
| `--role <name>` | ✅ | Free-text role: `builder` \| `verifier` \| `researcher` \| … Uppercased in the header; lowercased for the return-shape branch + scratch slug. |
| `--phase-dir <path>` | ✅ | The subagent's working folder (write boundary). Printed verbatim in the working-folder line; also the base of the env-ritual paths. |
| `--plan <file>` | ✅ | Plan filename inside the phase dir (e.g. `plan.md`). |
| `--charter <file>` | ✅ | Charter filename inside the phase dir. |
| `--verdict <path>` | ✅ for `--role bug-fixer` | The verifier verdict file the fixer's scope IS. It becomes **read-order item 1** (*"the findings you fix are EXACTLY these"*), making the verify→fix handoff a named artifact instead of freeform `{{TASK_CONTEXT}}` prose. **Mandatory** when `--role bug-fixer` (omitting it → exit 2); ignored for other roles. |
| `--session <ref>` / `--track <letter>` | | Stamp this tpm session in the `tpm-session` comment instead of resolving one (see "Session attribution"). `0012`, `0012b`, `12b`, `session-0012b`; malformed or disagreeing exits `2`. |
| `--round <N>` | | Round number → `r<N>` in the identity slug (scratch folder + verifier verdict filename). |
| `--variant <M>` | | Verifier variant → `v<M>`; only meaningful alongside `--round`. |
| `--model <name>` | | Named in a trailing `(Model for this spawn: … )` note. The Agent call still sets it. |
| `--epic <label>` | | Epic/lineage label appended to the header (`… subagent of the <label>`). |
| `--project-root <p>` | | If given, emits the step-zero env-source ritual with the task folder derived from `--phase-dir`. |
| `--out <path>` | | Write to a file instead of stdout (a `Wrote spawn prompt to <absolute path>` line goes to **stderr**). A relative path is resolved against `--phase-dir`, not cwd: a bare name lands in the phase folder, `tmp/x.md` under it. A path that resolves outside the phase dir (absolute, `..` escape, or the phase dir itself) is refused: exit `2`, nothing written. Missing parent dirs are created. |
| `--help` / `-h` | | Print the header docstring, exit 0. |

### The identity slug

`<role>-r<N>[-v<M>]`, falling back to `<role>` when no round is given. It drives the scratch
folder (`tpm-tmp/<slug>/`) and, for a verifier, the verdict filename
(`findings/<slug>-verdict.md`). Verified: `--role verifier --round 1 --variant 2` →
`tpm-tmp/verifier-r1-v2/` and `findings/verifier-r1-v2-verdict.md`.

**The scratch folder name is configurable (#1183).** `tpm-tmp` is the default of `workflow.folders.tmp` (see `docs/config-guide.md` §2). The composer reads that key from the project config at `--project-root` and uses it in both places it names the scratch folder: the step-zero `source '<phase>/<tmp>/subagent.env'` line and the Constraints `scratch → <tmp>/<slug>/` line. With `{"workflow":{"folders":{"tmp":"scratchy"}}}` in `<root>/.claude/claude-tpm/config.json`, both read `scratchy`. A missing or malformed config falls back to `tpm-tmp`; it never errors. The step-zero paths stay single-quoted (they can contain spaces).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success — prompt written to stdout (or `--out`). |
| `2` | Usage error — a missing required flag, or an unknown argument. |

Verified: missing `--charter` → `Missing required flag --charter. Run --help for usage.`
(exit 2); `--bogus` → `Unknown arg: --bogus` (exit 2); `--role bug-fixer` without `--verdict`
→ `Missing required flag --verdict. Run --help for usage.` (exit 2).

---

## Worked examples (each run, output pasted verbatim)

### Minimal builder → stdout

```bash
tpm workflow compose --role builder \
  --phase-dir 'dev/epic/01-thing' --plan plan.md --charter charter-builder.md
```
```
You are a BUILDER subagent.

Working folder (write ONLY inside here; quote paths — they contain spaces):
`dev/epic/01-thing`

Read, in order:
1. Your charter: `charter-builder.md` — your posture / definition of done — deliver the artifact; walk the plan's Definition-of-Done table and don't stop until every row is true.
2. Your plan: `plan.md` — the task, the Definition of Done, the specs, the constraints.
3. The curated context files the plan's "Context" section names.

Task for this round:
{{TASK_CONTEXT}}

Constraints: write ONLY inside the working folder above; zero external deps; portable `node <file>`; scratch → `tpm-tmp/builder/`; never name a file report/summary/analysis/findings (server-side blocked).

Return-shape: your deliverable = the built artifact + its passing checks on disk, plus `findings/HANDOFF.md`. Return a one-paragraph summary: what landed, the exact commands you ran + their results, the `findings/HANDOFF.md` path, and any caveat.
```
Exit `0`.

### Bug-fixer → the verdict is read-order item 1 (mechanical handoff)

```bash
tpm workflow compose --role bug-fixer \
  --phase-dir 'dev/epic/01-thing' --plan plan.md --charter charter-bug-fixer.md \
  --verdict findings/verifier-r1-v1-verdict.md
```
```
You are a BUG-FIXER subagent.

Working folder (write ONLY inside here; quote paths — they contain spaces):
`dev/epic/01-thing`

Read, in order:
1. The verifier's verdict: `findings/verifier-r1-v1-verdict.md` — the findings you fix are EXACTLY these; every one, and nothing beyond them.
2. Your charter: `charter-bug-fixer.md` — your posture / definition of done — fix exactly the verdict's findings, every one and nothing beyond them.
3. Your plan: `plan.md` — the task, the Definition of Done, the specs, the constraints.
4. The curated context files the plan's "Context" section names.

Task for this round:
{{TASK_CONTEXT}}

Constraints: write ONLY inside the working folder above; zero external deps; portable `node <file>`; scratch → `tpm-tmp/bug-fixer/`; never name a file report/summary/analysis/findings (server-side blocked).

Return-shape: your deliverable = the targeted fixes on the real artifact + re-run evidence that each verdict finding is closed, on disk, plus `findings/HANDOFF.md`. Touch nothing beyond the verdict's findings. `findings/HANDOFF.md` already holds the prior agents' content: ADD your own section headed `## Bug-fixer r<N>` at the END of it and leave everything above untouched - never overwrite or rewrite the existing HANDOFF (if none exists yet, create it). Return a one-paragraph summary: each finding and how you closed it, the exact commands you ran + their results, the `findings/HANDOFF.md` path, and any caveat.
```
Exit `0`. Omit `--verdict` here and it fails loudly: `Missing required flag --verdict.`
(exit `2`) — the verify→fix handoff can't ship without the verdict named.

### Verifier with round/variant/model/epic/project-root → `--out` file

```bash
tpm workflow compose --role verifier --phase-dir 'dev/epic/01-thing' \
  --plan plan.md --charter charter-verifier.md --round 1 --variant 2 \
  --model opus --epic 'demo epic' --project-root '/abs/root' --out composed-verifier.md
```
stderr: `Wrote spawn prompt to /abs/root/dev/epic/01-thing/composed-verifier.md` (the bare `--out` name resolved into the phase folder). The file contains the header
`You are a VERIFIER subagent of the demo epic.`, the env-source ritual block anchored at
`cd '/abs/root'`, the `tpm-tmp/verifier-r1-v2/` scratch folder, the verifier return-shape
(`your verdict to \`findings/verifier-r1-v2-verdict.md\` …`), and the trailing
`(Model for this spawn: opus — set it on the Agent call.)`.

### The poka-yoke round-trip with the linter

```bash
tpm workflow compose --role builder --phase-dir 'dev/epic/01-thing' \
  --plan plan.md --charter charter-builder.md --out composed-raw.md
tpm workflow lint --file dev/epic/01-thing/composed-raw.md --sentinels-only
```
```
FAIL: 1 of 5 required directives missing:
  X  fill-sentinel
     No surviving FILL sentinel ({{PLACEHOLDER}})
     -> surviving placeholder(s): {{TASK_CONTEXT}}
```
Exit `1` — the composer's own placeholder is flagged. Replace `{{TASK_CONTEXT}}` with real
task text and the same sentinel scan returns `PASS: prompt looks complete (3 checks)`
(exit 0). That is the two tools working as designed.

---

## Known behaviour — the base-chain seam (current, documented; NOT a bug to fix here)

`compose-spawn-prompt.js` emits **only** the read-order lines `charter → plan → "the curated
context files the plan's Context section names"`. It does **not** itself name the base
methodology reading chain (`project-workspace.md`, `shared-conventions.md`, `handbook.md`,
`tool-conventions.md`, `troubleshooting.md`), and the env-source ritual appears only when
`--project-root` is passed. Those base reads are expected to arrive through the
`{{TASK_CONTEXT}}` fill (or via the spawning skill), not from the composer.

**Consequence — run-verified.** A freshly-composed prompt, filled and then run through the
**full** manifest lint against the project manifest, FAILs the base-chain doc-read checks:

```bash
# composed WITHOUT --project-root, {{TASK_CONTEXT}} filled with plain task text:
tpm workflow lint --file composed-filled.md \
  --manifest claude-context/methodology/subagent/reading-list.md --charter-dir <dir>
```
```
FAIL: 7 of 12 required directives missing:
  X  step-zero-project-workspace
  X  step-zero-shared-conventions
  X  step-zero-handbook
  X  step-zero-tool-conventions
  X  step-zero-troubleshooting
  X  env-source-ritual
  X  env-source-project-root-anchor
```

Composing **with** `--project-root` satisfies the two env-source checks, but the **five
base-chain reads still FAIL** (`FAIL: 5 of 12` — the `step-zero-*` doc reads), because the
composer never names those docs:

```
FAIL: 5 of 12 required directives missing:
  X  step-zero-project-workspace
  X  step-zero-shared-conventions
  X  step-zero-handbook
  X  step-zero-tool-conventions
  X  step-zero-troubleshooting
```

This is a **deliberately-logged, non-blocking seam** (epic `00-epic-plan/decisions.md`,
Phase-06 promotion note #2: "compose-spawn-prompt omits the `shared-conventions.md`
base-chain read → a freshly-composed prompt fails the manifest lint's
`step-zero-shared-conventions` until the `{{TASK_CONTEXT}}` fill names it. Minor seam; small
fix at promotion."). It is documented here as current behaviour and **is not changed by this
round.** The practical upshot: the base reading chain must be supplied through the
`{{TASK_CONTEXT}}` fill (the spawn-subagent skill is what composes both together); the linter
is the backstop that catches a compose-only prompt before it ships.

---

## Tests

Behaviour is covered by
`dev/workflow-module-build/25-tighten-compose/tests/compose.test.js`. Run it:
```bash
node dev/workflow-module-build/25-tighten-compose/tests/compose.test.js
```
Observed: **48 passed, 0 failed** (exit 0). Beyond the original coverage (role header,
working-folder line, charter-before-plan read-order, constraints block, the `{{TASK_CONTEXT}}`
sentinel, the identity-slug scratch folder, the env-source ritual under `--project-root`, the
missing-required-flag exit 2 cases, and the linter round-trip), the extended suite exercises
**every role's** read-order cue + return-shape (builder / test-writer / documentarian /
verifier / planning / researcher / bug-fixer / unknown), asserts planners/researchers/verifiers
do **not** carry the builder "built artifact" return, verifies `--verdict` (bug-fixer names it as
read-order item 1, is mandatory → exit 2 without it, and is ignored for other roles), confirms a
composed verifier prompt **passes** the lint's `verifier-hard-rule`, and runs a **mutation-check**:
reverting `profileFor()` to role-blindness (always the builder profile — the exact bug this round
fixed) makes the role-distinctness guards go **red** (21 failures), and restoring returns 48/0.

---

## See also

- `lint-subagent-prompt.md` — the sibling linter; it flags this tool's `{{TASK_CONTEXT}}`
  sentinel and is the backstop for the base-chain seam above.
