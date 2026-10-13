'use strict';
/**
 * task-model.js — the `kind:"task"` engine (P04). Kind-SPECIFIC. Mirrors
 * `../../20260919-session-features/session-tooling/lib/session-model.js`.
 *
 * SURFACE (build-plan §6.04):
 *   IO            — loadTask (read→migrate→validate, C1 order) / saveTask (atomic JSON +
 *                   derived body .md + machine tasks-index.json + human index .md views).
 *   bidirectional — applyTask / exportTask / importTask (#1106) / importBodyText (#1107) /
 *                   stripHistory (the --thin projection, G1 — NOT trimNonEditable).
 *   subtasks      — addSubtask / editSubtask / removeSubtask / checkSubtask / reopenSubtask /
 *                   importSubtasks (§4 bulk-replace-set; state via verbs only).
 *   lifecycle     — openTask / startTask / finishTask / dropTask / removeTask / reopenTask,
 *                   each enforcing task-schema's legal-transition map, stamping the right
 *                   timestamp + updatedAt (D5) + a {op:"state"} history event. finishTask
 *                   carries the #1111 CLOSE-GUARD (refused while any subtask is `open`).
 *   history       — appendHistory (#1109, config-gated) / readHistory / setHistoryEnabled.
 *   store / index — deriveRow / readIndex / writeIndex / reindex / allocateNextId /
 *                   bodyPathFor + nextId high-water (D2/#1058). THIS is a P04 deliverable
 *                   (07 selects against tasks-index.json; build-plan §7 trap).
 *
 * ── CRITICAL LOAD-PATH CONTRACT (C1) ── read → migrate → validate. The refuse-unknown-NEWER
 * guard lives in `version.migrate` (NOT readEnvelope), so loadTask runs migrate BETWEEN read
 * and validate; skipping migrate would let old code silently read (and later destroy) newer data.
 *
 * ── RENDER DEFERRAL (build-plan §7.1) ── the converter is P05. task-model NEVER `require`s it:
 * saveTask/exportTask take `render` (body) + `indexRender` (index views) as INJECTED params, so
 * P04 precedes P05. When absent, the JSON (source of truth) is still written; derived files skip.
 *
 * ── updatedAt (D5) ── every mutating op stamps `timestamps.updatedAt`; saveTask re-stamps it at
 * persist time (the authoritative "updated" for `--updated-since`). Ops are PURE (return a NEW
 * record, never mutate the caller's) unless they do IO.
 *
 * ── PAYLOAD SHAPE ── top-level siblings (id/state/headline/labels/summary/context/subtasks/
 * timestamps/endAction/history), NOT nested under a `task` key (see task-schema.js).
 *
 * ── null summary/context (F3, decisions.md) ── task-schema treats `summary`/`context` `null` as
 * absent. apply/import here pass a supplied `null` straight through (stored as null, tolerated by
 * the validator); no coercion, no crash. A missing field is simply not set.
 *
 * Reaches the shared base lib through the phase-02 indirection `./base.js`; the kind via
 * `./task-schema.js`. Zero third-party deps; Node built-ins only; loadable via `node <file>`.
 */
const fs = require('fs');
const path = require('path');

const base = require('./base');
const { writeEnvelope, KNOWN_KINDS } = base.envelope;
const { migrate, CURRENT } = base.version;
const { validateEnvelope } = base.validate;
const { applyUpdate } = base.update;
const { normalizeArray } = base.normalize;
const { atomicWriteFileSync, readCanonicalSync } = base.io;
const { nowIsoTz } = base.timestamp;

const schema = require('./task-schema');
const { TASK_KIND, STATES, TRANSITION_VERBS, EDITABLE_TABLE, validatePayload } = schema;

// The scalar editable fields the generic layer sets (array-element "set" keys excluded).
const SCALAR_EDITABLE = Object.keys(EDITABLE_TABLE).filter((k) => k.indexOf('[]') === -1);

// Machine index (tasks-index.json) constants (../task-json-format-spec.md "tasks-index.json").
const TASK_INDEX_KIND = 'task-index';
const DEFAULT_START_ID = '1000';    // ids monotonic ≥1000 (format-spec)
const BUCKET_SIZE = 1000;           // thousand-bucketed bodies

// ── local deep clone (JSON-serialisable records only) ────────────────────────
function deepClone(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

// ── history gate (#1109) — module-level, set by the P06 config layer ─────────
// Default ON; P06's tpm-task-config flips it off to satisfy a `history=off` config. `appendHistory`
// (and every op that appends through it) becomes a no-op when off: NO event is written.
let HISTORY_ENABLED = true;
function setHistoryEnabled(on) { HISTORY_ENABLED = !!on; return HISTORY_ENABLED; }
function isHistoryEnabled() { return HISTORY_ENABLED; }

// In-place mutators over a working CLONE (never the caller's record) ──────────
function _stampUpdated(out) {
  if (!out.timestamps || typeof out.timestamps !== 'object') out.timestamps = {};
  out.timestamps.updatedAt = nowIsoTz();
  return out;
}
// Append a history event to the working clone — GATED: no-op (nothing written) when the gate is off.
function _pushHistory(out, event) {
  if (!HISTORY_ENABLED) return out;
  if (!Array.isArray(out.history)) out.history = [];
  const ev = { at: (event && event.at) || nowIsoTz() };
  for (const k of Object.keys(event || {})) if (k !== 'at') ev[k] = event[k];
  // Session attribution (multi-session): stamped only when a store verb set one AND the caller did not supply its own.
  if (ATTRIBUTION && !('session' in ev)) { ev.session = ATTRIBUTION.session; ev.sessionVia = ATTRIBUTION.sessionVia; }
  out.history.push(ev);
  return out;
}

// ── reader ENOENT-retry (lock-free readers vs. a rename-over writer) ──────────
// `rename`-over is content-atomic (0 torn reads) but NOT availability-gap-free on a shared mount: a reader
// can see a transient ENOENT (`open` fails although `stat` succeeds) for a few ms while a writer swaps the
// file. Read verbs take no lock, so the task read path retries a small bounded number of times, ONLY when
// the file demonstrably exists (existsSync true) — a genuinely missing file still fails at once, loudly.
// A name that stays unopenable (a "stranded" name) exhausts the retries and throws the same loud error;
// recovery is to move it aside (`mv tasks-index.json tasks-index.json.aside`, never delete-then-add) and
// run `tpm task reindex`.
const READ_RETRIES = 3;          // extra attempts after the first
const READ_RETRY_MS = 15;        // 10-20 ms apart
function _nap(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function readCanonicalRetry(filePath) {
  for (let attempt = 0; ; attempt++) {
    try {
      return readCanonicalSync(filePath);
    } catch (e) {
      const transient = attempt < READ_RETRIES && /ENOENT/.test(String(e && e.message)) && fs.existsSync(filePath);
      if (!transient) throw e;
      _nap(READ_RETRY_MS);
    }
  }
}
/** readTextRetry(filePath) -> string — the same bounded retry for a derived (non-JSON) file. */
function readTextRetry(filePath) {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      const transient = attempt < READ_RETRIES && e && e.code === 'ENOENT' && fs.existsSync(filePath);
      if (!transient) throw e;
      _nap(READ_RETRY_MS);
    }
  }
}

// ── lastWriter stamp (B2 / #1174) ─────────────────────────────────────────────
// While a store verb holds the lock, tpm-task.js sets the running tpm version here; writeIndex then stamps
// `lastWriter: {version, at}` as a TOP-LEVEL key of tasks-index.json (old tools preserve unknown top-level
// keys; the index is NOT reshaped). Unset (null) -> no stamp is added (and an existing one is left as is).
let LAST_WRITER = null;
/** tpmVersion() -> string | null — the running tpm package version (bundle package.json), null when unreadable. */
function tpmVersion() {
  try { return require('../../../package.json').version || null; } catch (_) { return null; }
}
// ── session attribution (multi-session support) ───────────────────────────────
// While a store verb holds the lock, tpm-task.js sets the resolved { session, sessionVia } here and _pushHistory
// stamps both keys on every history event written (never one without the other). Unset (null) -> events are
// byte-identical to before. The via list is a literal here (the model stays zero-coupling to tools/lib/attribution).
let ATTRIBUTION = null;
function setAttribution(info) {
  const ok = info && typeof info === 'object' && typeof info.session === 'string' && info.session !== ''
    && ['flag', 'env', 'lookup'].includes(info.sessionVia);
  ATTRIBUTION = ok ? { session: info.session, sessionVia: info.sessionVia } : null;
  return ATTRIBUTION;
}
function setLastWriter(info) {
  LAST_WRITER = info && typeof info === 'object' ? { version: info.version == null ? null : String(info.version) } : null;
  return LAST_WRITER;
}

// ── IO surface ───────────────────────────────────────────────────────────────

/**
 * loadTask(jsonPath) -> record
 * The canonical load path read → migrate → validate (honors C1). Fail-loud on a missing/corrupt
 * file; migrate refuses an unknown NEWER schemaVersion; validateEnvelope runs the task payload
 * validator + the known-kind gate. Returns the migrated + validated full record.
 */
function loadTask(jsonPath) {
  const raw = readCanonicalRetry(jsonPath);             // read (fail-loud; bounded ENOENT-retry for lock-free readers)
  const migrated = migrate(raw);                         // migrate  ← refuse-unknown-newer fires HERE
  validateEnvelope(migrated, {                           // validate
    payloadValidator: validatePayload,
    knownKinds: KNOWN_KINDS,
  });
  return migrated;
}

/**
 * saveTask(record, { jsonPath?, mdPath?, render?, tasksDir?, indexRender?, now? }) -> record
 *
 *  1. stamp timestamps.updatedAt (persist-time authority, D5);
 *  2. validate the payload (never persist a malformed canonical file);
 *  3. writeEnvelope(jsonPath) ← ATOMIC canonical write FIRST (temp→fsync→rename, #1100);
 *  4. ONLY on success: if `render` given, regenerate the derived body .md (disposable);
 *  5. if `tasksDir` given, upsert this task's row into tasks-index.json (rewriting nextId
 *     high-water + counts) and — if `indexRender` given — the three human index .md views.
 *
 * `jsonPath` defaults to bodyPathFor(tasksDir, id); `mdPath` to the .json's .md sibling. render /
 * indexRender are INJECTED (P05) — never required here (render-deferral, build-plan §7). `now` (F5,
 * OPTIONAL) is threaded ONLY to writeIndexViews to pin the index views' relative-age reference time
 * (default: real clock, unchanged). Returns the persisted record (so a round-trip identity check
 * compares exactly what was written).
 */
function saveTask(record, opts) {
  const options = opts || {};
  let { jsonPath } = options;
  const { mdPath, render, tasksDir, indexRender, now } = options;

  const out = deepClone(record);
  _stampUpdated(out);
  validateEnvelope(out, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });

  if (!jsonPath) {
    if (!tasksDir) throw new Error('saveTask: opts.jsonPath or opts.tasksDir is required');
    jsonPath = bodyPathFor(tasksDir, out.id);
  }
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  writeEnvelope(jsonPath, out);                          // atomic canonical write FIRST

  if (typeof render === 'function') {
    const md = mdPath || jsonPath.replace(/\.json$/, '.md');
    fs.mkdirSync(path.dirname(md), { recursive: true });
    atomicWriteFileSync(md, render(out));                // derived body — only AFTER JSON ok (atomic: lock-free readers never see a torn .md)
  }

  if (tasksDir) {
    const index = upsertRow(readIndex(tasksDir), out, tasksDir);
    writeIndex(tasksDir, index);
    if (typeof indexRender === 'function') writeIndexViews(tasksDir, index, indexRender, { now });
  }
  return out;
}

// ── bidirectional edit surface ───────────────────────────────────────────────

/**
 * applyTask(record, patch) -> record (a NEW record)
 * Generic editable-table filter over EDITABLE_TABLE (replace-mode scalars/labels only; the
 * "set" subtask key is skipped by the generic layer). For each SCALAR editable field that
 * actually changed, appends an {op:"edit", field, value:<full new value>} history event
 * (#1109, gated) and stamps updatedAt. Mechanical fields in `patch` are ignored. A supplied
 * `null` for summary/context passes straight through (F3 — stored null, no crash).
 */
function applyTask(record, patch) {
  const next = applyUpdate(record, patch, { editableTable: EDITABLE_TABLE, kind: TASK_KIND });
  let changed = false;
  for (const field of SCALAR_EDITABLE) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
      if (!_deepEqual(record[field], next[field])) {
        _pushHistory(next, { op: 'edit', field, value: deepClone(next[field]) });
        changed = true;
      }
    }
  }
  if (changed) _stampUpdated(next);
  return next;
}

/**
 * exportTask(record, { style, render }) -> object | string
 *   style "json"  -> the full canonical envelope (deep clone).
 *   style "human" -> render(record); requires an injected converter (P05) — throws loud if none.
 */
function exportTask(record, opts) {
  const options = opts || {};
  const style = options.style || 'json';
  if (style === 'json') return deepClone(record);
  if (style === 'human') {
    if (typeof options.render !== 'function') {
      throw new Error('exportTask: style "human" requires an injected `render` converter (P05)');
    }
    return options.render(record);
  }
  throw new Error(`exportTask: unknown style '${style}' (expected "json" | "human")`);
}

/**
 * importTask(record, patch) -> record (a NEW record)   (#1106)
 * The full JSON-import merge: applyTask over the scalar editables (+ their edit history), then —
 * if `patch.subtasks` is present — importSubtasks (§4 bulk-replace-set). Every mechanical field
 * (id/state/timestamps/endAction/history) present in `patch` is IGNORED (never trusted from import).
 */
function importTask(record, patch) {
  let out = applyTask(record, patch || {});
  if (patch && Array.isArray(patch.subtasks)) {
    out = importSubtasks(out, patch.subtasks);
  }
  return out;
}

/**
 * importBodyText(record, { field, text }) -> record (a NEW record)   (#1107)
 * Raw `--body-txt-file` text into a prose field: summary | context. Appends an {op:"edit"} event
 * and stamps updatedAt. `text` null passes through (F3).
 */
function importBodyText(record, spec) {
  const s = spec || {};
  const field = s.field;
  if (field !== 'summary' && field !== 'context') {
    throw new Error(`importBodyText: field must be "summary" | "context", got ${JSON.stringify(field)}`);
  }
  const out = deepClone(record);
  out[field] = s.text === undefined ? null : s.text;
  _pushHistory(out, { op: 'edit', field, value: deepClone(out[field]) });
  _stampUpdated(out);
  return out;
}

/**
 * addLabels(record, labels) -> record (a NEW record)   (#1071)
 * Thin convenience over applyTask: union the current `labels[]` with `labels` (a string or string[]),
 * preserving existing order and appending new labels in supplied order, deduped. No-op (same record
 * shape, no history/updatedAt churn) when nothing new is added — applyTask suppresses the edit event
 * for an unchanged field. Routes through applyTask so the {op:"edit", field:"labels"} history event +
 * updatedAt stamp are handled exactly as a manual `edit --labels` would be.
 */
function addLabels(record, labels) {
  const cur = Array.isArray(record.labels) ? record.labels.slice() : [];
  const seen = new Set(cur);
  for (const l of normalizeArray(labels)) {
    const s = String(l);
    if (!seen.has(s)) { cur.push(s); seen.add(s); }
  }
  return applyTask(record, { labels: cur });
}

/**
 * removeLabels(record, labels) -> record (a NEW record)   (#1071)
 * Thin convenience over applyTask: drop every label in `labels` (a string or string[]) from the
 * current `labels[]`, preserving the order of survivors. No-op when nothing matched.
 */
function removeLabels(record, labels) {
  const cur = Array.isArray(record.labels) ? record.labels : [];
  const drop = new Set(normalizeArray(labels).map((l) => String(l)));
  return applyTask(record, { labels: cur.filter((l) => !drop.has(String(l))) });
}

/**
 * stripHistory(record) -> record (a NEW record)   (--thin projection, G1)
 * A deep clone with `history` removed. This is the `--thin` shape (full-record-minus-history) —
 * NOT the base `trimNonEditable` (which projects to the editable set only; export-spec mis-cites it).
 */
function stripHistory(record) {
  const out = deepClone(record);
  delete out.history;
  return out;
}

// ── subtask lifecycle (#1111 — session-punchlist template) ───────────────────

/**
 * addSubtask(record, { text, key? }) -> record (a NEW record)
 * Appends a subtask (state "open"); mints the next key unless a unique `key` is supplied.
 * History {op:"subtask", key, action:"add"} + updatedAt. Throws on a duplicate supplied key.
 */
function addSubtask(record, spec) {
  const s = spec || {};
  const out = deepClone(record);
  if (!Array.isArray(out.subtasks)) out.subtasks = [];
  let key = s.key;
  if (key !== undefined && key !== null && key !== '') {
    if (out.subtasks.some((st) => st.key === key)) {
      throw new Error(`addSubtask: subtask key '${key}' already exists`);
    }
  } else {
    key = nextSubtaskKey(out);
  }
  out.subtasks.push({ key, text: s.text, state: 'open' });
  _pushHistory(out, { op: 'subtask', key, action: 'add' });
  _stampUpdated(out);
  return out;
}

/** editSubtask(record, key, text) -> record — overwrite text; history subtask/edit + updatedAt. */
function editSubtask(record, key, text) {
  const out = deepClone(record);
  const st = _findSubtask(out, key);
  st.text = text;
  _pushHistory(out, { op: 'subtask', key, action: 'edit' });
  _stampUpdated(out);
  return out;
}

/** removeSubtask(record, key) -> record — drop the subtask; history subtask/remove + updatedAt. */
function removeSubtask(record, key) {
  const out = deepClone(record);
  _findSubtask(out, key);                 // throws loud if absent
  out.subtasks = out.subtasks.filter((st) => st.key !== key);
  _pushHistory(out, { op: 'subtask', key, action: 'remove' });
  _stampUpdated(out);
  return out;
}

/** checkSubtask(record, key) -> record — state→done (mechanical); history subtask/check + updatedAt. */
function checkSubtask(record, key) {
  const out = deepClone(record);
  const st = _findSubtask(out, key);
  st.state = 'done';
  _pushHistory(out, { op: 'subtask', key, action: 'check' });
  _stampUpdated(out);
  return out;
}

/** reopenSubtask(record, key) -> record — state→open (mechanical); history subtask/reopen + updatedAt. */
function reopenSubtask(record, key) {
  const out = deepClone(record);
  const st = _findSubtask(out, key);
  st.state = 'open';
  _pushHistory(out, { op: 'subtask', key, action: 'reopen' });
  _stampUpdated(out);
  return out;
}

/**
 * importSubtasks(record, incoming[], { prune = false }) -> record (a NEW record)   (§4 / OQ1)
 *
 * Bulk-replace the (key,text) SET matched by stable `key`:
 *   - key in incoming ∧ in record → keep the item, overwrite `text` only if changed
 *     (history subtask/edit); PRESERVE the existing mechanical `state`.
 *   - key in incoming ∧ not in record → add it, state "open" (history subtask/add). A keyless
 *     incoming item is minted the next free key; a supplied UNIQUE key is honored.
 *   - key in record ∧ not in incoming → KEEP it by default (OQ1, Jason 2026-09-20 — FLIP to
 *     keep-missing: import only adds/updates, never silently drops). Pass `prune:true` (the ops-layer
 *     `--prune` flag) to REMOVE such record-only keys (history subtask/remove).
 *   - Any `state`/timestamps on an incoming item are IGNORED — done/open flips ONLY via
 *     check/reopen (D3). One updatedAt stamp for the whole merge.
 */
function importSubtasks(record, incoming, opts) {
  const prune = !!(opts && opts.prune === true);
  const out = deepClone(record);
  const existing = Array.isArray(out.subtasks) ? out.subtasks : [];
  const incomingList = Array.isArray(incoming) ? incoming : [];

  const byKey = new Map();
  for (const st of existing) byKey.set(st.key, st);

  // Resolve a stable key for each incoming item first (so minted keys don't collide with each other
  // or with existing keys), preserving incoming order for the resulting set.
  const usedKeys = new Set(existing.map((st) => st.key));
  const resolved = [];
  for (const item of incomingList) {
    const it = item || {};
    let key = it.key;
    if (key === undefined || key === null || key === '') {
      key = _nextKeyAmong(usedKeys);
    }
    usedKeys.add(key);
    resolved.push({ key, text: it.text });
  }

  const incomingKeys = new Set(resolved.map((r) => r.key));
  let changed = false;

  // removals: keys in record but not in incoming — dropped only when pruning (default)
  const removals = [];
  for (const st of existing) {
    if (!incomingKeys.has(st.key) && prune) { removals.push(st.key); changed = true; }
  }

  // build the surviving/new set in incoming order
  const orderedSurvivors = [];
  for (const r of resolved) {
    if (byKey.has(r.key)) {
      const prev = byKey.get(r.key);
      const keptText = r.text === undefined ? prev.text : r.text;
      if (!_deepEqual(keptText, prev.text)) changed = true;   // text edit
      orderedSurvivors.push({ key: r.key, text: keptText, state: prev.state });  // PRESERVE state
    } else {
      orderedSurvivors.push({ key: r.key, text: r.text, state: 'open' });         // new → open
      changed = true;
    }
  }

  // Default (keep-missing) / absent --prune: keep record-only items at their original relative order (appended after).
  const tail = [];
  if (!prune) {
    for (const st of existing) {
      if (!incomingKeys.has(st.key)) tail.push(deepClone(st));
    }
  }
  out.subtasks = orderedSurvivors.concat(tail);

  // history: removals, then per-incoming add/edit (deterministic, incoming order)
  for (const key of removals) _pushHistory(out, { op: 'subtask', key, action: 'remove' });
  for (const r of resolved) {
    if (byKey.has(r.key)) {
      const prev = byKey.get(r.key);
      const newText = r.text === undefined ? prev.text : r.text;
      if (!_deepEqual(newText, prev.text)) _pushHistory(out, { op: 'subtask', key: r.key, action: 'edit' });
    } else {
      _pushHistory(out, { op: 'subtask', key: r.key, action: 'add' });
    }
  }

  if (changed) _stampUpdated(out);
  return out;
}

function _findSubtask(record, key) {
  const st = (record.subtasks || []).find((x) => x.key === key);
  if (!st) throw new Error(`subtask op: no subtask with key '${key}'`);
  return st;
}

// ── lifecycle transitions ─────────────────────────────────────────────────────

/**
 * openTask({ id?, headline, labels?, summary?, context?, tpmVersion?, tasksDir? }) -> record
 * A fresh task envelope: state "open", empty subtasks, createdAt=updatedAt=now, other timestamps
 * null, endAction null, a {op:"create"} history event (gated). `id` is taken as-is (canonicalId)
 * or allocated from `tasksDir` (high-water). Validated before return.
 */
function openTask(spec) {
  const s = spec || {};
  if (typeof s.headline !== 'string' || s.headline.trim() === '') {
    throw new Error('openTask: `headline` is required (non-empty string)');
  }
  let id = s.id;
  if (id === undefined || id === null || id === '') {
    if (!s.tasksDir) throw new Error('openTask: provide `id` or `tasksDir` to allocate one');
    id = allocateNextId(s.tasksDir);
  } else {
    id = canonicalId(id);
  }
  const ts = nowIsoTz();
  const record = {
    schemaVersion: CURRENT,
    kind: TASK_KIND,
    id,
    state: 'open',
    headline: s.headline,
    labels: normalizeArray(s.labels),
    summary: s.summary === undefined ? null : s.summary,
    context: s.context === undefined ? null : s.context,
    subtasks: [],
    timestamps: {
      createdAt: ts,
      updatedAt: ts,
      startedAt: null,
      endedAt: null,
      reopenedAt: null,
    },
    endAction: null,
    history: [],
  };
  _pushHistory(record, { at: ts, op: 'create' });
  validatePayload(record);
  return record;
}

/**
 * transition(record, verb, { action?, note?, ref?, refs? }) -> record
 * The shared lifecycle mover, enforcing task-schema's TRANSITION_VERBS legal-move map:
 *   - `redundantFrom` (already in the target lane) → idempotent no-op: a clone, unchanged.
 *   - not `legalFrom` and not `redundantFrom` → a LOUD illegal-transition throw.
 *   - `legalFrom` → set state, stamp the verb's timestamp(s) + updatedAt, append {op:"state"}.
 * The #1111 CLOSE-GUARD (finish) is applied by finishTask BEFORE this runs.
 */
function transition(record, verb, extra) {
  const t = TRANSITION_VERBS[verb];
  if (!t) throw new Error(`transition: unknown lifecycle verb '${verb}'`);
  const from = record.state;
  const out = deepClone(record);

  if (t.redundantFrom.includes(from)) return out;   // idempotent no-op-with-notice (CLI notes it)
  if (!t.legalFrom.includes(from)) {
    throw new Error(
      `transition: illegal '${verb}' from state '${from}' (legal from: ${t.legalFrom.join(', ')})`
    );
  }

  const to = t.target;
  out.state = to;
  const ts = nowIsoTz();
  if (!out.timestamps || typeof out.timestamps !== 'object') out.timestamps = {};
  switch (verb) {
    case 'start':
      out.timestamps.startedAt = ts;
      break;
    case 'finish':
    case 'drop':
      out.timestamps.endedAt = ts;
      out.endAction = _buildEndAction(extra);
      break;
    case 'remove':
      // soft-stash: no endedAt (not a finished/dropped close); state + audit only
      break;
    case 'reopen':
      out.timestamps.reopenedAt = ts;
      out.timestamps.endedAt = null;   // clear the close
      out.endAction = null;
      break;
    default:
      break;
  }
  _pushHistory(out, { at: ts, op: 'state', from, to });
  out.timestamps.updatedAt = ts;
  return out;
}

/** startTask(record) -> record — open → in-progress, stamp startedAt. */
function startTask(record) { return transition(record, 'start'); }

/**
 * finishTask(record, { action?, note?, ref?, refs? }) -> record — {open,in-progress} → finished.
 * CLOSE-GUARD (#1111): REFUSED while any subtask is `open`, naming the blocking keys. Stamps
 * endedAt + endAction (the #1074 close-time resolution/provenance) on success.
 */
function finishTask(record, extra) {
  const blockers = (record.subtasks || []).filter((st) => st.state === 'open').map((st) => st.key);
  if (blockers.length > 0) {
    throw new Error(
      `finishTask: refused — ${blockers.length} open subtask(s) block close (#1111): ` +
      `${blockers.join(', ')}. Check or remove them first.`
    );
  }
  return transition(record, 'finish', extra);
}

/** dropTask(record, { action?, note?, ref?, refs? }) -> record — {open,in-progress} → dropped, stamp endedAt. */
function dropTask(record, extra) { return transition(record, 'drop', extra); }

/** removeTask(record) -> record — → removed (soft-stash); state + audit only. */
function removeTask(record) { return transition(record, 'remove'); }

/** reopenTask(record) -> record — {finished,dropped,removed} → open, clear ended/endAction, stamp reopenedAt. */
function reopenTask(record) { return transition(record, 'reopen'); }

/**
 * _buildEndAction({ action?, note?, ref?, refs? }) -> { action?, note?, refs? } | null   (#1074, T-Q3)
 * The generalized close-time resolution + provenance object. `action` (kept for back-compat) and
 * `note` are scalar strings; `refs` is the repeatable provenance list. The single legacy `ref`
 * folds into `refs` (back-compat), then `refs[]` is appended. Empty/blank refs are dropped.
 * T-Q3 (Jason, 2026-09-20 — FLIP from omit-empty): a NON-NULL endAction ALWAYS carries `refs` as an
 * array (`[]` when no refs), never omitted — so a closed task's machine shape is uniform. A bare
 * finish/drop with NOTHING supplied (no action/note/refs) still yields `endAction: null` (an un-closed
 * task has no resolution object at all). Close-time ONLY (T-Q2 — no mid-life note home).
 */
function _buildEndAction(extra) {
  const e = extra || {};
  const out = {};
  if (e.action !== undefined && e.action !== null) out.action = e.action;
  if (e.note !== undefined && e.note !== null) out.note = e.note;
  const refs = [];
  const pushRef = (r) => { if (r !== undefined && r !== null && String(r).trim() !== '') refs.push(String(r)); };
  pushRef(e.ref);                                   // legacy single --ref (back-compat)
  if (Array.isArray(e.refs)) for (const r of e.refs) pushRef(r);
  // Nothing supplied at all → no resolution object (a bare close stays endAction:null).
  if (out.action === undefined && out.note === undefined && refs.length === 0) return null;
  out.refs = refs;                                  // T-Q3: refs is always present in a non-null endAction
  return out;
}

// ── history read surface (#1109) ──────────────────────────────────────────────

/**
 * appendHistory(record, event) -> record (a NEW record)
 * The public history-append: a clone with `event` pushed onto history[] — a no-op (nothing
 * written) when the history gate is off. Does NOT stamp updatedAt (that is the op's job).
 */
function appendHistory(record, event) {
  const out = deepClone(record);
  _pushHistory(out, event || {});
  return out;
}

/** readHistory(record) -> event[] — the only user surface (tpm task history <id>); clone or []. */
function readHistory(record) {
  return Array.isArray(record.history) ? deepClone(record.history) : [];
}

// ── store / machine index (D2 / #1058) ────────────────────────────────────────

function bucketFor(id) {
  const n = Number(id);
  const lo = Math.floor(n / BUCKET_SIZE) * BUCKET_SIZE;
  return `${lo}-${lo + BUCKET_SIZE - 1}`;
}

/** bodyPathFor(tasksDir, id) -> absolute path bodies/<lo>-<hi>/task-<id>.json (a body never moves). */
function bodyPathFor(tasksDir, id) {
  return path.join(tasksDir, 'bodies', bucketFor(id), `task-${id}.json`);
}

/** The tasks-index.json path for a store dir. */
function indexPathFor(tasksDir) {
  return path.join(tasksDir, 'tasks-index.json');
}

function emptyCounts() {
  const c = {};
  for (const s of STATES) c[s] = 0;
  return c;
}

/**
 * deriveRow(record) -> thinRow — ONE tasks-index.json row: id/state/headline/labels/createdAt/
 * updatedAt/subtasks{done,total}/path (relative, posix). All states (mechanical filtering is by code).
 */
function deriveRow(record) {
  const subs = Array.isArray(record.subtasks) ? record.subtasks : [];
  const done = subs.filter((st) => st.state === 'done').length;
  return {
    id: String(record.id),
    state: record.state,
    headline: record.headline,
    labels: normalizeArray(record.labels),
    createdAt: record.timestamps ? record.timestamps.createdAt : null,
    updatedAt: record.timestamps ? record.timestamps.updatedAt : null,
    subtasks: { done, total: subs.length },
    path: `bodies/${bucketFor(record.id)}/task-${record.id}.json`,
  };
}

/**
 * readIndex(tasksDir) -> indexObj — the machine index, or a fresh empty one if absent/unreadable
 * shape. (It is a cache; a missing file just means "rebuild on next save/reindex".)
 */
function readIndex(tasksDir) {
  const p = indexPathFor(tasksDir);
  if (!fs.existsSync(p)) return _freshIndex();
  const obj = readCanonicalRetry(p);       // fail-loud on corrupt JSON (never silently empty); bounded ENOENT-retry
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) return _freshIndex();
  return obj;
}

function _freshIndex() {
  return {
    schemaVersion: CURRENT,
    kind: TASK_INDEX_KIND,
    generatedAt: nowIsoTz(),
    nextId: null,
    startId: DEFAULT_START_ID,
    counts: emptyCounts(),
    labels: {},
    tasks: [],
  };
}

/**
 * deriveLabelIndex(rows) -> { "<label>": ["<id>", …], … }   (#1071, T-Q6)
 * The orthogonal label→id-set reverse index derived from the thin index rows (each row's `labels[]`).
 * DETERMINISTIC for golden byte-stability (R4): label keys sorted lexicographically, ids sorted
 * numerically. A label with no tasks never appears; every id under a label agrees with that task's
 * per-task `labels[]` (rows ARE the projection of the bodies, so the map cannot drift from them).
 * Lives INSIDE tasks-index.json (not a separate file) — one derived index, rebuilt on every recount.
 */
function deriveLabelIndex(rows) {
  const map = new Map();  // label -> Set<idString>
  for (const r of Array.isArray(rows) ? rows : []) {
    const labels = Array.isArray(r && r.labels) ? r.labels : [];
    const id = String(r.id);
    for (const raw of labels) {
      const label = String(raw);
      if (!map.has(label)) map.set(label, new Set());
      map.get(label).add(id);
    }
  }
  const out = {};
  for (const label of [...map.keys()].sort()) {
    out[label] = [...map.get(label)].sort((a, b) => (Number(a) - Number(b)) || (a < b ? -1 : a > b ? 1 : 0));
  }
  return out;
}

/** writeIndex(tasksDir, indexObj) -> void — atomic write of tasks-index.json (temp→fsync→rename); stamps `lastWriter` when a store verb set one (setLastWriter). */
function writeIndex(tasksDir, indexObj) {
  fs.mkdirSync(tasksDir, { recursive: true });
  let out = indexObj;
  if (LAST_WRITER) out = Object.assign({}, indexObj, { lastWriter: { version: LAST_WRITER.version, at: nowIsoTz() } });  // B2 stamp (under the lock)
  atomicWriteFileSync(indexPathFor(tasksDir), JSON.stringify(out, null, 2) + '\n', { encoding: 'utf8' });
}

/**
 * upsertRow(indexObj, record, tasksDir) -> indexObj (a NEW object)
 * Replace/insert `record`'s thin row, recompute counts from all rows, and advance the nextId
 * high-water = max(prior nextId, max(rowId)+1, startId) so it NEVER regresses. generatedAt stamped.
 */
function upsertRow(indexObj, record) {
  const idx = deepClone(indexObj);
  if (!Array.isArray(idx.tasks)) idx.tasks = [];
  const row = deriveRow(record);
  const at = idx.tasks.findIndex((r) => String(r.id) === row.id);
  if (at >= 0) idx.tasks[at] = row; else idx.tasks.push(row);
  return _recount(idx);
}

function _recount(idx) {
  const startId = Number(idx.startId || DEFAULT_START_ID);
  const counts = emptyCounts();
  let maxId = startId - 1;
  for (const r of idx.tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, r.state)) counts[r.state] += 1;
    const n = Number(r.id);
    if (Number.isFinite(n) && n > maxId) maxId = n;
  }
  const priorNext = idx.nextId != null ? Number(idx.nextId) : startId;
  const nextId = Math.max(priorNext, maxId + 1, startId);
  idx.counts = counts;
  idx.labels = deriveLabelIndex(idx.tasks);   // #1071: rebuild the label reverse-index in lockstep
  idx.nextId = String(nextId);
  idx.startId = String(idx.startId || DEFAULT_START_ID);
  idx.generatedAt = nowIsoTz();
  return idx;
}

/**
 * reindex(tasksDir, { startId?, onUnreadable? }) -> indexObj
 * Full rebuild from the *.json bodies (bodies are truth for row content): scan every
 * bodies/<bucket>/task-*.json, load+derive a row, recompute counts. nextId high-water =
 * max(prior index.nextId, max(bodyId)+1, startId) — NEVER regresses (a hard-deleted top task
 * cannot let an id be reused). Writes tasks-index.json and returns it.
 *
 * ── FAILS LOUD on an unreadable body (B1(b) / #1172) ── a body that will not load (unknown-NEWER
 * schemaVersion, corrupt, invalid) is NEVER silently dropped from the index. `opts.onUnreadable`:
 *   'refuse' (default) — throw ReindexError listing every skipped body (count + id + file + reason);
 *                        NOTHING is written, so the existing index (and its old rows) is kept as is.
 *   'drop'             — the explicit `--drop-unreadable` opt-in: omit those rows, write the index, and
 *                        report them on the returned index's non-enumerable `skipped` array.
 *   'keep'             — keep the PRIOR index row for an unreadable body (when the old index has one) and
 *                        report it on `skipped`; used by `remove --hard`, which must not fail half-done.
 * The returned index always carries a non-enumerable `skipped: [{id, file, reason}]` (empty when none).
 */
class ReindexError extends Error {
  constructor(message, skipped) {
    super(message);
    this.name = 'ReindexError';
    this.code = 'EREINDEX_UNREADABLE';
    this.skipped = skipped;
  }
}

function reindex(tasksDir, opts) {
  const options = opts || {};
  const mode = options.onUnreadable || 'refuse';
  const prior = readIndex(tasksDir);
  const startId = options.startId != null ? String(options.startId) : (prior.startId || DEFAULT_START_ID);

  const rows = [];
  const skipped = [];
  for (const p of listBodyPaths(tasksDir)) {
    let rec;
    try {
      rec = loadTask(p);
    } catch (e) {
      const m = /task-(\d+)\.json$/.exec(p);
      const id = m ? m[1] : null;
      skipped.push({ id, file: path.relative(tasksDir, p).split(path.sep).join('/'), reason: String(e && e.message ? e.message : e) });
      if (mode === 'keep' && id != null) {
        const old = (Array.isArray(prior.tasks) ? prior.tasks : []).find((r) => String(r.id) === id);
        if (old) rows.push(old);
      }
      continue;
    }
    rows.push(deriveRow(rec));
  }
  if (skipped.length && mode === 'refuse') {
    const list = skipped.map((s) => `  - #${s.id} (${s.file}): ${s.reason}`).join('\n');
    throw new ReindexError(
      `reindex REFUSED: ${skipped.length} task body(ies) could not be read, and an index rebuilt now would silently drop them:\n${list}\n` +
      'Nothing was written; the existing index is unchanged. Upgrade tpm if a body is from a newer version, fix the body, ' +
      'or re-run with --drop-unreadable to discard these rows from the index (their body files stay on disk).',
      skipped,
    );
  }
  const idx = {
    schemaVersion: CURRENT,
    kind: TASK_INDEX_KIND,
    generatedAt: nowIsoTz(),
    nextId: prior.nextId,          // carry the prior high-water FLOOR into the recompute
    startId: String(startId),
    counts: emptyCounts(),
    tasks: rows,
  };
  const rebuilt = _recount(idx);
  writeIndex(tasksDir, rebuilt);
  Object.defineProperty(rebuilt, 'skipped', { value: skipped, enumerable: false });
  return rebuilt;
}

/** Every canonical body path under <tasksDir>/bodies/<bucket>/task-*.json (sorted by numeric id). */
function listBodyPaths(tasksDir) {
  const bodiesDir = path.join(tasksDir, 'bodies');
  if (!fs.existsSync(bodiesDir)) return [];
  const found = [];
  for (const bucket of fs.readdirSync(bodiesDir)) {
    const bdir = path.join(bodiesDir, bucket);
    let stat;
    try { stat = fs.statSync(bdir); } catch (_) { continue; }
    if (!stat.isDirectory()) continue;
    for (const fn of fs.readdirSync(bdir)) {
      const m = /^task-(\d+)\.json$/.exec(fn);
      if (m) found.push({ id: Number(m[1]), p: path.join(bdir, fn) });
    }
  }
  found.sort((a, b) => a.id - b.id);
  return found.map((x) => x.p);
}

/**
 * allocateNextId(tasksDir | indexObj) -> string
 * The next id to assign (the current high-water). Non-mutating (a peek): saveTask persists the
 * advance when the new task's row lands (nextId then floors at id+1). ids are never reused.
 */
function allocateNextId(arg) {
  const idx = typeof arg === 'string' ? readIndex(arg) : arg;
  const startId = idx && idx.startId ? idx.startId : DEFAULT_START_ID;
  return String(idx && idx.nextId != null ? idx.nextId : startId);
}

/**
 * writeIndexViews(tasksDir, indexObj, indexRender, opts) -> void
 * The three human index .md views, each `indexRender(indexObj, { states, now })` (P05-injected):
 *   task-index.md (open + in-progress) | finished-tasks-index.md (finished ∪ dropped) |
 *   removed-tasks-index.md (removed). No-op unless indexRender is supplied (render-deferral).
 *
 * ── F5 INJECTABLE `now` (additive seam; default UNCHANGED) ── `opts.now` (an ISO local-offset
 * string OR a Date) pins the reference time renderIndexView uses for its relative Created-age
 * column — the ONLY clock-dependent output — so the derived index-view bytes are byte-stable
 * THROUGH a save when a caller wants a deterministic golden. Absent → `new Date()` exactly as
 * before, so every existing caller (saveTask/migrate) is byte-for-byte unchanged.
 */
function writeIndexViews(tasksDir, indexObj, indexRender, opts) {
  if (typeof indexRender !== 'function') return;
  const now = (opts && opts.now !== undefined && opts.now !== null) ? opts.now : new Date();
  const views = [
    { file: 'task-index.md', states: ['open', 'in-progress'] },
    { file: 'finished-tasks-index.md', states: ['finished', 'dropped'] },
    { file: 'removed-tasks-index.md', states: ['removed'] },
  ];
  fs.mkdirSync(tasksDir, { recursive: true });
  for (const v of views) {
    atomicWriteFileSync(path.join(tasksDir, v.file), indexRender(indexObj, { states: v.states, now }), { encoding: 'utf8' });
  }
}

// ── small helpers ──────────────────────────────────────────────────────────────

/** canonicalId(n) -> string (D4: string, NO zero-pad). */
function canonicalId(n) {
  const s = String(n).trim();
  if (s === '') throw new Error('canonicalId: id must be non-empty');
  return s;
}

/**
 * nextSubtaskKey(record) -> 'A'|'B'|…|'Z'|'AA'|… — the smallest spreadsheet-style key not already
 * used in this record's subtasks. Honors arbitrary supplied keys by skipping any that are taken.
 */
function nextSubtaskKey(record) {
  const used = new Set((record.subtasks || []).map((st) => st.key));
  return _nextKeyAmong(used);
}

function _nextKeyAmong(usedSet) {
  let i = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const key = _colName(i);
    if (!usedSet.has(key)) return key;
    i++;
  }
}

// 0->A, 25->Z, 26->AA (spreadsheet column names).
function _colName(i) {
  let n = i;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function _deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!_deepEqual(a[k], b[k])) return false;
  }
  return true;
}

module.exports = {
  // IO
  loadTask,
  saveTask,
  // bidirectional edit
  applyTask,
  exportTask,
  importTask,
  importBodyText,
  addLabels,
  removeLabels,
  stripHistory,
  // subtask lifecycle
  addSubtask,
  editSubtask,
  removeSubtask,
  checkSubtask,
  reopenSubtask,
  importSubtasks,
  // lifecycle transitions
  openTask,
  startTask,
  finishTask,
  dropTask,
  removeTask,
  reopenTask,
  transition,
  // history (#1109, gated)
  appendHistory,
  readHistory,
  setHistoryEnabled,
  isHistoryEnabled,
  // store / machine index (D2)
  deriveRow,
  deriveLabelIndex,
  readIndex,
  writeIndex,
  reindex,
  ReindexError,
  readCanonicalRetry,
  readTextRetry,
  setLastWriter,
  setAttribution,
  tpmVersion,
  allocateNextId,
  bodyPathFor,
  indexPathFor,
  listBodyPaths,
  writeIndexViews,
  // helpers
  canonicalId,
  nextSubtaskKey,
  BUCKET_SIZE,
  DEFAULT_START_ID,
  TASK_INDEX_KIND,
};

// `node lib/task-model.js` → a self-check (loadable/inspectable per convention).
if (require.main === module) {
  const rec = openTask({ id: 1119, headline: 'self-check', labels: 'demo', tpmVersion: '0.1.0' });
  const started = startTask(rec);
  const withSub = addSubtask(started, { text: 'a subtask' });
  let threw = false;
  try { finishTask(withSub); } catch (_) { threw = true; }
  if (!threw) { console.error('task-model.js: close-guard did NOT refuse an open subtask'); process.exit(1); }
  const finished = finishTask(checkSubtask(withSub, 'A'));
  if (finished.state !== 'finished') { console.error('task-model.js: finish did not reach finished'); process.exit(1); }
  console.log(`task-model.js OK — open→start→addSubtask→(guard refuses)→check→finish; id ${rec.id}, ` +
    `${finished.history.length} history events; nextSubtaskKey now ${nextSubtaskKey(finished)}`);
}
