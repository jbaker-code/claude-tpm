# `tpm-session-ops.js` — session write-ops + import (#1115)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The node-invokable session **write-ops** + **#1115 import** tool for `kind:"session"` records (P06). It
operates off the canonical JSON and, on every write, regenerates the derived human `.md` via the
converter (`now` bound in a closure). Composes `lib/session-model.js` + `lib/session-converter.js` —
re-implements none of the model/converter/IO primitives.

Format authorities (cross-referenced, not restated here): [`../json-format-spec.md`](../json-format-spec.md)
(the JSON envelope + editable-vs-mechanical table) and [`../export-spec.md`](../export-spec.md) (the human
render). Overview + file map: [`README.md`](README.md). Export tool: [`tpm-session-export.md`](tpm-session-export.md).

**Run (Q5 — no bin, no npm-run):** each verb is a TOP-LEVEL session verb — the old `ops` grouping was
flattened away, so call the verb directly (typing the removed `ops` token now just hints at this form).
```
tpm session <verb> [flags]
```
Programmatic callers `require('./tpm-session-ops')` for `opOpen / opSave / opNote / opPunchlist /
opClose / opImportHandoff / opImportLog / opImportPunchlist` (each returns the persisted record).

## Common flags
| Flag | Meaning |
|------|---------|
| `--sessions-dir <dir>` | directory of `session-<NNNN>.json` (a SCRATCH or real dir; created for `open`). **Optional:** omitted, it is resolved from the project root's `.claude/claude-tpm/config.json` (`session.notes.sessionsDir`); the flag overrides. |
| `--session <NNNN>` | session number (aka `--number`). **Always 4-digit zero-padded** — `--session 1` is normalized to `0001`, so the on-disk folder (`session-0001/`) and the stored `meta.number` always agree (#3). |
| `--track <letter>` | which track to write (`a`..`z`; a letter only - a session designator like `0001b` is rejected, `ESESSION_DESIGNATOR`, exit 2). Default: the unsealed track **you own**, found by your Claude session id (`$CLAUDE_CODE_SESSION_ID`). Needed when you own none, or (with no readable session id) when several tracks are unsealed (see "Tracks" below). The resolution happens inside each op (`ownTrack`), so programmatic callers get the same protection as the CLI. |
| `--now <iso>` | reference time for punchlist age (default: now, local offset). |

Each write: canonical JSON is written **atomically first**, then the derived `session-<NNNN>.md` is
regenerated **only after** the JSON write succeeds. The `.md` is itself written by temp-file + atomic rename, so a reader never sees a half-written `.md` while another instance saves.

## Ops
| Verb | Flags | Effect |
|------|-------|--------|
| `open` | `--session-id <id>` `[--tpm-version v]` `[--prior-session-path <json>]` | mint a fresh session; a prior session's still-open punchlist items carry forward (same slug, new id, `{op:"carry-in", fromSession:<prior number>}`). |
| `save` | — | re-persist current session (re-stamp `handoff.updatedAt`, regenerate `.md`). |
| `note` | `--log --status NOTE --text "…"` \| `--decision --what "…" --why "…"` | append ONE log entry (append-only, monotonic seq). |
| `punchlist` | `--action add\|close\|reopen\|drop\|carry-in` | `add`: `--text "…" [--slug s]`; `close/reopen/drop`: `--item <id\|slug>`; `carry-in`: `--from <prior json> --item <id\|slug>`. |
| `close` | — | **CLOSE-GUARD (#1115):** REFUSES unless a handoff **AND** a punchlist are both present (names what's missing); else stamps `meta.closedAt`. Seals ONLY your own track; no other track's file is opened for write. |
| `close --track <other>` | `--even-if-running` (alias `--confirm`), `--reason "…"` | The **abandoned seal** of a track a different Claude instance owns: writes a `session-NNNN[-x].sealed` marker (who sealed it, when, the owner's last write; the record is untouched, the close guard is skipped, NO handoff is written for it). The confirmation flag is ALWAYS required (no own-pid exemption); without it nothing is written, the track / last write / liveness are printed and the exit code is **4** (`ESEAL_NEEDS_CONFIRM`). Idempotent. Ask the person first. |
| `unseal` | `--session NNNN --track x` | Undoes another instance's seal: renames the marker to a hidden audit file `.session-NNNN[-x].sealed.unsealed-<ts>`. Manual equivalent: `mv session-NNNN-x.sealed <anywhere>`. A live owner whose track was sealed by someone else gets `ETRACK_SEALED` on its next `save`/`note`/`punchlist`/`import-*` (naming who sealed it and when; nothing it saved is lost) until this is run. A track its owner closed itself is never guarded. |

## Tracks: what write verbs do when several Claude instances share a session (verified)

A session folder holds one record per track (`session-0001.json` = track a, `session-0001-b.json` = b, …). Write verbs
(`save`, `note`, `punchlist`, `import-*`, `close`) act on the track you own; they never open another track's file for write.

**Item ids.** `--item` (and `--id`) take the stored form `123.4` or the lettered form `123a.4` (also `#123a.4`, zero padded); both name the same item. Track `a` ids are STORED as `123.4`; tracks `b`..`z` as `123b.4`. Printed ids (`added #1a.3`, `closed #1b.1`) use the lettered form only when the session has more than one track.

**Another track's item is refused by name.** `punchlist close|reopen|drop` on an item that is not on your track exits 1 with `ECROSS_TRACK` (`item #1b.1 [exportr] belongs to track b of session 0001 (owner bbbbbbbb..., live), not to your track c. Nothing was changed. ...`) and writes nothing. A bare slug resolves in YOUR record first (slugs are unique per track, not per session).

**The session lock.** Every mutating verb (`save note punchlist close import-*`, the abandoned seal and `unseal`) runs its whole read-modify-write under the shared `tools/lib/lock.js` lock at `<sessionsDir>/session-NNNN/.lock`; files and stdin are read before it is taken, it is released on a throw, a stale holder is broken per the lock contract, and a waiter gives up after ~45 s (`TPM_LOCK_WAIT_MS` shortens it). `open` and the parallel claim are exclusive creates and do not use it. Uncontended, the lock prints nothing and leaves nothing behind.
Real output (scratch store; instance A = `aaaa1111-0000`, B = `bbbb2222-0000`; node `tools/tpm.js session …`):

| Situation | Output | Exit |
|---|---|---|
| `note` on your own track | `tpm-session-ops note: logged NOTE (entry #1)` | 0 |
| `close` with no handoff | `tpm-session-ops: refusing to close session — missing a handoff. A session cannot be sealed without a handoff AND at least one punchlist item (#1115 close-guard).` | 1 |
| `close` ok | `tpm-session-ops close: session 0001 closed · handoff ✓ · 1 open punchlist item(s) carried (surface in the next session's boot-read)` | 0 |
| you closed your own track, B is still live, `note` **without** `--track` (Q-C7) | ``track b (bbbb2222...) of 0001 belong to another Claude session; this write was refused. Use `tpm session current --open` to choose`` plus JSON `{ "refused": true, "code": "ENOT_OWNER" }` | 1 |
| same, with `--track a` (your own closed track) | `logged NOTE (entry #1)` | 0 |
| `close --track b` (B's track, not yours), no confirmation | the plan JSON (`plan.track/state/lastWriteAt/owner/liveness/livenessLine`, `"sealed": false`), then `track b of 0001   live   owner bbbb2222   last write …   unknown (no process id recorded)` and `NOTHING was sealed. Show this to the person; only on an explicit yes re-run with --even-if-running.` | **4** |
| same with `--confirm --reason "owner died"` (alias of `--even-if-running`) | JSON with `"sealed": true` and the marker, then `tpm-session-ops close: track b of 0001 sealed as abandoned (no handoff was written for it; recorded in session-0001-b.sealed)` | 0 |
| B (the sealed owner) runs `save --track b` | ``track b of session 0001 was sealed by another session (claude aaaa1111, host …) at 2026-10-07T22:56:10-07:00 (reason: abandoned). Nothing you saved earlier is lost. To continue on this track, ask the person, then run: tpm session unseal --session 0001 --track b. Or open a new track: tpm session current --open --parallel.`` plus JSON `code: "ETRACK_SEALED"` | 1 |
| `unseal --session 0001 --track b` | JSON `{ "unsealed": true, "already": false, "auditPath": …/.session-0001-b.sealed.unsealed-20261007T2256100700 }` then `tpm-session-ops unseal: track b of 0001 un-sealed (marker kept as .session-0001-b.sealed.unsealed-…)` | 0 |
| `unseal` again | `tpm-session-ops unseal: track b of 0001 has no seal marker; nothing to do` (`"already": true`) | 0 |

The seal marker `session-0001-b.sealed` (track a: `session-0001.sealed`) is JSON: `schema`, `kind: "seal-marker"`, `number`, `track`,
`reason` (`abandoned` from `close --track`, `seal-and-new` from `current --open --seal-and-new`), `note` (the `--reason` text),
`sealedAt`, `sealedBy {claudeSessionId, claudePid, claudePidStartedAt, hostname, track}`, `ownerAtSeal`, `lastSaveSeen`, `lastWriter`.
The owner's record is untouched. A track sealed by its own `close` is sealed by its own `meta.closedAt`; the marker is the *other* way a
track becomes sealed. Either one makes the track sealed (see `claude-context/methodology/session-notes-format.md`).

The `--confirm` spelling is accepted everywhere `--even-if-running` is (observed on `close --track` and `current --open --seal-and-new`).
Exit codes of this tool: `0` ok · `1` refused or failed (guard, `ENOT_OWNER`, `ETRACK_SEALED`; JSON `refused:true` and `code` on stdout) · `4` abandoned seal needs confirmation.

## Import (#1115) — honors the LOCKED editable table (mechanical fields ignored; state never set by import)
| Verb | Flags | Semantics |
|------|-------|-----------|
| `import-handoff` | `--json-file <f>` \| `(--txt-file\|--file) <f> (--next "…" \| --next-file <f>) [--in-flight "…"]… [--must-not-redo "…"]…` | **REPLACE.** JSON = a handoff object OR a full session record (`.handoff` extracted). Text = raw file → `where`; `next` supplied via flag/file (replace-semantics cannot invent the required `next` → fails loud if absent). |
| `import-log` | `(--txt-file\|--file) <f> [--status NOTE \| --decision --why "…"]` | **APPEND-ONLY.** File contents become one log entry's body; existing entries never rewritten; monotonic seq preserved. Removes the thin-log friction (multi-line body, no shell-escaping). |
| `import-punchlist` | `(--file\|--txt-file) <f>` | **ADD/merge.** File = a JSON array (strings or `{text}`), or one item per non-empty text line. Each becomes a new **open** item; state is never set by import. |

> **#2 (smoke): `--txt-file` and `--file` are aliases** — every import verb accepts both spellings, so
> you never have to remember which flag a given `import-*` uses.

The loosened all-or-none rule (#1115 D): partial file-driven writes are allowed by design, but each
write's canonical JSON is still atomic.

## Examples
```
tpm session open --sessions-dir /tmp/s --session 0021 \
    --session-id abc --tpm-version 1.0.0 --prior-session-path /tmp/s/session-0020.json
tpm session import-handoff --sessions-dir /tmp/s --session 0021 \
    --txt-file where.txt --next "wire the router"
tpm session import-log --sessions-dir /tmp/s --session 0021 --file entry.txt
tpm session punchlist --sessions-dir /tmp/s --session 0021 --action add --text "do X"
tpm session close --sessions-dir /tmp/s --session 0021
```

Tests: `tools/session/tests/session-ops.test.js`, `session-ops-tracks.test.js`, `session-seal.test.js`, `tracks-lifecycle.test.js`, `tracks-forced-order.test.js`, `session-md-atomic.test.js`, `session-ops-xtrack.test.js`, `session-lock-wrap.test.js`, `session-lock-forced.test.js` (each run as a single file: `node tools/session/tests/<file>`).
