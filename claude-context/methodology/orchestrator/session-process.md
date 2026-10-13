# Session Notes Process

This document defines how Claude keeps continuity across sessions using the configured sessions dir
(`session.notes.sessionsDir`; default `.claude/claude-tpm/sessions`) — and it is a MECHANISM doc, not
a set of manual steps: the `tpm-session`
skill + `tools/session/` own the actual work described below. Read this to understand what happens,
not as instructions to execute by hand.

Each session's memory lives in **two files** in its `session-NNNN/` folder — ONE canonical
`session-NNNN.json` (the source of truth) and ONE derived `session-NNNN.md` (a human view with
`## Handoff` / `## Punchlist` / `## Log` sections, regenerated from the JSON on every write). Both are
prefixed with the four-digit session number; the record carries `schemaVersion 1.0.0`. See
`claude-context/methodology/session-notes-format.md` for the full shape; this doc covers the lifecycle
around it.

## On start (boot)

`tpm-session open` (composed by `tpm session compose --mode open` from `tools/session/templates/open.md`):
1. Allocates or confirms the current session via `tpm session current --open`
   (idempotent — it finds YOUR track by Claude session id and resumes it; otherwise it creates the session
   folder AND your track's record. If another Claude session still has an unsealed track it REFUSES with
   exit 3 and writes nothing. `.current-session.json` is only a non-authoritative hint kept true).
2. Runs `tpm session boot-read` to pull the PRIOR session's state into context. This is
   a **tool call, not the model choosing to open a file** — its stdout is the pickup payload. Because it
   runs after step 1's `--open`, it excludes the session YOUR instance owns and emits what the prior session(s) left:
   - **Readable prior session:** the prior handoff slice verbatim + its open punchlist headlines + the
     canonical `session-NNNN.json` and derived `session-NNNN.md` file locations + the "log reads
     newest-first" reminder.
   - **A prior session that ran several parallel tracks** (one per Claude instance): one block per track —
     its state (sealed by its owner / sealed as abandoned by another instance / still live), its handoff
     verbatim, its open items, its file locations — then one combined open-items list. A track a later session already
     picked up (it opened strictly after the track settled) is left out and named in the header; a live or abandoned
     track is labelled, never hidden. Keep the tracks apart; reconcile them before acting.
   - **Unparseable / unknown-schema prior session:** SKIPPED — boot-read degrades to one clean line and
     keeps looking; the `lib/` model's migrate step refuses an unknown-newer schema rather than crashing.
   - **No readable prior session:** a clean "no prior session found — this looks like the first session" line.
   `boot-read` exits 0 on every data problem (it never crashes boot; the sole non-zero exit is a malformed `--track` with no value, exit 2); it self-resolves the sessions dir via config.

## During a session

Checkpoint with `tpm-session save` (or bare `tpm-session` once a session is already open) whenever
there's a coherent state worth capturing. The punchlist and ledger verbs are **live** — usable any time,
not just at save: `ops punchlist --action add|close` as work items surface and finish, `ops note --log`/
`ops note --decision` as decisions and record-worthy events happen. `save` then re-persists the record.
See `session-notes-format.md` for exactly what belongs where.

## What `save` does — the fixed 3-step ritual

**This is `tpm-session save`, not a manual "create a new numbered folder" step.** The skill body is a
FIXED 3-step ritual — one skill, no menu, so it reads as "do all three," not a set of options:

1. **Reconcile the punchlist.** `ops punchlist --action close --item <slug|id>` for finished items;
   `--action add --text "<text>"` for newly-surfaced ones; `--action carry-in --from <prior json>
   --item <slug>` to pull a prior session's unfinished work forward as OPEN. Each op appends to the
   item's `events[]` audit trail. There is no `list` verb — read open items from the derived
   `session-NNNN.md` `## Punchlist` section (or `tpm session export`).
2. **Append any ledger lines.** `ops note --decision --what "<what>" --why "<why>"` for a landmarked
   decision; `ops note --log --status <TAG> --text "<text>"` for a record line. Append-only; skip if
   nothing new is worth logging.
3. **Write the handoff, then persist.** Replace the handoff via `ops import-handoff` (`--json-file <f>`,
   or `--txt-file <f> --next "<next>" [--in-flight …]… [--must-not-redo …]…`), then `ops save`
   re-persists + re-renders. The handoff REPLACE is the mechanical gate — the one thing always true of a
   save is a complete handoff.

The tool talks back via exit code AND a message:
- **exit 1 — refused:** `import-handoff` fails loud when the required `next` is missing/empty or the JSON
  is unreadable; **nothing was written**; the message names what's wrong. Fix and re-run.
- **exit 0 — success:** the canonical `session-NNNN.json` was written and the derived `session-NNNN.md`
  regenerated from it.

The gate lives on the handoff because that is the one thing that must be complete for pickup to be
reliable. The punchlist and ledger writes are judgment (the tool cannot know an item got done unless
told), so they are ritual, never a mechanical requirement that would false-fail a valid save.

## Session numbering + first save of a session

1. `save` resolves the CURRENT session (the one `open` established; your track is found by Claude session id,
   not by `<sessionsDir>/.current-session.json`, which is only a kept-true hint) — it does **NOT** create a new folder on every save. Repeated
   saves within one session rewrite the SAME `session-NNNN/session-NNNN.json` wholesale (and re-render
   the `.md`).
2. `current --open` itself creates the folder + the canonical record (empty sections, owner stamped in `meta`) so
   the derived `.md` reveals where memory lives; the manual `ops open` never overwrites an existing record.
3. A genuinely NEW session (no session currently open — a fresh `tpm-session open`, or the prior
   session's pointer was closed by `current --seal`) allocates the NEXT number: highest existing
   `session-NNNN` + 1, zero-padded to **four** digits, allocated automatically by `tpm session current --open`.
4. A prior session's record is **never** overwritten by a later one — `close`'s seal step
   (`ops close`) stamps `meta.closedAt` on YOUR track only, and `current --seal` closes the hint only when no track of the session is still unsealed.

**Numbering convention:** folders are `session-NNNN`, **four-digit** zero-padded, sequential, highest
number = most recent session. What the tool owns is WHO allocates the number and WHEN (a genuinely new
session, not every `save`/`close` within one).

## Wrap-up

`tpm-session close` (composed by `tpm session compose --mode close` from `tools/session/templates/close.md`) runs the reap ritual, delegates to
the gated `save` for the final checkpoint (reconcile punchlist → append ledger lines → write the handoff
via `ops import-handoff`, honoring exit codes — a refused `import-handoff` wrote nothing, so fix and
re-run before sealing), seals the record via `ops close` (the close-guard REFUSES unless a handoff AND a
punchlist item are present) and the pointer via `current --seal`, nudges `/export`, and signs off. See
that file for the full sequence.
