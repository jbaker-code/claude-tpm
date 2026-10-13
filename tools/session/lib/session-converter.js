'use strict';
/**
 * session-converter.js — the PURE JSON→human converter for `kind:"session"` records (P04).
 *
 * `render(record, { now }) -> string` produces the single derived human-readable `.md` for a
 * session, faithful to the LOCKED render rules in `export-spec.md` (§ Human-render format rules):
 * a header banner, then Handoff → Punchlist → Log.
 *
 * ── PURITY (DoD row 1) ──
 * render is a pure function: no `fs`, no clock, no mutation of the input. Punchlist AGE is
 * relative-to-now, so the reference time is INJECTED via `opts.now` (a local-offset ISO string
 * or a Date) — the converter NEVER reads the clock, so goldens are byte-stable and two calls on
 * the same (record, now) return identical output.
 *
 * ── PAYLOAD SHAPE (03-session-model HANDOFF) ──
 * For `kind:"session"` the payload IS the whole record: top-level SIBLING blocks
 * `meta` / `handoff` / `log` / `punchlist`. `readEnvelope().payload` is `undefined` under this
 * kind — read the record directly (this module does).
 *
 * ── INJECTION ──
 * `session-model.saveSession(record, { jsonPath, mdPath, render })` and `exportSession(record,
 * { style:"human", render })` accept this as the injected `render`. saveSession calls it as
 * `render(record)` (one arg), so callers that need age bind `now` in a closure:
 *   saveSession(rec, { jsonPath, mdPath, render: (r) => render(r, { now }) })
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */
const { shortDateTime } = require('../../lib/timestamp');
const { hashRecord } = require('../../lib/hash');

const MS_MIN = 60 * 1000;
const MS_HOUR = 60 * MS_MIN;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function nonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

// ── render (public) ──────────────────────────────────────────────────────────

/**
 * render(record, opts?) -> string
 *   opts.now — reference time for punchlist age (ISO-8601 local-offset string OR Date).
 *              REQUIRED only when there is an OPEN punchlist item whose age must be shown;
 *              a null-handoff / no-open-items record renders without it.
 *
 * Pure: reads only; never mutates `record`; never reads the clock. Sections are joined with a
 * single blank line and the file ends with one trailing newline.
 */
function render(record, opts) {
  if (!isPlainObject(record)) {
    throw new Error('render: record must be an object (the full session record)');
  }
  const options = opts || {};
  const sections = [
    renderHeader(record, options),
    renderHandoff(record),
    renderPunchlist(record, options.now, options.displayId),
    renderLog(record),
  ];
  return sections.join('\n\n') + '\n';
}

// ── header ─────────────────────────────────────────────────────────────────

function renderHeader(record, options) {
  const opt = options || {};
  const meta = isPlainObject(record.meta) ? record.meta : {};
  const num = padNumber(meta.number);
  // Track b..z: the file is session-NNNN-<x>.json and the title names the track. Track a / absent is
  // byte-identical to the pre-tracks output (goldens unchanged).
  const letter = typeof meta.track === 'string' && /^[b-z]$/.test(meta.track) ? meta.track : '';
  const fileStem = 'session-' + num + (letter ? '-' + letter : '');
  const date = shortDate(meta.openedAt);
  // Additive render options (phase 12; every default leaves today's bytes unchanged): `stateWord` replaces the
  // closed/open banner word (the merged read overlays a marker seal, which the record itself cannot carry);
  // `trackLabel` names track a in the title (b..z already carry it).
  const state = typeof opt.stateWord === 'string' && opt.stateWord ? opt.stateWord : (meta.closedAt ? 'closed' : 'open');
  const schema = record.schemaVersion != null ? String(record.schemaVersion) : '?';
  const id = abbrevId(firstSessionId(meta.sessionIds));
  // (generated from: <12hex>): the content hash of the WHOLE canonical record (Q-D; wording per
  // Q-D.2, Jason 2026-09-20). Stamped here on every render; the session doctor (#1119) recomputes it
  // from the on-disk JSON to detect human-file drift. The hash is over the JSON record only — it
  // never sees this banner, so there is no self-reference.
  const gen = hashRecord(record);
  return [
    `# Session ${num} · ${date}` + (letter ? ` · track ${letter}` : (opt.trackLabel === true ? ' · track a' : '')),
    '',
    '> _Generated from `' + fileStem + '.json` — do not hand-edit; regenerated and overwritten on every save._',
    '> _Change it via `tpm session` ops or import (`#1115`). · session ' + num +
      ' · **' + state + '** · schema ' + schema + ' · id ' + id + ' (generated from: ' + gen + ')_',
  ].join('\n');
}

// meta.number is stored canonical zero-padded width-4 ("0021" — locked, Jason 2026-09-20); this
// re-pads defensively so the header renders "0021" regardless of the input form (a tolerant render).
function padNumber(number) {
  const n = Number(number);
  if (Number.isFinite(n)) return String(n).padStart(4, '0');
  return String(number == null ? '' : number).padStart(4, '0');
}

// "YYYY-MM-DD" from a local-offset ISO string (verbatim slice — no reparse/reproject).
function shortDate(isoTz) {
  return typeof isoTz === 'string' && isoTz.length >= 10 ? isoTz.slice(0, 10) : '????-??-??';
}

function firstSessionId(sessionIds) {
  return Array.isArray(sessionIds) && sessionIds.length ? sessionIds[0] : '';
}

// "31569169-6609-4bcf-b90f-448f25ee98a3" -> "31569169…98a3" (first 8 + ellipsis + last 4).
function abbrevId(id) {
  const s = String(id || '');
  if (s.length <= 12) return s;
  return s.slice(0, 8) + '…' + s.slice(-4);
}

// ── handoff ──────────────────────────────────────────────────────────────────

function renderHandoff(record) {
  const h = record.handoff;
  if (h === null || h === undefined) {
    return '## Handoff\n\n_No handoff yet — session opened, not yet saved._';
  }
  const blocks = [];
  if (nonEmptyString(h.where)) blocks.push('**Where we are:**\n' + h.where);
  if (nonEmptyString(h.next)) blocks.push('**Next:**\n' + h.next);
  if (Array.isArray(h.in_flight) && h.in_flight.length) {
    blocks.push('**In flight:**\n' + bulleted(h.in_flight));
  }
  if (Array.isArray(h.must_not_redo) && h.must_not_redo.length) {
    blocks.push('**Must not redo:**\n' + bulleted(h.must_not_redo));
  }
  const body = blocks.length ? blocks.join('\n\n') : '_Handoff present but empty._';
  return '## Handoff\n\n' + body;
}

function bulleted(items) {
  return items.map((x) => '- ' + x).join('\n');
}

// ── punchlist ────────────────────────────────────────────────────────────────

function renderPunchlist(record, now, displayId) {
  const shown = typeof displayId === 'function' ? displayId : (id) => id;
  const items = Array.isArray(record.punchlist) ? record.punchlist : [];
  const open = items.filter((it) => it && it.state === 'open');
  const done = items.filter((it) => it && it.state === 'done');
  // dropped items are intentionally omitted (neither Open nor Done) — see HANDOFF.

  const sections = [];

  const openLines = ['**Open (' + open.length + ')**'];
  open.forEach((it, idx) => {
    const marker = carriedMarker(it);
    openLines.push(
      (idx + 1) + '. `#' + shown(it.id) + '`' + marker + ' ' + it.text + ' _(' + ageOf(it.createdAt, now) + ')_',
    );
  });
  sections.push(openLines.join('\n'));

  if (done.length) {
    const doneLines = ['**Done (' + done.length + ')**'];
    done.forEach((it) => {
      const closedTs = lastEventTs(it, 'close');
      const suffix = closedTs ? ' _(closed ' + shortDateTime(closedTs).slice(11) + ')_' : '';
      doneLines.push('- ~~`#' + shown(it.id) + '` ' + it.text + '~~' + suffix);
    });
    sections.push(doneLines.join('\n'));
  }

  return '## Punchlist\n\n' + sections.join('\n\n');
}

/**
 * carriedMarker(item) -> string  (P06 fromSession provenance)
 *   carried WITH a source-session number  -> ' ⤴ _carried from NNNN_ —'  (NNNN zero-padded 4-wide)
 *   carried WITHOUT one (legacy carry-in)  -> ' ⤴ _carried_ —'
 *   not carried                            -> ''
 * export-spec.md § Punchlist example: `2. `#21.4` ⤴ _carried from 0020_ — <text> _(6h ago)_`.
 */
function carriedMarker(item) {
  const events = Array.isArray(item.events) ? item.events : [];
  const carryEv = events.find((e) => e && e.op === 'carry-in');
  if (!carryEv) return '';
  const from = carryEv.fromSession;
  if (from !== undefined && from !== null && String(from) !== '') {
    return ' ⤴ _carried from ' + padNumber(from) + '_ —';
  }
  return ' ⤴ _carried_ —';
}

// The ts of the most-recent event with op === `op`, or null.
function lastEventTs(item, op) {
  const events = Array.isArray(item.events) ? item.events : [];
  let ts = null;
  for (const ev of events) if (ev && ev.op === op && typeof ev.ts === 'string') ts = ev.ts;
  return ts;
}

/**
 * ageOf(createdAt, now) -> string  (Q1 ruling)
 *   `Nm ago` (< 1h) · `Nh ago` (< 24h) · `Nd ago` (< 7d) · absolute `YYYY-MM-DD` at >= 7d.
 * PURE: `now` is injected; the clock is never read. `now` may be an ISO string or a Date.
 */
function ageOf(createdAt, now) {
  if (now === undefined || now === null) {
    throw new Error(
      'render: opts.now is required to compute punchlist ages (open items are present) — ' +
      'pass a reference time (ISO-8601 local-offset string or Date); the converter never reads the clock',
    );
  }
  const created = toMs(createdAt);
  const ref = toMs(now);
  if (Number.isNaN(created) || Number.isNaN(ref)) return '?';
  const diff = Math.max(0, ref - created);
  if (diff < MS_HOUR) return Math.floor(diff / MS_MIN) + 'm ago';
  if (diff < MS_DAY) return Math.floor(diff / MS_HOUR) + 'h ago';
  if (diff < MS_WEEK) return Math.floor(diff / MS_DAY) + 'd ago';
  return shortDate(typeof createdAt === 'string' ? createdAt : new Date(created).toISOString());
}

function toMs(t) {
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'string') {
    const ms = Date.parse(t); // ISO-8601 with an explicit offset parses deterministically.
    return Number.isNaN(ms) ? NaN : ms;
  }
  return NaN;
}

// ── log ──────────────────────────────────────────────────────────────────────

function renderLog(record) {
  const log = Array.isArray(record.log) ? record.log.slice() : [];
  // reverse-chron: seq is the sole order authority (validator enforces strictly increasing).
  log.sort((a, b) => (b.seq || 0) - (a.seq || 0));
  const entries = log.map(renderLogEntry);
  const body = entries.length ? entries.join('\n\n') : '_No log entries yet._';
  return '## Log\n_Newest first._\n\n' + body;
}

/**
 * A single log entry.
 *   decision -> `🔹 DECISION — <what>` + a `why: <why>` line (always multi-line).
 *   log      -> `<status> — <text>` (status rendered inline).
 * Single-line body  -> `YYYY-MM-DD HH:MM: <body>`.
 * Multi-line body   -> `YYYY-MM-DD HH:MM:` + newline + <body>. NO leading dash.
 */
function renderLogEntry(entry) {
  const e = entry || {};
  const time = shortDateTime(e.ts);
  let body;
  if (e.type === 'decision') {
    body = '🔹 DECISION — ' + e.what + '\nwhy: ' + e.why;
  } else {
    body = e.status + ' — ' + e.text;
  }
  return body.indexOf('\n') !== -1 ? time + ':\n' + body : time + ': ' + body;
}

module.exports = {
  render,
  // Internals exported for unit tests only (not part of the public surface).
  _ageOf: ageOf,
  _renderLogEntry: renderLogEntry,
  _abbrevId: abbrevId,
};
