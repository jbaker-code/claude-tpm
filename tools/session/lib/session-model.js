'use strict';
/**
 * session-model.js — the bidirectional `kind:"session"` model surface: load / save / apply /
 * export-shape / import + the mechanical ops (punchlist add/close/reopen/drop/carry-in, log
 * append-only, handoff replace, open/resume/close). Kind-SPECIFIC (P03). Built on the
 * promoted kind-agnostic base lib in this same `lib/` dir (required as siblings; base-lib
 * files are NOT modified).
 *
 * ── CRITICAL LOAD-PATH CONTRACT (verifier concern C1, decisions.md) ──
 * The canonical load path is  read → migrate → validate.  The refuse-unknown-NEWER guard
 * lives in `version.migrate` (NOT in `readEnvelope`), so if migrate is skipped the guard
 * never fires and old code could silently read (and later destroy) newer data. loadSession
 * therefore runs migrate BETWEEN read and validate. Proven by session-model.test.js.
 *
 * ── PAYLOAD SHAPE ── top-level siblings meta/handoff/log/punchlist (see session-schema.js).
 *
 * saveSession's human-file regeneration is DEFERRED to P04's converter (session-converter.js,
 * not built in this phase). Rather than hard-`require` an unbuilt module, saveSession accepts
 * an OPTIONAL injected `render` fn (deviation raised in HANDOFF): canonical JSON is written
 * atomically FIRST, then — only on success, and only if both `mdPath` and `render` are given —
 * the derived human file is regenerated. P04/P06 inject `session-converter.render`.
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */
const fs = require('fs');

const { atomicWriteFileSync } = require('../../lib/io');
const { readEnvelope, writeEnvelope, KNOWN_KINDS } = require('../../lib/envelope');
const { migrate, CURRENT } = require('../../lib/version');
const { validateEnvelope } = require('../../lib/validate');
const { applyUpdate } = require('../../lib/update');
const { normalizeArray } = require('../../lib/normalize');
const { nowIsoTz } = require('../../lib/timestamp');
const { SESSION_KIND, EDITABLE_TABLE, validatePayload } = require('./session-schema');
const ids = require('./session-ids');

// Local deep clone (JSON-serialisable records only — matches the canonical store). Kept
// suite-local rather than reaching into the base `_util` (suite-internal, not public API).
function deepClone(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

// ── IO surface ─────────────────────────────────────────────────────────────

/**
 * loadSession(jsonPath) -> record
 *
 * The canonical load path: read → migrate → validate (honors C1). `readEnvelope` fails loud
 * on a missing/corrupt file; `migrate` refuses an unknown NEWER schemaVersion (and would
 * upgrade an older-but-known one); `validateEnvelope` runs the session payload validator and
 * the known-kind gate. Returns the migrated + validated full record.
 */
function loadSession(jsonPath) {
  const env = readEnvelope(jsonPath);          // read  (fail-loud; asserts schemaVersion+kind)
  const migrated = migrate(env._raw);          // migrate  ← refuse-unknown-newer guard fires HERE
  validateEnvelope(migrated, {                 // validate
    payloadValidator: validatePayload,
    knownKinds: KNOWN_KINDS,
  });
  return migrated;
}

/**
 * saveSession(record, { jsonPath, mdPath, render }) -> record (the persisted record)
 *
 *  1. stamp handoff.updatedAt (only if a handoff is present) via nowIsoTz;
 *  2. validate the payload (defensive — never persist a malformed canonical file);
 *  3. writeEnvelope(jsonPath, record)  ← ATOMIC, canonical FIRST (temp→fsync→rename);
 *  4. ONLY on success, and only if `mdPath` AND `render` are both supplied, regenerate the
 *     derived human file (disposable; the JSON is the source of truth).
 *
 * Does NOT mutate the caller's record (works on a clone). Returns the persisted record so a
 * round-trip identity check can compare exactly what was written against what reloads (a
 * backward-compatible superset of the plan's `void`).
 */
function saveSession(record, opts) {
  const options = opts || {};
  const { jsonPath, mdPath, render } = options;
  if (!jsonPath) throw new Error('saveSession: opts.jsonPath is required');

  const out = deepClone(record);
  // OPT-IN B2 stamp (tracks store): only when the caller passes `lastWriter: { version }` do we set
  // meta.lastWriter = { version, at }. Without the option the function is byte-stable (unconditional
  // stamping broke the round-trip-identity test). ops.persist passes it; the model never does by itself.
  if (options.lastWriter && out && out.meta && typeof out.meta === 'object') {
    out.meta.lastWriter = {
      version: options.lastWriter.version === undefined ? null : options.lastWriter.version,
      at: nowIsoTz(),
    };
  }
  if (out && out.handoff !== null && out.handoff !== undefined) {
    out.handoff.updatedAt = nowIsoTz();
  }
  validateEnvelope(out, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
  writeEnvelope(jsonPath, out);                 // atomic canonical write FIRST
  if (mdPath && typeof render === 'function') {
    atomicWriteFileSync(mdPath, render(out));   // derived file — regenerated only AFTER JSON ok (atomic: readers never see a torn .md)
  }
  return out;
}

// ── bidirectional edit surface (import + export aware) ───────────────────────

/**
 * applySession(record, patch) -> record (a NEW record)
 *
 * Pure editable-table filter over the LOCKED EDITABLE_TABLE: sets ONLY the replace-mode
 * handoff fields (where/next/in_flight/must_not_redo). Array-element editables (log[]/
 * punchlist[]) and every mechanical field are IGNORED even if supplied (that is the whole
 * point of the table). string[] fields are normalised. No clock dependency — updatedAt is
 * stamped by saveSession, keeping this deterministic for the editable-enforcement test.
 */
function applySession(record, patch) {
  return applyUpdate(record, patch, { editableTable: EDITABLE_TABLE, kind: SESSION_KIND });
}

/**
 * exportSession(record, { style, render }) -> object | string
 *   style "json"  -> the full canonical envelope (deep clone).
 *   style "human" -> render(record); requires an injected converter (P04) — throws loud if
 *                    none is supplied (the converter is not built in this phase).
 */
function exportSession(record, opts) {
  const options = opts || {};
  const style = options.style || 'json';
  if (style === 'json') return deepClone(record);
  if (style === 'human') {
    if (typeof options.render !== 'function') {
      throw new Error('exportSession: style "human" requires an injected `render` converter (P04)');
    }
    return options.render(record);
  }
  throw new Error(`exportSession: unknown style '${style}' (expected "json" | "human")`);
}

/**
 * importHandoff(record, handoffObj) -> record (a NEW record)
 *
 * REPLACE-semantics: overwrites handoff wholesale from the EDITABLE fields ONLY
 * (where/next/in_flight/must_not_redo — mechanical fields in `handoffObj` are ignored),
 * normalising the two arrays, and re-stamps updatedAt. Never touches punchlist state.
 */
function importHandoff(record, handoffObj) {
  const src = handoffObj || {};
  const out = deepClone(record);
  out.handoff = {
    where: src.where,
    next: src.next,
    in_flight: normalizeArray(src.in_flight),
    must_not_redo: normalizeArray(src.must_not_redo),
    updatedAt: nowIsoTz(),
  };
  return out;
}

/**
 * importLogAddendum(record, entries[]) -> record (a NEW record)
 *
 * APPEND-ONLY: for each entry allocate seq = max(existing seq)+1 (monotonic), stamp ts, and
 * copy ONLY the editable body (decision→what/why | log→status/text). Any seq/ts supplied on
 * the incoming entry is mechanical and IGNORED. Existing entries are NEVER rewritten.
 */
function importLogAddendum(record, entries) {
  const out = deepClone(record);
  if (!Array.isArray(out.log)) out.log = [];
  const list = Array.isArray(entries) ? entries : [entries];
  for (const e of list) {
    out.log.push(buildLogEntry(out, e));
  }
  return out;
}

/**
 * importPunchlist(record, items[]) -> record (a NEW record)
 *
 * ADD items: mint a slug (once, never reused), assign a session-prefixed id, set the editable
 * text, default state "open", and stamp an {op:"add"} event. IMPORT NEVER SETS state (only the
 * mechanical close/reopen/drop ops do).
 */
function importPunchlist(record, items) {
  let out = deepClone(record);
  const list = Array.isArray(items) ? items : [items];
  for (const it of list) {
    out = addPunchlist(out, { text: it && it.text, slug: it && it.slug });
  }
  return out;
}

// ── mechanical ops (state the tool stamps) ───────────────────────────────────

/**
 * openSession({ number, sessionId, tpmVersion, priorSession?, priorSessionPath? }) -> record
 *
 * A fresh session envelope (lifecycle A3): meta stamped, handoff:null, log:[], punchlist:[].
 * If a prior session is supplied (record via `priorSession`, or a path via `priorSessionPath`),
 * its still-OPEN punchlist items are physically COPIED forward (same slug, new id, {op:"carry-in"}
 * event) so this session's JSON is self-contained.
 */
function openSession(spec) {
  const s = spec || {};
  if (!s.number) throw new Error('openSession: `number` is required');
  if (!s.sessionId) throw new Error('openSession: `sessionId` is required');
  let record = {
    schemaVersion: CURRENT,
    kind: SESSION_KIND,
    meta: {
      number: canonicalNumber(s.number),
      sessionIds: [s.sessionId],
      openedAt: nowIsoTz(),
      closedAt: null,
      tpmVersion: s.tpmVersion || '0.0.0',
    },
    handoff: null,
    log: [],
    punchlist: [],
  };

  let prior = s.priorSession;
  if (!prior && s.priorSessionPath) prior = loadSession(s.priorSessionPath);
  if (prior && Array.isArray(prior.punchlist)) {
    const fromSession = ids.fromSessionLabel(prior.meta);   // source session (+ track letter for b..z) (P06 fromSession)
    for (const item of prior.punchlist) {
      if (item && item.state === 'open') record = carryInPunchlist(record, item, fromSession);
    }
  }
  return record;
}

/**
 * openTrack({ number, track = 'a', identity, tpmVersion, lastWriterVersion, now?, priorSession?, priorSessionPath? }) -> record
 *
 * The record factory of the tracks store: the same envelope as openSession plus the ADDITIVE per-track
 * `meta` keys (track, claudeSessionId, claudePid, claudePidStartedAt, hostname, lastWriter). Every identity
 * field may be null — a null never blocks. A claimed/parallel track carries NO items (Q6) — a prior
 * session is consulted only when explicitly passed (the legacy manual `open --prior-session-path`).
 * `meta.tpmVersion` keeps today's meaning ("0.0.0" when not given); the B2 stamp is `meta.lastWriter`.
 */
function openTrack(spec) {
  const s = spec || {};
  if (!s.number) throw new Error('openTrack: `number` is required');
  const track = s.track === undefined || s.track === null ? 'a' : s.track;
  if (!/^[a-z]$/.test(String(track))) throw new Error(`openTrack: track must be one letter a-z, got ${JSON.stringify(s.track)}`);
  const id = s.identity && typeof s.identity === 'object' ? s.identity : {};
  const claudeSessionId = typeof id.claudeSessionId === 'string' && id.claudeSessionId ? id.claudeSessionId : null;
  const at = s.now || nowIsoTz();
  let record = {
    schemaVersion: CURRENT,
    kind: SESSION_KIND,
    meta: {
      number: canonicalNumber(s.number),
      track,
      sessionIds: claudeSessionId ? [claudeSessionId] : [],
      claudeSessionId,
      claudePid: id.claudePid === undefined ? null : id.claudePid,
      claudePidStartedAt: id.claudePidStartedAt === undefined ? null : id.claudePidStartedAt,
      hostname: id.hostname === undefined ? null : id.hostname,
      openedAt: at,
      closedAt: null,
      tpmVersion: s.tpmVersion || '0.0.0',
      lastWriter: { version: s.lastWriterVersion === undefined ? null : s.lastWriterVersion, at },
    },
    handoff: null,
    log: [],
    punchlist: [],
  };
  let prior = s.priorSession;
  if (!prior && s.priorSessionPath) prior = loadSession(s.priorSessionPath);
  if (prior && Array.isArray(prior.punchlist)) {
    const fromSession = ids.fromSessionLabel(prior.meta);   // '0001' for track a / legacy, '0001b' for b..z: the track of origin survives
    for (const item of prior.punchlist) {
      if (item && item.state === 'open') record = carryInPunchlist(record, item, fromSession);
    }
  }
  return record;
}

/** validateRecord(record) -> void   the same envelope+payload validation saveSession runs (throws loud). */
function validateRecord(record) {
  validateEnvelope(record, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
}

/**
 * resumeSession(record, sessionId) -> record (a NEW record)
 * Appends sessionId to meta.sessionIds if not already present (grows on resume across
 * Claude Code processes; diagnostic).
 */
function resumeSession(record, sessionId) {
  const out = deepClone(record);
  if (!Array.isArray(out.meta.sessionIds)) out.meta.sessionIds = [];
  if (sessionId && !out.meta.sessionIds.includes(sessionId)) out.meta.sessionIds.push(sessionId);
  return out;
}

/**
 * appendLog(record, { type, what, why, status, text }) -> record (a NEW record)
 * APPEND-ONLY with a monotonic seq = max(existing)+1 and a fresh ts.
 */
function appendLog(record, entry) {
  const out = deepClone(record);
  if (!Array.isArray(out.log)) out.log = [];
  out.log.push(buildLogEntry(out, entry));
  return out;
}

// Build a single append-only log entry against `record` (allocates the next monotonic seq).
// Ignores any caller-supplied seq/ts (mechanical). type defaults per which body is present.
function buildLogEntry(record, entry) {
  const e = entry || {};
  const nextSeq = maxSeq(record.log) + 1;
  const type = e.type || (e.what !== undefined || e.why !== undefined ? 'decision' : 'log');
  const base = { seq: nextSeq, ts: nowIsoTz(), type };
  if (type === 'decision') {
    base.what = e.what;
    base.why = e.why;
  } else if (type === 'log') {
    base.status = e.status;
    base.text = e.text;
  } else {
    throw new Error(`appendLog: type must be "decision" | "log", got ${JSON.stringify(type)}`);
  }
  return base;
}

function maxSeq(log) {
  if (!Array.isArray(log) || log.length === 0) return 0;
  return log.reduce((m, e) => (Number.isInteger(e.seq) && e.seq > m ? e.seq : m), 0);
}

/**
 * addPunchlist(record, { text, slug? }) -> record (a NEW record)
 * Mint a slug (lineage key; `slug` override accepted for deterministic tests), assign a
 * session-prefixed id ("<number>.<n>"), state "open", stamp an {op:"add"} event.
 */
function addPunchlist(record, spec) {
  const s = spec || {};
  const out = deepClone(record);
  if (!Array.isArray(out.punchlist)) out.punchlist = [];
  const ts = nowIsoTz();
  out.punchlist.push({
    id: nextItemId(out),
    slug: s.slug || mintSlug(out),
    text: s.text,
    state: 'open',
    createdAt: ts,
    events: [{ ts, op: 'add' }],
  });
  return out;
}

/**
 * carryInPunchlist(record, sourceItem, fromSession?) -> record (a NEW record)
 * Physical copy of a still-open prior item: SAME slug (lineage key preserved), a NEW
 * session-prefixed id, this session's createdAt, state reset to "open", and a fresh
 * {op:"carry-in"} event trail (prior events stay in the prior session's JSON; cross-session
 * lineage reconstructs by folding on the shared slug). (O4.)
 *
 * P06 fromSession provenance: when the SOURCE session number is known (openSession passes
 * `prior.meta.number`), it is stamped on the carry-in event as `fromSession` so the converter
 * can render "⤴ _carried from NNNN_". Omitted (undefined/null/'') -> event carries no
 * fromSession and the converter falls back to the bare "⤴ _carried_" marker.
 */
function carryInPunchlist(record, sourceItem, fromSession) {
  const src = sourceItem || {};
  const out = deepClone(record);
  if (!Array.isArray(out.punchlist)) out.punchlist = [];
  const ts = nowIsoTz();
  const event = { ts, op: 'carry-in' };
  if (fromSession !== undefined && fromSession !== null && String(fromSession) !== '') {
    event.fromSession = String(fromSession);   // source session number (provenance)
  }
  out.punchlist.push({
    id: nextItemId(out),
    slug: src.slug,               // SAME slug — lineage primary key, never reused
    text: src.text,
    state: 'open',
    createdAt: ts,
    events: [event],
  });
  return out;
}

function setPunchlistState(record, idOrSlug, state, op) {
  const out = deepClone(record);
  const item = findItem(out, idOrSlug);
  if (!item) throw new Error(`punchlist op: no item matching '${idOrSlug}'`);
  item.state = state;
  item.events.push({ ts: nowIsoTz(), op });
  return out;
}

function closePunchlistItem(record, idOrSlug) { return setPunchlistState(record, idOrSlug, 'done', 'close'); }
function reopenPunchlistItem(record, idOrSlug) { return setPunchlistState(record, idOrSlug, 'open', 'reopen'); }
function dropPunchlistItem(record, idOrSlug) { return setPunchlistState(record, idOrSlug, 'dropped', 'drop'); }

/**
 * closeSession(record) -> record (a NEW record)
 * Stamp meta.closedAt = nowIsoTz. The #1115 close-guard (handoff + punchlist presence) is a
 * P06 tool concern, NOT enforced here.
 */
function closeSession(record) {
  const out = deepClone(record);
  out.meta.closedAt = nowIsoTz();
  return out;
}

// ── small helpers ────────────────────────────────────────────────────────────

/**
 * canonicalNumber(n) -> string  (the LOCKED canonical stored form of a session number)
 *
 * Zero-padded width-4 STRING ("0031" — never the integer 31, never the un-padded "31").
 * Locked decision (Jason, 2026-09-20, session 0022): session names, folder names, filenames, AND
 * the stored `meta.number` are ALL `NNNN`. Accepts an integer or any integer-valued string and
 * normalizes to this one canonical form, so `openSession({number:"31"})` and
 * `openSession({number:"0031"})` (and `openSession({number:31})`) all STORE `"0031"`. Numbers
 * wider than 4 digits keep their natural width. Throws loud on a non-integer / negative input so a
 * malformed number can never reach the canonical store. Filename/folder derivation is independent
 * (ops + export re-pad via their own `padNumber`), so the on-disk name is `session-0031.json`
 * regardless of the input form; this helper only fixes the STORED field.
 */
function canonicalNumber(n) {
  const num = Number(n);
  if (!Number.isInteger(num) || num < 0) {
    throw new Error(`session number must be a non-negative integer (got ${JSON.stringify(n)})`);
  }
  return String(num).padStart(4, '0');
}

// Friendly session-prefixed id "<number>.<n>": number stripped of zero-padding, n monotonic
// within the session (max existing suffix + 1). Reuse-after-drop is a later refinement.
// Track-aware (stored form): track a / legacy -> "123.4" (unchanged); track b..z -> "123b.4", so two
// tracks of one session never mint the same id. The shape is defined once, in session-ids.js.
function nextItemId(record) {
  const prefix = ids.storedPrefix(record.meta.number, record.meta && record.meta.track);
  let maxN = 0;
  for (const it of record.punchlist || []) {
    const m = /^(\d+[a-z]?)\.(\d+)$/.exec(String(it.id));
    if (m && m[1] === prefix) maxN = Math.max(maxN, Number(m[2]));
  }
  return `${prefix}.${maxN + 1}`;
}

// Mint a 6-char base36 slug, unique within this record's punchlist (lineage key; minted once).
function mintSlug(record) {
  const existing = new Set((record.punchlist || []).map((it) => it.slug));
  for (let tries = 0; tries < 1000; tries++) {
    const slug = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    if (!existing.has(slug)) return slug;
  }
  throw new Error('mintSlug: could not mint a unique slug');
}

// findItem: (1) an exact id or slug match first (a legacy id or a slug that merely looks like an id keeps working);
// (2) else, when the input is id-shaped, the canonical form: `123a.4`, `#123.4` and `0123.4` all find stored `123.4`.
function findItem(record, idOrSlug) {
  const list = record.punchlist || [];
  const exact = list.find((it) => it.id === idOrSlug || it.slug === idOrSlug);
  if (exact) return exact;
  const parsed = ids.parseItemId(idOrSlug);
  if (!parsed) return undefined;
  return list.find((it) => it.id === parsed.stored);
}

module.exports = {
  // IO
  loadSession,
  saveSession,
  // bidirectional edit
  applySession,
  exportSession,
  importHandoff,
  importLogAddendum,
  importPunchlist,
  // mechanical ops
  openSession,
  openTrack,
  validateRecord,
  canonicalNumber,
  resumeSession,
  appendLog,
  addPunchlist,
  carryInPunchlist,
  closePunchlistItem,
  reopenPunchlistItem,
  dropPunchlistItem,
  closeSession,
  findItem,
};
