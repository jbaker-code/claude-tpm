'use strict';
/**
 * task-schema.js — the `kind:"task"` payload schema + THE editable-field table +
 * lifecycle rules. Kind-SPECIFIC (P03), the FIRST task kind module. Mirrors
 * `../../20260919-session-features/session-tooling/lib/session-schema.js`.
 *
 * Built on the shared, kind-agnostic base lib reached through the phase-02 indirection
 * `./base.js` (reference-in-place, OQ5). This module NEVER imports the session lib
 * directly — it only touches the base via `require('./base')`.
 *
 * ── LOCKED PAYLOAD SHAPE (../task-json-format-spec.md, 🔒 shape) ──
 * The canonical record is the ENVELOPE (`schemaVersion` + `kind`) with the task payload
 * fields as TOP-LEVEL SIBLINGS — NOT nested under a `task` key:
 *
 *   { schemaVersion, kind:"task", id, state, headline, labels, summary, context,
 *     subtasks:[…], timestamps:{…}, endAction, history:[…] }
 *
 * COLLISION CONSEQUENCE (why validatePayload reads the 2nd arg): the base `readEnvelope`
 * returns `payload = record[kind]` = `record["task"]`, which does NOT exist under the
 * sibling shape → `payload` is `undefined`. The base `validateEnvelope` calls
 * `payloadValidator(record[kind], record)`, passing the FULL record as the 2nd arg
 * exactly so a sibling-shape kind can validate off the whole record. So validatePayload
 * here operates on the full record (2nd arg), and is also directly callable as
 * `validatePayload(record)`.
 *
 * Zero third-party deps; Node built-ins only; loadable/inspectable via `node <file>`.
 */
const base = require('./base');
const { KNOWN_KINDS } = base.envelope;

const TASK_KIND = 'task';

// ── lifecycle constants ───────────────────────────────────────────────────
// Task states (verbs only move `state`; import IGNORES a hand-set state — D3).
const STATES = ['open', 'in-progress', 'finished', 'dropped', 'removed'];
// Per-subtask states — flip ONLY via the mechanical check/reopen verbs.
const SUBTASK_STATES = ['open', 'done'];

/**
 * TRANSITION_VERBS — the state-transition legality matrix (G3), lifted VERBATIM from the
 * current tool `../claude-tpm/tools/task/tpm-task.js` (`const TRANSITIONS`). Keyed by the
 * lifecycle VERB. `legalFrom` = states from which the verb makes a real move; `redundantFrom`
 * = states where it is a no-op-with-notice; anything else is a loud illegal transition.
 */
const TRANSITION_VERBS = {
  start:  { target: 'in-progress', legalFrom: ['open'],                                       redundantFrom: ['in-progress'] },
  finish: { target: 'finished',    legalFrom: ['open', 'in-progress'],                        redundantFrom: ['finished'] },
  drop:   { target: 'dropped',     legalFrom: ['open', 'in-progress'],                        redundantFrom: ['dropped'] },
  remove: { target: 'removed',     legalFrom: ['open', 'in-progress', 'finished', 'dropped'], redundantFrom: ['removed'] },
  reopen: { target: 'open',        legalFrom: ['finished', 'dropped', 'removed'],             redundantFrom: ['open', 'in-progress'] },
};

/**
 * TRANSITIONS — the legal-state-move map keyed by SOURCE state (build-plan §6.03 shape:
 * `{ open:[…], 'in-progress':[…], … }`). DERIVED from TRANSITION_VERBS so the two can never
 * diverge: for each verb, every `legalFrom` state gains the verb's `target` as a legal move.
 * Deduped, listed in STATES order for stable output.
 */
const TRANSITIONS = (() => {
  const map = {};
  for (const s of STATES) map[s] = new Set();
  for (const verb of Object.keys(TRANSITION_VERBS)) {
    const { target, legalFrom } = TRANSITION_VERBS[verb];
    for (const from of legalFrom) map[from].add(target);
  }
  const out = {};
  for (const s of STATES) out[s] = STATES.filter((t) => map[s].has(t));
  return out;
})();

// History event ops + subtask actions (../task-json-format-spec.md "History event schema").
const HISTORY_OPS = ['create', 'edit', 'state', 'subtask'];
const SUBTASK_ACTIONS = ['add', 'edit', 'remove', 'check', 'reopen'];

/**
 * THE editable-field table — the SINGLE source of truth for (a) what an import may set,
 * (b) what the tool stamps & therefore IGNORES on import (D3 / format-spec field table).
 * Paths resolve against the record ROOT (top-level siblings), matching the base `update.js`
 * path resolution.
 *
 * edit: "replace" (whole-field overwrite) | "set" (whole-collection replace matched by key).
 *   The generic base layer performs ONLY "replace" on scalar/array paths; a "set" key carries
 *   "[]" and is handled by the kind's mechanical op (importSubtasks, P04), never a blind patch.
 * EDITABLE  = headline · labels · summary · context · subtasks(text/set)   (D3)
 * MECHANICAL (absent here, ignored on import) = id · state · timestamps · endAction · history
 */
const EDITABLE_TABLE = {
  'headline':        { edit: 'replace', type: 'string' },
  'labels':          { edit: 'replace', type: 'string[]' }, // #1116 array-canonical; bare-string sugar
  'summary':         { edit: 'replace', type: 'string' },
  'context':         { edit: 'replace', type: 'string' },
  'subtasks[].text': { edit: 'set',     type: 'string' },   // '[]' ⇒ generic layer skips; importSubtasks owns it
  // EVERYTHING ELSE (id/state/timestamps/endAction/history) = mechanical, ignored on import.
};

// ── local validation helpers ──────────────────────────────────────────────

const ISO_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}([.]\d+)?[+-]\d{2}:\d{2}$/;

/** ISO-8601 WITH an explicit local offset (never bare/UTC-Z) — format-spec "Timestamps". */
function isIsoTz(s) {
  return typeof s === 'string' && ISO_TZ_RE.test(s);
}

function assertIsoTz(s, where) {
  if (!isIsoTz(s)) {
    throw new Error(`validatePayload: ${where} must be a local-offset ISO-8601 timestamp, got ${JSON.stringify(s)}`);
  }
}

/** iso-tz-or-null (mechanical timestamps that are unset until an op stamps them). */
function assertIsoTzOrNull(s, where) {
  if (s === null || s === undefined) return;
  assertIsoTz(s, where);
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

/** Is `s` a legal lifecycle state? (build-plan §6.03 export.) */
function isValidState(s) {
  return STATES.includes(s);
}

/** Is `verb` a legal transition FROM `current`? (derived from G3, for P04.) */
function isLegalTransition(verb, current) {
  const t = TRANSITION_VERBS[verb];
  return !!t && t.legalFrom.includes(current);
}

// ── the payload validator ─────────────────────────────────────────────────

/**
 * validatePayload(payloadOrRecord, record?) -> void   (throws LOUD on any violation)
 *
 * Validates the task payload = the top-level SIBLING fields of the full canonical record.
 * Because the base `validateEnvelope` calls this as `payloadValidator(record[kind], record)`
 * and `record["task"]` is `undefined` under the sibling shape, this reads the SECOND arg
 * (the full record) when present; it is also directly callable as `validatePayload(record)`.
 *
 * Covers (format-spec field table): id (non-empty string, D4), state ∈ STATES, headline
 * non-empty, labels string[] (when present), summary/context strings (when present),
 * subtasks[] {key,text,state∈SUBTASK_STATES}, timestamps.* iso-tz-or-null (createdAt +
 * updatedAt required), endAction object|null, history[] per the event schema.
 *
 * Lifecycle: labels/summary/context/subtasks/history default to empty/absent on a freshly
 * opened task, so each is validated only WHEN PRESENT; id/state/headline/timestamps are the
 * always-present spine of a canonical task record.
 */
function validatePayload(payloadOrRecord, record) {
  const rec = record !== undefined ? record : payloadOrRecord;
  if (!isPlainObject(rec)) {
    throw new Error('validatePayload: task record must be an object');
  }

  // ── id (mechanical, D4: string, monotonic, never reused) ──
  assertNonEmpty(rec.id, 'id');

  // ── state (mechanical, verbs only) ──
  if (!isValidState(rec.state)) {
    throw new Error(`validatePayload: state must be one of ${STATES.join('|')}, got ${JSON.stringify(rec.state)}`);
  }

  // ── headline (editable, required non-empty) ──
  assertNonEmpty(rec.headline, 'headline');

  // ── labels (editable string[]; default []) ──
  if (rec.labels !== undefined) {
    assertStringArray(rec.labels, 'labels');
  }

  // ── summary / context (editable free prose; optional strings) ──
  if (rec.summary !== undefined && rec.summary !== null && typeof rec.summary !== 'string') {
    throw new Error(`validatePayload: summary must be a string, got ${JSON.stringify(rec.summary)}`);
  }
  if (rec.context !== undefined && rec.context !== null && typeof rec.context !== 'string') {
    throw new Error(`validatePayload: context must be a string, got ${JSON.stringify(rec.context)}`);
  }

  // ── subtasks (editable text/set; per-item state mechanical) ──
  if (rec.subtasks !== undefined && rec.subtasks !== null) {
    if (!Array.isArray(rec.subtasks)) {
      throw new Error(`validatePayload: subtasks must be an array, got ${JSON.stringify(rec.subtasks)}`);
    }
    rec.subtasks.forEach((st, i) => {
      if (!isPlainObject(st)) throw new Error(`validatePayload: subtasks[${i}] must be an object`);
      assertNonEmpty(st.key, `subtasks[${i}].key`);
      assertNonEmpty(st.text, `subtasks[${i}].text`);
      if (!SUBTASK_STATES.includes(st.state)) {
        throw new Error(`validatePayload: subtasks[${i}].state must be ${SUBTASK_STATES.join('|')}, got ${JSON.stringify(st.state)}`);
      }
    });
  }

  // ── timestamps (ALL MECHANICAL; createdAt + updatedAt required, rest iso-tz-or-null) ──
  const ts = rec.timestamps;
  if (!isPlainObject(ts)) {
    throw new Error('validatePayload: timestamps block is required and must be an object');
  }
  assertIsoTz(ts.createdAt, 'timestamps.createdAt');
  assertIsoTz(ts.updatedAt, 'timestamps.updatedAt');
  assertIsoTzOrNull(ts.startedAt, 'timestamps.startedAt');
  assertIsoTzOrNull(ts.endedAt, 'timestamps.endedAt');
  assertIsoTzOrNull(ts.reopenedAt, 'timestamps.reopenedAt');

  // ── endAction (mechanical; #1074/T-Q3 close-time resolution: {action?, note?, refs:[]}) ──
  // object|null; when an object, the KNOWN keys are type-checked (action/note strings, refs string[]).
  // Unknown keys are tolerated (forward/back-compat) — the validator gates types, not the key set.
  if (rec.endAction !== undefined && rec.endAction !== null) {
    if (!isPlainObject(rec.endAction)) {
      throw new Error(`validatePayload: endAction must be an object or null, got ${JSON.stringify(rec.endAction)}`);
    }
    const ea = rec.endAction;
    if (ea.action !== undefined && ea.action !== null && typeof ea.action !== 'string') {
      throw new Error(`validatePayload: endAction.action must be a string, got ${JSON.stringify(ea.action)}`);
    }
    if (ea.note !== undefined && ea.note !== null && typeof ea.note !== 'string') {
      throw new Error(`validatePayload: endAction.note must be a string, got ${JSON.stringify(ea.note)}`);
    }
    if (ea.refs !== undefined && ea.refs !== null) {
      assertStringArray(ea.refs, 'endAction.refs');
    }
  }

  // ── history (mechanical, append-only audit; default []; config-gated) ──
  // Events MAY also carry optional `session` (e.g. 'session-0012b') + `sessionVia` ('flag'|'env'|'lookup') keys
  // (attribution). They are deliberately NOT validated: a hand-edited value must never make a record unreadable.
  if (rec.history !== undefined && rec.history !== null) {
    if (!Array.isArray(rec.history)) {
      throw new Error(`validatePayload: history must be an array, got ${JSON.stringify(rec.history)}`);
    }
    rec.history.forEach((ev, i) => {
      if (!isPlainObject(ev)) throw new Error(`validatePayload: history[${i}] must be an object`);
      assertIsoTz(ev.at, `history[${i}].at`);
      if (!HISTORY_OPS.includes(ev.op)) {
        throw new Error(`validatePayload: history[${i}].op must be ${HISTORY_OPS.join('|')}, got ${JSON.stringify(ev.op)}`);
      }
      if (ev.op === 'edit') {
        assertNonEmpty(ev.field, `history[${i}].field`);
        if (!('value' in ev)) throw new Error(`validatePayload: history[${i}] (edit) must carry a value snapshot`);
      } else if (ev.op === 'state') {
        if (!isValidState(ev.from)) throw new Error(`validatePayload: history[${i}].from must be a valid state, got ${JSON.stringify(ev.from)}`);
        if (!isValidState(ev.to)) throw new Error(`validatePayload: history[${i}].to must be a valid state, got ${JSON.stringify(ev.to)}`);
      } else if (ev.op === 'subtask') {
        assertNonEmpty(ev.key, `history[${i}].key`);
        if (!SUBTASK_ACTIONS.includes(ev.action)) {
          throw new Error(`validatePayload: history[${i}].action must be ${SUBTASK_ACTIONS.join('|')}, got ${JSON.stringify(ev.action)}`);
        }
      }
    });
  }
}

// ── register kind:"task" with the base lib (DoD: KNOWN_KINDS includes "task") ──
// Mutates the shared (mutable) registry the base `envelope.js` ships EMPTY. Requiring this
// module wires the kind in; the task model passes KNOWN_KINDS to validateEnvelope.
KNOWN_KINDS[TASK_KIND] = {
  validatePayload,
  editableTable: EDITABLE_TABLE,
};

module.exports = {
  TASK_KIND,
  STATES,
  SUBTASK_STATES,
  TRANSITIONS,
  TRANSITION_VERBS,
  HISTORY_OPS,
  SUBTASK_ACTIONS,
  EDITABLE_TABLE,
  validatePayload,
  isValidState,
  isLegalTransition,
  isIsoTz,
  assertNonEmpty,
};

// `node lib/task-schema.js` → a self-check (loadable/inspectable per convention).
if (require.main === module) {
  const ok = Object.prototype.hasOwnProperty.call(KNOWN_KINDS, TASK_KIND);
  if (!ok) {
    console.error('task-schema.js: KNOWN_KINDS did not register "task"');
    process.exit(1);
  }
  console.log(`task-schema.js OK — kind "${TASK_KIND}" registered; states: ${STATES.join(', ')}`);
  console.log(`  legal transitions: ${JSON.stringify(TRANSITIONS)}`);
}
