# `tpm-task-doctor.js` — read-only task-store validator + drift detector (`#1119`)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The task **doctor**: a strictly READ-ONLY health check over a task store. It validates every
canonical `bodies/<bucket>/task-<id>.json`, detects derived-file **drift** (the JSON changed since
its body `.md` was rendered), checks the **label reverse-index**, and detects an **old-format**
markdown store and SUGGESTS the migrator. It never writes, mutates, migrates, or re-renders anything.
There is no `--fix`.

The task-side mirror of `../../20260919-session-features/session-tooling/tpm-session-doctor.js`.
Node-invokable, no `bin` (`#1121`): run via bare `node`. Zero third-party deps.

Format authority (cross-referenced, not restated): [`../task-json-format-spec.md`](../task-json-format-spec.md).
Overview + file map: [`README.md`](README.md). The old-format detector + migrate command:
[`tpm-task-migrate.md`](tpm-task-migrate.md).

---

## Usage

```
tpm task doctor --tasks-dir <dir> [--json]
```

| Flag | |
|---|---|
| `--tasks-dir <dir>` | **Optional:** omitted, it is resolved from the project root's `.claude/claude-tpm/config.json` (`tasks.tasksDir`); the flag overrides. The task store root (`bodies/<bucket>/task-<id>.json` in the nested bucket layout + `tasks-index.json`). READ-ONLY. |
| `--json` | Emit the structured report as JSON instead of human text. |
| `--help` | Show usage (exit `0`). |

Programmatic callers `require()` it for `runDoctor(opts) -> report`.

---

## The checks (four store checks + lock health, id health, last-writer flag)

Bodies are discovered by `task-model.listBodyPaths` — the NESTED `bodies/<bucket>/task-<id>.json`
layout, the store's real shape (a task store is a single dir, so detection is whole-store, not the
session doctor's per-subdir sweep).

1. **Schema validation.** Each body runs the canonical load path, stage-labeled so a failure names
   the stage instead of crashing the run:
   - `readCanonicalSync` throws → **FAIL [read]** (unreadable / corrupt JSON).
   - `version.migrate` throws → **FAIL [migrate]** (unknown, newer-than-code `schemaVersion`).
   - `validateEnvelope` + `task-schema.validatePayload` throws → **FAIL [validate]** (the exact violation).
   - all pass → **OK**.

2. **Hash-drift (read-only).** The derived body `.md` carries a `<!-- generated from: <12hex> -->`
   banner that is `hash.hashRecord(record)` stamped at render time. The doctor recomputes
   `hashRecord` over the CURRENT on-disk JSON and compares to the banner. A mismatch means the **JSON
   changed** since the body was rendered (a save that skipped the re-render, or a hand-edited JSON) →
   **DRIFT**. It recomputes + string-compares only; it never re-renders. Because the hash is over the
   record content, not the clock, there are no `now`-relative false positives. (Editing the `.md`
   text without changing its banner does not register — the check is JSON-vs-banner, not
   render-vs-`.md`.)

3. **Label-index consistency.** `tasks-index.json.labels` is the `#1071` label→ids reverse index the
   model keeps in lockstep with the rows. The doctor recomputes `model.deriveLabelIndex(index.tasks)`
   and compares to the stored `index.labels`:
   - `OK` — the two match.
   - `MISMATCH` — they differ → **SUGGEST `tpm task reindex`** (never rebuilds).
   - `MISSING` — bodies exist but there is no `tasks-index.json` → SUGGEST reindex.
   - `CORRUPT` — `tasks-index.json` is unparseable / has no `tasks` array → SUGGEST reindex.
   - `NONE` — empty store (no index, no bodies): nothing to check.

4. **Old-format detect.** Imports the migrator's `detectStore` (the ONE old-format detector, NOT
   re-implemented). Probed FIRST: a clean markdown-only store has no JSON bodies to validate, so when
   one is detected the doctor reports it + **SUGGESTS `tpm task migrate`** and stops. A `MigrateError`
   refusal means "not a clean old store" → falls through to checks 1–3. Never migrates.

5. **Lock health (multi-session).** `<tasksDir>/.lock` is inspected with the same `lock.inspect` / `isStale` the verbs use (one stale rule). Prints nothing when there is no lock.
   - `HELD` — a live holder inside the 30 s limit; normal while a verb runs; **not** a problem.
   - `STALE` — holder dead/reused on this host, or held past the limit → **problem** (any task verb will break it loudly, or inspect it).
   - `INCOMPLETE` — the directory has no readable `owner.json`; never auto-broken → **problem** (move it aside by hand once no tpm process runs).
   - `UNIGNORED` — a lock directory without its self-ignoring `.gitignore`, so it could be committed → **problem**.
   - Leftover `.lock.broken.*` / `.lock.new.*` / `.lock.rel.*` directories are listed (advisory; a `.broken.*` dir means a holder died, so check drift and `reindex` if in doubt); one lacking a `.gitignore` is a **problem**.

6. **Id health.** The lock prevents duplicate ids; this reports them if they ever happened (an old tool, a hand edit, a merge). Each is a **problem**, report-only: `DUPLICATE` (two bodies carry one in-file id), `FILENAME-MISMATCH` (`task-1005.json` holding id 1001), `DUP-ROW` (an id twice in the index), `NEXTID-REGRESSED` (`nextId` <= the highest body id: the next `add` would overwrite a body), `UNINDEXED` (a body with no index row), `ORPHAN-ROW` (a row whose body is gone). Suggests `tpm task reindex` (a duplicate id needs a human to renumber one body first). Silent on a healthy store.

7. **Last-writer flag (advisory).** `tasks-index.json.lastWriter` is `{version, at}`, stamped under the lock by every mutating verb. The doctor FLAGS (exit unchanged) a store last written by an **UNSTAMPED** tool (no stamp) or an **OLDER** tpm (stamped version < this one, compared on `x.y.z`): an older tool ignores the lock and can lose updates. Silent when the last writer is this version or newer.

---

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Clean store — no problems. Advisories (`UNSTAMPED`, a missing `.md`) are allowed and do NOT flip it. |
| `1` | Problems found — an invalid record, hash-drift, a label-index `MISMATCH`/`MISSING`/`CORRUPT`, a `STALE`/`INCOMPLETE`/`UNIGNORED` lock, any id-health problem, OR a detected old-format store. Still report-only; nothing is written. |
| `2` | Usage error — bad/unknown flag, missing `--tasks-dir` value, or an unreadable/non-directory store dir. |

The advisory posture, verified: a body whose `.md` sibling is **missing** → `drift NONE`, exit
unchanged (`0`); a `.md` with **no banner** → **UNSTAMPED** advisory, exit unchanged (`0`). Neither
is a hard problem. (There is no `--strict` — the task exit contract lumps every real finding as
nonzero, so a strict/advisory split would only muddy it.)

---

## Report shape

- **Human (default):** a header (`N task(s) · X valid · Y invalid · Z drift [· W unstamped] ·
  label-index <status>`), one line per body (`OK` / `FAIL [stage]: …` / `OK · DRIFT (banner … ·
  current … — …)` / `OK · UNSTAMPED (…)`), then the label-index suggestion block (on
  MISMATCH/MISSING/CORRUPT) and a closing `Clean — no problems found` on exit 0. An old-format store
  prints its own block with the migrate suggestion.
- **`--json`:** `{ tasksDir, oldFormat, bodies:[{file, id, validate:{status,stage?,problem?},
  drift:{status,bannerHash?,currentHash?}}], labelIndex:{status,…}, summary:{bodies, valid, invalid,
  drift, unstamped, labelIndex, oldFormat, lock, idProblems, writer}, lock:{status,owner?,leftovers,…}, ids:{status,problems[]}, writer:{status,version?}, exitCode }`.

Verified runs against scratch stores:

```
$ tpm task doctor --tasks-dir <clean>
task doctor · <clean>
2 task(s) · 2 valid · 0 invalid · 0 drift · label-index OK
  bodies/1000-1999/task-1000.json  OK
  bodies/1000-1999/task-1119.json  OK

Clean — no problems found. (Read-only: the doctor never writes.)
# exit 0

$ tpm task doctor --tasks-dir <json-hand-edited>
2 task(s) · 2 valid · 0 invalid · 1 drift · label-index OK
  bodies/1000-1999/task-1119.json  OK · DRIFT (banner 855e551c5933 · current e981f136e25d — body out of date; re-save via `tpm task`)
# exit 1

$ tpm task doctor --tasks-dir <old-markdown-store>
OLD-FORMAT task store detected (2 markdown body(ies), Next ID marker 1150).
  → SUGGEST migrate (the doctor never converts):
      tpm task migrate --in "<old-markdown-store>" --out-dir "<choose-an-output-dir>"
# exit 1
```

Verified lock / writer runs (scratch stores; `<store>` abbreviates the path; the lock lines print only when there is something to say):

```
# a live verb holds the lock                                  -> exit 0 (HELD is not a problem)
Lock: HELD by pid 46315 on admins-Virtual-Machine.local, verb edit, tpm 0.2.0-dev, taken 1 s ago (normal while a task verb runs; not a problem).

# the holder was kill -9'd                                    -> exit 1
Lock: STALE (process 46468 is not running) — held by pid 46468 on admins-Virtual-Machine.local, verb edit, tpm 0.2.0-dev, taken 1 s ago. PROBLEM, report-only:
  run any task verb (it breaks a stale lock loudly), or inspect <store>/.lock

# .lock exists with no owner.json                              -> exit 1
Lock: INCOMPLETE — <store>/.lock exists but its owner record is missing or unreadable, so it cannot be judged stale. PROBLEM, report-only:
  if no tpm process is running, move the directory aside by hand (e.g. mv .lock .lock.aside).
  (it also has no .gitignore, so it could be committed.)

# .lock/.gitignore removed from a held lock                    -> exit 1
Lock: UNIGNORED — <store>/.lock has no .gitignore, so it could be committed. PROBLEM, report-only:
  add a .gitignore containing "*" inside it (or move the directory aside once no verb is running).

# after a stale lock was broken                                 -> exit 0 (advisory)
Lock leftovers (1): .lock.broken.46523.1791414666477
  a .broken.* dir is a stale lock that was broken: its holder died, so its last write may be incomplete — check the drift lines above; `tpm task reindex` if in doubt.

# index stamped by an older tpm / by no stamp at all             -> exit 0 (advisory)
Last writer: OLDER — this store was last written by tpm 0.1.5 (at 2026-10-07T16:11:24-07:00), older than this tpm 0.2.0-dev. An older tpm ignores the lock and can lose updates; use one tpm version per live store. (advisory)
Last writer: UNSTAMPED — tasks-index.json carries no `lastWriter`, so this store was last written by a tpm that predates the stamp (this is 0.2.0-dev). An older tpm ignores the lock and can lose updates; use one tpm version per live store. (advisory)
```

`--json` on a healthy store carries `lock:{status:"NONE",lockDir,leftovers:[],leftoversUnignored:[]}`, `ids:{status:"OK",problems:[]}`, `writer:{status:"OK",version,at,running}` and the summary keys `lock`, `idProblems`, `writer`.

**Clearing a stuck lock by hand:** see "Clearing a stuck lock by hand" in [`tpm-task.md`](./tpm-task.md#what-you-see) (`mv .lock .lock.aside`, only when no tpm process runs; then re-run the doctor and `reindex` if it reports drift). The doctor itself never touches the lock.

---

## Composition (re-implements nothing)

`lib/base.js` → `io.readCanonicalSync` · `version.migrate` · `validate.validateEnvelope` ·
`envelope.KNOWN_KINDS` · `hash.hashRecord` (the SHARED content hash the converter stamps into the
banner) · `task-schema.validatePayload` · `task-model.listBodyPaths` / `deriveLabelIndex` /
`indexPathFor` · `tpm-task-migrate.detectStore` / `MigrateError`. Zero third-party deps.

---

## Read-only guarantee (tested)

`tests/task-doctor.test.js` builds a scratch fixture store (valid, schema-invalid, drifted,
unstamped, missing-`.md`, label-mismatch, old-format), snapshots every file before/after `runDoctor`
in all modes, and asserts every file is byte-identical and none was created or deleted. The validate
and drift checks are mutation-proven (blanking a headline turns `invalid` 0→1; a JSON hand-edit turns
`drift` 0→1 with `bannerHash != currentHash`). Exit-code rows live in `tests/exit-code.test.js`. Both
run via `tests/run-all.js`.
