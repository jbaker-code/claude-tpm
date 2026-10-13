#!/usr/bin/env node
'use strict';
/**
 * tpm-session-export.js — the node-invokable EXPORT tool for `kind:"session"` records (P05).
 *
 * Delegated the `export` verb by the router (export-spec Locked #4; #1113 C/D). Turns session
 * JSON on disk into the outputs from the LOCKED `export-spec.md` by COMPOSING the blessed shared
 * pieces — it re-implements NONE of them:
 *   - `lib/session-model.js`     · `loadSession(jsonPath)`     — read→migrate→validate one session.
 *   - `lib/session-converter.js` · `render(record, { now })`   — the PURE JSON→human converter.
 *   - `lib/export-scaffold.js`   · `selectRecords` / `combine` / `dispatch` — kind-agnostic
 *                                  filter / combine / one-vs-many / JSON-vs-human dispatch.
 *
 * ── EXPORT SURFACE (export-spec §Export surface) ──
 *   Single session   — full JSON (canonical envelope) OR human (one-way, NOT re-importable).
 *   Multi-session     — the last N sessions (or an explicit selector list), as either
 *                       ONE combined file OR per-session files, in JSON and/or human.
 *   Combined shape (Q4): JSON = a BARE ARRAY of session envelopes `[ {…}, … ]` (no wrapper);
 *                        human = the FULL per-session render REPEATED for each session.
 *   Filters COMPOSE with a #1092 search result-set (feed an id/selector list or a pre-loaded
 *                        record set in) — matching is NOT reimplemented here (stubbed as the seam).
 *   Thin/editable session export: DROPPED (Q3) — deliberately NOT wired (JSON-full + human-only).
 *
 * ── `now` CLOSURE (P04 concern) ──
 * The converter is `render(record, { now })`, but the scaffold's human dispatcher calls its
 * injected converter as `converter(record)` (one arg). So we bind a real `now` in a CLOSURE:
 *   converter: (r) => render(r, { now })
 * `now` is captured ONCE per export (default `nowIsoTz()`; overridable via `--now`) so punchlist
 * ages render and open items never hit the converter's loud "opts.now is required" throw.
 *
 * ── NODE-INVOKABLE, NO BIN (Q5) ──
 * Runs via `tpm session export …` (routed through the `tpm` bin), or bare
 * `node tools/session/tpm-session-export.js …`. Programmatic callers `require()` it for `exportSessions(...)`.
 *
 * Zero third-party deps; Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const { loadSession } = require('./lib/session-model');
const { render } = require('./lib/session-converter');
const T = require('./lib/session-tracks');
const ids = require('./lib/session-ids');
const collate = require('./lib/session-collate');
const { selectRecords, combine, dispatch } = require('../lib/export-scaffold');
const { nowIsoTz } = require('../lib/timestamp');

const SESSION_FILE_RE = /^session-(\d+)\.json$/;

// ── enumeration / resolution ─────────────────────────────────────────────────

/**
 * enumerateSessions(sessionsDir) -> [{ number, name, path }]  (ascending by number)
 * Discovers canonical sessions in the CANONICAL NESTED per-session-folder layout (json-format-spec
 * §"On-disk naming + location", Q-F): each session is `session-<NNNN>/session-<NNNN>.json`. Used for
 * `--last N` and to resolve a selector's session numbers to on-disk paths. Never touches the live
 * sessions dir (the caller supplies a scratch/real dir explicitly). `name` is the JSON basename
 * (e.g. `session-0021.json`) so the derived export output filename stays flat.
 */
function enumerateSessions(sessionsDir) {
  if (!sessionsDir) throw new Error('enumerateSessions: sessionsDir is required');
  let dirents;
  try {
    dirents = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`tpm-session-export: cannot read --sessions-dir '${sessionsDir}': ${e.message}`);
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue; // nested layout: canonical JSON lives inside session-<NNNN>/
    const subPath = path.join(sessionsDir, d.name);
    let subNames;
    try {
      subNames = fs.readdirSync(subPath);
    } catch (_e) {
      continue;
    }
    for (const name of subNames) {
      const m = SESSION_FILE_RE.exec(name);
      if (m) entries.push({ number: Number(m[1]), name, path: path.join(subPath, name) });
    }
  }
  entries.sort((a, b) => a.number - b.number);
  return entries;
}

// Zero-padded 4-wide session number for output file names (matches the human header's "0021").
function padNumber(number) {
  const n = Number(number);
  return Number.isFinite(n) ? String(n).padStart(4, '0') : String(number == null ? '' : number);
}

/**
 * sessionNumbers(sessionsDir) -> ['0001', ...] ascending: every session folder holding at least one TRACK record
 * (a, or only b..z). `--last N` counts these (sessions), never track files.
 */
function sessionNumbers(sessionsDir) {
  if (!sessionsDir) throw new Error('enumerateSessions: sessionsDir is required');
  try {
    fs.readdirSync(sessionsDir);
  } catch (e) {
    throw new Error(`tpm-session-export: cannot read --sessions-dir '${sessionsDir}': ${e.message}`);
  }
  return T.listSessionNumbers(sessionsDir).filter((n) => T.listFolder(sessionsDir, n).tracks.length > 0);
}

const nameForRecord = (record) => {
  const t = record && record.meta && typeof record.meta.track === 'string' && /^[b-z]$/.test(record.meta.track) ? `-${record.meta.track}` : '';
  return `session-${padNumber(record && record.meta && record.meta.number)}${t}`;
};

/**
 * resolveUnits(opts) -> { units, notes }   (the sessions to export, in export order)
 * A UNIT is one session: { number, name, collation|null, records:[readable track records, a..z] }.
 *
 * The search-composition SEAM (export-spec: compose with #1092, do NOT re-match). Three ways in,
 * in precedence order:
 *   1. opts.records   — a PRE-LOADED result-set (the truest #1092 seam): used verbatim, one unit per record.
 *   2. opts.selector  — an explicit id/selector LIST of session numbers, resolved in the ORDER given; a number may
 *                       be padded ('0021') or bare ('21'). A session expands to its tracks a..z.
 *   3. opts.last (N)  — the N most-recent SESSIONS (highest numbers), NEWEST-FIRST, each expanded to its tracks.
 * `opts.track` (a letter or a >=8-char Claude session id prefix) narrows every selected session to that track;
 * a session lacking it is skipped with a note, and when NO selected session has it the lookup is an error.
 * An optional `opts.filter` (a predicate fn OR an array result-set) then COMPOSES over the candidate records.
 */
function resolveUnits(opts) {
  const options = opts || {};
  const load = typeof options.loadSession === 'function' ? options.loadSession : null;
  const notes = [];
  let units;

  if (Array.isArray(options.records)) {
    units = options.records.map((record) => ({
      number: padNumber(record && record.meta && record.meta.number), name: nameForRecord(record), collation: null, records: [record],
    }));
  } else {
    let numbers;
    if (Array.isArray(options.selector) && options.selector.length) {
      const have = new Set(sessionNumbers(options.sessionsDir).map(Number));
      numbers = options.selector.map((sel) => {
        T.assertSessionNumber(sel);
        const num = Number(sel);
        if (!Number.isFinite(num) || !have.has(num)) {
          throw new Error(`tpm-session-export: selector '${sel}' matched no session-<NNNN>.json in '${options.sessionsDir}'`);
        }
        return padNumber(num);
      });
    } else if (options.last != null) {
      const n = Number(options.last);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`tpm-session-export: --last must be a positive integer, got ${JSON.stringify(options.last)}`);
      }
      numbers = sessionNumbers(options.sessionsDir).slice(-n).reverse(); // top-N highest, NEWEST-FIRST
    } else {
      throw new Error('tpm-session-export: nothing to export — pass records, --session <NNNN>… (selector), or --last N');
    }
    units = [];
    let firstMissing = null;
    for (const num of numbers) {
      let col;
      try {
        col = collate.collateSession(options.sessionsDir, num, { track: options.track });
      } catch (e) {
        if (options.track && e && (e.code === 'ENO_TRACK')) {
          if (!firstMissing) firstMissing = e;
          if (numbers.length > 1) notes.push(`note: session ${num} has no track ${options.track}; skipped`);
          continue;
        }
        throw e;
      }
      if (load) {
        for (const ts of col.tracks) {
          if (!ts.files.json) continue;
          try { ts.record = load(ts.jsonPath); ts.readable = true; } catch (e) { ts.record = null; ts.readable = false; ts.message = String(e.message); }
        }
      }
      if (!col.multi && col.tracks.length === 1 && !col.tracks[0].readable) {
        // a lone track a that cannot be read fails loudly, exactly as before (never an empty export)
        throw new Error(col.tracks[0].message || `cannot read track ${col.tracks[0].track} of session ${col.number}`);
      }
      const records = col.tracks.filter((t) => t.readable).map((t) => t.record);
      for (const t of col.tracks) {
        if (t.readable) continue;
        if (!col.multi && !col.narrowed) continue;                 // a lone unreadable track a fails loudly at render, as before
        notes.push(`note: track ${t.track} of ${col.number} is unreadable (${collate.unreadableReason(t)}); not exported`);
      }
      const narrowedLetter = col.narrowed && col.narrowed !== 'a' ? `-${col.narrowed}` : '';
      units.push({ number: col.number, name: `session-${col.number}${narrowedLetter}`, collation: col, records });
    }
    if (!units.length && firstMissing) throw firstMissing;
  }

  if (options.filter !== undefined && options.filter !== null) {
    const all = [].concat(...units.map((u) => u.records));
    const keep = new Set(selectRecords(all, { filter: options.filter }));
    units = units.map((u) => {
      const records = u.records.filter((r) => keep.has(r));
      const collation = u.collation ? Object.assign({}, u.collation, { tracks: u.collation.tracks.filter((t) => !t.readable || keep.has(t.record)) }) : null;
      return Object.assign({}, u, { records, collation });
    }).filter((u) => u.records.length);
  }
  if (!units.length) throw new Error('tpm-session-export: the selection resolved to zero sessions');
  return { units, notes };
}

/** resolveRecords(opts) -> record[] — the flat record list of resolveUnits (a..z within each session). */
function resolveRecords(opts) {
  return [].concat(...resolveUnits(opts).units.map((u) => u.records));
}

// ── the export core ──────────────────────────────────────────────────────────

/**
 * exportSessions(opts) -> { records, outputs, written, notes }
 *
 *   opts.sessionsDir  — dir of per-session folders session-<NNNN>/ (required unless opts.records given).
 *   opts.records      — OPTIONAL pre-loaded result-set (bypasses enumeration; the #1092 seam).
 *   opts.selector     — OPTIONAL explicit list of session numbers (the #1092-style seam).
 *   opts.last         — OPTIONAL N most-recent SESSIONS (highest numbers), newest-first.
 *   opts.track        — OPTIONAL narrow every selected session to one track (letter or Claude session id prefix).
 *   opts.filter       — OPTIONAL predicate fn OR array result-set, composed via selectRecords.
 *   opts.styles       — ['json'] | ['human'] | ['json','human']  (default ['json']).
 *   opts.combine      — 'one-file' | 'per-file' (default 'one-file' for multi; moot for a single).
 *   opts.out          — dir (write each file) OR a single file path; omitted -> nothing written.
 *   opts.now          — reference time for punchlist age (ISO string / Date); default nowIsoTz().
 *   opts.render       — injected converter (default session-converter.render).
 *   opts.loadSession  — injected loader (default: the track-state loader).
 *
 * A session with several tracks is ONE human unit (the merged read: title + table, every track's section, the
 * combined open punchlist) and one JSON record per track (a bare array when more than one record is exported).
 * File names: `session-NNNN` for track a, `session-NNNN-x` for b..z. Returns the resolved `records` (flat, a..z per
 * session), the `outputs` ([{ style, suggestedName, body, path|null }]), whether files were `written`, and the
 * stderr `notes` a caller should print (marker-sealed tracks read from JSON, unreadable tracks skipped, ...).
 * `now` is bound ONCE in a closure so the human converter always has an age reference (P04 concern).
 */
function exportSessions(opts) {
  const options = opts || {};
  const styles = normalizeStyles(options.styles);
  const renderFn = typeof options.render === 'function' ? options.render : render;
  const now = options.now != null ? options.now : nowIsoTz();

  const { units, notes } = resolveUnits(options);
  const records = [].concat(...units.map((u) => u.records));
  const mode = options.combine || (records.length > 1 ? 'one-file' : 'per-file');
  const unitCount = units.length;
  const combinedName = options.combinedName ||
    (options.last != null ? `sessions-last-${unitCount}` : 'sessions-combined');

  // stderr notes for what a reader of the JSON/human output must know about marker-sealed tracks
  for (const u of units) {
    if (!u.collation) continue;
    for (const ts of u.collation.tracks) {
      if (!ts.readable || ts.sealedBy !== 'marker') continue;
      if (styles.includes('json')) notes.push(collate.jsonMarkerNote(ts));
      else if (!u.collation.multi) notes.push(collate.humanMarkerNote(ts));
    }
  }

  const outputs = [];
  for (const style of styles) {
    const groups = style === 'human' ? combine(units, { mode }) : combine(records, { mode });
    for (const group of groups) {
      const descriptors = style === 'human'
        ? dispatch(group, {
          style, combinedName, nameFor: (u) => u.name,
          converter: (u) => (u.collation ? collate.renderSessionHuman(u.collation, { now, render: renderFn }) : renderFn(u.records[0], { now })),
        })
        : dispatch(group, { style, nameFor: nameForRecord, combinedName });
      for (const d of descriptors) outputs.push({ style, suggestedName: d.suggestedName, body: d.body, path: null });
    }
  }

  let written = false;
  if (options.out != null && options.out !== '') {
    writeOutputs(outputs, options.out);
    written = true;
  }
  return { records, outputs, written, notes };
}

// ['json','human'] normalized/deduped; accepts a string, comma-list, 'both', or array.
function normalizeStyles(styles) {
  let list = styles;
  if (list == null) return ['json'];
  if (typeof list === 'string') list = list.split(',');
  if (!Array.isArray(list)) throw new Error('tpm-session-export: styles must be a string or array');
  const out = [];
  for (const raw of list) {
    const s = String(raw).trim().toLowerCase();
    if (s === '' ) continue;
    if (s === 'both') { for (const b of ['json', 'human']) if (!out.includes(b)) out.push(b); continue; }
    if (s !== 'json' && s !== 'human') throw new Error(`tpm-session-export: unknown --style '${raw}' (json|human|both)`);
    if (!out.includes(s)) out.push(s);
  }
  return out.length ? out : ['json'];
}

/**
 * writeOutputs(outputs, out) — mutates each output's `path` with where it landed.
 *  - Exactly one output AND `out` has a .json/.md extension -> write that single file to `out`.
 *  - Otherwise `out` is treated as a DIRECTORY: created if needed; each output written under it
 *    as its suggestedName. Multiple outputs REQUIRE a directory (never one file path).
 */
function writeOutputs(outputs, out) {
  const singleFile = outputs.length === 1 && /\.(json|md)$/i.test(out) && !isExistingDir(out);
  if (singleFile) {
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, outputs[0].body);
    outputs[0].path = out;
    return;
  }
  if (outputs.length > 1 && /\.(json|md)$/i.test(out) && !isExistingDir(out)) {
    throw new Error(`tpm-session-export: --out '${out}' looks like a single file but ${outputs.length} files were produced — give a directory`);
  }
  fs.mkdirSync(out, { recursive: true });
  for (const o of outputs) {
    const p = path.join(out, o.suggestedName);
    fs.writeFileSync(p, o.body);
    o.path = p;
  }
}

function isExistingDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (_e) { return false; }
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = { selector: [], styles: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`tpm-session-export: ${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--sessions-dir': opts.sessionsDir = next(); break;
      case '--last': opts.last = next(); break;
      case '--track': opts.track = next(); break;
      case '--session': { const raw = next(); T.assertSessionNumber(raw); for (const v of raw.split(',')) if (v.trim()) opts.selector.push(v.trim()); break; }
      case '--style': for (const v of next().split(',')) if (v.trim()) opts.styles.push(v.trim()); break;
      case '--combine': opts.combine = next(); break;
      case '--out': opts.out = next(); break;
      case '--now': opts.now = next(); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`tpm-session-export: unknown argument '${a}'`);
    }
  }
  if (!opts.selector.length) delete opts.selector;
  if (!opts.styles.length) delete opts.styles;
  return opts;
}

const USAGE = `tpm-session-export — session export tool (run: tpm session export …)

  --sessions-dir <dir>     directory of session-<NNNN>.json (a SCRATCH or real dir). OPTIONAL (F4):
                           omitted → resolved from the LOCAL project's .claude/claude-tpm/config.json
                           (session.notes.sessionsDir); the flag OVERRIDES; with NEITHER, FAILS LOUD.
  --last N                 export the N most-recent sessions (newest first; a session with several tracks counts once)
  --track <letter|id>      narrow to ONE track: a letter a-z, or at least 8 characters of its owner's Claude session
                           id. An unknown value is an error, never an empty result. Without it, a session with
                           several tracks prints ALL of them (human: one merged read with a table and the combined
                           open punchlist; json: one record per track, a bare array when more than one).
  --session <NNNN>[,NNNN]  explicit selector list (repeatable; the #1092 seam) — no re-matching. A number only:
                           '0001b' is rejected (pick the track with --track b)
  --style json|human|both  output format(s); repeatable / comma-list (default: json)
  --combine one-file|per-file   multi-session: ONE combined file (default) or per-session files
  --out <dir|file>         write here (dir = per suggestedName; file = single output). Omit -> stdout.
  --now <iso>              reference time for punchlist age (default: now, local offset)

Combined (Q4): JSON = a bare array of envelopes; human = full per-session render repeated.
Thin/editable session export is intentionally NOT available (Q3).`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    if (e && e.code === 'ESESSION_DESIGNATOR') {
      process.stderr.write(`tpm-session-export: ${e.message}\n`);
      return e.exitCode || 2;
    }
    process.stderr.write(String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    // F4: --sessions-dir is OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). Never a
    // silent live-store default; resolveSessionsDir throws loud when neither a flag nor a local config.
    if (!opts.sessionsDir && !opts.records) {
      opts.sessionsDir = require('./tpm-session-config').resolveSessionsDir(undefined, undefined).sessionsDir;
    }
    const { outputs, written, notes } = exportSessions(opts);
    for (const n of notes) process.stderr.write(`${n}\n`);
    if (!written) {
      // stdout: single output raw; multiple outputs delimited by a name banner.
      if (outputs.length === 1) {
        process.stdout.write(outputs[0].body.endsWith('\n') ? outputs[0].body : outputs[0].body + '\n');
      } else {
        process.stdout.write(outputs.map((o) => `===== ${o.suggestedName} =====\n${o.body}`).join('\n') + '\n');
      }
    } else {
      process.stderr.write(`wrote ${outputs.length} file(s):\n` + outputs.map((o) => '  ' + o.path).join('\n') + '\n');
    }
    return 0;
  } catch (e) {
    process.stderr.write('tpm-session-export: ' + String(e.message) + '\n');
    return e && (e.code === 'ETRACK_SELECTOR' || e.code === 'ESESSION_DESIGNATOR') ? e.exitCode : 1;
  }
}

module.exports = {
  exportSessions,
  resolveRecords,
  enumerateSessions,
  resolveUnits,
  sessionNumbers,
  normalizeStyles,
  padNumber,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
