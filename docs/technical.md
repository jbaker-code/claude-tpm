# claude-tpm — technical details

This is the deep dive: the innards of claude-tpm for anyone who's curious how the thing actually works, not just how to run it. If you just want to install it and go, the [README](../README.md) and [`docs/INSTALL.md`](INSTALL.md) have you covered. This one is about *why* it's shaped the way it is.

Note: **Claude wrote nearly all of this code and these docs.** I'm the ideas guy: I decided what it should do and why, argued with it about the design, and drove the rounds. Claude did the typing. That's not a disclaimer I'm embarrassed about; it's kind of the whole point of a tool that turns Claude into a disciplined engineering team.

A couple of expectation-setters before the deep dive:

- **This is a personal tool, pre-1.0.** Mac-first, works-on-my-machine energy. It's a methodology I lifted out of months of real use, not a product with a support line. I haven't tested it across a matrix of operating systems, so if you're on Linux or Windows, you're a little further out on the frontier than I am.
- **Distribution is GitHub, not the npm registry.** claude-tpm installs from GitHub - as a project dependency (`npm install --save-dev github:codercowboy/claude-tpm`) or from a local clone you point at your projects. There's no published `@codercowboy/claude-tpm` on the public npm registry, so nothing below assumes you can install it from there.

---

## The 10,000-foot view

claude-tpm turns a single [Claude Code](https://claude.com/claude-code) session into a small, disciplined engineering org. One session, the **orchestrator**, plays the role of a Technical Program Manager: it takes intent from you (the product owner), decomposes the work, delegates pieces to **subagents** running in their own isolated contexts, verifies what comes back, integrates it, and reports up. The name is the role on purpose: a TPM.

The whole thing is a [Claude Code plugin](https://docs.claude.com/en/docs/claude-code/plugins) that grafts onto a project you *already have*. It doesn't scaffold a new repo. After install, a plain `claude` in your project gets the `/tpm-session`, `/tpm-task`, `/tpm-workflow` (and friends) slash commands live from message #1. Alongside the plugin ships a small, dependency-free `tpm` command-line tool that does the plumbing the skills lean on.

```mermaid
flowchart TB
  You(["You — product owner"])
  You <-->|intent, decisions| Orch

  subgraph Session["one Claude Code session"]
    Orch["Orchestrator / TPM<br/>plans · delegates · verifies · reconciles"]
  end

  Orch -->|spawns, isolated context| P["planning"]
  Orch -->|spawns| B["builder"]
  Orch -->|spawns| R["researcher"]
  Orch -->|spawns| T["test-writer"]
  Orch -->|spawns| D["documentarian"]
  Orch -->|spawns| V["verifier"]
  V -. "FAIL" .-> BF["bug-fixer"]
  BF -. "artifact re-checked" .-> V

  Orch -. "reads durable artifacts on disk" .-> FS[("dev/ work folders<br/>findings, plan.md, charters")]
  B --> FS
  V --> FS
```

The rest of this doc walks the pieces: the roles and the discipline that keeps them honest, how work flows through a round, the `tpm` CLI architecture, the module model, the plugin/marketplace mechanics, the hooks, and finally the dependency and toolkit breakdown.

---

## Components & roles

### The orchestrator (the TPM)

The orchestrator is the session you actually talk to. It's the only actor that's user-facing, so it's the only one that can be *corrected* mid-flight: you redirect it, it self-corrects. Its job is planning, delegating, reconciling, and talking to you. It does the legwork itself only for lightweight, direct work; anything that earns a formal round gets handed to subagents.

### The subagents (the workers)

Subagents run in their own isolated contexts and never see you directly. claude-tpm ships **seven subagent types**, each a distinct role:

| Type | What it does |
|---|---|
| `planning` | Formalizes the ask, surfaces risks and open questions, proposes a plan. Doesn't build. |
| `builder` | Produces the working artifact. |
| `test-writer` | Adds tests to already-delivered code. |
| `documentarian` | Adds docs to already-delivered code. |
| `verifier` | Independently inspects the artifact and returns PASS/FAIL. |
| `bug-fixer` | The loop's fixer - spawned only when a verifier fails something. |
| `researcher` | Pulls information together (recon, fact-finding), rather than building. |

The `bug-fixer` is the odd one out: it's in **no team roster**. It only exists inside the verify loop, spawned to fix whatever a verifier just failed. More on that below.

### Asymmetric trust — the design principle underneath the roles

Here's the counterintuitive part. claude-tpm trusts its actors *unequally*:

- The **orchestrator** is user-facing and self-correcting. You can see what it's doing and steer it, so its own self-verification can be light. Policing it heavily would just be friction.
- The **subagents** are user-invisible. You never watch them work. So the orchestrator keeps a critical eye on *their* output: trust-but-verify, the classic verifier pattern.

The rule of thumb: **police the orchestrator↔subagent boundary, not the user↔orchestrator one.** Verification exists because the work happened somewhere you couldn't see it.

### Charters — a per-round posture, kept secret

A **charter** is a subagent role's singular definition of "done." A round runs under exactly one of two *postures*, and the charter carries it:

- **Shipping charter** - the goal is a working artifact. Build the thing, make it run.
- **Research charter** - the goal is durable knowledge. Produce findings someone can trust later.

Exactly one charter is pasted into every round's `plan.md`. **Never both.** **A worker must never learn that the other posture exists.** That's "charter secrecy."

*Awareness is behavior.* A builder that knows "research mode" is a thing it could be in will occasionally hedge, over-document, or reach for the wrong shape of output. A worker that has only ever heard of shipping just ships. The charter registry (which postures exist, which role gets which) is orchestrator-side knowledge. The worker sees one charter and nothing else. (This is the same idea as module opacity, one level down: a posture you can't see is a posture you can't drift into.)

The eight shipped charter files live at `claude-context/methodology/workflow-setup/charters/`: one each for `planning`, `shipping`, `test-writer`, `documentarian`, `verifier`, `bug-fixer`, `research`, plus an `mvp` charter. Each well-known role ships with exactly one charter, which is why there's no "pick a charter" question at round time. The roster just displays what each role gets. If you want a lower bar for a specific round, you edit that round's *copied* charter in its work folder; the canonical file stays pristine.

### Reading lists as the single source of truth

Every actor's context is expensive, so what each actor reads is defined *once*, in a manifest, not scattered across prose that inevitably drifts. Two reading lists own it:

- **`orchestrator/reading-list.md`** - the orchestrator's session-open reading chain, including the orchestrator-only docs (the ones that carry the two-charter knowledge).
- **`subagent/reading-list.md`** - the subagent's step-zero chain: a base set plus conditional blocks per spawn flavor (resume / shipping / live-system / verifier).

The honor-system fence is the payoff: **subagents read only the subagent list.** The orchestrator list carries project-management knowledge (most importantly, that two charters exist) that would mislead a worker. It's a fence, not access control.

What keeps the fence from rotting: `tools/workflow/tpm-workflow-lint-subagent-prompt.js` **parses the subagent reading list directly.** The linter that enforces what a spawn prompt may reference reads the same manifest the humans read. Docs and enforcement literally can't drift, because they're the same file. That's the whole "single source of truth" thing made real rather than aspirational.

---

## Data flow — the round/epic lifecycle

"Just answer a question" or "make a quick edit" doesn't go through any of this. That's **low ceremony**: the orchestrator just does it. The machinery below is **triggered, not boot-default**: it fires only when a piece of work earns a formal round.

When a round *is* earned, here's the shape:

```mermaid
flowchart TD
  Start([work earns a formal round]) --> Plan["plan the round<br/>choose team + charter posture"]
  Plan --> Scaffold["scaffold work folder<br/>tpm workflow scaffold"]
  Scaffold --> Compose["compose spawn prompt<br/>tpm workflow compose"]
  Compose --> Lint["lint prompt vs. reading-list manifest<br/>tpm workflow lint"]
  Lint --> Gate{"spawn gate<br/>sign-off recorded?"}
  Gate -- "no" --> Block["blocked — no subagents spawn"]
  Gate -- "yes" --> Spawn["spawn subagent(s)"]
  Spawn --> Work["worker produces artifact on disk"]
  Work --> Verify{"verifier: PASS / FAIL?"}
  Verify -- "FAIL" --> Fix["spawn bug-fixer<br/>(loop, capped)"]
  Fix --> Verify
  Verify -- "PASS" --> Reconcile["orchestrator reconciles + reports to you"]
  Reconcile --> Done([round closed])
```

A few things worth unpacking:

**Teams are ordered rosters.** claude-tpm ships six built-in teams, and the array order *is* the run order:

| Team | Shape (run order) | When |
|---|---|---|
| `full` *(default)* | planning → builder → test-writer → documentarian → verifier | the complete separated-concerns round |
| `ship` | builder → verifier | builder wears all hats, then verify |
| `build` | builder | a quick, unverified build |
| `test` | test-writer → verifier | add tests to delivered code |
| `docs` | documentarian → verifier | add docs to delivered code |
| `research` | researcher | a one-off info-gathering pass |

Note that `research` is a standalone one-off, *not* a planner-for-a-builder. A planner structures work; a researcher pulls info together. They're different jobs and claude-tpm keeps them separate.

**The verify↔bug-fixer loop.** Any team with a verifier gets it. On a FAIL, the orchestrator spawns a `bug-fixer` (that's the `verifier.loopFixer`, default `bug-fixer`) to fix the artifact, then re-verifies. It loops until PASS or until it hits `verifyLoopCap` (default **5**). Verification is AND-semantics by default: *every* verifier must PASS or it's a kickback (`verifier.requireAllPass`).

```
   ┌─────────────┐   FAIL   ┌─────────────┐
   │  verifier   │─────────▶│  bug-fixer  │
   │ (read-only) │◀─────────│  (fixes)    │
   └──────┬──────┘  re-check└─────────────┘
          │ PASS                 ▲
          ▼                      │  bounded by verifyLoopCap (default 5)
     reconcile                   └── if the cap is hit, the loop stops and escalates
```

**The verifier can't cheat.** There's a HARD RULE, enforced in `verification.md` and the lint: a verifier inspects **only on-disk artifacts** and never touches the live system under test. It can't mutate what it's checking, which is the only way a PASS means anything. A verifier that could edit the thing it's verifying would just be a second builder.

**How work partitions - "trains."** The per-round default parallelism is `serial` (one team finishes before the next starts). The other modes are `user-dictated` (you lay out the ordering in the plan discussion) and `orchestrator-optimized` (the orchestrator schedules for throughput within the dependency graph). In real use, the shape that emerges is **parallel "trains"**: each train is one feature's pipeline of teams running *serially* (team → team → team), while multiple trains run *in parallel* with each other. Parallelism is opt-in through the plan, not something the framework forces on you.

**Standing deliverables.** A round produces a few standing outputs, all on by default: `findings/TLDR.md` (the narrative for you), `findings/tool-feedback.md` (a friction log), and `findings/wiki.md` (a long-form writeup, research charter only).

**Blocked filenames.** A subagent's `.md` deliverable name is *rejected server-side* if it matches `report`, `summary`, `analysis`, or `findings` (as a standalone deliverable name). `tools/workflow/tpm-workflow-check-filename.js` enforces it. The reason is that those generic names are what a model reaches for when it's producing filler; forcing a specific, honest filename is a nudge toward specific, honest content.

---

## The `tpm` CLI architecture

The skills are the brains; the `tpm` command-line tool is the hands. It's a Node program (the package `bin` is `tpm` → `tools/tpm.js`), and its architecture is simple.

### A simple top dispatcher → per-suite routers

`tools/tpm.js` is a **simple top dispatcher**, git-style. It knows only *suites*, not verbs. When you run `tpm <suite> <verb> [args…]`, it forwards `<suite>` plus everything after it, verbatim, to that suite's own router (`tools/<suite>/tpm-<suite>-router.js`), which owns its verb table. Adding or renaming a verb never touches `tpm.js`.

```
  npx tpm <suite> <verb> [args…]
          │
          ▼
   tools/tpm.js   ── the DUMB top dispatcher (knows SUITES only)
          │  spawnSync('node', [router, ...everything-after], {stdio:'inherit'})
          │
          ├── session   → tools/session/tpm-session-router.js   (config · current · notes · review)
          ├── task      → tools/task/tpm-task-router.js          (add · list · show · … · config)
          ├── workflow  → tools/workflow/tpm-workflow-router.js   (scaffold · compose · lint · audit · cost · signoff · doctor · …)
          ├── hooks     → tools/hooks/tpm-hooks-router.js         (gate-spawn · session-start)
          └── plugin    → tools/plugin/tpm-plugin-router.js       (install · uninstall · doctor)

   flat consumer aliases (NOT suites — they map straight to a script):
          ├── install    → tools/consumer/tpm-consumer-install.js
          ├── uninstall  → tools/consumer/tpm-consumer-uninstall.js
          └── doctor     → tools/consumer/tpm-consumer-doctor.js  (own script; `install --check` is a kept alias)
```

Dispatch happens by **child process** (`spawnSync('node', …, {stdio:'inherit'})`) with faithful argv/stdio pass-through, and the child's exit code is propagated up. Unknown command → exit 2 plus the menu; bare `tpm` or `--help` → menu, exit 0.

The five suites are `session`, `task`, `workflow`, `hooks`, and `plugin`. On top of those sit three flat, human-facing porcelain aliases (`install`, `uninstall`, `doctor`) because "graft this onto my project" and "check my install" are things a *person* types, not a suite/verb pair. `doctor` is its own script (`tpm-consumer-doctor.js`), a renderer over the same observer the installer uses; `install --check` still works as an alias.

> **A doc-map note:** there are two tool docs in the tree. `tools/README.md` is the self-titled canonical tool ledger - the exhaustive index of every tool that ships. `tools/tpm.md` is the narrower reference for the `tpm` dispatcher itself (the two-level model, the suite/verb tables, exit codes). Both cover the five suites (`session` / `task` / `workflow` / `hooks` / `plugin`) plus the `install` / `uninstall` / `doctor` aliases; **if they ever disagree, `tools/README.md` wins.**

### Concurrent writers: the store lock

Several Claude sessions can run `tpm` against one project at once, so a store that is read, modified and written
back is serialised. Every mutating `tpm task` verb (`add edit import add-subtask check start finish drop remove
reopen label unlabel remove --hard reindex`) holds a directory lock, `<tasksDir>/.lock`, taken by an atomic rename
of a prepared directory (`tools/lib/lock.js`), for its whole read-modify-write; the three index views and each
body are also written by temp-file rename, so a reader never sees a torn file. Read verbs (`list show labels
history export search doctor`) take no lock. A waiting verb prints one line after 2 s and gives up after ~45 s
(`TPM_LOCK_WAIT_MS`); a lock whose holder died, or that is older than 30 s (`TPM_LOCK_STALE_MS`), is broken loudly
and kept as `.lock.broken.*` for `tpm task doctor`. The lock directory contains its own `.gitignore` (`*`), so it
is never committed. Each write stamps `lastWriter: {version, at}` in `tasks-index.json`, which the doctor uses to
flag a store last written by an older tpm. `tpm task migrate` takes no store lock because `--out-dir` is a staging
directory; pointing it at a live store with `--force` is unsupported. Details and real output:
`tools/task/tpm-task.md`; the rule for tool authors: `claude-context/methodology/tool-conventions.md` section 7.

### Session tracks: several Claude instances, one session folder

A `session-NNNN/` folder holds one record per **track**: `session-NNNN.json` is track a (the pre-tracks name), `-b` ... `-z` are the others, each with a
derived `.md`, plus an optional `.sealed` marker. Ownership is additive `meta` (`track`, `claudeSessionId`, `claudePid`, `claudePidStartedAt`,
`hostname`, `lastWriter {version, at}`); there is no `schemaVersion` bump. "Which track is mine" is answered by `$CLAUDE_CODE_SESSION_ID`. The session
number is claimed by a non-recursive `mkdir`, and a track record by a `link` from a prepared temp (never an overwrite), so a lost race is detected and
re-gated rather than joined. `tpm session current --open` is the gate: resume your track, or refuse (exit 3, nothing written) when another session's
track is unsealed, after which a person picks `--adopt` / `--parallel` / `--next` / `--seal-and-new`. A track is sealed by its own `meta.closedAt` or by
a `.sealed` marker written by another instance (abandoned seal, exit 4 until confirmed). Canonical JSON, the derived `.md`, claims, markers and the hint
are all written atomically. Item ids are minted per track (track a `1.4`, track b `1b.4`; both forms are accepted) and slugs are unique per record only, never globally;
`punchlist close|reopen|drop` on another track's item is refused (`ECROSS_TRACK`). Reads collate the tracks through one place (`tools/session/lib/session-collate.js`): `export --style human`
is one merged document per session while JSON is one record per track (`--combine per-file` names the JSON files with the letter, the human file is a single `session-NNNN.md`),
and `boot-read` derives the pickup (a track is left out only if a later session opened strictly after it settled; a live track never settles; a tie shows the track) with no stored state.
`boot-read` exits 0 on every data problem; `--track` with no value is a usage error (exit 2). `doctor` folds a name/`meta.track` mismatch and its claim collision into one finding;
`migrate` carries the source's latest real timestamp into `handoff.updatedAt` unless `--now` is given. Reference: `tools/session/tpm-session-current.md`, `tools/session/tpm-session-ops.md`,
`claude-context/methodology/session-notes-format.md`; user-facing explanation: `user-guide.md` section 5b.

### Self-locating

Every router finds its own scripts relative to `__dirname`, so a tool never needs an environment variable to
find claude-tpm's code. The one thing a tool cannot work out alone is which *project* it serves; see
[How it fits together](#how-it-fits-together) and the [config guide](config-guide.md#which-project-a-tool-works-on).

Bundle docs referenced as `%TPM_HOME%/…` resolve against the bundle root. A reader runs `tpm resolve-home`
(an alias of `tpm home`), which prints the absolute bundle root, and `tpm doc <bundle-relative-path>` prints a
bundle doc with its in-content tokens already resolved. Both locate the bundle from the running script and
ignore the `TPM_HOME` environment variable.

---

## The module model

Capabilities in claude-tpm are **modules**, and the activation model is opt-*out*, not opt-in: everything is ON by default, and a project *disables* what it doesn't want. The documented modules:

- **`session`** - session notes + the boot ritual.
- **`workflow`** - the formal multi-agent round engine described above.
- **`tasks`** - the lightweight task ledger.
- **`hygiene`** - periodic project-wide drift sweeps. **Planned, not fully shipped.** Its config is still being finalized and no hygiene doc directory ships in the bundle yet. Don't count on it working today.
- **`motd`** - a boot greeting. Named in the design, but there's no config section or shipped implementation for it yet. Treat it as **planned**.

Config lives in one file: **`.claude/claude-tpm/config.json`**, versioned (`"version": 1`). Every module ships with sensible built-in defaults, so an *absent* config file (or an absent section) just means "use the defaults." You only add config to *change* something. (The installer writes a starter file with the default task and session folders if none exists, and never overwrites one. The full schema is documented in the [config guide](config-guide.md).)

### Module opacity

"A disabled module costs zero context" sounds like a nice-to-have. It does more than that.

Module opacity means a disabled module leaves **no residual awareness** of its concept in the orchestrator's context: not a stray mention, not a cross-reference, not a "when you're running a workflow…" aside buried in an always-loaded doc. If a project disables `workflow`, its orchestrator should operate as though formal rounds, charters, and verifiers *are not a thing that exists.*

The test is concrete: with a module OFF, walk the orchestrator's entire live reading chain. The disabled module's vocabulary ("charter," "workflow round," "verifier," "pre-task questions") should not appear *anywhere* in it. If it does, that's a leak to fix.

That test has a real design consequence: **core/shared docs must be module-agnostic.** A doc on the always-on core list may describe only module-agnostic ground: the orchestrator's identity, its read/write boundaries, shared conventions. Every reference to a specific optional module moves *into that module's own docs*, which load only when it's enabled. This is why the orchestrator handbook gets carved up: its general job description stays core, but its charter/pre-task/plan-review material moves into the `workflow` module, so a workflow-disabled orchestrator never reads the word "charter."

And the reason it matters beyond saving tokens: **awareness is behavior.** An orchestrator that *knows* charters exist reaches for them. One that has never heard of them just operates. Clutter isn't only cost, it's unwanted capability bleeding into a context that opted out.

> **A couple more planned-not-shipped references** you may spot if you read the methodology docs closely: `workflow-setup/prompt-templates/` (reusable spawn-prompt skeletons) and `docs/CONSUMER-QUICKSTART.md` are both referenced in the methodology inventory but **aren't in the shipped bundle** yet. They're aspirational pointers, not working paths. Don't follow them expecting to find something.

---

## How it fits together

This is the chain from "plugin enabled" to "a tool is working on the right project". The project root
enters at the SessionStart hook, which exports it as `TPM_PROJECT_ROOT`; the tools read it from there.

```
 you: npx tpm install .           (once per project; human, pre-install)
        │
        ▼
 plugin enabled in the project     .claude/settings.json: "enabledPlugins": { "claude-tpm@claude-tpm-market-<version>": true }
        │                          (Claude Code runs the plugin from the registered folder, in place)
        ▼
 Claude session starts ──► SessionStart hook   hooks/hooks.json → node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks session-start
        │                       writes to $CLAUDE_ENV_FILE:  TPM_PROJECT_ROOT = the project folder
        │                                                    TPM_HOME         = the claude-tpm folder (informational)
        ▼
 Claude Code puts the plugin's bin/ on PATH for every Bash call (main session and subagents)
        │
        ▼
 a skill runs bare   tpm task list
        │
        ▼
 bin/tpm  ──►  tools/tpm.js  ──►  per-suite router  ──►  tool
                                                           │
                                                           ▼
                              resolve the project root:  explicit flag
                                                          > $TPM_PROJECT_ROOT
                                                          > walk up for .claude/claude-tpm/
```

Where `npx tpm` fits: it is the human form, typed in a project shell. It runs the `tpm` bin from the
project's own `node_modules`, which is a link to (or a copy of) the same claude-tpm folder the plugin runs
from. So `npx tpm`, bare `tpm` and the hook's `${CLAUDE_PLUGIN_ROOT}` path all end at the same
`tools/tpm.js`. The three forms exist because each context has a different way to find it:

| Form | Used by | Why |
|---|---|---|
| `npx tpm …` | You, in a project shell; every pre-install step | The project's own dependency. Works before the plugin is enabled. |
| bare `tpm …` | Skills, mode files, methodology docs and tool output, all read by Claude | The plugin's `bin/` is on PATH in every Claude Bash call, even in a project with no `node_modules` copy. |
| `node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" …` | `hooks/hooks.json` | Hooks don't get the plugin's `bin/` on PATH, and Claude Code fills in `${CLAUDE_PLUGIN_ROOT}` in hook commands. |

Don't use `npx tpm` inside a Claude session. In a project with no local `node_modules/.bin/tpm`, npx
downloads an unrelated package named `tpm` and runs that.

`bin/tpm` is a small shell script that resolves its own symlinks and runs the `tools/tpm.js` beside it.

---

## Plugin + marketplace mechanics

claude-tpm installs as a Claude Code plugin, and `tpm install` wires up the chain so you don't run the
`claude plugin` commands by hand.

- The **plugin** is named `claude-tpm` (`.claude-plugin/plugin.json`). Its manifest points at the skills
  folder (`"skills": ["./.claude/skills"]`), which is how the six `tpm-*` skills become slash commands. The
  bundle-root `hooks/hooks.json` carries the plugin's two hooks.
- The **marketplace** is named for the version: `claude-tpm-market-<version>` (for example
  `claude-tpm-market-0.2.0-dev`), stamped into `.claude-plugin/marketplace.json` from `package.json` by
  `tools/build/stamp-manifests.js`. The version lives in the marketplace name, not the plugin name, so the
  skill namespace stays `claude-tpm:tpm-*` for every version, and a project enables
  `claude-tpm@claude-tpm-market-<version>` to choose which version it runs. A machine ends up with one
  registry row per installed version. Don't enable two `claude-tpm@*` plugins in one project: the first
  silently wins.
- **The registered folder is the code.** A plugin registered from a local folder runs in place from it.
  Claude Code also writes a copy under its plugin cache, but never runs it. If the folder moves, the plugin
  fails to load (Claude Code calls it "cache-miss"). The installer therefore registers its own real folder,
  never a project's `node_modules` link, so every project on a version shares one row pointing at one
  folder.
- **Scopes.** The marketplace is registered at user scope and the plugin is installed at project scope. The
  project's checked-in settings end up holding only the `enabledPlugins` line, with no machine-specific path.

The installer (`tools/consumer/tpm-consumer-install.js`) is a state reconciler, not a fixed list of steps. Three
files share the work: `tpm-consumer-observe.js` reads the machine and project into one plain-data state,
`tpm-consumer-voice.js` builds every string the user reads, and the installer, the doctor
(`tpm-consumer-doctor.js`) and the uninstaller all consume the observer instead of re-detecting anything.

```mermaid
flowchart LR
  A["observe<br/>5 layers + env<br/>(reads only)"] --> B["refuse?<br/>npm/claude, package.json,<br/>stamp, wrong copy, non-TTY"]
  B --> C["diagnose<br/>one of 7 labels"]
  C --> D["decide<br/>only if registered<br/>from another folder"]
  D --> E["plan<br/>the diff, in order"]
  E --> F["Proceed? [y/N]<br/>--plan stops here"]
  F --> G["apply<br/>run, re-observe the layer,<br/>check it"]
  G --> H["observe again<br/>closing line + Next:"]
```

The five layers it observes are: the dependency in `package.json`/`node_modules` (written by npm), the
machine-wide marketplace registration, the project's plugin record and enablement, the project's
`.claude/claude-tpm/` marker, and the installer's own folder. The plan is the difference between that state and the
target, in a fixed order: re-point, register, dependency, plugin install, plugin enable, turn off older versions,
write config. Registration comes before the dependency so a run that stops halfway never leaves the plugin on with
`npx tpm` broken. Each action is idempotent and verified after it runs, so re-running plans exactly what is left.
There is no `--force`: an action runs only when the observer said it was missing, so an "already exists" from a
child command is a real disagreement and stops the run.

Which folder becomes canonical depends on where the installer runs: from a standalone folder it links the project to
it; from a copy in the project's own `node_modules` it registers that copy; from another project's copy it refuses.
If this version is already registered from a different live folder, the one question the installer asks is
use / re-point / quit (`--share` and `--repoint` pre-answer it); a registration whose folder is gone is simply
re-pointed in the plan. [INSTALL.md](INSTALL.md) has the user-facing version;
`tools/consumer/tpm-consumer-install.md` has the maintainer version, with the scenario table.

`tpm doctor` is `observe` plus a renderer: it prints the ⚠/✗ rows with a `fix:` line and one summary (all rows under
`--verbose`), exits 1 only on ✗, and never changes anything. The SessionStart hook runs the same observer in its
file-only light mode (no `claude` spawn) and turns what it finds into at most one line for Claude; see Hooks below.

The installer never authors your project files and never edits `settings.json` itself. It writes
`.claude/claude-tpm/config.json` with the default folders if none exists.

`tpm uninstall` mirrors it and is scope-aware, because one marketplace row serves every project on that
version. *This project only* uninstalls the plugin here, drops the dependency, and removes the marketplace
row only if no other project still has the plugin installed. *The whole system* removes the row too, which
uninstalls it for every project on that version. It never deletes your files. It reads the project and the
machine through the same observer as the installer and the doctor (its `--check` flag is retired; use `tpm doctor`).

---

## Hooks

claude-tpm ships two hooks in `hooks/hooks.json`, with nothing to wire in the consumer's `settings.json`.
Each is invoked as `node "${CLAUDE_PLUGIN_ROOT}/tools/tpm.js" hooks <verb>`, a path-independent form that
works in a project with no `node_modules` copy. The `hooks` suite router passes the harness's payload,
stdout and exit code through unchanged.

- **`session-start`** (SessionStart). Appends `export TPM_PROJECT_ROOT=…` (the project, from
  `$CLAUDE_PROJECT_DIR`) and `export TPM_HOME=…` (the real path of `$CLAUDE_PLUGIN_ROOT`) to
  `$CLAUDE_ENV_FILE`. Those variables then reach every Bash call, subagents included. It skips a variable
  that is already set (so a `.claude/settings.local.json` override wins), skips lines already in the file
  (SessionStart fires again on `/compact`, `/clear` and resume), prints nothing from this part, and always
  exits 0. `TPM_HOME` is informational. It never touches PATH: Claude Code adds the plugin's `bin/` itself.
  After the exports it runs the **light health check**: the observer in file-only mode (no `claude` spawn, no full
  doctor). A healthy project prints nothing. An unhealthy one prints one `[claude-tpm]` line (at most three
  problems) that tells Claude to report them and not to repair anything. It is gated by
  `hygiene.healthCheck.enabled` in `.claude/claude-tpm/config.json` (default on; only an explicit `false` silences
  it), fires on every session `source`, is isolated from the exports so a failure in one never costs the other, and
  stays silent for a folder with no `package.json`. See [config-guide.md](config-guide.md#4-hygiene-config).
- **`gate-spawn`** (PreToolUse, matches `Agent|Task`). The spawn gate: it blocks a marked subagent spawn that
  fails the sign-off check. This is the enforcement behind "you can't fire off a formal round without the
  recorded two-token sign-off". It reads the sign-off ledger (`tpm-workflow-signoff.js`). Script:
  `tools/workflow/hooks/tpm-workflow-gate-spawn.js`.

The older `%TPM_HOME%` token-rewriting hooks were retired in #1126. Bundle docs resolve through
`tpm resolve-home` and `tpm doc` instead (see [Self-locating](#self-locating)).

---

## Dependency breakdown

### Packaged (npm) dependencies: none

**claude-tpm has zero npm dependencies.** The `package.json` declares **no `dependencies` field and no `devDependencies` field at all.** There is nothing to `npm install` transitively, nothing to audit for CVEs, no supply chain to reason about. The tool suites are written to run under a bare `node` with only Node's standard library.

That's a real feature, not an accident. Every dependency you *don't* take is a dependency that can't get compromised, abandoned, or wedged against a future Node version. For a tool whose entire job is to be trustworthy plumbing under your engineering process, "no supply chain to audit" is the property you want.

### Hard platform / engine requirements

"No npm deps" is *not* "no requirements." claude-tpm cannot function without the following, none of which show up in any package manifest, so know what you need before you start:

- **[Node.js](https://nodejs.org) + [npm](https://www.npmjs.com/)** - the `tpm` CLI is a Node program (`bin` = `tools/tpm.js`), and install drives `npm`. Both need to be on your PATH. *No minimum Node version is pinned*: there's no `engines` field and no floor declared anywhere, so I won't assert one.
- **The [Claude Code](https://claude.com/claude-code) CLI** - the whole thing rides on it. claude-tpm *is* a Claude Code plugin; without the `claude` command on your PATH there is nothing to plug into.
- **An existing project with a `package.json`** - claude-tpm grafts onto a project you already have; it won't create one. If you don't have one, `npm init -y` first.
- **A way to get the bundle** - you install from GitHub, either as a project dependency (`npm install --save-dev github:codercowboy/claude-tpm`, then `npx tpm install .`) or from a central folder you point at your projects (`cd claude-tpm && npx tpm install ../my-project`). There's no npm-registry package. See [`INSTALL.md`](INSTALL.md) for both routes.

Platform-wise: it's **Mac-first with works-on-my-machine energy.** I haven't done a real cross-platform test pass, so I'm not going to claim tested Linux/Windows support. The code is plain Node with no obvious OS-specific tricks, so it *should* travel, but "should" is doing real work in that sentence.

---

## Built with

The dev/authoring toolkit, distinct from the runtime requirements above. These are the things *I* (and Claude) used to build it, not things you need to run it:

- **[VS Code](https://code.visualstudio.com)** — the editor.
- **[Node.js](https://nodejs.org)** — the runtime everything is written in. The test suite is plain `node --test` (run via `node tools/tests/run-all.js`), so there's no test framework to install.
- **[Claude Code](https://claude.com/claude-code)** — claude-tpm was built with Claude Code, and it's what claude-tpm plugs into. Fully dogfooded.
- **[git](https://git-scm.com)** — version control.
- **[npm](https://www.npmjs.com/)** — packaging and distribution (claude-tpm installs as an optional dependency and enables as a Claude Code plugin).