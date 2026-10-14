# tools/ — canonical tool ledger

The single source of truth for every tool that ships in claude-tpm: what it is, how (if at all) you run
it, and where its fuller doc lives. **Keep this current** — when you add, remove, or rename a tool,
update this file in the same change. The ledger is exhaustive (every tool that exists is listed) and
honest (nothing that no longer exists is listed). This is the one canonical index. Two suites (`session/`, `task/`) additionally
keep a long-form `README.md` (architecture, data format, per-verb walk-through) that this ledger does not
duplicate — everything else is documented per tool in `<tool>.md`. The authoring rules behind it — portability, the "runnable by a bare `node`"
convention, and this ledger's contract — live in
[`../claude-context/methodology/tool-conventions.md`](../claude-context/methodology/tool-conventions.md).

**How to read a bullet.** Each tool is `` `path` `` — one sentence. A **Run:** line appears only when the
tool is wired into a run command (claude-tpm exposes the `tpm` bin, so that's `tpm …`); tools with no
`npm run` / `npx` wiring — internal helpers, hook scripts invoked by the harness, one-off utilities — get
no Run line. A **Doc:** pointer names the tool's reference (`<tool>.md`) or "header" when the doc is the
top-of-file docstring.

**Command forms.** In a Claude session (plugin enabled) the plugin's `bin/` is on `PATH`, so Claude runs the bare
`tpm <suite> <verb>`; every Run: line below is written that way. A *human* at a terminal inside a project that vendors
the package runs the same commands as `npx tpm <suite> <verb>` (never `npx tpm` where there is no local
`node_modules/.bin/tpm` — npx would fetch an unrelated registry package).

Human terminal: the pre-install porcelain (`install` / `uninstall` / `doctor`) runs before the plugin's bin is on `PATH`, so it is listed as `npx tpm …`.

**The `tpm` front door.** `tools/tpm.js` is the package `bin`, so everything wired runs as `tpm
<suite> <verb>`. `tpm.js` is a **dumb top dispatcher**: it knows only
the five suites (`session` / `task` / `workflow` / `hooks` / `plugin`) plus the flat consumer aliases
(`install` / `uninstall` / `doctor`), and forwards `<everything-after>` to that suite's own router. The per-suite
routers own their verb tables and self-locate their scripts via `__dirname`, so no `%TPM_HOME%`/env is
needed. Dispatch is by child process with faithful arg/stdio pass-through and exit-code propagation.

- **`bin/tpm`** — bash PATH shim (`exec node …/tools/tpm.js "$@"`, symlink-safe, self-locating). Claude Code puts the plugin's `bin/` on PATH, so a bare `tpm <suite> <verb>` works in every project (no `npx tpm` registry-fallthrough risk). Run: `tpm <suite> <verb>` · Doc: header · Test: `tools/tests/tpm-bin-shim.test.js`
- **`tools/tpm.js`** — the top dispatcher / front door; routes `<suite> <verb>` to the per-suite router, plus the flat consumer aliases `install` / `uninstall` / `doctor` (unknown → exit 2; bare / `--help` → menu). Run: `tpm <suite> <verb>` · Doc: `tpm.md`
- **`tools/tpm-reading-list.js`** — emit a role's methodology reading chain in anchor form (a `tpm resolve-home` line + one `tpm doc <bundle-relpath>` per entry), derived from the live reading-list manifests; self-locating, zero-dep. Run: `tpm reading-list <role>` (orchestrator | subagent) · Doc: `tpm-reading-list.md`

---

## Workflow suite — `tools/workflow/`

The tools the `/tpm-workflow` + `/tpm-spawn*` skills compose to run a formal multi-agent round: scaffold →
compose → lint → Agent, plus config resolution, cost, audit, sign-off, and a fail-loud preflight. All wired
as `tpm workflow <verb>`.

- **`tools/workflow/tpm-workflow-config-resolver.js`** — resolve the `workflow` registry from `.claude/claude-tpm/config.json` (personas · teams · `verifier.loopFixer` · charter homes) over built-in defaults. Run: `tpm workflow config` · Doc: `tpm-workflow-config-resolver.md`
- **`tools/workflow/tpm-workflow-scaffold-subagent.js`** — scaffold an epic/phase work folder (`epic-init` / `add-phase` / `add-round`): per-role charter, spawn-prompt stub, `tpm-tmp/<role>-r<N>/`, `subagent.env`; a bare `epic-init <name>` lands under `workflow.devDir` (default `dev/<name>`). Run: `tpm workflow scaffold` · Doc: `tpm-workflow-scaffold-subagent.md`
- **`tools/workflow/tpm-workflow-compose-spawn-prompt.js`** — emit the standard spawn-prompt boilerplate (role-conditional read-order + return-shape, env ritual, base chain, `{{TASK_CONTEXT}}` sentinel, and a `<!-- tpm-session … -->` comment after the spawn marker; `--session` / `--track`). Run: `tpm workflow compose` · Doc: `tpm-workflow-compose-spawn-prompt.md`
- **`tools/workflow/tpm-workflow-lint-subagent-prompt.js`** — lint a spawn prompt / plan / charter against the subagent reading-list manifest + prompt-shape + sentinel checks; enforces the verifier HARD RULE, fails loud on a bad `--manifest`. Run: `tpm workflow lint` · Doc: `tpm-workflow-lint-subagent-prompt.md`
- **`tools/workflow/tpm-workflow-check-filename.js`** — guard: reject `.md` deliverable names matching blocked patterns (report/summary/analysis/findings). Run: `tpm workflow check-filename` · Doc: `tpm-workflow-check-filename.md`
- **`tools/workflow/tpm-workflow-audit.js`** — audit a `dev/` epic/phase tree against the canonical layout + `00-epic-plan/` charter-cleanliness; emits a markdown punch list. Run: `tpm workflow audit` · Doc: `tpm-workflow-audit.md`
- **`tools/workflow/tpm-workflow-cost-ledger.js`** — per-subagent cost rows in `00-epic-plan/`, with `--summary` / `--rollup`; a trailing `Session` column and `--session` / `--track`. Run: `tpm workflow cost` · Doc: `tpm-workflow-cost-ledger.md`
- **`tools/workflow/tpm-workflow-signoff.js`** — the user-sign-off ledger for workflow kickoffs: records the deterministic two-token sign-off that the spawn gate checks before a round is allowed to spawn subagents (spawn token at `<phase>/tpm-tmp/tpm-signoff/spawn.json`, questions token at `<project-root>/tpm-tmp/tpm-signoff/questions.json`; the `tpm-tmp` folder is a fixed literal, not `workflow.folders.tmp`); tokens also carry informational `tpmSession` / `tpmSessionVia` (`--session` / `--track` on `questions` / `spawn`; the spawn gate never reads them). Run: `tpm workflow signoff` · Doc: header
- **`tools/workflow/tpm-workflow-doctor.js`** — fail-loud PREFLIGHT: charters resolve · sign-off writable · compose emits a marker + `%TPM_HOME%` paths; self-locates the bundle, runs in a consumer. Every ✗ prints its fix. Run: `tpm workflow doctor` · Doc: header
- **`tools/workflow/tpm-workflow-router.js`** — the `workflow` sub-router (owns the verb table above; forwarded to by `tpm.js`). Internal plumbing, not a CLI. Doc: header

---

## Session suite — `tools/session/`

The JSON-first session-memory subsystem behind the `tpm-session` skill's modes: ONE canonical
`session-NNNN.json` per session (source of truth) + a derived `session-NNNN.md` (`## Handoff` /
`## Punchlist` / `## Log`, regenerated on every write), nested under `session-NNNN/`. Self-contained
(no imports outside the suite). User-facing verbs wired as `tpm session <verb>`; the `lib/` model +
`paths` module are internal.

- **`tools/session/tpm-session-config.js`** — resolve the `session` config section over built-in defaults (`--json` / `--get` / `--sessions-dir` / `--modules` — the cross-module ENABLED map for the boot MOTD). Run: `tpm session config` · Doc: `tpm-session-config.md`
- **`tools/session/tpm-session-current.js`** — the current-session resolver + open gate: finds YOUR track by Claude session id, next-`session-NNNN` allocation, idempotent `--open` (refuses, exit 3, a foreign unsealed track), track-aware `--seal`; `.current-session.json` is a non-authoritative hint kept true. Run: `tpm session current` · Doc: `tpm-session-current.md`
- **`tools/session/tpm-session-ops.js`** — the notes WRITE surface + `#1115` import: `open` / `save` / `note (--log|--decision)` / `punchlist --action add|close|reopen|drop|carry-in` / `close` (close-guard: refuses without a handoff AND a punchlist; seals only YOUR track; `close --track <other> --even-if-running` is the abandoned seal of a dead instance's track via a `.sealed` marker, exit 4 without the flag) / `unseal` (undo another instance's seal) / `import-handoff|import-log|import-punchlist`. Every write is atomic; the `.md` is regenerated from the JSON. These are TOP-LEVEL session verbs (the `ops` grouping was flattened away). Run: `tpm session <open|save|note|punchlist|close|unseal|import-handoff|import-log|import-punchlist>` · Doc: `tpm-session-ops.md`
- **`tools/session/tpm-session-export.js`** — the READ / export API: `--last N | --session NNNN[,NNNN]` · `--style json|human|both` · `--out <dir|file>` (default: JSON to stdout). Run: `tpm session export` · Doc: `tpm-session-export.md`
- **`tools/session/tpm-session-migrate.js`** — `#1114` opt-in convert ONE old 3-file markdown session → canonical JSON (`--in` / `--out-dir`). Run: `tpm session migrate` · Doc: `tpm-session-migrate.md`
- **`tools/session/tpm-session-boot-read.js`** — the boot-time pickup emit: the prior session's handoff verbatim + open punchlist headlines + the JSON/`.md` file locations; self-resolves the sessions dir via config; degrades to one clean line and exits 0 on every data problem (`--track` with no value is a usage error, exit 2). Run: `tpm session boot-read` · Doc: `tpm-session-boot-read.md`
- **`tools/session/tpm-session-doctor.js`** — `#1119` READ-ONLY health check: validate + hash-drift + detect/suggest-migrate (`--sessions-dir` / `--json` / `--strict`). Run: `tpm session doctor` · Doc: `tpm-session-doctor.md`
- **`tools/session/lib/`** — the JSON model the tools share: `session-model.js` (read → migrate → validate + render), `session-schema.js` (the envelope + `session` payload schema), `session-converter.js` (old 3-file → JSON). Internal helpers (imported, not CLIs). Doc: header
- **`tools/session/tpm-session-paths.js`** — the suite's project-root / path resolver. Internal helper (imported, not a CLI). Doc: header
- **`tools/session/tpm-session-router.js`** — the `session` sub-router (forwarded to by `tpm.js`; routes `ops` / `export` / `migrate` / `doctor` / `config` / `current` / `boot-read`). Internal plumbing, not a CLI. Doc: header

---

## Task suite — `tools/task/`

The JSON-first task-ledger subsystem behind the `tpm-task` skill: one canonical `task-<id>.json` per
task (+ derived `.md`, machine `tasks-index.json`, and three human index views). Self-contained; the
ledger CLI, its config resolver, and the export/doctor/migrate tools are user-facing, the `lib/` model
is internal.

- **`tools/task/tpm-task.js`** — the ledger CLI: `list` / `show` / `add` / `edit` / `import` (per-id JSON, `--template` / `--prune`) / `add-subtask` / `check` / `label` / `unlabel` / `labels` / `start` / `finish` / `drop` / `remove [--hard]` (`--hard` PURGES the body, config-gated on `tasks.allowHardDelete`, off by default) / `reopen`, plus `reindex` / `history`. Every event-writing verb stamps the history event with the tpm session (`session` / `sessionVia`; `--session` / `--track`; `list --session` filters; see `tpm-task.md`). Every mutating verb holds the store lock `<tasksDir>/.lock` (`tools/lib/lock.js`) for its whole read-modify-write and stamps `lastWriter` in the index; read verbs never lock; `reindex` refuses to drop an unreadable body unless `--drop-unreadable`. Run: `tpm task <subcmd>` · Doc: `tpm-task.md`
- **`tools/task/tpm-task-config.js`** — resolve the `tasks` config section over defaults (`--json` / `--get` / `--tasks-dir`; owns the `allowHardDelete` gate + the `#1109` history gate). Run: `tpm task config` · Doc: `tpm-task-config.md`
- **`tools/task/tpm-task-export.js`** — export + search on ONE selector core: ids/ranges, `--state`, `--open`/`--closed`, `--label`, `--match`, `--opened-since`/`--updated-since`/`--closed-since`, `--last N --by …`; shape `--json`/`--human` (default `--human` to stdout), `--out <dir|file>`, `--per-file`, `--thin`. Run: `tpm task export|search` · Doc: `tpm-task-export.md`
- **`tools/task/tpm-task-doctor.js`** — `#1119` READ-ONLY task-store validator + drift detector (`--tasks-dir` / `--json`); also reports lock health (HELD / STALE / INCOMPLETE / UNIGNORED / leftovers), id health, and an older / unstamped `lastWriter`. Run: `tpm task doctor` · Doc: `tpm-task-doctor.md`
- **`tools/task/tpm-task-migrate.js`** — `#1114.B` opt-in whole-store old-markdown → JSON task migrator (`--in` / `--out-dir` / `--dry-run`; `--out-dir` is a staging dir - it takes NO store lock, so `--out-dir <live store> --force` is unsupported). Run: `tpm task migrate` · Doc: `tpm-task-migrate.md`
- **`tools/task/lib/`** — the JSON model the tools share: `task-model.js` (read → migrate → validate + render + `reindex`), `task-schema.js`, `task-converter.js` + `legacy-task-format.js` (old markdown → JSON), `base.js` (shared path/root helpers). Internal helpers (imported, not CLIs). Doc: header
- **`tools/task/tpm-task-router.js`** — the `task` sub-router (forwarded to by `tpm.js`; routes `config` / `export` / `search` / `doctor` / `migrate`, else → `tpm-task.js`). Internal plumbing, not a CLI. Doc: header

---

## Consumer adoption — `tools/consumer/`

How a downstream project adopts claude-tpm as a dependency. `install`/`uninstall` are wired as flat `tpm`
aliases; the rest support the smoke suites and skill-relocatability.

- **`tools/plugin/tpm-plugin-router.js`** — the `plugin` suite router: `tpm plugin install` / `uninstall` / `doctor` route (child process, args + stdin + exit code passed through) to the consumer scripts below; `doctor` routes to `tpm-consumer-doctor.js`. The flat `tpm install` / `uninstall` / `doctor` aliases stay and are identical. No `update` verb (a local-folder plugin runs in place from the registered folder — nothing to refresh). Run: `npx tpm plugin <verb>` · Doc: header · Test: `tools/tests/tpm-router.test.js`
- **`tools/consumer/tpm-consumer-observe.js`** — the ONE shared observer behind `install`, `doctor`, `uninstall` and the SessionStart health note: `observe(dir, self, env, {probes})` → a plain-data State of five layers (dependency · registration · enablement · project marker · the installer's own folder) + env, never throws, writes nothing; `{probes:false}` is the file-only light mode (no `claude` spawn); `reobserveLayer` re-reads one layer after an action; `preconditions` are the refusals. Run: `node tools/consumer/tpm-consumer-observe.js [dir]` (dumps the State) · Doc: header
- **`tools/consumer/tpm-consumer-voice.js`** — every string a user (or Claude, via the hook) reads from the installer, doctor and hook: plan lines, menu, refusals, doctor rows and summary, the `[claude-tpm]` health line, `--help`; plus the never-print vocabulary check. Pure functions, no I/O. Doc: header
- **`tools/consumer/tpm-consumer-install.js`** — `tpm install`: graft claude-tpm onto an existing project as a **state reconciler**: observe → refuse? → diagnose → [decide] → plan → one `Proceed? [y/N]` → apply (each action verified) → observe → closing. `--plan` prints the plan and exits; `--quiet` / `--save` / `--from` / `--repoint` / `--share` / `--debug`; no `--force`, no `-y`. Calls `npm` + `claude plugin …` directly; never authors project files or `settings.json`. Run: `npx tpm install [dir]` · Doc: `tools/consumer/tpm-consumer-install.md`, `docs/INSTALL.md`
- **`tools/consumer/tpm-consumer-doctor.js`** — `tpm doctor`: `observe()` + a renderer. Prints only the ⚠/✗ rows (each with a `fix:`) and one summary, `--verbose` for every row; exit 1 iff any ✗; report-only; refuses on the claude-tpm folder itself; `install --check` is kept as an alias. Run: `npx tpm doctor [dir]` · Doc: header, `docs/INSTALL.md`
- **`tools/consumer/tpm-consumer-uninstall.js`** — reverse the install, **scope-aware** (the plugin + marketplace are machine-global singletons): asks *this project only* (disable here + drop the dep, leave the shared marketplace for others) vs *whole system* (plugin uninstall + global marketplace remove + drop the dep), with a secondary consent + a guard when the shared marketplace's source points at this project. `--project` / `--system` set the scope non-interactively. Detection comes from the shared observer (no private copies); `--check` is retired (use `tpm doctor`). Never deletes the user's files. Run: `npx tpm uninstall [dir]` · Doc: header
- **`tools/consumer/tpm-consumer-check-json.js`** — extract + assert on the strict JSON a headless `claude -p` probe returns (`--truthy` / `--eq` / `--includes`); backs the smoke suites deterministically. Doc: header
- **`tools/consumer/tpm-consumer-lint-skill-refs.js`** — keep the `tpm-*` skills relocatable: flag any bare bundle ref that must carry `%TPM_HOME%/`; accepts bare `tpm …` and flags `npx tpm …` in skill content. Doc: header
- **`tools/consumer/smoke.sh`** — LLM-in-the-loop consumer smoke: headless `claude -p` probes (`skills-present`, `methodology-resolves`, `tpm-doc-resolves`, + the deterministic `npx-tpm-resolves`) asserted via `tpm-consumer-check-json.js`. Run against an installed consumer dir. Doc: header
- **`tools/tests/smoke/multi-session-smoke.js`** — LIVE two-instance smoke for multi-session support (NOT in `npm test` / any default run; spawns real headless `claude`, a few cents, needs auth). Creates a scratch project under `<workspace>/tmp/`, runs two overlapping `claude -p` instances (scoped allow-list `Bash(node ./harness/step.js:*)`, never `--dangerously-skip-permissions`) through fixed self-logging `tpm` steps, plus a third for the two-block pickup, and asserts from the logged files + stores (refused 2nd open, parallel track, cross-track refusals, distinct task ids, per-instance attribution, doctors clean, no lock left). `--lone` = single-instance regression; `--launcher` = real `tpm-child-launch.sh --headless` child (observes the #1175 attribution). Run: `node tools/tests/smoke/multi-session-smoke.js --yes [--lone|--launcher]`

---

## Hooks — `tools/hooks/` + suite hook scripts

claude-tpm's hooks (PreToolUse, SessionStart). The plugin auto-invokes them via the bundle-root `hooks/hooks.json`, which
calls each by a **stable, path-independent** `node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks <verb>` command (not `npx tpm`, which fails where there is no `node_modules` copy); the hook scripts themselves
live in their owning suite (a workflow gate under `workflow/`, the read-path resolver under `consumer/`).

- **`tools/hooks/tpm-hooks-router.js`** — the `hooks` sub-router: exposes each hook under one stable verb table (`tpm hooks <verb>`), dispatching by child process so the harness's PreToolUse payload/stdout/exit-code pass through unchanged. Internal plumbing. Doc: header
- **`tools/workflow/hooks/tpm-workflow-gate-spawn.js`** — PreToolUse hook on `Agent|Task`: the spawn gate (blocks a marked subagent spawn that fails the sign-off check). Run: `node tools/tpm.js hooks gate-spawn` · Doc: header
- **`tools/hooks/tpm-hooks-session-start.js`** — SessionStart hook: appends `export TPM_PROJECT_ROOT=<CLAUDE_PROJECT_DIR>` and `export TPM_HOME=<realpath CLAUDE_PLUGIN_ROOT>` to `$CLAUDE_ENV_FILE` (skip-if-already-set, idempotent, fail-open), then runs the **light health check** (observer in file-only mode, no `claude` spawn): silent when healthy, one `[claude-tpm]` line for Claude (≤ 3 problems, report-only) when not; gate `hygiene.healthCheck.enabled`, default on. Run: `node tools/tpm.js hooks session-start` · Doc: header
- **`tools/hooks/tests/tpm-hooks-session-start.test.js`** — unit tests for the session-start hook (env exports + the light health check: healthy silent, ≤ 3 problems, gate off/on, fail-open). Run: `node tools/hooks/tests/tpm-hooks-session-start.test.js`

---

## Child-session — `tools/child-session/`

Orchestrator-owned Bash scripts for launching and managing a **child Claude session** (a separate `claude`
process the orchestrator drives, headless or remote-controlled). Not wired into `tpm` — run directly with
Bash. They keep the child project pristine and vendor everything the child reads into a per-session folder.

- **`tools/child-session/tpm-child-launch.sh`** — the launcher: spins up a child Claude session against a target project (`--headless "<prompt>"` / `--interactive` / `--print-cmd`), vendoring the session folder and forcing transcript persistence; sets `TPM_SESSION_ID` for the child (known limitation #1175: names a session number, not a store). Run: `bash tools/child-session/tpm-child-launch.sh <child-project-dir> …` · Doc: header
- **`tools/child-session/tpm-child-reap.sh`** — finalize an exited child session: stamp `session.json` (ended/status/exit) and archive the child transcript into the session folder so it survives a later sweep. Non-destructive. Run: `bash tools/child-session/tpm-child-reap.sh <session-dir>` · Doc: header
- **`tools/child-session/tpm-child-watch.sh`** — watch an interactive child by pid/screen name: resolve its transcript path once it registers, then report its first real user message. Run: `bash tools/child-session/tpm-child-watch.sh <pid> <screen-name> <child-cwd>` · Doc: header

---

## Misc — `tools/misc/`

Standalone utilities that aren't part of a suite. Not wired into `tpm` — run directly with `node`.

- **`tools/misc/fix-git-rename/tpm-fix-git-rename-refs.js`** — domain-agnostic reference migrator: after a batch of git renames/deletes, find + fix references to the old paths (`identify` / `fix` / `apply-plan`); provable refs auto-fixed byte-exact, ambiguous ones flagged. Never calls git; zero-dep. Doc: `tpm-fix-git-rename-refs.md` (+ `.design.md`, `.test-design.md`, and the agent-resolution `agent-ambiguous-resolution.design.md` / `.eval-design.md`)
- **`tools/misc/fix-git-rename/find-tool-rename-usages.js`** — the superseded identify-only predecessor of the above (kept for reference). Doc: header

---

## Shared base lib — `tools/lib/`

Kind-agnostic helpers the suites share (zero deps, Node built-ins only, synchronous). Internal helpers
(imported, not CLIs); each file's header docstring is the contract. The multi-session pair:

- **`tools/lib/lock.js`** — the directory lock that serialises writers to a file-backed store: `acquire` / `tryAcquire` / `withLock(lockDir, fn)` (always releases, even when `fn` throws), `inspect` / `readOwner` / `isStale` (read-only, for the doctor), `breakLock`, `LockError` + `CODES`. Acquired by renaming a fully prepared, self-ignoring `.lock/` (holding `owner.json`) into place; waits ~45 s then fails loud; a dead / reused-pid / over-30 s holder is broken with a stderr block naming it; an owner record that is missing or unreadable is never auto-broken. Used by the session store and, via `tools/task/lib/base.js`, by every mutating `tpm task` verb. Tests: `tools/session/tests/lock.test.js` (in-process, injected clock) + `lock-interleave.test.js` (real processes); task side `tools/task/tests/task-lock.test.js`, `task-lock-interleave.test.js`, `task-lock-forced.test.js`. Run: `node tools/lib/lock.js` (self-check) · Doc: header
- **Changed in the tracks-harden phase:** `tools/session/lib/session-model.js` and `tools/session/tpm-session-migrate.js` now write the derived `.md` through `atomicWriteFileSync` (a reader never catches a half-written `.md`; `tools/lib/io.js` unchanged). Docs refreshed to match the real tools: `tools/session/tpm-session-current.md`, `tpm-session-ops.md`, `README.md`, `claude-context/methodology/session-notes-format.md`, `docs/user-guide.md` section 5b, `docs/technical.md`.
- **`tools/lib/tpm-version.js`** — `tpmVersion()` → the running package's `version` (or `null`); the source of the `meta.lastWriter` B2 stamp. Run: `node tools/lib/tpm-version.js`
- **`tools/lib/io.js`** also exports `exclusiveCreateFileSync(path, data)` → `'created' | 'exists'`: write a complete temp, then `link` it into place (NOT `wx`, which can read empty ~1 s on the shared mount); falls back to `wx` with a warning on filesystems without hard links.
- **`tools/session/lib/session-tracks.js`** — the tracks store: track naming (`session-NNNN.json` = track a, `-b`…`-z`), `trackState()` (the one "is it sealed" answer), `scanSessions()`/`listFolder()` (honest: skipped + unrecognised are always listed), ownership (`ownerOf`, `classify`), claims (`claimSessionFolder` mkdir, `claimTrack` link; cap 26), `resolveWriteTrack`, and the derived hint (`deriveHint`/`writeHint`). Tests: `session-tracks`, `session-claim*`, `session-current-tracks`, `session-open-gate` (liveness evidence, adopt, parallel, next, the `foreign-open` state and its compose routing), `session-meta-additive`, `session-ops-tracks`, `session-reader-honesty`.
- **`tools/lib/attribution.js`** — the ONE session-attribution resolver: `resolveAttribution({ explicit })` → `{ session, sessionVia }` (`session-0012b`; flag > `TPM_SESSION_ID` > Claude-id lookup > blank), `toEventFields`, `parseExplicit` (the CLI flag validator), `parseSessionRef` / `normalizeStored` / `sessionMatches`, `lookupTrack`. Never throws, never prints. Tools needing the current session call this and nothing else. Tests: `tools/session/tests/attribution.test.js`, `tools/tests/tpm-attribution-lockin.test.js`, `tools/task/tests/task-attribution*.test.js`. Run: `node tools/lib/attribution.js` (self-check) · Doc: header
- **`tools/lib/sessions-dir.js`** — `resolveSessionsDirQuiet()`: the quiet twin of the session suite's sessions-dir resolver (`null` instead of throwing / warning). Doc: header
- **`tools/lib/identity.js`** — who is running: `readIdentity()` → `{ claudeSessionId, claudePid, claudePidStartedAt, hostname }` (each `null` when unavailable; never throws, never prints; reads only `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID`), plus `processStartedAt(pid)` and `isProcessAlive(pid)`. Tests: `tools/session/tests/identity.test.js`. Run: `node tools/lib/identity.js` (self-check) · Doc: header
- **`tools/tests/lib/fs-barrier.js`** (test-only, not shipped) — the interleaving seam: a `node -r` preload that parks a process at a chosen `fs` call so a race reproduces deterministically. Inert unless `BARRIER_FN` + `BARRIER_PATTERN` are set; no production file references it. Used by `lock-interleave.test.js`, `task-lock-interleave.test.js`, `task-lock-forced.test.js`. Doc: header

Also here: `io.js` (atomic write + fail-loud read), `timestamp.js` (local-offset ISO stamps), `hash.js`, `paths.js`, `validate.js`, `normalize.js`, `envelope.js`, `version.js`, `update.js` — each documented in its own header.

---

## Tests ledger

Every suite's tests are self-contained (zero-dep) and safe to run anywhere (they spawn no real
`claude`/`npm`). Test scratch output goes to `tmp/scratch/<run-slug>/`, out of the tool tree.

- **Everything at once:** `npm test` → `tools/tests/run-all.js` (the top-level aggregator; runs all suites under one scratch slug).
- **`tools/tests/tpm-router.test.js`** — the `tpm` dispatcher: suite/verb routing, unknown → exit 2, arg pass-through, exit-code propagation. Run: `node tools/tests/tpm-router.test.js`
- **`tools/tests/tpm-workflow-lint-selflocate.test.js`** — the lint tool self-locating its canonical manifest. Run: `node tools/tests/tpm-workflow-lint-selflocate.test.js`
- **`tools/workflow/tests/run-all.js`** — the workflow suite. Run: `node tools/workflow/tests/run-all.js`
- **`tools/session/tests/run-all.js`** — the session suite (65 `*.test.js` files, auto-discovered by directory glob; `ls tools/session/tests/*.test.js | wc -l`), incl. the lock / identity / lock-interleave unit tests and the tracks-store suites: session-tracks, session-claim, session-claim-interleave, session-current-tracks, session-open-gate, session-meta-additive, session-ops-tracks, session-reader-honesty, session-seal, plus the three added by the tracks-harden phase (below) the five added by the verbs-collate phase (session-ids, session-collate, session-ops-xtrack, session-lock-wrap, session-lock-forced), and the three added by the verbs-boot phase (session-boot-pin: the single-track byte pin; session-pickup-rule: the derived pickup rule; session-boot-multi: the per-track pickup), and the three added by the verbs-doctor phase (session-info-tracks: the `tracks` array of `current --state`; session-doctor-tracks: the track-aware doctor; session-export-migrate-tracks: export coverage of every track and the migrate guards), and the two added by the verbs-harden phase (session-three-track-e2e: the whole three-instance lifecycle through the pickup; session-verbs-harden: cross-track refusals, `--track` narrowing, the late-sealing pickup orderings, boot-read `--track` usage error, migrate `handoff.updatedAt`, doctor de-dup, forced `unseal` interleaving, no-id `compose`). Run each file alone on a constrained machine: `node tools/session/tests/<file>.test.js`. Aggregator: `node tools/session/tests/run-all.js`
  - **`tracks-forced-order.test.js`** (5 cases, real child processes parked at an `fs` call by the barrier seam): two opens forced to the same session number (loser refused, exit 3), two `--parallel` claims forced to the same letter (loser falls through to the next), second instance refused-not-joined, a refused instance recovering via `--parallel`, and a sealed owner refused in the load-to-write window.
  - **`tracks-lifecycle.test.js`** (12 cases, per-child `CLAUDE_CODE_SESSION_ID`/`CLAUDE_PID`): adopt (+ `--even-if-running`), parallel, the `foreign-open` state, own-track close leaves other records byte-identical, sealed owner refused on every write verb, abandoned seal needs confirmation (exit 4, `--confirm` alias), unseal, `--seal-and-new`, a legacy single-record folder, no session id with one vs two unsealed tracks, and an older-version reader on a new record (`schemaVersion` stays `1.0.0`; also reads the frozen `../old/claude-tpm-0.2.0` when present).
  - **`session-md-atomic.test.js`** (6 cases): the derived session `.md` is written by temp + rename (no plain `writeFileSync`), a forced torn-read, JSON-first ordering, the migrate `.md`, and the hint / track claim still atomic.
  - Mutation evidence for these three (24 one-line mutations, all caught) lives in the 10-tracks-harden `findings/HANDOFF.md`; the phase-local runner is `tools/run-mutations.js` in that phase folder (not shipped).
- **`tools/task/tests/run-all.js`** — the task suite (23 `*.test.js` files, auto-discovered by directory glob; incl. `show-selectors.test.js` for the #1132 `show` selector grammar and the three store-lock files: `task-lock.test.js` (28 in-process cases), `task-lock-interleave.test.js` (18 cases, child processes + the barrier seam) and `task-lock-forced.test.js` (11 forced-interleaving cases: duplicate id, lost index update, import vs add, stale-lock break, release on throw, read verbs unblocked, foreign host, reindex fail-loud, `lastWriter`, doctor flag, reader ENOENT-retry; mutation-checked). Run each file alone: `node tools/task/tests/task-lock-forced.test.js`; the aggregator is `node tools/task/tests/run-all.js`
- **`tools/consumer/tests/run-all.js`** — the observer (`tpm-consumer-observe/`) + the voice (`tpm-consumer-voice/`) + the install reconciler (`tpm-consumer-install/test.js`, stateful fake `claude`/`npm`) and its retained helpers (`test-legacy-helpers.js`) + the doctor (`tpm-consumer-doctor/`) + uninstall (`tpm-consumer-uninstall/`) + the skill-ref lint. (The `expand-hook` suites were retired in #1126 with the %TPM_HOME% resolution hooks.) Run: `node tools/consumer/tests/run-all.js`
- **`tools/misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js`** — the rename migrator (hermetic temp-dir fixtures). Run: `node tools/misc/fix-git-rename/tests/tpm-fix-git-rename-refs/test.js`
- **`tools/tests/lib/`** — shared test-support (the scratch-dir helper, `fs-barrier.js`), not a suite.

---

## See also — skills (not tools)

The `tpm-*` skills in `.claude/skills/` are what *compose* these tools into workflows; they are skills,
not tools, so they're not part of this ledger:

- **`tpm-session`** — the session lifecycle (open · close · save · info).
- **`tpm-task`** — the task ledger front door.
- **`tpm-workflow`** — the round lifecycle (plan · run · verify · reconcile · reap · status).
- **`tpm-spawn`** / **`tpm-spawn-team`** — spawn one subagent / a named team.
- **`tpm-reap`** — safe stray-subagent cleanup.
