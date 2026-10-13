#!/usr/bin/env node
'use strict';
/**
 * tpm-session-migrate.js — the OPT-IN, convert-on-demand OLD→NEW session migrator (#1114.C).
 *
 * Converts ONE old-format 3-file markdown session (handoff + log + punchlist `.md`, the clean
 * marked "session-<NNNN>-{handoff,log,punchlist}.md" shape written by the pre-JSON tpm-session
 * tooling — sessions 0020/0021-style) into the new canonical `session-<NNNN>/session-<NNNN>.json` envelope
 * (the per-session-folder NESTED layout, json-format-spec Q-F),
 * COMPOSING the blessed base lib — it re-implements none of the write/validate path:
 *   - lib/envelope.js       · writeEnvelope(path, record)   — ATOMIC canonical write (temp→rename).
 *   - lib/validate.js       · validateEnvelope(record, …)   — envelope + kind gate.
 *   - lib/session-schema.js · validatePayload               — the LOCKED payload validator.
 *   - lib/session-model.js  · canonicalNumber / loadSession — canonical number + round-trip load.
 *   - lib/session-converter · render                        — the derived `.md` (on by default; --no-emit-md skips).
 *   - lib/timestamp.js      · nowIsoTz                       — the handoff.updatedAt stamp.
 *
 * ── SAFETY RAILS (build-plan §2c; Jason's locked rulings) ──
 *  - CONVERT-ON-DEMAND, ONE target per run. NO scan-and-auto-convert (that suggest-only behavior
 *    is the doctor's, #1119/P04). Nothing happens unless a human runs this with explicit flags.
 *  - `--in` and `--out-dir` are REQUIRED, NO defaults (tool-conventions no-defaults). It refuses
 *    if `--out-dir` is (or is inside) `--in`, or if `--out-dir` resolves inside a live
 *    `.claude/claude-tpm/sessions` tree — READ-ONLY on the input, WRITE-ONLY under `--out-dir`.
 *  - VALIDATE-BEFORE-WRITE: the assembled record is run through validateEnvelope and FAILS LOUD
 *    (naming the unfillable field) rather than ever writing an invalid `session-<NNNN>.json`.
 *  - `--dry-run` reports what WOULD be written + the validation result and writes nothing.
 *
 * ── Q-B: MARKED-3-FILE ONLY (Jason, 2026-09-20) ──
 *  Only the clean marked 3-file shape is accepted. Mixed (stray unprefixed note files present,
 *  e.g. session-0019), 2-file (handoff.md + session-notes.md, e.g. session-011) and freeform
 *  (notes.md + *.txt, e.g. session-001) inputs are REFUSED with a clear message — never
 *  best-effort or partial-converted.
 *
 * ── Q-C: DO NOT SYNTHESIZE TIMESTAMPS (Jason, 2026-09-20) ──
 *  No historical timestamp is ever invented. `meta.closedAt` is left null when the source has no
 *  real close timestamp (a "SEALED <date>" line is date-only → NOT synthesized into a T00:00:00
 *  value). `meta.openedAt` (schema-required, non-nullable) is taken from the EARLIEST REAL ISO-TZ
 *  timestamp already present in the session (log entries + punchlist items/events) — a real value
 *  selected from the data, never a fabricated one; if the session carries no real timestamp at all
 *  the migrator REFUSES rather than invent one. No new schema marker field is added.
 *
 * ── NODE-INVOKABLE ── run via `tpm session migrate …` (routed), or bare `node tools/session/tpm-session-migrate.js …`;
 *  programmatic callers `require()` it for `runMigration(...)` / `parseOldSession(...)`.
 *
 * Zero third-party deps; Node built-ins only.
 *
 * USAGE
 *   node tpm-session-migrate.js --in <old-session-dir> --out-dir <dir> \
 *       [--number NNNN] [--dry-run] [--emit-md|--no-emit-md] [--force] [--now <iso>]
 *
 * FLAGS
 *   --in <dir>       REQUIRED. Directory holding the old marked 3-file session. READ-ONLY.
 *   --out-dir <dir>  REQUIRED. The store dir; output lands NESTED at
 *                    <out-dir>/session-<NNNN>/session-<NNNN>.json. Must differ from --in and
 *                    must not resolve inside a live .claude/claude-tpm/sessions tree.
 *   --number NNNN    Optional. Override the session number (else parsed from the banner/filename).
 *   --dry-run        Validate + report what WOULD be written; write nothing.
 *   --emit-md        Also write the derived human-readable session-<NNNN>.md (via the converter). DEFAULT: on.
 *   --no-emit-md     Opt OUT of the derived .md — write only the canonical .json.
 *   --force          Overwrite an existing output file (otherwise refuse if it exists).
 *   --now <iso>      Overrides handoff.updatedAt (default: the source's latest timestamp, now only if it has none). Injectable
 *                    so goldens are byte-stable.
 *   --help           Show this usage.
 *
 * EXAMPLE
 *   tpm session migrate \
 *     --in  .claude/claude-tpm/sessions/session-0021 \
 *     --out-dir /tmp/migrated
 */
const fs = require('fs');
const path = require('path');

const { atomicWriteFileSync } = require('../lib/io');
const { KNOWN_KINDS, writeEnvelope } = require('../lib/envelope');
const { validateEnvelope } = require('../lib/validate');
const { validatePayload, SESSION_KIND, isIsoTz } = require('./lib/session-schema');
const { CURRENT } = require('../lib/version');
const { canonicalNumber, loadSession } = require('./lib/session-model');
const { nowIsoTz } = require('../lib/timestamp');
const { render } = require('./lib/session-converter');

const MID = '·'; // "·" middle dot   (punchlist "#id · text")
const EMD = '—'; // "—" em dash      (decision "what — why")
const BANNER_RE = /^<!--\s*tpm-session:\s*(\S+)\b/;
// Trailing "  [slug, <iso-tz>]" (+ optional "(closed <iso-tz>)") — anchored to the END and
// requiring the 2nd bracket field to be a timestamp, so item text that itself contains "[x, y]"
// brackets can never be mistaken for the metadata bracket.
const PL_TAIL_RE = new RegExp(
  '\\[([^\\],]+),\\s*(\\d{4}-\\d{2}-\\d{2}T[^\\]]+)\\]\\s*(?:\\(closed\\s+([^)]+)\\))?\\s*$',
);
const TS_TAIL_RE = /\[(\d{4}-\d{2}-\d{2}T[^\]]+)\]\s*$/; // trailing "  [<iso-tz>]" (decisions/log)

class MigrateError extends Error {}
function refuse(msg) { throw new MigrateError(msg); }

// ── shape detection / refusal (Q-B: marked-3-file ONLY) ──────────────────────

/**
 * detectShape(inDir) -> { number, files } | throws MigrateError
 *
 * Accepts ONLY the clean marked 3-file shape:
 *   - exactly session-<NNNN>-{handoff,log,punchlist}.md for a single <NNNN>, each carrying the
 *     "<!-- tpm-session: NNNN … -->" banner, AND
 *   - NO stray legacy note files (handoff.md / punchlist.md / log.md / session-notes.md /
 *     notes.md / any *.txt / any other *.md) in the directory.
 * Anything else is REFUSED with a message naming what disqualified it.
 */
const TRACK_RECORD_RE = /^session-\d+(?:-[b-z])?\.(json|sealed)$/;
const SIBLING_TRACK_RE = /^session-\d+-[b-z]\.(json|md|sealed)$|^session-\d+\.sealed$/;

function detectShape(inDir) {
  let names;
  try {
    names = fs.readdirSync(inDir);
  } catch (e) {
    refuse(`cannot read --in '${inDir}': ${e.message}`);
  }
  // A folder of TRACK records is the CURRENT format (session-NNNN.json = track a, session-NNNN-b.json … = b..z, plus
  // .sealed markers). It is never a migration source: say so instead of calling it "mixed/pre-format". A folder that
  // still holds the legacy marked trio is judged as before.
  const trackRecords = names.filter((n) => TRACK_RECORD_RE.test(n));
  if (trackRecords.length && !names.some((n) => /^session-\d+-(handoff|log|punchlist)\.md$/.test(n))) {
    refuse(
      `refusing '${inDir}': this is a current-format session folder (${trackRecords.length} track record file(s): ` +
      `${trackRecords.slice(0, 6).join(', ')}${trackRecords.length > 6 ? ', ...' : ''}); there is nothing to migrate and nothing was touched.`,
    );
  }
  const mdFiles = names.filter((n) => n.toLowerCase().endsWith('.md'));
  const txtFiles = names.filter((n) => n.toLowerCase().endsWith('.txt'));
  const markedRe = /^session-(\d+)-(handoff|log|punchlist)\.md$/;

  const marked = {};       // number -> { handoff, log, punchlist }
  const strays = [];
  for (const n of mdFiles) {
    const m = markedRe.exec(n);
    if (m) {
      const num = m[1];
      (marked[num] = marked[num] || {})[m[2]] = n;
    } else {
      strays.push(n); // any unprefixed / off-pattern .md is a stray (mixed/2-file/freeform signal)
    }
  }

  if (txtFiles.length) {
    refuse(
      `refusing '${inDir}': freeform session (found .txt file(s): ${txtFiles.join(', ')}). ` +
      'Only the clean marked 3-file shape (session-<NNNN>-{handoff,log,punchlist}.md) is supported — ' +
      'convert this one by hand.',
    );
  }
  if (strays.length) {
    refuse(
      `refusing '${inDir}': mixed/pre-format session (stray note file(s): ${strays.join(', ')}). ` +
      'The clean marked 3-file shape must contain ONLY session-<NNNN>-{handoff,log,punchlist}.md — ' +
      'convert this one by hand.',
    );
  }

  const nums = Object.keys(marked);
  if (nums.length === 0) {
    refuse(
      `refusing '${inDir}': no marked session files found (expected ` +
      'session-<NNNN>-{handoff,log,punchlist}.md).',
    );
  }
  if (nums.length > 1) {
    refuse(`refusing '${inDir}': marked files for multiple session numbers (${nums.join(', ')}).`);
  }
  const number = nums[0];
  const trio = marked[number];
  const missing = ['handoff', 'log', 'punchlist'].filter((k) => !trio[k]);
  if (missing.length) {
    refuse(
      `refusing '${inDir}': incomplete marked 3-file set for ${number} — missing ` +
      `${missing.map((k) => `session-${number}-${k}.md`).join(', ')}.`,
    );
  }

  // Each of the three files must carry the detection banner.
  for (const k of ['handoff', 'log', 'punchlist']) {
    const p = path.join(inDir, trio[k]);
    const first = readFirstNonEmptyLine(p);
    if (!BANNER_RE.test(first)) {
      refuse(
        `refusing '${inDir}': ${trio[k]} lacks the "<!-- tpm-session: … -->" banner — ` +
        'not a marked 3-file session.',
      );
    }
  }
  return { number, files: trio };
}

function readFirstNonEmptyLine(p) {
  const text = fs.readFileSync(p, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() !== '') return line.trim();
  }
  return '';
}

// ── section splitting ────────────────────────────────────────────────────────

// Split a markdown body into { <heading-text-lowercased>: [lines…] } keyed by "## " headings.
// Banner (<!--), block-quote (>) and the top "# " title are dropped.
function sectionsOf(text) {
  const out = {};
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (/^<!--/.test(line)) continue;
    if (/^>/.test(line)) continue;
    const h2 = /^##\s+(.*)$/.exec(line);
    if (h2) { cur = h2[1].trim().toLowerCase(); out[cur] = []; continue; }
    if (/^#\s+/.test(line)) { cur = null; continue; } // top-level title
    if (cur) out[cur].push(line);
  }
  return out;
}

// ── handoff parsing ──────────────────────────────────────────────────────────

/**
 * parseHandoff(text, updatedAt) -> handoffObj | null
 *  where  ← "**Where we are:** …"      next ← "**Next action:**" (or "**Next:**")
 *  in_flight ← "**In flight:** a; b; c" (semicolon-joined)   must_not_redo ← "## MUST NOT redo" bullets
 * If where or next is missing/empty, returns null (a valid null handoff — lifecycle A3).
 */
function parseHandoff(text, updatedAt) {
  const lines = text.split(/\r?\n/);
  const field = (labels) => {
    for (const line of lines) {
      for (const label of labels) {
        if (line.startsWith(label)) return line.slice(label.length).trim();
      }
    }
    return '';
  };
  const where = field(['**Where we are:**']);
  const next = field(['**Next action:**', '**Next:**']);
  const inFlightRaw = field(['**In flight:**', '**In-flight:**']);
  const in_flight = splitSemis(inFlightRaw);

  const secs = sectionsOf(text);
  const mnrKey = Object.keys(secs).find((k) => k.replace(/[^a-z]/g, '').includes('mustnotredo'));
  const must_not_redo = mnrKey ? bulletsOf(secs[mnrKey]) : [];

  if (!where || !next) return null;
  return { where, next, in_flight, must_not_redo, updatedAt };
}

function splitSemis(s) {
  if (!s) return [];
  return s.split(';').map((x) => x.trim()).filter((x) => x !== '');
}

// Collect "- …" bullet bodies from a set of section lines (nested continuation lines dropped).
function bulletsOf(lines) {
  const out = [];
  for (const line of lines || []) {
    const m = /^-\s+(.*)$/.exec(line);
    if (m && m[1].trim() !== '') out.push(m[1].trim());
  }
  return out;
}

// ── log parsing ────────────────────────────────────────────────────────────

/**
 * parseLog(text) -> entries[]  (chronological, seq assigned by the caller after merge/sort)
 * Merges the "## Decisions" and "## Log" bullets into one timestamp-sorted ledger.
 *   decision line: "- **Decided:** <what> — <why>  [<iso-tz>]"  -> {type:'decision', what, why, ts}
 *   log line:      "- [STATUS] <text…>  [<iso-tz>]"             -> {type:'log', status, text, ts}
 */
function parseLog(text) {
  const secs = sectionsOf(text);
  const entries = [];

  const decKey = Object.keys(secs).find((k) => k.startsWith('decision'));
  for (const line of bulletsRaw(secs[decKey])) {
    entries.push(parseDecisionLine(line));
  }
  const logKey = Object.keys(secs).find((k) => k === 'log' || k.startsWith('log'));
  for (const line of bulletsRaw(secs[logKey])) {
    entries.push(parseLogLine(line));
  }
  return entries;
}

// Raw "- …" bullet lines (kept whole; parsed by the line parsers) from a section.
function bulletsRaw(lines) {
  const out = [];
  for (const line of lines || []) {
    if (/^-\s+/.test(line)) out.push(line.replace(/^-\s+/, ''));
  }
  return out;
}

function parseDecisionLine(body) {
  const tsm = TS_TAIL_RE.exec(body);
  if (!tsm) refuse(`decision line missing a trailing [ISO-TZ] timestamp: "${body}"`);
  const ts = tsm[1].trim();
  if (!isIsoTz(ts)) refuse(`decision line timestamp is not local-offset ISO-8601: "${ts}"`);
  let rest = body.slice(0, tsm.index).trim();
  rest = rest.replace(/^\*\*Decided:\*\*\s*/, '');
  const sep = rest.indexOf(` ${EMD} `);
  if (sep === -1) {
    refuse(`decision line missing the " ${EMD} " what/why separator: "${rest}"`);
  }
  const what = rest.slice(0, sep).trim();
  const why = rest.slice(sep + 3).trim();
  if (!what || !why) refuse(`decision line has an empty what or why: "${rest}"`);
  return { type: 'decision', what, why, ts };
}

function parseLogLine(body) {
  const tsm = TS_TAIL_RE.exec(body);
  if (!tsm) refuse(`log line missing a trailing [ISO-TZ] timestamp: "${body}"`);
  const ts = tsm[1].trim();
  if (!isIsoTz(ts)) refuse(`log line timestamp is not local-offset ISO-8601: "${ts}"`);
  let rest = body.slice(0, tsm.index).trim();
  const sm = /^\[([^\]]+)\]\s*(.*)$/.exec(rest); // leading [STATUS]
  let status;
  let textBody;
  if (sm) {
    status = sm[1].trim();
    textBody = sm[2].trim();
  } else {
    status = 'LOG';
    textBody = rest;
  }
  if (!textBody) refuse(`log line has no text body: "${body}"`);
  return { type: 'log', status, text: textBody, ts };
}

// ── punchlist parsing ────────────────────────────────────────────────────────

/**
 * parsePunchlist(text) -> items[]  (payload-shaped punchlist entries)
 *   Open line: "- [ ] #<id> · <text>  [<slug>, <iso-tz>]"
 *   Done line: "- [x] #<id> · <text>  [<slug>, <iso-tz>] (closed <iso-tz>)"
 * slug (lineage key) is PRESERVED verbatim; id kept as written; events synthesized (add [+ close]).
 */
function parsePunchlist(text) {
  const secs = sectionsOf(text);
  const items = [];
  const openKey = Object.keys(secs).find((k) => k === 'open' || k.startsWith('open'));
  const doneKey = Object.keys(secs).find((k) => k === 'done' || k.startsWith('done'));
  for (const line of bulletsRaw(secs[openKey])) items.push(parsePunchItem(line, 'open'));
  for (const line of bulletsRaw(secs[doneKey])) items.push(parsePunchItem(line, 'done'));
  return items;
}

function parsePunchItem(body, state) {
  // strip a leading checkbox "[ ] " / "[x] " if the raw bullet still carries it
  let rest = body.replace(/^\[[ xX]\]\s*/, '');
  const tailm = PL_TAIL_RE.exec(rest);
  if (!tailm) refuse(`punchlist item missing a trailing "[slug, ISO-TZ]" tag: "${body}"`);
  const slug = tailm[1].trim();
  const createdAt = tailm[2].trim();
  const closedAt = tailm[3] ? tailm[3].trim() : null;
  if (!isIsoTz(createdAt)) refuse(`punchlist item createdAt is not local-offset ISO-8601: "${createdAt}"`);
  if (closedAt && !isIsoTz(closedAt)) refuse(`punchlist item closed-ts is not local-offset ISO-8601: "${closedAt}"`);
  const head = rest.slice(0, tailm.index).trim();
  const hm = new RegExp(`^#(\\S+)\\s+${MID}\\s+(.*)$`).exec(head);
  if (!hm) refuse(`punchlist item head is not "#<id> ${MID} <text>": "${head}"`);
  const id = hm[1].trim();
  const itemText = hm[2].trim();
  if (!id || !itemText || !slug) refuse(`punchlist item has an empty id/text/slug: "${body}"`);

  const events = [{ ts: createdAt, op: 'add' }];
  if (state === 'done' && closedAt) events.push({ ts: closedAt, op: 'close' });
  return { id, slug, text: itemText, state, createdAt, events };
}

// ── sidecar (.current-session.json) — optional, per-dir ──────────────────────

function readSidecar(inDir) {
  const p = path.join(inDir, '.current-session.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_e) {
    return null; // a malformed sidecar is ignored (we fall back to timestamp derivation)
  }
}

// ── earliest real timestamp (openedAt derivation — Q-C: select, never synthesize) ──

function earliestTs(log, punchlist) {
  const stamps = [];
  for (const e of log) if (isIsoTz(e.ts)) stamps.push(e.ts);
  for (const it of punchlist) {
    if (isIsoTz(it.createdAt)) stamps.push(it.createdAt);
    for (const ev of it.events || []) if (isIsoTz(ev.ts)) stamps.push(ev.ts);
  }
  if (!stamps.length) return null;
  stamps.sort((a, b) => Date.parse(a) - Date.parse(b));
  return stamps[0];
}

/** latestTs(log, punchlist, sidecar) -> the latest REAL ISO-TZ stamp in the source, or null (never synthesized). */
function latestTs(log, punchlist, sidecar) {
  const stamps = [];
  for (const e of log) if (isIsoTz(e.ts)) stamps.push(e.ts);
  for (const it of punchlist) {
    if (isIsoTz(it.createdAt)) stamps.push(it.createdAt);
    for (const ev of it.events || []) if (isIsoTz(ev.ts)) stamps.push(ev.ts);
  }
  if (sidecar) for (const k of ['openedAt', 'closedAt']) if (isIsoTz(sidecar[k])) stamps.push(sidecar[k]);
  if (!stamps.length) return null;
  stamps.sort((a, b) => Date.parse(b) - Date.parse(a));
  return stamps[0];
}

// ── the parse → payload assembler ────────────────────────────────────────────

/**
 * parseOldSession({ inDir, number, now }) -> { record, notes }
 *
 * Detects + parses the marked 3-file session and assembles a canonical record. Does NOT write or
 * validate (runMigration does that). `notes` records provenance decisions (openedAt source, etc.).
 */
function parseOldSession(opts) {
  const options = opts || {};
  const inDir = options.inDir;
  if (!inDir) refuse('parseOldSession: inDir is required');
  // handoff.updatedAt: an injected --now wins (the golden pins it). Otherwise carry the SOURCE's real last-write
  // time so a migrated legacy session is not stamped "just now" (which made it look left-open in a later pickup);
  // fall back to now only when the source holds no real stamp.
  let now = options.now;

  const shape = detectShape(inDir);
  const bannerNumber = shape.number;
  const rawNumber = options.number != null && options.number !== '' ? String(options.number) : bannerNumber;

  // Validate the parsed number BEFORE canonicalNumber (which would coerce loose input like
  // ""/null -> "0000" or hex): only a clean non-negative integer string is allowed.
  if (!/^\d+$/.test(String(rawNumber).trim())) {
    refuse(`unparseable session number ${JSON.stringify(rawNumber)} — expected digits only (NNNN).`);
  }
  const number = canonicalNumber(rawNumber.trim());

  const handoffText = fs.readFileSync(path.join(inDir, shape.files.handoff), 'utf8');
  const logText = fs.readFileSync(path.join(inDir, shape.files.log), 'utf8');
  const punchText = fs.readFileSync(path.join(inDir, shape.files.punchlist), 'utf8');

  // log: merge decisions + log, sort chronologically, assign monotonic seq (robust to the file's
  // physical ordering — the source's "reads bottom-to-top" note is not relied on).
  const logEntries = parseLog(logText);
  logEntries.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const log = logEntries.map((e, i) => {
    const base = { seq: i + 1, ts: e.ts, type: e.type };
    if (e.type === 'decision') { base.what = e.what; base.why = e.why; }
    else { base.status = e.status; base.text = e.text; }
    return base;
  });

  const punchlist = parsePunchlist(punchText);

  const notes = [];
  const sidecar = readSidecar(inDir);
  const sessionIds = sidecar && sidecar.sessionId ? [String(sidecar.sessionId)] : [];
  if (sessionIds.length) notes.push(`meta.sessionIds from sidecar sessionId`);
  else notes.push('meta.sessionIds = [] (no per-dir .current-session.json sidecar)');

  // openedAt: sidecar (if a real ISO-TZ) else earliest real timestamp in the data. NEVER synthesized.
  let openedAt = null;
  if (sidecar && isIsoTz(sidecar.openedAt)) {
    openedAt = sidecar.openedAt;
    notes.push('meta.openedAt from sidecar.openedAt');
  } else {
    openedAt = earliestTs(log, punchlist);
    if (openedAt) notes.push(`meta.openedAt derived from earliest real timestamp (${openedAt})`);
  }
  if (!openedAt) {
    refuse(
      'cannot fill meta.openedAt: no real timestamp found in the session (no sidecar, no log/' +
      'punchlist stamps) and Q-C forbids synthesizing one. Convert this session by hand.',
    );
  }

  // closedAt: sidecar (if a real ISO-TZ) else null. A "SEALED <date>" line is date-only → NOT
  // synthesized (Q-C) → left null.
  let closedAt = null;
  if (sidecar && isIsoTz(sidecar.closedAt)) {
    closedAt = sidecar.closedAt;
    notes.push('meta.closedAt from sidecar.closedAt');
  } else {
    notes.push('meta.closedAt = null (no real close timestamp; SEALED date-only is not synthesized)');
  }

  if (!now) {
    now = latestTs(log, punchlist, sidecar);
    if (now) notes.push(`handoff.updatedAt = latest real source timestamp (${now}), not the migration time`);
    else { now = nowIsoTz(); notes.push('handoff.updatedAt = migration time (the source holds no real timestamp)'); }
  }
  const handoff = parseHandoff(handoffText, now);
  if (!handoff) notes.push('handoff = null (source lacked a usable Where/Next)');

  const record = {
    schemaVersion: CURRENT,
    kind: SESSION_KIND,
    meta: {
      number,
      sessionIds,
      openedAt,
      closedAt,
      tpmVersion: '0.0.0-legacy', // sentinel: the note's "tpm-session-version" is a NOTE-format
                                  // version, NOT the writer version — do not conflate.
    },
    handoff,
    log,
    punchlist,
  };
  return { record, notes };
}

// ── the migrate operation ────────────────────────────────────────────────────

function resolve(p) { return path.resolve(p); }

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Refuse an --out-dir that resolves inside a live .claude/claude-tpm/sessions tree.
function looksLikeLiveSessions(outDir) {
  const norm = resolve(outDir).split(path.sep).join('/');
  return /(^|\/)\.claude\/claude-tpm\/sessions(\/|$)/.test(norm);
}

/**
 * runMigration(opts) -> { record, notes, outPath, mdPath, written, valid }
 *   opts.inDir     — REQUIRED old-session dir (read-only).
 *   opts.outDir    — REQUIRED output dir (write-only; must differ from inDir + not live sessions).
 *   opts.number    — OPTIONAL number override.
 *   opts.dryRun    — validate + report, write nothing.
 *   opts.emitMd    — also write the derived session-<NNNN>.md via the converter. DEFAULT true; pass
 *                    `false` (CLI `--no-emit-md`) to opt out.
 *   opts.force     — overwrite an existing output file.
 *   opts.now       — overrides handoff.updatedAt (default: the source's latest log/punchlist/sidecar timestamp, nowIsoTz() only if none; injectable).
 *   opts.loadSession — injected loader (default session-model.loadSession) for the post-write check.
 */
function runMigration(opts) {
  const options = opts || {};
  const { inDir, outDir } = options;
  if (!inDir) refuse('--in is required (no default)');
  if (!outDir) refuse('--out-dir is required (no default)');
  if (resolve(inDir) === resolve(outDir) || isInside(resolve(outDir), resolve(inDir))) {
    refuse(`--out-dir '${outDir}' is (or is inside) --in '${inDir}'; write output somewhere else.`);
  }
  if (looksLikeLiveSessions(outDir)) {
    refuse(`--out-dir '${outDir}' resolves inside a live .claude/claude-tpm/sessions tree — refusing to write there.`);
  }

  const { record, notes } = parseOldSession({ inDir, number: options.number, now: options.now });

  // VALIDATE-BEFORE-WRITE — fail loud naming the unfillable field; never write an invalid file.
  validateEnvelope(record, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });

  // CANONICAL NESTED layout (json-format-spec, Q-F): write into the session's OWN per-session folder
  // <outDir>/session-<NNNN>/session-<NNNN>.json (+ .md on --emit-md).
  const sessionDir = path.join(outDir, `session-${record.meta.number}`);
  const outPath = path.join(sessionDir, `session-${record.meta.number}.json`);
  // #4 (smoke): the derived .md is emitted BY DEFAULT (the rest of the tooling assumes the .md half
  // exists); only an explicit `emitMd:false` (CLI `--no-emit-md`) opts out.
  const emitMd = options.emitMd !== false;
  const mdPath = emitMd ? path.join(sessionDir, `session-${record.meta.number}.md`) : null;

  // Migrating INTO a session folder that already holds other tracks (parallel instances) or a seal marker would
  // plant an unowned live track a beside them. Refused explicitly, even with --force: pick a different --out-dir
  // (or number) instead. A folder holding only a previous migration of this session (track a) is still fine.
  let existing = [];
  try { existing = fs.readdirSync(sessionDir); } catch (_e) { /* the folder does not exist yet */ }
  const siblings = existing.filter((n) => SIBLING_TRACK_RE.test(n));
  if (siblings.length) {
    refuse(
      `refusing to migrate into '${sessionDir}': it already holds other track file(s) (${siblings.slice(0, 6).join(', ')}` +
      `${siblings.length > 6 ? ', ...' : ''}). A migrated session would add an unowned track a beside live or sealed tracks. ` +
      'Nothing was written; choose a different --out-dir.',
    );
  }

  if (!options.dryRun) {
    if (fs.existsSync(outPath) && !options.force) {
      refuse(`output '${outPath}' already exists — pass --force to overwrite.`);
    }
    fs.mkdirSync(sessionDir, { recursive: true });
    writeEnvelope(outPath, record); // ATOMIC canonical write
    if (mdPath) {
      const now = options.now || nowIsoTz();
      atomicWriteFileSync(mdPath, render(record, { now })); // derived .md — atomic
    }
    // Round-trip proof: the file we just wrote loads cleanly through the canonical load path.
    const load = typeof options.loadSession === 'function' ? options.loadSession : loadSession;
    load(outPath);
  }

  return {
    record,
    notes,
    outPath,
    mdPath,
    written: !options.dryRun,
    valid: true,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--in': opts.inDir = next(); break;
      case '--out-dir': opts.outDir = next(); break;
      case '--number': opts.number = next(); break;
      case '--now': opts.now = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--emit-md': opts.emitMd = true; break;          // #4: default now ON — kept for back-compat / explicitness
      case '--no-emit-md': opts.emitMd = false; break;      // #4: opt OUT of the derived .md
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument '${a}'`);
    }
  }
  return opts;
}

const USAGE = `tpm-session-migrate — OPT-IN old→new session migrator (#1114.C)
  run: tpm session migrate --in <dir> --out-dir <dir> [flags]

  --in <dir>       REQUIRED  old marked 3-file session dir (READ-ONLY)
  --out-dir <dir>  REQUIRED  where session-<NNNN>.json is written (must differ from --in;
                             refused inside a live .claude/claude-tpm/sessions tree)
  --number NNNN    override the session number (else parsed from the banner)
  --dry-run        validate + report; write nothing
  --emit-md        also write the derived human-readable session-<NNNN>.md (DEFAULT: on)
  --no-emit-md     opt OUT of writing the derived .md (write only the canonical .json)
  --force          overwrite an existing output file
  --now <iso>      overrides handoff.updatedAt (default: source's latest timestamp; now only if it has none)
  --help           show this usage

Convert-on-demand ONLY: one explicit target per run; NO scan-and-auto-convert (that suggest-only
behavior is the doctor's, #1119). Only the clean marked 3-file shape is accepted; mixed/2-file/
freeform sessions are refused. No historical timestamps are ever synthesized (Q-C).`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write('tpm-session-migrate: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    const res = runMigration(opts);
    const lines = [];
    lines.push(`session ${res.record.meta.number} — ${res.written ? 'WROTE' : 'DRY-RUN (nothing written)'}`);
    lines.push(`  out:        ${res.outPath}`);
    if (res.mdPath) lines.push(`  derived md: ${res.mdPath}`);
    lines.push(`  validation: PASS (schema ${res.record.schemaVersion}, kind ${res.record.kind})`);
    lines.push(`  log:        ${res.record.log.length} entr${res.record.log.length === 1 ? 'y' : 'ies'}`);
    lines.push(`  punchlist:  ${res.record.punchlist.length} item(s)`);
    lines.push(`  handoff:    ${res.record.handoff ? 'present' : 'null'}`);
    for (const n of res.notes) lines.push(`  note:       ${n}`);
    process.stderr.write(lines.join('\n') + '\n');
    return 0;
  } catch (e) {
    const tag = e instanceof MigrateError ? 'tpm-session-migrate (refused)' : 'tpm-session-migrate';
    process.stderr.write(tag + ': ' + String(e.message) + '\n');
    return 1;
  }
}

module.exports = {
  runMigration,
  parseOldSession,
  detectShape,
  parseHandoff,
  parseLog,
  parsePunchlist,
  earliestTs,
  MigrateError,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
