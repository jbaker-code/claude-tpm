Notes WRITE verbs are TOP-LEVEL session verbs (`tpm session <verb> --session <NNNN> [args]`). One canonical
record per track (`session-NNNN.json` for track a, `session-NNNN-b.json` … for later tracks) + a derived `.md` beside each;
every write is atomic and the `.md` is regenerated from the JSON. Write verbs act on YOUR track (resolved from your Claude
session id); pass `--track <letter>` only when told to, and never write to a track another session owns.
- `note (--log --status <TAG> --text "<text>" | --decision --what "<what>" --why "<why>")` — the append-only ledger.
- `punchlist --action add|close|reopen|drop|carry-in` — the work items (`add --text "…" [--slug s]`; `close/reopen/drop --item <id|slug>`; `carry-in --from <prior json> --item <id|slug>`). There is **no `list`** — read open items from the derived `.md` `## Punchlist` section or `export`.
- `import-handoff (--json-file <f> | --txt-file <f> --next "…"|--next-file <f> [--in-flight "…"]… [--must-not-redo "…"]…)` — REPLACE the handoff. Fails loud (exit `1`) if the required `next` is absent or the JSON is unreadable.
- `save` — re-persist + re-render the current record (no content args).
- `close` — the seal of YOUR track: **REFUSES (exit `1`, naming what's missing) unless a handoff AND at least one punchlist item are present**; otherwise stamps `meta.closedAt`. `close --track <another instance's letter>` is the ABANDONED SEAL of a dead instance's track: it needs `--even-if-running`, exits `4` and writes nothing without it; ask the person (show the evidence) before you pass it. `unseal --session <NNNN> --track <letter>` undoes someone else's seal of a track.
- **Refusals are not errors to route around.** A write that is refused wrote nothing; read the message, tell the person, do not retry with other flags until they say so.
  - `ENOT_OWNER` (exit 1): none of the unsealed tracks is yours (you closed yours, or your id changed) - run `tpm session compose --mode open` to reach the open gate; `--track <your own letter>` is only for a track you own.
  - `ETRACK_AMBIGUOUS` (exit 1): your Claude session id is unreadable and several tracks are unsealed - ask the person which letter is theirs, then pass `--track <letter>`.
  - `ECROSS_TRACK` (exit 1): a `punchlist close|reopen|drop` named an item that belongs to another track (`#1b.1` is track b's). Each track changes only its own items; ask that instance. Item ids work as `#1.4` or `#1a.4` (the lettered form); a bare slug resolves in YOUR track first (slugs repeat across tracks).
  - `ETRACK_SEALED` (exit 1): someone sealed your track as abandoned. Nothing you saved is lost. Tell the person; do NOT `unseal` without their say-so.
- `punchlist --action carry-in --from <prior track's json> --item <id|slug>` records where an item came from (`fromSession` `0001b` = session 0001, track b).
- `import-log` / `import-punchlist` — file-based append/add.
- `tpm session export --last N | --session NNNN[,NNNN] --style json|human|both` — the notes READ API.
