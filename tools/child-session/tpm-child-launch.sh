#!/usr/bin/env bash
# tpm-child-launch.sh — Orchestrator-owned launcher for a child Claude session.
#
# Design (option A, symlink-free for cross-platform portability):
#   - The ORCHESTRATOR (claude-tpm) owns everything under this repo's
#     tmp/sessions/<session-name>/ : the vendored methodology the child reads
#     (claude-tpm/BOOT.md + ...) AND a session.json descriptor (pid, start,
#     end, status, transcript path, vendor hash).
#   - The CHILD project stays pristine: a hidden .claude-tpm/config.json
#     pointer (rewritten every launch — option A, no symlinks) + one bootstrap
#     line in its CLAUDE.md.
#   - The child is granted read access to ONLY its session folder via --add-dir.
#
# Usage:
#   tpm-child-launch.sh <child-project-dir> --headless "<prompt>"
#   tpm-child-launch.sh <child-project-dir> --interactive        # remote-control, you drive
#   tpm-child-launch.sh <child-project-dir> --print-cmd          # just print the interactive cmd
#
set -euo pipefail

# --- CRITICAL: keep the child's transcript on disk. ---
# A child launched from an orchestrator's Claude Code session INHERITS the
# CLAUDE_CODE_CHILD_SESSION env marker, which DISABLES interactive transcript
# saving (Claude Code prints "Transcript saving is off — inherited
# CLAUDE_CODE_CHILD_SESSION marker"). Forcing persistence overrides that, so an
# interactive / Remote-Control child writes its transcript to
# ~/.claude/projects/<esc-cwd>/<sessionId>.jsonl like any normal session.
#
# Verified 2026-08-26: this single flag is what makes an orchestrator-launched,
# DETACHED-screen, Remote-Control child log. The earlier "needs an attached
# terminal / bridge-only can't log" theory was a MISDIAGNOSIS — attachment is
# irrelevant; the inherited marker was the whole cause.
export CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1

# --- locate this repo (claude-tpm) root: the dir two levels up from this script ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADMIN_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# --- attribution: tell the child which tpm session LAUNCHED it (informational only) ---
# TPM_SESSION_ID is set in the child env to the launching session (stored form, e.g. session-0012b),
# resolved with the SHARED resolver (tools/lib/attribution.js). Skipped when the caller already exported one;
# nothing is set (and nothing printed) when no session resolves. Never fails the launch.
# KNOWN LIMITATION (#1175 coupling): TPM_SESSION_ID names a session NUMBER, not a store. It is correct only
# while the child writes the PARENT's store (true today via the #1175 TPM_PROJECT_ROOT leak); once #1175 is
# fixed, a child writing its OWN store would mis-stamp. Do not "fix" that here.
# What the child sees: `--headless` exports TPM_SESSION_ID before `claude -p` runs; `--interactive` puts it inline in
# the launched command (`TPM_SESSION_ID='session-0012b' claude --remote-control ...`), and so does `--print-cmd`, so you can
# check it without launching. A caller-exported TPM_SESSION_ID is kept verbatim. The child's tpm tools then stamp it as
# `sessionVia: "env"` (see tools/task/tpm-task.md "Session attribution"). Only `--print-cmd` has been checked end to end;
# a real headless / interactive child run has not.
CHILD_SESSION_ATTR=""
if [ -z "${TPM_SESSION_ID:-}" ]; then
  CHILD_SESSION_ATTR="$(node -e 'try{const a=require(process.argv[1]);const r=a.toEventFields(a.resolveAttribution());process.stdout.write(r.session||"")}catch(e){}' "$ADMIN_ROOT/tools/lib/attribution.js" 2>/dev/null || true)"
  case "$CHILD_SESSION_ATTR" in session-[0-9]*) export TPM_SESSION_ID="$CHILD_SESSION_ATTR" ;; *) CHILD_SESSION_ATTR="" ;; esac
fi

# --- args ---
CHILD_DIR="${1:-}"; shift || true
MODE=""; PROMPT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --headless)    MODE="headless"; PROMPT="${2:-}"; shift 2 ;;
    --interactive) MODE="interactive"; shift ;;
    --print-cmd)   MODE="print-cmd"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$CHILD_DIR" ] || { echo "usage: tpm-child-launch.sh <child-project-dir> --headless \"<prompt>\" | --interactive | --print-cmd" >&2; exit 2; }
[ -d "$CHILD_DIR" ] || { echo "child dir not found: $CHILD_DIR" >&2; exit 2; }
MODE="${MODE:-print-cmd}"
CHILD_DIR="$(cd "$CHILD_DIR" && pwd)"   # absolutize

# --- slugify the child project folder name + append a random 6-char slug ---
slugify() { printf '%s' "$1" | LC_ALL=C tr '[:upper:]' '[:lower:]' \
  | LC_ALL=C sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g'; }
PROJ_SLUG="$(slugify "$(basename "$CHILD_DIR")")"
# random 6-char slug; disable pipefail locally so head-closes-pipe SIGPIPE (141) doesn't abort
rand6() { set +o pipefail; LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c6; set -o pipefail; }
RAND="$(rand6)"
SESSION_NAME="${PROJ_SLUG}-${RAND}"

# --- pre-assign the child's session UUID so we know its transcript path up front ---
CHILD_UUID="$(uuidgen | LC_ALL=C tr '[:upper:]' '[:lower:]')"
# Claude stores transcripts under an escaped-cwd dir: leading '/' + each '/' -> '-'
ESCAPED_CWD="$(printf '%s' "$CHILD_DIR" | LC_ALL=C sed -E 's#[^a-zA-Z0-9]#-#g')"
CHILD_TRANSCRIPT="$HOME/.claude/projects/${ESCAPED_CWD}/${CHILD_UUID}.jsonl"

# --- orchestrator-owned session folder (I own this; safe to sweep once ended) ---
SESS_DIR="$ADMIN_ROOT/tmp/sessions/$SESSION_NAME"
VENDOR_DIR="$SESS_DIR/claude-tpm"
mkdir -p "$VENDOR_DIR"

now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# --- vendor the child-facing bootstrap (prototype: BOOT.md only; full methodology later) ---
cat > "$VENDOR_DIR/BOOT.md" <<EOF
# Child bootstrap — managed by claude-tpm

You are a **child Claude** launched and supervised by a claude-tpm orchestrator.
This folder was vendored fresh for THIS session ($SESSION_NAME) and is read-only
to you. Do not attempt to manage the orchestrator or edit anything outside your
own project directory.

- Your session name: $SESSION_NAME
- Vendored at: $(now)
- (Full worker-facing methodology + skills will be vendored here in later versions.)

Read this file first, then proceed with the task your orchestrator gave you.
EOF

# checksum the vendored tree (drift detection between sessions)
VENDOR_SHA="$( (cd "$VENDOR_DIR" && find . -type f -exec shasum -a 256 {} \; | LC_ALL=C sort | shasum -a 256 | awk '{print $1}') )"

# --- write the child's pristine pointer (option A: rewrite every launch) ---
CHILD_CFG_DIR="$CHILD_DIR/.claude-tpm"
mkdir -p "$CHILD_CFG_DIR"
cat > "$CHILD_CFG_DIR/config.json" <<EOF
{
  "boot": "$VENDOR_DIR/BOOT.md",
  "session_name": "$SESSION_NAME",
  "vendor_sha256": "$VENDOR_SHA",
  "managed_by": "claude-tpm",
  "written_at": "$(now)"
}
EOF

# --- ensure the child's CLAUDE.md carries the one bootstrap line ---
CHILD_CLAUDE="$CHILD_DIR/CLAUDE.md"
BOOT_LINE='If a `.claude-tpm/` folder exists in this project, read the file named by `.claude-tpm/config.json` `boot` FIRST, before anything else — it is your claude-tpm bootstrap.'
if [ ! -f "$CHILD_CLAUDE" ] || ! grep -qF '.claude-tpm/config.json' "$CHILD_CLAUDE"; then
  { echo ""; echo "<!-- claude-tpm:bootstrap -->"; echo "$BOOT_LINE"; } >> "$CHILD_CLAUDE"
  BOOT_LINE_ADDED="yes"
else
  BOOT_LINE_ADDED="already-present"
fi

# --- write the session descriptor ---
write_descriptor() { # status pid ended result
  cat > "$SESS_DIR/session.json" <<EOF
{
  "session_name": "$SESSION_NAME",
  "mode": "$MODE",
  "child_project_dir": "$CHILD_DIR",
  "child_project_slug": "$PROJ_SLUG",
  "slug": "$RAND",
  "child_session_uuid": "$CHILD_UUID",
  "child_transcript_path": "$CHILD_TRANSCRIPT",
  "vendor_dir": "$VENDOR_DIR",
  "vendor_sha256": "$VENDOR_SHA",
  "boot_line": "$BOOT_LINE_ADDED",
  "created_at": "${CREATED_AT:-$(now)}",
  "status": "${1:-provisioning}",
  "pid": ${2:-null},
  "ended_at": ${3:-null},
  "result": ${4:-null}
}
EOF
}
CREATED_AT="$(now)"
write_descriptor "provisioning" "null" "null" "null"

echo "=== session provisioned ==="
echo "  session name : $SESSION_NAME"
echo "  owned folder : $SESS_DIR"
echo "  child pointer: $CHILD_CFG_DIR/config.json"
echo "  boot line    : $BOOT_LINE_ADDED"
echo "  transcript   : $CHILD_TRANSCRIPT"
echo

case "$MODE" in
  headless)
    write_descriptor "running" "$$" "null" "null"
    set +e
    ( cd "$CHILD_DIR" && claude -p "$PROMPT" \
        --session-id "$CHILD_UUID" \
        --add-dir "$SESS_DIR" \
        --dangerously-skip-permissions \
        --output-format json ) > "$SESS_DIR/child-result.json" 2> "$SESS_DIR/child-run.err"
    RC=$?
    set -e
    if [ $RC -eq 0 ]; then
      RESULT_JSON="$(python3 -c 'import json,sys;print(json.dumps(json.load(open(sys.argv[1])).get("result","")))' "$SESS_DIR/child-result.json" 2>/dev/null || echo 'null')"
      write_descriptor "completed" "null" "\"$(now)\"" "$RESULT_JSON"
      echo "=== child completed (rc=0) ==="
    else
      write_descriptor "failed" "null" "\"$(now)\"" "null"
      echo "=== child FAILED (rc=$RC) — see $SESS_DIR/child-run.err ===" >&2
    fi
    echo "  descriptor : $SESS_DIR/session.json"
    ;;
  interactive)
    # Interactive + Remote Control: you drive it from your phone. An interactive
    # claude needs a live PTY, so we park it in a DETACHED `screen` session that
    # persists independently of this launcher. When claude exits (you quit from
    # the phone), the trailing command writes an exit sentinel the reaper watches.
    command -v screen >/dev/null 2>&1 || { echo "screen not found — needed for --interactive" >&2; exit 3; }
    SENTINEL="$SESS_DIR/.child-exited"
    rm -f "$SENTINEL"
    # NOTE: do NOT pass --session-id here. --session-id + --remote-control keeps the
    # session out of the transcript-writing path (verified: no <pid>.json, no jsonl).
    # Instead we let Claude assign the sessionId and discover it from <pid>.json below.
    # CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 is exported at the top of this script
    # (covers this screen too); re-stated inline here so the transcript-saving fix
    # is visible at the exact launch point even if a login shell reset the env.
    INNER="cd \"$CHILD_DIR\" && CLAUDE_CODE_FORCE_SESSION_PERSISTENCE=1 ${TPM_SESSION_ID:+TPM_SESSION_ID=\"$TPM_SESSION_ID\" }claude --remote-control \"$SESSION_NAME\" --name \"$SESSION_NAME\" --add-dir \"$SESS_DIR\"; echo \"exit=\$? at \$(date -u +%Y-%m-%dT%H:%M:%SZ)\" > \"$SENTINEL\""
    screen -dmS "$SESSION_NAME" bash -lc "$INNER"
    sleep 1
    CHILD_PID="$(pgrep -f "remote-control $SESSION_NAME" | head -1 || true)"
    # Resolve the REAL sessionId Claude assigned, via ~/.claude/sessions/<pid>.json,
    # then recompute the transcript path from it (pid -> sessionId -> jsonl).
    REAL_SID=""; SJSON="$HOME/.claude/sessions/${CHILD_PID}.json"
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      if [ -n "$CHILD_PID" ] && [ -f "$SJSON" ]; then
        REAL_SID="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("sessionId",""))' "$SJSON" 2>/dev/null || true)"
        [ -n "$REAL_SID" ] && break
      fi
      sleep 1
    done
    if [ -n "$REAL_SID" ]; then
      CHILD_UUID="$REAL_SID"
      CHILD_TRANSCRIPT="$HOME/.claude/projects/${ESCAPED_CWD}/${REAL_SID}.jsonl"
    else
      CHILD_UUID=""; CHILD_TRANSCRIPT=""   # unresolved; session.json record didn't appear
    fi
    write_descriptor "running" "${CHILD_PID:-null}" "null" "null"
    echo "=== interactive child launched in screen '$SESSION_NAME' (pid ${CHILD_PID:-?}) ==="
    echo "  Remote Control name: $SESSION_NAME — attach from your phone's session list."
    echo "  resolved sessionId : ${REAL_SID:-<unresolved — check ~/.claude/sessions/${CHILD_PID}.json>}"
    echo "  transcript         : ${CHILD_TRANSCRIPT:-<unknown>}"
    echo "  reap when you exit : bash '$SCRIPT_DIR/tpm-child-reap.sh' '$SESS_DIR'"
    ;;
  print-cmd)
    echo "=== interactive remote-control command (run yourself, or --interactive to launch) ==="
    echo "cd '$CHILD_DIR' && ${TPM_SESSION_ID:+TPM_SESSION_ID='$TPM_SESSION_ID' }claude --remote-control '$SESSION_NAME' --name '$SESSION_NAME' --session-id '$CHILD_UUID' --add-dir '$SESS_DIR'"
    ;;
esac
