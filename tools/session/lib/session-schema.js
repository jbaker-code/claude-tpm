'use strict';
/**
 * session-schema.js — the `kind:"session"` payload schema + THE editable-field table +
 * lifecycle rules. Kind-SPECIFIC (P03). Built on the promoted, kind-agnostic base lib in
 * this same `lib/` dir (required as siblings; base-lib files are NOT modified).
 *
 * ── LOCKED PAYLOAD SHAPE (json-format-spec.md, P02→P03 nesting ruling 2026-09-19) ──
 * The canonical record is the ENVELOPE (`schemaVersion` + `kind`) with FOUR top-level
 * SIBLING blocks — NOT nested under a `session` key:
 *
 *   { schemaVersion, kind:"session", meta:{…}, handoff:{…}|null, log:[…], punchlist:[…] }
 *
 * `meta` is the mechanical metadata block, RENAMED from `session` to avoid colliding with
 * `kind:"session"` (decisions.md "Raise to user" → resolved: keep top-level siblings, rename
 * the metadata object to `meta`).
 *
 * COLLISION CONSEQUENCE (why validatePayload reads the 2nd arg): the base `readEnvelope`
 * returns `payload = record[kind]` = `record["session"]`, which no longer exists (renamed to
 * `meta`) → `payload` is `undefined`. The base `validateEnvelope` calls
 * `payloadValidator(record[kind], record)`, passing the FULL record as the 2nd arg exactly so
 * a sibling-shape kind can validate off the whole record. So validatePayload here operates on
 * the full record (2nd arg), and is also directly callable as `validatePayload(record)`.
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */
const { KNOWN_KINDS } = require('../../lib/envelope');

const SESSION_KIND = 'session';

/**
 * THE editable-field table — the SINGLE source of truth for (a) what a thin export emits,
 * (b) what an import may set, (c) what the tool stamps & therefore IGNORES on import
 * (json-format-spec "Field reference — editable vs mechanical"). Encoded verbatim from the
 * LOCKED table. Paths resolve against the record ROOT (top-level siblings), matching the
 * base `update.js` path resolution.
 *
 * mode: "replace" (handoff, whole-field overwrite) | "append" (log, new entries only) |
 *       "add" (punchlist, new items only). The generic base layer performs ONLY "replace"
 *       on scalar/array paths; "append"/"add" keys carry "[]" and are handled by the kind's
 *       mechanical ops (appendLog / addPunchlist / import*), never by a blind patch.
 * EVERYTHING NOT IN THIS TABLE IS MECHANICAL (stamped; ignored on import even if supplied).
 */
const EDITABLE_TABLE = {
  'handoff.where':         { edit: 'replace', type: 'string' },
  'handoff.next':          { edit: 'replace', type: 'string' },
  'handoff.in_flight':     { edit: 'replace', type: 'string[]' },
  'handoff.must_not_redo': { edit: 'replace', type: 'string[]' },
  'log[].what':            { edit: 'append',  type: 'string' },   // req if type==="decision"
  'log[].why':             { edit: 'append',  type: 'string' },
  'log[].status':          { edit: 'append',  type: 'string' },   // req if type==="log"; free-form (O3)
  'log[].text':            { edit: 'append',  type: 'string' },
  'punchlist[].text':      { edit: 'add',     type: 'string' },
  // EVERYTHING ELSE = mechanical (stamped; ignored on import).
};

// ── local validation helpers ──────────────────────────────────────────────

const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?[+-]\d{2}:\d{2}$/;

/** ISO-8601 WITH an explicit local offset (never bare/UTC-Z). (A2 / #1116 B.) */
function isIsoTz(s) {
  return typeof s === 'string' && ISO_TZ_RE.test(s);
}

function assertIsoTz(s, where) {
  if (!isIsoTz(s)) {
    throw new Error(`validatePayload: ${where} must be a local-offset ISO-8601 timestamp, got ${JSON.stringify(s)}`);
  }
}

function assertNonEmpty(s, where) {
  if (typeof s !== 'string' || s.trim() === '') {
    throw new Error(`validatePayload: ${where} must be a non-empty string, got ${JSON.stringify(s)}`);
  }
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function assertStringArray(v, where) {
  if (!isStringArray(v)) {
    throw new Error(`validatePayload: ${where} must be a string[], got ${JSON.stringify(v)}`);
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ── the payload validator ─────────────────────────────────────────────────

/**
 * validatePayload(payloadOrRecord, record?) -> void   (throws LOUD on any violation)
 *
 * Validates the session payload = the top-level SIBLING blocks (meta / handoff / log /
 * punchlist) of the full record. Because the base `validateEnvelope` calls this as
 * `payloadValidator(record[kind], record)` and `record[kind]` is `undefined` under the
 * sibling shape, this reads the SECOND arg (the full record) when present; it is also
 * directly callable as `validatePayload(record)`.
 *
 * Lifecycle (A3): a freshly-opened session has `meta.openedAt` but NO handoff yet — so
 * `handoff` is NULLABLE (null/absent until first save); `log`/`punchlist` default to `[]`;
 * `handoff.where`/`next` are required-non-empty ONLY when `handoff` is present. Presence of
 * handoff + punchlist is enforced at CLOSE by the #1115 close-guard, NOT here.
 */
function validatePayload(payloadOrRecord, record) {
  const rec = record !== undefined ? record : payloadOrRecord;
  if (!isPlainObject(rec)) {
    throw new Error('validatePayload: session record must be an object');
  }

  // ── meta (mechanical) ──
  const meta = rec.meta;
  if (!isPlainObject(meta)) {
    throw new Error('validatePayload: meta block is required and must be an object (renamed from "session")');
  }
  assertNonEmpty(meta.number, 'meta.number');
  assertStringArray(meta.sessionIds, 'meta.sessionIds');
  assertIsoTz(meta.openedAt, 'meta.openedAt');
  if (meta.closedAt !== null && meta.closedAt !== undefined) {
    assertIsoTz(meta.closedAt, 'meta.closedAt');
  }
  assertNonEmpty(meta.tpmVersion, 'meta.tpmVersion');

  // ── meta: ADDITIVE per-track keys (tracks store; NO schemaVersion bump). Each is validated only
  // when PRESENT (absent is always fine; unknown keys are still accepted and preserved). ──
  if (meta.track !== undefined && !(typeof meta.track === 'string' && /^[a-z]$/.test(meta.track))) {
    throw new Error(`validatePayload: meta.track must be one letter a-z, got ${JSON.stringify(meta.track)}`);
  }
  if (meta.claudeSessionId !== undefined && meta.claudeSessionId !== null && typeof meta.claudeSessionId !== 'string') {
    throw new Error('validatePayload: meta.claudeSessionId must be a string or null');
  }
  if (meta.claudePid !== undefined && meta.claudePid !== null
      && !(Number.isSafeInteger(meta.claudePid) && meta.claudePid > 1)) {
    throw new Error(`validatePayload: meta.claudePid must be an integer > 1 or null, got ${JSON.stringify(meta.claudePid)}`);
  }
  if (meta.claudePidStartedAt !== undefined && meta.claudePidStartedAt !== null) {
    assertIsoTz(meta.claudePidStartedAt, 'meta.claudePidStartedAt');
  }
  if (meta.hostname !== undefined && meta.hostname !== null && typeof meta.hostname !== 'string') {
    throw new Error('validatePayload: meta.hostname must be a string or null');
  }
  if (meta.lastWriter !== undefined) {
    if (!isPlainObject(meta.lastWriter)) throw new Error('validatePayload: meta.lastWriter must be an object { version, at }');
    assertIsoTz(meta.lastWriter.at, 'meta.lastWriter.at');
    if (meta.lastWriter.version !== null && typeof meta.lastWriter.version !== 'string') {
      throw new Error('validatePayload: meta.lastWriter.version must be a string or null');
    }
  }
  if (meta.adoptions !== undefined) {
    if (!Array.isArray(meta.adoptions)) throw new Error('validatePayload: meta.adoptions must be an array');
    meta.adoptions.forEach((a, i) => {
      if (!isPlainObject(a)) throw new Error(`validatePayload: meta.adoptions[${i}] must be an object`);
      assertIsoTz(a.at, `meta.adoptions[${i}].at`);
    });
  }

  // ── handoff (nullable until first save; REPLACE-semantics) ──
  const handoff = rec.handoff;
  if (handoff !== null && handoff !== undefined) {
    if (!isPlainObject(handoff)) {
      throw new Error('validatePayload: handoff must be an object or null');
    }
    assertNonEmpty(handoff.where, 'handoff.where');
    assertNonEmpty(handoff.next, 'handoff.next');
    if (handoff.in_flight !== undefined) assertStringArray(handoff.in_flight, 'handoff.in_flight');
    if (handoff.must_not_redo !== undefined) assertStringArray(handoff.must_not_redo, 'handoff.must_not_redo');
    assertIsoTz(handoff.updatedAt, 'handoff.updatedAt');
  }

  // ── log (append-only ledger; default []) ──
  const log = rec.log;
  if (log !== undefined) {
    if (!Array.isArray(log)) throw new Error('validatePayload: log must be an array');
    let prevSeq = -Infinity;
    log.forEach((entry, i) => {
      if (!isPlainObject(entry)) throw new Error(`validatePayload: log[${i}] must be an object`);
      if (!Number.isInteger(entry.seq)) throw new Error(`validatePayload: log[${i}].seq must be an integer`);
      if (entry.seq <= prevSeq) {
        throw new Error(`validatePayload: log[${i}].seq (${entry.seq}) must be strictly increasing (prev ${prevSeq}) — seq is the sole order authority`);
      }
      prevSeq = entry.seq;
      assertIsoTz(entry.ts, `log[${i}].ts`);
      if (entry.type === 'decision') {
        assertNonEmpty(entry.what, `log[${i}].what`);
        assertNonEmpty(entry.why, `log[${i}].why`);
      } else if (entry.type === 'log') {
        assertNonEmpty(entry.status, `log[${i}].status`);
        assertNonEmpty(entry.text, `log[${i}].text`);
      } else {
        throw new Error(`validatePayload: log[${i}].type must be "decision" or "log", got ${JSON.stringify(entry.type)}`);
      }
    });
  }

  // ── punchlist (default []) ──
  const punchlist = rec.punchlist;
  if (punchlist !== undefined) {
    if (!Array.isArray(punchlist)) throw new Error('validatePayload: punchlist must be an array');
    punchlist.forEach((item, i) => {
      if (!isPlainObject(item)) throw new Error(`validatePayload: punchlist[${i}] must be an object`);
      assertNonEmpty(item.id, `punchlist[${i}].id`);
      assertNonEmpty(item.slug, `punchlist[${i}].slug`);
      assertNonEmpty(item.text, `punchlist[${i}].text`);
      if (!['open', 'done', 'dropped'].includes(item.state)) {
        throw new Error(`validatePayload: punchlist[${i}].state must be open|done|dropped, got ${JSON.stringify(item.state)}`);
      }
      assertIsoTz(item.createdAt, `punchlist[${i}].createdAt`);
      if (!Array.isArray(item.events)) throw new Error(`validatePayload: punchlist[${i}].events must be an array`);
      item.events.forEach((ev, j) => {
        if (!isPlainObject(ev)) throw new Error(`validatePayload: punchlist[${i}].events[${j}] must be an object`);
        assertIsoTz(ev.ts, `punchlist[${i}].events[${j}].ts`);
        if (!['add', 'close', 'reopen', 'drop', 'carry-in'].includes(ev.op)) {
          throw new Error(`validatePayload: punchlist[${i}].events[${j}].op must be add|close|reopen|drop|carry-in, got ${JSON.stringify(ev.op)}`);
        }
      });
    });
  }
}

// ── register kind:"session" with the base lib (DoD: KNOWN_KINDS includes "session") ──
// Mutates the shared (mutable) registry the base `envelope.js` ships EMPTY. Requiring this
// module wires the kind in; loadSession passes KNOWN_KINDS to validateEnvelope.
KNOWN_KINDS[SESSION_KIND] = {
  validatePayload,
  editableTable: EDITABLE_TABLE,
};

module.exports = {
  SESSION_KIND,
  EDITABLE_TABLE,
  validatePayload,
  isIsoTz,
  assertNonEmpty,
};
