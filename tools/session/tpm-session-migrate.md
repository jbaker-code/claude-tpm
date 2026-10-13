# `tpm-session-migrate.js` — opt-in old→new session migrator (`#1114.C`)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Convert-on-demand tool that turns ONE old-format 3-file markdown session (the clean marked
`session-<NNNN>-{handoff,log,punchlist}.md` shape written by the pre-JSON `tpm-session` tooling —
sessions **0020 / 0021**-style) into the new canonical `session-<NNNN>.json` envelope.

It **composes** the blessed base lib and re-implements none of the write/validate path:
`writeEnvelope` (atomic write) · `validateEnvelope` + `session-schema.validatePayload` ·
`session-model.canonicalNumber` / `loadSession` (round-trip check) · `session-converter.render`
(the optional derived `.md`) · `timestamp.nowIsoTz`.

> **This is `#1114` subtask C only** — the *conversion*. Detection and the "suggest migration"
> nudge (subtasks A / D) live in the read-only doctor (`#1119` / P04), not here. This tool NEVER
> scans, never auto-runs, never touches the live sessions dir.

Node-invokable, no `bin` (Q5): run via bare `node`. Zero third-party deps.

---

## Usage

```
tpm session migrate --in <old-session-dir> --out-dir <dir> \
    [--number NNNN] [--dry-run] [--emit-md|--no-emit-md] [--force] [--now <iso>]
```

| Flag | Req | Meaning |
|---|---|---|
| `--in <dir>` | ✅ | old marked 3-file session dir. **READ-ONLY** — never modified. |
| `--out-dir <dir>` | ✅ | where `session-<NNNN>.json` is written. Must differ from `--in` and must not resolve inside a live `.claude/claude-tpm/sessions` tree. |
| `--number NNNN` | | override the session number (else parsed from the banner). Validated (digits only) before canonicalization. |
| `--dry-run` | | validate + report what *would* be written; write nothing. |
| `--emit-md` | | also write the derived human-readable `session-<NNNN>.md` (via the converter). **Default: on** (kept for explicitness / back-compat). |
| `--no-emit-md` | | opt OUT of the derived `.md` — write only the canonical `.json`. |
| `--force` | | overwrite an existing output file (otherwise refuse if it exists). |
| `--now <iso>` | | explicit stamp for `handoff.updatedAt`. When given it ALWAYS wins (goldens pin it so output is byte-stable). When omitted, `handoff.updatedAt` is the source's own latest real timestamp (see the field table), falling back to now only if the source holds none. |
| `--help` | | show usage. |

No flag has a default path (tool-conventions "no hardcoded paths / no silent defaults for required inputs").

### Example

```
tpm session migrate \
  --in  .claude/claude-tpm/sessions/session-0021 \
  --out-dir /tmp/migrated
# -> /tmp/migrated/session-0021.json  (+ session-0021.md — the .md is emitted by default; --no-emit-md skips it)
```

Exit codes: `0` success · `1` refusal / runtime error · `2` CLI arg error.

---

## What it accepts — MARKED-3-FILE ONLY (Q-B, Jason 2026-09-20)

The input dir must be the **clean marked 3-file shape**:

1. exactly `session-<NNNN>-{handoff,log,punchlist}.md` for a single `<NNNN>`, each opening with a
   `<!-- tpm-session: NNNN · … -->` banner, and
2. **no** stray legacy note files (`handoff.md`, `punchlist.md`, `session-notes.md`, `notes.md`, any
   `*.txt`, or any off-pattern `.md`).

Everything else is **REFUSED with a clear message — never best-effort or partial-converted**:

| Old shape | Example | Refusal reason |
|---|---|---|
| mixed (marked trio + stray notes) | `session-0019` | stray note file(s) present |
| pre-format 2-file | `session-011` (`handoff.md` + `session-notes.md`) | stray note file(s) / no marked trio |
| freeform | `session-001` (`notes.md` + `*.txt`) | `.txt` file present |
| unmarked trio | trio without the banner | missing `<!-- tpm-session: … -->` banner |

A silent partial migration of a hand-written note is worse than a clear "convert this one by hand."

---

## Field mapping (old → canonical JSON)

| Canonical field | Source | Notes |
|---|---|---|
| `schemaVersion` | `version.CURRENT` (`1.0.0`) | envelope |
| `kind` | `"session"` | envelope |
| `meta.number` | banner `tpm-session: NNNN` (or `--number`) → `canonicalNumber` | **zero-padded width-4 STRING** (`"0021"`). The parsed number is validated (`^\d+$`) **before** `canonicalNumber` so loose input (`""`/`null`/hex) is refused, not coerced. |
| `meta.sessionIds` | `.current-session.json` sidecar `sessionId` if present, else `[]` | empty is schema-valid |
| `meta.openedAt` | sidecar `openedAt` (if ISO-TZ), else the **earliest real timestamp** across log + punchlist | a real value selected from the data — **never** a synthesized `T00:00:00` (Q-C) |
| `meta.closedAt` | sidecar `closedAt` (if ISO-TZ), else `null` | a `SEALED <date>` line is date-only → left `null`, not synthesized (Q-C) |
| `meta.tpmVersion` | `"0.0.0-legacy"` sentinel | the note's `tpm-session-version: 1.0` is a NOTE-format version, not the writer version — not conflated |
| `handoff.where` | `**Where we are:**` line | |
| `handoff.next` | `**Next action:**` (or `**Next:**`) line | |
| `handoff.in_flight` | `**In flight:**` line, split on `;` | |
| `handoff.must_not_redo` | `## MUST NOT redo` bullets | |
| `handoff.updatedAt` | `--now` if given; else the LATEST real ISO-with-offset stamp in the source (log timestamps, punchlist `createdAt`/event times, sidecar `openedAt`/`closedAt`); else now (local offset) | the record's real last-write time, so a migrated legacy session does not look freshly written. Migrate prints a `note:` saying which was used. Verified on `tests/fixtures/legacy/session-0021`: no `--now` -> `2026-09-19T21:44:19-07:00`; `--now 2026-09-19T22:00:00-07:00` -> that value. **Sessions migrated before this change keep the now-stamp they were given** (nothing rewrites them). The fall-back to now when the source holds no stamp at all is unexercised (no such fixture). If the source has no usable Where/Next, `handoff` is `null` (valid). |
| `log[]` | `## Decisions` (`type:"decision"`, `what`/`why` split on the first ` — `) + `## Log` (`type:"log"`, `status`/`text`) | merged, **sorted by timestamp**, `seq` assigned `1..n` (robust to the file's physical order). |
| `punchlist[]` | `## Open` / `## Done` items `#<id> · <text> [<slug>, <ts>] (closed <ts>)` | `slug` (lineage key) **preserved verbatim**; `id` kept as written; `events` = `add` (+ `close` for done items with a close-ts). |

### The one field that does not map 1:1 — `meta.openedAt`

Historical sessions have no per-dir `.current-session.json` sidecar (the live sidecar is a single
top-level pointer, not per-session), and the schema **requires** `meta.openedAt` (non-nullable
ISO-TZ). Q-C forbids inventing one. Resolution: `openedAt` is taken from the **earliest real ISO-TZ
timestamp already present** in the session (log/punchlist stamps) — a real value, not a fabrication.
If a session carried no real timestamp anywhere, the migrator **refuses** rather than invent one.
See `dev/20260920-session-ship-prep/03-session-migration/findings/HANDOFF.md` for the full rationale.

> **Q-E is parked (non-blocking).** This "derive from the earliest real timestamp, else refuse" reading
> of Q-C is the shipped default, pending Jason's confirmation that it is the intended reading (the
> alternative being to refuse any session lacking an explicit opened-at source outright). See
> `dev/20260920-session-ship-prep/00-epic-plan/decisions.md` §"Raise to user" (Q-E). The refuse branch
> is covered by `tests/migrate-openedat-refuse.test.js`.

---

## Safety rails

- **Convert-on-demand, one target per run.** No scan-and-auto-convert; nothing runs without explicit flags.
- **Read-only on `--in`; write-only under `--out-dir`.** `--out-dir` == / inside `--in` is refused;
  an `--out-dir` inside a live `.claude/claude-tpm/sessions` tree is refused.
- **Validate-before-write.** The assembled record is run through `validateEnvelope`; a would-be-invalid
  record fails loud (naming the field) — an invalid `session-<NNNN>.json` is never written.
- **Round-trip proof.** After writing, the file is re-loaded through `loadSession` (read → migrate →
  validate) so the output is provably canonical.
- **`--dry-run`** validates + reports and writes nothing; an existing output is refused without `--force`.

---

## Programmatic API

```js
const { runMigration, parseOldSession, detectShape, MigrateError } = require('./tpm-session-migrate');

const { record, notes, outPath, written } = runMigration({
  inDir: 'path/to/session-0021', outDir: '/tmp/out', now: '2026-09-19T22:00:00-07:00',
});
```

`runMigration(opts)` — full convert (opts: `inDir`, `outDir`, `number?`, `dryRun?`, `emitMd?`,
`force?`, `now?`, `loadSession?`). `parseOldSession({ inDir, number?, now? })` → `{ record, notes }`
(parse + assemble, no write). `detectShape(inDir)` → `{ number, files }` or throws `MigrateError`.
A refusal is always a `MigrateError` (a clean refuse, not a crash).

---

## Tests

`tests/session-migrate.test.js` (run: `node session-tooling/tests/session-migrate.test.js`, or via
`tests/run-all.js`). Fixtures under `tests/fixtures/legacy/` (copied real 0020/0021 + hand-built
clean / sidecar / refusal fixtures); output always goes to `os.tmpdir()` — the live sessions dir is
never read or written. Includes the **golden old→new pair** (real 0021 → frozen
`session-0021.expected.json`, byte-exact), faithful-mapping assertions, the Q-B refusals, the Q-C
no-synthesis checks, and the safety rails. The golden is mutation-proven (a parser regression turns it red).

## Multi-track folders

A folder of TRACK records (`session-NNNN.json`, `session-NNNN-b.json` ..., `.sealed` markers) is the current format: given as
`--in` it is refused with "current-format session folder ... nothing to migrate" and nothing is touched. Migrating INTO a session
folder that already holds sibling tracks (b..z or a seal marker) is refused explicitly, even with `--force` or `--dry-run`: a
migrated session is an unowned track a and would sit beside live or sealed tracks. Choose a different `--out-dir`.
Legacy marked 3-file folders migrate exactly as before.
