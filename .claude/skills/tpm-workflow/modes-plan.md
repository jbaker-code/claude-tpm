# `plan` mode — pre-task Q&A → charter → scaffold → plan.md → compose + lint

> In this file, `%TPM_HOME%` is the claude-tpm **installation home** — it is NOT always
> `<project>/node_modules/@codercowboy/claude-tpm`. If you need its actual value, run `tpm resolve-home`.

**Do NOT freehand a `plan.md`.** The template + tools exist for exactly this. Plan mode drives the
real pipeline: **pre-task questions → resolve config → scaffold → fill `plan.md` → compose → lint —
BEFORE any spawn.** Present the plan for review, then hand off to `run` mode.

## 1. Resolve config first (the raw defaults)

```
tpm workflow config --json
```

This hands you the RESOLVED picture — the **7 personas** (`subagentConfigs[]`: `planning` · `builder`
· `test-writer` · `documentarian` · `verifier` · `bug-fixer` · `researcher`), each with its
`defaultModel` + `retryCount`; the charter file each role maps to (`charterFile` + `charterVariants`);
the **6 teams** (`teams[]`: `full` / `ship` / `test` / `docs` / `research` / `build` — **array order IS
run order**); `defaultParallelism`; `verifyLoopCap`; `verifier.loopFixer`; `deliverables.{tldr,toolFeedback,wiki}`;
and the plan-template path. Config parsing is **mechanics** — let the resolver do it; you supply judgment.

## 2. Pre-task presentation — the roster + 3 big rocks + one advanced line

Batch the pre-task message as **3 big rocks + ONE collapsed advanced line** — never a wall of
equal-weight questions. `-v`/`--verbose` expands the advanced set to full questions.

**The 3 big rocks, in THIS order:**
1. **Roster + sequencing** — the team as a roster (below).
2. **Definition of "done"** — acceptance, drafted as the triple table (Claim · Artifact · Check).
3. **Paths** — confirm inputs/outputs (a wrong input path silently wastes a whole round).

**Advanced — collapsed to ONE line by default (`-v` asks in full):**
Time budget (default 2h) · Models (defaults from config) · Scope (default: task-folder) ·
Retry counts (config: builder 5 · bug-fixer 5 · verify-loop cap 5 · everyone-else 1).

### The roster (big rock ①) — one subagent per line, in run order

Pick the team once; that single choice **cascades the whole roster + order + loop** — the resolver
expands the team's `subagents[]` (array order = run order) into per-line entries. Present it as:

- **One subagent per line, in run order:** `role · charter: <name> · <model>` (+ a per-role note — an
  opt-down, a count). The roster reads top-to-bottom as the pipeline. Models come from
  `subagentConfigs[].defaultModel`; retries from `retryCount`.
- **The charter is shown ON the roster, not asked as a separate big rock.** Each role's charter is
  **fixed** (resolved from config; `charterVariants` is empty) and just displayed on its line — there
  is no live per-round charter menu. The builder's line shows its charter (`shipping`, the default and
  only shipped builder charter); a weaker "mvp" bar is not a roster opt-down but an ad-hoc `--charter`
  override (see §3). The question set shrinks to fit the team ("more personas, not more questions").
- **The verify↔bug-fixer loop is a sub-line** under the roster, marked *"on FAIL only"*
  (`bug-fixer · <model> · cap <verifyLoopCap>`) — visible but off the happy path. Delivery agents each
  run ONCE, in roster order; the ONLY thing that repeats is verify↔bug-fixer.
- **Every default is shown explicitly** (models, time, scope, retries) and **a default is NEVER a
  mutation** — accepting runs the team **AS CONFIGURED** (shipping stays shipping; the team runs as-is).
  The header states this.
- **Accept phrase = `all defaults`.** Any override is named (e.g. `time 1h`, `2 verifiers`). On accept,
  you **write the pre-task receipt** (`00-epic-plan/pretask-<NN>.md`, `**Accepted:** <phrase>`) — it is
  the tool-enforced precondition of scaffolding (see §4's STOP gate); no receipt → `add-phase` refuses.

**Sample A — a `full` round (build a new `json-summarize` tool):**

```
Pre-task — full round: build json-summarize
Defaults run the team AS CONFIGURED. Reply "all defaults" to accept; name only what you want changed.

① Roster + sequencing — serial, 1 each:
     planner        · charter: planning        · opus
     builder        · charter: shipping        · opus
     test-writer    · charter: test-writer      · opus
     documentarian  · charter: documentarian    · opus
     verifier       · charter: verifier         · opus
     ↳ on FAIL only: verify ↔ bug-fixer loop    · bug-fixer · opus · cap 5

② Definition of "done" — [draft, confirm/edit]:
     • tool runs + --help + handles cases X / Y
     • tests green AND mutation-checked
     • json-summarize.md accurate (every claim run-verified)

③ Paths:
     in:   <spec>
     out:  the json-summarize tool under tools/workflow/   (+ .md  + tests/)

Advanced — all defaulted ("-v" expands):
     time 2h · scope task-folder · retries builder 5 / verify-loop 5 / everyone-else 1
```

**Sample B — a `docs` round (document the already-delivered cost-ledger tool, run as `tpm workflow cost`):**

```
Pre-task — docs round: document the cost-ledger tool (`tpm workflow cost`)
Defaults run the team AS CONFIGURED. Reply "all defaults" to accept; name only what you want changed.

① Roster + sequencing — serial:
     documentarian  · charter: documentarian    · opus
     verifier       · charter: verifier          · opus
     ↳ on FAIL only: verify ↔ bug-fixer loop     · bug-fixer · opus · cap 5
     (no builder → no charter choice)

② Definition of "done" — [draft, confirm/edit]:
     • tpm-workflow-cost-ledger.md covers every subcommand + flag
     • each claim run-verified against --help
     • a doc-accuracy check the verifier can reproduce

③ Paths:
     in:   the cost-ledger tool under tools/workflow/   (read-only)
     out:  tools/workflow/tpm-workflow-cost-ledger.md

Advanced — all defaulted ("-v" expands):
     time 1h · scope task-folder · retries documentarian 1 / verify-loop 5 / verifier 1
```

The `docs` round **drops the charter question entirely** — no builder, no candidate-charter choice.

**Baked in — NOT questions:** background execution (the orchestrator always backgrounds subagents);
resume handling (you fill it contextually in the plan when a `HANDOFF.md` exists — resume / sibling /
clean-reset are plan-writing machinery, not user questions).

### Question-folding (the key ergonomic — `/tpm-spawn` interpretation, one level up)

The user states intent once in prose; you reconcile it against the structured defaults so they
correct only deltas:
1. **Raw defaults** from the resolver (§1).
2. **Overlay the opening statement** — intent-match (not exact-string) what the user said onto each
   question ("fable" → models; "two builders + a verifier in parallel" → roster + sequencing; "quick,
   just prove it" → team/charter).
3. **Confidence-gate** — fold only when confident; ambiguous/unmentioned → keep the safe config
   default, don't guess.
4. **Echo** — the batched roster *shows* the folded-in defaults so a mis-fold is a visible line to
   correct before any machinery runs.

**⭐ Precedence (highest wins): (1) user opening statement → (2) consuming-project override config →
(3) TPM default config.** The resolver merges the bottom two; you overlay the opening statement on top.

> **Guardrail — never reintroduce stop-authorizing questions.** Depth-vs-breadth, can-worker-pivot,
> and 30-min-stall were deleted deliberately: they contradict the charter's persistence clause. The
> retry machinery (below) is the opposite — it forces MORE delivery, not less. Keep it in.

## 3. Charter folds into the roster (the singular definition of done)

The charter is the agent's **singular, unconditional success bar** — it lives on the roster line, not
as a separate big rock. A worker must **never** see that a weaker bar exists for some other role — the
harm is not "knowing another role exists," it's *adopting the weaker definition of done*. So:
- **Every persona has exactly ONE fixed charter**, resolved from config and just displayed on its
  roster line — `charterVariants` is empty, so there is no live per-round charter menu for any role.
  The builder's is `shipping` (the default and only shipped builder charter). A weaker "mvp" bar is
  NOT a live opt-down: it is an ad-hoc route — pass `--charter <path>` to `scaffold add-phase`/`add-round`
  (e.g. the now-orphaned `charters/mvp-charter.md`, unreferenced by config) to copy a lower-bar charter
  into that one round.
- A **weaker-bar charter (`research`/`mvp`) NEVER sits in a build folder.** A verifier charter next
  to a builder charter is harmless (different role); a research charter next to a builder is the
  contamination that matters.
- When you do opt a builder down (the ad-hoc `--charter` route above), the worker never sees the
  choice happened — which is why any charter handling stays in the first step of `plan`.

## 4. Scaffold the folder(s) — epic vs flat

> ### 🛑 TWO STOP GATES — each ENDS YOUR TURN and waits for the user (tool-enforced)
> Kickoff is TWO separate confirmations. Do not collapse them; each ends your turn (present → **stop** →
> the user's NEXT message is the answer). Use `AskUserQuestion` for each so the answer is genuinely theirs.
>
> **Gate A — questions answered (gates SCAFFOLDING).** Present the §2 roster, then STOP. When the user
> answers (`all defaults` or explicit deltas): (1) capture it to **`dev/<epic>/00-epic-plan/pretask-<NN>.md`**
> — the roster shown, the user's response **quoted**, an **`**Accepted:** <their phrase>`** line; (2) record
> it: **`tpm workflow signoff questions --roster "<one-line>"`**; then scaffold. EVERY `add-phase`
> passes **`--pretask-ack <that receipt>`** and **the scaffolder REFUSES without it** (exit 1). *(This got
> silently skipped in session-007. No bypass flag: if you want one, you haven't run §2.)*
>
> **Gate B — spawn confirmed (gates the SPAWN itself — the critical gate).** After scaffolding + composing +
> linting, ask an **explicit** "kick it off now?" and STOP. A rambly / discussion / "process-what-I'm-saying"
> turn is **NOT** a kickoff. Only on an explicit "yes": **`tpm workflow signoff spawn --round
> "<phase-dir>" --roster "<one-line>"`** (`--round` = the phase-folder path), then spawn. A **`PreToolUse` hook**
> (`tpm hooks gate-spawn`) BLOCKS any workflow spawn whose `compose`-stamped marker (`<!-- tpm-workflow-spawn
> phase=… -->`) has no **fresh, same-round, same-session** `spawn` token — so a missed/faked Gate B, or a
> token for a different round, fails loudly at spawn time. **Only ever write the token from an explicit user
> confirmation — never from your own inference.**
>
> *(The argument text passed to `/tpm-workflow` is the SPEC for Gate A, never sign-off for either gate —
> see SKILL.md ⛔ HARD RULE. `epic-init` + `add-round` need no ack: `epic-init` only makes the folder the
> receipt lives in, and `add-round` is the verify↔bug-fixer loop inside an already-approved phase.)*

**Trigger:** a flat `dev/<task>/` for the single-delivery-agent teams (`build`, `ship`, `test`,
`docs`, `research` — one delivery agent, verifier aside). The **epic layout kicks in the moment more
than one delivery agent shares the deliverable** — `full` (planner → builder → test-writer →
documentarian), or multiple builders. Below that, no epic overhead.

- **Epic:** `tpm workflow scaffold epic-init dev/<epic>` then
  `tpm workflow scaffold add-phase dev/<epic> --slug <slug> --team <team> --pretask-ack dev/<epic>/00-epic-plan/pretask-<NN>.md`.
  `add-phase` auto-computes the next `NN` (append-only; never renumber), drops the phase skeleton:
  `plan.md` (**seeded from the config's `planTemplateFile` when one resolves on disk — the scaffolder
  consumes it, phase 24 fix #9; the built-in sentinel stub is only the fallback**), per-role
  `charter-<role>.md` (copied from the resolved `charterFile`), per-role
  `spawn-prompt-<role>-r1.md` stubs, `findings/ tools/ tests/ tmp/`, and per-subagent
  `tmp/<role>-r1[-v<M>]/` scratch folders. **Numbered ≠ serial** — `NN` is a stable lineage id; the
  `00-epic-plan/` phase map is the source of truth for order + parallelism.
- **Flat round:** a single `add-phase`-style folder is fine; a flat `ship` folder holds ONE `plan.md`
  (the builder's) + `charter-builder.md` + `charter-verifier.md` (the verifier reads the same plan's
  DoD + its own charter — not a second plan).

`00-epic-plan/` is **orchestrator-write-only** (subagents read it, never write) and must be
**charter-clean** — nothing in it may leak a second charter/posture to a worker.

## 5. Fill `plan.md` (pure structure — no posture)

`plan.md` is STRUCTURE only; the charter is a **separate file** the spawn-prompt names. The skeleton
the scaffolder dropped is whichever §4 resolved — a configured `planTemplateFile` if one exists on
disk, otherwise the built-in sentinel stub — so don't assume a fixed stub; fill whatever sentinels
the dropped file actually carries. Fill every `{{FILL}}` sentinel: Scope/motivation · **Definition of Done** (the triple table) · Task/method ·
**Tools & MCP** (baseline reminder + the `{{RELEVANT_TOOLS}}` you populate during recon) · Context
(curated, token-scoped reading list — own folder · `00-epic-plan/` · the specific prior-phase
`HANDOFF.md`s + `README`) · Deliverables (task-specific + standing; TLDR / wiki / tool-feedback are
**config-gated** per `deliverables.*`) · Constraints (scope boundary · don't-modify-siblings) ·
Time budget (the number) · When done. **Front-load what you know** — curate SPECIFIC reference
material with one-line why-relevant hooks, not "consult the docs"; flag anything a referenced doc
marks as wrong/stale so the worker doesn't trust it.

## 6. Compose + lint the spawn prompt — BEFORE the spawn

```
tpm workflow compose --role builder \
  --phase-dir 'dev/<epic>/NN-<slug>' --plan plan.md --charter charter-builder.md \
  [--round 1 --model <model> --project-root "$(pwd)" --out spawn-prompt-builder-r1.md]
```

`--out` is resolved against `--phase-dir`, so a bare name lands in the phase folder; a path that
escapes the phase folder is refused.

Then **lint** the finalized plan/charter/prompt (the poka-yoke that makes token-saving partial reads
safe — you grep the template, the lint catches the gaps):

```
tpm workflow lint --file spawn-prompt-builder-r1.md \
  --require-charter --charter-dir 'dev/<epic>/NN-<slug>' [--verifier] [--resume]
```

**No `--manifest` needed** — it defaults to the ONE canonical manifest, which the tool SELF-LOCATES
from its own bundle (below). `--manifest` stays an OPTIONAL override for a caller that wants a
different one; an explicit `--manifest` that doesn't exist fails LOUD (exit 2), and if the manifest is
found nowhere (a broken bundle) the lint also fails LOUD rather than silently skipping the doc-chain.

> **The canonical lint manifest — one place, no duplicate chain.** There is exactly ONE reading-list
> the lint enforces against: the **live subagent reading-list**
> (`%TPM_HOME%/claude-context/methodology/subagent/reading-list.md`). It owns the base chain AND the per-persona
> blocks (`test-writer` / `documentarian` / `bug-fixer`, gated by the matching `--<role>` flag) — the
> persona blocks live in that ONE file. The orchestrator's own round-machinery docs (the pre-task
> questions, the charters, `subagent-orchestration.md`) are separate and carry no second copy of the
> subagent chain — so the lint self-locates that ONE manifest and nothing lints against a duplicate.
> (Folding the persona blocks INTO the live manifest is a separate promotion step — this note only
> records that they land there, canonically.)

Exits 0 on PASS, 1 on FAIL with a per-check missing-directive list. It checks the manifest reading
chain, the env-source ritual, the working folder, the **charter-file-present** guard, the sentinel
taxonomy (fill/strip/required/config-gated), and **blocked filenames**. Do NOT spawn on a FAIL.

## 7. Present for review, then hand off

Present the plan for the user's review (the plan-review gate — common tweaks: task ordering, budget,
verifier count, inline-vs-link references). Iterate until approved. Then — on the user's explicit
kickoff (the HARD RULE) — hand off to **`run` mode**, which delegates to `tpm-spawn` (single) or
`tpm-spawn-team` (roster). The `run` mode has no body of its own.
