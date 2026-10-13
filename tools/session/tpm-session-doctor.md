# `tpm-session-doctor.js` — read-only session-store validator + drift detector (#1119)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The session **doctor**: a strictly READ-ONLY health check over a sessions directory. It validates
every canonical `session-<NNNN>.json`, detects human-file **drift** (the derived `.md` no longer
matches the JSON it was generated from), and detects **old-format** 3-file sessions and SUGGESTS the
migrator — it never writes, mutates, migrates, converts, or re-renders anything. There is no
`--fix`.

## Usage

```
tpm session doctor --sessions-dir <dir> [--json] [--strict] [--track <letter|claude-id>] [--stale-after <3d|36h|90m>]
```

| Flag | |
|---|---|
| `--sessions-dir <dir>` | **Optional:** omitted, it is resolved from the project root's `.claude/claude-tpm/config.json` (`session.notes.sessionsDir`); the flag overrides. The sessions store. Canonical `session-<NNNN>.json` is discovered both flat at the top AND in the canonical **nested** per-session-dir layout `session-<NNNN>/session-<NNNN>.json` (the live store's shape); old-format 3-file subdirectories are detected too. Read-only. |
| `--json` | Emit the structured report as JSON instead of human text. |
| `--strict` | Promote advisories (drift / unstamped / old-format / number-form) to a non-zero exit. |
| `--track <t>` | Only that track: one letter a-z, or at least 8 characters of its owner's Claude session id. Malformed = exit 2; no match = exit 1. |
| `--stale-after <d>` | An UNSEALED track with no write for longer than this is reported (default `3d`; `90m`, `36h`, `3d`; a bare number is hours). |
| `--help` | Show usage. |

Bare `node`, no `bin` (Q5). Programmatic callers `require()` it for `runDoctor(opts) -> report`.

## What it checks (per `session-<NNNN>.json` — flat at the top of `--sessions-dir` OR nested in `session-<NNNN>/`)

> Per the LOCKED `json-format-spec.md` §"On-disk naming + location", the canonical layout is **nested**
> — each session is its own dir (`session-<NNNN>/session-<NNNN>.json` + `session-<NNNN>.md`), which is
> the live store's real shape. A subdir holding a canonical JSON is validated + drift-checked **in
> place** (its `.md` sibling is right there); a flat `session-<NNNN>.json` at the top is also checked.
>
> **Q-F is OPEN — the doctor reads both layouts because the writers and the spec disagree.** The ops
> writer (`opOpen`/`saveSession`) and the migrator's `--out-dir` both emit canonical JSON **flat**
> (`session-<NNNN>.json`), while this spec + this doctor treat **nested** as canonical. The doctor's
> flat scan is kept additively so it reads the writers' actual (flat) output today, but the
> writer-vs-spec reconciliation is a parked architecture decision (make the writer emit nested, change
> the spec+doctor to flat, or accept both with a de-dup pass). This doc does **not** assert a single
> canonical write layout; it documents the current dual-read behavior. See
> `dev/20260920-session-ship-prep/00-epic-plan/decisions.md` §"Raise to user" (Q-F).

1. **Schema + version validation** — the canonical load path, stage-labeled so a failure names the
   stage instead of crashing the run:
   - `readEnvelope` throws → **FAIL [read]** (unreadable / corrupt JSON).
   - `migrate` throws → **FAIL [migrate]** (unknown, newer-than-code `schemaVersion` — the refusal
     names the version).
   - `validateEnvelope` + `validatePayload` throws → **FAIL [validate]** (the exact violation).
   - all pass → **OK**.
2. **Hash-based drift (read-only).** For a session with both `session-<NNNN>.json` and
   `session-<NNNN>.md`: parse the banner's `(generated from: <12hex>)` token, recompute
   `hashRecord(<raw on-disk JSON>)`, and compare.
   - token matches → **OK (in sync)**.
   - token differs → **DRIFT** (advisory).
   - `.md` has no token → **UNSTAMPED** advisory (the `.md` predates the hash — re-save to stamp).
   - no `.md` → not checked.
   It recomputes + string-compares only; it never re-renders or rewrites the `.md`. The hash is over
   the record's content, not the clock, so there are no `now`-relative false positives. It hashes the
   **raw on-disk** record (not the post-`migrate` form), because the banner was stamped from the
   on-disk bytes (Q-D.4; moot today, matters once real migrations exist).
3. **`meta.number` form (advisory).** Asserts the stored `meta.number` is the canonical zero-padded
   form (`/^\d{4,}$/`) AND agrees with the filename's `<NNNN>`; a mismatch is a **WARN** (validity
   itself is covered by check 1 / P02).

## What it does for OLD-FORMAT sessions (#1114 A/D — detect + suggest, NEVER convert)

For each immediate subdirectory of `--sessions-dir` that does **not** already hold a canonical
`session-<NNNN>.json` (a subdir that does is treated as a migrated session and validated in place, per
the section above), it reuses the P03 migrator's `detectShape` (the single old-format detector —
collision C-A):

- clean marked 3-file session **with no** `session-<NNNN>.json` → prints a ready-to-run suggestion:
  ```
  tpm session migrate --in "<dir>" --out-dir "<choose-an-output-dir>"
  ```
  plus a total count.
- clean marked 3-file session that **already has** a JSON → nothing to report.
- a dir that `detectShape` refuses (2-file / freeform / mixed / no-banner) **and** looks like a
  legacy session (has markup, no canonical JSON) → reported as **not auto-migratable**, naming
  `detectShape`'s reason (needs a manual conversion).
- anything else (a new-format dir, an unrelated dir) → skipped.

The doctor **never** converts — conversion is `tpm-session-migrate.js`, run explicitly by a human.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No validation FAILs (advisories allowed). |
| `1` | At least one validation FAIL (unreadable / unknown-newer / schema-invalid). Dominates `--strict`. |
| `2` | `--strict` and at least one advisory (drift / unstamped / old-format / number-form), no hard FAIL. |

## Report shape

- **Human (default):** a header (`N session(s) · X valid · Y invalid · Z drift · W old-format`), one
  line per session (`OK` / `FAIL [stage]: …` / `DRIFT (…)` / `UNSTAMPED` / `WARN: …`), then an
  old-format block with the migrate suggestions.
- **`--json`:** `{ sessionsDir, results:[{file, number, validate:{status,stage?,problem?},
  drift:{status,bannerHash?,currentHash?}, numberForm:{status,detail?}}], oldFormat:[{dir, number?,
  migratable, suggestion?|reason?}], summary:{…}, exitCode }`.

## Composition (re-implements nothing)

`lib/envelope.readEnvelope` · `lib/version.migrate` · `lib/validate.validateEnvelope` +
`lib/session-schema.validatePayload` · `lib/hash.hashRecord` (the SHARED content hash the
converter also uses to stamp the banner) · `tpm-session-migrate.detectShape`. Zero third-party deps;
Node built-ins only.

## Read-only guarantee (tested)

`tests/session-doctor.test.js` builds a scratch fixture dir (valid, schema-invalid, unknown-newer,
corrupt, drifted, unstamped, number-form, an old-format 3-file dir, and a refusal-shape dir),
byte-snapshots every file, runs the doctor in all three modes (in-process + the real CLI), then
re-snapshots and asserts every file is byte-identical and none was created or deleted. The drift and
validate checks are mutation-proven (forcing drift to OK, or dropping the payload validator, turns
the matrix red).

## Tracks (multi-session support)

A session folder holds one record per **track** (`session-NNNN.json` = track a, `session-NNNN-b.json` ... = tracks b..z, each
with its OWN derived `.md`, plus `.sealed` markers). The doctor reads them all; every record is drift-checked against ITS OWN
`.md` (it used to compare every record with track a's). Sealed-ness comes from `trackState` (a marker wins), never from the
record's `closedAt` or the `.md`. A folder holding only `-b`/`-c` records is current-format, not old-format. A lone healthy
track a prints exactly the line it always did; a multi-track session adds `SEALED by owner` / `SEALED by marker (...)` / `live`
and the owner after `OK`.

Report-only checks (each counts toward `--strict` unless marked note; none of them changes anything):

| Code | What | Hint |
|---|---|---|
| `STALE` | unsealed track, no write for longer than `--stale-after` | `tpm session close --session NNNN --track x --confirm --reason "abandoned"` (the abandoned seal: deletes nothing) |
| `OWNER-GONE` | unsealed track whose owner process on this host is gone (a recorded pid on another host is never judged) | same |
| `MARKER-WITHOUT-RECORD` | a `.sealed` marker with no `.json` beside it | |
| `MARKER-UNREADABLE` | the marker cannot be parsed (the track still reads as sealed) | |
| `DUPLICATE-TRACK` | a stray `session-NNNN-a.json` beside the real `session-NNNN.json` (both claim track a). Printed as a folder note. | move the extra one out |
| `TRACK-MISMATCH` | the file name and `meta.track` disagree (or `meta.track` is absent on a b..z file). If the claimed track is also claimed by another file, the SAME finding says so (`it collides with session-0001-c.json, which also claims track c`) - one root cause is one finding, not a TRACK-MISMATCH plus a DUPLICATE-TRACK per file. | keep the real record, move the other out |
| `LOCK-STALE` / `LOCK-INCOMPLETE` / `LOCK-LEFTOVER` | `session-NNNN/.lock` stale / unreadable / `.lock.new.*`, `.lock.rel.*`, `.lock.broken.*` left behind | |
| `LEFTOVER-TMP` | a `*.tmp` older than a minute (interrupted write) | |
| `UNRECOGNISED` | a `*.json` / `.sealed`-looking name that is not a track file (`session-notes.md` stays silent) | |
| note: `MARKER-STALE-RECORD`, `MD-MISSING`, `MD-WITHOUT-RECORD`, `LOCK-HELD`, `LOCK-NO-GITIGNORE`, `HINT-DISAGREES` | informational, never counted | |

Dot-names (`.lock`, `.current-session.json`) are never sessions. The old stderr line "N track record file(s) are not checked by
this version" is gone: every track is checked.

Real output (scratch store; `session-0001-c.json` copied to `session-0001-d.json`), one finding on the `d` row and none on `c`:

```
  session-0001/session-0001-d.json  OK · live · owner cccccccc · TRACK-MISMATCH: session-0001-d.json is named for track d but its meta.track says "c"; it collides with session-0001-c.json, which also claims track c (keep the real record, move the other out of the folder) · note: session-0001-d.md (the derived file) is missing; ...
```

A stray `session-0001-a.json` copy of track a still prints `DUPLICATE-TRACK` (as a `Folder notes` line) and is not folded into anything. Both runs exit 0 (the doctor reports; `--strict` is what turns findings into a non-zero exit).
