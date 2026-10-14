# `tpm-workflow-scaffold-subagent.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The epic-aware scaffolder for the claude-tpm workflow module. It owns the
**mechanics** of the numbered-phase folder layout — auto-numbering phases,
auto-numbering kickback rounds, and dropping the per-role / per-round /
per-subagent skeleton — so the orchestrator stops hand-scaffolding folders,
hand-numbering them, and hand-tracking round lineage. The orchestrator decides
*what* a phase is; this tool owns the numbering and the skeleton.

- **Location:** `tools/<suite>/tpm-workflow-scaffold-subagent.js` (canonical copy documented here:
  `dev/workflow-module-build/24-tighten-scaffold-config/tools/scaffold-subagent.js` — the
  fable-review tightening version, superseding the phase-12 copy).
- **Runtime:** Node built-ins only, zero runtime deps. Run portably with
  `tpm workflow scaffold …` (verified on Node v24.16.0).
- **In-suite dependencies** (must sit beside it): `config-resolver.js` (resolves the
  team roster + each role's `charterFile`, plus `planTemplateFile` / `subagentEnvTemplate`)
  and `check-filename.js` (guards every emitted filename against the blocked patterns
  `report` / `summary` / `analysis` / `findings`).
- **Also a module:** `require('./scaffold-subagent.js')` exposes the pure helpers
  (`epicInit`, `addPhase`, `addRound`, `resolveTeamRoster`, `resolveRoleCharter`,
  `nextPhaseNumber`, `nextRoundNumber`, `tmpFolderNames`, `pad2`, `planStub`,
  `epicPlanStub`, `dropCharter`, `subagentEnvStub`, `resolveEnvTemplate`,
  `dropSubagentEnv`, `expandPlanTemplate`, `resolvePlanContent`) so the test drives them directly.

> Every command, flag, message, and exit code below was executed against a
> throwaway epic and observed to behave as written.

> **Tightening round (2026-08-29) — four fixes from the fable review.** (#3) every
> `add-phase` now drops a comment-only `tpm-tmp/subagent.env` stub (or a consumer override
> template) so the step-zero `source` ritual always succeeds; (#5) a new `--charter <path>`
> lands a chosen charter (e.g. the mvp opt-down) via the tool; (#6) the ORCHESTRATOR-NOTE
> strip is now **case-insensitive**; (#9) `plan.md` is seeded from a configured
> `planTemplateFile` when one resolves. Each is documented in its section below.

---

## The layout it produces

Append-only. `NN` is a **stable creation-order id, not an execution order** — a
gap in the numbers is never back-filled.

```
dev/<epic-slug>/
├── 00-epic-plan/                    ← the ONE mutable cross-phase home
│   ├── epic-plan.md                 ← goal · phase map · deliverable
│   ├── punchlist.md                 ← running done / pending / cut
│   └── decisions.md                 ← decisions + raise-to-user queue
├── 01-<slug>/                       ← a phase = self-contained work folder
│   ├── plan.md                      ← ONE plan (planTemplateFile if set, else sentinel stub)
│   ├── charter-<role>.md            ← ONE charter per team role (copied from config, note stripped)
│   ├── spawn-prompt-<role>-r1.md    ← per-role, per-round spawn-prompt stub
│   ├── findings/                    ← HANDOFF.md, durable outputs
│   ├── tools/                       ← phase-local scripts
│   ├── tests/                       ← phase-local tests
│   └── tpm-tmp/                     ← scratch (per-subagent subfolders; name = workflow.folders.tmp)
│       ├── subagent.env            ← comment-only stub (or consumer override) — step-zero sources it
│       ├── builder-r1/              ← per-subagent scratch (no clobber)
│       └── verifier-r1-v1/          ← verifier M-of-count gets a -v<M> suffix
└── ...                              ← next add-phase → 02-…, append-only
```

**The subfolder names are configurable (#1183).** `findings/`, `tools/`, `tests/` and the scratch folder come from `workflow.folders` (defaults `findings`, `tools`, `tests`, and `tmp: "tpm-tmp"`); the epic base comes from `workflow.devDir` (default `"dev"`). The diagram shows the defaults. With `{"workflow":{"folders":{"tmp":"scratchy"}}}` in the project config, `add-phase` creates `<phase>/scratchy/` (and `scratchy/subagent.env`, `scratchy/<role>-r1/`) instead. See `docs/config-guide.md` §2. The scratch folder was `tmp/` before #1183; there is no legacy fallback, so an existing phase folder that still has `tmp/` keeps it, and new scaffolding writes `tpm-tmp/`.

---

## Subcommands

### `epic-init <epic-path>`

Create `<epic-path>/00-epic-plan/` with `epic-plan.md`, `punchlist.md`, and
`decisions.md` stubs. Refuses to clobber an existing stub file unless `--force`
(see [Overwrite protection](#overwrite-protection)).

**Where `<epic-path>` lands (#1183 — behavior change).** A **bare name** (no path separator, not absolute) is resolved under `workflow.devDir` (default `"dev"`): `epic-init foo` creates `dev/foo`. A path **with a separator or an absolute path** is honored as-is and never double-prefixed: `epic-init sub/bar` creates `sub/bar`, `epic-init /abs/baz` creates `/abs/baz`. **This changes what a bare name did:** before #1183, `epic-init foo` created `./foo`; now it creates `dev/foo`. To get the old placement, pass an explicit path (`epic-init ./foo`). The same bare-name rule applies to the `<epic-path>` of `add-phase` and `add-phases`; `add-round` takes a phase path and is unchanged. Callers that already pass `dev/<epic>` are unaffected. `devDir` is config-only (set `workflow.devDir` in `.claude/claude-tpm/config.json`, or pass `--config <path>`); there is no flag or env override. See `docs/config-guide.md` §2.

```
$ tpm workflow scaffold epic-init foo            # default devDir
  mkdir:   dev/foo
$ tpm workflow scaffold epic-init sub/bar        # separator → as-is
  mkdir:   sub/bar
```

```
$ tpm workflow scaffold epic-init dev/my-epic
  mkdir:   dev/my-epic
  mkdir:   dev/my-epic/00-epic-plan
  created: dev/my-epic/00-epic-plan/epic-plan.md
  created: dev/my-epic/00-epic-plan/punchlist.md
  created: dev/my-epic/00-epic-plan/decisions.md

epic-init complete: /abs/path/dev/my-epic
Next: add-phase <epic-path> --slug <slug> --team <team>
```

### `add-phase <epic-path> --slug <slug> --team <team> --pretask-ack <receipt> [--config <path>] [--charter <path> [--role <role>]]`

> **🛑 Pre-task ack gate (required).** `add-phase` **refuses to run** without
> `--pretask-ack <receipt>` — a markdown file (by convention
> `00-epic-plan/pretask-<NN>.md`) carrying an **`**Accepted:** <phrase>`** line that
> records the user's answer to the pre-task roster (`all defaults` or explicit deltas).
> A missing file, or a missing / empty / placeholder (`{{…}}`, `no`, `pending`, …)
> acceptance line → **exit 1**. This makes the "present the roster and get the user's OK
> **before** scaffolding" step (`tpm-workflow` `modes-plan §2`) mechanical instead of
> honor-system prose, which got silently skipped twice (session-007). There is **no
> bypass flag** (`--force` overwrites files; it does not skip the questions).
> `epic-init` and `add-round` are **not** gated — `epic-init` only makes the folder the
> receipt lives in, and `add-round` is the verify↔bug-fixer loop *inside* an
> already-approved phase.

Auto-compute the next phase number (**max existing `NN` + 1**, zero-padded to 2
digits — mechanically enforcing append-only), then create `NN-<slug>/` with the
full phase skeleton:

- `plan.md` — seeded from the config's `planTemplateFile` if one resolves (fix #9;
  see [plan.md & subagent.env seeding](#planmd--subagentenv-seeding)), else a
  sentinel stub (structure only; no charter, no posture).
- `findings/`, `tools/`, `tests/`, `tpm-tmp/`, and a comment-only `tpm-tmp/subagent.env`
  stub (or the consumer override template — fix #3).
- **For each role in the team's roster:** `charter-<role>.md` (see
  [Charter resolution](#charter-resolution)), `spawn-prompt-<role>-r1.md`, and a
  per-subagent `tpm-tmp/<role>-r1[-v<M>]/` scratch folder.
- **`--charter <path>` (fix #5)** re-charters ONE role from the given file, routed
  through the same strip + blocked-name guards as a config charter. It targets the
  `--role` named role, or the sole role of a single-role team; a multi-role team
  without `--role` is a loud error. This is how the orchestrator lands the mvp
  opt-down via the tool instead of hand-copying (which bypassed the strip). Pair
  with `--force` to replace an existing `charter-<role>.md`.

The roster (which roles, how many of each, each role's charter path) is resolved
by `config-resolver.js`. **Known teams and their rosters** (from the built-in
defaults; the exact set is printed on an unknown-team error):

| Team | Roles dropped |
|------|---------------|
| `full` | planning · builder · test-writer · documentarian · verifier |
| `ship` | builder · verifier |
| `test` | test-writer · verifier |
| `docs` | documentarian · verifier |
| `research` | researcher |
| `build` | builder |

```
$ tpm workflow scaffold add-phase dev/my-epic --slug write-guide --team docs
  ...
  created: dev/my-epic/01-write-guide/plan.md
  created: dev/my-epic/01-write-guide/tpm-tmp/subagent.env
  created: dev/my-epic/01-write-guide/charter-documentarian.md
  created: dev/my-epic/01-write-guide/spawn-prompt-documentarian-r1.md
  mkdir:   dev/my-epic/01-write-guide/tpm-tmp/documentarian-r1
  created: dev/my-epic/01-write-guide/charter-verifier.md
  created: dev/my-epic/01-write-guide/spawn-prompt-verifier-r1.md
  mkdir:   dev/my-epic/01-write-guide/tpm-tmp/verifier-r1-v1

add-phase complete: 01-write-guide (roles: documentarian, verifier)
  tpm-tmp/subagent.env ← comment-only stub (orchestrator adds real values as needed)
  charter-documentarian.md ← PLACEHOLDER (configured file missing: /.../workflow-setup/charters/documentarian-charter.md)
  charter-verifier.md ← PLACEHOLDER (configured file missing: /.../workflow-setup/charters/verifier-charter.md)
```

> **Note (fix #1 forward reference).** With the built-in defaults, each role's
> `charterFile` now points at its promoted charter home
> (`claude-context/methodology/workflow-setup/charters/<stem>-charter.md`). Until those
> charters land at promotion, a default-config `add-phase` drops a **`configured file
> missing`** placeholder (as above) rather than the old `no override` placeholder — the
> charter homes are a forward reference. Once the charters exist, the drop is a real copy.

**Append-only numbering, verified:** on a fresh epic (only `00-epic-plan/`) the
first `add-phase` produces `01-`. After a manually-created `07-manual-thing/`,
the next `add-phase` produces `08-after-gap/` (max + 1) — the gap at 03–06 is
**not** back-filled.

**`--slug` is a plain folder name, never a path.** A slug containing `/`, `\`,
`..`, or an absolute path is rejected (path-traversal guard) before anything is
written.

### `add-round <phase-path> --role <role> [--count <N>] [--config <path>] [--charter <path>]`

Append a kickback round for one role **into the same phase folder**: auto-number
`r<N>` (**max existing `spawn-prompt-<role>-r*.md` + 1**), and drop
`spawn-prompt-<role>-r<N>.md` plus the per-subagent `tpm-tmp/<role>-r<N>[-v<M>]/`
scratch folder(s). This is the mechanism behind the verify↔bug-fixer kickback
loop that re-runs in the same phase. It also drops the `tpm-tmp/subagent.env` stub if
the phase lacks one.

**`--charter <path>` (fix #5)** (re)drops THIS role's charter from the given file
(routed through the strip guard) — the charter-swap / opt-down via the tool. Unlike
the absent-only default drop below, `--charter` always drops; overwriting an
existing `charter-<role>.md` requires `--force`:
`add-round <phase> --role builder --charter <mvp-charter> --force`.

It **also drops `charter-<role>.md` — but only if that file is absent.** That is
what lets the loop's `bug-fixer` (which is in no team's roster, so it was never
charted at `add-phase` time) arrive complete:

```
$ tpm workflow scaffold add-round dev/my-epic/02-build-thing --role bug-fixer
  created: .../02-build-thing/spawn-prompt-bug-fixer-r1.md
  created: .../02-build-thing/charter-bug-fixer.md
  mkdir:   .../02-build-thing/tpm-tmp/bug-fixer-r1

add-round complete: spawn-prompt-bug-fixer-r1.md + tmp scratch
  charter-bug-fixer.md ← PLACEHOLDER (no override; TPM default charter applies)
```

- A **second** `add-round --role bug-fixer` yields `-r2` (spawn-prompt +
  `tpm-tmp/bug-fixer-r2/`) and does **not** re-drop the charter that already exists
  (no charter line in its output).
- A re-check round for a **roster role** (e.g. `--role verifier`) auto-numbers the
  next `r<N>`, drops the spawn-prompt + scratch, and **keeps** the charter copied
  at `add-phase` — it is never clobbered with a placeholder.

### Scratch-folder naming (`-v<M>` suffix)

Per role+round the scratch folder (`workflow.folders.tmp`, default `tpm-tmp`) is named `tpm-tmp/<role>-r<N>[-v<M>]/`:

- A lone non-verifier role → plain `tpm-tmp/<role>-r<N>/` (e.g. `builder-r1`,
  `bug-fixer-r1`).
- The **verifier always gets a `-v<M>` suffix** (blind M-of-count), so a single
  verifier is `tpm-tmp/verifier-r1-v1/` — never a plain `verifier-r1`.
- `--count <N>` on any role fans the scratch out to one folder per instance:
  `add-round --role builder --count 2` → `tpm-tmp/builder-r2-v1/` and
  `tpm-tmp/builder-r2-v2/`.

---

## Charter resolution

`charter-<role>.md` is dropped one of three ways; each prints a note and is
observable in the `charter-*` summary lines:

1. **Copied** — the role's `charterFile` resolves to a file that exists on disk.
   The charter body is copied in **with the orchestrator-only `<!-- ORCHESTRATOR NOTE
   … -->` block(s) stripped and leading/interior blank-runs collapsed** (not literally
   byte-for-byte — the strip and whitespace-normalize are the only transforms). The strip
   is **case-insensitive and hyphen-tolerant** (fix #6): a `<!-- Orchestrator note … -->`
   or `<!-- ORCHESTRATOR-NOTE … -->` is caught too, matching the lint's `STRIP_RE` grammar —
   so a naturally-spelled posture leak can't drop verbatim while the lint FAILs it.
   Note: `charter-<role>.md ← copied from <abs-path>` (with ` [--charter override]` appended
   when landed via the `--charter` flag).
2. **Placeholder (configured file missing)** — a `charterFile` is configured but the
   path does not exist on disk. A placeholder stub is written and the miss is
   flagged. Note: `charter-<role>.md ← PLACEHOLDER (configured file missing: <path>)`.
3. **Placeholder (no override)** — no `charterFile` in config (the default; the
   role's TPM default charter applies at spawn time). A placeholder pointer stub is
   written. Note: `charter-<role>.md ← PLACEHOLDER (no override; TPM default charter applies)`.

> **Gotcha, verified.** A **relative** `charterFile` in a config is resolved
> relative to the **project root** (the nearest `CLAUDE.md` ancestor), *not*
> relative to the config file's own directory. A relative path that looks correct
> from the config's folder can therefore land as a "configured file missing"
> placeholder. Use an **absolute** `charterFile` path to get a reliable copy.

---

## plan.md & subagent.env seeding

Two consumer extension hooks, both resolved from the config at `add-phase` (and the
env stub at `add-round` too). Both fall back to a built-in default when nothing is
configured, so a fresh project needs no config.

### `plan.md` from `planTemplateFile` (fix #9)

If the resolved config names a `workflow.planTemplateFile` that **exists on disk**
(relative to the project root, or absolute), `add-phase` seeds `plan.md` from THAT
template instead of the built-in sentinel stub. A light token expansion runs first:
`{{PHASE}}`, `{{PHASE_NAME}}`, and `{{PHASE_SLUG}}` are all replaced with the phase
folder name (e.g. `01-linecount`); a template with none of those tokens is copied
through unchanged. Absent / non-existent `planTemplateFile` → the built-in stub, as
before. (This kills the "dead config" finding — `planTemplateFile` was resolved but
never consumed.) The scaffold summary prints
`plan.md ← seeded from planTemplateFile <path>` when a template is used.

### `tpm-tmp/subagent.env` stub + consumer override (fix #3)

The module's step-zero ritual `source`s `tpm-tmp/subagent.env`; nothing in the documented
flow used to create it, so every worker's `source` aborted on a missing file. Now
`add-phase` (and `add-round`, if absent) drops it:

- **Default** — a **comment-only stub** (`source`s cleanly, sets nothing): the expected
  state when the round needs no live system. The orchestrator overwrites it with real
  values (endpoints/handles/keys) when a round needs a live system.
- **Consumer override** — if `workflow.subagentEnvTemplate` names an existing file, OR
  `.claude/claude-tpm/subagent.env.template` exists at the project root, that file is
  copied in instead. This is the extensibility hook a child project uses to populate
  emulator env (nbajam/ggaitk). Config value wins over the conventional path.

It is **never clobbered** — an existing `tpm-tmp/subagent.env` (e.g. one the orchestrator
already populated) is left untouched. Summary line: `tpm-tmp/subagent.env ← comment-only
stub` or `… ← copied from <config|convention> template <path>`.

---

## Flags

| Flag | Applies to | Meaning |
|------|-----------|---------|
| `--slug <slug>` | add-phase | Plain phase folder name (no `/`, `\`, `..`, or absolute). Required. |
| `--team <team>` | add-phase | Team whose roster is scaffolded. Required. One of the [known teams](#add-phase-epic-path---slug-slug---team-team---config-path). |
| `--pretask-ack <receipt>` | add-phase | **Required.** Pre-task ack receipt (an `**Accepted:** <phrase>` line). Missing / empty / placeholder → exit 1. No bypass. See the gate note under [`add-phase`](#add-phase-epic-path---slug-slug---team-team---pretask-ack-receipt---config-path---charter-path---role-role). |
| `--role <role>` | add-round (required); add-phase (with `--charter`) | On add-round: the role to add a round for. On add-phase: which roster role a `--charter` override re-charters. |
| `--count <N>` | add-round | Fan the scratch out to N per-instance folders (`-v1`..`-vN`). |
| `--config <path>` | add-phase, add-round | Path to a claude-tpm `config.json`. Default: `<projectRoot>/.claude/claude-tpm/config.json`; absent → built-in defaults. |
| `--charter <path>` | add-phase, add-round | Re-charter one role from `<path>`, routed through the strip + blocked-name guards (fix #5 — the mvp opt-down / charter-swap via the tool). On add-phase, pairs with `--role` (or a single-role team); `--force` to replace an existing charter. |
| `--force` | all | Overwrite files that already exist instead of refusing. |
| `--quiet` | all | Suppress the per-file `mkdir:` / `created:` progress lines. |
| `--help`, `-h` | all | Print the header docstring and exit 0. |

A **value flag given without a value** (e.g. `--slug` at end of argv) fails loudly:
`Error: --slug requires a value.` (exit 2). An **unknown flag** →
`Unknown flag: --bogus` (exit 2).

---

## Overwrite protection

Every file write is guarded twice:

- **Blocked filename patterns** — a target basename containing `report` / `summary`
  / `analysis` / `findings` is refused (these are server-side-blocked names), via
  `check-filename.js`.
- **No clobber** — an existing target is refused unless `--force`:
  `refusing to overwrite existing file: <path> (pass --force).` (exit 1). Likewise
  `add-phase` refuses an already-existing `NN-<slug>/` phase folder without
  `--force`.

---

## Exit codes and error messages (all verified)

| Situation | Message (stderr) | Exit |
|-----------|------------------|------|
| `--help` (or a subcommand with `--help`) | header docstring on stdout | 0 |
| Bare invocation (no subcommand) | header docstring | 1 |
| `add-phase` without `--slug` | `add-phase: --slug is required.` | 1 |
| `add-phase` without `--team` | `add-phase: --team is required.` | 1 |
| `add-phase --slug ../../ESCAPE` | `--slug must be a plain folder name (no "/", "\", ".." or absolute path) …` | 1 |
| `add-phase --team nope` | `unknown team "nope". Known teams: full, ship, test, docs, research, build.` | 1 |
| `add-round` without `--role` | `add-round: --role is required.` | 1 |
| `add-round` on a non-existent phase dir | `add-round: phase folder does not exist: <path>` | 1 |
| Overwrite without `--force` | `refusing to overwrite existing file: <path> (pass --force).` | 1 |
| Value flag missing its value (e.g. `--slug`) | `Error: --slug requires a value.` | 2 |
| Unknown flag | `Unknown flag: --bogus` | 2 |
| Unknown subcommand | `Unknown subcommand: <x>` + usage | 2 |

(Semantic / usage failures inside a subcommand carry the `scaffold-subagent:`
prefix and exit **1**; argv-parse failures exit **2**.)

---

## Worked example (run end-to-end)

Build an epic, add two phases, then drive a verify→bug-fixer kickback loop — every
line below was executed and observed.

```bash
# 1. Initialize the epic (creates 00-epic-plan/).
tpm workflow scaffold epic-init dev/demo-epic

# 2. First phase, docs team → 01-write-guide/ (documentarian + verifier).
tpm workflow scaffold add-phase dev/demo-epic --slug write-guide --team docs

# 3. Second phase, full team → 02-build-thing/
#    (planning, builder, test-writer, documentarian, verifier).
tpm workflow scaffold add-phase dev/demo-epic --slug build-thing --team full

# 4. Verifier kicked back → spawn the loop's bug-fixer into the SAME phase.
#    Drops spawn-prompt-bug-fixer-r1.md + charter-bug-fixer.md + tpm-tmp/bug-fixer-r1/.
tpm workflow scaffold add-round dev/demo-epic/02-build-thing --role bug-fixer

# 5. Re-run the builder (auto-numbers → r2) and re-check the verifier (→ r2, -v1).
tpm workflow scaffold add-round dev/demo-epic/02-build-thing --role builder
tpm workflow scaffold add-round dev/demo-epic/02-build-thing --role verifier
```

Resulting `02-build-thing/` (observed):

```
02-build-thing/
├── plan.md
├── charter-planning.md   charter-builder.md   charter-test-writer.md
├── charter-documentarian.md   charter-verifier.md   charter-bug-fixer.md
├── spawn-prompt-planning-r1.md
├── spawn-prompt-builder-r1.md      spawn-prompt-builder-r2.md
├── spawn-prompt-test-writer-r1.md
├── spawn-prompt-documentarian-r1.md
├── spawn-prompt-verifier-r1.md     spawn-prompt-verifier-r2.md
├── spawn-prompt-bug-fixer-r1.md
├── findings/  tools/  tests/
└── tpm-tmp/
    ├── subagent.env                 ← comment-only stub (dropped at add-phase)
    ├── planning-r1/  builder-r1/  builder-r2/  test-writer-r1/
    ├── documentarian-r1/  bug-fixer-r1/
    └── verifier-r1-v1/  verifier-r2-v1/
```

---

## Tests

`tests/scaffold-subagent/test.js` — a self-contained, zero-dep suite that builds
throwaway epics under `os.tmpdir()` and tears them down. Run it:

```
$ node tests/scaffold-subagent/test.js
PASS — 87 checks passed, 0 failed        # exit 0
```

It exits non-zero on any failure (keeping the scratch epic for inspection and
printing its path). The tightening round added coverage for the env stub + consumer
override (#3), `--charter` on add-phase/add-round (#5), the case-insensitive strip
(#6), and `planTemplateFile` seeding (#9).

Each new behavior is **mutation-checked** by `tools/mutation-check.js`: it applies one
deliberate mutation per fix, confirms the owning suite goes RED, then restores the tool
byte-for-byte (`PASS — 5/5 mutants killed`).
