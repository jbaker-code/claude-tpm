# Troubleshooting — when stuck, blocked, or broken

What to try when the work isn't moving (you're stuck on an open question, a verification keeps failing, a tool isn't doing what you expect) and what to do when something concretely breaks (a build output gets clobbered, a working folder disappears). **Applies to both orchestrator and subagents** — read this when the path forward isn't obvious.

If the project has a live system under test (SUT), its own docs cover live-system recovery. This doc covers everything else.

---

## When stuck on an open question

Before declaring a dead-end or pausing for the user, work through these options. Most "I'm stuck" moments turn out to be solvable with one more pass.

### Static analysis (always allowed — orchestrator AND subagents)

- **Byte/text scans of the artifact under test** — `grep`, signature scans, node-based searches for patterns. Faster than reading code — let the bytes tell you where the thing is.
- **Cross-reference against existing findings** in `dev/*/findings/`. Someone (you, a past subagent, the user) may have already answered the question or found the relevant region.
- **Read source code** for the artifact / tools to understand how a mechanism actually works. Don't assume; trace.
- **Byte/text-diff** the modified artifact against the baseline. When a tool does something unexpected, the diff often points at the surprising side effect.
- **Read findings index** before deep-diving into a new investigation. The `findings/README.md` of a related task often surfaces a 10-line answer for what looked like a 2-hour question.

These are the cheapest moves and the right first reach when you don't have live-system access (default subagents) or when you DO but want to avoid a contention round.

### Manual / external (escalation)

- **Documentation in one place disagrees with another** — search broader. Other findings, session notes, web research. Resolve the disagreement before depending on either source.
- **Behavior isn't documented anywhere** — write a focused investigation plan first; don't iterate blindly. The plan goes in `findings/` so future-you (or another subagent) can follow your reasoning.
- **Task is genuinely blocked on user input** (aesthetic decision, yes/no on a trade-off, missing source asset) — surface it clearly and **keep working on everything else**. Subagents surface via `findings/questions.md`; the orchestrator surfaces directly to the user in chat. A single blocked question is not a blocked round: park it and move to the next thing the task asks for. The task's definition of done defines what counts as a legitimate ending.

---

## When something breaks — disaster recovery

Disaster scenarios and their methodology-level recovery paths. **Applies to any actor.**

### 1. A generated build output accidentally overwritten

**Symptoms:** A deterministic build output under `findings/` got clobbered (wrong size, wrong MD5, or missing entirely).

**Recovery:** The generator is deterministic. Re-run it with the same inputs documented in the task's `findings/README.md`. MD5 of the rebuilt output should match what was previously documented; if it doesn't, one of the inputs is stale — chase that down before trusting the rebuild.

If the generator's inputs themselves are lost: rebuild from canonical source (`dev/<task>/tpm-tmp/`).

### 2. Working folder accidentally deleted / contents corrupted

**Symptoms:** `dev/<task>/` (or files inside) gone or unreadable.

**Recovery:** Ask the user whether a recoverable snapshot of the folder exists. If not: hope the orchestrator's session log / TaskList has enough breadcrumbs to recover, and check `tpm-tmp/` for in-progress artifacts that were copied out before deletion.

**Prevention is the real fix here:** when the orchestrator is doing heavy multi-hour work, periodically ask the user if it's a good time for him to checkpoint a commit. Don't accumulate too much uncommitted state in a single session.

### 3. Shared-folder EMFILE / ENOENT-for-files-that-exist under load — host-side, NOT your bug

**Symptoms (when the project tree is on a host↔VM shared folder):** `EMFILE: too many open files` on writes; `ENOENT` for files that provably exist; directory listings truncate or come back empty while plain file reads/writes still work; bash reports the working directory as deleted; a file you just wrote reads back as missing. These come in bursts and often clear on their own for a moment before returning.

**What it is:** **host-side file-descriptor exhaustion in the shared-folder daemon** (the host process serving the share holds an fd per accessed inode and can hit its ceiling under heavy or concurrent I/O — full builds, many small `require`s, multiple concurrent processes, or *another project on the same mount*). It is an environment failure, **not the subagent's own code and not a harness write-block.** Do not "fix" it by adding retry-with-fallback logic, and do not record it as a tool/harness bug (this has twice been mis-attributed — once as a fake "findings-file write guard").

**Action — ALERT THE USER; do not silently retry or work around it.** Recovery is host-side: the user remounts the share or restarts/reboots the host process (or VM) serving it. Note: dropping OS caches (e.g. macOS `purge`) does **not** reclaim the leaked handles — only a remount/restart does. While waiting, a write-local-then-probe-retry salvage pattern keeps state safe, but the fix is host-side, not in your code. If the project (or a sibling) ships a monitor/repair tool for the host share, its own docs cover using it — this is a consumer-specific supplement, not part of this project-agnostic doc.

---

## Cross-references

- [`./shared-conventions.md`](./shared-conventions.md) — shared conventions (communication, reading heuristics, onboarding).
- [`./project-workspace.md`](./project-workspace.md) — write boundaries (in case "stuck" turns out to be "I tried to write where I'm not allowed to").
- [`./orchestrator/handbook.md`](./orchestrator/handbook.md) — the orchestrator's general operating identity.

*(Verification and the formal-round machinery live in the `workflow` module — not referenced here, so this doc stays module-agnostic.)*

---

## Known dead ends — don't re-investigate

Consumer projects should maintain a per-project `known-dead-ends.md` (or an equivalent section in their local troubleshooting supplement) that captures conclusively-ruled-out hypotheses from prior investigations. Read that list before chasing a lead that smells like one of the documented dead ends — these are NOT shortcuts to try, they're confirmed dead ends. Format each entry as:

- **Short hypothesis name** — one-sentence summary of what was ruled out + one-sentence pointer at the actual mechanism / correct explanation. Link to the findings doc that established the ruling.

If you encounter a NEW dead end during current work — log it in your consumer project's dead-ends list with a one-line summary + a pointer to the findings doc that established it. Hygiene check on newly-superseded research surfaces dead-end candidates.
