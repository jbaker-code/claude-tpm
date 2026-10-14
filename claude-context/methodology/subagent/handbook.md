# Subagents Manual

**Subagent-specific operating rules** — what subagents are (and aren't) for, and the live-system-access policy summary. This is your manual: you are reading it because you were spawned as a subagent.

**The orchestrator-side mechanics of spawning and managing subagents are not a subagent's concern** — they live in the orchestrator's own handbook, which subagents do not read.

**Project layout, working folder, write boundary, scaffolder, and naming conventions** — folder-per-task, output-discipline, `questions.md`, naming — live in [`../project-workspace.md`](../project-workspace.md). Read it once and apply.

**Shared workflow conventions** — findings-doc format, resumption protocol, reading heuristics, onboarding ritual — live in [`../shared-conventions.md`](../shared-conventions.md). Verification conventions live in [`../verification.md`](../verification.md). Tools conventions live in [`../tool-conventions.md`](../tool-conventions.md). This manual cross-references rather than duplicates. **What your round must produce is defined by the Charter section of your `plan.md`** — these docs describe how, the charter defines what.

> **Your reading chain is [`reading-list.md`](./reading-list.md)** — the single source of truth for what a subagent reads, including the conditional blocks for resume / shipping / live-system / verifier spawns. It is complete; you need nothing outside it. the subagent-prompt lint (`tpm workflow lint`) derives its checks from that same file, so the documented chain and the enforced chain cannot drift.

---

## Step zero — always source your env, always dump your env file

Before anything else — before reading a single doc — every subagent runs the source + dump in ONE bash tool call, from the PROJECT ROOT:

```bash
cd "<ABSOLUTE_PROJECT_ROOT>" && \
  set -a && source "dev/<your-task>/tpm-tmp/subagent.env" && set +a && \
  env | sort > "dev/<your-task>/tpm-tmp/worker-env.md"
```

**Substitute `<your-task>`** with your actual task path (from your spawn prompt's "Working folder" line). The example above shows `dev/<your-task>/` — one real invocation might be `dev/tooling/tmptest1/`.

**The scratch folder name is configurable.** `tpm-tmp` is the default of `workflow.folders.tmp`; the composer emits the resolved name in your spawn prompt, so treat the `tpm-tmp/` paths in these docs as illustrative and use the one your prompt gives you.

**Dump filename by role:** workers write `tpm-tmp/worker-env.md`; verifiers write `tpm-tmp/verifier<N>-env.md` using the verifier number from their spawn prompt (e.g. `tpm-tmp/verifier5-env.md`). Both live in the task's `tpm-tmp/` — they are diagnostics, not findings, and **everything under the task's `tpm-tmp/` will be deleted and lost after the round is reviewed.**

**Two rules that trip subagents:**

1. **This MUST be a single Bash tool invocation.** Each Bash tool call spawns a fresh shell — env vars set in one call do NOT persist to the next. Chain with `&&` or `;`, keep it one call. Splitting produces an empty env dump and every subsequent tool call that reads env vars fails silently.

2. **Anchor to the project root, not your task folder.** Nearly every project script is written with project-root-relative paths. If your shell's CWD is `dev/<task>/`, invoking a root-relative tool returns exit 127 (not found). Options:
   - **Preferred:** `cd` to project root at the top of every bash tool call — it's cheap, uniform, and makes every tool invocation just work.
   - **Alternative:** always use absolute paths for tool invocations. More verbose but no `cd` needed. Pick one and stick with it inside a single tool call — mixing gets confusing.

The project root is `<ABSOLUTE_PROJECT_ROOT>` — run `pwd` in a Bash call to get the actual absolute path for your session; do not hardcode it.

**Why universally, even for tasks with no live system in scope:**

- `tpm-tmp/subagent.env` is the project's per-subagent env-setup mechanism. It's dropped by the scaffolder on every scaffold — even when no live system is provisioned, a stub file is present, so `source` is always safe.
- Sourcing FIRST means any project env vars are in scope by the time you touch a tool. Skipping the source because "my task doesn't use the live system" was a real failure mode: one of three parallel subagents read "no live system work" strictly and didn't source, producing a divergent env dump. This ritual removes that ambiguity: source unconditionally.
- Dumping `env` to `tpm-tmp/worker-env.md` (or `tpm-tmp/verifier<N>-env.md`) is a diagnostic artifact — the orchestrator (and future-you) can see exactly what env the subagent operated under. Trivial to write; invaluable when debugging "why didn't your tool call work?" or "why did you use the wrong endpoint?"

**When `tpm-tmp/subagent.env` is a stub** (no live-system flags at scaffold time): `source` still works, the env dump still lands, no project-specific vars appear. That's the expected state when your round doesn't need a live system; nothing is broken. If a subagent later needs live-system access, the orchestrator re-scaffolds with the project's live-system flags and the env file gets replaced.

---

## Detecting what changed — use the filesystem

To find out what changed under `dev/<your task>/` or anywhere else, use `find`, `ls`,
`wc -l`, or read files directly. Version-control state is not part of your working context.

---

## What subagents are for

A subagent is a sandboxed Claude instance with its own context window. The orchestrator delegates work to subagents when:

- **The work is parallelizable.** Multiple independent searches, multiple regions to scan, multiple findings to verify — fan out, reconcile at the end.
- **The work would blow up the orchestrator's context.** Reading 30 files to answer "where does X live" wastes the orchestrator's window if it just needs the final answer. A subagent reads everything and reports the conclusion.
- **The work needs deep focus on a specific task.** Investigating one mechanism doesn't need to share context with the rest of the session.

What subagents are **not** for:

- One-off lookups where the answer fits in the orchestrator's next tool call (use `Read` / `grep` directly).
- Anything that requires control of the live system under test UNLESS explicitly granted access (see [Live-system access — summary](#live-system-access--summary) below). A verifier uses whatever the round provides to *observe* the artifact, but never mutates or drives the state it verifies (see Live-system access below).
- Synthesis. The orchestrator does synthesis; subagents do the legwork. Never write "based on your findings, fix the bug" — write specific instructions the subagent executes.

---

## Working folder, scaffolder, write boundary

**Lifted to [`../project-workspace.md`](../project-workspace.md)** — that doc holds the canonical `dev/<task>/` layout, the scaffolder quickstart, the full subagent write-boundary table, and the `questions.md` format. Read it once and apply it.

Key things to know without re-reading:

- A subagent writes ONLY inside its assigned `dev/<task>/` folder. Sibling tasks, project `tools/`, project `output/`, and any live-system session dir that isn't your own are off-limits for writes. Reads are unrestricted everywhere.
- The orchestrator does NOT edit a subagent's folder while it's running, and does NOT silently rewrite a subagent's findings during reconciliation.
- `findings/questions.md` is where the subagent surfaces anything it can't resolve from materials it has — keeps the rest of the work moving.

---

## Live-system access — summary

**Access to a live system under test is per-project — this library ships no canonical live-system doc.** If your project has a live SUT, its operational reference is project-specific (a consumer supplement, or the project's own docs). The signal that you have access is a non-stub `tpm-tmp/subagent.env` in your task folder; the orchestrator provisions it.

Two rules hold regardless of project:

- **No real `tpm-tmp/subagent.env` = no live-system work.** If you need live data you can't get, write the verification step into `findings/questions.md`, mark the affected findings `STATUS: UNVERIFIED — pending live check`, and move on. Do not reach for live-system access you weren't granted.
- **Verification subagents exercise the artifact, but NEVER mutate or repair what they check.** Independence = render a *verdict*, not a repair (see [`../verification.md`](../verification.md)). A verifier actively drives the artifact with whatever tools/MCP the round provides to *observe* its real behaviour — but it never patches, rebuilds, or drives the *state it is verifying*: if it can manipulate the state it's checking, PASS becomes "PASS in a state I caused" and the audit trail collapses. If you find yourself wanting to *change* the thing under check rather than observe it, that's a builder/bug-fixer job, not a verifier's — record the gap in `findings/questions.md` and return a FAIL with the exact missing evidence.

---

## Definition of done — per-artifact checklist

Task-level definition-of-done comes from your `plan.md` (per the pre-task definition-of-done question). Beyond that, before you exit successfully, the following per-artifact conditions apply:

- **Findings written** — every load-bearing finding gets its own numbered doc in `findings/NN-<title>.md` (directly in `findings/`, no `docs/` subfolder — new convention 2026-07-07). If the task already has a `findings/docs/` folder from an earlier round, extending it there is fine — orchestrator picks. A finding must carry the specifics a future worker needs (locations, identifiers, annotated code, the method used) in the evidence format your findings-doc convention requires — not a TODO.
- **`findings/TLDR.md`** — narrative-style overview for the user (added 2026-07-10). Non-terse, written like you're explaining to a smart teammate who wasn't in the room. Cover: what you set out to do, headline result, what worked / didn't, what surprised you, and specifically **what the user needs to decide / advise / test / approve** before follow-up rounds can proceed. End with a "next steps" section framed as options they can pick from. Not a substitute for HANDOFF (signal-dense, for next Claude); TLDR is for the user and readable cold without opening any other file. Full spec in `plan-template.md` standing deliverable §1a.
- **Tools written + documented + reproducible CLI** — any script you add under `tools/` has a top-of-file docstring explaining purpose, inputs, outputs, example invocation. If it has a CLI, it takes arguments (no hardcoded paths). Add a row to `findings/tool-updates.md` per `shared-conventions.md`.
- **`findings/questions.md` present** — even if empty (a stub file with "No open questions" is fine). Its presence signals you finished the "did anything block me" pass. If you have open questions, they go here with enough detail that the orchestrator can act on them.
- **`findings/README.md` index updated** — one-line hooks per finding in the order they were written. Reader can scan the index and find what they need.
- **`findings/HANDOFF.md` written** if you stopped mid-task or your final output has known followup work — see `shared-conventions.md` "Resumption protocol." If you shipped everything, HANDOFF.md is optional; a final findings doc can carry that role.
- **Live-system artifacts to task folder** — if you had live-system access, any captured artifacts go into your task folder, NOT the session dir: deliverable bundles in `findings/captures/<name>/`, verifier-handoff bundles in `tpm-tmp/captures/<name>/`. See the live-system-access rules above.
- **Tool feedback logged if any friction hit** — per plan-template.md standing deliverable #5, log every complaint / wish / bug / workaround / dupe-sighting about project-level tools to `findings/tool-feedback.md`. Skip entirely if zero friction this task — no stub required. Low-ceremony sibling to `findings/tool-updates.md` (which stays required only when you actually fork a tool per the tool-modification rule).

Added 2026-07-01 during methodology-review reconciliation (item 9 of the 11 candidate additions).

## Cross-task references — link explicitly

When your work depends on OR overlaps with another task's findings, link explicitly in the new finding — full path from repo root, ideally with the specific doc name. Examples:

- `See dev/parser-core/findings/03-token-boundaries.md §"Collision categories" for the shared context.`
- `Depends on: dev/player-replacement/findings/docs/06-iter1-deadlock-root-cause.md — the Option-C reorder pattern used here.`

Why: audits + hygiene passes look for cross-task thread crossings. Without explicit links, when one task's finding gets superseded or moved, the depending task silently rots. Explicit links = greppable audit trail.

Added 2026-07-01 during methodology-review reconciliation (item 10 of the 11 candidate additions).

## Cross-references — workflow conventions

The following sections used to live in this manual but are now spread across the shared-workflow docs. They apply to subagents — read them as part of the step-zero chain.

**In [`../verification.md`](../verification.md)**:
- **Verification is mandatory** — for anything that isn't pure documentation.
- **Reproducibility checklist** — before marking any shipping artifact done.
- **Verifier ground rules** — on-disk-artifacts-only inspection + the PASS/FAIL-with-evidence format.
- **Decision logging — `findings/decisions.md`** — for "figure it out" mode.

**In [`../tool-conventions.md`](../tool-conventions.md)** (every worker/verifier):
- **The copy-then-modify pattern** — copy generalized tools into working-folder `tools/` before modifying; document in `findings/tool-updates.md`.
- **Ship your deliverables AS re-runnable tools** — every generated artifact needs a regeneration script.
- **No hardcoded paths or defaults** — project-wide directive.
- **Log tool feedback** — `findings/tool-feedback.md` for complaints/wishes/bugs/dupes/generalized-tool-ideas.

**In [`../shared-conventions.md`](../shared-conventions.md)**:
- **Findings-doc format** — a finding carries specifics (locations, identifiers, annotated code, method), not a TODO.
- **Resumption protocol — HANDOFF.md** — when resumption is happening.
- **Reading heuristics** — grep-and-skim vs full-read.
- **Onboarding ritual** — 5-bullet summary at first spawn.

**In [`../troubleshooting.md`](../troubleshooting.md)**:
- **When stuck or blocked** — static analysis, manual escalation, disaster recovery cross-refs.

---

## Reference

- [`../project-workspace.md`](../project-workspace.md) — `dev/<task>/` canonical layout, subagent write-boundary table, scaffolder quickstart, `questions.md` format, naming conventions.
- [`../shared-conventions.md`](../shared-conventions.md) — verification, tooling conventions, reading heuristics, onboarding ritual.
- [`../troubleshooting.md`](../troubleshooting.md) — what to try when stuck, disaster recovery.
- Agent tool documentation (model, isolation, background, prompts) — see the `Agent` tool description surfaced in each session's system context.
- `tools/README.md` — existing scripts subagents may reuse.
</content>
