<!-- tpm:if !session.enabled -->
tpm-session is disabled by config (`session.enabled: false`) — say "session lifecycle disabled by config" and do nothing else.
<!-- tpm:endif -->
<!-- tpm:if session.enabled -->
## `tpm-session close` — wrap-up ritual

**A subagent must never run this skill.**

<!-- tpm:inject foreign-gate -->

`close` wraps up the orchestrator's own session (reap, session-notes seal, sign-off) — a worker's lifecycle is its spawn prompt + its working folder's `plan.md`, not this. If you were spawned as a subagent and somehow reached this, STOP and follow your spawn prompt instead.

Step A. **Run the reap ritual.** Call `/tpm-reap`. `close` just triggers it. **NEVER auto-kills** — enumerate, explicit user choice, double-confirm for "all", close only the confirmed, per `tpm-reap`'s own ritual. Silent (no prompt) if `tpm-reap` finds nothing running.

<!-- tpm:if session.notes.enabled -->
Step B. **Finalize session notes — the save ritual below, verbatim (its own numbered sub-steps 1-3).** (A refused `import-handoff` (exit 1) wrote nothing, so fix the named field and re-run before sealing.)

<!-- tpm:inject save-ritual -->

**Closing seals ONLY your own track** (found by your Claude session id); other instances' tracks are never touched.

<!-- tpm:inject multi-track -->

Step C. **Seal the session.** After the save ritual finishes, run `tpm session close --session <NNNN>` — the seal. It **REFUSES (exit 1, naming what's missing) unless a handoff AND at least one punchlist item are present**; otherwise it stamps `meta.closedAt`. Then run `tpm session current --seal` — it closes the current-session hint only when NO track of the session is still unsealed (and says so, leaving the hint open, when another track is still live), so the NEXT bare `tpm-session` invocation opens fresh instead of reusing this folder. It is safe to run either way; it never seals a track itself.

Tools for this mode:

<!-- tpm:inject tools-write -->

<!-- tpm:inject tools-common -->
<!-- tpm:endif -->
<!-- tpm:if !session.notes.enabled -->
Step B. Notes are disabled by config (`session.notes.enabled: false`): skip the notes save and the seal entirely (no `session` write verb runs at all).
<!-- tpm:endif -->

Step D. **`/export` nudge.** One line: `/export` (a Claude Code CLI command) saves a readable transcript — the user types it themselves. Transcripts also persist automatically; this is a convenience, not a data-safety requirement.

<!-- tpm:if session.showTPMCloseMessage -->
Step E. **Terse sign-off** — NOT the skill menu. At close the user is *stopping*, so do NOT list "here's what else you could do". One paragraph: what shipped, what's pending, any hand-offs to the next session, the notes-saved-to pointer.
<!-- tpm:inject additional -->
<!-- tpm:endif -->

Step F. **Print the footer** (below). It is the LAST thing you emit.

<!-- tpm:inject footer -->
<!-- tpm:endif -->
