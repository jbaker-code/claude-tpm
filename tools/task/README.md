# task-tooling — JSON-first task storage (`#1112`)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The greenfield task store for `kind:"task"` records: one canonical JSON file per task (source of
truth), a derived human body `.md` plus a machine `tasks-index.json` and three human index `.md` views,
all regenerated on every write, and node-invokable tools for task verbs, `#1092` export/search, and the
`#1109` history-gate config.

**Status: promoted.** This store was built and hardened in the
`dev/20260920-task-features/task-tooling/` sandbox and promoted into this `tools/` tree as a gated step,
together with the session store. `--tasks-dir` is optional on every store op: when omitted the store is resolved from the project root's
`.claude/claude-tpm/config.json` (`tasks.tasksDir`); the flag overrides it. Pass a *scratch* dir for tests.

The canonical JSON envelope + `task` payload (with the editable-vs-mechanical field table and disk
layout) and the derived human render + export/search surface are described under [The JSON envelope +
human render](#the-json-envelope--human-render) below. The format-authority specs
(`task-json-format-spec.md` / `task-export-spec.md`) were not promoted out of the sandbox and are not
part of this tree; the per-tool `.md` references below are the promoted reference.

Per-tool references: [`tpm-task.md`](tpm-task.md) · [`tpm-task-export.md`](tpm-task-export.md) · [`tpm-task-router.md`](tpm-task-router.md) · [`tpm-task-config.md`](tpm-task-config.md) · [`tpm-task-migrate.md`](tpm-task-migrate.md) · [`tpm-task-doctor.md`](tpm-task-doctor.md).

---

## Architecture

The store is a pipeline of layers, each depending only on the ones above it:

```
base lib (kind-agnostic)   io · timestamp · normalize · version · envelope · validate · update · export-scaffold · hash · paths
        │                     atomic IO, versioning/migrate, envelope read/write, validate, apply-update, export scaffolding
        ▼                     the shared copy at the sibling tools/lib/, reached through lib/base.js (the ONE indirection, #1121)
task model (kind:"task")   lib/task-schema · lib/task-model
        │                     payload schema + editable table (registers the kind); load/save; lifecycle + subtask ops;
        │                     import primitives; the machine tasks-index.json writer + high-water nextId
        ▼
converter (pure)           lib/task-converter
        │                     render(record,{now}) -> the human body .md; renderIndexView(index,{states,now}) -> a view .md
        ▼                     no fs, no clock, no mutation
tools (node-invokable)     tpm-task.js          (verbs: list/show/add/edit/import/check/add-subtask/lifecycle/reindex/history)
                           tpm-task-export.js   (export + search on ONE selector core; #1092)
                           tpm-task-config.js   (resolves the `tasks` config section; the #1109 history gate)
                           tpm-task-router.js   (the `tpm task` sub-router; forwards to the tools above)
                           tpm-task-migrate.js  (opt-in whole-store old-markdown→JSON migrator; #1114.B)
                           tpm-task-doctor.js   (READ-ONLY validator + drift/label-index/old-format detector; #1119)
```

`tpm-task-migrate.js` and `tpm-task-doctor.js` are the Epic-2 additions. The migrator is a
convert-on-demand tool (never auto-runs); the doctor is strictly read-only and imports the migrator's
`detectStore` as its old-format check (the ONE detector, not re-implemented).

Only three things are `kind`-specific: the **payload schema** (`task-schema.js`), the **editable-field
table** (same file), and the **JSON→human converter** (`task-converter.js`). Everything else — the
envelope, versioning + migration, validate/apply-update, the content hash, and the export scaffolding —
is the shared base lib. The sibling session store (`#1113`) supplies its own schema/table/converter and
reuses the same base lib.

### The blessed shared base lib (`#1121` / OQ5)

`tool-conventions.md` §2/§6 normally forbid a shared cross-suite lib: each suite carries its own `lib/`,
duplication accepted. The base lib is the **one deliberate exception** — both the session and task
suites `require` the *same* runtime lib. Tasks do NOT copy it: the single physical copy lives at the
sibling `tools/lib/` (this promoted tree consolidates it there), reached from the task suite through the
single indirection `lib/base.js` — the only file that spells the path (`../../lib`). `base.js` re-exports
the ten base modules (`io · envelope · version · validate · update · normalize · timestamp ·
exportScaffold · hash · paths`); `node lib/base.js` self-checks that all ten load. This blessed shared-lib
exception is `#1121`, now realized (the shared lib lives at `tools/lib/`); it is the only shared-lib
dependency in the tree.

### Store invariants (from the spec)

The load-bearing guarantees, all enforced in the base lib:

- **Atomic writes.** Canonical JSON is written temp-file → `fsync` → atomic `rename`; a crash mid-write
  never leaves a partial file. `tasks-index.json` is written the same way. The derived `.md` files are
  regenerated **only after** the JSON write succeeds. History and subtask config live inside the one
  `task-<id>.json`, so a write is one atomic file — no cross-file race (the `#1100` fix for tasks).
- **Fail-loud reads.** `loadTask` follows read → migrate → validate; an unreadable or schema-invalid
  JSON is a loud failure naming the file, never a silent empty task.
- **Version tolerance.** An older *known* `schemaVersion` migrates on load; a newer *unknown* version is
  refused loud (the refuse-unknown-newer guard lives in `version.migrate`, run between read and
  validate). Unknown fields survive a round-trip.
- **Local-offset timestamps.** Every stored timestamp is ISO-8601 with an explicit local offset, never
  bare or `Z`. The human render shortens to `YYYY-MM-DD` (task granularity is coarser than session).

### The derived-file model

**JSON is canonical; every other file is derived and rebuildable.** Each mutating verb funnels through
`saveTask`, which:

1. stamps `timestamps.updatedAt` (the persist-time "updated" authority for `--updated-since`);
2. validates the payload (never persists a malformed canonical file);
3. writes the canonical `bodies/<lo>-<hi>/task-<id>.json` **atomically first**; then, only on success:
4. regenerates the derived body `bodies/<lo>-<hi>/task-<id>.md` (via `converter.render`);
5. upserts the task's thin row into `tasks-index.json` (recomputing counts, the high-water `nextId`, and
   the `#1071` `labels` reverse-index — a `label → [ids]` map rebuilt from the rows in lockstep, sorted
   deterministically);
6. regenerates the three human index views (via `converter.renderIndexView`).

So one canonical JSON fans out to **five derived files** across the store:

```
task-<id>.json  (CANONICAL)
   ├─▶ task-<id>.md               body render: banner + generated-from hash, title, State/Labels/Created,
   │                               Summary, Context, a **Subtasks:** (done/total) checkbox block, history pointer
   └─▶ tasks-index.json           machine index: one thin row/task (all states) + counts + high-water nextId
                                    + the #1071 labels reverse-index (label → [ids])
          ├─▶ task-index.md            human view: open + in-progress
          ├─▶ finished-tasks-index.md  human view: finished ∪ dropped
          └─▶ removed-tasks-index.md   human view: removed soft-stash
```

The body `.md` and the three index views are disposable: hand-edits are overwritten on the next save
(change content via `tpm task` ops or import). The banner's second line carries a `generated from:
<12hex>` content hash of the whole canonical record — the same shared hash the session doctor uses, so
drift detection comes free. `reindex` throws away the derived files and rebuilds `tasks-index.json` +
the views by scanning the `*.json` bodies; its `nextId` self-heals as
`max(prior nextId, max(bodyId)+1, startId)` so an id is never reused even after a body is deleted.

---

## File map

```
tools/task/
  README.md                      this file
  tpm-task.js  / .md             task verbs (list/show/add/edit/import/check/add-subtask/lifecycle/reindex/history)
  tpm-task-export.js / .md       export + search on ONE selector core (#1092)
  tpm-task-config.js / .md       the `tasks` config-section resolver (the #1109 history gate)
  tpm-task-router.js / .md       the `tpm task` sub-router (forwards to the tools above)
  tpm-task-migrate.js / .md      opt-in whole-store old-markdown→JSON migrator (#1114.B); exports detectStore
  tpm-task-doctor.js / .md       READ-ONLY validator: schema · hash-drift · label-index · old-format detect (#1119) · lock health · id health · lastWriter flag
  lib/
    base.js                      the ONE indirection → the shared base lib at the sibling tools/lib/ via ../../lib (#1121)
    # kind:"task" — the only kind-specific modules
    task-schema.js               TASK_KIND · STATES · TRANSITION_VERBS/TRANSITIONS · EDITABLE_TABLE · validatePayload (registers the kind)
    task-model.js                load/save · lifecycle + subtask ops · import* · history (gated) · deriveRow/deriveLabelIndex/readIndex/reindex/writeIndexViews
    task-converter.js            render(record,{now}) + renderIndexView(index,{states,now}) — pure; stamps the generated-from hash
    legacy-task-format.js        the copied lenient old-markdown parser (parseBody/parseIndex) the migrator reuses; NOT a shared lib
  tests/
    run-all.js                   forks one process per *.test.js; exits nonzero on any failure
    *.test.js                    23 suites incl. the store-lock trio task-lock · task-lock-interleave · task-lock-forced (base-load · task-schema · task-model · task-converter · tpm-task-ops ·
                                 tpm-task-export · integration-e2e · dogfood-corpus · ops-persist-fault · exit-code ·
                                 metadata · task-migrate · task-doctor · task-hard-remove · task-router-doctor-migrate ·
                                 index-now-golden; the list is abridged - the directory glob is the truth)
    fixtures/legacy-tasks/       clean / refuse-no-created / refuse-partial old-store fixtures (migrate + doctor tests)
    golden/                      task-1119.fixture.json + .expected.md (byte-exact body render) ·
                                 tasks-index.fixture.json + task-index.expected.md (byte-exact index-view render)
    helpers/                     task-e2e-helpers.js (shared test scaffolding, not a suite)
```

The base lib is **not** listed under `lib/` because the task suite does not vendor a copy — `lib/base.js`
reaches the single shared physical copy at the sibling `tools/lib/` (see "the blessed shared base lib" above).

---

## Running the tests

Zero dependencies; Node built-ins only. From this folder:

```
node tests/run-all.js
```

Real output (2026-09-20):

```
──────────────────────────────
16 suites run, 0 failed
```

Exit code `0`. `run-all.js` auto-discovers every `tests/*.test.js` (flat, non-recursive — `helpers/` is
never picked up) and forks a process per suite, so each suite is also runnable standalone, e.g.
`node tests/tpm-task-ops.test.js`. Every `lib/*.js` also self-checks via a bare `node lib/<file>.js`
(e.g. `node lib/task-model.js` runs an open→start→addSubtask→close-guard→check→finish smoke).

---

## Task verbs (`tpm-task.js`)

The capstone verb tool. Every MUTATION loads → mutates via the model → `saveTask` (canonical JSON atomic
first, then the five derived files). It re-implements none of the model/converter/IO. Full reference:
[`tpm-task.md`](tpm-task.md).

```
tpm task <verb> --tasks-dir <dir> [flags]
```

| Verb | Effect |
|------|--------|
| `list` | the human index view for a state set (`--state open\|in-progress\|finished\|dropped\|removed\|all\|wip\|active`; default open+in-progress). |
| `show <id>` | the rendered body `.md` for a task. |
| `add` | mint a task; id from the store high-water unless `--id`. `--headline` (required), `--label`/`--labels`, `--summary`, `--context`, `--body-txt-file <f> --field summary\|context` (#1107). |
| `edit <id>` | rewrite editable scalars (headline/labels/summary/context); `--body-txt-file` supported. |
| `import <id>` | #1106 JSON apply (`--file` or stdin): sets ONLY editable fields, IGNORES mechanical (id/state/timestamps/history/endAction); subtasks bulk-replace-by-key, **keep-missing by default** (OQ1), `--prune` to drop missing keys. `--template` emits a blank editable-fields skeleton. |
| `add-subtask <id>` | `--text "…" [--key K]` (auto-mints a spreadsheet key when none given). |
| `check <id> <key>` | flip a subtask to done (mechanical). |
| `start/finish/drop/remove/reopen <id>` | lifecycle transitions (G3 legality enforced). `finish` carries the #1111 close-guard (refused while any subtask is open, naming blockers); `finish`/`drop` take `--action`/`--note`/`--ref` (repeatable; drop aliases `--reason`) → the `endAction` (T-Q3: a non-null `endAction` always carries `refs:[]`). |
| `reindex` | rebuild `tasks-index.json` + the human views from the `*.json` bodies. |
| `history <id>` | read-only #1109 events (`--json` for the raw array). |

Verified end-to-end against a scratch store. The close-guard refusal is real:

```
$ tpm-task.js finish --tasks-dir <scratch> 1000
tpm-task: finishTask: refused — 1 open subtask(s) block close (#1111): A. Check or remove them first.
# exit 1
```

`export` / `search` are owned by `tpm-task-export.js`; `tpm-task.js export …` delegates to it (child
process, exit propagated).

---

## Export + search (`tpm-task-export.js`)

`tpm task export` and `tpm task search` on ONE selector core (#1092 C/D · E3): `buildSelector` parses the
identical selector set once, `selectCandidates` evaluates it against `tasks-index.json` (opening a body
only when `--match` or `--closed-since` needs it). Export emits the RECORDS, search emits
`id·file·line·snippet` POINTERS. Full reference: [`tpm-task-export.md`](tpm-task-export.md).

```
tpm task <export|search> --tasks-dir <dir> [SELECTORS…] [SHAPE…]
```

- **Selectors** (AND together): ids/ranges (also the comma form `"1112,1119"`) · `--state <s>[,<s>]`
  (+ `--open`, `--closed` sugar) · `--label` (repeatable) · `--match <text>` · `--opened-since` /
  `--opened-after` / `--opened-before` · `--updated-since` · `--closed-since` · `--last N --by
  updated|created|closed`. Windows are `<Nd|Nh|Nw>` relative or `YYYY-MM-DD`; an invalid window is an
  **EXIT-2 usage error** (`#1092-I`), never a silent empty result.
- **Shape** (export): `--json` / `--human` (default `--human` to stdout, OQ4) · `--combined` (default) or
  `--per-file --out <dir>` · `--thin` (drops `history[]` via `model.stripHistory`) · `--out <dir|file>`.
- **Combined JSON** is a bare array of envelopes for a multi-task match; a **single-task match collapses
  to a bare envelope object** (no length-1 array wrapper) — the base scaffold's one-vs-many dispatch.

Verified against a scratch store — the invalid-window guard is real:

```
$ tpm-task-export.js export --tasks-dir <scratch> --opened-since garbage
tpm-task-export: invalid window 'garbage' — expected a relative window (Nd | Nh | Nw) or a date (YYYY-MM-DD)
# exit 2
```

---

## Config + router (`tpm-task-config.js`, `tpm-task-router.js`)

`tpm-task-config.js` resolves the `tasks` section of a project `config.json` over built-in defaults so
every task tool AND the tpm-task skill read the same keys the same way. Its one JSON-first delta is the
`history: { enabled: true }` key — the #1109 gate `tpm-task.js` reads to turn history append on/off.
Full reference: [`tpm-task-config.md`](tpm-task-config.md).

`tpm-task-router.js` is the `tpm task` sub-router. `task` is a single-tool suite, so it forwards almost
everything verbatim to `tpm-task.js`; the reserved verbs `config` → `tpm-task-config.js` and
`export`/`search` → `tpm-task-export.js`. Dispatch is by child process and the child's exit is
propagated. Full reference: [`tpm-task-router.md`](tpm-task-router.md).

---

## The JSON envelope + human render

The format-authority specs that governed the build (`task-json-format-spec.md` shape-locked /
`task-export-spec.md` surface-locked) were not promoted into this tree; the shape below plus the
per-tool `.md` references are the in-tree description of the canonical envelope, the human render, and
the export/search surface.

Every record is the shared envelope (`schemaVersion`, `kind:"task"`) with the payload as **top-level
siblings** (not nested under a `task` key):

- `id` — mechanical string, monotonic ≥ 1000, never reused (D4).
- `state` — mechanical `open|in-progress|finished|dropped|removed`; moved ONLY by the lifecycle verbs
  (G3 legality). Import ignores a hand-set state.
- `headline` / `labels` (`string[]`, bare-string sugar #1116) / `summary` / `context` — the editable
  scalar set.
- `subtasks[]` — `{ key, text, state }`; `text` and the set are editable, per-item `state` (`open|done`)
  flips only via `check`/`reopen`.
- `timestamps` — all mechanical: `createdAt` (required) · `updatedAt` (required, stamped every mutation)
  · `startedAt` · `endedAt` (finished/dropped close) · `reopenedAt`.
- `endAction` — mechanical, set by `finish`/`drop` (`--action`/`--note`/`--ref`). `null` on an un-closed
  task; a NON-NULL `endAction` is `{ action?, note?, refs:[] }` and ALWAYS carries `refs` as an array
  (`[]` when none) — T-Q3, so a closed task's machine shape is uniform.
- `history[]` — mechanical, append-only audit (#1109), config-gated: off ⇒ nothing written, read reports
  none. Projected out of `--thin`/human/index views. Event shapes: `create` · `edit{field,value}` ·
  `state{from,to}` · `subtask{key,action}`.

**Editable vs mechanical.** The editable set is exactly what import may set: `headline`, `labels`,
`summary`, `context`, `subtasks` (text/set). Everything else is mechanical — tool-stamped, and ignored on
import even if supplied. The editable set is registered in `lib/task-schema.js` (`EDITABLE_TABLE`).

**Human render.** The body `.md` is derived and disposable, regenerated and overwritten from the JSON on
every save. Order is Title → State/Labels/Created → Summary → Context → Subtasks → history pointer. The
index views render `tasks-index.json` filtered by state as a `| # | State | Created | Task |` table;
the Created column reads `Nm/Nh/Nd ago` and switches to absolute `YYYY-MM-DD` at ≥ 7 days. The exact
render rules live in `lib/task-converter.js`; `tests/golden/` holds byte-exact body and index-view goldens.
