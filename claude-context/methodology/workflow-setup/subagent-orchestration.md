# Subagent orchestration — the round machinery (spawn → verify → loop)

> ⚠️ **Orchestrator-only (charter-secret).** Describes the spawn pipeline, the verify↔bug-fixer loop, and retries.
> Never point a subagent at it — a verifier that learns the loop exists can slack ("someone will fix it").

## Only the orchestrator spawns

Every subagent is a **leaf** — no subagent spawns its own. A verifier's finding is an INPUT to an orchestrator
decision, never a self-executing order (the orchestrator must be free to disagree and record why). All spawn
authority funnels **orchestrator → and the orchestrator clears the kickoff with the user** (hard rule).

## The spawn pipeline (per subagent)

1. **`tpm workflow scaffold`** `add-phase` / `add-round` — creates the phase work folder: per-role
   `charter-<role>.md` (copied from its config `charterFile` home, orchestrator-note **stripped**), a
   `spawn-prompt-<role>-r<N>.md` stub, `tpm-tmp/<role>-r<N>/`, and a `subagent.env` stub. Uses `--team` (the roster)
   or `--charter <path>` (a specific charter).
2. **`tpm workflow compose`** — emit the standard prompt: env step-zero, role-conditional read-order +
   return-shape (a planner is told *don't build*; a verifier *verdict-not-repair*; a bug-fixer *fix the verdict's
   findings*), the base methodology chain, and the `{{TASK_CONTEXT}}` fill sentinel. `--verdict <path>` is
   mandatory for a bug-fixer (the mechanical verdict handoff).
3. **Fill** `{{TASK_CONTEXT}}` with this round's specifics.
4. **`tpm workflow lint`** `--file <prompt> [--verifier|--test-writer|--documentarian|--bug-fixer]` — the
   poka-yoke: rejects unfilled sentinels, placeholder charters, leaked orchestrator notes, missing base-chain/HARD-RULE
   reads, and a bad `--manifest`. No `--manifest` needed — it self-locates the canonical `claude-context/methodology/subagent/reading-list.md`; pass it only to override.
5. **Spawn** via the Agent tool with the role's `defaultModel` — in the background.

## The loop — delivery once, then verify ↔ bug-fixer

The team's **delivery agents** (builder / test-writer / documentarian, whichever the team has) each run **ONCE**,
in roster order. Then the **verifier** checks (worker→verifier is always a barrier). On the verdict:

- **PASS** → reconcile the phase; move on.
- **PASS-with-concern** → log the concerns; no kickback (concerns are not FAILs).
- **FAIL** → the orchestrator **judges** the verdict, **logs the call** in `00-epic-plan/decisions.md`, and — if a
  kickback is warranted — spawns a **bug-fixer** (the persona in config `verifier.loopFixer`, default `bug-fixer`),
  handing it the verdict via compose `--verdict`. The bug-fixer fixes **exactly** the verdict's findings, nothing
  beyond. Then **re-verify** (verifier r<N+1>). Repeat until PASS or the **`verifyLoopCap`** (default 5) is hit.

Only the verify↔bug-fixer pair repeats — never a fresh builder/test-writer/documentarian. The **verifier stays
blind** to the loop; it reports a verdict + concerns and stops.

## Retries — two mechanisms

- **Per-agent bail-retry** (`subagentConfigs[].retryCount`): if an agent bails without delivering (dies on an API
  error, exits with no artifact), re-spawn it in the SAME folder via `findings/HANDOFF.md`. Builder/bug-fixer get
  5; others 1. Retry is **orchestrator-judged**: a bail → retry; a broken plan → re-plan; a question → answer +
  retry; a genuine blocker → surface to the user.
- **Verify-loop cap** (`verifyLoopCap`, default 5): the cap on verify↔bug-fixer cycles above.

## Reconciling verdicts

After each round, update `00-epic-plan/punchlist.md` + `decisions.md`. Multiple verifiers (count > 1) work **blind
to each other** (`multiCountMode: blind-pair`); reconcile their independent verdicts yourself. A failed reconciliation
(verifiers disagree, or the cap is hit without PASS) is surfaced to the user, not force-shipped.

Authoritative model: this file plus `tpm workflow config --json` (the resolved persona / team / loop model).
