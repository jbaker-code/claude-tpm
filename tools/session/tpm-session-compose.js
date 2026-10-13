#!/usr/bin/env node
/**
 * tpm-session-compose.js — the tpm-session COMPOSER (#1155 session half; folds #1153 prose + #1154
 * reading-list pointers in as engine features).
 *
 * PURPOSE
 *   `.claude/skills/tpm-session/SKILL.md` is a tiny skeleton. Its PRIMARY, always-correct path is Claude
 *   running `tpm session compose --mode <mode>` as an ordinary tool call; the skill's `!`-pre-inject of the
 *   same command is BEST-EFFORT only (unreliable under normal permissions — skill-expansion-probe.md).
 *   This verb picks the mode, builds the slots, renders the mode's template through the template engine
 *   (tools/lib/tpm-template.js — consumed, never edited here) and prints the composed procedure.
 *
 * READ-ONLY. It never allocates a session, never writes. (Allocation stays an instruction the model runs:
 *   `tpm session current --open`.) A double run is therefore harmless.
 *
 * ALWAYS EXITS 0 and ALWAYS prints a usable procedure: any internal failure prints EMERGENCY_BOOT, a literal
 *   hard-coded procedure, so boot never depends on template resolution.
 *
 * CLI
 *   tpm session compose --mode <open|save|close|info|auto|<alias>> [free text…]
 *   tpm session compose --help
 *   --mode takes the user's whole argument string (forgiving: aliases, misspellings; empty/auto = state-aware).
 *
 * PRECEDENCE LADDER (per mode M; engine supplies only `tpm:if` / `tpm:inject`)
 *   1. TEMPLATE  session.templates.M (path) wholesale-overrides the shipped tools/session/templates/M.md;
 *      a missing/unreadable override falls back to the shipped one + warning `template-override-missing`.
 *   2. PROSE     session.proseInjections entries with mode===M build slot `prose` (config order).
 *   3. MARKER    a `tpm:inject prose` marker in the active template places ALL prose there (location ignored).
 *   4. WRAP      else location:'before' entries are prepended and 'after' appended around the body.
 *   5. GATING    `tpm:if` regions inside the template; flags resolve through resolveLayers (defaults -> project
 *                -> user). An override template does NOT suppress proseInjections (rules 2-4 still apply).
 *
 * API
 *   compose(modeArg, ctx?) -> { text, mode, kind, warnings[], emergency }
 *   normalizeMode(arg) -> { kind: 'mode'|'auto'|'reap'|'ambiguous', mode?, echo? }
 *   EMERGENCY_BOOT, degradedBanner
 *
 * Zero third-party deps; Node built-ins only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MODES = ['open', 'save', 'close', 'info'];
const ALIASES = {
  open: ['start', 'begin', 'boot'],
  close: ['end', 'finish', 'wrap'],
  save: ['write', 'store', 'checkpoint', 'snapshot', 'record', 'note'],
  info: ['status', 'current', 'which', 'where', 'show'],
};
const REAP_WORDS = ['reap', 'cleanup', 'clean', 'kill', 'sweep', 'strays', 'stray'];
const TEMPLATES_DIR = path.join(__dirname, 'templates');
const PROSE_MODES = ['open', 'save', 'close'];
const PROSE_LOCATIONS = ['before', 'after'];
const READING_AUDIENCES = ['orchestrator', 'subagent', 'all'];

const EMERGENCY_BOOT = [
  '# tpm-session — EMERGENCY BOOT (the composer failed; this literal procedure is the fallback)',
  '',
  'You are the TPM orchestrator for this session. Do these in order, from the project root:',
  '1. `tpm session current --open` — allocate/confirm the session (idempotent).',
  '2. `tpm session config --json` — read the session config (`session.enabled:false` => say so and stop).',
  '3. `tpm reading-list orchestrator` — run the emitted `tpm doc` lines top to bottom.',
  '4. `tpm session boot-read` — the prior session pickup (read the handoff fully).',
  '5. Print the footer: the session number + folder (`tpm session current --state`).',
  '',
  'Composer failure: {MSG}. Run `tpm session doctor` to diagnose.',
].join('\n');

// Used ONLY when the engine fell back to an EMPTY config (defaults file unreadable): every `tpm:if` would be
// OFF and the procedure would render hollow. This keeps boot correct (all modules ON, like shipped defaults).
const MINIMAL_CONFIG = Object.freeze({
  session: { enabled: true, notes: { enabled: true, sessionsDir: '.claude/claude-tpm/sessions' },
    showTPMOpenMessage: true, showTPMCloseMessage: true, additionalOpenMessage: '', additionalCloseMessage: '' },
  tasks: { enabled: true }, workflow: { enabled: true },
});

// ── mode normalization (the forgiving-interpretation table, moved out of SKILL.md into code) ──────────

function levenshtein(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

function allNames() {
  const out = [];
  for (const m of MODES) { out.push([m, m]); for (const a of ALIASES[m] || []) out.push([a, m]); }
  return out;
}

/** Resolve ONE word to a mode: exact, then (len>=3) edit-distance 1 or prefix; null if none/ambiguous. */
function resolveWord(w) {
  const names = allNames();
  const exact = names.filter(([n]) => n === w).map(([, m]) => m);
  if (exact.length) return exact[0];
  if (w.length < 3) return null;
  const prefix = new Set();
  for (const [n, m] of names) if (n.startsWith(w)) prefix.add(m);
  if (prefix.size) return prefix.size === 1 ? [...prefix][0] : null; // prefix matches beat edit-distance
  const fuzzy = new Set();
  for (const [n, m] of names) if (levenshtein(w, n) <= 1) fuzzy.add(m);
  return fuzzy.size === 1 ? [...fuzzy][0] : null;
}

function normalizeMode(arg) {
  const raw = typeof arg === 'string' ? arg : '';
  const norm = raw.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!norm || norm === 'auto') return { kind: 'auto', echo: null };
  const words = norm.split(' ');
  if (words.some((w) => REAP_WORDS.includes(w))) return { kind: 'reap', echo: raw.trim() };
  const hits = [];
  for (const w of words) { const m = resolveWord(w); if (m) hits.push(m); }
  const uniq = [...new Set(hits)];
  if (uniq.length === 1) return { kind: 'mode', mode: uniq[0], echo: raw.trim() };
  return { kind: 'ambiguous', echo: raw.trim() };
}

const MODE_TABLE = [
  '| Mode | Aliases |',
  '|---|---|',
  '| `open` | start, begin, boot |',
  '| `close` | end, finish, wrap |',
  '| `save` | write, store, checkpoint, snapshot, record, note |',
  '| `info` | status, current, which, where, show |',
].join('\n');

// ── small helpers ─────────────────────────────────────────────────────────────────────────────────────

function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function resolvePath(p, projectRoot) { return path.isAbsolute(p) ? p : path.join(projectRoot, p); }

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (_e) { return null; }
}

/** The degraded-config banner, byte-matching the engine's (pinned by a test against the engine). */
function degradedBanner(reason, fallback) {
  const how = fallback === 'defaults' ? 'shipped defaults' : 'no config';
  return `> WARNING: tpm degraded config (${reason}) — rendered with ${how}. Run \`tpm doctor\` to diagnose.\n\n`;
}

function getFlag(cfg, dotted) {
  let cur = cfg;
  for (const k of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(k in cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

// ── slot builders ────────────────────────────────────────────────────────────────────────────────────

function fragment(name, warnings, templatesDir) {
  const t = readText(path.join(templatesDir, name));
  if (t === null) { warnings.push(`fragment-missing: ${name}`); return ''; }
  return t.replace(/\n+$/, '');
}

function buildMotd(cfg) {
  const on = (m) => !(isPlainObject(cfg[m]) && cfg[m].enabled === false);
  const lines = ['Here is what you can reach for (enabled modules only):'];
  if (on('session')) lines.push('- `tpm-session` → save session notes');
  if (on('tasks')) lines.push('- `tpm-task` → task management');
  if (on('workflow')) {
    lines.push('- `tpm-workflow` → run a workflow');
    lines.push('- `tpm-spawn` / `tpm-spawn-team` → spawn subagents');
    lines.push('- `tpm-reap` → clean up strays');
  }
  // hygiene is ON by default but ships no tpm-hygiene skill yet: NEVER listed.
  return lines.join('\n');
}

function buildAdditional(cfg, mode, projectRoot, warnings) {
  const key = mode === 'open' ? 'additionalOpenMessage' : mode === 'close' ? 'additionalCloseMessage' : null;
  const rel = key && cfg.session ? cfg.session[key] : '';
  if (typeof rel !== 'string' || !rel) return '';
  const t = readText(resolvePath(rel, projectRoot));
  if (t === null) { warnings.push(`additional-file-missing: ${rel}`); return ''; }
  return t.replace(/\n+$/, '');
}

function buildReadingExtras(cfg, projectRoot, warnings) {
  const list = cfg.session && cfg.session.readingList;
  if (!Array.isArray(list) || !list.length) return '';
  const lines = [];
  for (const e of list) {
    if (!isPlainObject(e) || typeof e.file !== 'string' || !e.file || !READING_AUDIENCES.includes(e.audience)) {
      warnings.push(`bad-reading-entry: ${JSON.stringify(e)}`); continue;
    }
    if (e.audience === 'subagent') continue; // orchestrator boot reads orchestrator + all only
    if (!fs.existsSync(resolvePath(e.file, projectRoot))) { warnings.push(`reading-file-missing: ${e.file}`); continue; }
    lines.push(`- \`${e.file}\``);
  }
  return lines.length
    ? ['Also read these project-specific docs (after the chain above, in order):', ...lines].join('\n')
    : '';
}

/** Returns { before, after, all } prose texts for mode M (config order), validating each entry. */
function buildProse(cfg, mode, projectRoot, warnings) {
  const list = cfg.session && cfg.session.proseInjections;
  const out = { before: [], after: [], all: [] };
  if (!Array.isArray(list)) return out;
  for (const e of list) {
    if (!isPlainObject(e) || !PROSE_MODES.includes(e.mode) || !PROSE_LOCATIONS.includes(e.location)
        || typeof e.file !== 'string' || !e.file) {
      warnings.push(`bad-prose-entry: ${JSON.stringify(e)}`); continue;
    }
    if (e.mode !== mode) continue;
    const t = readText(resolvePath(e.file, projectRoot));
    if (t === null) { warnings.push(`prose-file-missing: ${e.file}`); continue; }
    const body = t.replace(/\n+$/, '');
    out[e.location].push(body);
    out.all.push(body);
  }
  return out;
}

/**
 * pickupLead(pickupText) -> the line that introduces the pre-read pickup. Generated HERE in code (the template engine
 * has no loop): when boot-read printed per-track blocks, several Claude instances ran in parallel, so say so and tell the
 * reader to read every block and keep the tracks apart. A single-track pickup keeps the original lead word for word.
 */
function pickupLead(text) {
  const blocks = (String(text).match(/^=== TRACK [a-z] ·/gm) || []).length;
  if (!blocks) return 'Prior-session pickup (pre-read by the composer; read it fully):';
  return `Prior-session pickup (pre-read by the composer; read it fully). SEVERAL Claude instances ran in parallel (${blocks} track block${blocks === 1 ? '' : 's'} below): ` +
    'read EVERY block, keep the tracks apart, and reconcile them before acting. A track marked STILL LIVE or SEALED AS ABANDONED carries only its last-saved handoff.';
}

function runBootRead(sessionsDir, ctx) {
  const fallback = 'Prior-session pickup: run `tpm session boot-read` and read the handoff fully.';
  if (typeof ctx.pickup === 'string') return ctx.pickup;
  try {
    const args = [path.join(__dirname, 'tpm-session-boot-read.js')];
    if (sessionsDir) args.push('--sessions-dir', sessionsDir);
    const r = spawnSync('node', args, { encoding: 'utf8', timeout: 15000, env: Object.assign({}, process.env, ctx.env || {}) });
    const out = (r.stdout || '').replace(/\n+$/, '');
    if (r.status === 0 && out) return `${pickupLead(out)}\n\n${out}`;
  } catch (_e) { /* fall through */ }
  return fallback;
}

// ── compose ──────────────────────────────────────────────────────────────────────────────────────────

// The session state -> mode table for a bare invocation. EXPLICIT (no ternary): an unrecognised state string must
// not silently become `open`. `foreign-open` = a session is open but none of its unsealed tracks is mine ->
// the open gate (adopt / parallel / next / seal), NEVER save.
const STATE_MODE = { open: 'save', 'not-opened': 'open', 'foreign-open': 'open' };

const GATE_NOTICE = [
  'Open gate: a session is open, but by ANOTHER Claude instance — none of its unsealed tracks is yours. Do NOT save or write to it.',
  'Run `tpm session current --open`; it will refuse (exit 3) and print the other track(s) with evidence. Then ASK the person which it is — adopt (that track is mine, e.g. after /clear), parallel (I am a second train), next (open the next session), or seal-and-new (those tracks are dead: abandoned-seal them, then open the next session; show the evidence and get an explicit yes before passing --even-if-running) — and re-run with the matching flag. Never choose for them.',
].join('\n');

function foreignRefusal(mode) {
  return [
    `Cannot run \`tpm-session ${mode}\`: the session state is "foreign-open" — a session is open, but none of its unsealed tracks is yours.`,
    `Writing now would put notes into a track you do not own. Nothing was written. Run \`tpm session compose --mode open\` (or the bare \`tpm-session\`) and follow the open gate: it shows the other track(s) and asks whether to adopt, run in parallel, or open the next session.`,
  ].join('\n');
}

// True when the session has more than one track OR any foreign/other-owner/unowned track (the same
// resolveCurrentSession signal that drives `foreign-open`). Fails OPEN (true): an unreadable state keeps the guidance.
function hasMultiTrack(sessionsDirFor, warnings) {
  try {
    const { resolveCurrentSession } = require('./tpm-session-current');
    const r = resolveCurrentSession({ sessionsDir: sessionsDirFor() });
    return (Array.isArray(r.tracks) && r.tracks.length > 1) || r.state === 'foreign-open'
      || (r.foreign || []).length > 0 || (r.unowned || []).length > 0;
  } catch (e) {
    warnings.push(`session-state-unreadable: ${e && e.message ? e.message : e}`);
    return true;
  }
}

function currentState(sessionsDirFor, warnings) {
  try {
    const { resolveCurrentSession } = require('./tpm-session-current');
    return resolveCurrentSession({ sessionsDir: sessionsDirFor() }).state;
  } catch (e) {
    // Reader honesty: a resolver failure still defaults to open, but it is now VISIBLE.
    warnings.push(`session-state-unreadable: ${e && e.message ? e.message : e}`);
    return 'not-opened';
  }
}

function composeInner(modeArg, ctx) {
  const tpl = ctx.engine || require('../lib/tpm-template');
  const { findRoot } = require('./tpm-session-paths');
  const env = ctx.env || process.env;
  const projectRoot = ctx.projectRoot || findRoot({ marker: path.join('.claude', 'claude-tpm') });
  const templatesDir = ctx.templatesDir || TEMPLATES_DIR;
  const warnings = [];

  const rc = ctx.config
    ? { config: ctx.config, degraded: false }
    : tpl.resolveConfig({ projectRoot, env });
  const cfg = rc.degraded && rc.fallback === 'empty' ? JSON.parse(JSON.stringify(MINIMAL_CONFIG))
    : (isPlainObject(rc.config) ? rc.config : {});
  const sess = isPlainObject(cfg.session) ? cfg.session : {};

  const sessionsDirFor = () => {
    if (ctx.sessionsDir) return ctx.sessionsDir;
    if (env.TPM_SESSIONS_DIR) return env.TPM_SESSIONS_DIR;
    const dir = (sess.notes && sess.notes.sessionsDir) || '.claude/claude-tpm/sessions';
    return resolvePath(dir, projectRoot);
  };

  const norm = normalizeMode(modeArg);
  let mode;
  let echo = '';
  let gateNotice = '';
  if (norm.kind === 'reap') {
    return { text: `Reading "${norm.echo}" as a reap request: there is no \`tpm-session reap\` mode — run \`/tpm-reap\` directly.\n`,
      mode: null, kind: 'reap', warnings, emergency: false };
  }
  if (norm.kind === 'ambiguous') {
    return { text: `Could not read "${norm.echo}" as a tpm-session mode. Pick one (do NOT guess):\n\n${MODE_TABLE}\n`,
      mode: null, kind: 'ambiguous', warnings, emergency: false };
  }
  if (norm.kind === 'auto') {
    const state = currentState(sessionsDirFor, warnings);
    mode = STATE_MODE[state];
    if (!mode) {
      warnings.push(`session-state-unknown: "${state}" is not a state this composer knows; defaulting to open (the safe gate)`);
      mode = 'open';
    }
    echo = `Bare invocation → session state "${state}" → mode: ${mode}${state === 'foreign-open' ? ' (open gate)' : ''}`;
    if (state === 'foreign-open') gateNotice = GATE_NOTICE;
  } else {
    mode = norm.mode;
    echo = `Reading "${norm.echo}" as → mode: ${mode}`;
    if (mode === 'save' || mode === 'close') {
      // An explicit save/close in the third state is REFUSED with a pointer to open (never writes into a foreign track).
      if (currentState(sessionsDirFor, warnings) === 'foreign-open') {
        return { text: `${echo}\n\n${foreignRefusal(mode)}\n`, mode, kind: norm.kind, warnings, emergency: false, refused: true };
      }
    }
  }

  // 1. template source
  const shipped = path.join(templatesDir, `${mode}.md`);
  let template = null;
  const override = PROSE_MODES.includes(mode) && isPlainObject(sess.templates) ? sess.templates[mode] : '';
  if (typeof override === 'string' && override) {
    template = readText(resolvePath(override, projectRoot));
    if (template === null) warnings.push(`template-override-missing: ${override}`);
  }
  if (template === null) {
    template = readText(shipped);
    if (template === null) throw new Error(`shipped template missing: ${shipped}`);
  }

  // 2-4. prose + slots
  const prose = PROSE_MODES.includes(mode) ? buildProse(cfg, mode, projectRoot, warnings)
    : { before: [], after: [], all: [] };
  const hasMarker = tpl.scanTemplate(template).injects.includes('prose');
  const multi = mode === 'close' && hasMultiTrack(sessionsDirFor, warnings);
  const slots = {
    prose: hasMarker ? prose.all.join('\n\n') : '',
    'tools-common': fragment('_tools-common.md', warnings, templatesDir),
    'tools-write': fragment('_tools-write.md', warnings, templatesDir),
    'save-ritual': fragment('_save-ritual.md', warnings, templatesDir),
    footer: fragment('_footer.md', warnings, templatesDir),
    motd: mode === 'open' ? buildMotd(cfg) : '',
    additional: buildAdditional(cfg, mode, projectRoot, warnings),
    'reading-extras': mode === 'open' ? buildReadingExtras(cfg, projectRoot, warnings) : '',
    // Multi-track seal / abandoned-seal / ETRACK_SEALED guidance: close only, and only when it can apply.
    'multi-track': mode === 'close' && multi ? fragment('_close-multitrack.md', warnings, templatesDir) : '',
    'foreign-gate': mode === 'close' && multi ? fragment('_close-foreign-gate.md', warnings, templatesDir) : '',
    pickup: '',
  };
  if (mode === 'open' && sess.enabled !== false && getFlag(cfg, 'session.notes.enabled') !== false) {
    slots.pickup = runBootRead(sessionsDirFor(), ctx);
  }

  const renderFn = ctx.renderFn || tpl.render;
  const r = renderFn(template, { config: cfg, slots, banner: false, name: `${mode}.md` });
  for (const w of r.warnings || []) warnings.push(`${w.code}: ${w.message}`);

  const parts = [];
  if (rc.degraded) parts.push(degradedBanner(rc.reason, rc.fallback).replace(/\n+$/, ''));
  if (echo) parts.push(echo);
  if (gateNotice) parts.push(gateNotice);
  if (!hasMarker && prose.before.length) parts.push(prose.before.join('\n\n'));
  parts.push(r.text.replace(/\n+$/, ''));
  if (!hasMarker && prose.after.length) parts.push(prose.after.join('\n\n'));
  let text = parts.join('\n\n') + '\n';
  if (warnings.length) {
    text += `\ntpm notes (composer):\n${warnings.map((w) => `- ${w}`).join('\n')}\n`;
  }
  return { text, mode, kind: norm.kind, warnings, emergency: false };
}

function compose(modeArg, ctx = {}) {
  try {
    return composeInner(modeArg, ctx);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return { text: `${EMERGENCY_BOOT.replace('{MSG}', msg)}\n`, mode: null, kind: 'emergency', warnings: [msg], emergency: true };
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────────

function printHelp() {
  process.stdout.write([
    'Usage: tpm session compose --mode <open|save|close|info|auto|alias> [free text...]',
    '       tpm session compose --help',
    '',
    'Composes the tpm-session procedure for a mode from the shipped template + resolved config, and',
    'prints it. READ-ONLY (never allocates a session). ALWAYS exits 0; on an internal failure it prints a',
    'literal emergency boot procedure instead.',
    '',
    'Flags:',
    '  --mode <m>   Mode token (open|save|close|info, an alias such as start/wrap/checkpoint/status, a',
    '               misspelling, or auto/empty = state-aware: not-opened -> open, open -> save,',
    '               foreign-open (a session is open but none of its tracks is yours) -> open, the gate).',
    '               Extra words after the mode token are accepted and ignored.',
    '  --help       Show this message.',
    '',
    'Examples:',
    '  tpm session compose --mode open',
    '  tpm session compose --mode save',
    '  tpm session compose --mode auto',
    '',
  ].join('\n'));
}

function main(argv) {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) { printHelp(); return 0; }
  const i = args.indexOf('--mode');
  const rest = i === -1 ? args.filter((a) => a !== '--') : args.slice(i + 1).filter((a) => a !== '--');
  const modeArg = rest.join(' ');
  const res = compose(modeArg);
  process.stdout.write(res.text);
  return 0;
}

if (require.main === module) {
  process.exit(main(process.argv));
}

module.exports = { compose, pickupLead, normalizeMode, STATE_MODE, EMERGENCY_BOOT, degradedBanner, MODES, ALIASES, TEMPLATES_DIR, main };
