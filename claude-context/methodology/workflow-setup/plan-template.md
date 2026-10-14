# Plan Template

<!-- ORCHESTRATOR NOTE — HOW TO USE THIS FILE (delete this whole block before the plan.md ships to a worker).
     This template is STRUCTURE only — it carries no charter and no posture (persistence / pivot / stopping /
     honesty / document lists all live in the per-role CHARTER FILE, not here). The charter is a SEPARATE FILE
     the scaffolder drops next to this plan.md and names in the round's spawn-prompt.md; do NOT paste a charter
     into this file and do NOT add a `## Charter` section.

     To use: copy this template into the target work folder as `plan.md`, fill every `{{PLACEHOLDER}}`, and
     delete the two delete-before-ship strip blocks (this one + `## Template maintenance notes` at the bottom)
     and any config-gated deliverable block whose flag is false. Then lint the finalized plan.md:
       tpm workflow lint --sentinels-only plan.md
     A surviving `{{PLACEHOLDER}}` or a leaked orchestrator-only block means you missed a step — the linter is
     the spell-check that makes grepping the template (instead of loading it whole) safe. The ⛔ charter guard
     is NOT a section here: the linter checks that the charter FILE the spawn-prompt names exists and is
     non-empty. -->

---

# Plan — {{TASK_TITLE}}

## Scope / motivation

{{MOTIVATION — 2-4 sentences: what this task exists to accomplish and why now. If it resumes prior work, cite the immediate parent context (e.g. "phase 02 shipped X but left Y open — this phase closes Y").}}

## Definition of Done

The acceptance criteria for this round, as a table of triples. Your charter tells you to **walk this table and
close every row** before reporting done — each row must be specific enough that you can point at a file and say
"this row is closed."

| Claim (what must be true) | Artifact (the file path that proves it) | Check (how it is verified) |
|---|---|---|
{{DOD — one row per acceptance criterion. Vague criteria ("the fix works") produce vague completions; name the concrete file and the concrete check for each.}}

## Task / method

{{TASK_METHOD — the actual method for THIS task: enough concrete steps that the worker can execute without back-and-forth. One task, one charter — if the work is genuinely multi-stage with different postures, that is an epic of separate phases, not one plan.}}

## Tools & MCP

Baseline: build a small tool in your `tools/` folder rather than doing repetitive work by hand (a searcher, a
differ, a decoder, an annotator — a 30-line script that codifies a pattern is worth writing). Tool conventions —
CLI shape, header docstring, no hardcoded paths, copy-then-modify when forking a project tool, and — for any
tool you intend to SHIP (promote, or leave as a durable re-runnable deliverable) — **tests (`tests/<tool>/`)
plus a `<tool>.md` reference doc** — are in the methodology `tool-conventions.md`; read it at first spawn.
(Scratch / probe / one-shot tools are exempt from tests + doc — header docstring only.) Log any tool friction
to `findings/tool-feedback.md`.

**If this round ships a tool, its `tests/<tool>/` and `<tool>.md` are DELIVERABLES** — list them in
Deliverables below and give each its own row in the Definition of Done. A ship-intended tool with no tests or
no doc is unfinished (the verifier fails the round), the same as a tool that doesn't run.

Task-specific tools / MCP servers for this round:

{{RELEVANT_TOOLS — the specific project tools, scripts, and MCP servers (emulators, browsers, runners, …) this task should use, each with a one-line "use it for X". "None beyond the baseline" is a valid answer.}}

## Context — folders to read

Read only what this list names — it is token-scoped on purpose. Standard anchors, plus this round's curated set:

- **This work folder** — your `plan.md` (this file), the charter file the spawn-prompt names, and `README.md`
  if present (context / recon for this phase).
- **`00-epic-plan/`** (if this task is part of an epic) — the epic plan, punchlist, and decisions log for
  lineage; read for orientation, do not modify.
- **Prior-phase folders** named below — for settled facts only. **Mine them for FACTS, not POSTURE** (your
  charter governs how; a sibling's survey voice is not your success bar).

{{RELEVANT_FOLDERS — the specific sibling / prior-phase paths this round should read, each with a one-line hook for why. Keep it tight: name what to read, not "read everything nearby".}}

## Deliverables

### Task-specific deliverables

{{DELIVERABLES — a bulleted list of the concrete files + paths this round MUST produce. Every item a specific file (e.g. `tools/foo` tool, `findings/01-xyz.md`), never vague ("some analysis"). Every shipped generated artifact must be regenerable from base inputs by a script in `tools/` — no manual steps.}}

### Standing deliverables — required on every task

These are the one home for the cross-round document set (they are not in the charter). Non-negotiable,
independent of the task-specific list above:

1. **`findings/HANDOFF.md`** — the terse, signal-dense handoff for the next Claude / orchestrator: what landed
   vs partial vs not-started, what a next round must NOT re-derive, concrete stuck points (identifiers, values,
   snippets — enough to resume cold), recommended next actions in priority order. A single rolling doc — the
   numbered per-round spawn-prompt / verdict artifacts are the history; HANDOFF is the current state.
2. **`findings/questions.md`** — present even if it only says "no open questions." Its presence signals you ran
   the did-anything-block-me pass; real blockers go here with enough detail for the orchestrator to act.

<!-- config-gated: workflow.deliverables.tldr — include this block only when the flag is true (default true) -->
3. **`findings/TLDR.md`** — the narrative overview for the user, readable cold without opening anything else:
   what you set out to do, the headline result first, what worked / didn't, what surprised you, and — most
   importantly — anything the user must decide, test, or approve before follow-up. End with next-step options
   the user can pick from.
<!-- end config-gated: workflow.deliverables.tldr -->

<!-- config-gated: workflow.deliverables.wiki — include this block only when the flag is true (research rounds; default true) -->
4. **`findings/wiki.md`** — the long-form durable writeup (research-charter rounds). Expected to be long; token
   cost is not a constraint on it. Explain from first principles, annotate the evidence, and make it the
   reference a future round reads instead of repeating your investigation.
<!-- end config-gated: workflow.deliverables.wiki -->

<!-- config-gated: workflow.deliverables.toolFeedback — include this block only when the flag is true (default true) -->
5. **`findings/tool-feedback.md`** — every complaint, wish, bug, workaround, and generalized-tool idea about
   project-level tools. Skip entirely if you had zero tool friction; otherwise bias toward logging.
<!-- end config-gated: workflow.deliverables.toolFeedback -->

**Durable vs disposable — `findings/` is saved, `tpm-tmp/` is deleted.** Everything under `findings/` is a git-saved
artifact this round is accountable for; **everything under `tpm-tmp/` WILL BE DELETED after review.** Put all
scratch, intermediates, and verification handoff material under `tpm-tmp/` (your env dump → `tpm-tmp/worker-env.md`);
never invent scratch homes inside `findings/`. If a `tpm-tmp/` file turns out to be load-bearing for a claim, move
it into `findings/` before you return — prose about deleted evidence is not evidence.

The scratch folder is named by `workflow.folders.tmp` (default `tpm-tmp`); the composer emits the resolved name in the spawn prompt, so `tpm-tmp/` here is the default, not a hardcoded contract.

## Constraints

- **Scope-boundary**: {{SCOPE_BOUNDARY — a task-specific warning if the surrounding project spans multiple targets / domains / codebases and other findings would mislead if applied here: name which findings do NOT apply to this target, and which sources to trust. Write "none — single target" if not relevant.}}
- **Do NOT modify sibling folders** — they are read-only reference for you.
- Follow the terse-communication default and the findings-doc format from the methodology `shared-conventions.md`.

## Time budget

**{{TIME_BUDGET}} wall-clock** — the container for this round, the maximum you may spend.

It is not a stopping rule. What counts as a legitimate ending is defined solely by your **charter** — re-read it
before you decide to stop.

## When done

Return a one-paragraph summary as your final response: {{FINAL_SUMMARY_SHAPE — the specific facts the summary must include, e.g. "which DoD rows closed, path to the shipping artifact, path to HANDOFF, and any critical caveat".}} That is what the orchestrator collates.

---

<!-- ORCHESTRATOR NOTE — TEMPLATE MAINTENANCE (delete this whole block before the plan.md ships to a worker).
     ## Template maintenance notes
     If you find yourself adding the SAME extra section to multiple plans that isn't in this template, that's a
     signal to extend the template rather than keep hand-adding it. Log candidate extensions for orchestrator
     review during periodic hygiene passes — e.g. a recurring per-model prompt-shape section, or a reusable
     writing-style slot. This block is structure-maintenance meta, not part of the shipped plan the worker
     reads — strip it (along with the how-to-use block at the top) when filling the plan. -->
