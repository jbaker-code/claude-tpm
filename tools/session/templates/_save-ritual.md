Run the **FIXED 3-step ritual** — one skill, no menu: do all three in order, every save. The punchlist/log steps are
judgment (the tool cannot know an item got done unless told); the handoff is the mechanical gate.

1. **Reconcile the punchlist.** For each work item finished since the last save, run
   `tpm session punchlist --session <NNNN> --action close --item <id|slug>`; for each newly-surfaced item,
   `tpm session punchlist --session <NNNN> --action add --text "<text>"`. Read what is still open from the derived
   `.md` of YOUR track (`session-NNNN.md` on track a, `session-NNNN-<letter>.md` on track b..z) `## Punchlist` section (or `export`). This is the single source of truth for open work — the
   handoff's "In flight" carries it forward, so tick things off HERE, not in prose.
2. **Append any ledger lines.** For a decision worth landmarking, `tpm session note --session <NNNN> --decision --what "<what>" --why "<why>"`;
   for a plain record line, `tpm session note --session <NNNN> --log --status <TAG> --text "<text>"`.
   Append-only — skip this step if nothing new is worth logging.
3. **Write the handoff, then persist.** Replace the handoff with `tpm session import-handoff --session <NNNN>` — either
   `--json-file <f>` (a handoff object, or a full record whose `.handoff` is extracted) or `--txt-file <f> --next "<next>" [--in-flight "…"]… [--must-not-redo "…"]…`
   (the text file becomes `where`; `next` is required and cannot be invented). Write `where`/`next` like you're leaving
   a note for a cold resume, not transcribing the turn. Then `tpm session save --session <NNNN>` re-persists and re-renders the record.
   - **exit 1 (refused):** `import-handoff` fails loud when the required `next` is missing/empty or the JSON is unreadable — **nothing was written**; the message names what's wrong. Fix and re-run; do NOT proceed as if the handoff landed.
   - **exit 0 (success):** your track's canonical record (`session-NNNN.json` on track a, `session-NNNN-<letter>.json` on track b..z) was written and its derived `.md` regenerated.

**Rewrite, not append:** `import-handoff` REPLACES the handoff wholesale each time (the ledger and punchlist are append/mark-only);
repeated saves in one session keep updating the SAME `session-NNNN` record — never spawn a new session number. Only
`tpm session current --open` allocates a new number.
