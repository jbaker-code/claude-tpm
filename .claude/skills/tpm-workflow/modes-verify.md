# `verify` mode — verifier(s) + the verify↔bug-fixer loop

**Verification is a per-round DECISION, not a reflex.** A round that ships an artifact warrants a
verification round; "just operating" does not. Whether to run verifiers was settled in the pre-task
questions (team shape) — this mode executes that decision. It spawns verifier(s), runs the capped
verify↔bug-fixer loop (on FAIL only), and routes each stop with judgment.

## Spawn the verifier(s)

- A verifier reads the **completed artifact from disk** — so **delivery→verifier is a HARD BARRIER**
  (verifiers cannot start until the delivery agents — builder / test-writer / documentarian — are
  done), regardless of `--mode`.
- Each verifier runs under the **verifier charter** (a file — `charter-verifier.md` — named by its
  own visible `spawn-prompt.md`). The charter, not this skill, owns the verifier's posture (its
  singular definition of done); you route to it, you do not restate it. Two routing consequences shape
  this mode: (1) a verifier produces a **verdict, not a fix** — it never repairs what it checks; and
  (2) the **verifier is blind to the loop** — it never learns a fixer follows, and never fixes. So a
  FAIL is an INPUT the orchestrator judges, and any kickback goes to a **bug-fixer**, never to the
  verifier and never to a fresh builder.
- Scaffold/compose/lint the verifier the same way `plan` mode does a builder:
  `tpm workflow scaffold add-round <phase> --role verifier` → `tpm workflow compose --role verifier
  --round <N> --variant <M>` → `tpm workflow lint --file … --verifier`. The `--verifier` flag enables the
  manifest's `verifier` block plus the HARD-RULE reminder; no `--manifest` needed (it self-locates the
  ONE canonical manifest — see `modes-plan.md` §6; `--manifest` stays an optional override). Spawn via `tpm-spawn`
  (single) or `tpm-spawn-team` (roster).
- **Verdict lands at `findings/verifier-r<N>-v<M>-verdict.md`** ("verdict" avoids the blocked
  "findings" filename pattern). Scratch/captures → the verifier's own `tpm-tmp/verifier-r<N>-v<M>/`.

## Multiple verifiers (`count > 1`)

- **Independence:** verifiers run **BLIND to each other** — a verifier never reads another's verdict.
- **`verifier.requireAllPass` (default true):** the round PASSes only if EVERY verifier PASSes; any
  FAIL → kickback.
- **`verifier.multiCountMode`:** `blind-pair` (identical, redundant — catches flakiness) vs
  `scoped-lenses` (differently-scoped, e.g. a correctness verifier + a regression verifier). From
  config; confirm with the resolver.

## The two retry mechanisms (both config-defaulted, user-overridable)

Delivery agents regularly bail early (hallucinate a stop, time out, stop to ask) or under-deliver;
verifiers catch them. This machinery is **essential to reliable delivery** — do NOT remove it (unlike
the stop-authorizing questions we cut, this forces MORE delivery).

1. **Per-agent retry (`retryCount`, per type):** an agent that bails WITHOUT delivering is re-run up
   to `retryCount`. Defaults: **researcher 1 · planner 1 · builder 5 · bug-fixer 5** (delivery/fix
   work often needs 2–3 serial runs just to deliver) · test-writer / documentarian / verifier 1.
2. **Verify↔bug-fixer loop (`verifyLoopCap`, default 5):** the delivery agents (builder / test-writer
   / documentarian, whichever the team has) each run ONCE, in roster order. Then the verifier checks.
   On a **FAIL**, the **orchestrator** judges the verdict, logs the call in `00-epic-plan/decisions.md`,
   and — only if a kickback is warranted — spawns the persona named by config **`verifier.loopFixer`
   (default `bug-fixer`)** to make the targeted fixes; the verifier re-checks; repeat up to
   `verifyLoopCap` cycles. **This is the ONLY thing that repeats.**

**The fixer, not a fresh delivery agent.** On a FAIL the orchestrator spawns the **`bug-fixer`** (the
`verifier.loopFixer` persona) — NOT a fresh builder / test-writer / documentarian. Route it against the
verdict's reported findings; its own charter (`charter-bug-fixer.md`), not this skill, owns its posture
(scoped to the reported findings, no redesign/re-scope) — you route to it, you do not restate it. The
**verifier stays blind to the loop** — it produces a verdict + concerns (including any
automatable-but-untested test-adequacy gaps), never learns a fixer follows, and never fixes; the
orchestrator turns its concerns into the fixer kickback.

**Both retries re-run in the SAME phase folder, coordinated by `HANDOFF.md`** (the single rolling
doc; the numbered `spawn-prompt-<role>-r<N>.md` + `verifier-r<N>-v<M>-verdict.md` are the history).
`tpm workflow scaffold add-round` auto-numbers `r<N>` — never hand-track it. A retry is NOT a new
phase; only a deliberate later stage (a dedicated verification sweep, a distinct post-build bug-hunt)
is an appended numbered phase.

## Retry is JUDGED, not blind (the resilience gate)

On any stop, read the worker's `HANDOFF` / `questions.md` and **route by failure class** — blindly
re-running conflates them:
- **Worker-bail** (hallucinated stop, ran out of steam) → **retry the same plan.**
- **Question** (stopped to ask) → **answer it** ("I wrote your question down; for now do X…") **+
  retry.**
- **Plan-broken** (impossible DoD, wrong path, self-contradiction) → **RE-PLAN.** Re-running a broken
  plan N× just burns the retries — fix the plan, log the change in `00-epic-plan/decisions.md`, then
  retry. (Back to `plan` mode.)
- **Genuine blocker** → **surface to the user** (`STOPPING DUE TO BLOCKER`, or `verifyLoopCap`
  exhausted → `failed-reconciliation`).

`retryCount` is a **CAP, not a mandate.** The discrimination signal is the worker's own loud-stop
report — which is exactly why the charter mandates that stopping is a loud, explicit, full-context event.

## Partial-with-stated-gap is a legitimate completion

"Done" isn't always 100%. A phase can complete with a **working artifact + an honestly-measured gap**;
the gap becomes an **appended follow-on phase**, not an infinite grind toward 100%. The verify-loop
must accept partial-with-stated-gap as a valid phase completion.

On a clean PASS (or accepted partial), advance to **`reconcile` mode**.
