# `tpm-session-current.js` — current-session resolver + open gate

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

Answers "which track is **mine**, if any?" and owns allocating the next `session-NNNN` folder number
(four-digit, zero-padded). Backs the `tpm-session` skill's bare-invocation state check (open → `save`,
not-opened → `open`, foreign-open → `open`, the gate); the skill resolves the session number here, then passes it to the write surface
(`tpm-session-ops.js`) and the reader (`tpm-session-export.js`) as an explicit `--session`.

## Purpose — tracks, found by Claude session id

A session folder `session-NNNN/` holds one record per **track** — one per Claude instance working in it.
Track **a** is the unsuffixed `session-NNNN.json` (exactly the pre-tracks name, so an old single record is
simply track a); tracks b..z are `session-NNNN-b.json` …, each with a derived `.md` beside it. Each record
carries its owner in `meta` (`track`, `claudeSessionId`, `claudePid`, `claudePidStartedAt`, `hostname`, and
the `lastWriter {version, at}` stamp) — additive keys, **no schemaVersion bump**.

"Which session am I in" is answered by **Claude session id** (`$CLAUDE_CODE_SESSION_ID`, read through
`tools/lib/identity.js`): the unsealed track whose recorded owner id equals the caller's. Whether a track is
sealed is decided in exactly one place (`trackState()` in `lib/session-tracks.js`): its own `meta.closedAt`
(`close`) or a `.sealed` marker file.

`<sessionsDir>/.current-session.json` is kept as a **non-authoritative hint**, derived from the tracks and
kept true (`closedAt` is `null` iff any track of that session is still unsealed) so older tpm versions that
read it keep working. New code never decides "current" from it. The one narrow exception is the upgrade
aid: when there is no unsealed track, the hint is open and names the caller, but its folder holds no
record, `--open` creates the missing record (track a) in that folder instead of allocating a new number.

## Requirements / invocation shape

```
tpm session current [--sessions-dir <dir>] (--state [--all] | --open [<choice>] | --seal | --next-number) [--help]
```

`<choice>` (after an exit-3 refusal; exactly one — the person decides, the tool never picks): `--adopt <track> [--even-if-running] [--session NNNN]`, `--parallel [--session NNNN]`, `--next`, `--seal-and-new [--even-if-running]`, or `--track <letter>` (explicit resume; the way through when your own session id is unreadable).

- `--sessions-dir <dir>` — **optional.** Omitted, it is resolved from the project root's
  `.claude/claude-tpm/config.json` (`session.notes.sessionsDir`); the flag overrides that.
- Exactly one of `--state` / `--open` / `--seal` / `--next-number` must be passed.

## Flags

| Flag | Effect | Side effect |
|---|---|---|
| `--state` | Prints `{ state, number, track, sessionId, mine, foreign, unowned, superseded, skipped, unrecognised, scanned, hint, pointerPath, pointer }` as JSON. `refusal` (`{code}`) and `blocking[]` appear only when `state` is `foreign-open`. `state` is `"open"` (you own an unsealed track), `"not-opened"` (nothing blocks you), or **`"foreign-open"`** (a session is open but none of its unsealed tracks is yours — foreign/unreadable/unowned tracks are listed in `foreign` and `blocking`, each with a `liveness` line; bare `tpm-session` routes this to the open gate, never to `save`). `skipped` lists every record that could not be read; `unrecognised` lists `session-*` files that are not a track. Scans the newest 20 session folders; `--all` scans every folder. | none |
| `--open` | Opens or resumes **your** track, **idempotent**. Order: a track you own → resumed; your id unreadable and exactly one unsealed track → that one; another session's (or an unreadable) unsealed track → **refused, exit 3, nothing written**; nothing unsealed → claims a new `session-NNNN/` folder (`mkdir`) and track a (`link`-from-temp), creating the folder and the record. A lost race re-runs the gate, so two opens never return the same number-and-track. | creates the folder + record, writes the hint |
| `--open --adopt <track>` | "That track is **mine**": re-points the named unsealed track to your Claude session id and process (`claudeSessionId`, `sessionIds`, `claudePid`, `claudePidStartedAt`, `hostname`, `adoptions[]`; atomic rewrite, re-read verified). Refused (exit 1, JSON `code` on stdout) for a sealed track (`EADOPT_SEALED`), a missing one (`EADOPT_NO_TRACK`), an unreadable one (`EADOPT_UNREADABLE`), no readable session id (`EADOPT_NO_ID`), or a track whose owner process is **demonstrably still running on this host** (`EADOPT_RUNNING`) unless `--even-if-running` is given. Adopting after `/clear` (the owner process is your own) needs no override. `--session NNNN` picks the session when the letter exists in several. | rewrites that track's record + `.md`, hint |
| `--open --parallel` | "I am a **second train**": claims the next free track letter (never a sealed one; hard cap 26, `ETRACK_CAP`) in the session holding the unsealed tracks (highest if several; `--session` overrides). The new track's punchlist starts **empty**. Refused without a session id (`EPARALLEL_NO_ID`), with nothing to run alongside (`EPARALLEL_NO_TARGET`), or when you already own a track there (`EPARALLEL_ALREADY_MINE`). | creates the record, hint |
| `--open --next` | Skips the foreign refusal and opens the **next session number**, track a. Refused if you already own an unsealed track (`ENEXT_HAVE_OPEN`). The older tracks are untouched. | creates folder + record, hint |
| `--open --seal-and-new [--even-if-running]` | "Those tracks are **dead**": abandoned-seals EVERY foreign unsealed track (a `session-NNNN[-x].sealed` marker beside each record; the records are untouched, **no handoff is written for them**, who/when/their last write are recorded) and opens the **next session number**. `--even-if-running` (alias `--confirm`) is the confirmation and is **always** required, with no own-pid exemption; without it nothing is written, the tracks that would be sealed are printed (track, last write, liveness) and it exits **4** (`ESEAL_NEEDS_CONFIRM`, `details.plans`). Refused if you already own an unsealed track (`ESEAL_HAVE_OPEN`) or have no readable session id (`ESEAL_NO_ID`). Undo per track with `tpm session unseal`. | writes marker files, creates folder + record, hint |
| `--open --track <letter>` | Resume that unsealed track explicitly. The only way through when your session id is unreadable and more than one track is unsealed; with an id it will not take someone else's track (`ENOT_OWNER`; use `--adopt`). | hint |
| `--seal` | Re-derives the **hint** from the tracks. It closes the hint only when no track of any scanned session is still unsealed; otherwise `hintClosed:false` and a stderr line names the live track. Never stamps or seals a track record (that is `tpm session close`). `nothing is currently open to seal` (exit 1) only when there is no hint and no unsealed track. | writes the hint |
| `--next-number` | Prints the next allocation (highest `session-NNN(N)` folder + 1, zero-padded to four digits; surviving three-digit legacy folders still count) with **no side effect**. | none |

## Exit codes

| Code | When |
|---|---|
| `0` | The requested mode ran. |
| `1` | Error: no args; `--sessions-dir` missing; `--seal` with nothing open; an unreadable sessions directory. |
| `3` | `--open` **refused**: `ESESSION_FOREIGN_TRACK` (an unsealed track belongs to another Claude session, or is unreadable) or `ESESSION_AMBIGUOUS` (your id is unreadable and several unsealed tracks exist). stderr carries the human message; stdout carries `{ "refused": true, "code": …, "tracks": […], "skipped": […] }`. The refusal prints, per blocking track, the letter, opened and last-write times and a **same-host liveness line** — `owner process running`, `owner process gone` (pid + start time; pid reuse counts as gone), or `unknown (recorded on another host)` / `unknown (no process id recorded)` (never "gone" for another host) — plus, when the owner is your own Claude process under a new session id (a `/clear`), a line saying so as evidence for adopt. It then lists the choice flags. With no readable session id and two or more unsealed tracks the code is `ESESSION_AMBIGUOUS`. |
| `4` | `--open --seal-and-new` without `--even-if-running` (alias `--confirm`): nothing sealed, the plan is on stderr and stdout (`ESEAL_NEEDS_CONFIRM`, `details.plans[]`). |
| `1` (JSON) | A choice flag was refused (`EADOPT_*`, `EPARALLEL_*`, `ENEXT_HAVE_OPEN`, `ESEAL_HAVE_OPEN`, `ESEAL_NO_ID`, `ETRACK_CAP`, `ETRACK_ARG`, `ENO_TRACK`, `ENOT_OWNER`): stderr has the message, stdout `{ "refused": true, "code": …, "message": …, "details": … }`. Nothing was written. |

## Worked example

```
$ tpm session current --sessions-dir "$SDIR" --open
{ "number": "0001", "track": "a", "sessionId": "…", "isNew": true, "isNewSession": true, "resumed": false,
  "recordPath": ".../session-0001/session-0001.json", "pointerPath": "...", "gate": "new-session", ... }

$ tpm session current --sessions-dir "$SDIR" --open        # idempotent: same track
{ "number": "0001", "track": "a", ..., "isNew": false, "resumed": true, "gate": "resume" }

# (another Claude session, same store)
$ tpm session current --sessions-dir "$SDIR" --open
current-session: cannot open - session 0001 has an unsealed track owned by another Claude session.
  track a of 0001   owner 4ce782a5 (pid …)   opened …   last write …   [live]
            owner process running
Not joining or overwriting those tracks. Nothing was written.
Choose one and re-run `current --open` with the flag … --adopt <track> | --parallel | --next | --seal-and-new   # exit 3

$ tpm session current --sessions-dir "$SDIR" --open --parallel     # "I am a second train"
{ "number": "0001", "track": "b", ..., "gate": "parallel" }
```

## Real output (scratch store, two simulated Claude instances)

Every block below was produced by running `node tools/tpm.js session current --sessions-dir <scratch> …` with
`CLAUDE_CODE_SESSION_ID` / `CLAUDE_PID` set per process (instance A = `aaaa1111-0000`, B = `bbbb2222-0000`).

**The refusal (B opens while A's track is unsealed), exit 3:**

```
current-session: cannot open - session 0001 has an unsealed track owned by another Claude session.
  track a of 0001   owner aaaa1111 (pid 22636 on admins-Virtual-Machine.local)   opened 2026-10-07T22:55:59-07:00   last write 2026-10-07T22:55:59-07:00   [live]
            owner process running
Not joining or overwriting those tracks. Nothing was written.
Choose one and re-run `current --open` with the flag (the person decides; the tool never picks):
  --adopt <track>   that track is MINE (same train, new Claude session id, e.g. after /clear).
                    A track whose owner process is still running on this host also needs --even-if-running.
  --parallel        I am a SECOND train: claim the next free track letter in session 0001.
  --next            leave those tracks alone and open the NEXT session number.
  --seal-and-new    those tracks are DEAD: seal every foreign unsealed track (abandoned seal; no handoff is written for
                    them) and open the NEXT session number. Needs --even-if-running; without it, it prints the tracks it
                    would seal and exits 4. Show the person the evidence and get an explicit yes first.
{ "refused": true, "code": "ESESSION_FOREIGN_TRACK", "tracks": [ … ], "skipped": [] }
```

`--state` for B at the same moment prints `"state": "foreign-open"`, the track under `foreign[]` and `blocking[]`
(each with `liveness: { status: "running", line: "owner process running", sameProcessNewSession: false }`),
`"refusal": { "code": "ESESSION_FOREIGN_TRACK" }`, `"mine": []`, exit 0.

**`--parallel`** (exit 0): `"number": "0001", "track": "b", "isNew": true, "isNewSession": false, "gate": "parallel"`; files
`session-0001-b.json` + `session-0001-b.md` appear beside track a. With nothing to run alongside:
`cannot start a parallel track: no session has an unsealed track to run alongside. Use a plain --open. Nothing was written.` (`EPARALLEL_NO_TARGET`, exit 1).

**`--adopt a` on a track whose owner process is still running** (exit 1, nothing written):

```
current-session: cannot adopt: the owner process of track a of 0001 is still running on this host (pid 23240), and it is not your own process. Adopting it would take the track from a live session. If that session is truly finished or you are sure, re-run with --even-if-running. Nothing was written.
{ "refused": true, "code": "EADOPT_RUNNING", "details": { "number": "0001", "track": "a", "liveness": { "status": "running", … } } }
```

With `--even-if-running` (exit 0) the result carries `"gate": "adopt", "adopted": true, "adoptedFrom": { claudeSessionId, claudePid, hostname }`.
An unknown letter: `cannot adopt: no track q exists in the scanned sessions. Nothing was written.` (`EADOPT_NO_TRACK`, exit 1).

**`--next`** (exit 0): opens `session-0002`, track a (`"isNewSession": true`). If the caller already owns an unsealed
track: `cannot open the next session: you already own an unsealed track (track a of 0002). Close it first, or use a plain --open. Nothing was written.` (`ENEXT_HAVE_OPEN`, exit 1).

**`--seal-and-new` without confirmation** (exit 4, nothing written; `ESEAL_NEEDS_CONFIRM`):

```
current-session: --seal-and-new would seal these tracks as ABANDONED (no handoff is written for them, the owners are not asked):
  track a of 0001   owner cccc3333   last write 2026-10-07T22:56:20-07:00   unknown (no process id recorded)
  track a of 0002   owner aaaa1111   last write 2026-10-07T22:56:20-07:00   owner process running
NOTHING was sealed. Show the person this evidence; only on an explicit yes re-run with --seal-and-new --even-if-running.
```

With `--even-if-running` or its alias `--confirm` (both observed; the marker records `reason: "seal-and-new"`) the result is `"gate": "seal-and-new"`, a `sealed[]` list
(`0001/a`, `0002/a`), the new `number` `0003`, track a; a `session-0001.sealed` / `session-0002.sealed` marker now sits beside
each record (reason `seal-and-new`).

**Session id unreadable** (no `CLAUDE_CODE_SESSION_ID`): with exactly one unsealed track `--open` resumes it
(`"sessionId": null, "resumed": true, "gate": "resume"`); with two, exit 3 `ESESSION_AMBIGUOUS`:

```
current-session: cannot open - your Claude session id is unreadable and 2 unsealed track(s) exist; cannot tell which is yours.
  …
Nothing was written. Pick one explicitly with `current --open --track <letter>` (--adopt, --parallel and --seal-and-new need a readable session id).
```

`--open --track b` then resumes b (exit 0). With an id, `--track b` on someone else's track:
`track b of 0001 belongs to another Claude session (bbbb2222...); --track cannot take it. Use --adopt b if it is yours. Nothing was written.` (`ENOT_OWNER`, exit 1).

**`--seal` while another track is live** (exit 0): stderr `current-session: hint left open - track b of 0001 is still unsealed`,
stdout `{ "number": "0001", "closedAt": null, "hintClosed": false, "unsealed": [ { "number": "0001", "track": "b" } ] }`.

### How the open race is decided

Two layers: `claimSessionFolder` (non-recursive `mkdir session-NNNN`) and the exclusive create of the track record
(`link` from a prepared temp, EEXIST on a loss). The **record link is the layer that decides**; the loser re-runs the gate
and is refused (exit 3) naming the winner. Removing only the mkdir guard changes nothing observable
(`tracks-forced-order.test.js`, case F1). Likewise two `--parallel` claims racing for one letter: the loser falls
through to the next letter (case F2).

### Write verbs after you close your own track (Q-C7)

Once your own track is sealed, `tpm session current --state` reports `foreign-open` while another track of the session is live (`not-opened` when none is). While another track of the same
session is still live, a write verb run WITHOUT `--track` (e.g. `note`) no longer finds a track of yours and is refused:
``track b (bbbb2222...) of 0001 belong to another Claude session; this write was refused. Use `tpm session current --open` to choose``
(`ENOT_OWNER`, exit 1; "belong" is the tool's literal text). Passing `--track a` (your own, closed, track) works (exit 0). This
is a known rough edge, not a guarantee.

## See also

- `tools/session/lib/session-tracks.js` — naming, `trackState`, claims, the hint, write-track resolution.
- `tools/session/tpm-session-ops.md` — the write surface; write verbs act on your track (`--track <letter>` overrides).
- `tools/session/tpm-session-config.md` — resolves `--sessions-dir` for this tool.

## `--state`: the `tracks` array (info)

When the session in question (the caller's open session, or in `foreign-open` the session that blocks the open, named by
`tracksOfSession`) holds more than one track, `--state` adds `tracks`: one row per track, a..z, `{track, state, mine, owner (8 chars),
openedAt, lastWriteAt, sealedAt}` with `state` = `live` | `sealed-self` | `sealed-marker` | `unreadable` (from `trackState`, never the
record's `closedAt`). `mine` marks the caller's track. A session with a lone track a has no `tracks` key (output unchanged).
`--track <letter|claude-id>` narrows `tracks` to that row; a malformed or unknown value is an error. `tpm-session info` prints the rows.
