# Verification — the shared evidence & reproducibility rulebook

The rules for **proving** work, shared by everyone whose round touches a **shipping artifact** — a built
artifact, a code change, a data transformation, an extracted asset, a new tool — and everyone who **checks**
one. It covers the reproducibility bar an artifact must clear, where verification files live, the on-disk
ground rules and PASS/FAIL-with-evidence format for a check, and how to log decisions during "figure it out"
runs.

> **When this doc applies.** It is in your reading chain, so it applies to your round. Your `plan.md` defines
> *what* your round must produce and *what* must be true for it to be done; this doc defines *how* you prove
> that — the evidence that turns "I did it" into "here is the artifact and the check that reproduces it."

> **Two audiences, one rulebook.** If your round **produces** an artifact, read this as the reproducibility
> bar that artifact has to clear. If your round **verifies** an artifact a builder produced, read this as the
> ground rules for exercising it, the independence **HARD RULE** (render the verdict, don't repair what you
> check), and the PASS/FAIL-with-evidence format your verdict must follow. The evidence-quality standard is the
> same standard from both sides: the builder writes a check that reproduces the result, and the verifier
> confirms it reproduces independently.

> **Related docs:**
> - [`./shared-conventions.md`](./shared-conventions.md) — conventions that apply even without verification:
>   terse-by-default communication, reading heuristics.
> - [`./tool-conventions.md`](./tool-conventions.md) — how you build/copy/reuse the tools your evidence
>   depends on ("Ship your deliverables AS re-runnable tools", the no-hardcoded-paths directive).
> - [`./troubleshooting.md`](./troubleshooting.md) — what to try when a verification keeps failing (static
>   analysis, escalation) and disaster recovery.

---

## The reproducibility bar — before any shipping artifact is "done"

An artifact is not done because you built it. It is done when someone else can **reproduce the claimed
result from documented inputs.** The bar is a single question:

> "Could someone else — a fresh session, or the user picking this up months from now — rebuild this artifact
> from the documented inputs, and re-observe the result you're claiming, in a few minutes and with no
> guesswork?"

If the answer is no, that is a TODO before "done." Concretely, the artifact clears the bar only when:

- [ ] **A check re-runs and reproduces the result.** The artifact ships with a script (in the relevant
      `tools/` folder — project-level or task-folder, per [`./tool-conventions.md`](./tool-conventions.md))
      that rebuilds it from documented inputs and demonstrates the claimed output end-to-end. Not an inline
      Bash one-off you'll never find again — a committed script. **The tool IS the reproducibility contract.**
- [ ] **All inputs are named with absolute paths** in `plan.md` or the relevant findings doc — source paths,
      asset paths, config.
- [ ] **No hardcoded paths inside the script** — everything is CLI-flag-driven, per the
      [no-defaults directive](./tool-conventions.md#no-hardcoded-paths-or-defaults). A path someone else
      can't set is a path that won't reproduce on their machine.
- [ ] **Evidence carries its inputs.** Any capture, diff, or before/after artifact records the exact inputs
      that produced it — so the evidence itself is reproducible, not just plausible.
- [ ] **The output has a stable name + a documented checksum** (in `findings/README.md`) when it is a
      deterministic build output.
- [ ] **The task's `README.md` has step-by-step reproduce instructions.**

This is the standard that kills the "I made this last week but can't remember how" failure mode — and it is
exactly what a verifier re-runs to confirm your claim.

---

## HARD RULE — an output is disposable only if its generator survives (the "lost-step" rule)

Verification produces large *outputs* — built artifacts, capture bundles, captured evidence. Those are
**throwaway by design**: you regenerate them by re-running the *generator* (the tool source) on the source
inputs. **The generator is the durable artifact; every output is regenerable from it, and only from it.** Two
failure modes each destroy an entire step of work, and both are forbidden:

1. **Never delete a large output until its generator is committed AND re-running that generator reproduces
   the output** (byte-for-byte where the output is deterministic). If the generator isn't in the repo, or
   doesn't regenerate the output, that output is the *only* copy of the work — removing it is unrecoverable.
   A round is not "done / disposable" until `generator + source inputs → the exact output` holds and has been
   checked.

2. **For a VISUAL or observable result, prose is NOT durable proof — preserve the key captured evidence.** A
   textual description of what an output "looked like" is unreliable: people describe by *expectation* as
   readily as by what actually happened, and a one-time observation — a transient, a frame that won't recur —
   may be gone by the time a verifier re-runs the artifact. So the single durable, independently-checkable
   record of an observable claim is the captured evidence itself — the screenshot,
   the log, the recorded output. Preserve the key evidence to durable storage (small, not gigabytes)
   **before** any large-output removal.

**Practical split:** commit the generator (tiny) forever; keep the handful of load-bearing evidence files;
remove large bundles freely — they come back on command. What makes removal safe is "generator committed +
proven," never "it looked finished."

---

## Verification is mandatory (except for pure documentation)

If your round produces a built artifact, a new tool, a code change, a data extraction, a format
transformation, or a parsed table — verification is REQUIRED before the task is done:

- **Verify the work first.** Write a script in the relevant `tools/` folder that demonstrates the work runs
  end-to-end and produces the claimed output. Document the verification approach in a numbered findings doc.
- **"I wrote the code" is not "the code is verified."** A built artifact without a passing verification step
  is `STATUS: in-progress`, not `STATUS: complete`. Declaring done without verification is the single most
  common failure mode this rulebook exists to prevent.
- **If you cannot verify it yourself** — because the evidence or the tool/access a claim genuinely needs
  isn't available to you — write the exact verification steps into `findings/questions.md` AND mark every
  affected finding `STATUS: UNVERIFIED — pending check`, and move on. An honestly-unverified claim with a
  written procedure is useful; a claim "verified" by an instrument that can't observe it is worse than none,
  because it will be believed.

---

## Where verification files live — durable vs disposable

A task folder splits into `findings/` (durable — kept) and `tpm-tmp/` (**disposable — everything under it will be
deleted and lost after the round is reviewed**). Verification work straddles that line, so placement is
explicit:

| Thing | Location | Lifecycle |
|---|---|---|
| Evidence produced FOR a downstream check (capture bundles, captured evidence) | task `tpm-tmp/captures/`, `tpm-tmp/verification/` | disposable |
| Verifier scratch (intermediate diffs, exploratory renders, working notes) | task `tpm-tmp/verification/` | disposable |
| A verifier's verdict / findings | `findings/` (per your folder-hygiene rule) | durable |
| Proof-of-claim evidence the round ships (final before/after captures, the decisive diff) | `findings/verification/` | durable |
| Capture bundles the plan names as deliverables | `findings/captures/` | durable |

Two consequences of the split:

- **A verdict must never point at a `tpm-tmp/` path as its lasting evidence.** If an artifact is load-bearing for
  a PASS or FAIL — the key capture, the decisive diff — copy it into `findings/` before you return. Per the
  lost-step HARD RULE, prose about evidence that has been deleted is not evidence.
- **Handoff evidence flows through `tpm-tmp/`**, and a check reads from those `tpm-tmp/` paths. That is fine *during*
  the round — the deletion happens after review, not mid-round.

---

## Verifier ground rules — exercise the artifact, render a verdict

A verification round **actively exercises the artifact** to establish whether its claims are true. Use
whatever tools and MCP servers the round makes available — emulators, browsers, runners, a project's own
state-inspection tool — to drive the real thing and observe the real output. A visual or behavioural claim
cannot be proven from static bytes; reproduce the exact path the claim is about, not an adjacent one that
merely resembles it. On-disk inspection of the artifact files and captured evidence is one technique in that
kit — often the most reproducible one — not a boundary that forbids driving the artifact. Prefer raw captured
evidence over derived or annotated evidence for load-bearing checks, unless the derivation pipeline has itself
been verified bug-free for the artifact in question.

**The check must match the claim.** Choose an instrument that can actually observe the thing being claimed —
this is where confident checks most often go wrong, not by lying but by measuring something *adjacent* to the
claim and reading the result as proof. A transient is not established by sampling single moments; a visual
result is not established by reading back the values that were written; a behaviour claim needs the real path
exercised, not a state poked into place that resembles the outcome. Reproduce the exact path the claim is
about, not one that merely resembles it.

**Report PASS or FAIL with evidence.** For each claim, capture the method that backs the verdict so someone
else can re-run it and reach the same result. Preserve the captured artifact — the screenshot, the log, the
exit code — not just prose about it. **Evidence a reviewer cannot reproduce is an assertion, not a
verification.** Walk the plan's Definition-of-Done table row by row; every row gets a PASS or FAIL and the
evidence path that backs it.

**FAIL is a legitimate verdict — use the escape hatch.** If you cannot establish PASS with the tools and
evidence available to you, return **FAIL with the hypothesized cause named and the missing evidence named.**
Do not soften a verdict to PASS you can't stand behind, and do not manufacture a PASS by fabricating evidence
you couldn't actually observe. An honest FAIL with a hypothesized cause is more useful than an unbacked PASS.

### HARD RULE — render the VERDICT, do not REPAIR what you check

This is a hard rule with no exceptions and no per-project variants: a verification subagent produces the
**verdict, not the repair.** You actively drive the artifact with whatever tools and MCP are available, but
you do **not** fix, patch, rebuild, or otherwise change the thing you are checking. A verification subagent:

- **exercises the artifact and reports PASS/FAIL with evidence** — it renders a verdict, it does not fix or
  build;
- makes **no repair to the artifact under check** — no patch to the code, no correction of the data, no
  authoring of the missing test — because the moment a check edits the thing it checks, it can no longer say
  whether the artifact *as shipped* was correct;
- **hands a failure back precisely** rather than closing it — when something fails, it reports *why*, names
  the missing evidence, and stops there.

The reason is the whole value of an independent check: a verifier that "helpfully" patches the bug it found
destroys the independence of its own check — PASS collapses into "PASS in a state I fixed," and the audit
trail is worthless. Using tools to *exercise* the artifact is exactly what a verifier should do; the bar is
that it never *repairs* what it exercises. If a claim can't be settled with the tools and evidence you have,
that is a FAIL with the missing-evidence problem named — name it in the verdict and in `findings/questions.md`,
and return FAIL. (Read this rule even on a project where nothing seems fixable in place — it is what makes a
verdict trustworthy, and it holds identically the moment there is something a check could reach in and
"correct.")

### Mutation-check the tests — a green suite is a claim, not proof

When the artifact under check ships its own tests, **those tests are themselves an artifact to verify, not
evidence you may take on trust.** A passing suite tells you the tests are consistent with the current code —
it does not tell you the tests would *catch the code going wrong*. Establish that they would:

- **A test that still passes when you break the thing it tests has verified nothing — so try breaking it.**
  For the load-bearing tests, deliberately introduce a fault into the behaviour a test covers (flip a
  condition, return a wrong value, short-circuit the path), confirm that test goes red, then **restore the
  artifact byte-for-byte.** A test you have never watched fail is a test you do not yet know works, and a
  suite that stays green through a real defect is **worse than no suite** — it manufactures false confidence.
  A mutation the suite fails to catch is a finding: record it in the verdict with its evidence.

- **Assess whether the tests actually exercise the claimed behaviour (test-adequacy).** Walk the plan's
  Definition of Done and, for each claim, ask whether *any* test would fail if that claim stopped being true.
  Where a behaviour is automatable but has no test that pins it — or is "covered" only by a check that
  asserts nothing about the result — **report that automatable-but-untested gap as a concern in the
  verdict**, naming the untested claim and what a real test of it would exercise. Test-adequacy gaps are part
  of the verdict, not an aside.

This is the same bar the builder side owes — a ship-intended tool owes tests that exercise its real behaviour
and exit non-zero on failure ([`./tool-conventions.md`](./tool-conventions.md)) — read from the checking
side: the builder writes real tests, not smoke tests; the check proves those tests can fail and flags the
behaviours they leave uncovered.

**Report the gap; do not close it.** Finding a weak or missing test is a gap to **report as a concern**, not
a test for the check to write. Authoring the missing test would destroy the independence the HARD RULE above
protects — a check that writes the thing it is checking can no longer say whether the artifact **as shipped**
was correct. Name the gap precisely, attach its evidence, and stop there.

### Verification techniques — reach for a project catalog

For recurring verification problems (render-diff alignment, distribution comparison, alignment checks, and
the like), a project may maintain a techniques catalog so a check doesn't re-derive a method already worked
out. Reach for it when your task names a cataloged problem; adding a new technique back to the catalog is a
project-wide win. If a project ships a state-inspection tool, its **static/offline mode** (reads a captured
bundle) is often the most reproducible instrument for a state claim — prefer it when a captured bundle can
settle the claim; drive the tool's live mode when exercising the real path is what the claim actually needs.
Whichever mode you use, the HARD RULE stands: exercise the artifact freely, but never repair it.

---

## Decision logging — `findings/decisions.md`

When you make a decision the user might not have made — which lead to pursue, which variant to build, which
instrument to trust — document it where it can be audited. A decision left unwritten is a decision the user
can't second-guess later.

For a round running in **"figure it out"** mode (full latitude delegated, no step-by-step review), keep a
single `findings/decisions.md` at the task root with a dated entry per non-trivial decision — the
audit-friendly alternative to scattering decisions across many docs. Each entry:

```markdown
## 2026-06-29 14:23 — Chose the streaming parser over the buffered one for large inputs

**Decision:** Use the streaming parser path (`--stream`) instead of the prior round's buffered read.

**Why:** The buffered path holds the whole input in memory; the inputs this task must handle exceed the
memory budget, so the buffered path fails on the largest cases.

**Alternatives considered:**
- Raise the buffer cap — only defers the failure to a larger input.
- Chunk the buffered reader — more code than switching to the existing streaming path, for the same result.

**Reversibility:** Reversible — flip the flag, re-run.
```

The **Reversibility** line matters: it tells the user at a glance whether the decision committed something
hard to undo. `findings/decisions.md` is the first place the user looks when auditing a "figure it out" run.

---

## Cross-references

- [`./shared-conventions.md`](./shared-conventions.md) — shared workflow conventions.
- [`./tool-conventions.md`](./tool-conventions.md) — how you build and reuse the tools your evidence depends
  on; the reproducibility bar above is enforced by shipping deliverables AS re-runnable tools.
- [`./project-workspace.md`](./project-workspace.md) — read/write boundaries; where `findings/` vs `tpm-tmp/`
  live.
- [`./troubleshooting.md`](./troubleshooting.md) — what to try when a verification keeps failing, plus
  disaster recovery (including recovering a clobbered deterministic output from its committed generator).
