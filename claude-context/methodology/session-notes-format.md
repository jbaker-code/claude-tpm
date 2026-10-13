# Session-notes format — the JSON-first session memory + a human-reading reference

**What this is.** The canonical shape of a session's memory. Each `session-NNNN/` folder holds, per track, **two
files** (a single-instance session is just track a; see "Tracks" below): ONE canonical `session-NNNN.json` (the single source of truth) and ONE derived
`session-NNNN.md` (a human-readable view with `## Handoff` / `## Punchlist` / `## Log` sections). Both
are prefixed with the four-digit session number, so no two sessions share a basename if pulled into a
shared folder. The tools under `tools/session/` OWN these formats — the orchestrator never hand-emits
them. The JSON is authoritative; the `.md` is **regenerated from the JSON on every write** and carries a
"do not hand-edit" banner. This doc is the reading reference; the shared `lib/` model
(the `session-model` + `session-schema` modules under `tools/session/lib/`) derives all read/migrate/validate/render
logic, and the per-tool docs (`tpm-session-ops.md`, `tpm-session-export.md`) are the verb-level SSOT.

## Why one JSON + one derived `.md` (not three markdown files)

An earlier design kept everything in three markdown files (`-handoff.md` / `-punchlist.md` / `-log.md`),
which coupled parse and render and let the files drift. The JSON-first design keeps a single canonical
record with one clean write path per part, and renders the human `.md` from it — the `.md` can never
drift from the JSON because it is never the source. The three jobs the original brief asked for still
hold, now as sections of one record:

1. **Resume-if-it-dies** → the `handoff` object (rendered as `## Handoff`; a cold resume reads it first).
2. **Decisions + rationale** → `log[]` entries of `type:"decision"` (rendered under `## Log`).
3. **Open items that are drifting** → the `punchlist[]` array (rendered as `## Punchlist`; items stay
   *candidates* for promotion to the task ledger; promotion stays manual).

## The tools that own it

| Part | Written by | Read by |
|---|---|---|
| the record (open / persist / seal) | `tpm session open` / `save` / `close` | `tpm session export`, `tpm session boot-read` |
| `handoff` | `tpm session import-handoff` (REPLACE) + `save` | export / boot-read |
| `log[]` | `tpm session note` (`--log` / `--decision`) + `import-log` (append-only) | export |
| `punchlist[]` | `tpm session punchlist --action add\|close\|reopen\|drop\|carry-in` + `import-punchlist` | export / boot-read (open headlines) |

Every write rewrites the canonical `session-NNNN.json` atomically, then regenerates the derived
`session-NNNN.md` from it. Reads never parse the `.md` back.

## Numbering + schema version

Session folders are `session-NNNN` — **four-digit**, zero-padded, sequential; the next number is
allocated by `tpm session current --open` (idempotent). The canonical record carries
`"schemaVersion": "1.0.0"` and `"kind": "session"`. The `lib/` model gates on the schema version: an
unknown-newer schema is refused by the migrate step (so a corrupt or future record is skipped, never
crashed on), and an old 3-file markdown session is converted only by the opt-in `tpm session migrate`
(see "Version gate + migration").

## Tracks — more than one Claude instance in one session folder

A `session-NNNN/` folder holds **one record per track** (one per Claude instance working in it), not one record per folder.
Layout of a two-track folder that has seen an abandoned seal (this is what the tools wrote in a scratch store):

```
session-0001/
  session-0001.json        track a  (the unsuffixed, pre-tracks name: an old single record IS track a)
  session-0001.md          track a  derived view
  session-0001-b.json      track b  (b..z, at most 26 tracks)
  session-0001-b.md        track b  derived view
  session-0001-b.sealed    optional marker: track b was sealed by ANOTHER instance (abandoned seal)
  .session-0001-b.sealed.unsealed-20261007T2256100700    audit copy left when a marker is undone
.current-session.json      (in the sessions dir) a non-authoritative hint, derived from the tracks
```

**Ownership is additive `meta`.** Each track record carries, inside `meta`, who owns it. Real values from a scratch record:

```json
"meta": {
  "number": "0001", "track": "b",
  "sessionIds": ["bbbb2222-0000"],
  "claudeSessionId": "bbbb2222-0000",      // the CURRENT owner (what "which track is mine" matches)
  "claudePid": null, "claudePidStartedAt": null,   // liveness evidence; null when unavailable
  "hostname": "admins-Virtual-Machine.local",
  "openedAt": "...", "closedAt": null, "tpmVersion": "0.0.0",
  "lastWriter": { "version": "0.2.0-dev", "at": "2026-10-07T22:56:09-07:00" }
}
```

- `track`, `claudeSessionId`, `claudePid`, `claudePidStartedAt`, `hostname` are the ownership fields; `sessionIds[]` is every Claude id that ever
  wrote the track. Matching is by the **current** `claudeSessionId`, never by `sessionIds`.
- **`meta.lastWriter {version, at}`** is stamped by every write: the tpm version that wrote and when. It lets a newer tool see that a record was last
  touched by an older one. Informational only; nothing gates on it.
- `meta.adoptions[]` (only after an `--adopt`): `{ at, from {claudeSessionId, claudePid, hostname}, via }` (observed `via`: `"adopt --even-if-running"`); the new owner's id replaces `claudeSessionId` and is appended to `sessionIds`.
- A pre-tracks record (no `claudeSessionId`) is still owned if its `sessionIds[]` is non-empty: the owner is read from the last entry (observed: a record with `sessionIds:["old"]` is refused to a different instance as `owner old`, exit 3). Only a record with an **empty** `sessionIds[]` and no ownership fields is **unowned**: it is track a, and the first instance to `--open` resumes it (observed: exit 0, `gate: "resume"`).

**There is NO `schemaVersion` bump.** Every track record is still `"schemaVersion": "1.0.0"`. The new keys are additive inside `meta`, and unknown
fields survive a round trip. Observed with the frozen `../old/claude-tpm-0.2.0` reader (read-only): it reads track a normally and silently skips
`session-NNNN-b.json` (a name it does not recognise); it never crashes on a new record (`tracks-lifecycle.test.js`, L12).

**What "sealed" means — exactly one rule (`trackState()` in `tools/session/lib/session-tracks.js`).** A track is sealed if EITHER:

1. its own record has `meta.closedAt` set (its owner ran `tpm session close`: a *handoff-bearing* seal), OR
2. a `session-NNNN[-x].sealed` marker file sits beside it (another instance sealed it as **abandoned**: no handoff is written; the record is untouched).

The marker is JSON: `{ schema: 1, kind: "seal-marker", number, track, reason ("abandoned" | "seal-and-new"), note, sealedAt, sealedBy {claudeSessionId, claudePid, claudePidStartedAt, hostname, track}, ownerAtSeal, lastSaveSeen, lastWriter }`.
Undoing it (`tpm session unseal`) renames the marker to the hidden audit file above. A track whose owner closed it itself is never guarded by a
marker. A sealed track refuses writes from its owner (`ETRACK_SEALED`); the sealed record itself is never rewritten by the sealer.

**The hint.** `.current-session.json` is derived from the tracks and kept true (`closedAt` is `null` iff some track of that session is unsealed), only so older
tpm versions that read it keep working. New code never decides "current" from it.

**Atomicity.** Every write described here is atomic: the canonical JSON, the derived `.md` (temp + rename, written only after the JSON), the track-record
claim (`link` from a prepared temp, never an overwrite), the `.sealed` marker and the hint.

## Reading across tracks

Ids, slugs and the pickup, as built (each shown in `tools/session/tpm-session-ops.md`, `tpm-session-boot-read.md`, `tpm-session-export.md`).

- **Ids.** Item ids are minted per track: track a keeps the stored form `1.4`, tracks b..z are stored as `1b.4`. `--item` takes either the stored
  or the lettered form (`1a.4`, `#1a.4`). Printed ids carry the letter only when the session has more than one track.
- **Slugs are unique per record, not globally.** Two tracks of one session can each hold an item with slug `alpha` (observed: `added #1a.1 [alpha]`, then
  `added #1b.1 [alpha]`). A bare slug resolves in YOUR track's record first; across tracks use the lettered id.
- **Another track's item is read-only to you.** `punchlist close|reopen|drop` on it is refused (`ECROSS_TRACK`, exit 1) and writes nothing.
- **Carry-forward keeps provenance.** `carry-in` from a track's record stamps `fromSession` with the session number plus the track letter
  (`0001b`; track a stays `0001`).
- **The pickup.** A new session's `boot-read` prints one block per pending track (state: sealed by its owner / sealed as abandoned / still live / left open),
  each track's handoff, and one combined open list tagged by track. A track is left out only when a LATER session opened strictly after the track settled
  (sealed, or for a never-closed legacy record its last write); a live track is always shown. Nothing is stored for this: it is recomputed from timestamps.
- **Merged reads.** `export --style human` of a multi-track session is ONE document (a table of tracks, each track's section, the combined open punchlist).
  JSON is one record per track. With `--combine per-file` the JSON names keep the letter (`session-0001-b.json`) but the human export is a single merged
  `session-0001.md` - not one `.md` per track.
- **Doctor.** Checks every track against its own `.md`; reports `OWNER-GONE`, `STALE`, `TRACK-MISMATCH` (including a file that collides with another
  claimant - one finding, not two), a stray `session-NNNN-a.json` (`DUPLICATE-TRACK`), orphan markers and lock leftovers.

## The canonical record — `session-NNNN.json`

The source of truth (verified shape):

```json
{
  "schemaVersion": "1.0.0",
  "kind": "session",
  "meta": {
    "number": "0005",
    "sessionIds": ["abc-123"],
    "openedAt": "2026-09-21T01:38:50-07:00",
    "closedAt": "2026-09-21T01:39:26-07:00",
    "tpmVersion": "0.0.0"
  },
  "handoff": {
    "where": "wrapped stage C doc rewire",
    "next": "verify the docs",
    "in_flight": ["one thing"],
    "must_not_redo": [],
    "updatedAt": "2026-09-21T01:39:26-07:00"
  },
  "log": [
    { "seq": 1, "ts": "2026-09-21T01:38:50-07:00", "type": "log", "status": "DONE", "text": "did the thing" },
    { "seq": 2, "ts": "2026-09-21T01:38:50-07:00", "type": "decision", "what": "chose X", "why": "because Y" }
  ],
  "punchlist": [
    {
      "id": "5.1",
      "slug": "x0hvc0",
      "text": "open item one",
      "state": "open",
      "createdAt": "2026-09-21T01:38:50-07:00",
      "events": [ { "ts": "2026-09-21T01:38:50-07:00", "op": "add" } ]
    }
  ]
}
```

- **`meta`** — `number` (padded four-digit string), `sessionIds[]` (the real Claude Code session ids
  seen), `openedAt` (set by `ops open`), `closedAt` (stamped by `ops close`; unset while the session is
  live), `tpmVersion`.
- **`handoff`** — the pickup doc. `where` + `next` are the load-bearing pair; `in_flight[]` and
  `must_not_redo[]` are optional string arrays; `updatedAt` marks the last handoff write. `ops
  import-handoff` REPLACES this object wholesale (it will not invent a missing `next`).
- **`log[]`** — append-only, `seq`-ordered. Each entry is `type:"log"` (`status` + `text`) or
  `type:"decision"` (`what` + `why`), with an ISO-TZ `ts`.
- **`punchlist[]`** — each item has an `id` (`#<session>.<n>`), a durable base36 `slug`, `text`, a
  `state` (`open`/`closed`/dropped), `createdAt`, and an `events[]` audit trail (`add`/`close`/`reopen`/
  `drop`/`carry-in`). The slug is unique within one record only (see "Reading across tracks"). See `tpm-session-ops.md` for the full verb + carry-in mechanics.

## The derived view — `session-NNNN.md`

Regenerated from the JSON on every write; **do not hand-edit** (the banner says so). Verified render:

```markdown
# Session 0005 · 2026-09-21

> _Generated from `session-0005.json` — do not hand-edit; regenerated and overwritten on every save._
> _Change it via `tpm session` ops or import (`#1115`). · session 0005 · **open** · schema 1.0.0 · id abc-123 (generated from: 2f20b593efd2)_

## Handoff

**Where we are:**
wrapped stage C doc rewire

**Next:**
verify the docs

**In flight:**
- one thing

## Punchlist

**Open (1)**
1. `#7.2` item B _(0m ago)_

**Done (1)**
- ~~`#7.1` item A~~ _(closed 01:51)_

## Log
_Newest first._

2026-09-21 01:38:
🔹 DECISION — chose X
why: because Y

2026-09-21 01:38: DONE — did the thing
```

- **Header banner** carries the "generated from JSON" warning + the session number, open/closed state,
  schema version, and session id. It is a human-readable comment, not front-matter.
- **`## Handoff`** renders `where` / `next` / `in_flight`; before the first handoff write it reads
  `_No handoff yet — session opened, not yet saved._`. `must_not_redo` renders only when non-empty.
- **`## Punchlist`** splits into `**Open (N)**` (numbered) and `**Done (N)**` (struck-through, stamped
  `(closed HH:MM)`); each item shows its `#<session>.<n>` id.
- **`## Log`** reads **newest first** (note the `_Newest first._` header — the opposite of the old
  file's bottom-to-top log), decisions marked `🔹 DECISION`, log lines as `<TAG> — <text>`.

## Write disciplines, restated

- **`handoff` — REPLACE.** `ops import-handoff` rewrites the whole handoff object each time (fails loud,
  exit 1, if the required `next` is missing or the JSON is unreadable); `ops save` re-persists +
  re-renders. Pickup state can't drift because the `.md` is regenerated, never authored.
- **`log[]` — append-only.** `note --log` / `note --decision` (and `import-log`) only ever append; no
  verb rewrites a past entry. A long session reconciles the *handoff* at close, not by piling addenda
  into the log.
- **`punchlist[]` — mechanical.** `add` appends; `close`/`reopen`/`drop` flip state; `carry-in` copies a
  prior item forward. Safe to run any time, one path per verb.

## The close-guard + immutability

`ops close` is the seal. It **REFUSES (exit 1, naming what's missing) unless a handoff AND at least one
punchlist item are present**; otherwise it stamps `meta.closedAt`. The current-session hint is refreshed
by `tpm session current --seal` (it closes only when no track of the session is still unsealed), so the next
bare `tpm-session` opens fresh instead of reusing the folder. `claude-context/` is off-limits to subagent writes
(`project-workspace.md` §"Subagent write boundaries"), so a subagent never touches session memory at all.

## Version gate + migration (opt-in, no silent back-compat)

The `lib/` model reads records at `schemaVersion 1.0.0`; an unknown-newer schema is refused by the
migrate step and simply skipped (never crashed on) — this is why `boot-read` and `doctor` degrade
cleanly. Old 3-file markdown sessions are **not** read in place: `tpm session migrate --in <dir>
--out-dir <dir>` is the opt-in converter that rewrites ONE old session into the canonical JSON, and
`tpm session doctor` detects drift and suggests a migrate. `boot-read` walks prior sessions newest first and
emits every pending track (see "Reading across tracks"), skipping and listing anything it can't parse; if none qualify it
reports the first-session case. It exits 0 on every data problem; the one non-zero exit is a malformed command line
(`--track` with no value, exit 2). A migrated record's `handoff.updatedAt` is the source's own latest real timestamp (an
explicit `--now` overrides it); a legacy session migrated by an older build carries the now-stamp of its migration instead.

## Timestamps — ISO-8601 with a real timezone offset

All timestamps are local time with an explicit offset: `2026-09-21T01:38:50-07:00`. The model builds
this from local components and derives the offset from the machine's timezone — it deliberately does
**not** use `Date.toISOString()` (always UTC `Z`). On a UTC host the offset renders `+00:00`. Tools and
tests assert the *shape* (`…[+-]HH:MM`), never a literal offset.

## Length + tone

Keep the record dense and landmarked. The handoff is short by design (`where` / `next` + two optional
lists); a long session's history lives in the append-only `log[]`, and the coherent "where we are"
summary is re-snapshotted into the handoff at each save, so it never grows addenda.
