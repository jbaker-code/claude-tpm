# `tpm-session-boot-read.js`

> Commands below use bare `tpm` (on `PATH` in a Claude session).
>
> Human terminal: outside a Claude session, run the same commands as `npx tpm …` from the project.

The boot-time pickup emitter, reworked for the JSON-first note format (#1123 Stage C). A
**pure-read** verb whose stdout **is** the boot pickup payload — `session open` (the `tpm-session`
skill's boot ritual) runs it so prior state enters context via a tool call, not by the model
choosing to open a file.

## What it emits

For every **pending track of the PRIOR session(s)** (never a session this Claude instance owns):

- the track's **HANDOFF** (where / next / in flight / must-not-redo), verbatim, rendered from the
  canonical record via `lib/session-model.loadSession`;
- the still-**OPEN** punchlist items, HEADLINES ONLY (`#id · text  [slug]`) — done/dropped items omitted;
- the file locations of the track's canonical JSON + derived `.md`;
- a pointer to the derived `.md` and to `tpm session export … --style human` for the full log + detail.

### The pickup rule (derived, nothing is stored)

A session folder can hold several parallel **tracks** (a..z), one per Claude instance, and they seal at
different times. A track is **picked up** — and left out of the pickup — iff a later session `J`
(`K < J < N`, `N` = the session the caller owns) **opened strictly after the track settled**. A track settles
when it was sealed (by its owner, or by another instance's seal marker), or — for a legacy record that was
never closed — at its last write. A **live** track never settles, so it is always shown. A tie counts as *not*
picked up: a duplicate show is harmless, a hidden handoff is not. Nothing is written anywhere: the
rule is recomputed from the records' timestamps on every call (`pickupSet`, pure; `computePickup`).
Sealed-ness comes ONLY from `trackState()` — a track sealed by another instance's marker still has a record
whose `.md` says "open".

### Layouts

- **Single** — exactly one pending track and it is track a of a session that holds only track a: the
  output is byte-identical to every earlier version (pinned by `tests/session-boot-pin.test.js`). One
  exception, for honesty: a lone track a that another instance sealed by marker gets a `note:` line above the pickup.
- **Per-track** — otherwise: a header per session (`== PRIOR SESSION 0001 · <folder>/ · 3 parallel tracks ==`, naming
  tracks already picked up), then one block per track, newest session first, tracks a..z:
  `=== TRACK b · SEALED AS ABANDONED <time> by claude dddddddd (abandoned, "owner window closed"); no final handoff was written ===`
  / `SEALED by its owner <time>` / `STILL LIVE (handoff may not be final); last save <time>; <liveness>` /
  `LEFT OPEN (never closed; superseded by a later session)`; its files (a marker-sealed track warns that its `.md`
  banner may still say "open"), its handoff (`LAST-SAVED HANDOFF (not a final handoff)` for a marker-sealed or
  left-open track), its open items (ids shown with the track letter, `#1a.2`), a per-track export hint. Then
  `== OPEN PUNCHLIST, ALL TRACKS ABOVE (N) ==` — one combined, ordered list tagged `[track b]` / `[track c, live]`.
  A track whose record cannot be read is a `=== TRACK b · UNREADABLE (corrupt) ===` block saying *read this file
  directly*; the other tracks still print. The repetition is generated in code (the template engine has no loop).

### Reader honesty

- Only a session the caller **demonstrably owns** is excluded. If the open gate would "resume" a record the caller
  does not own (no readable Claude session id, or an unowned record), nothing is excluded and a `note:` says so —
  never "this looks like the first session" over a live record.
- Stray files that look like mis-named track records (`*.json`, anything containing `.sealed`) and hollow NEWER session
  folders are surfaced in a `note:`; `session-notes.md`-style strays are not.
- Records that could not be read are listed, never silently dropped.

## Format (the rework)

The notes are now **ONE canonical `session-NNNN.json`** plus **ONE derived `session-NNNN.md`**
(with `## Handoff` / `## Punchlist` / `## Log` sections), nested under
`<sessionsDir>/session-NNNN/`. The OLD boot-read parsed the retired three-file `.md` layout
(`-handoff.md` / `-punchlist.md` / `-log.md`); this version reads the canonical JSON through the
session model (`read → migrate → validate`) instead — no dependence on the old markdown parser or its
v1.0 sentinel. The migrate step **refuses an unknown-NEWER `schemaVersion`**, so a session written by
a newer tool is skipped (never mis-read), not crashed on.

## Contract — never crashes boot

Exits **0 for every data problem**: no prior session, an unreadable dir, or a corrupt / unknown-newer / partial
prior JSON (that folder or track is skipped and listed). Side-effect-free (reads only). Any such failure degrades to a clean
message + exit 0. The one exception is a malformed **command line**: `--track` with no value exits **2** (below).

## Sessions dir

`--sessions-dir <dir>` if given (used by tests + explicit callers). Otherwise resolved from the
session config — the same value `tpm session config --sessions-dir` prints — best-effort; a
resolution failure degrades to a clean message + exit 0.

## CLI

```
tpm session boot-read [--sessions-dir <dir>] [--track <letter|claude-id-prefix>]
tpm session boot-read --help
```

`--track` narrows the pickup to one track (a letter, or the first 8+ characters of its owner's Claude session id).
A malformed selector (e.g. `--track zz`) is ignored with a `note:`; one that matches nothing prints a clear message; both exit 0.

`--track` with **no value** - at the end of the arguments, or followed by another flag - is a usage error: nothing is read, stdout is
empty, and stderr says (exit **2**):

```
$ tpm session boot-read --sessions-dir <dir> --track
boot-read: --track needs a value (a track letter a-z, or a Claude session id prefix of at least 8 characters). usage: tpm session boot-read [--sessions-dir <dir>] [--track <letter|claude-id-prefix>]
$ echo $?
2
```

(`--track --sessions-dir <dir>` gives the same error rather than reading the next flag as the selector.) `--track a` on a three-track
session prints only the track-a block and exits 0.

### Example

```
$ tpm session boot-read --sessions-dir .claude/claude-tpm/sessions
== PRIOR SESSION 0022 · …/session-0022/ ==
files: …/session-0022.json · …/session-0022.md   (canonical JSON + derived .md; the log reads newest-first)
--- HANDOFF (read fully) ---
**Where we are:**
…
**Next:**
…
--- OPEN PUNCHLIST (2) ---
#22.3 · wire the export pointer  [a1b2c3]
#22.4 · rerun both suites  [d4e5f6]
for full detail: read …/session-0022.md (## Punchlist / ## Log), or run: tpm session export …
```
