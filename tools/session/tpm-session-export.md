# `tpm-session-export.js` — session export (`#1113`)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The node-invokable export tool for `kind:"session"` records (P05). It reads canonical JSON through the
model's load path (read → migrate → validate) and emits JSON and/or the human render — one session or
many, combined or per-file. It **composes** the blessed shared pieces (`loadSession`,
`session-converter.render`, and the scaffold's `selectRecords`/`combine`/`dispatch`) and re-implements
none of them.

**Run (Q5 — no bin, no npm-run):**
```
tpm session export [flags]
```
Programmatic callers `require('./tpm-session-export')` for `exportSessions(opts)` (plus helpers
`resolveRecords`, `resolveUnits`, `sessionNumbers`, `enumerateSessions`, `normalizeStyles`, `padNumber`).

## Flags

| Flag | Meaning |
|------|---------|
| `--sessions-dir <dir>` | directory of `session-<NNNN>.json` (a SCRATCH or real dir). **Optional:** omitted, it is resolved from the project root's `.claude/claude-tpm/config.json` (`session.notes.sessionsDir`); the flag overrides. |
| `--last N` | export the N most-recent **sessions** (a session with several tracks counts once), **newest first**. |
| `--track <letter\|id>` | narrow every selected session to ONE track: a letter `a`-`z`, or at least 8 characters of its owner's Claude session id (case-insensitive). An unknown value is an error (`ENO_TRACK`, exit 1), a malformed one is `ETRACK_SELECTOR` (exit 2) - never an empty result. A sealed or unreadable track is selectable. |
| `--session <NNNN>[,NNNN] …` | explicit selector list (repeatable / comma-list) — the `#1092` seam, resolved in the order given; no re-matching. A number only: `0001b` is rejected (`ESESSION_DESIGNATOR`, exit 2) - pick the track with `--track b`. |
| `--style json\|human\|both` | output format(s); repeatable / comma-list. Default `json`. |
| `--combine one-file\|per-file` | multi-session: ONE combined file (default) or per-session files. |
| `--out <dir\|file>` | write here (dir = one file per `suggestedName`; a `.json`/`.md` path = a single file). Omit → stdout. |
| `--now <iso>` | reference time for punchlist age (default: now, local offset). Bound once per export in a closure so open items render an age. |

## Export shapes

- **Single session — full JSON:** the bare canonical envelope (carries `schemaVersion`). `--session <one>`.
- **Single session — human:** the converter's `.md` (one-way, NOT re-importable).
- **Multi (combined, Q4):** JSON = a **bare array** of session envelopes (no wrapper); human = the **full
  per-session render repeated** per session (one `# Session NNNN` header each, not one top header).
  `--combine one-file` (the multi default).
- **Multi (per-file):** one file per session, `session-<NNNN>.{json,md}`; a session with several tracks writes one JSON per track (`session-<NNNN>-b.json` ...) but still ONE merged `.md`. `--combine per-file`.
- **JSON and/or human:** `--style json` / `human` / `both`. With `both` + per-file, each session yields
  both a `.json` and a `.md`.

Combined shape and the repeated-header rule are the authority of
[`../export-spec.md`](../export-spec.md) § *Export surface* (Q4) — see it for the locked details.

## The search-composition seam (`#1092`)

Candidates resolve three ways, in precedence order (in `resolveRecords`), then an optional `filter`
composes over them via the scaffold — matching is never reimplemented here:

1. `opts.records` — a pre-loaded, already-validated result-set (no dir needed).
2. `opts.selector` / `--session` — an explicit id/selector list; a miss fails loud.
3. `opts.last` / `--last N` — the N highest-numbered sessions, newest first.

A selection that resolves to no sessions fails loud, with the message depending on which path came up
empty:
- an explicit `--session`/`opts.selector` entry that names a missing session →
  `tpm-session-export: selector '<sel>' matched no session-<NNNN>.json in '<dir>'`;
- any other empty resolution (e.g. an `opts.records`/`filter` path, or `--last N` over an empty dir) →
  `tpm-session-export: the selection resolved to zero sessions`.

## Thin/editable export — NOT wired (Q3)

There is no thin/editable session export and no `--thin` flag; `normalizeStyles` accepts only
`json|human|both`. `trimNonEditable` stays in the base lib for `#1112` but is not wired to any session
CLI flag.

## Examples (run-verified against a scratch dir)

```
# single-session full JSON to stdout
tpm session export --sessions-dir /tmp/s --session 0050 --style json
#   -> {
#        "schemaVersion": "1.0.0",
#        "kind": "session",
#        "meta": { "number": "0050", …

# last 2 sessions, combined human — one # Session header per session
tpm session export --sessions-dir /tmp/s --last 2 --style human
#   -> 2 "# Session NNNN" headers

# last 2 sessions, combined JSON — a bare array of envelopes
tpm session export --sessions-dir /tmp/s --last 2 --style json
#   -> [
#        {
#          "schemaVersion": "1.0.0",
#          …

# per-file, both styles, into an out dir
tpm session export --sessions-dir /tmp/s --last 2 --style both --combine per-file --out /tmp/s/out
#   -> wrote 4 file(s):
#        /tmp/s/out/session-0051.json
#        /tmp/s/out/session-0050.json
#        /tmp/s/out/session-0051.md
#        /tmp/s/out/session-0050.md
```

`--last N` emits newest-first (descending session number); an explicit `--session` selector preserves the
order you give.

## Sessions with several tracks (phase 12)

A session folder may hold one record per track (`session-0001.json` = a, `session-0001-b.json` = b, ...). Without `--track`, every
track is read; the state of each comes from `T.trackState` (a track sealed by someone else's marker still has a JSON record whose
`meta.closedAt` is `null` and a `.md` that says "open" - the marker wins, and nothing here ever rewrites those files).

- **human** (`review`): ONE merged read per session. A lone track `a` prints exactly as before (byte-identical). Several tracks print
  `# Session NNNN · K parallel tracks`, a table (`track | state | owner | opened | last write`), each track's full section (ids shown
  as `#1a.2` - track a gains its letter only in a multi-track session; the banner says `sealed by marker (abandoned)` where the marker
  says so), then `## Open punchlist, all tracks (N)`. A folder holding only track `b` prints `1 track (track b)`. An unreadable track
  gets a table row `unreadable (<reason>)` and a 3-line block; the other tracks still print.
- **json**: one on-disk envelope per track; one record in total is a bare envelope, several are a bare array (a..z). One stderr line
  per marker-sealed track: `note: track b of 0001 is sealed by a marker (abandoned); its JSON record still says meta.closedAt = null - the marker is authoritative`.
  An unreadable track is skipped with a stderr note (exit stays 0).
- **file names** (`--out`): only the **JSON** is per track. JSON: `session-0001.json` (track a), `session-0001-b.json`, `session-0001-c.json`, ... - the track letter is in the name, so `--combine per-file` no longer overwrites. Human: ONE merged `session-0001.md` for the whole session (all tracks, the table, the combined open punchlist) - there is **no** `session-0001-b.md` per track unless you narrow with `--track b` (then the merged unit holds only that track and is named `session-0001-b.md`). Verified on a three-track scratch store: `--style both --combine per-file` wrote `session-0001.json`, `session-0001-b.json`, `session-0001-c.json`, `session-0001.md` (4 files); `--style json --combine per-file` wrote the three JSON files; `--track b --style both --out <dir>` wrote `session-0001-b.json` + `session-0001-b.md`.
- A lone track `a` sealed by a marker: stdout unchanged, stderr `note: track a of session 0001 was SEALED AS ABANDONED ...`.

Tests: `session-tooling/tests/session-export.test.js`, `session-collate.test.js` (auto-discovered by `tests/run-all.js`).
