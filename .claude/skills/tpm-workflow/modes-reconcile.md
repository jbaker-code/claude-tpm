# `reconcile` mode — per-phase reconcile → `00-epic-plan/` update → epic-close

> In this file, `%TPM_HOME%` is the claude-tpm **installation home** — it is NOT always
> `<project>/node_modules/@codercowboy/claude-tpm`. If you need its actual value, run `tpm resolve-home`.

Two scopes: the **per-phase reconcile** (after each phase's verify settles — the natural
auto-checkpoint) and the **epic-close ritual** (the one user-gated hand-back at the end of the train).
**NOTHING promotes mid-epic** — promotion happens only at epic-close.

## Per-phase reconcile (auto-checkpoint)

After a phase reaches a verified PASS (or accepted partial-with-gap):
0. **Judge the verdict + record the call.** Each verifier verdict is an INPUT, not a self-executing
   order: the orchestrator **judges** it, **records the decision** in `00-epic-plan/decisions.md`
   (tagged "raise to user" when made autonomously), and **decides whether a bug-fixer kickback
   happens** — a FAIL that warrants a fix loops back through `verify` mode's verify↔bug-fixer loop
   (spawning the `verifier.loopFixer` persona, never a fresh delivery agent); a FAIL the orchestrator
   overrides, or a clean PASS, records the reasoning and advances. This judge→log→kickback step is the
   hinge between `verify` and reconcile.
1. **Confirm the phase HANDOFF** is current — `findings/HANDOFF.md` is the single rolling doc: what
   landed · what's partial · what's blocked/open · what NOT to redo (load-bearing) · recommended
   next actions. If resuming, overwrite it in place (never `HANDOFF-v2.md`).
2. **Write the cost row** for each subagent from the harness completion notification (a subagent
   can't introspect its own cumulative tokens — orchestrator-written):
   `tpm workflow cost --epic-path dev/<epic> --agent <id> --role <role>
   --model <m> --tokens <n> --calls <n> --verdict <v> --round <N>`. In an epic the ledger lives at
   `00-epic-plan/cost-ledger.md`; a flat round keeps `tpm-tmp/cost-ledger.md`.
3. **Update `00-epic-plan/`** — log the decision in `decisions.md` (tag "raise to user" for
   autonomously-made calls), update `punchlist.md` (done / pending / cut), adjust the phase map if
   scope expanded (append-only — a new need is a new numbered phase). `00-epic-plan/` is
   orchestrator-write-only and must stay **charter-clean** (no posture leak to the subagents who read it).
4. **Advance** per the phase map + parallelism (respecting stage barriers), or hold at a
   user-set breakpoint.

Within an epic, a later phase that needs an earlier phase's tool **copies it** into its own `%TPM_HOME%/tools/`
(noting lineage) — it does NOT promote. The train never stops mid-run for a promotion.

## Epic-close ritual (user-gated)

Runs when the deliverable ships AND every `punchlist.md` item is done OR explicitly deferred
(partial-deferral is allowed — a lingering hard item becomes the next epic, it does not block close).
**Detect + propose — never auto-close.** Then, on the user's go:

1. **Promotion review** — the ONLY place promotions happen (task-folder artifact → project root):
   - **Planned deliverables auto-promote** per the plan.
   - **Unplanned artifacts** (a verifier's bonus tool, an unplanned helper) → **confirm with the
     user** before promoting.
   - Apply the promotion criteria + **move-and-breadcrumb** to project-level `%TPM_HOME%/tools/` (leave a
     breadcrumb at the old path). Reusable verifier/ builder tools flagged for promotion are graded
     here; one-off probes stay in `tmp/`.
   - Cross-epic: outputs another epic depends on are promoted **before** that epic starts.
2. **Decision review** — surface the `00-epic-plan/decisions.md` "raise to user" queue.
3. **Cost rollup** — `tpm workflow cost --rollup dev/<epic> --summary` for the
   epic-level cost provenance reviewed at close (what the epic cost, per subagent).
4. **Structure audit** — `tpm workflow audit --out <tmp>/audit.md` to confirm numbering
   integrity, one-plan-one-charter per phase, and `00-epic-plan/` charter-cleanliness before sealing.
5. **Update project state** — the **task queue** (mark the epic done + log deferred gaps as follow-on
   tasks/epics), **project-history**, and **`%TPM_HOME%/tools/README`** (any promoted tools). **NOT `CLAUDE.md`**
   — it stays frozen (always-injected canon; it points at manifests, doesn't hold status). A
   standing-convention change is a rare, separately user-approved edit, never a routine close step.
6. **Seal `00-epic-plan/`** — mark complete; the epic records go immutable (like sealed session notes).
7. **Archive** — the sealed epic stays in `dev/` marked SEALED; a periodic hygiene sweep archives
   old sealed epics. `tpm-tmp/` scratch is NOT swept at close (that's a hygiene step); the per-phase
   `tpm-tmp/unreviewed.md` markers clear once the user reviews.

## Reconcile is where the `write-handoff` job lives

Every phase ends with a current `findings/HANDOFF.md` (terse, for the next Claude) — and, when the
config gates them on (`deliverables.tldr`), a narrative `TLDR.md` for the user. Both are standing
deliverables and are **not interchangeable**. Even a fully-complete phase writes a brief HANDOFF
("everything landed, see <deliverable>") so the next worker knows no pickup is needed.
