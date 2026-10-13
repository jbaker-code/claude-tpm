# `tpm-workflow-cost-ledger.js` — per-subagent cost ledger (v2, epic-aware)

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Reference doc for `tools/workflow/tpm-workflow-cost-ledger.js`. Every claim below was confirmed by running the canonical tool
(`tools/workflow/tpm-workflow-cost-ledger.js`, via `tpm workflow cost`) with `node v24.16.0`.

## Purpose

Make subagent cost durable. The orchestrator spawns workers + verifiers and the harness reports each
one's token + tool-call usage in its completion notification; this tool writes **one row per spawned
subagent** into a markdown ledger table that travels with the round. It can also **print a running total**
for a ledger and **roll up an entire epic** (per-phase breakdown + epic-wide totals).

It is an **orchestrator tool**: a subagent can't reliably introspect its own cumulative token count, so
`tokens` comes from the completion notification and is authoritative. What a subagent *does* know — its
tool-call count — can be passed via `--calls` as a cross-check. The tool is project-agnostic (no project
paths or domain knowledge baked in).

## Modes — pick exactly one target

Exactly one of `--dir`, `--epic-path`, or `--rollup` is required; passing zero or more than one is a
usage error (exit `2`).

| Target flag | Ledger location | Mode |
|-------------|-----------------|------|
| `--dir <path>` | `<path>/tmp/cost-ledger.md` | Flat round ledger. Append a row, or (with `--summary`) print its total. |
| `--epic-path <path>` | `<path>/00-epic-plan/cost-ledger.md` | Epic-level ledger — deliberately in `00-epic-plan/` (charter-clean orchestrator state), **not** in a `tmp/` that gets swept. Append a row, or (with `--summary`) print its total. |
| `--rollup <path>` | reads all of them | Aggregate an epic: scan every phase's `NN-<slug>/tmp/cost-ledger.md` **plus** the epic-level `00-epic-plan/cost-ledger.md`, print a per-phase breakdown and the epic-wide totals. Read-only; prints and exits. |

Behaviour is chosen by which flags are present: `--summary` → print totals (no row written); `--rollup`
→ aggregate; otherwise → append a row.

## Flags

| Flag | Effect |
|------|--------|
| `--dir <path>` | Flat round ledger target (see table above). |
| `--epic-path <path>` | Epic ledger target. Mutually exclusive with `--dir` / `--rollup`. |
| `--rollup <path>` | Aggregate an epic and exit. Read-only. |
| `--summary` | Print the target ledger's totals and exit; no row is written. |
| `--agent <name>` | Subagent label / uuid (e.g. `round-w-8b3e`). |
| `--role <role>` | `worker` \| `verifier` \| `orchestrator` \| … (free text). |
| `--model <model>` | `opus` \| `sonnet` \| `haiku` \| … (free text). Totals break down by model. |
| `--tokens <n>` | Token count. Accepts `715000`, `"715k"`, `"~715k"`, `"1.2m"`. |
| `--calls <n>` | Tool-call count (the subagent-observable cross-check). |
| `--verdict <text>` | `ACCEPT` \| `FAIL` \| `PASS` \| `n/a` \| … (free text). |
| `--round <text>` | Round / phase label (free text). |
| `--note <text>` | Anything worth keeping (fix-loop count, retries, …). |
| `--date <YYYY-MM-DD>` | Override the auto-stamped date (default: today in `--tz`). |
| `--tz <IANA zone>` | Timezone for the auto-stamped date (default: `COST_LEDGER_TZ` env var, else `America/Los_Angeles`). |
| `--file <name>` | Ledger filename (default `cost-ledger.md`). |
| `--session <ref>` | Stamp this tpm session in the row's `Session` cell instead of resolving one. Accepts `0012`, `0012b`, `12b`, `session-0012b`. A malformed value exits `2` and writes nothing. See "Session attribution". |
| `--track <letter>` | Track letter to pair with `--session 0012` (`--session 0012 --track c` = `0012c`). Disagreeing or without `--session` exits `2`. |
| `--help`, `-h` | Print usage and exit `0`. |

### Token/call parsing

`--tokens` / `--calls` accept a plain integer, a `k`/`m` suffix (`715k` = 715000, `1.2m` = 1200000), and
tolerate a leading `~` and embedded commas/spaces. A missing or `n/a` value renders as `—` in the row and
is skipped from totals. Verified: `--tokens "~1.2m"` summed to `1,200,000`.

## Output shape

The ledger is an append-only markdown table. The tool writes the header block (with column headers) on
first append, then appends one row per invocation. Columns:

```
| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes | Session |
```

Numeric columns are right-aligned and rendered with thousands separators (`715,000`). A pipe inside any
free-text field is escaped. `--summary` prints the subagent count, total tokens (and how many rows carried
a token count), total calls, and — when more than one model appears — a per-model token breakdown.

## Session attribution

The last column, `Session`, records which tpm session appended the row, in stored form (`session-0012b`; track a is
`session-0012`). It is resolved by the shared resolver (`tools/lib/attribution.js`) in this order: `--session`/`--track`, then the
`TPM_SESSION_ID` environment variable, then a lookup of `CLAUDE_CODE_SESSION_ID` against the session tracks (`TPM_SESSIONS_DIR`
or the project's sessions folder), then blank. A blank resolution leaves the cell empty; attribution never blocks the append.
The ledger holds only the session, not how it was found (the `via` is kept in task history and sign-off tokens).

An existing ledger whose header is exactly the old 9-column pair gets the `Session` column added (both header lines) in the
same write that appends the row; old rows are not touched (they stay short and are not back-filled). Any other header is left
alone and the 10-cell row is still appended. Observed on a scratch round:

```
$ CLAUDE_CODE_SESSION_ID=fake-id-bbb TPM_SESSIONS_DIR=<sessions> tpm workflow cost --dir <round> --agent w1 --role worker --model sonnet --tokens 10k --calls 3 --verdict PASS
  | 2026-10-08 |  | w1 | worker | sonnet | 10,000 | 3 | PASS |  | session-0012b |
$ tpm workflow cost --dir <round> --agent w2 --role worker --tokens 5k --session 0012 --track c
  | 2026-10-08 |  | w2 | worker |  | 5,000 | — |  |  | session-0012c |
$ tpm workflow cost --dir <round> --agent w3 --tokens 5k          # nothing resolves: empty cell
  | 2026-10-08 |  | w3 |  |  | 5,000 | — |  |  |  |
$ tpm workflow cost --dir <round> --agent w4 --session zz
cost-ledger: --session: 'zz' is not a session reference (use 0012, 0012b, 12b or session-0012b; number 1-9999, track a-z lowercase)
# exit 2, nothing written
```

`--summary` and `--rollup` read the ledger as before (they use the Tokens / Calls / Model columns and ignore `Session`).

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Success — row appended, summary printed, rollup printed, or `--help`. |
| `2` | Usage error — no target given, more than one of `--dir` / `--epic-path` / `--rollup`, or a malformed / disagreeing `--session` / `--track`. |

## Worked examples

All run against scratch folders under `tmp/`.

### Append two rows to a flat round ledger, then summarize

```
tpm workflow cost --dir <round-a> \
  --agent w1 --role worker --model opus --tokens 715k --calls 198 --verdict ACCEPT --round "phase B" --note ok
tpm workflow cost --dir <round-a> \
  --agent v1 --role verifier --model sonnet --tokens 1.2m --calls 40 --verdict PASS
tpm workflow cost --dir <round-a> --summary
```

The first append printed (ledger written to `<round-a>/tmp/cost-ledger.md`):

```
cost-ledger: appended to …/round-a/tmp/cost-ledger.md
  | 2026-08-29 | phase B | w1 | worker | opus | 715,000 | 198 | ACCEPT | ok |
```

`--summary` printed:

```
Cost ledger — …/round-a/tmp/cost-ledger.md
  2 subagent(s)
  tokens: 1,915,000 total (2 row(s) with a token count)
  calls:  238 total (2 row(s) with a call count)
    sonnet: 1,200,000
    opus: 715,000
```

(715k + 1.2m = 1,915,000; 198 + 40 = 238.)

### Append to the epic ledger (lands in `00-epic-plan/`, not `tmp/`)

```
tpm workflow cost --epic-path <my-epic> \
  --agent orch --role orchestrator --tokens 40k --calls 12 --round "epic bookkeeping"
```

Verified the row landed at `<my-epic>/00-epic-plan/cost-ledger.md` and that **no** `<my-epic>/tmp/`
ledger was created.

### Roll the whole epic up

With the epic ledger above (40k) plus two phase ledgers — `01-planning` (100k+60k over two subagents) and
a letter-suffixed `02b-build` (200k) — `--rollup` printed:

```
Cost rollup — …/my-epic
  Per-phase breakdown:
    00-epic-plan: 1 subagent(s) · tokens 40,000 · calls 12
    01-planning: 2 subagent(s) · tokens 160,000 · calls 70
    02b-build: 1 subagent(s) · tokens 200,000 · calls 80
  ────
  EPIC TOTAL: 4 subagent(s) across 3 ledger(s)
    tokens: 400,000 total (4 row(s) with a token count)
    calls:  162 total (4 row(s) with a call count)
      opus: 300,000
      sonnet: 60,000
      (none): 40,000
```

The rollup includes the epic-level `00-epic-plan/` ledger, sorts phases numerically (so `02b` follows
`01`), ignores non-phase sibling folders, and breaks the epic-wide token total down by model (rows with
no `--model` fall under `(none)`).

### Guards

- No target (`--agent x --tokens 10k` with none of `--dir`/`--epic-path`/`--rollup`) → exit `2`,
  message "one of --dir …, --epic-path …, or --rollup … is REQUIRED."
- Two targets (`--dir … --epic-path …`) → exit `2`, message "mutually exclusive — pass exactly one."

## Tests

The tool's tests live under `tools/workflow/tests/tpm-workflow-audit-cost/` — run the full suite with `npm test` (exit 0 = all
pass). Confirmed green: **21/21 assertions passed**. It covers the flat append + `--summary` total, token
parsing (`715k` / `1.2m`), the `--epic-path` target landing in `00-epic-plan/` (and *not* `tmp/`), the
`--rollup` aggregation across phase + epic ledgers, the mutually-exclusive-target guard (exit `2`), and
`--help` (exit `0`).
