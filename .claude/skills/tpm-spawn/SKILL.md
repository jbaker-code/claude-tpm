---
name: tpm-spawn
description: Use when the orchestrator is about to spawn a SINGLE subagent via the Agent tool for a task in this project — a lone builder, researcher, verifier, planner, test-writer, documentarian, or bug-fixer. Forgiving role interpretation (normalize → intent-match → confidence-gate → echo) then the scaffold → compose → lint → Agent flow. For two or more roles with ordering/counts, use tpm-spawn-team. For a full round lifecycle, use tpm-workflow. Orchestrator-only — a subagent never invokes this (subagents don't spawn their own subagents).
---

> In this file, `%TPM_HOME%` is the claude-tpm **installation home** — it is NOT always
> `<project>/node_modules/@codercowboy/claude-tpm`. If you need its actual value, run `tpm resolve-home`.

`/tpm-spawn` fires **one** subagent. It owns *role* judgment (which role, resolved forgivingly) and
drives the standard spawn flow. It is judgment + routing only: the **charter owns posture**, the
**tools own mechanics**. Usable standalone (fire one worker without a full round) or as `tpm-workflow`
`run` mode's single-agent delegate.

Usage: `/tpm-spawn <role> [freeform task context]`. No/empty/malformed args → show this usage and stop.

## ⛔ HARD RULE — the USER directs the kickoff

**Never spawn without explicit user direction.** If there is any doubt the user said "go," echo and
ask ("ready to launch a <role> on X — confirm?") rather than inferring it. Spawning burns tokens and
does real work.

## Interpreting the role (forgiving)

Resolve the argument to ONE canonical role: **`planning`** · **`builder`** · **`test-writer`** ·
**`documentarian`** · **`verifier`** · **`bug-fixer`** · **`researcher`** (the seven TPM-shipped
personas; a child project may add its own on top).

1. **Normalize** — lower-case, collapse whitespace, strip punctuation.
2. **Intent-match, not exact-string** — map by meaning; obvious misspellings (`biulder`, `reseacher`,
   `verfier`) resolve normally.

   | Canonical | Also accept (case-insensitive, incl. obvious variants) |
   |---|---|
   | `planning` | planning, planner, plan, formalize the ask, survey + surface risks, plan proposal |
   | `builder` | builder, worker, work, working subagent, implementer, do the work, ship it, build |
   | `test-writer` | test-writer, test writer, write tests, add tests, tests, testing, test author, coverage, unit tests |
   | `documentarian` | documentarian, documenter, docs, doc, document, documentation, write docs, add docs, wiki, write-up |
   | `verifier` | verifier, verify, verification, checker, check, second opinion, review the artifact |
   | `bug-fixer` | bug-fixer, bug fixer, fixer, fix, fix the bug, fixup, patch, repair, address the findings, fix the verdict |
   | `researcher` | researcher, research, investigate, explore, look into, study, survey |

3. **Confidence gate** — resolve ONLY when confident. Empty / maps to nothing / genuinely ambiguous
   between two roles → do NOT guess; show the usage and name the ambiguity in one line. (Guard the
   near-neighbours: a bare `check` reads as `verifier`, but "fix what the check found" is a `bug-fixer`;
   "write the docs" is a `documentarian`, but "build the docs site" is a `builder`. When the phrasing
   genuinely straddles two, ask — don't pick.)
4. **Echo before acting** — `Reading "<arg>" as → role: <role>` so a mis-parse is a visible line to
   correct before anything spawns.

**On the `bug-fixer` role.** The bug-fixer is the **verify-loop fixer**: its job is to make the targeted
fixes a verifier's verdict called out (the orchestrator hands it that verdict's findings), not to build
fresh scope. `/tpm-spawn bug-fixer` is the correct front door for a **one-off manual fix** — you have a
verdict in hand and want a single fixer pass. The **automated verify↔bug-fixer loop** (spawn a fixer on a
kickback, re-verify, repeat up to `verifyLoopCap`) is orchestrator-owned and its wiring lives in
`tpm-workflow`'s `modes-verify` — NOT here. This skill only resolves the role and runs the one
spawn; it does not run or reason about the loop.

## The spawn flow — scaffold → compose → lint → Agent

Reference the tools by their promoted path (`%TPM_HOME%/tools/workflow/…`); a skill never bundles its own copy.

1. **Scaffold the folder** (if not already present) — `tpm workflow scaffold …`
   (`add-phase` for a new phase, `add-round --role <role>` to append a kickback round in an existing
   phase — the tool auto-numbers the phase `NN` / round `r<N>` and drops the skeleton: `plan.md`
   stub, `charter-<role>.md` copied from the resolved `charterFile`, `spawn-prompt-<role>-r<N>.md`,
   `findings/ tools/ tests/ tmp/`, and the per-subagent `tmp/<role>-r<N>[-v<M>]/` scratch folder).
   The role's charter + model come from the resolved config (`tpm workflow config`).
2. **Fill `plan.md`** — pure structure (DoD triple table · task/method · Tools & MCP · curated
   Context · deliverables · constraints · budget). No posture — that's the charter file.
3. **Compose the spawn prompt** — `tpm workflow compose --role <role>
   --phase-dir <dir> --plan plan.md --charter charter-<role>.md [--round N --model <m>
   --project-root "$(pwd)" --out spawn-prompt-<role>-r<N>.md]`. Emits the working-folder line, the
   read-order (charter THEN plan), the env-source ritual, constraints, and return shape — you supply
   only the one `{{TASK_CONTEXT}}` fill. `--out` is resolved against `--phase-dir` (not cwd): a bare name
   lands in the phase folder, and a path that escapes it is refused (exit 2).
4. **Lint BEFORE the Agent call** — `tpm workflow lint --file
   spawn-prompt-<role>-r<N>.md --require-charter --charter-dir <dir> [--verifier] [--resume]`. Exits
   0 = PASS, 1 = FAIL with a per-check missing-directive list. Do NOT spawn on a FAIL. The lint
   enforces the manifest reading chain, env ritual, working folder, charter-file-present, the sentinel
   taxonomy, and blocked filenames. **No `--manifest` needed** — it defaults to the ONE canonical
   manifest, the **live subagent reading-list** (`%TPM_HOME%/claude-context/methodology/subagent/reading-list.md`),
   which the tool SELF-LOCATES from its own bundle; it owns the base chain and the per-persona blocks
   (`--test-writer` / `--documentarian` / `--bug-fixer` gate their block in that same file). `--manifest`
   stays an OPTIONAL override for a consumer that wants a different one; if the manifest is found nowhere
   (a broken bundle) the lint FAILS LOUD (exit 2) rather than silently skipping. The orchestrator's
   round-machinery docs carry no duplicate of this chain.
5. **Spawn** — the `Agent` call, in the **background** (the orchestrator always backgrounds
   subagents), with the composed prompt and the resolved **model** on the `model` param.

**Resume:** if `findings/HANDOFF.md` exists in the target folder, tell the subagent to read it BEFORE
`plan.md`, note its "what NOT to redo" list is load-bearing, and lint with `--resume`.

**Verifier:** verifiers actively exercise the artifact with whatever tools/MCP the round provides and
render a **verdict — they do NOT repair or build what they check** (independence = verdict-not-repair, not a
tool ban); their verdict lands at `findings/verifier-r<N>-v<M>-verdict.md`. Lint with `--verifier`.

Do NOT freehand a spawn prompt, and do NOT skip directives because "the subagent will figure it out."
If the user says "spawn a worker w/ the manuals," that's redundant confirmation — the directives are
required by default on every Agent call, even when the phrasing is terse or the round feels small.
