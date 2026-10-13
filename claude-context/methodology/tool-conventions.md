# Tool conventions

How tools in this project are **structured**, the **conventions** they follow, and how workers/verifiers
**use, copy, modify, build, and give feedback on** them. One canonical doc — read Part I when authoring
or restructuring project-level tools; read Part II every time you touch a tool inside a `dev/<task>/`.

> **When this applies.** Part II: every round, every worker/verifier that reads or writes any script
> under `tools/**` or `dev/*/tools/**` (and the orchestrator when building task-folder tools). Part I:
> whenever a project-level tool is created or restructured.

> **These are conventions — a best-practices guide, not hard rules.** They're the defaults that serve
> most tools here (and in consuming projects), and you should follow them by default. But real situations
> occasionally warrant a deliberate, judgment-based exception, and that's expected — not a violation.
> *Example:* the self-contained / zero-shared-imports rule (§2, §6) is intentionally set aside for the
> shared JSON base library that the `session` and `task` suites both build on — those two backbones
> genuinely intertwine, and that shared foundation is part of what makes tpm what it is. Use judgment;
> call out a notable exception where it helps the next reader, but don't treat every convention as
> strictly enforced.

> **Related docs:** [`./project-workspace.md`](./project-workspace.md) (write-boundary table — WHERE a
> task-folder tool goes) · [`./shared-conventions.md`](./shared-conventions.md) (shared workflow
> conventions) · [`./verification.md`](./verification.md) (verification depends on the tools you build)
> · [`./orchestrator/handbook.md`](./orchestrator/handbook.md) (orchestrator-only promotion criteria) ·
> [`../../tools/README.md`](../../tools/README.md) (canonical index of every project-level tool — check
> before writing anything).

---

# Part I — Tool structure (authoring project-level tools)

## 1. Portable per-suite folders

Project-level tools live in **portable per-suite folders**:

```
tools/
  README.md                      # THE canonical ledger: every tool + a tests ledger, one bullet each (SSOT — §4)
  <suite>/                       # e.g. task, spawn, session, workflow — a self-contained suite
    <tool>                       # the executable (a Node script, or .sh)
    <tool>.md                    # its reference doc  (tool + its .md at the suite ROOT)
    lib/                         # the suite's OWN library code (or flat helpers beside the tool)
    tests/
      <tool>/                    # human-readable test script(s) for that tool
      lib/                       # shared test helpers WITHIN this suite
```

There is **one** ledger (`tools/README.md`). A suite may also keep a long-form `README.md` of its own
(architecture, data format, per-verb walk-through) that the ledger does not duplicate: `tools/session/` and
`tools/task/` do, and the ledger says so. A suite README is a companion to the ledger, never a second index.

At the suite root: only the tool executables + their `.md`s + `README.md` + `lib/` + `tests/`. Anything
a tool needs beyond a single file goes in `lib/`. `<tool>.md` sits beside the tool executable. A suite name may
be skill-branded (`task`, `spawn`) or functional (`workflow` for scaffold/lint/cost) — either way it's a
portable folder.

## 2. Portability — the load-bearing rule

**Copy a whole `tools/<suite>/` folder (with its `lib/` and `tests/`) elsewhere and it must just work** —
NO dependency on any shared project-level lib, no `require('../../shared/…')`, no cross-suite imports. A
suite is self-contained.

- **Tradeoff, accepted deliberately:** if two suites need the same helper, **each carries its own copy**
  in its `lib/`. Copy-portability wins over DRY-shared-lib.
- **Zero runtime dependencies:** tools use only Node built-ins (or POSIX for `.sh`). No third-party npm
  deps. A tool stays runnable with nothing but Node — a bare `node` invocation of the tool script, no install step.

## 3. Running tools — `npm run` and/or a `tpm`-style bin

Root **`package.json`** is a convenience wrapper (a script registry + `bin`), NOT a dependency manifest. A
project wires its tools to be run in one or both of two ways:

- **npm scripts** — one `scripts` entry per tool, run as `npm run <name>` (args after `--`, e.g.
  `npm run task -- list`):
  ```jsonc
  { "scripts": { "task": "node tools/task/<tool>" } }
  ```
- **A `bin` dispatcher** — a single git-style front-door command declared as the package `bin`, run as
  `<bin> <suite> <verb>` (humans in a shell write `npx <bin> …`; see "Who calls what" below). claude-tpm ships a `"bin"` entry mapping `tpm` to the top-level dispatcher, so its tools run as
  `tpm session export`, `tpm task list`, etc. (claude-tpm exposes only this bin — no per-tool
  `npm run` scripts beyond `npm test`; another project may prefer npm scripts, or both.)

**Who calls what — bare `tpm` for Claude; the `npx` form is for humans and is always marked.** Claude Code puts the plugin's `bin/` on PATH for
every Bash tool call (main session and subagents) while the plugin is enabled, so **skills and every Claude-facing
doc call bare `tpm <suite> <verb>`** — it works in any consumer project, with or without a `node_modules` copy of
claude-tpm. **Never instruct Claude to run `npx tpm …`**: with no local `node_modules/.bin/tpm`, npx downloads and
runs an unrelated registry package named `tpm`. The `npx` form is for a *human* at a terminal inside a project that
vendors the package; it lives only in human-facing places (READMEs, `docs/*`, `tools/consumer/**` and `tools/plugin/**`
docs, `tools/tpm.md`, and the `--help` of the install / uninstall / doctor / plugin commands) — never in a skill or a
methodology doc. `tools/consumer/tpm-consumer-lint-skill-refs.js` enforces this on skill content.

**Writing a human-form note.** A tool doc, or text a tool prints, that must show the human `npx` form carries the literal
marker `Human terminal:` on the SAME line as the `npx` command. It reads as an ordinary label in rendered markdown:

> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

At most one such note per per-suite tool doc. `tools/tests/tpm-npx-regression-guard.test.js` enforces the marker: any
other Claude-facing line that tells a reader to run the `npx` form fails the guard.

Either style is fine, and a tool wired **neither** way (an internal helper, a hook script the harness
invokes, a one-off utility) simply has **no** run command. Every tool also stays runnable by a bare
a bare `node` invocation of the tool script regardless (§2). The `tools/README.md` ledger records a tool's run command
**only when it's actually wired** (§4).

## 4. Docs — the canonical ledger + per-tool references

- **`tools/README.md` — the one canonical ledger (SSOT).** A suite may keep a long-form README
  (`tools/session/`, `tools/task/` do), but this single file is the exhaustive index. Its contract:
  - **Exhaustive + honest** — every tool that exists is listed; nothing that no longer exists is.
  - **Categorized by suite**, each category opening with a one-line description of what the suite is for.
  - **One bullet per tool** = the `` `path` `` + one sentence on what it does; a **Run:** command **only if
    the tool is wired** (`npm run …` / `<bin> …` per §3) — otherwise no run line; and a **Doc:** pointer
    to its `<tool>.md` or "header". Internal helpers and routers are listed but **tagged** (e.g. "internal
    helper — imported, not a CLI") so the ledger is complete without implying they're runnable.
  - **A tests ledger** below the tools ledger — how to run everything (`npm test`) and each suite's runner.
  - **Kept in sync in the same change** that adds, removes, or renames a tool.
- **`<tool>.md`** — the tool's own reference (flags, subcommands, examples), beside the tool executable.
- Test files carry a header docstring (purpose / guards / how-to-run).

## 5. CLI conventions (uniform across project-level tools)

- **Standard flag vocabulary:** `--in`, `--out`, `--force`, `--help`.
- **No silent defaults for REQUIRED inputs** — a required flag with no value fails loudly with usage
  (e.g. `tpm workflow audit --out`). No guessing a path/target. (Full rationale in Part II §"No hardcoded paths.")
- **Every tool supports `--help`** and carries a header docstring (purpose, usage, flags, what it guards).
- **Run-wired where applicable** — via `npm run` and/or the project's `bin` per §3; not every
  tool is wired, and unwired tools carry no run command in the ledger.
- **Genericity:** tools stay project-agnostic; project-specific data comes via flags/env, never
  hardcoded.

## 6. Migration status + a rejected pattern

**Migration (largely done):** the workflow tools (`scaffold-subagent`, `audit`, `lint-*`, `cost-ledger`,
…) were moved from the old `tools/workflow/` category layout + `tools/test/workflow/` into this per-suite
shape, with `package.json` + the `tpm` bin dispatcher wiring them (`tpm <suite> <verb>`).

**⚠️ Deliberate DIVERGENCE from ggaitk — no shared tool lib.** ggaitk used a shared `tools/lib/`
(a shared `GGAITKPaths` module, `#paths` subpath imports) every tool `require()`d. **We reject that** for the §2
portability rule: each suite carries its own `lib/`, duplication accepted. Do NOT port a shared
`#paths`/subpath-imports module. Any paths/root-finding helper a suite needs lives in that suite's `lib/`
(copied, not shared).

## 7. Shared stores: lock the whole read-modify-write

**Rule.** A tool that READS a shared store, MODIFIES what it read, and WRITES it back (allocate the next
id, update an index row, rebuild an index from bodies) takes the `tools/lib/lock.js` directory lock for the
**whole span**, from the first read the write depends on to the last write. Several Claude sessions run the
same tool against one store at once; without the lock, two of them are handed the same id or one overwrites
the other's index update, and nothing reports it.

- **Atomic rename is not enough.** Writing to a temp file and renaming over the target (`io.atomicWriteFileSync`)
  prevents a TORN file; it does not prevent a LOST UPDATE (both writers read the old value, each renames
  its own result over the other's). Keep atomic writes for the files (readers never see half a file) AND take
  the lock for the span.
- **The helper and its API** (the shared base lib, reached through the suite's `lib/base.js` namespace,
  e.g. `base.lock.withLock`, never copied): `withLock(lockDir, fn, opts?)` acquires, runs `fn(handle)`
  SYNCHRONOUSLY, and always releases, even if `fn` throws (the original error is rethrown unchanged).
  `lockDir` is the final lock path, conventionally `<store>/.lock`. Also `acquire`, `tryAcquire`,
  `inspect` / `readOwner` / `isStale` (read-only, for a doctor), `breakLock`, `LockError` with `err.code`
  (`ELOCK_TIMEOUT`, `ELOCK_LOST`, ...; branch on the code, never the message). Options include `verb`,
  `version`, `label` (stderr prefix), `waitMs` (default 45000) and `staleMs` (default 30000); env
  `TPM_LOCK_WAIT_MS` / `TPM_LOCK_STALE_MS` override when the option is absent. Full contract: the header
  of `tools/lib/lock.js`.
- **Shape it must have.** Take the lock INSIDE each mutating operation (so direct `require()`-ers are covered
  too), after any cheap refusal check, and read stdin / `--file` inputs BEFORE taking it. The lock is not
  re-entrant: a locking operation must not call another locking operation. Read-only verbs take no lock
  (they rely on atomic writes and may retry a transient `ENOENT`). The lock directory ignores itself
  (`.gitignore` of `*`), so it is never committed.
- **Test it by forcing the interleaving, not by racing real processes.** A race test that merely launches
  N processes passes by luck. Park one process inside its critical section with the test-only seam
  `tools/tests/lib/fs-barrier.js` (a `node -r` preload armed by `BARRIER_FN` + `BARRIER_PATTERN`, with
  `BARRIER_READY` / `BARRIER_WAIT` files), run the competitor, assert it is still waiting and has written
  nothing, release, and assert both effects landed. Then MUTATION-CHECK the test: disable the protection in
  a scratch COPY of the tool and see the test go red. Run such files one at a time; keep at most 2-3 child
  processes alive. Worked examples: `tools/task/tests/task-lock-forced.test.js`,
  `task-lock-interleave.test.js`, `tools/session/tests/lock-interleave.test.js`.
- **What the lock does not cover.** Tools that write a user-chosen output path, or a staging directory, are
  last-writer-wins unless they take the lock themselves (`tpm task migrate --out-dir <live store> --force`
  bypasses it and is unsupported).

## 8. Session attribution: use the shared resolver

**Rule.** A tool that wants to know, or record, which tpm session it is running in (to stamp a history event, a ledger row,
a token, a generated file) calls the shared resolver, `tools/lib/attribution.js`. It does NOT read `TPM_SESSION_ID`,
`CLAUDE_CODE_SESSION_ID` or `CLAUDE_PID` itself, and it does NOT read the sessions directory or open a track file itself.
Two copies of the rule drift, and a tool that guesses differently stamps a different session than its neighbours.

- **The call.** `resolveAttribution({ explicit })` returns `{ session, sessionVia }`, where `session` is the stored form
  (`session-0012b`; track a is `session-0012`) and `sessionVia` is `'flag' | 'env' | 'lookup'`; blank is
  `{ session: null, sessionVia: null }`. Order: explicit flag, then `TPM_SESSION_ID`, then a lookup of the Claude session id
  against the session tracks, then blank. Wrap the result in `toEventFields(...)` to get `{}` when blank or
  `{ session, sessionVia }` to spread into a record, so the two keys are written together or not at all. It never throws and
  never prints.
- **Flags.** Offer `--session <ref> [--track <letter>]` and validate them with `parseExplicit({ session, track })` BEFORE any
  write: a malformed or disagreeing flag is a usage error (exit 2, nothing written). Only the explicit flag may fail the
  command; everything the resolver finds by itself must fall through to blank, because attribution is informational and
  never blocks a write.
- **Comparing.** Normalise both sides with `normalizeStored` / `sessionMatches`; never compare raw strings or slice a prefix.
  The stored form (`session-0012b`) deliberately differs from the session suite's bare `fromSession` label (`0012b`).
- **The sessions directory.** If you need it, use `tools/lib/sessions-dir.js` (`resolveSessionsDirQuiet`), the quiet twin of the
  session suite's loud resolver. Do not import from `tools/session/` to find a session from the task or workflow suites.
- **Reach it** through the suite's `lib/base.js` namespace where one exists (`base.attribution` in the task suite), else
  `require('../lib/attribution')`; do not copy it.
- **Tests.** Give a test child an EXPLICIT environment (PATH, a scratch `HOME`, fake `CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID`,
  a scratch `TPM_SESSIONS_DIR`) so the invoking session never leaks in. Reference: `tools/tests/tpm-attribution-lockin.test.js`.

Reference for users of the data: `tools/task/tpm-task.md` ("Session attribution").

---

# Part II — Using & building tools inside a task (worker/verifier-facing)

## Core rule — read this first

**You do NOT edit any tool under the project-root `tools/` folder.** Those are canonical / shared /
cross-task; editing them in-place forks the tool silently and breaks every other task that uses it.

**You ARE encouraged to USE them as much as possible.** Read-first list:
1. **[`../../tools/README.md`](../../tools/README.md)** — the index. Grep it for your domain; every tool
   has a description, CLI flags, and its npm alias.
2. **Sibling `dev/*/tools/`** — someone may have built a task-folder tool close to what you need
   (read-only reference; you may copy into YOUR task tools folder, attributing in your docstring).
3. **Your own task's existing tools** — a resumption may already have tools in `dev/<your-task>/tools/`.

If a root-level tool does exactly what you need — call it. If ~80% — use copy-then-modify below.

## The copy-then-modify pattern

When you need a modified version of a project-level tool:
1. **Copy the file into your task's `tools/` subfolder** (`dev/<your-task>/tools/<name>`); create the
   folder on demand per [`./project-workspace.md`](./project-workspace.md).
2. **Modify the copy.** Run the copy. The canonical version stays byte-exact for everyone else.
3. **Aim for generalizations, not special cases.** A change that satisfies both the original use case AND
   yours (via a new flag/option) can be promoted back later; one that only works for you (and breaks the
   original) is a fork that rots.
4. **Document it in `findings/tool-updates.md`** (format below), one entry per modified tool.
5. **The `findings/README.md` index** gets a one-line hook pointing at `tool-updates.md`.

At task close the orchestrator reviews `tool-updates.md` for promotion candidates (generalized
modifications get pulled back to the project-level tool; special-cased ones stay).

### `findings/tool-updates.md` format

Append-only, one entry per forked tool:
```markdown
## tools/<suite>/<tool> → dev/<task>/tools/<tool>
**Why:** <what forced the fork>
**Original use cases preserved:** <YES — all flags unchanged / NO — hardcoded to this task>
**New use case added:** <the flag/codepath you added>
**Promotion candidate:** <YES — general-purpose, opt-in, no task-specific assumptions / NO — task-specific>
```
The "Promotion candidate" line is the key audit signal.

## Ship your deliverables AS re-runnable tools

Any generated artifact (transformed data, extracted asset, decoded dump, diff, JSON export) **MUST have
a script in your task's `tools/` folder that regenerates it from documented inputs** — no manual steps.
Generators, verifiers, extractors, analyzers all ship as scripts (the verifier reads the on-disk
artifact, checks criteria, exits 0/nonzero with a clear PASS/FAIL). **The tool IS the reproducibility
contract** — an artifact without its regeneration script is a black box. Bar is low: a 30-line Node
script with a header docstring, flag parsing, and an example invocation. Anything you'd paste into a Bash
heredoc more than twice → script.

## No hardcoded paths or defaults

> No tool anywhere (project-level `tools/**` OR task-level `dev/**/tools/**`) has a default input path or
> any project-structure-hardcoded default baked into CLI parsing. All path inputs are explicit flags with
> no default.

**Rationale:** portability for distribution outside this repo's layout, plus the "which input produced
which artifact?" audit trail. Concretely: `--in`/`--out`/`--config` REQUIRED, no defaults, fail with a
clear error if omitted; output paths for generated artifacts taken as a flag (`--out-dir`); data files
that ship WITH the tool (`require('./data/table.json')`) are fine (module-local, not project-structure).
When a data source must live somewhere, name it in the docstring + task README — don't bake the path in.

## How tools find the consumer project (and their own bundle)

**The project** (the consumer repo whose `.claude/claude-tpm/` a tool reads and writes) is resolved by
`findRoot` with this precedence (design D8):

1. an **explicit argument** — a flag (`--source`, `--project-root`, `--tasks-dir`, …) or a `startDir` the
   caller deliberately passes;
2. **`$TPM_PROJECT_ROOT`** — exported by the SessionStart hook into every Bash call of a session and its
   subagents, so it never drifts when Claude `cd`s;
3. a **walk up from the current folder** for the nearest ancestor containing `.claude/claude-tpm/`.

Rules that follow from it:
- **Never pass `process.cwd()` as if it were an explicit argument** — omit `startDir` so the env can win.
- A `TPM_PROJECT_ROOT` that is not an existing directory is **not fatal**: one stderr warning naming the var
  and value, then the walk-up runs.
- A walk-up **miss is loud**: `findRoot` still returns the start folder (back-compat) but writes one stderr
  warning saying no `.claude/claude-tpm/` was found and which folder is being used. A caller that must not
  guess passes `{ strict: true }` (throws `ETPM_NO_PROJECT_ROOT`); `{ quiet: true }` silences the warning.
- The env applies only to the default `.claude/claude-tpm` marker; a custom `marker` means "find that
  thing", which a project-root variable cannot answer.
- Test runners strip `TPM_PROJECT_ROOT` and `TPM_HOME` from the env they hand to child suites (so a run from
  inside a live session can't touch the real project); a test that needs either sets it explicitly.

**The bundle** (claude-tpm itself: its docs and tools) is found by **self-location** — `tpm home` /
`tpm doc` derive it from their own file path. **`$TPM_HOME` in the environment is informational only**: the
hook exports it as a pointer for Claude and scripts, but no tool reads it to resolve anything (an env
override would let one version's code read another version's docs). Guarded by
`tools/tests/tpm-home-env-guard.test.js`.

## Resolving project-internal paths — never hardcode absolutes (suite-local helper)

The no-defaults rule above is about **user inputs**. This is the flip side: when a tool must resolve a
**project-internal location** (the repo root, the tools dir, the work dir), **never hardcode an absolute
path** (`/Volumes/…`, `/Users/<user>/…`) and never do `__dirname`-relative `../../../` gymnastics — both
rot the moment the tool moves or the same tree is viewed from a different filesystem mount.

**The principle survives; the mechanism is per-suite (not a shared module).** Per Part I §2 there is NO
shared project paths module. Instead, a suite that needs root resolution keeps a **small `lib/paths`
helper of its own** — typically a `findRoot({ startDir, marker })` that walks upward for a repo marker — and the
tool resolves through that. Copied across suites, per the portability rule.

```js
// PREFERRED — resolve the root via the SUITE'S OWN helper, then path.join the tail
const { findRoot } = require('./lib/paths');   // suite-local, NOT a shared '#paths'
const path = require('path');
const OUT = path.join(findRoot({ startDir: __dirname, marker: 'package.json' }), 'dev/<task>/findings/out.json');
```
```js
// ❌ absolute path — rots on any move / other filesystem view
const DATA = '/Volumes/share/project/data';
// ❌ dirname gymnastics — breaks when the tool moves
const data = path.resolve(__dirname, '../../../../data');
```

**One-shots use the idiom too — no exemption.** A one-shot's forensic value lives in its FROZEN INPUT
DATASET (the exact file/offset/bytes the finding claims about) — keep those coordinates hardcoded, they
ARE the evidence. Only the ROOT resolution goes through the suite helper, so a layout migration doesn't
silently break a re-run. (A past migration created path drift across hundreds of files and cost a full
session to fix — every hit avoidable had the root resolved through a helper.)

Task-folder tools (`dev/<task>/tools/`) follow the same rule: resolve the root via a small copied helper,
not a hardcoded absolute. If you need a resolution helper that doesn't exist, don't invent a shared one —
copy a minimal `findRoot` into your task tools and log the gap to `findings/tool-feedback.md`.

## Building reusable tools by default

For anything that touches a binary blob, scans/extracts/transforms data, or could need re-running to
verify — write a small Node script, not an inline Bash one-liner. Plain `grep`/`Read`/`ls` inline is
fine. Every script in a task's `tools/` folder has: a top-of-file docstring (purpose, inputs, outputs,
example invocation), CLI flag parsing (no hardcoded paths), and a working example in the docstring.
Project-level tools follow the stricter Part I conventions; task-folder tools aim for the same shape but
may deviate when the task calls for it (the no-defaults rule is not optional). What a task-folder tool
must DELIVER once it is meant to ship is the next section.

## Ship-intended tools owe tests + a `<tool>.md`; scratch tools don't

Draw the line by **intent**, not size or cleverness:

- A **ship-intended tool** — one you expect to promote to a project-level `tools/<suite>/`, OR a durable
  deliverable a later round is meant to re-run — owes, **delivered alongside the executable**:
  1. **tests** (under `tests/<tool>/`, per Part I §1) that exercise its real behaviour and exit non-zero
     on failure, and
  2. a **`<tool>.md`** reference doc beside the executable (flags, subcommands, one worked example).

  These are not optional polish — they are **hard Definition-of-Done rows**. A ship-intended tool with no
  tests or no `<tool>.md` is **unfinished**, exactly like a tool that doesn't run; the round's DoD must
  carry a row for each and the verifier FAILS the round if either is missing. The plan's Deliverables must
  name both files, and the DoD must close them.

- A **scratch / probe / one-shot debugging tool** — written to answer one question this round and not
  meant to outlive it — owes **neither** a test suite nor a `.md`. It still carries its **header docstring**
  (purpose / inputs / example) and obeys **no-hardcoded-paths** — that baseline never lapses. If a scratch
  tool proves worth keeping, it **graduates to ship-intended** and then owes the tests + doc before it can
  be promoted.

**When unsure which a tool is, treat it as ship-intended.** An extra test file and a short `.md` are cheap;
a promoted tool with no tests is a latent breakage for every future task that inherits it.

## Log your tool feedback

Any friction with a project-level tool (awkward CLI, a hardcoded path that forced a fork, a missing
export, a bug, a wished-for helper, a spotted duplicate) → log it in `findings/tool-feedback.md` (skip
entirely if zero friction). Append-only:
```markdown
## 2026-MM-DD — Tool: `tools/<suite>/foo`
**Category:** complaint | wish | bug | workaround | dupe-spotted | generalized-tool-idea
**Observation:** what you hit, what you wanted, what you did.
**Cross-ref:** finding doc / HANDOFF section / code file with the detail.
```
Bias toward logging — friction observations aggregate into tool-refactor rounds.

### `tool-updates.md` vs `tool-feedback.md`

| File | When | What |
|------|------|------|
| `findings/tool-updates.md` | Whenever you fork a project-level tool (copy-then-modify) | Required. One entry per fork, promotion candidate YES/NO. |
| `findings/tool-feedback.md` | Whenever you hit friction with a tool | Optional (skip if none). One short entry per observation. |

If you fork AND have feedback about the original, log both and cross-reference.

---

## Cross-references

- [`../../tools/README.md`](../../tools/README.md) — canonical index of every project-level tool. Read-first.
- [`./project-workspace.md`](./project-workspace.md) — write boundaries + canonical `dev/<task>/` layout.
- [`./shared-conventions.md`](./shared-conventions.md) — shared workflow conventions.
- [`./verification.md`](./verification.md) — verification deliverables depend on the tools you build here.
- [`./orchestrator/handbook.md`](./orchestrator/handbook.md) — orchestrator-only promotion criteria.
- [`./workflow-setup/plan-template.md`](./workflow-setup/plan-template.md) — standing deliverables (repro
  from documented inputs, build missing tools, log tool feedback) that Part II consolidates.
