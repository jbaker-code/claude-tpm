# `tpm-task.js` — task verbs (#1106/#1107/#1109/#1111)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The node-invokable task **verb** tool for `kind:"task"` records (P06). It operates off the canonical
JSON: every mutating verb loads → mutates via the model → `saveTask`, which writes the canonical
`task-<id>.json` **atomically first**, then regenerates the derived body `.md`, the machine
`tasks-index.json`, and the three human index `.md` views. It composes `lib/task-model.js` +
`lib/task-converter.js` + `tpm-task-config.js` — re-implements none of the model/converter/IO.

Format authorities (cross-referenced, not restated here):
[`../task-json-format-spec.md`](../task-json-format-spec.md) (the JSON envelope + editable-vs-mechanical
table) and [`../task-export-spec.md`](../task-export-spec.md) (the human render). Overview + file map:
[`README.md`](README.md). Export/search: [`tpm-task-export.md`](tpm-task-export.md).

**Run:**
```
tpm task <verb> --tasks-dir <dir> [flags]
```
Programmatic callers `require('./tpm-task')` for `opAdd / opEdit / opImport / opAddSubtask / opCheck /
opTransition / opReindex / opHistory / opList / opShow` (each mutating op returns the persisted record).

## Common flags
| Flag | Meaning |
|------|---------|
| `--tasks-dir <dir>` | the task store (a SCRATCH or real dir). **Optional (F4/#1132)** — resolved by precedence: (1) this flag, (2) `TPM_TASKS_DIR` env, (3) local `.claude/claude-tpm/config.json` `tasks.tasksDir`, (4) the project-local default `<root>/.claude/claude-tpm/tasks` inside a `.claude/claude-tpm/`-marked project. **Outside any project it FAILS LOUD — never a silent live-store default** (the project-local default is inherently scoped; the flag/env may point anywhere). |
| `--config <path>` | `config.json` for the #1109 history gate (default: `<projectRoot>/.claude/claude-tpm/config.json`). |
| `--history on\|off` | override the history gate for this run (wins over config). |
| `--now <iso>` | reference time for `list`/`show` ages (default: now, local offset). |

Bare `tpm-task.js` (no args) prints usage and exits `1`; `--help` prints usage and exits `0`. An unknown
verb or bad flag exits `2`; a runtime failure (missing task, illegal transition, close-guard) exits `1`.

## Verbs
| Verb | Args / flags | Effect |
|------|--------------|--------|
| `list` | `[--state open\|in-progress\|finished\|dropped\|removed\|all\|wip\|active]` | render the human index view for a state set (default `open`+`in-progress`; `wip`=in-progress, `active`/`open+wip`=open+in-progress, `all`=every state). To stdout. |
| `show` | `<selector> [--state <s>]` | render the derived body `.md` for the selected task(s) to stdout. Selector (shared §5 grammar, #1132): `all` \| `<id>` \| `<id>,<id>,…` \| `<lo>-<hi>` (ascending; descending is an error; sparse ranges skip). Default pool `open`+`in-progress` (like `list`); `--state` widens it — so `show all` renders every OPEN body, `show all --state all` every body. Bodies join with a `---` separator; a valid selection matching nothing prints `(no matching tasks)` (never a `NaN` path). No selector → `a task id is required` (exit 1). |
| `add` | `--headline "…"` (required) `[--label L]… [--labels "a,b"] [--summary …] [--context …] [--body-txt-file <f> --field summary\|context] [--id <id>]` | mint a task; id allocated from the store high-water unless `--id`. #1107: `--body-txt-file` reads a raw file verbatim into summary\|context (field default `summary`). |
| `edit` | `<id> [--headline …] [--label L]… [--labels …] [--summary …] [--context …] [--body-txt-file <f> --field …]` | rewrite ONLY the supplied editable scalars (mechanical fields never touched). |
| `import` | `<id> (--file <f> \| stdin) [--prune]` | #1106 JSON apply: sets ONLY editable fields, IGNORES mechanical (id/state/timestamps/history/endAction); subtasks bulk-replace-by-key, **KEEP-MISSING by default** (OQ1) — a key absent from the incoming set is kept, not dropped; `--prune` opts into dropping missing keys. Accepts a bare editable-fields object OR a full exported record. A `null` `summary`/`context` is accepted (F3-lenient). |
| `import` | `--template` | emit a blank editable-fields JSON skeleton to stdout (safe to fill + re-import). |
| `add-subtask` | `<id> --text "…" [--key K]` | append an OPEN subtask; auto-mints the next spreadsheet key (A, B, …) unless `--key`. |
| `check` | `<id> <key>` (or `--key K`) | flip a subtask to `done` (mechanical). |
| `start` | `<id>` | open → in-progress (stamps `startedAt`). |
| `finish` | `<id> [--action "…"] [--note "…"] [--ref "…"]…` | {open,in-progress} → finished. `--action`/`--note`/`--ref` fill the #1074 `endAction` (`--ref` repeatable). **#1111 close-guard: REFUSED while any subtask is `open`, naming the blockers.** |
| `drop` | `<id> [--reason "…"] [--note "…"] [--ref "…"]…` | {open,in-progress} → dropped (`--reason` aliases `endAction.action`). |
| `remove` | `<id> [--hard]` | Without `--hard`: → removed (soft-stash; recoverable; no `endedAt`). With `--hard`: PURGES the canonical body (+ derived `.md`) and reindexes — UNRECOVERABLE. `--hard` is CONFIG-GATED: it refuses unless `tasks.allowHardDelete` is `true` (default OFF/safe, #1086), naming the key. The reindex preserves the nextId high-water so a purged id is never reissued. |
| `reopen` | `<id>` | {finished,dropped,removed} → open (clears the close). |
| `reindex` | `[--drop-unreadable]` | rebuild `tasks-index.json` + the three human views from the `*.json` bodies. **Fails loud**: if any body cannot be loaded (a newer `schemaVersion`, corrupt, invalid) it REFUSES, lists every such body (count + id + file + reason), writes nothing and exits `1` — the existing index (and its old rows) stays. `--drop-unreadable` is the ONLY way to discard those rows (it lists what it dropped; the body files stay on disk). |
| `history` | `<id> [--json]` | read-only #1109 events (plain lines, or the raw array with `--json`). |

Illegal lifecycle moves are rejected loud (G3); a `redundantFrom` move (already in the target lane) is an
idempotent no-op. Mutating verbs print a one-line confirmation to **stderr**; rendered output (`list`,
`show`, `history`, `import --template`) goes to **stdout**.

## The mutation contract
Every mutation writes `task-<id>.json` atomically FIRST, then regenerates the five derived files. Import
NEVER trusts a mechanical field from the JSON (verified: importing `{"state":"finished","id":"9999"}`
against an open task 1500 left it `state=open id=1500`). State moves ONLY via the lifecycle verbs. A
supplied `null` `summary`/`context` is accepted and stored `null` (F3-lenient — never coerced, never a
crash, never flagged by the doctor).

`endAction` shape (T-Q3): a NON-NULL `endAction` from `finish`/`drop` ALWAYS carries `refs` as an array
(`[]` when none), so a closed task's machine shape is uniform — `{ action?, note?, refs:[] }`. A bare
`finish`/`drop` with nothing supplied leaves `endAction: null`. Verified: `finish 1000 --action shipped
--ref PR#42 --ref "commit abc"` stored `{"action":"shipped","refs":["PR#42","commit abc"]}`; a bare
`finish` stored `null`.

## The store lock (multi-session support)
Every MUTATING verb (`add edit import add-subtask check start finish drop remove reopen label unlabel remove --hard reindex`) holds the store's directory lock, `<tasksDir>/.lock`, for its WHOLE read-modify-write: from the first read the write depends on (id allocation, the body, the index) to the last write (the three index views). Two Claude instances can therefore run verbs against one store at the same moment and can never be handed the same id or lose each other's index update. The lock lives inside the resolved tasks dir, so a scratch `--tasks-dir` locks only the scratch store. It is taken AFTER the un-migrated-store guard (a refused 0.1.0 store never gets a `.lock`), and every stdin / `--file` / `--body-txt-file` input is read BEFORE it is taken. `migrate` writes only to a staging out-dir and needs no live-store lock.

### What is locked, and what is not

| Locked (waits its turn) | NOT locked |
|---|---|
| `add edit import add-subtask check start finish drop remove reopen label unlabel remove --hard reindex` | `list show labels history export search doctor` (read-only), and `migrate` (see sharp edge 1) |

- **Read verbs never wait.** They take no lock. Their reads retry a transient `ENOENT` (a few ms, up to 3 times, only for a file that exists) so a reader racing a writer's rename-over still sees correct output. Verified: with a writer holding the lock, `list` and `show` returned in about half a second and `doctor` ran and reported the lock as held.
- **Why a lock, not just atomic writes.** The lock covers the whole read, modify, write. Atomic rename alone (already used for every file) prevents a torn file but not a lost update; the lock is what prevents two writers both reading the same `nextId` or the same index.
- **`lastWriter` stamp.** Under the lock every mutating verb writes `lastWriter: {version, at}` as a top-level key of `tasks-index.json` (older tools preserve unknown keys; the index is not reshaped). `tpm task doctor` flags a store last written by an older or unstamped tpm. One live store should be used by one tpm version: the lock is advisory to older tools.
- **Never committed.** The lock directory (and its `.lock.broken.*` leftovers) holds a `.gitignore` containing `*`, written before the directory gets its name, so git ignores it. The doctor flags one that lacks it. The mechanism is asserted by the tests; that git really prints nothing for it is **confirmed by `git` at the commit point** (`git status` in a repo holding a live lock) - `git` is blocked in the VM this was built in, so that last step has not been run here.

### What you see

Knobs: `TPM_LOCK_WAIT_MS` (wait budget, default 45000) and `TPM_LOCK_STALE_MS` (stale age, default 30000); there is no `--wait` flag.

**A verb has to wait.** After 2 s it prints one line, and keeps waiting (jittered 20-50 ms polls). Real output, with another process holding the lock and a 4 s budget:

```
$ TPM_LOCK_WAIT_MS=4000 tpm task add --tasks-dir <store> --headline second
tpm-task: waiting for lock <store>/.lock (held by pid 46315 on host admins-Virtual-Machine.local, verb edit, version 0.2.0-dev, for 3 s)
tpm-task: gave up waiting 4 s for lock <store>/.lock, held by pid 46315 on host admins-Virtual-Machine.local, verb edit, version 0.2.0-dev, taken 2026-10-07T16:10:47-07:00 (5 s ago). It is not stale yet (stale after 30 s). Re-run in a moment.
# exit 1; nothing was written
```

**A stale lock is broken, loudly.** A holder whose pid is dead (or reused) on this host, or that has held the lock past 30 s, loses it to the next verb, which prints who held it and why, and keeps the broken lock for the doctor. Real output (the holder was `kill -9`'d):

```
$ tpm task add --tasks-dir <store> --headline second
tpm-task: breaking a stale lock <store>/.lock
  held by pid 46468 on host admins-Virtual-Machine.local, verb edit, version 0.2.0-dev, claude session b08e47cc, taken 2026-10-07T16:11:05-07:00 (1 s ago)
  reason: process 46468 is not running
  moved to .lock.broken.46523.1791414666477; its write may be incomplete: run `tpm task doctor`; if it reports drift, `tpm task reindex`.
tpm-task add: created task #1001 (state open).
```

A lock owned by another host is never judged by pid (only by age). A lock directory with no readable `owner.json` is never auto-broken.

**Clearing a stuck lock by hand.** Only when no tpm process is running, and only for a lock that is not going to clear itself (the verb times out and tells you so). Real output for a lock directory with no owner record:

```
$ TPM_LOCK_WAIT_MS=1000 tpm task add --tasks-dir <store> --headline third
tpm-task: gave up waiting 1 s for lock <store>/.lock: its owner record is missing or unreadable, so it cannot be judged stale. If no tpm process is running, remove (or move aside) the directory <store>/.lock by hand.
# exit 1
$ mv <store>/.lock <store>/.lock.aside        # no rm needed
$ tpm task add --tasks-dir <store> --headline third
tpm-task add: created task #1002 (state open).
```

Afterwards run `tpm task doctor`; if it reports drift, `tpm task reindex`. `tpm task doctor` also names every state of the lock (HELD, STALE, INCOMPLETE, UNIGNORED, leftovers); see [`tpm-task-doctor.md`](./tpm-task-doctor.md).

**`reindex` will not silently drop a task.** If a body will not load (for example a `schemaVersion` newer than this tpm), `reindex` refuses, writes nothing, and exits 1:

```
$ tpm task reindex --tasks-dir <store>
tpm-task: reindex REFUSED: 1 task body(ies) could not be read, and an index rebuilt now would silently drop them:
  - #1001 (bodies/1000-1999/task-1001.json): migrate: refusing record with newer schemaVersion '9.0.0' — this code understands up to '1.0.0'; upgrade the tooling before reading this file.
Nothing was written; the existing index is unchanged. Upgrade tpm if a body is from a newer version, fix the body, or re-run with --drop-unreadable to discard these rows from the index (their body files stay on disk).
# exit 1
$ tpm task reindex --tasks-dir <store> --drop-unreadable
tpm-task reindex: rebuilt index for 2 task(s); nextId 1003.
tpm-task reindex: DROPPED 1 unreadable body(ies) from the index (--drop-unreadable); the body files remain on disk:
  - #1001 (...): migrate: refusing record with newer schemaVersion '9.0.0' — ...
# exit 0
```

### Sharp edges

1. **`migrate --out-dir <a live store> --force` bypasses the lock. It is unsupported: `--out-dir` is a STAGING directory.** Observed: with a real verb holding `<store>/.lock`, `tpm task migrate --in <old> --out-dir <store> --force` ran straight through (exit 0), overwrote task 1000 with the migrated body and replaced `tasks-index.json` (the store's own task was gone from the index). Migrate into an empty staging dir, then promote it by hand with no verb running (see [`tpm-task-migrate.md`](./tpm-task-migrate.md)). Without `--force`, a non-empty target is refused.
2. **Stranded-index recovery: do NOT run `add` between the move-aside and the `reindex`.** If `tasks-index.json` exists but cannot be read (a rare rename-over artefact on a shared mount; a read verb and `reindex` both then fail loudly after the bounded retries), the recovery is two commands, back to back, with nothing else touching the store in between:
   ```
   mv tasks-index.json tasks-index.json.aside
   tpm task reindex
   ```
   With the index moved aside, an `add` sees an empty store and starts again at the start id. Observed on a scratch store of #1000 alpha, #1001 beta, #1002 gamma: after the move-aside, `add --headline INTRUDER` reported `created task #1000` and OVERWROTE alpha's body (bodies on disk were then INTRUDER, beta, gamma). Run `reindex` immediately; if an `add` already ran, the overwritten body is lost (restore it from version control or backup before reindexing). Done in order, nothing is lost: on a scratch store the same two commands gave `rebuilt index for 3 task(s); nextId 1003`, and the next `add` was `#1003`. Unverified: the exact `ENOENT-on-an-existing-file` trigger (not reproducible here); an unreadable index was simulated with `chmod 000` and failed the same way (`readCanonicalSync: cannot read canonical file ... tasks-index.json: EACCES`, also for `reindex`, exit 1).

## Un-migrated 0.1.0 store guard (#1114.B)
Before any verb runs, the resolved store is checked with the migrator's one old-format detector (`detectStore`, the same one the doctor uses). If it is a CLEAN un-migrated 0.1.0 markdown store (`bodies/<lo>-<hi>/task-<id>.md` with NO JSON body and NO `tasks-index.json`), every verb REFUSES loud (exit `1`) with a message that points at `tpm task migrate` — instead of seeding a fresh JSON store whose id counter resets and silently overwrites the old tasks (the 0.2.0-upgrade incident this guards against). The block is POSITIVE-only: `detectStore` throws for an already-migrated, empty, or non-store/variant dir, and in that case the verb runs exactly as before — so a fresh empty project store still accepts the first `add`, and a migrated store is never touched. A detector hiccup can never brick the tool (fail-open on any throw). Run `tpm task doctor` to confirm a store's format; see [`tpm-task-migrate.md`](./tpm-task-migrate.md) for the staged migrate-then-promote flow.

## Session attribution (multi-session support)

Several Claude instances can work one project at once, so every history event a verb writes says WHICH tpm session made it.
Each event carries two extra keys: `"session": "session-0012b"` (track a is `session-0012`, with no letter) and
`"sessionVia": "flag" | "env" | "lookup"` (how it was found). When nothing resolves, BOTH keys are omitted (never `null`).
`tpm task history <id>` shows the value in brackets (`[session-0012b]`); `--json` shows both keys as stored.

**Resolution order** (once per run, before the store lock, only for verbs that write an event and only when history is on):

1. `--session` flag (with optional `--track`)  ->  `sessionVia: "flag"`
2. `TPM_SESSION_ID` environment variable  ->  `"env"`
3. lookup of the Claude session id (`CLAUDE_CODE_SESSION_ID`) against the session tracks in the sessions folder
   (`TPM_SESSIONS_DIR`, else the project's configured sessions folder)  ->  `"lookup"`
4. blank (keys omitted)

Attribution never blocks a write. A missing sessions folder, no Claude id, a corrupt track record, an ambiguous lookup (two live tracks of one session owned by the same Claude id give blank), a
disabled session module (`session.enabled: false`) or a malformed `TPM_SESSION_ID` all just give the next rung, ending at blank.
Old history is NOT back-filled: events written before this feature (or while nothing resolved) stay without the keys, and they still load, validate and render.

**`TPM_SESSION_ID` is a MANUAL override** for scripts and humans, for when the automatic lookup cannot know the session (a
script run from outside a Claude session, a cron job, a hand-driven shell). Inside a Claude session you normally set nothing:
the lookup finds your track by itself. It accepts the same spellings as `--session` (`12`, `0012`, `0012b`, `session-0012b`);
a malformed value (`bogus!`, a UUID, `0`, `12345`, upper-case `0012B`, empty) is silently ignored, with no error and no output. It beats the lookup even
when the lookup would disagree. The child-session launcher sets it for the child it starts (see `tools/child-session`).

**`--session <ref> [--track <letter>]`** goes before or after the verb, on every verb of `tpm-task.js` (`export`, `search`, `doctor`, `migrate` and `config` have their own
parsers and reject it: `tpm-task-export: unknown flag '--session'`). `--session 0012b` and
`--session 0012 --track b` are the same; `--session 0012` alone means track a when stamping. A malformed value, a `--track`
without `--session`, or a letter that disagrees (`--session 0012a --track b`) is a usage error: exit 2, nothing written.
Unlike `tpm session` (which wants `--session 0012 --track b`), the combined `0012b` form is accepted here. Nothing checks the
session exists: the flag is grammar-checked only.

**`list --session <ref>`** FILTERS to tasks that have at least one history event from that session, derived by scanning
history (nothing extra is stored). A bare number (`--session 12`) matches every track of that session; a letter pins one
(`--session 0012b`, or `0012 --track b`; `a` matches `session-0012`).

Worked example (scratch store, fake Claude id `fake-id-bbb` owning track b of session 12):

```
$ TPM_SESSIONS_DIR=<sessions> CLAUDE_CODE_SESSION_ID=fake-id-bbb CLAUDE_PID=1 tpm task add --tasks-dir <t> --headline L2
tpm-task add: created task #1000 (state open).
$ tpm task start --tasks-dir <t> 1000        # with TPM_SESSION_ID=0012 in the environment
$ tpm task start --tasks-dir <t> 1001 --session 0012c
$ tpm task history --tasks-dir <t> 1000 --json
[ { "at": "...", "op": "create", "session": "session-0012b", "sessionVia": "lookup" },
  { "at": "...", "op": "state", "from": "open", "to": "in-progress", "session": "session-0012", "sessionVia": "env" } ]
$ tpm task add --tasks-dir <t> --headline x --session 0012a --track b
tpm-task: --session '0012a' and --track 'b' disagree        # exit 2
$ tpm task list --tasks-dir <t> --session 12      # tasks with an event from ANY track of session 12
$ tpm task list --tasks-dir <t> --session 0012b   # only track b
```

Heads-up: the stored value (`session-0012b`) deliberately differs from the session suite's `fromSession` label (bare `0012b`);
never compare them as strings. A tool that needs the current session should call the shared resolver, `tools/lib/attribution.js`.

## History gate (#1109)
`--history off` (or a config `tasks.history.enabled: false`) makes every history append a no-op — nothing
is written and `history <id>` reports `(no history events)`. Default is ON. Config-resolution failure
never breaks a store op (it falls back to ON).

## Examples
```
tpm task add --tasks-dir /tmp/t --headline "Wire the router" --label infra --summary "port it"
tpm task list --tasks-dir /tmp/t --now 2026-09-20T15:00:00-07:00
tpm task start --tasks-dir /tmp/t 1000
tpm task add-subtask --tasks-dir /tmp/t 1000 --text "first sub"
tpm task check --tasks-dir /tmp/t 1000 A
tpm task finish --tasks-dir /tmp/t 1000 --action "shipped in PR 42" --ref "PR#42"
tpm task import --template > patch.json      # fill it in, then:
tpm task import --tasks-dir /tmp/t 1500 --file patch.json
tpm task history --tasks-dir /tmp/t 1500 --json
tpm task reindex --tasks-dir /tmp/t
```

Real close-guard refusal (open subtask `A` blocks `finish`):
```
$ tpm task finish --tasks-dir /tmp/t 1000
tpm-task: finishTask: refused — 1 open subtask(s) block close (#1111): A. Check or remove them first.
# exit 1
```

Tests: `tests/tpm-task-ops.test.js` + `tests/integration-e2e.test.js` (auto-discovered by
`tests/run-all.js`).
