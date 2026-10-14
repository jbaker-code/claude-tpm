# `tpm-workflow-audit.js` — task-folder adherence audit (v2, epic-aware)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Reference doc for `tools/workflow/tpm-workflow-audit.js`. Every claim below was confirmed by running the canonical tool
(`tools/workflow/tpm-workflow-audit.js`, via `tpm workflow audit`) with `node v24.16.0`.

## Purpose

Walk a task tree (`dev/` by default) and audit each top-level entry against the canonical folder
layouts. Each top-level entry is classified automatically as one of two shapes and checked against the
rules for that shape:

- **EPIC** — a folder that contains a `00-epic-plan/` subfolder. Its other children are numbered PHASE
  folders (`NN[-letter]-<slug>/`, append-only lineage).
- **FLAT** — a classic `dev/<task>/` leaf (a `plan.md` + `findings/` …). The legacy flat-task audit is
  preserved unchanged.

The tool is **read-only against the task tree**; the only thing it writes is the one markdown report you
point `--out` at. It never modifies any task folder.

## Flags

| Flag | Required | Default | Effect |
|------|----------|---------|--------|
| `--out <path>` | **yes** | none | Output markdown report path. No default — omitting it fails loudly (exit 1). Parent dirs are created. |
| `--tasks-root <dir>` | no | `workflow.devDir` (default `dev`) | The task tree to scan. Point it at a scratch tree so the real `dev/` tree isn't required (used by the tests and by this doc's example). |
| `--strict` | no | off | Exit `3` (instead of `0`) if ANY epic/phase violation is found. The report is still written either way. Useful in CI. |
| `--help`, `-h` | no | — | Print usage and exit `0`. |

An unknown argument fails with `unknown arg: <arg>` and exit `1`.

## What it checks

### EPIC entries

- **Numbering integrity.** Every phase folder (all children except `00-epic-plan/`) must start with an
  `NN-` token — one or more digits plus an optional lowercase-letter suffix, then `-` (`01-foo` → `01`,
  `02b-bar` → `02b`). A folder without that prefix is flagged **malformed**. Two phases sharing the same
  token are flagged as a **duplicate**. Monotonic-with-gaps is fine (append-only lineage never renumbers,
  so a skipped number is not a violation).
- **One-plan-one-charter per phase.** Each phase folder must have **exactly one** `plan*.md` and **at
  least one** `charter-*.md`. Zero plans, 2+ plans, or zero charters is each flagged. Multiple charters
  are allowed (a phase can legitimately carry, e.g., a builder and a verifier charter).
- **`00-epic-plan/` charter-cleanliness (structural scope only — see below).**

Also flags any scratch dir (the configured scratch folder — `tpm-tmp` by default — plus `scratch`/`research`) nested inside a phase's `findings/`.

### FLAT entries (legacy)

- `plan.md` and `findings/` presence.
- Scratch-shaped dirs (the configured scratch folder `workflow.folders.tmp`, default `tpm-tmp`, plus `scratch`/`research`) wrongly nested under `findings/` (they belong in the
  task's own `tpm-tmp/`) — reported as drift. The drift message names the configured folder: ``(move to task `tpm-tmp/`)``. A plain `findings/tmp/` is no longer flagged under the default config.
- Stray files/dirs at the task root that aren't part of the recognized layout.

### The charter-cleanliness check is STRUCTURAL scope only

The `00-epic-plan/` folder is worker-readable and must stay charter-clean. The check scans every `.md`
file directly under `00-epic-plan/` for three **structural posture markers**:

1. a `## The one rule` heading (a pasted charter section),
2. an `<!-- ORCHESTRATOR NOTE …` inline comment, and
3. a `# Charter —` heading (a pasted charter heading).

The markers are anchored so the plain **word** "charter" used legitimately in an epic plan does not trip
them — only an actual pasted charter heading / orchestrator note does.

**Deliberate, documented limitation:** this catches a *structural* leak (a pasted heading or an
orchestrator-note comment), but **not a PROSE posture leak** — e.g. a sentence like "phase 04 is a
verification round" reads clean to this check. Prose-level cleanliness stays orchestrator discipline; the
tradeoff is logged in `00-epic-plan/decisions.md` (Phase 06 sweep, promotion note 1). Do not describe the
check as guaranteeing the `00-epic-plan/` folder is posture-free — it guarantees only the absence of the
three structural markers.

> Note: `audit.js` does **not** check filenames against a blocked-filename list — that is a separate tool
> (`check-filename.js`). This doc describes only what `audit.js` itself runs.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Audit ran and the report was written (and, under `--strict`, no violations were found). |
| `1` | Usage error — missing `--out`, an unknown arg, a `--tasks-root` that doesn't exist, or an IO failure writing the report. |
| `3` | `--strict` only: the audit ran and the report was written, but at least one epic/phase violation was found. |

## Worked example

Built a scratch tree (any throwaway dir) containing a clean epic (`demo-epic`), a deliberately broken epic
(`broken-epic`), and a legacy flat task (`legacy-task`), then ran:

```
tpm workflow audit \
  --out audit-report.md --tasks-root <scratch-work> --strict
```

`broken-epic` carried four seeded problems (a `misc-notes/` folder with no `NN-` prefix, two phases both
numbered `03`, a phase with two `plan*.md` files and no charter, and a `## The one rule` heading pasted
into its `00-epic-plan/epic-plan.md`); `legacy-task` had a `findings/tpm-tmp/` scratch dir and a stray
`stray-note.md` at its root.

Observed console output:

```
Written to audit-report.md (59 lines)
Summary: {
  "epics": 2,
  "flatLeaves": 1,
  "violations": 5,
  "fullySpecd": 0,
  "missingPlan": 0,
  "missingFindings": 0,
  "findingsScratch": 1,
  "anyStray": 1
}
```

Exit code was `3` under `--strict` (violations present); rerunning without `--strict` produced the same
report and exited `0`.

The report's clean epic and violation sections read (excerpt):

```markdown
### `…/demo-epic`
- classified: **EPIC** (has `00-epic-plan/`)
- phases (3): `01-planning`, `02-build`, `02b-extra`
- numbering: monotonic append-only, gaps OK — ✓ no duplicates
  - `01-planning`: plan=1 charter=1 (charter-builder.md) ✓
  - `02-build`: plan=1 charter=2 (charter-builder.md, charter-verifier.md) ✓
  - `02b-extra`: plan=1 charter=1 (charter-builder.md) ✓
- `00-epic-plan/` charter-cleanliness: ✓ clean (2 md file(s) scanned)

### Violations
- malformed phase folder `…/broken-epic/misc-notes` — does not start with a `NN-` number token
- duplicate phase number `03` in `…/broken-epic` — `03-again`, `03-twoplans`
- phase `03-twoplans` has 2+ plan files: `plan-v2.md`, `plan.md`
- phase `03-twoplans` has NO charter-*.md
- charter/posture leak in `…/broken-epic/00-epic-plan/epic-plan.md` — ## The one rule (charter section)
```

The report legend: `✓` present · `✗` missing · `-` optional · `❌ FLAG` = a hard violation.

## Tests

The tool's tests live under `tools/workflow/tests/tpm-workflow-audit-cost/` — run the full suite with `npm test` (exit 0 = all pass).
Confirmed green: **25/25 assertions passed**. It covers epic-vs-flat classification, numbering integrity
(duplicate / malformed / monotonic-with-gaps), one-plan-one-charter, the structural charter-cleanliness
check (including that the legitimate word "charter" does not trip it), the preserved legacy flat checks,
and the `--strict` (0/3) and `--help` (0) exit codes.
