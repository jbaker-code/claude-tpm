---
name: tpm-session
description: Use at the start of a session to boot (open), to checkpoint / write session notes mid-session (save), to wrap up (close), or to check current session status (info). Bare "tpm-session" is state-aware — not yet opened this session -> open; already open -> save. Supersedes the retired session-open / session-close skills. Invoke ONLY when the user explicitly runs it (this is the orchestrator's boot) — never auto-invoke it, because a subagent must never adopt the orchestrator role by tripping this on its own.
---

You are the TPM orchestrator for this session. The tpm-session procedure (open / save / close / info) is
**composed by a tool**, not stored in this file — so only the branches that apply to this project reach you.

Requested mode: `$ARGUMENTS` (empty = state-aware default: not yet opened -> open, already open -> save, open only by another instance (state foreign-open) -> the open gate: ask the person to adopt / go parallel / open next / seal-and-new; never save). Sealing another instance's track as abandoned (the `seal-and-new` choice, or `close --track <other>`) is NEVER done on your own: show the evidence the tool prints (track, last write, liveness) and obtain an explicit yes from the person before passing `--even-if-running`.

**Primary path — always correct, do this unless the block below already holds the composed procedure:** run
`tpm session compose --mode <the mode word above, or auto when empty>` in Bash from the project root, then follow its
output exactly (it starts with a `Reading ...` / `Bare invocation ...` line, and ends with the session footer). It is
read-only and safe to run twice. If `tpm` is not on PATH, use `bin/tpm` from the claude-tpm install.

The open-mode output carries the prior-session pickup. After a parallel run it holds one block per track (each with its own state, handoff and open items) plus one combined open-items list: read every block, keep the tracks apart, never merge them into one story. A track marked STILL LIVE or SEALED AS ABANDONED carries a last-saved handoff, not a final one. A write verb that is refused (`ENOT_OWNER`, `ETRACK_AMBIGUOUS`, `ECROSS_TRACK`, `ETRACK_SEALED`) wrote nothing: report it to the person and do not retry with other flags on your own.

Best-effort pre-inject (may be empty, blocked, or show an unexpanded command; if so, just do the primary path above):
!`tpm session compose --mode "$ARGUMENTS"`
