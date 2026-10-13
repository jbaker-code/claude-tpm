# session-tooling — JSON-first session storage (`#1113`)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The greenfield session store for `kind:"session"` records: one canonical JSON file per session
(source of truth), a derived human `.md` regenerated on every write, and node-invokable tools —
the write-ops + `#1115` import (the `open`/`save`/`note`/`punchlist`/`close`/`import-*` verbs), export,
the `#1114` migrator, a read-only doctor, config resolution,
the current-session pointer, and the JSON-first boot pickup — dispatched behind a `tpm session` router.

**Status: promoted.** This store was built and hardened in the
`dev/20260919-session-features/session-tooling/` sandbox and promoted into this `tools/` tree as a
gated step. Every store op takes an explicit `--sessions-dir` (a *scratch* dir for tests, the real dir
only when named) and never silently defaults to the live `.claude/claude-tpm/sessions/`.

The canonical JSON envelope + `session` payload (with the editable-vs-mechanical field table) and the
derived human render are described under [The JSON envelope + human render](#the-json-envelope--human-render)
below. The format-authority specs (`json-format-spec.md` / `export-spec.md`) were not promoted out of the
sandbox and are not part of this tree; the per-tool `.md` references below are the promoted reference.

Per-tool references: [`tpm-session-ops.md`](tpm-session-ops.md) · [`tpm-session-export.md`](tpm-session-export.md) · [`tpm-session-migrate.md`](tpm-session-migrate.md) · [`tpm-session-doctor.md`](tpm-session-doctor.md) · [`tpm-session-config.md`](tpm-session-config.md) · [`tpm-session-current.md`](tpm-session-current.md) · [`tpm-session-boot-read.md`](tpm-session-boot-read.md). Tracks / the open gate / abandoned seals: [`tpm-session-current.md`](tpm-session-current.md) and [`tpm-session-ops.md`](tpm-session-ops.md) ("Tracks"). (`tpm-session-router.js` and the suite-local `tpm-session-paths.js` helper carry no `.md`.)

---

## Architecture

The store is a pipeline of layers, each depending only on the ones above it:

```
base lib (kind-agnostic)      tools/lib/ (shared): io · timestamp · normalize · version · envelope · validate · update · export-scaffold · hash · paths
        │                         atomic IO, versioning/migrate, envelope read/write, validate, apply-update, export scaffolding
        │                         reached directly by the session model via ../../lib (no indirection file)
        ▼
session model (kind:"session") lib/session-schema · lib/session-model
        │                         payload schema + editable table (registers the kind); load/save; mechanical ops; import primitives
        ▼
converter (pure)              lib/session-converter
        │                         render(record,{now}) -> the human .md; no fs, no clock, no mutation
        ▼
tools (node-invokable)        tpm-session-ops.js      (ops + #1115 import; regenerates the .md on every write)
                              tpm-session-export.js   (single/multi · JSON/human; composes the search seam)
                              tpm-session-migrate.js  (#1114 opt-in old 3-file markdown -> canonical JSON)
                              tpm-session-doctor.js   (#1119 READ-ONLY validate + hash-drift + detect/suggest-migrate)
                              tpm-session-config.js   (resolves the `session` config section over defaults; the config-gate + sessionsDir the skill reads)
                              tpm-session-current.js  (reads/mutates the current-session pointer .current-session.json)
                              tpm-session-boot-read.js (JSON-first boot pickup: prior handoff + open punchlist + file locations; exits 0 on every data problem, `--track` with no value exits 2)
                              tpm-session-router.js   (the `tpm session` sub-router; forwards each verb to the tool above)
                              tpm-session-paths.js    (suite-local findRoot helper; imported by config, not a routed verb)
  lib/session-ids.js        the one item-id grammar (123.4 == 123a.4; display 123a.4 only when multi-track)
  lib/session-collate.js    the merged, track-attributed read of one session (export/review now; boot-read/doctor later)
  lib/session-lock.js       the per-session write lock (<sessionsDir>/session-NNNN/.lock) behind ops' mutate() seam
```

Only three things are `kind`-specific: the **payload schema** (`session-schema.js`), the **editable-field
table** (same file), and the **JSON→human converter** (`session-converter.js`). Everything else — the
envelope, versioning + migration, validate/apply-update/trim, and the export scaffolding — is the shared
base lib at the sibling `tools/lib/`, built once. The sibling task store (`#1112`) reuses the same base
lib and supplies only its own schema/table/converter.

### The blessed shared base lib (`#1121`)

`tool-conventions.md` §2/§6 normally forbid a shared cross-suite lib: each suite carries its own `lib/`,
duplication accepted, so a suite copies elsewhere and just works. The base lib is the **one deliberate
exception**: per the Q0 ruling both the session and task suites `require` the *same* runtime lib rather
than each vendoring a copy. In this promoted tree that single physical copy is CONSOLIDATED at the
sibling `tools/lib/`; the session suite reaches it directly (`session-model.js` / `session-converter.js`
`require('../../lib/…')`) while the task suite reaches the same copy through its own `lib/base.js`
indirection. This blessed shared-lib exception is `#1121`, now realized (the shared lib lives at
`tools/lib/`); it is the only shared-lib dependency in the tree.

### Store invariants (from the spec)

The load-bearing guarantees, all enforced in the base lib and proven by the suites:

- **Atomic writes.** Canonical JSON is written temp-file → `fsync` → atomic `rename`; a crash mid-write
  never leaves a partial file. The derived `.md` is regenerated **only after** the JSON write succeeds.
- **Fail-loud reads.** An unreadable or schema-invalid JSON is a loud failure naming the file — never a
  silent empty session.
- **Version tolerance.** An older *known* `schemaVersion` migrates on load (read → migrate → validate); a
  newer *unknown* version is refused loud. Unknown fields survive a round-trip.
- **Local-offset timestamps.** Every stored timestamp is ISO-8601 with an explicit local offset, never
  bare or `Z`. The human render shortens to `YYYY-MM-DD HH:MM`.

---

## File map

```
tools/session/
  README.md                      this file
  tpm-session-ops.js  / .md      notes write-ops + #1115 import (open/save/note/punchlist/close/import-*)
  tpm-session-export.js / .md    export tool (single/multi · JSON/human · composes the search seam)
  tpm-session-migrate.js / .md   #1114 opt-in old 3-file markdown -> canonical JSON migrator
  tpm-session-doctor.js / .md    #1119 READ-ONLY doctor: validate + hash-drift + detect/suggest-migrate
  tpm-session-config.js / .md    resolves the `session` config section; the config-gate + sessionsDir the skill reads
  tpm-session-current.js / .md   reads/mutates the current-session pointer (.current-session.json)
  tpm-session-boot-read.js / .md JSON-first boot pickup: prior handoff + open punchlist + file locations; exits 0 on every data problem, `--track` with no value exits 2
  tpm-session-router.js          the `tpm session` sub-router; forwards each verb to the tool beside it (no .md)
  tpm-session-paths.js           suite-local findRoot helper; imported by config, not a routed verb (no .md)
  lib/                           kind:"session" modules ONLY (the base lib is the sibling tools/lib/; see note below)
    session-schema.js            SESSION_KIND · EDITABLE_TABLE · validatePayload (registers the kind)
    session-model.js             load/save · mechanical ops · import primitives; require's the base lib via ../../lib
    session-converter.js         render(record,{now}) -> human .md (pure); stamps the (generated from:) banner hash
    session-tracks.js            the tracks store: track naming (a = session-NNNN.json, b..z = session-NNNN-b.json), trackState()
                                 (sealed = own meta.closedAt OR a .sealed marker), scans, ownership, claims, seal/unseal, the hint
  tests/
    run-all.js                   forks one process per *.test.js; exits nonzero on any failure
    *.test.js                    65 suites (unit + e2e + fault + version-tolerance + dogfood + migrate + hash +
                                 doctor + config/current/boot-read + the cross-cutting suites + the lock/identity
                                 suites + the tracks-store suites; the last three added are tracks-forced-order,
                                 tracks-lifecycle, session-md-atomic: see tools/README.md; phase 12 added session-ids, session-collate,
                                 session-ops-xtrack, session-lock-wrap, session-lock-forced; phase 15 added session-three-track-e2e, session-verbs-harden)
    golden/                      session-0021.fixture.json + .expected.md (byte-exact render golden)
    fixtures/legacy/             #1114 old-format inputs: copied real 0020/0021 + clean/sidecar/refusal
                                 fixtures + session-0021.expected.json (byte-exact old->new golden)
    helpers/                     harness.js · e2e-helpers.js (shared test scaffolding, not suites)
```

The base lib is **not** under `tools/session/lib/` — the session suite does not vendor a copy. It is the
shared, consolidated `#1121` copy at the sibling `tools/lib/`, which `session-model.js` /
`session-converter.js` require directly via `../../lib`:

```
tools/lib/                       the blessed shared base lib (#1121) — kind-agnostic, one physical copy
  io.js                          atomicWriteFileSync · readCanonicalSync
  timestamp.js                   nowIsoTz · shortDateTime · pad2
  normalize.js                   normalizeArray (bare string -> length-1 array)
  version.js                     CURRENT · compare · migrate · migrations registry
  envelope.js                    readEnvelope · writeEnvelope · mergePreservingUnknown · KNOWN_KINDS
  validate.js                    validateEnvelope
  update.js                      applyUpdate · trimNonEditable
  export-scaffold.js             selectRecords · combine · dispatch
  hash.js                        canonicalize · hashRecord (the shared (generated from:) content hash; Q-D)
  paths.js                       findRoot (the shared #1058 path helper)
  _util.js                       suite-internal helpers (NOT public API)
```

---

## Running the tests

Zero dependencies; Node built-ins only. From the repo root:

```
node tools/session/tests/run-all.js
```

`run-all.js` auto-discovers every `tests/*.test.js` (65 today: `ls tools/session/tests/*.test.js | wc -l`) and forks a process
per suite. On a constrained machine run the files one at a time, e.g. `node tools/session/tests/tracks-lifecycle.test.js`.
Tests that play several Claude instances set `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` per child process; when you run a CLI
by hand from inside a Claude session, strip or override them (`env -i PATH="$PATH" HOME="$HOME" CLAUDE_CODE_SESSION_ID=… node tools/tpm.js session …`)
or you will meet "belongs to another Claude session".

---

## Tracks: more than one Claude instance in a session folder

A `session-NNNN/` folder holds one **track** per Claude instance: `session-NNNN.json` (+ `.md`) is track a, `session-NNNN-b.json` … `-z` are the
others, and an optional `session-NNNN[-x].sealed` marker means "sealed by someone else". `tpm session current --open` is the **open gate**: it
resumes your own track, refuses (exit 3, nothing written) when another Claude session's track is unsealed, and otherwise creates the session. After a refusal the
person chooses one of `--adopt <track>`, `--parallel`, `--next`, `--seal-and-new` (see [`tpm-session-current.md`](tpm-session-current.md) for every
flag, state, exit code and message, all run against the real tool). Ownership lives in additive `meta` keys (`track`, `claudeSessionId`, `claudePid`,
`claudePidStartedAt`, `hostname`, `lastWriter`); there is **no `schemaVersion` bump** (still `1.0.0`). The on-disk contract is
`claude-context/methodology/session-notes-format.md`.

Exit codes across the session CLI: `0` ok · `1` error or a refused choice (JSON `refused:true`, `code`) · `3` open refused (foreign / ambiguous) · `4` abandoned seal needs confirmation.

---

## Session write-ops + import (`tpm-session-ops.js`)

Operates off the canonical JSON. Every write persists the JSON atomically first, then regenerates the
derived `session-<NNNN>.md` via the converter (with `now` bound in a closure for punchlist ages). Full
reference: [`tpm-session-ops.md`](tpm-session-ops.md). These are TOP-LEVEL session verbs — the old
`ops` grouping was flattened away, so call each verb directly.

```
tpm session <verb> --sessions-dir <dir> --session <NNNN> [flags]
```

**Ops**

| Verb | Effect |
|------|--------|
| `open` | mint a fresh session; with `--prior-session-path` a prior session's still-open items carry forward (same `slug`, new `id`, a `carry-in` event stamped with `fromSession`). |
| `save` | re-persist the current session (re-stamp `handoff.updatedAt`, regenerate the `.md`). |
| `note` | append ONE log entry: `--log --status NOTE --text "…"` or `--decision --what "…" --why "…"`. Append-only, monotonic `seq`. |
| `punchlist` | `--action add\|close\|reopen\|drop\|carry-in`. `add`: `--text "…" [--slug s]`. |
| `close` | **close-guard (#1115):** refuses unless a handoff AND at least one punchlist item are present, naming what is missing; otherwise stamps `meta.closedAt`. Seals only YOUR track. `close --track <other> --even-if-running` (alias `--confirm`) is the abandoned seal (exit 4 without the flag). |
| `unseal` | `--session NNNN --track x`: undo an abandoned seal. |

**Import (`#1115`)** — honors the locked editable table (mechanical fields ignored; state never set by import):

| Verb | Semantics |
|------|-----------|
| `import-handoff` | REPLACE. `--json-file` (a handoff object or a full record) or `--txt-file` (raw → `where`) plus `--next`/`--next-file` for the required `next`. |
| `import-log` | APPEND-ONLY. `--txt-file` becomes one log entry's body; existing entries are never rewritten. |
| `import-punchlist` | ADD/merge. `--file` is a JSON array of strings/`{text}` or one item per line; each becomes a new open item. |

Verified end-to-end against a scratch dir. The close-guard refusal is real:

```
$ tpm-session-ops close --sessions-dir <scratch> --session 0043
tpm-session-ops: tpm-session-ops close: refusing to close session — missing a handoff and a
punchlist. A session cannot be sealed without a handoff AND at least one punchlist item (#1115
close-guard).
# exit 1
```

---

## Export (`tpm-session-export.js`)

Reads canonical JSON through the same load path (read → migrate → validate) and emits JSON and/or the
human render, one or many sessions, combined or per-file. Full reference:
[`tpm-session-export.md`](tpm-session-export.md).

```
tpm session export --sessions-dir <dir> \
  [--last N | --session <NNNN>[,NNNN] …] --style json|human|both [--combine one-file|per-file] [--out <dir|file>]
```

- **Single session** — full JSON (the bare canonical envelope) or the human `.md` (one-way, not re-importable).
- **Multi-session (`--last N` or a selector)** — combined into ONE file (default) or per-session files.
  Combined JSON is a **bare array of envelopes** (no wrapper); combined human is the **full per-session
  header repeated** per session (the Q4 export surface).
- **Style** — `--style json|human|both` (repeatable / comma-list; default `json`).

**Thin/editable session export is intentionally absent** (Q3): JSON-full + human-only is enough for
session state. `trimNonEditable` stays in the base lib for `#1112`, but no `--thin` flag is wired.

### The search-composition seam (`#1092`)

Export **composes** with search rather than re-matching. `resolveRecords` takes candidates three ways, in
precedence order:

1. `opts.records` — a pre-loaded, already-validated result-set (the truest `#1092` seam; no dir needed).
2. `opts.selector` / `--session` — an explicit list of session numbers, resolved in the order given.
3. `opts.last` / `--last N` — the N highest-numbered sessions, newest first.

An optional `opts.filter` (predicate or array) then composes over the candidates via the scaffold's
`selectRecords`. A selection that resolves to zero sessions fails loud. The seam feeds a `#1092` search
result-set straight into export; matching is never reimplemented here.

---

## Migrator (`tpm-session-migrate.js`, `#1114`)

The **opt-in** convert-on-demand tool that turns ONE old-format 3-file markdown session (the
pre-JSON `session-<NNNN>-{handoff,log,punchlist}.md` shape) into a canonical `session-<NNNN>.json`
envelope. Full reference: [`tpm-session-migrate.md`](tpm-session-migrate.md).

```
tpm session migrate --in <old-session-dir> --out-dir <dir> \
    [--number NNNN] [--dry-run] [--emit-md] [--force] [--now <iso>]
```

- **Convert-on-demand, one target per run.** No scan, no auto-run — a human names a single `--in`
  and `--out-dir`, both REQUIRED with no default. It **never** touches the live sessions dir (the
  `--in` is read-only; an `--out-dir` inside a live `.claude/claude-tpm/sessions` tree is refused).
- **Marked-3-file ONLY (Q-B).** It accepts only the clean marked trio (each file banner-stamped
  `<!-- tpm-session: NNNN · … -->`, no stray note files) and **refuses everything else** with a clear
  message — mixed dirs, pre-format 2-file, freeform, or an unmarked trio. A silent partial migration
  of a hand-written note is worse than a clear "convert this one by hand"; there is no best-effort path.
- **No synthesized timestamps (Q-C).** `meta.closedAt` stays `null` for a date-only `SEALED` line, and
  `meta.openedAt` is derived from the **earliest real ISO-TZ timestamp already present** in the session
  (min across log + punchlist stamps) — a real value *selected* from the data, never a fabricated
  `T00:00:00`. A session carrying no real timestamp anywhere is refused rather than invented.
  (This reading of Q-C is the parked **Q-E** item — non-blocking, proceeding on this default pending
  Jason's confirmation; see `00-epic-plan/decisions.md`.)
- **Validate-before-write + round-trip.** The assembled record is `validateEnvelope`d before any write
  and re-loaded through `loadSession` after, so the output is provably canonical.

Verified end-to-end against a scratch dir — a dry-run reports what would be written, a real run writes
the JSON (+ the `.md` under `--emit-md`), and a mixed dir is refused:

```
$ tpm-session-migrate --in <scratch>/session-0021 --out-dir <scratch>/migrated --emit-md
session 0021 — WROTE
  out:        <scratch>/migrated/session-0021.json
  derived md: <scratch>/migrated/session-0021.md
  validation: PASS (schema 1.0.0, kind session)
  note:       meta.openedAt derived from earliest real timestamp (2026-09-19T09:40:33-07:00)
  note:       meta.closedAt = null (no real close timestamp; SEALED date-only is not synthesized)

$ tpm-session-migrate --in <scratch>/refuse-mixed --out-dir <scratch>/out2
tpm-session-migrate (refused): … mixed/pre-format session (stray note file(s): handoff.md,
session-notes.md). … convert this one by hand.
# exit 1
```

---

## Doctor (`tpm-session-doctor.js`)

A strictly **READ-ONLY** health check over a sessions dir — no `--fix`, no write path. Full reference:
[`tpm-session-doctor.md`](tpm-session-doctor.md).

```
tpm session doctor --sessions-dir <dir> [--json] [--strict]
```

- **Validate** every canonical `session-<NNNN>.json` (read → migrate → validate), stage-labeling any
  FAIL (unreadable / unknown-newer / schema-invalid).
- **Hash-drift** — recompute the content hash of the current JSON (`lib/hash.hashRecord`) and
  compare it to the `(generated from: <12hex>)` token the converter stamped into the `.md` banner (Q-D). A
  mismatch is reported as DRIFT; a token-less `.md` as UNSTAMPED. Recompute + compare only — the `.md`
  is never re-rendered or rewritten.
- **Detect old-format + suggest migrate** (#1114 A/D) — reuses the migrator's `detectShape`; for a
  clean marked 3-file session with no JSON it PRINTS `tpm-session-migrate.js --in … --out-dir …` and a
  count. It never converts.
- **`meta.number` form** — advisory WARN when the stored number is non-canonical or disagrees with the
  filename.

Exit: `0` healthy (advisories allowed) · `1` a validation FAIL · `2` `--strict` + an advisory. The
read-only guarantee is byte-snapshot-proven in `tests/session-doctor.test.js` and `doctor-nested-matrix.test.js`.

Verified end-to-end against a scratch store (a nested canonical session + an old-format subdir); a
hand-edited JSON is caught as DRIFT and `--strict` promotes it to exit 2:

```
$ tpm-session-doctor --sessions-dir <scratch>/store
1 session(s) · 1 valid · 0 invalid · 1 drift · 1 old-format
  session-0021/session-0021.json  OK · DRIFT (banner cf6696eb45d1 · current 8ed4d6acd732)

Old-format sessions (1; 1 auto-migratable):
  session-0007  → tpm session migrate --in "…/session-0007" --out-dir "<choose-an-output-dir>"
# exit 0 ; with --strict, exit 2
```

### On-disk layout — the doctor reads flat AND nested (Q-F is OPEN)

The doctor discovers canonical JSON **two** ways: **nested** per-session dirs
(`session-<NNNN>/session-<NNNN>.json`, the canonical on-disk naming/location and the live store's shape)
AND **flat** at the top of `--sessions-dir` (`session-<NNNN>.json`). Both were run-verified above.

This reads both layouts on purpose, because the **writers and the spec currently disagree** on the
canonical write layout: the ops writer (`opOpen`/`saveSession`) and the migrator's `--out-dir` both emit
**flat** `session-<NNNN>.json`, while the spec + doctor treat **nested** as canonical. That
writer-vs-spec reconciliation is the **OPEN Q-F** item — parked for Jason, to be resolved before
promotion; this doc records the current behavior and does **not** assert a single canonical write layout.
See `00-epic-plan/decisions.md` §"Raise to user" for the three options under consideration.

---

## The JSON envelope + human render

The format-authority specs that governed the build (`json-format-spec.md` schema-locked / `export-spec.md`
render-locked) were not promoted into this tree; the shape below plus the per-tool `.md` references are the
in-tree description of the canonical envelope and the human render.

Every record is the shared envelope (`schemaVersion`, `kind:"session"`) with the payload as **top-level
siblings** (not nested under a `session` key):

- `meta` — mechanical block (tool-stamped, never hand-edited): `number`, `sessionIds`, `openedAt`,
  `closedAt`, `tpmVersion`. Renamed from `session` to avoid the `kind:"session"` collision.
  **`meta.number` is the canonical zero-padded width-4 `NNNN` STRING** (`"0021"`, not the integer `21`) —
  the same form as the session name, its folder, and its filenames. `openSession` normalizes any input
  form (`31` / `"31"` / `"0031"`) to that STRING at the single write site (the P02 `#1122.C`
  normalization, per Jason's **Q-A** ruling); the filename/folder derivation re-pads independently, so it
  was never coupled to the stored form. This is verified across the input-form equivalence class in
  `number-decouple-regression.test.js`.
- `handoff` — REPLACE-semantics: `where`, `next` (required, editable), `in_flight`, `must_not_redo`
  (editable `string[]`), `updatedAt` (mechanical). Nullable until the first save.
- `log[]` — APPEND-ONLY typed ledger (`decision` / `log`), monotonic `seq`; stored oldest→newest, rendered
  newest-first.
- `punchlist[]` — items with a mechanical `id` (friendly alias) + `slug` (never-reused lineage key),
  editable `text`, ops-only `state`, and a per-session `events[]` trail.

**Editable vs mechanical.** The editable set is exactly what a thin export would show and what import may
set: `handoff.where`/`next`/`in_flight`/`must_not_redo`, `log[].what`/`.why`/`.status`/`.text` (on append),
`punchlist[].text` (on add). Everything else is mechanical — tool-stamped, and ignored on import even if
supplied. The editable set is registered in `lib/session-schema.js` (`EDITABLE_TABLE`).

**Human render.** The `.md` is derived and disposable, regenerated and overwritten from the JSON on every
save; hand-edits are lost by design (change content via ops or import). Order is Handoff → Punchlist → Log;
the log is one reverse-chron stream; punchlist ages read `Nm/Nh/Nd ago` and switch to absolute `YYYY-MM-DD`
at ≥ 7 days. The banner's second line carries a `(generated from: <12hex>)` content hash of the whole canonical
record (Q-D) — the anchor the doctor uses for read-only drift detection. The exact render rules live in
`lib/session-converter.js`; `tests/golden/session-0021.expected.md` is a byte-exact generated `.md`.
