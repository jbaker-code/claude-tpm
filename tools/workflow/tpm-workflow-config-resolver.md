# `tpm-workflow-config-resolver.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The workflow-module config resolver.

**Canonical location:** `tools/workflow/tpm-workflow-config-resolver.js` (documented from
`dev/workflow-module-build/24-tighten-scaffold-config/tools/config-resolver.js` — the model-aware
version hardened by the fable-review tightening round: 7 personas + the `mvp` opt-down charter slot /
6 teams / `verifier.loopFixer`). This supersedes the earlier phase-01 and phase-12 config-resolvers.

> **Tightening round (2026-08-29).** Two changes land here: (#1) every `subagentConfigs[].charterFile`
> now points at its **promoted charter home** instead of `""` (the placeholder no-op the fable review
> found); (#3) a new `subagentEnvTemplate` field lets a consumer supply the scaffolder's per-phase
> `subagent.env` from a template. The charter homes are a **forward reference** — see the `--validate`
> note below.

## Purpose

Per-suite domain resolver for the `workflow` section of a project's
`.claude/claude-tpm/config.json`. It reads the config file (if any), merges it over built-in
defaults, and hands back the fully **resolved** workflow registry (`subagentConfigs` / `teams` /
`charterVariants` / `verifier` / `deliverables` / etc.) so callers never hand-parse JSON.

- **Absent or partial config is not an error** — it means "use the defaults."
- A config that **references a file which doesn't exist on disk** is an error only under `--validate`.

It is both a CLI and a `require()`-able module.

## Usage

```
tpm workflow config [--config <path>] (--json | --get <dotted.key> | --validate) [--help]
```

Exactly one action (`--json` / `--get` / `--validate` / `--help`) is expected. Omitting all of them
prints usage to stderr and exits 1 (nothing to do is a usage error, not a silent no-op).

## Flags

| Flag | Effect |
|---|---|
| `--config <path>` | Path to a `config.json`. Default: `<projectRoot>/.claude/claude-tpm/config.json`, where `<projectRoot>` is found by walking up from the current directory for a `CLAUDE.md` marker (falls back to the current directory if none is found). |
| `--json` | Emit the resolved `workflow` config as pretty-printed JSON to stdout. Exit 0. |
| `--get <dotted.key>` | Emit one value from the resolved config, JSON-stringified (e.g. `--get verifier.loopFixer`). Exit 0, or a friendly error + exit 1 if the key path doesn't resolve. |
| `--validate` | Confirm every file the resolved config **references** (`planTemplateFile`, `subagentEnvTemplate`, each `subagentConfigs[].charterFile`, each `charterVariants[role]`'s `alternates[]` / `addenda[]`) exists on disk relative to `<projectRoot>`. `OK` + exit 0 if all present; a friendly error listing every missing path + exit 1 otherwise. **NB (fix #1):** the default `charterFile`s point at the promoted charter homes (`claude-context/methodology/workflow-setup/charters/`), a **forward reference** — `--validate` against a tree without those charters is *expected* to fail until they land at promotion. |
| `--help`, `-h` | Print usage and exit 0. |

### `--config` resolution

- **Explicit `--config` pointing at a non-existent file** → friendly error + exit 1 (the caller named a specific file; a typo/missing file is surfaced loudly).
- **The default location not existing** → NOT an error (the normal "no config yet" case) → resolves to built-in defaults.

### Version awareness

Reads the top-level `version` field (defaults to 1 if absent). This resolver understands version 1.
An unrecognized version prints a warning to stderr and continues best-effort rather than hard-failing.

## Exit codes

| Exit | Meaning |
|---|---|
| `0` | `--json` / `--get` (key found) / `--validate` (all referenced files present) / `--help` succeeded. |
| `1` | No action flag given (usage error); `--get` key not found; `--validate` found missing referenced file(s); explicit `--config` points at a non-existent file; config file could not be parsed as JSON. Errors print to stderr, prefixed `config-resolver:`. |

## What it resolves — the defaults

With no config (or a partial one), the resolver returns these built-in defaults:

- **8 `subagentConfigs` entries** — 7 spawnable personas + the `mvp` opt-down charter slot — each
  `defaultModel: opus`, each **`charterFile` wired to its promoted home** (fix #1; was `""` → placeholder):

  | name | charterFile (`claude-context/methodology/workflow-setup/charters/…`) | retryCount |
  |---|---|---|
  | `planning` | `planning-charter.md` | 1 |
  | `builder` | `shipping-charter.md` | 5 |
  | `test-writer` | `test-writer-charter.md` | 1 |
  | `documentarian` | `documentarian-charter.md` | 1 |
  | `verifier` | `verifier-charter.md` | 1 |
  | `bug-fixer` | `bug-fixer-charter.md` | 5 |
  | `researcher` | `research-charter.md` | 1 |
  | `mvp` | `mvp-charter.md` | 5 |

  Note `builder → shipping-charter.md` and `researcher → research-charter.md` (the persona name and its
  charter stem differ). `mvp` is the **builder opt-down variant**: it is in **no team's roster** (so team
  resolution is unaffected), carried here only so its charter home is wired + `--validate`-checked; the
  orchestrator lands it via the scaffolder's `--charter` flag (or `add-round --role mvp`).
  `retryCount` is the per-agent bail-retry budget — delivery/fix roles (`builder`/`mvp`/`bug-fixer`) get **5**, everyone else **1**.
- **6 teams** (`teams`, array order = run order): `full` (planning → builder → test-writer → documentarian → verifier), `ship` (builder → verifier), `test` (test-writer → verifier), `docs` (documentarian → verifier), `research` (researcher), `build` (builder).
- **`verifier`**: `{ requireAllPass: true, multiCountMode: "blind-pair", loopFixer: "bug-fixer" }`. `loopFixer` names the persona the orchestrator spawns to make targeted fixes when a verifier kicks back (convention: the `bug-fixer` persona).
- `defaultParallelism: "serial"`, `verifyLoopCap: 5`, `deliverables: { tldr, toolFeedback, wiki }` (all true), `planTemplateFile: ""`, `subagentEnvTemplate: ""` (fix #3), `charterVariants: {}`, `costLedger.epicPath: "00-epic-plan/cost-ledger.md"`, `folders: { tmp: "tpm-tmp", findings: "findings", tools: "tools", tests: "tests" }`, `devDir: "dev"` (#1183; see `docs/config-guide.md` §2), `blockedFilenamePatterns: ["report","summary","analysis","findings"]`.

**`planTemplateFile`** (consumed by the scaffolder — fix #9) and **`subagentEnvTemplate`** (fix #3) both
name a file the scaffolder copies at `add-phase`: the plan-template seeds `plan.md`, the env-template
seeds each phase's `tpm-tmp/subagent.env` (else a comment-only stub). See `scaffold-subagent.md`.

### Merge rules (config over defaults)

- `subagentConfigs` and `teams` merge **by name** — a matching name overrides its default fields; a new name is appended.
- `deliverables`, `verifier`, `costLedger`, `folders`, and each `charterVariants[role]` are **shallow-merged** (config keys override matching default keys; unset keys keep their default).
- `blockedFilenamePatterns` is **replaced** wholesale by the config's list (not merged).
- `enabled`, `planTemplateFile`, `subagentEnvTemplate`, `defaultParallelism`, `verifyLoopCap`, `devDir` are scalar overrides (a non-string `devDir` is ignored and the default kept). `folders` and `devDir` are config-only: no flag or env rung.

## Reusable API

The file is also a module:

- `resolveConfig(configPath, opts) -> { resolved, projectRoot, configPath, usedDefaultLocation, configExists }`
- `validateResolved(resolved, projectRoot) -> { ok, missing: [{ key, filePath }] }`
- `getDefaults() -> object` (deep-cloned built-in workflow defaults)
- `findProjectRoot(startDir, marker='CLAUDE.md') -> absolute path`
- `mergeWorkflowConfig(rawWorkflow) -> object`, `getDotted(obj, dottedKey) -> { found, value }`

## Worked example

Verified runs (Node v24.16.0), invoked from `dev/workflow-module-build/18-shipdocs-foundational-v2/`
with the canonical tool at `../12-model-config/tools/config-resolver.js`. There is no config at the
default location, so these resolve to the built-in defaults:

```console
$ tpm workflow config --get verifier.loopFixer
"bug-fixer"

$ tpm workflow config --config sample-config.json --get verifier
{"requireAllPass":true,"multiCountMode":"blind-pair","loopFixer":"custom-fixer"}

$ tpm workflow config --get verifyLoopCap
5

$ tpm workflow config --validate                              # against a tree WITHOUT the promoted charters
config-resolver: referenced file(s) do not exist:
  - subagentConfigs[planning].charterFile -> /.../workflow-setup/charters/planning-charter.md
  - subagentConfigs[builder].charterFile  -> /.../workflow-setup/charters/shipping-charter.md
  ... (one row per wired charter home) ...                         # exit 1 — EXPECTED forward reference (fix #1);
                                                                    # passes once the charters land at promotion

$ tpm workflow config --get verifier.nope
config-resolver: no such key "verifier.nope" in resolved config.  # exit 1

$ tpm workflow config               # no action flag
config-resolver.js: nothing to do — pass one of --json / --get / --validate.
...usage...                                                        # exit 1
```

With a sample config `sample-config.json`:

```json
{
  "version": 1,
  "workflow": {
    "verifyLoopCap": 3,
    "subagentConfigs": [
      { "name": "builder", "defaultModel": "sonnet" },
      { "name": "custom-role", "defaultModel": "haiku", "charterFile": "charters/custom.md", "retryCount": 2 }
    ],
    "verifier": { "loopFixer": "custom-fixer" }
  }
}
```

```console
# by-name merge: builder's model overridden to "sonnet" (its wired charterFile home preserved),
# new custom-role appended:
$ tpm workflow config --config sample-config.json --get subagentConfigs
[... ,{"name":"builder","defaultModel":"sonnet","charterFile":"claude-context/methodology/workflow-setup/charters/shipping-charter.md","retryCount":5}, ...
 {"name":"custom-role","defaultModel":"haiku","charterFile":"charters/custom.md","retryCount":2}]

# scalar override:
$ tpm workflow config --config sample-config.json --get verifyLoopCap
3

# shallow-merge: loopFixer overridden, requireAllPass/multiCountMode kept from defaults:
$ tpm workflow config --config sample-config.json --get verifier
{"requireAllPass":true,"multiCountMode":"blind-pair","loopFixer":"custom-fixer"}

# --validate fails: custom-role.charterFile references a file that doesn't exist:
$ tpm workflow config --config sample-config.json --validate
config-resolver: referenced file(s) do not exist:
  - subagentConfigs[custom-role].charterFile -> /.../charters/custom.md    # exit 1
```

Error / edge behavior (all verified):

```console
# explicit --config pointing nowhere -> loud error:
$ tpm workflow config --config ./nope.json --json
config-resolver: --config path does not exist: /.../nope.json     # exit 1

# unrecognized version -> stderr warning, best-effort resolve continues:
$ tpm workflow config --config badversion.json --get verifyLoopCap
config-resolver: warning — config.json declares version 99, this resolver understands version 1. Resolving best-effort.
2                                                                  # exit 0

# unparseable JSON in an explicit config -> error:
$ tpm workflow config --config badjson.json --json
config-resolver: could not parse /.../badjson.json as JSON: Expected property name or '}' ...   # exit 1
```
