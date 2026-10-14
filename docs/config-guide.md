# claude-tpm — Config Guide

How to configure claude-tpm for a project via `.claude/claude-tpm/config.json`. Every module is **ON by
default with sensible built-ins** - you only add config to *change* something. An absent config file, or an
absent section, means "use the defaults." The file is versioned (`"version": 1`).

Each module's config is read by a **per-suite resolver tool** - you never hand-edit anything the
orchestrator can't re-derive, and a config that points at a missing file fails loudly (friendly error +
exit 1) rather than silently at spawn time. How a tool finds the project, and how to override it, is in
[Which project a tool works on](#which-project-a-tool-works-on) at the end.

```jsonc
{
  "version": 1,
  "session":  { /* §1 */ },
  "workflow": { /* §2 */ },
  "tasks":    { /* §3 */ },
  "hygiene":  { /* §4 */ }
}
```

---

## Where the defaults live, and how layers combine

The built-in defaults for every section are shipped in one file inside the plugin bundle,
`tools/config/defaults.json` (a JSONC-style file: inline notes ride along as `_comment` keys, which are
stripped from the resolved values and never reach a tool). That file is the **bottom layer**. A project's
`.claude/claude-tpm/config.json` layers over it, and a machine-local user file layers over that:

| # | Layer | Where | Precedence |
|---|-------|-------|------------|
| 1 | **Shipped defaults** | `tools/config/defaults.json` (in the bundle) | lowest |
| 2 | **Project config** | `<project>/.claude/claude-tpm/config.json` | middle |
| 3 | **User config** | the file named by `$CLAUDE_TPM_USER_CONFIG` | highest |

A later layer wins **per value**. Plain objects deep-merge key by key; scalars, objects, and arrays
REPLACE wholesale (so a project or user array fully replaces the one below it). The one exception is
`session.proseInjections` and `session.readingList`, which STACK: the layers concatenate and duplicates are dropped.
Any layer may be absent: no project config and no `CLAUDE_TPM_USER_CONFIG` means "use the defaults." A
missing user file is skipped; a user file that is present but **not valid JSON** prints one stderr warning
and is ignored (never fatal). An invalid *project* config is still surfaced loudly by the resolver /
`npx tpm doctor .`, as before.

**Per-value flag/env still win on top of all three layers.** `--sessions-dir`, `--tasks-dir`,
`TPM_SESSIONS_DIR`, `TPM_TASKS_DIR` and friends override the overlaid config value for that one key — see
[Which project a tool works on](#which-project-a-tool-works-on). The layering described here resolves the
"config" rung; the flag/env rungs sit above it.

`$CLAUDE_TPM_USER_CONFIG` is a full config file of the same shape (a subset is fine — only the keys you
want to override). You normally set nothing; it exists for an operator who wants personal overrides that
are not checked into a project.

---

## 1. Session config

Controls the session lifecycle (`tpm-session open`/`close`/`save`/`info`) and, when the `notes`
behavior is on, where notes live and what the boot/close messages say.

```jsonc
"session": {
  "enabled": true,
  "notes": {
    "enabled": true,                                // gates ONLY the notes-writing behavior
    "sessionsDir": ".claude/claude-tpm/sessions"      // where session-NNN/ notes + the current-session pointer live.
                                                       // also where session ATTRIBUTION looks up your track; `session.enabled: false` turns that lookup off (blank).
  },
  "showTPMOpenMessage":  true,      // show TPM's built-in open MOTD = the menu of ENABLED tpm-* commands
  "showTPMCloseMessage": true,      // show TPM's built-in close sign-off (what happened + notes-saved pointer)
  "additionalOpenMessage":  "",     // path to a consumer .md/.txt shown AFTER TPM's open message ("" = none)
  "additionalCloseMessage": "",     // path to a consumer .md/.txt shown AFTER TPM's close message ("" = none)
  "proseInjections": [],            // [{ "mode": "open|save|close", "file": "<path>", "location": "before|after" }] - STACKS across layers
  "templates": { "open": "", "save": "", "close": "" },  // path to a template replacing the shipped one ("" = shipped); does NOT suppress proseInjections
  "readingList": []                 // [{ "audience": "orchestrator|subagent|all", "file": "<path>" }] - extra open-time reading pointers; STACKS across layers
}
```
- `proseInjections` and `templates` are authored with the template engine; see
  `claude-context/methodology/template-engine.md` for the directives, the three injection tiers and the precedence ladder.
- The **open** message invites work (a command menu); the **close** message is a sign-off, never a menu.
- **Two independently gateable flags, not one overloaded boolean:**
  - `session.enabled` gates the WHOLE `tpm-session` skill (rare to disable - you'd have no session
    ritual at all: no boot reading chain, no wrap-up, no notes).
  - `session.notes.enabled` gates ONLY the notes-writing behavior, independent of the outer flag:
    "bootstrap TPM's session lifecycle but keep my own notes system." `open`/`close`/`save` still run
    their non-notes steps (reading chain, boot-read pickup, reap, MOTD, sign-off) when this is `false`;
    they just skip every write to the session's record (`session-NNNN/session-NNNN.json` + its derived
    `session-NNNN.md`).
  - Both default `true`; setting neither changes nothing for an existing project. (This is the fix for
    a self-contradictory single flag whose own prose used to claim "keep the lifecycle, disable the
    notes." A boolean cannot express that; nesting `notes.enabled` can.)
- Full design: `claude-context/methodology/session-notes-format.md` (the JSON-first session-memory
  format — one canonical `session-NNNN.json` + a derived `session-NNNN.md`).

---

## 2. Workflow config

The formal multi-agent round engine. It lets a child project shape charters,
subagent models, and team shapes **without forking TPM**.

```jsonc
"workflow": {
  "enabled": true,
  "planTemplateFile": "",           // child's own plan-template (relative to project root); "" = TPM default
  "subagentEnvTemplate": "",        // child's own subagent.env template (relative to project root); "" = TPM default

  // --- folder names + epic base (#1183) ---
  "folders": {                      // the per-phase subfolder names. Shallow-merged: set only the ones you rename.
    "tmp": "tpm-tmp",               //   scratch folder (was a literal `tmp/` before #1183)
    "findings": "findings",
    "tools": "tools",
    "tests": "tests"
  },
  "devDir": "dev",                  // where a BARE epic name lands: `epic-init foo` -> `<devDir>/foo`

  // Per subagent TYPE: its default model + its charter. The 7 TPM-shipped types ship with defaults pointing at
  // their promoted charter homes (workflow-setup/charters/); listing one here OVERRIDES it. A new name APPENDS a type.
  "subagentConfigs": [
    { "name": "planning",      "defaultModel": "opus", "charterFile": "", "retryCount": 1 },  // "" = TPM default charter home
    { "name": "builder",       "defaultModel": "opus", "charterFile": "", "retryCount": 5 },  // builder/bug-fixer often need a few tries
    { "name": "test-writer",   "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "documentarian", "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "verifier",      "defaultModel": "opus", "charterFile": "", "retryCount": 1 },
    { "name": "bug-fixer",     "defaultModel": "opus", "charterFile": "", "retryCount": 5 },
    { "name": "researcher",    "defaultModel": "opus", "charterFile": "", "retryCount": 1 }
    // e.g. add: { "name": "designer", "defaultModel": "opus", "charterFile": "charters/design.md", "retryCount": 1 }
  ],

  // Named team shapes (ARRAY ORDER = RUN ORDER; delivery agents run once, then verify↔bug-fixer loops). TPM ships
  // the six below; a child may override or add. bug-fixer is in NO roster — it's the loop's fixer (verifier.loopFixer).
  "teams": [
    { "name": "full",     "subagents": [ { "name": "planning" }, { "name": "builder" }, { "name": "test-writer" }, { "name": "documentarian" }, { "name": "verifier" } ] },
    { "name": "ship",     "subagents": [ { "name": "builder" }, { "name": "verifier" } ] },
    { "name": "build",    "subagents": [ { "name": "builder" } ] },
    { "name": "test",     "subagents": [ { "name": "test-writer" }, { "name": "verifier" } ] },
    { "name": "docs",     "subagents": [ { "name": "documentarian" }, { "name": "verifier" } ] },
    { "name": "research", "subagents": [ { "name": "researcher" } ] }
  ],

  "defaultParallelism": "serial",   // serial | user-dictated | orchestrator-optimized
  "verifyLoopCap": 5,               // max build→verify kickback cycles on a FAIL (per phase)

  "deliverables": {                 // standing-output gates — all default true (generated)
    "tldr":         true,           // findings/TLDR.md — narrative for the user
    "toolFeedback": true,           // findings/tool-feedback.md — friction log
    "wiki":         true            // findings/wiki.md — long-form writeup (research charter only)
  },

  // --- added from the design-review fold-in (2026-08-28) ---
  "charterVariants": {}, // {} by default — TPM ships no alternates (a lower bar is an ad-hoc edit to the round's
                         // copied charter, not a shipped variant). A consumer adds a role's opt-down/addenda here,
                         // e.g.: "builder": { "alternates": ["charters/quick.md"], "addenda": [] }
  "verifier": {
    "requireAllPass": true,         // AND-semantics: EVERY verifier must PASS, else kickback
    "multiCountMode": "blind-pair", // blind-pair (redundant, catches flakiness) | scoped-lenses (different focuses)
    "loopFixer": "bug-fixer"        // the persona the verify↔bug-fixer loop spawns on a FAIL
  },
  "costLedger": { "epicPath": "00-epic-plan/cost-ledger.md" },  // epic-level ledger, outside the swept scratch folder
  "blockedFilenamePatterns": ["report", "summary", "analysis", "findings"]  // subagent .md names to reject (server-side block)
}
```

### Folder names and epic base (`folders`, `devDir`) — #1183

Two keys let a consumer rename the folders the workflow tools create and read, without forking TPM.

| Key | Default | Meaning |
|---|---|---|
| `workflow.folders.tmp` | `"tpm-tmp"` | Per-phase scratch folder. Was a literal `tmp/` before #1183; the new default avoids colliding with a project's own `tmp/`. |
| `workflow.folders.findings` / `.tools` / `.tests` | `"findings"` / `"tools"` / `"tests"` | The other three per-phase subfolders. |
| `workflow.devDir` | `"dev"` | The base a **bare** epic name resolves under: `tpm workflow scaffold epic-init foo` creates `dev/foo`. A path with a separator, or an absolute path, is honored as-is. This is a behavior change: a bare `foo` used to create `./foo`. |

Precedence is **config only**: project `config.json` over the built-in default, with the usual user-file layer on top. There is no CLI flag and no env var for either key. `folders` merges shallow (override `tmp` alone and the other three keep their defaults); a non-string `devDir` is ignored and the default is kept. Read them back with `tpm workflow config --get folders` and `tpm workflow config --get devDir` (keys are relative to the `workflow` section).

Who reads them: the scaffolder (`add-phase` / `add-round` create `<phase>/<tmp>/`; the epic-path positional resolves under `devDir`), the composer (the step-zero `source` / `worker-env` lines and the Constraints scratch line name `<tmp>`), the cost ledger (`<dir>/<tmp>/cost-ledger.md` and the `--rollup` scan), and the audit (default scan root is `devDir`; the scratch-in-`findings/` drift check uses `folders.tmp`).

**Exception — the sign-off store does not follow `folders.tmp`.** The gate's tokens live under the fixed literal `tpm-tmp` (`<phase>/tpm-tmp/tpm-signoff/spawn.json`, `<project-root>/tpm-tmp/tpm-signoff/questions.json`) even when `folders.tmp` is overridden. Making it follow the override is tracked as task #1188.

```jsonc
// .claude/claude-tpm/config.json
{ "workflow": { "folders": { "tmp": "scratchy" }, "devDir": "work" } }
```

Add `tpm-tmp/` (and your override name, if you set one) to the project `.gitignore`; scratch is disposable.

### Charters (via `subagentConfigs[].charterFile`)
A charter is a subagent role's **singular definition of "done."** Charters attach to subagent *types*:
- **Well-known types** — `builder` (ships the *shipping* charter), `researcher` (the *research* charter),
  `verifier` (the *verifier* charter), `planning` (the *planning* charter — formalize the ask, surface
  risks/questions → a plan proposal; don't build). Leaving `charterFile: ""` uses the TPM default for the role.
- **Override** — set `charterFile` on a well-known type to replace its default with your own file.
- **Additional** — add a new subagent type with its own `charterFile`; it **appends to the end** of the
  resolved charter list.

Each role has exactly ONE shipped charter, so there is **no pre-task charter question**. The roster simply
displays each role's charter. (A lower bar for a round is an ad-hoc edit to that round's copied
`charter-<role>.md` in the work folder; the canonical stays pristine.) Charter secrecy still holds: a worker sees
exactly one charter, and the registry is orchestrator-side knowledge.

### Subagent refs (inside a team's `subagents`)
Each entry is a **subagent ref**: `{ name, count, model }`.
- `name` — maps to a shipped type (`planning`/`builder`/`test-writer`/`documentarian`/`verifier`/`bug-fixer`/`researcher`) or a consumer-added type.
- `count` — how many of that role; **default 1**.
- `model` — override the model for this team slot; **default = that subagent type's `defaultModel`** (from
  `subagentConfigs`), falling back to the TPM default model if the type isn't consumer-configured.

### The six built-in teams
| Team | Shape (run order) | Use |
|---|---|---|
| **`full`** *(default)* | planning → builder → test-writer → documentarian → verifier | the complete separated-concerns round |
| **`ship`** | builder → verifier | builder wears all hats (build + tests + docs) → verify |
| **`build`** | builder | quick, unverified build |
| **`test`** | test-writer → verifier | add tests to already-delivered code |
| **`docs`** | documentarian → verifier | add docs to already-delivered code |
| **`research`** | researcher | a one-off subagent pulling info together (hygiene sweep, recon, fact-finding) |

Every team with a verifier gets the **verify↔bug-fixer loop** on a FAIL (the fixer is `verifier.loopFixer`, default `bug-fixer`).

*(Default is `full`, so a typical round gets up-front planning + verification. `research` is a standalone
one-off, NOT a planner-for-a-builder: a **planner structures work**, a **researcher pulls
info**. A child project may override any team or add its own named teams.)*

### Parallelism (`defaultParallelism`)
The orchestrator asks how a multi-team round runs; the default is **`serial`**.
- **`serial`** *(default)* — one team completes before the next starts.
- **`user-dictated`** — the user lays out the ordering/parallelism explicitly in the plan discussion.
- **`orchestrator-optimized`** — the orchestrator schedules for throughput within the dependency graph.

**Real-world shape:** work usually runs as **parallel "trains"**. Each train is a feature's pipeline of
teams run *serially* (team → team → team), while multiple trains run *in parallel* with each other. The
per-round default stays serial; parallelism is opt-in via the plan discussion.

---

## 3. Task config

The `tpm-task` tracking system (`/tpm-task add`/`list`/`show`/`edit`/`check`/`add-subtask`/`start`/`finish`/
`drop`/`remove`/`reopen`/`import`/`export`) - a lightweight, human-readable **and hand-editable** per-task-file
markdown ledger. Every key is optional; an absent `tasks` section (or an absent config file) means "use
the defaults," and the system is ON.

```jsonc
"tasks": {
  "enabled": true,                              // false ⇒ /tpm-task + tpm-task.js short-circuit, no store ops
  "tasksDir": ".claude/claude-tpm/tasks",        // store location; a project may repoint it (e.g. "claude-context/tasks")
  "startId": 1000,                              // first task number (monotonic, never reused)
  "bucketSize": 1000,                           // body-folder bucketing (bodies/1000-1999/, …)
  "defaultOrder": "newest",                     // fixed list sort (newest|oldest|id|state); there is no --order flag
  "defaultListState": ["open", "in-progress"],  // the pool `list` shows by default
  "timezone": "local",                          // created/ended stamps + age computation
  "exportDir": "tmp",                           // resolved but NOT read by the export tool — export defaults to stdout; pass --out
  "allowHardDelete": true,                      // false ⇒ `remove` can only stash, never hard-delete
  "maxOpenWarn": 50,                            // soft stderr nudge when the open list exceeds this
  "autoConfirm": { "finish": false, "drop": false }, // may skip the confirm dialogue for these two only
  "minimalTasks": false,                        // true ⇒ quick-capture: headline+summary, context optional
  "subtaskStyle": "letters"                     // "letters" (1245.A) at launch; "numbers" deferred
}
```
- **`tasks.enabled`** is the master off-switch. Both the skill and `tpm-task.js` bail with a clear message
  pointing at the key, and do no store ops. Missing config ⇒ defaults (system ON); malformed config ⇒
  defaults + a stderr warning (never a crash - the lenient philosophy the ledger is built on).
- **The store is plain markdown a human can open and hand-edit.** `tasksDir` holds three index files
  (`task-index.md` = open + in-progress and the `**Next ID:**` marker · `finished-tasks-index.md` ·
  `removed-tasks-index.md`) plus `bodies/<bucket>/task-<N>.md`. Bodies are canonical; the indexes are a
  regenerable cache. If one drifts (a hand edit, a crash), `tpm-task.js reindex` rebuilds them from the
  bodies. A hand edit is never treated as corruption.
- **`autoConfirm`** only tunes *which* of `finish`/`drop` skip the skill's confirm dialogue; the
  confirm-before-destructive *rule itself* is not configurable, and **`remove --hard` is never
  auto-confirmable** (and is blocked entirely when `allowHardDelete: false`).
- **`minimalTasks`** is a **skill drafting hint** (whether to require a context field on capture), not a
  tool gate. The tool is lenient and stores whatever it's handed.
- **NOT configurable** (to avoid knob-explosion): mode names/aliases, the field schema, the
  index filenames, the age ladder, and the confirm-before-destructive rule. A `storageMode: flat`
  backend was considered and rejected (the index files already give a catable flat view).
- Full reference: `tools/task/tpm-task.md` (tool + all 15 subcommands — the 13 user modes above plus the
  tool-internal `resolve`/`reindex`) and `tools/task/config.md` (this resolver).

---

## 4. Hygiene config

Drift sweeps + living-document upkeep (`tpm-hygiene`).

```jsonc
"hygiene": {
  "enabled": true,
  "healthCheck": { "enabled": true }   // the SessionStart health note (below); default on
  // cadence + check selection for the sweeps — still being finalized
}
```
*(The sweep settings land when the hygiene module is built. `healthCheck` ships today.)*

### `hygiene.healthCheck.enabled` — the session-start health note

At every session start (startup, resume, `/clear`, compact) the SessionStart hook runs a light, file-only
check of the project: it reads `package.json`, `node_modules`, the project's settings files and
`.claude/claude-tpm/`. It never runs `claude`, so it cannot see a plugin that failed to load; `npx tpm doctor .`
from a terminal can. When nothing is wrong it prints nothing and costs no context. When something is wrong it adds
one `[claude-tpm]` line to Claude's context naming up to three problems, telling Claude to report them to you,
to suggest `npx tpm install .` from a terminal, and not to edit files to fix them. The problems it looks for:

- `package.json` points at a different claude-tpm version than the running plugin (so `npx tpm` runs the old one).
- A second claude-tpm version is also turned on in the project.
- `.claude/claude-tpm/` is missing.
- `.claude/claude-tpm/config.json` is not valid JSON.

| Key | Default | Effect |
|---|---|---|
| `hygiene.healthCheck.enabled` | `true` | `false` silences the note. Only an explicit `false` turns it off; an absent key, a missing config, or an unreadable one leaves it on. |

There is no setting that makes the hook run the full doctor. A project without a `package.json` gets no note.

---

## Reading and writing config: `tpm config`

The `config` suite reads the resolved config and writes a single value into a chosen layer, so you (or a
skill) never hand-edit JSON. It calls the same overlay the resolvers use. Full reference:
`tools/config/tpm-config-router.md`.

- **`tpm config get <path> [--layer defaults|project|user]`** — print one value as JSON. Without `--layer`,
  the overlaid value across all three layers; with `--layer`, that one layer's value. `<path>` is dotted and
  may index arrays: `tpm config get workflow.subagentConfigs[1].name`.
- **`tpm config set <path> <value> [--user | --default]`** — write `<value>` (JSON-coerced) into a layer's
  raw file, creating it if absent. No flag writes the **project** `config.json`; `--user` writes
  `$CLAUDE_TPM_USER_CONFIG`; `--default` writes the shipped `tools/config/defaults.json`. `<path>` supports
  `name[i]` (set element i) and `name[+]` (append). Comment keys and sibling sections round-trip untouched.
- **`tpm config list`** — print the whole resolved config as JSON.

```
tpm config get session.notes.sessionsDir
tpm config set tasks.maxOpenWarn 100
tpm config set tasks.defaultListState[+] done --user
tpm config list
```

> **⚠ `--default` edits the install-global shipped defaults file.** It changes
> `tools/config/defaults.json` inside the bundle, so it affects **every project** that uses this claude-tpm
> install and can clobber a shipped default. To change one project, set it in that project's
> `.claude/claude-tpm/config.json` (the default layer for `set`); for a personal override, use `--user`.

---

## Turning a module OFF

Set `"enabled": false` on any module. A disabled module costs **zero context**. Its docs, skills, and
reading-list entries never load, and its vocabulary never appears in what the orchestrator reads (the
module-opacity principle; see `claude-context/methodology/overview.md`).

**Reading the enablement map.** `npx tpm session config --modules` reports every module's ON/OFF state
as JSON (`{ "session": true, "workflow": true, "tasks": true, "hygiene": true }`). This is what boot
uses to decide which modules load and which `tpm-*` commands the open MOTD lists. It reads only the
top-level `<module>.enabled` booleans (each defaulting `true`), so it stays a cross-cutting *read*, not
a resolver of any one module's full config. It is **lenient**: an absent or malformed
config resolves to "all enabled" (a warning, never a crash) so a bad config can't wedge boot.
Validating a malformed config is the doctor's job (`npx tpm doctor .`), not boot's.

---

## Which project a tool works on

Every tool needs to know which project it is serving, because the config, session notes and task ledger all
live under that project's `.claude/claude-tpm/`. A tool picks the project root in this order, first match
wins:

1. **An explicit flag or argument.** For example `--tasks-dir <dir>`, `--sessions-dir <dir>`, `--config <path>`,
   or the `[dir]` argument of `tpm install` and `tpm doctor`. An explicit value always wins.
2. **`TPM_PROJECT_ROOT`**, if it is set to a folder that exists.
3. **Walk up from the current folder** to the nearest folder that contains `.claude/claude-tpm/`.

A bad `TPM_PROJECT_ROOT` (not an existing folder) prints one warning and the tool falls through to the walk
up. If the walk up finds nothing, the tool warns and uses the current folder.

```
$ TPM_PROJECT_ROOT=/no/such/folder tpm task config --tasks-dir
tpm: warning: TPM_PROJECT_ROOT=/no/such/folder is not an existing directory; ignoring it and walking up from the current folder instead.
/path/to/this-project/.claude/claude-tpm/tasks
```

You normally set nothing. In a Claude session, a SessionStart hook that the plugin ships exports
`TPM_PROJECT_ROOT` (the project folder, from `$CLAUDE_PROJECT_DIR`) and `TPM_HOME` (the claude-tpm folder) for every
Bash call, subagents included. The hook leaves a variable alone if it is already set.

### Overriding the project root

To point a project's tools at a different folder, set `TPM_PROJECT_ROOT` in the project's
`.claude/settings.local.json`. That file is machine-local and is not checked in:

```json
{
  "env": {
    "TPM_PROJECT_ROOT": "/absolute/path/to/the/project"
  }
}
```

The hook sees the variable already set and does not overwrite it. Don't put this in the checked-in
`.claude/settings.json`: it is an absolute path, so it would be wrong on every other machine.

### `TPM_HOME` is informational

`TPM_HOME` tells you which claude-tpm folder the plugin is running from. Nothing reads it to find code. Tools
always locate their own folder, so setting `TPM_HOME` to another path does not redirect them:

```
$ TPM_HOME=/tmp tpm home
/path/to/claude-tpm-0.2.0
```

The doctor shows a warning row if `TPM_HOME` is set and names a different folder than the one it runs from.
To run a different copy of claude-tpm in a project, enable that copy's marketplace in the project (see
[INSTALL.md](INSTALL.md)) instead.
