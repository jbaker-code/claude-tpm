# `tpm-workflow-lint-subagent-prompt.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Validate a subagent spawn prompt — and catch unresolved template sentinels — before a
subagent is spawned or a finalized plan/charter is handed to a worker. A poka-yoke: it
turns "I forgot a required read / left a placeholder / named a blocked file" into a loud,
pre-spawn FAIL instead of a silent runtime problem.

> Reference doc for the **hardened (v2) tool** at
> `dev/workflow-module-build/23-tighten-lint/tools/lint-subagent-prompt.js` — the
> phase-15 canonical lint plus the 5 fable-review tightening fixes (see
> "Tightening fixes (23)" below). Every command, flag, exit code, and example below was
> run against that file and observed to behave as shown.

---

## Purpose

Two jobs in one tool:

1. **Spawn-prompt lint (default mode).** Checks a *draft spawn prompt* for the pieces a
   subagent brief must carry: the step-zero reading chain (derived from the subagent
   reading-list **manifest**, so the enforced chain can't drift from the documented one),
   the env-source ritual, the project-root anchor, the working-folder mention, and — under
   `--verifier` — the HARD-RULE reminder.
2. **Sentinel lint (`--sentinels-only`).** Greps a *finalized* plan / charter / spawn
   prompt for template sentinels that must (or must not) still be present. This is what
   makes it safe for the orchestrator to grep a template rather than load it whole.

Folded in as structural guards: **charter-file-present** (a named `charter*.md` exists on
disk and is non-empty) and **blocked-filename** (a deliverable filename isn't
server-side-blocked), the latter via the sibling `check-filename.js`.

**Portability.** Node built-ins only, zero third-party deps. The one local dependency is
the sibling `check-filename.js` in the same suite folder — copy the whole folder and it
just works.

---

## Usage

```bash
# Full spawn-prompt lint (manifest chain + structural + sentinels):
tpm workflow lint --file draft-prompt.md
tpm workflow lint --file draft.md --manifest path/to/reading-list.md
tpm workflow lint --file draft.md --verifier --verbose

# Sentinel-only scan of a finalized plan / charter (no env ritual, no chain):
tpm workflow lint --file plan.md --sentinels-only --require charter

# Standalone blocked-filename guard (no body needed):
tpm workflow lint --sentinels-only --filename my-findings.md
```

The prompt body comes from `--file <path>`, or from a bare positional path (first non-flag
argument is treated as `--file`), or from stdin when something is piped in. With no `--file`
and a TTY stdin, the body is empty — which is exactly what the standalone `--filename` guard
wants.

---

## Flags

| Flag | Effect |
|---|---|
| `--file <path>` | Read the prompt/plan/charter from a file. Default: stdin if piped, else empty. |
| *(bare positional)* | First non-flag argument is treated as `--file` (matches the documented `lint … --sentinels-only plan.md` idiom). Only the first; extras are still errors. |
| `--sentinels-only` | Run ONLY the sentinel family (fill / strip / required / config-gated) + charter-file + blocked-filename. Skips the manifest doc-chain AND the env/working-folder structural checks. Use for a finalized plan/charter that is not itself a spawn prompt. |
| `--manifest <path>` | Explicit path to the subagent reading-list manifest (overrides discovery). An **explicit path that does not exist is a usage error → exit 2** (fail loud, never a silent skip). Only *discovery* (no `--manifest` given) may fall back to the SKIP-with-NOTE behavior. |
| `--require <name[,..]>` | A `<!-- required: <name> -->` marker that MUST be present in the body. Repeatable; comma-lists accepted. Absent → FAIL. **Note:** this is a *marker-presence* check, distinct from `--require-charter` below. |
| `--filename <name[,..]>` | A deliverable filename to run through the blocked-filename guard. Repeatable; comma-lists accepted. Blocked → FAIL. |
| `--require-charter` | Require the prompt to NAME a charter file (`charter*.md`) AND that file to exist + be non-empty. |
| `--charter-dir <path>` | Directory to resolve a named charter file against. Default: the directory of `--file`, else cwd. |
| `--config <path>` | A claude-tpm `config.json` for `--config-gate` cross-checks. |
| `--config-gate <dot.path>=<marker>` | The config boolean at `<dot.path>` must MATCH the presence of the literal `<marker>` in the body. Repeatable. Requires `--config`. |
| `--live-system` | Enable the live-system reading block (per-project). |
| `--verifier` | Enable verifier checks: the manifest `verifier` block reads + the HARD-RULE structural reminder. The reminder now keys off the **current independence doctrine** — `HARD RULE` present **and** a verdict-not-repair phrase (`verdict,` / `do not fix`/`repair`); the retired "never touch the live system" framing is **no longer accepted**. |
| `--shipping` | Enable the shipping-artifact-worker reading block. |
| `--resume` | Enable the HANDOFF.md read check. |
| `--test-writer` | Enable the manifest `test-writer` persona reading block. |
| `--documentarian` | Enable the manifest `documentarian` persona reading block. |
| `--bug-fixer` | Enable the manifest `bug-fixer` persona reading block **and** require the prompt to NAME the verdict it fixes (a `verifier-r<N>-v<M>-verdict.md`, or the `--verdict` path). The verify→fix handoff must be a named artifact, not freeform. |
| `--verdict <path>` | The verdict file a `--bug-fixer` prompt must reference (its basename or full path must appear in the body). Optional; without it the prompt must name a `*-verdict.md` file itself. |
| `--verbose` / `-v` | Print each check's rationale + doc pointer (on PASS, lists every check that ran). |
| `--help` / `-h` | Print the header docstring and exit 0. |

### The role flags are manifest-derived (important)

`--live-system`, `--verifier`, `--shipping`, `--resume`, `--test-writer`, `--documentarian`,
and `--bug-fixer` each enable the reads listed in the **correspondingly-named
`<!-- lint:begin <block> -->` block of the manifest**. If the manifest in play has no such
block, the flag adds no doc-chain checks — it becomes a no-op for those reads.

**Observed:** the current project manifest
(`claude-context/methodology/subagent/reading-list.md`) contains `base`, `working-folder`,
`resume`, `shipping`, `live-system`, `verifier`, and `consumer-optional` blocks, but **no
`test-writer` / `documentarian` / `bug-fixer` blocks**. So against the project manifest,
`--documentarian` enforces nothing extra (run 10a below: 13 checks with the flag, same as
without). The persona enforcement is exercised in the test suite against a *fixture* manifest
that does carry those blocks (run 10b below). The `--verifier` **HARD-RULE structural
reminder** is separate from any manifest block and always applies under `--verifier`.

---

## What each check catches

**Manifest doc-chain checks** (skipped under `--sentinels-only`; skipped with a NOTE if no
manifest is found) — one check per `.md` named in each applicable manifest block. The prompt
body must mention each doc (fuzzy stem match), e.g. `step-zero-project-workspace`,
`step-zero-handbook`, `plan-md-read`. `--verifier`/`--resume`/persona flags widen the set to
their blocks.

**Structural checks** (skipped under `--sentinels-only`):

- `env-source-ritual` — body mentions `source … subagent.env` / `set -a … source`.
- `env-source-project-root-anchor` — body anchors the `cd` to the project root.
- `working-folder-mentioned` — body contains a `dev/…` path.
- `verifier-hard-rule` — under `--verifier`, body contains `HARD RULE` **and** a verdict-not-repair phrase (`verdict,` / `do not fix`/`repair`). The retired "never touch the live system" wording no longer satisfies it.
- `bug-fixer-names-verdict` — under `--bug-fixer`, body names the verdict file it fixes (`verifier-r<N>-v<M>-verdict.md`, or the `--verdict` path).

**Location check** (applies in every mode, but only with `--file` and a `<!-- tpm-workflow-spawn phase="…" -->` marker in the body; otherwise skipped):

- `phase-location-matches-marker` — the linted file must sit in the folder its marker's `phase="…"` names. Catches a spawn prompt written to the wrong place (#1182). The marker path is resolved against cwd, so run from the project root.

**Sentinel checks** (always apply):

- `fill-sentinel` — no surviving `{{PLACEHOLDER}}` (names the offending placeholder).
- `strip-sentinel` — no surviving `<!-- ORCHESTRATOR NOTE … -->` block (a leak into a worker-facing file).
- `required-sentinel-<name>` — each `--require <name>` marker is present.
- `config-gate-<dot.path>` — the config flag and the marker's presence agree.

**Structural guards:**

- `charter-file-present` — if the body names a `charter*.md` (or `--require-charter` is set), that file exists on disk, is non-empty, **and is not a placeholder stub** (rejects a `{{CHARTER_BODY}}` fill-marker or a `# Charter — <role> (placeholder)` header — a worker spawned against a placeholder charter has no posture at all).
- `charter-no-strip-sentinel` — the named charter's **contents** carry no surviving `<!-- ORCHESTRATOR NOTE … -->` block, matched **case-insensitively**. A backstop for the scaffolder's case-*sensitive* `dropCharter` strip, which would otherwise let a natural lowercase `<!-- Orchestrator note … -->` leak verbatim into the worker-facing charter.
- `blocked-filename:<name>` — each `--filename` isn't server-side-blocked (report/summary/analysis/findings).

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | PASS — `PASS: prompt looks complete (<N> checks)`. |
| `1` | FAIL — `FAIL: <N> of <M> required directives missing`, then a per-check list (each failing sentinel prints the offending detail). |
| `2` | Bad CLI usage — unknown arg, a malformed `--config-gate` (not `<dot.path>=<marker>`), or an **explicit `--manifest <path>` that does not exist**. |

> The header docstring says "0 = PASS, 1 = FAIL, 2 = bad CLI usage" and the tool behaves
> exactly so (verified: `--bogus` → exit 2; a missing required marker → exit 1; a clean
> prompt → exit 0).

---

## Worked examples (each run, output pasted verbatim)

### 1. A clean draft passes the full lint

Given a draft prompt that reads the five base docs + `plan.md`, carries the env ritual +
project-root anchor + a `dev/…` path, and names `charter-builder.md` (present on disk):

```bash
tpm workflow lint --file clean-prompt.md \
  --manifest claude-context/methodology/subagent/reading-list.md \
  --charter-dir <dir-with-charter-builder.md> --verbose
```
```
PASS: prompt looks complete (13 checks)

  ok  step-zero-project-workspace              - Step-zero read: project-workspace.md
  ok  step-zero-shared-conventions             - Step-zero read: shared-conventions.md
  ok  step-zero-handbook                       - Step-zero read: handbook.md
  ok  step-zero-tool-conventions               - Step-zero read: tool-conventions.md
  ok  step-zero-troubleshooting                - Step-zero read: troubleshooting.md
  ok  plan-md-read                             - Working-folder read: plan.md
  ok  env-source-ritual                        - Env-source ritual (single-bash-call + cd to project root)
  ok  env-source-project-root-anchor           - Env-source cd-to-project-root anchor
  ok  working-folder-mentioned                 - Working folder path (dev/<task>/)
  ok  fill-sentinel                            - No surviving FILL sentinel ({{PLACEHOLDER}})
  ok  strip-sentinel                           - No surviving STRIP sentinel (<!-- ORCHESTRATOR NOTE ... -->)
  ok  charter-file-present                     - Named charter file exists, is non-empty, and is not a placeholder stub
  ok  charter-no-strip-sentinel                - Named charter carries no un-stripped orchestrator note (case-insensitive backstop)
```
Exit `0`. (One check more than the phase-15 cut: `charter-no-strip-sentinel`, added by fix #6
whenever the prompt names a charter.)

### 2. No manifest found → NOTE, and the sentinel/structural checks still run

Run from a directory with no `claude-context/…` and no `--manifest`:
```
NOTE: no subagent reading-list manifest found (looked for claude-context/methodology/subagent/reading-list.md, and --manifest was not given) - SKIPPING doc-chain checks. Structural + sentinel checks still run.
FAIL: 1 of 8 required directives missing:
  X  required-sentinel-charter
     REQUIRED sentinel present (<!-- required: charter -->)
     -> missing required marker <!-- required: charter -->
```
v2 no longer hard-exits on a *discovery miss* (no `--manifest` given, none found); it
degrades to the checks it can still run.

**But an EXPLICIT `--manifest` that doesn't exist fails LOUD (exit 2)** — a typo'd path
must never silently drop the entire doc-chain family:
```bash
tpm workflow lint --file draft.md --manifest reading-lst.md   # typo
```
```
lint-subagent-prompt: --manifest "reading-lst.md" does not exist (resolved: …/reading-lst.md). An explicit manifest path must exist; omit --manifest to fall back to discovery + the SKIP-with-NOTE behavior.
```
Exit `2`.

### 3. Sentinel scan catches a leftover placeholder and an un-stripped note

```bash
tpm workflow lint --file dirty.md --sentinels-only
```
where `dirty.md` contains `{{TASK_CONTEXT}}` and `<!-- ORCHESTRATOR NOTE: pick opus -->`:
```
FAIL: 2 of 2 required directives missing:
  X  fill-sentinel
     No surviving FILL sentinel ({{PLACEHOLDER}})
     -> surviving placeholder(s): {{TASK_CONTEXT}}
  X  strip-sentinel
     No surviving STRIP sentinel (<!-- ORCHESTRATOR NOTE ... -->)
     -> 1 un-stripped orchestrator-only block(s) leaked into a worker-facing file
```
Exit `1`.

### 4. Standalone blocked-filename guard

```bash
tpm workflow lint --sentinels-only --filename my-findings.md
```
```
FAIL: 1 of 3 required directives missing:
  X  blocked-filename:my-findings.md
     Deliverable filename not server-side-blocked (my-findings.md)
     -> "my-findings.md" contains blocked pattern "findings"
```
Exit `1`. A clean name (`--filename out.md`) exits `0`. (The 3 applicable checks with an
empty body are fill-sentinel, strip-sentinel, and the filename guard.)

### 5. A named-but-missing charter fails

```bash
tpm workflow lint --file names-missing-charter.md --sentinels-only --charter-dir <dir>
```
where the body names `charter-nope.md` (not on disk):
```
FAIL: 1 of 4 required directives missing:
  X  charter-file-present
     Named charter file exists, is non-empty, and is not a placeholder stub
     -> charter "charter-nope.md" missing or empty under <dir>
```
Exit `1`.

### 5b. A PLACEHOLDER charter fails (fix #1)

When the named charter is still the scaffolder stub — a `{{CHARTER_BODY}}` fill-marker
and/or a `# Charter — <role> (placeholder)` header — `charter-file-present` FAILs (the old
"exists + non-empty" check passed it, spawning a worker with no posture):
```
FAIL: 1 of 5 required directives missing:
  X  charter-file-present
     Named charter file exists, is non-empty, and is not a placeholder stub
     -> charter "charter-builder.md" is still a PLACEHOLDER stub (unfilled {{...}} fill-marker) — land the real charter before spawn
```
Exit `1`.

### 5c. A leaked orchestrator note in the charter fails, case-insensitively (fix #6)

When the named charter's contents still carry a `<!-- Orchestrator note … -->` block (any
case — the scaffolder's strip is case-*sensitive* and misses a lowercase one),
`charter-no-strip-sentinel` FAILs:
```
FAIL: 1 of 5 required directives missing:
  X  charter-no-strip-sentinel
     Named charter carries no un-stripped orchestrator note (case-insensitive backstop)
     -> charter "charter-leaky.md" has 1 un-stripped orchestrator note(s) (matched case-insensitively) — the scaffolder's case-sensitive strip missed it; it leaks orchestrator-only content to the worker
```
Exit `1`.

### 5d. A bug-fixer prompt that names no verdict fails (fix #4)

`--bug-fixer` requires the prompt to NAME the verdict it fixes (the verify→fix handoff must
be a named artifact). A prompt with no `*-verdict.md` reference (and no `--verdict` flag):
```
FAIL: 1 of 13 required directives missing:
  X  bug-fixer-names-verdict
     Bug-fixer prompt names the verifier verdict it must fix (--bug-fixer)
     -> --bug-fixer prompt must name the verdict file it fixes (verifier-r<N>-v<M>-verdict.md); the verify->fix handoff must be mechanical, not freeform
```
Exit `1`. Naming `verifier-r2-v1-verdict.md` (or supplying `--verdict <path>` whose basename
appears in the body) PASSes.

### 6. Config-gated drift

With `config.json` = `{ "workflow": { "deliverables": { "wiki": false } } }` and a body that
still contains the `<!-- wiki-deliverable -->` marker:
```bash
tpm workflow lint --file gated.md --sentinels-only \
  --config config.json --config-gate 'workflow.deliverables.wiki=<!-- wiki-deliverable -->'
```
```
FAIL: 1 of 3 required directives missing:
  X  config-gate-workflow.deliverables.wiki
     CONFIG-GATED sentinel matches config flag (workflow.deliverables.wiki)
     -> flag workflow.deliverables.wiki=false but marker present (should be stripped)
```
Exit `1`. With the flag false and the marker absent, it PASSes (exit `0`).

### 10a / 10b. Persona flag enforcement is manifest-driven

- **10a** — `--documentarian` against the **project** manifest (no documentarian block):
  `PASS: prompt looks complete (13 checks)` — identical to running without the flag, i.e. no
  extra reads enforced. (13, not 12, because the prompt names a charter → `charter-no-strip-sentinel`
  applies; this is the constant +1 fix #6 adds to any charter-naming prompt.)
- **10b** — `--documentarian` against a **fixture** manifest that DOES carry a
  `<!-- lint:begin documentarian -->` block listing `tool-conventions.md`, on a prompt that
  omits that read:
  ```
  FAIL: 1 of 10 required directives missing:
    X  documentarian-tool-conventions
       Step-zero read: tool-conventions.md
  ```
  Exit `1`. This is the anti-drift property: the enforced persona chain is exactly the
  manifest's block.

### 11. Verifier HARD-RULE reminder (fix #2 — current doctrine)

`--verifier` requires the body to carry the **current independence rule**: `HARD RULE`
present **and** a verdict-not-repair phrase (`verdict,` / `do not fix`/`repair`). A prompt
carrying only the **retired** "you must NEVER touch the live system under test" framing now
FAILs (the doctrine was resolved as "verdict, not repair" — a verifier actively drives the
artifact; the bar is "don't repair what you check"):
```
FAIL: 1 of 11 required directives missing:
  X  verifier-hard-rule
     Verifier HARD RULE reminder — independence is verdict-not-repair (--verifier)
```
Exit `1`. A prompt with e.g. `HARD RULE: you render a verdict; do not fix or repair what you
check.` PASSes. This structural check applies regardless of manifest content.
(Coordinates with phase 26, which fixes the doctrine in `verification.md` + `tpm-spawn`.)

---

## Tightening fixes (23)

The phase-23 cut hardens the phase-15 canonical lint against 5 gaps the fable review found:

| # | Gap | Now |
|---|---|---|
| 1 | a PLACEHOLDER charter (`{{CHARTER_BODY}}` / `(placeholder)` header) passed `charter-file-present` (exists + non-empty), spawning a worker with no posture | `charter-file-present` FAILs a placeholder stub |
| 6 | the scaffolder's `dropCharter` strip is case-*sensitive*; a lowercase `<!-- Orchestrator note … -->` leaked into the worker-facing charter with no backstop | new `charter-no-strip-sentinel` scans the charter's contents case-*insensitively* |
| 2 | `verifier-hard-rule` keyed off the retired `/NEVER.*touch.*live system/` framing | keys off the current doctrine: `HARD RULE` + a verdict-not-repair phrase (docPointer → `verification.md`) |
| 4 | a `--bug-fixer` prompt had no machine link to the verdict it fixes | new `bug-fixer-names-verdict` requires the prompt to name `verifier-r<N>-v<M>-verdict.md` (or the `--verdict` path) |
| 8 | an explicit `--manifest <missing>` failed OPEN (silently skipped the doc-chain, misreported "not given") | fails LOUD → exit 2 |

## Tests

Behaviour is covered by
`dev/workflow-module-build/23-tighten-lint/tests/lint-subagent-prompt/test.js`.
Run it:
```bash
node dev/workflow-module-build/23-tighten-lint/tests/lint-subagent-prompt/test.js
```
Observed: **56 passed, 0 failed** (exit 0). It keeps the phase-15 coverage (the manifest
chain + a mutation proving the chain is manifest-derived, each sentinel family, the
charter/filename guards, the config-gate, all three persona flags against a fixture
manifest) and adds negative-path coverage for all 5 tightening fixes above.

A companion **mutation check** proves each new guard is load-bearing — it neuters one guard
in a COPY of the tool and confirms the catch disappears (never touches the canonical tool):
```bash
node dev/workflow-module-build/23-tighten-lint/tests/lint-subagent-prompt/mutation-check.js
```
Observed: **15 passed, 0 failed** (exit 0) — 5 guards × (target-is-unique + baseline-catches
+ mutant-flips).

---

## See also

- `check-filename.js` (same suite) — the blocked-filename primitive this tool builds on.
- `compose-spawn-prompt.md` — the sibling composer; the two form a loop: compose emits a
  `{{TASK_CONTEXT}}` fill sentinel, and this lint flags it until the orchestrator fills it.
