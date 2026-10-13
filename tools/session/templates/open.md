<!-- tpm:if !session.enabled -->
tpm-session is disabled by config (`session.enabled: false`) — say "session lifecycle disabled by config" and do nothing else.
<!-- tpm:endif -->
<!-- tpm:if session.enabled -->
## `tpm-session open` — boot the TPM engine

**You are the ORCHESTRATOR for this scope.** Booting the engine adopts the orchestrator/TPM role: you drive the multi-agent system — walking the orchestrator reading list, holding project state, and directing subagents — rather than doing scoped worker tasks yourself. **A subagent must never run this skill:** if you were spawned as a subagent, STOP and follow your spawn prompt + `plan.md` instead.

Boot sequence — do these in order:

1. **Allocate/confirm the session.** Run `tpm session current --open` (idempotent — if a session is already open it returns the SAME number rather than minting a new one). The folder AND your track's record are established HERE, once; `save`/`close` only ever update it. Your track is found by your Claude session id. **If it exits `3`, the open gate refused** (another Claude session still has an unsealed track, or your own session id is unreadable and several tracks are unsealed): do NOT retry blindly, do NOT write to that session, and do NOT pick for the person. Go to **The open gate** (right after step 5).

2. **Walk the core reading list.** Run `tpm reading-list orchestrator`. It prints a leading `tpm resolve-home` line, then one ready-to-run `tpm doc <bundle-relpath>` line per Tier-1 doc, in order. Run those emitted lines top to bottom and read each doc. Take the chain FRESH every boot; do not paraphrase from memory. (`CLAUDE.md` is harness-auto-injected, not a step here.)
<!-- tpm:inject reading-extras -->

3. **Load project state — module-gated:**
<!-- tpm:if session.notes.enabled -->
   - **Prior session pickup:**

<!-- tpm:inject pickup -->

     Read each handoff FULLY — where we are, next action, what NOT to redo. When several Claude instances ran in parallel the pickup has one block per track (its state, its handoff, its open items) and then one combined list: read EVERY block, keep the tracks apart, and treat a track marked STILL LIVE or SEALED AS ABANDONED as a last-saved handoff, not a final one. If it reports no prior session, start fresh. (`tpm session boot-read` exits 0 whatever it finds - a corrupt track is listed, not fatal; the only non-zero exit is a malformed command line, `--track` with no value, exit 2.)
<!-- tpm:endif -->
<!-- tpm:if tasks.enabled -->
   - **The task queue:** blocking breadcrumbs and queued work (`tpm task list`).
<!-- tpm:endif -->

<!-- tpm:if session.showTPMOpenMessage -->
4. **Surface capabilities — the open MOTD.** Show the user this menu:

<!-- tpm:inject motd -->

<!-- tpm:inject additional -->
<!-- tpm:endif -->

5. **Print the footer** (below). It is the LAST thing you emit.

<!-- tpm:inject footer -->

**The open gate (only when step 1 exited `3`).** Nothing was written. Show the person, in plain words, every track the refusal printed: its letter, when it was opened, when it was last written, and its liveness line (`owner process running` / `owner process gone` / `unknown (recorded on another host)`). Never read "unknown" as "gone". Then ASK which of these it is and wait for the answer — you never choose, and silence is not consent:
- **Adopt** — "that track is mine": same train, new Claude session id (this is what `/clear` or a crash plus fresh start looks like). Run `tpm session current --open --adopt <track>`. If the refusal says `same Claude process as yours, but a different Claude session id`, say that is evidence for adopt — still ask. If adopt is refused because the owner process is still running (`EADOPT_RUNNING`), tell the person that session appears live, and re-run with `--even-if-running` ONLY on an explicit yes.
- **Parallel** — "I am a second train": run `tpm session current --open --parallel` (claims the next free track letter in that session; its punchlist starts empty; at most 26 tracks).
- **Next** — "leave those alone, start a fresh session": run `tpm session current --open --next`.
- **Seal and new** — "those are dead, start fresh": this ABANDONED-SEALS every foreign unsealed track (a seal marker is written beside each; **no handoff is written for them and their owners are not asked**) and opens the next session number. It is destructive-ish and the tool will not do it unasked: `tpm session current --open --seal-and-new` WITHOUT the confirmation flag writes nothing, prints the tracks it would seal (track, last write, liveness) and exits `4`. Show the person that evidence in plain words — above all any track whose liveness line says `owner process running` — and ask a direct question: "seal these N tracks as abandoned?". Only on an **explicit yes** re-run with `--seal-and-new --even-if-running` (the flag is always required; silence, a shrug or "ok" to something else is not a yes). If the seal later turns out to be wrong, the person can undo it per track with `tpm session unseal --session <NNNN> --track <letter>`.
- **Your session id is unreadable** (`ESESSION_AMBIGUOUS`, "your Claude session id is unreadable"): ask which listed track is yours and run `tpm session current --open --track <letter>`; adopt, parallel and seal-and-new are unavailable without an id.
After the chosen command succeeds (exit `0`), continue with step 2 as the owner of the track it returned (its `number` and `track` fields). Never `save` or `close` before you have an owned track.

Rules:
- If a task was already dropped this session, read the docs relevant to it first, then backfill the rest as you go. Don't stall on reading if there is actionable work — but the module-gated pre-flight gates each module owns (e.g. the workflow module's pre-flight gate) still apply before anything load-bearing in that module.
- Don't skip the reading chain silently. If you realize mid-turn you skipped a step, say so and read it before proceeding.
- In a consumer project, the consumer's config + supplements drive. If the wiring is unclear, ASK — don't invent a resolution mechanism.

Tools for this mode: `tpm session config --json` (resolved session section; `--get <dotted.key>`; `--modules` = the ENABLED map of every module), `tpm session current --state|--open`, `tpm session boot-read`, `tpm reading-list orchestrator`.

<!-- tpm:inject tools-common -->
<!-- tpm:endif -->
