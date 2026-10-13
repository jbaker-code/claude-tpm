#!/usr/bin/env node
'use strict';
/**
 * tpm-session-router.js — the `session` sub-router for the `tpm` dispatcher.
 *
 * PURPOSE
 *   `tpm session <verb> [args…]` dispatches to the matching session tool script. This router OWNS the
 *   session verb table; the top-level `tpm.js` is deliberately dumb about verbs and just forwards
 *   `session <anything…>` here (see tools/tpm.js). Verbs are SHORT — the `session` suite name already
 *   namespaces them.
 *
 *   The JSON-first session tooling (#1113) is four node-invokable scripts; this router is the ONE `bin`
 *   seam over them. Most entry scripts own their OWN subcommands/flags, so everything after the verb token
 *   passes straight through. The ONE exception is `tpm-session-ops.js`: its sub-verbs (open/save/note/
 *   punchlist/close/import-*) are PROMOTED to TOP-LEVEL session verbs here — the router re-injects the
 *   matched verb as argv[0] to the ops tool (`tpm session open …` ≡ `tpm-session-ops.js open …`). The old
 *   `ops` GROUPING was removed (a tool boundary leaking into the surface; the task suite has no `task ops`).
 *   Clean break — a bare `ops` token is now an unknown verb that hints at the flattened form.
 *
 *   Sibling scripts resolve against THIS file's own directory (`__dirname`), so nothing here depends on
 *   an absolute bundle path or any env var. Dispatch is by CHILD PROCESS
 *   (`spawnSync('node', [tool, …args], {stdio:'inherit'})`) — process isolation + faithful argv/stdio
 *   pass-through; the child's exit code is propagated.
 *
 * USAGE
 *   tpm session <open|save|note|punchlist|close|import-handoff|import-log|import-punchlist> [args…]
 *   tpm session <export|review|migrate|doctor|config|current|boot-read|compose> [args…]
 *   tpm session --help | -h
 *
 * Zero third-party deps; Node built-ins only.
 */

const path = require('path');
const { spawnSync } = require('child_process');

// short verb -> sibling script (in this same dir). Self-contained; no shared imports.
const VERBS = {
  // ── ops sub-verbs, PROMOTED to top-level (flatten: the `ops` grouping was removed) ──
  //    each dispatches to tpm-session-ops.js with the verb re-injected as argv[0] (see OPS_VERBS).
  open: 'tpm-session-ops.js',
  save: 'tpm-session-ops.js',
  note: 'tpm-session-ops.js',
  punchlist: 'tpm-session-ops.js',
  close: 'tpm-session-ops.js',
  unseal: 'tpm-session-ops.js',
  'import-handoff': 'tpm-session-ops.js',
  'import-log': 'tpm-session-ops.js',
  'import-punchlist': 'tpm-session-ops.js',
  // ── the rest: each entry script owns its own subcommands/flags (pure pass-through) ──
  export: 'tpm-session-export.js',    // #1092 export: single/multi · JSON/human
  review: 'tpm-session-export.js',    // read-back alias → export with --style human by default (smoke #24: everyone types `review`)
  migrate: 'tpm-session-migrate.js',  // #1114 opt-in old 3-file markdown -> canonical JSON
  doctor: 'tpm-session-doctor.js',    // #1119 READ-ONLY validate + hash-drift + detect/suggest-migrate
  config: 'tpm-session-config.js',    // #1123 restored: session config resolver (--json/--get/--sessions-dir/--modules)
  current: 'tpm-session-current.js',  // #1123 restored: current-session pointer (--state/--open/--seal/--next-number)
  'boot-read': 'tpm-session-boot-read.js', // #1123 reworked: JSON-first boot pickup emitter (exit 0 for any valid invocation; malformed usage e.g. --track with no value exits 2)
  compose: 'tpm-session-compose.js',  // #1155 the tpm-session composer: --mode open|save|close|info (read-only, always exit 0)
};

// The promoted ops sub-verbs (flatten): the router injects the matched verb as argv[0] to the ops tool
// (mirror of how `review` injects `--style human`). tpm-session-ops.js still parses `<subverb> …`.
const OPS_VERBS = new Set([
  'open', 'save', 'note', 'punchlist', 'close', 'unseal',
  'import-handoff', 'import-log', 'import-punchlist',
]);

function help() {
  console.log(`tpm session — JSON-first session-notes tooling router

Usage:
  tpm session <verb> [args…]

Notes-write verbs (promoted from the removed 'ops' grouping — call them directly):
  open       mint a fresh session record (--session-id … [--prior-session-path <json>])
  save       re-persist the current session (re-stamp handoff.updatedAt, regenerate the .md)
  note       append ONE log entry (--log --status TAG --text "…" | --decision --what "…" --why "…")
  punchlist  add/close/reopen/drop/carry-in a work item (--action …)
  close      seal YOUR track (REFUSES unless a handoff AND a punchlist are both present); with --track <other letter> --even-if-running, the abandoned seal of a dead instance's track
  unseal     undo another instance's seal of a track (--session NNNN --track x); ask the person first
  import-handoff   REPLACE the handoff from a file (--json-file <f> | --txt-file/--file <f> --next "…")
  import-log       APPEND a log addendum from a file (--txt-file/--file <f>)
  import-punchlist ADD punchlist items from a file (--file/--txt-file <f>)

Other verbs:
  export     export sessions (single/multi · --style json|human|both · --last N | --session NNNN)
  review     read a session back — alias for 'export --style human' (--last N | --session NNNN)
  migrate    #1114 opt-in convert ONE old 3-file markdown session -> canonical JSON (--in / --out-dir)
  doctor     #1119 READ-ONLY health check: validate + hash-drift + detect/suggest-migrate (--sessions-dir)
  config     session config resolver (--json / --get <k> / --sessions-dir / --modules)
  current    current-session pointer (--state / --open / --seal / --next-number · --sessions-dir)
  boot-read  JSON-first boot pickup emitter — prior handoff + open punchlist (exits 0 for any valid invocation, corrupt store included; --track with no value exits 2)
  compose    compose the tpm-session procedure for a mode (--mode open|save|close|info|auto; read-only, always exits 0)

Session numbers are ALWAYS 4-digit zero-padded (--session 1 ≡ --session 0001; folder + meta agree).
Remaining args pass straight through, e.g.:
  tpm session open --sessions-dir .claude/claude-tpm/sessions --session 0043 --session-id abc
  tpm session export --sessions-dir .claude/claude-tpm/sessions --last 3 --style human
  tpm session doctor --sessions-dir .claude/claude-tpm/sessions
  tpm session config --sessions-dir
  tpm session boot-read --sessions-dir .claude/claude-tpm/sessions`);
}

function main(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    help();
    return 0;
  }

  const verb = args[0];
  const rel = VERBS[verb];
  if (!rel) {
    process.stderr.write(`tpm session: unknown verb '${verb}'.\n`);
    if (verb === 'ops') {
      // FLATTEN clean break: the `ops` grouping was removed; its verbs are now top-level.
      process.stderr.write(
        "  note: the 'ops' grouping was removed — its sub-verbs are now top-level session verbs.\n" +
        '        Use `tpm session <verb>` directly, e.g. `tpm session open …`, `tpm session note …`,\n' +
        '        `tpm session punchlist …`, `tpm session close …`, `tpm session import-handoff …`.\n',
      );
    }
    process.stderr.write('\n');
    help();
    return 2;
  }

  let passthru = args.slice(1);
  // `review` is a read-back alias for `export --style human` (smoke #24: every agent reaches for `review`).
  // Default to human style unless the caller passed their own --style.
  if (verb === 'review' && !passthru.includes('--style')) {
    passthru = ['--style', 'human', ...passthru];
  }
  // FLATTEN: promoted ops sub-verbs dispatch to tpm-session-ops.js with the sub-verb re-injected as
  // argv[0] (the ops tool still parses `<subverb> …`) — the same injection trick `review` uses above.
  if (OPS_VERBS.has(verb)) {
    passthru = [verb, ...passthru];
  }

  const tool = path.join(__dirname, rel);
  const r = spawnSync('node', [tool, ...passthru], { stdio: 'inherit' });
  if (r.error) {
    process.stderr.write(`tpm session: failed to run '${verb}': ${r.error.message}\n`);
    return 1;
  }
  return r.status == null ? 1 : r.status; // propagate child exit (null => killed by signal)
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { main, VERBS, OPS_VERBS };
