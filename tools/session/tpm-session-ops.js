#!/usr/bin/env node
'use strict';
/**
 * tpm-session-ops.js — the node-invokable session OPS + IMPORT tool for `kind:"session"` records
 * (P06). The capstone that makes the JSON-first session tooling usable end-to-end, against a
 * SCRATCH or real sessions dir. Composes the blessed shared pieces — it re-implements NONE of the
 * model / converter / IO primitives:
 *   - `lib/session-model.js`     · loadSession / saveSession / open / append / punchlist ops / import*
 *   - `lib/session-converter.js` · render(record, { now }) — the PURE JSON→human converter
 *
 * ── OPS (each: load → mutate via the model → saveSession = ATOMIC canonical JSON FIRST, then the
 *    derived human `.md` regenerated via the converter with `now` bound in a CLOSURE) ──
 *   open           — mint a fresh session (optionally folding a prior session's open punchlist items,
 *                    each carried with `fromSession` provenance); writes JSON + .md.
 *   save           — re-persist the current session (re-stamp handoff.updatedAt, regenerate the .md).
 *   note           — append ONE log entry (append-only): a plain `log` line OR a `decision`.
 *   punchlist      — add / close / reopen / drop / carry-in a punchlist item.
 *   close          — CLOSE-GUARD (#1115 E): REFUSES unless a handoff AND a punchlist are both present,
 *                    naming what is missing; only then stamps meta.closedAt.
 *
 * ── IMPORT (#1115; honors the LOCKED editable table — mechanical fields ignored, state never set
 *    by import; loosened all-or-none rule = partial file-driven writes allowed, but each write's
 *    canonical JSON is still ATOMIC) ──
 *   import-handoff — REPLACE the handoff from a JSON file (handoff obj OR a full session record) OR
 *                    from a plain TEXT file (raw → handoff `where`; `--next`/`--next-file` supplies
 *                    the required `next`).
 *   import-log     — APPEND a log addendum from a TEXT file (append-only; existing entries never
 *                    rewritten; monotonic seq preserved).
 *   import-punchlist — ADD/merge punchlist items from a file (JSON array of strings/{text}, or one
 *                    item per non-empty text line); state is NEVER set by import.
 *
 * ── NODE-INVOKABLE, NO BIN (Q5) ──
 * Each verb is a TOP-LEVEL session verb (the old `ops` grouping was flattened away): run via
 * `tpm session <verb> …` (routed through the `tpm` bin), or bare
 * `node tools/session/tpm-session-ops.js <verb> …`. Programmatic callers `require()` it for the `op*` functions.
 *
 * Zero third-party deps; Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const model = require('./lib/session-model');
const { render } = require('./lib/session-converter');
const { nowIsoTz } = require('../lib/timestamp');
const { readIdentity } = require('../lib/identity');
const { tpmVersion } = require('../lib/tpm-version');
const sessionConfig = require('./tpm-session-config');
const T = require('./lib/session-tracks');
const ids = require('./lib/session-ids');
const { withSessionLock } = require('./lib/session-lock');

// ── paths ────────────────────────────────────────────────────────────────────

// Zero-padded 4-wide session number for on-disk file names (matches the human header's "0021").
function padNumber(number) {
  const n = Number(number);
  return Number.isFinite(n) ? String(n).padStart(4, '0') : String(number == null ? '' : number);
}

/**
 * sessionPaths(sessionsDir, number, track = 'a') -> { jsonPath, mdPath, sealedPath, folder, track }
 * CANONICAL NESTED layout (json-format-spec A4, Q-F): each session lives in its OWN per-session
 * folder `<sessionsDir>/session-<NNNN>/`. Track a is `session-<NNNN>.json` (+ `.md` derived) — the
 * pre-tracks name; tracks b..z are `session-<NNNN>-<x>.json`. The 2-arg form is track a. The enclosing
 * folder is created (mkdir -p) by `persist` before write.
 */
function sessionPaths(sessionsDir, number, track) {
  if (!sessionsDir) throw new Error('tpm-session-ops: sessionsDir is required');
  if (number === undefined || number === null || String(number) === '') {
    throw new Error('tpm-session-ops: session number is required');
  }
  const p = T.trackPaths(sessionsDir, padNumber(number), track);
  return { jsonPath: p.jsonPath, mdPath: p.mdPath, sealedPath: p.sealedPath, folder: p.folder, track: p.track };
}

// ── the mutate seam (Q11: every mutating verb runs under the shared session lock) ─────────────
/**
 * Every mutating op runs its WHOLE read-modify-write (own-track resolution → load → mutate → persist → hint)
 * through here, under the per-session-folder lock (lib/session-lock.js). Files and stdin the op needs are read
 * BEFORE it (a gather step), the lock is never held for anything else, and it is released on a throw.
 */
function mutate(o, verb, fn) { return withSessionLock(o && o.sessionsDir, o && o.number, verb, fn); }
// Late-bound through module.exports so a test can spy on the seam.
function runMutating(o, verb, fn) { return module.exports.mutate(o, verb, fn); }

/**
 * ownTrack(o) -> letter — THE function that answers "which track is mine" for a write. One call per write verb, as
 * the first statement of its locked body, so a programmatic caller gets the same ownership protection as the CLI.
 * An explicit `o.track` is honoured after an ownership check (ENOT_OWNER); with none, the caller's Claude session
 * id picks its own track (see T.resolveWriteTrack for the ladder).
 */
function ownTrack(o) {
  return T.resolveWriteTrack({
    sessionsDir: o.sessionsDir, number: o.number, track: o.track,
    identity: o.identity || readIdentity({ withStartTime: false }),
  }).track;
}

/**
 * touchOwner(record, identity, readFull) -> record   (evidence only — never changes WHO owns the track)
 * Called by persist on every save. Adds meta.track when absent (a legacy record gains it on its first
 * save, which ends its supersession-by-age). When the caller IS the owner (or the record has no owner id)
 * and the process id differs from the recorded one, refreshes claudePid / claudePidStartedAt / hostname
 * (a `claude --resume` keeps the session id but starts a new process). A null owner is filled with the
 * caller's id; a non-null owner is NEVER replaced (that is adopt, a later phase).
 */
function touchOwner(record, track, identity, readFull) {
  const meta = record && record.meta;
  if (!meta || typeof meta !== 'object') return record;
  if (meta.track === undefined) meta.track = track;
  const callerId = identity && identity.claudeSessionId ? identity.claudeSessionId : null;
  if (!callerId) return record;
  const owner = T.ownerOf(meta);
  if (owner.claudeSessionId !== null && owner.claudeSessionId !== callerId) return record;
  const needsId = meta.claudeSessionId !== callerId;
  const pidDiffers = identity.claudePid !== null && identity.claudePid !== undefined && identity.claudePid !== meta.claudePid;
  if (needsId) meta.claudeSessionId = callerId;
  if (pidDiffers) {
    const full = typeof readFull === 'function' ? readFull() : identity;
    meta.claudePid = full.claudePid === undefined ? null : full.claudePid;
    meta.claudePidStartedAt = full.claudePidStartedAt === undefined ? null : full.claudePidStartedAt;
    meta.hostname = full.hostname === undefined ? null : full.hostname;
  }
  return record;
}

/**
 * persist(record, { sessionsDir, number, track = 'a', now, renderFn, lastWriterVersion, identity }) -> record
 * The single save path shared by every op: writes the canonical JSON ATOMICALLY first, THEN
 * regenerates the derived `.md` via the converter with `now` bound in a CLOSURE (P04/P06 concern).
 * Stamps meta.lastWriter {version, at} (the B2 mixed-version stamp) and refreshes owner evidence.
 */
function persist(record, opts) {
  const { sessionsDir, number, now } = opts;
  const track = opts.track || 'a';
  const renderFn = typeof opts.renderFn === 'function' ? opts.renderFn : render;
  const ref = now != null ? now : nowIsoTz();
  const { jsonPath, mdPath, sealedPath } = sessionPaths(sessionsDir, number, track);
  // Narrow the load-to-write window: a marker created after our load still refuses the write (DoD D).
  if (fs.existsSync(sealedPath)) T.assertWritable(T.trackState(sessionsDir, padNumber(number), track));
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true }); // the per-session folder session-<NNNN>/
  const identity = opts.identity || readIdentity({ withStartTime: false });
  const next = JSON.parse(JSON.stringify(record));
  touchOwner(next, track, identity, () => (opts.identity || readIdentity({ withStartTime: true })));
  const version = opts.lastWriterVersion !== undefined ? opts.lastWriterVersion : tpmVersion();
  return model.saveSession(next, {
    jsonPath,
    mdPath,
    render: (r) => renderFn(r, { now: ref }),   // ← the `now` CLOSURE
    lastWriter: { version },
  });
}

// Load the current canonical record for a session track (fail-loud via the model's load path).
function loadCurrent(sessionsDir, number, track) {
  const { jsonPath } = sessionPaths(sessionsDir, number, track);
  return model.loadSession(jsonPath);
}

// The load every WRITE op starts from: a track sealed by someone else's marker refuses (ETRACK_SEALED, naming
// who sealed it and when). The ONE "is it sealed" answer is T.trackState; a track the owner closed itself is
// not guarded (Q-C7).
function loadForWrite(sessionsDir, number, track) {
  T.assertWritable(T.trackState(sessionsDir, padNumber(number), track || 'a'));
  return loadCurrent(sessionsDir, number, track);
}

// Pass-through of the per-op options persist needs.
function pOpts(o, track) {
  return { sessionsDir: o.sessionsDir, number: o.number, track, now: o.now, renderFn: o.renderFn, identity: o.identity };
}

// Gather step: files are read BEFORE the lock is taken; a read error is kept and thrown inside the body at the
// point the old code threw it, so the order of errors a caller sees does not change.
function preRead(file) {
  try { return { text: readFileText(file) }; } catch (e) { return { error: e }; }
}
function takePre(pre) {
  if (pre.error) throw pre.error;
  return pre.text;
}

// ── OPS ───────────────────────────────────────────────────────────────────────

/**
 * opOpen({ sessionsDir, number, track?, sessionId, tpmVersion?, priorSessionPath?, now?, identity? }) -> record
 * Mint a fresh session track and persist it — EXCLUSIVELY: the record is created with a link-from-temp claim,
 * so an existing record is NEVER overwritten. If the target already exists and belongs to this session id
 * (or either side has no id) it is returned unchanged ("record exists; nothing done"); if it belongs to a
 * different session id -> ESESSION_EXISTS. A prior session's still-open punchlist items are carried forward
 * (same slug, new id, {op:"carry-in", fromSession}) only when the record is newly created.
 */
function opOpen(opts) {
  const o = opts || {};
  if (!o.number) throw new Error('openSession: `number` is required');
  if (!o.sessionId) throw new Error('openSession: `sessionId` is required');
  const track = o.track || 'a';
  const nnnn = padNumber(o.number);
  const ident = Object.assign({}, o.identity || readIdentity({ withStartTime: true }), { claudeSessionId: o.sessionId });
  const lwv = tpmVersion();
  let claimed;
  try {
    claimed = T.claimTrack(o.sessionsDir, nnnn, {
      letters: [track], now: o.now, renderFn: o.renderFn, lastWriterVersion: lwv,
      makeRecord: (letter) => model.openTrack({
        number: o.number, track: letter, identity: ident, tpmVersion: o.tpmVersion, lastWriterVersion: lwv,
        priorSessionPath: o.priorSessionPath, priorSession: o.priorSession,
      }),
    });
  } catch (err) {
    if (!(err && err.code === 'ETRACK_EXISTS')) throw err;
    const existing = loadCurrent(o.sessionsDir, nnnn, track);
    const ownerId = T.ownerOf(existing.meta).claudeSessionId;
    if (ownerId !== null && ownerId !== o.sessionId) {
      throw new T.TrackError('ESESSION_EXISTS',
        `track ${track} of ${nnnn} already exists and belongs to another session; use \`tpm session current --open\``);
    }
    process.stderr.write('tpm-session-ops open: record exists; nothing done\n');
    return existing;
  }
  return claimed.record;
}

/**
 * opSave({ sessionsDir, number, now? }) -> record
 * Re-persist the current session — re-stamps handoff.updatedAt (if present) and regenerates the .md.
 */
function opSave(opts) {
  const o = opts || {};
  return runMutating(o, 'save', () => {
    const track = ownTrack(o);
    const record = loadForWrite(o.sessionsDir, o.number, track);
    return persist(record, pOpts(o, track));
  });
}

/**
 * opNote({ sessionsDir, number, type?, what?, why?, status?, text?, now? }) -> record  (append-only)
 * Appends ONE log entry: a `decision` (what/why) or a plain `log` line (status/text). The model
 * allocates a monotonic seq and stamps ts; existing entries are never rewritten.
 */
function opNote(opts) {
  const o = opts || {};
  return runMutating(o, 'note', () => {
    const track = ownTrack(o);
    let record = loadForWrite(o.sessionsDir, o.number, track);
    record = model.appendLog(record, {
      type: o.type, what: o.what, why: o.why, status: o.status, text: o.text,
    });
    return persist(record, pOpts(o, track));
  });
}

/**
 * opPunchlist({ sessionsDir, number, action, text?, slug?, idOrSlug?, priorSessionPath?, item?, now? })
 *   -> record
 * action: add | close | reopen | drop | carry-in.
 *   add       — mint a slug + session-prefixed id, state open, {op:"add"}.
 *   close/reopen/drop — set state via the mechanical op (by id OR slug); append the op event.
 *   carry-in  — copy a still-OPEN item from a prior session file (`priorSessionPath` + `item` =
 *               that item's id/slug); SAME slug, NEW id, {op:"carry-in", fromSession:<prior number>}.
 */
function opPunchlist(opts) {
  const o = opts || {};
  // gather: the prior session file of a carry-in is read before the lock
  let prior = null;
  if (o.action === 'carry-in' && o.priorSessionPath) {
    try { prior = { record: model.loadSession(o.priorSessionPath) }; } catch (e) { prior = { error: e }; }
  }
  return runMutating(o, 'punchlist', () => opPunchlistBody(o, prior));
}

/**
 * assertOwnItem(o, track, record) — close/reopen/drop change ONLY items on the caller's own track. An item that is
 * not in `record` but belongs to another track is refused BY NAME (ECROSS_TRACK) before anything is written; a true
 * miss falls through to the model's own "no item matching" error, byte for byte.
 */
function assertOwnItem(o, track, record) {
  if (model.findItem(record, o.idOrSlug)) return;
  const hit = T.locateItem(o.sessionsDir, padNumber(o.number), o.idOrSlug, { exceptTrack: track });
  if (!hit) return;
  const nnnn = padNumber(o.number);
  const verb = o.action;
  const ownerId = hit.state.owner && hit.state.owner.claudeSessionId;
  const stateText = hit.state.sealedBy === 'marker' ? 'sealed by marker' : hit.state.state === 'sealed' ? 'sealed (closed)' : hit.state.state;
  const shown = ids.displayItemId(hit.item.id, true);
  throw new T.TrackError('ECROSS_TRACK',
    `item #${shown} [${hit.item.slug}] belongs to track ${hit.track} of session ${nnnn} (owner ${ownerId ? `${String(ownerId).slice(0, 8)}...` : 'unowned'}, ${stateText}), not to your track ${track}. `
    + `Nothing was changed. Each track changes only its own items; ask that instance to ${verb} it.`,
    { number: nnnn, item: { id: hit.item.id, slug: hit.item.slug }, ownerTrack: hit.track, mineTrack: track, ownerState: stateText });
}

function opPunchlistBody(o, prior) {
  const track = ownTrack(o);
  let record = loadForWrite(o.sessionsDir, o.number, track);
  if (o.action === 'close' || o.action === 'reopen' || o.action === 'drop') assertOwnItem(o, track, record);
  switch (o.action) {
    case 'add':
      record = model.addPunchlist(record, { text: o.text, slug: o.slug });
      break;
    case 'close':
      record = model.closePunchlistItem(record, o.idOrSlug);
      break;
    case 'reopen':
      record = model.reopenPunchlistItem(record, o.idOrSlug);
      break;
    case 'drop':
      record = model.dropPunchlistItem(record, o.idOrSlug);
      break;
    case 'carry-in': {
      if (!o.priorSessionPath) throw new Error('punchlist carry-in: --from <prior session json> is required');
      if (!o.item) throw new Error('punchlist carry-in: --item <id|slug> is required');
      if (prior.error) throw prior.error;
      const priorRecord = prior.record;
      const src = model.findItem(priorRecord, o.item);
      if (!src) throw new Error(`punchlist carry-in: no item matching '${o.item}' in '${o.priorSessionPath}'`);
      if (src.state !== 'open') throw new Error(`punchlist carry-in: item '${o.item}' is '${src.state}', only OPEN items carry in`);
      record = model.carryInPunchlist(record, src, ids.fromSessionLabel(priorRecord.meta));
      break;
    }
    default:
      throw new Error(`punchlist: unknown action '${o.action}' (add|close|reopen|drop|carry-in)`);
  }
  return persist(record, pOpts(o, track));
}

/**
 * opClose({ sessionsDir, number, now? }) -> record
 * CLOSE-GUARD (#1115 E): REFUSES to seal unless a handoff AND a punchlist are BOTH present, naming
 * what is missing. Only when the guard passes does it stamp meta.closedAt and persist.
 */
function opClose(opts) {
  const o = opts || {};
  return runMutating(o, 'close', () => {
    const track = ownTrack(o);
    const record = loadForWrite(o.sessionsDir, o.number, track);
    assertCloseGuard(record);
    const closed = model.closeSession(record);
    const saved = persist(closed, pOpts(o, track));
    // Keep the hint TRUE (closed iff no track is still unsealed) — only when a hint already exists, so
    // closing a record never creates files in a store that has none.
    try { T.writeHint(o.sessionsDir, { ifPresent: true }); } catch (_e) { /* hint is advisory */ }
    return saved;
  });
}


/**
 * opSealAbandoned({ sessionsDir, number, track, identity?, reason?, note?, confirm?, now? }) -> { plan, sealed, already, marker }
 * `close --track <other instance's letter>`: the deliberate ABANDONED SEAL of a foreign track (marker file;
 * the record is never opened for write, no close guard, no handoff fabricated). `confirm` is the
 * `--even-if-running` flag and is ALWAYS required - without it nothing is written and the plan is returned.
 */
function opSealAbandoned(opts) {
  const o = opts || {};
  if (!o.number) throw new T.TrackError('ETRACK_ARG', 'sealing another track needs --session <NNNN>');
  return runMutating(o, 'seal-abandoned', () => T.sealByMarker(o.sessionsDir, padNumber(o.number), o.track, {
    by: o.identity || readIdentity({ withStartTime: true }), reason: 'abandoned', note: o.reason === undefined ? null : o.reason,
    confirm: Boolean(o.confirm), now: o.now,
  }));
}

/** opUnseal({ sessionsDir, number, track, now? }) -> { number, track, unsealed, already, auditPath } */
function opUnseal(opts) {
  const o = opts || {};
  if (!o.number) throw new T.TrackError('ETRACK_ARG', 'unseal needs --session <NNNN>');
  if (!o.track) throw new T.TrackError('ETRACK_ARG', 'unseal needs --track <letter>');
  return runMutating(o, 'unseal', () => T.unsealTrack(o.sessionsDir, padNumber(o.number), o.track, { now: o.now }));
}

/** formatSealPlan([plan]) -> the evidence block shown before any abandoned seal (also used by --seal-and-new). */
function formatSealPlan(plans) {
  return plans.map((p) => `  track ${p.track} of ${p.number}   ${p.state === 'unreadable' ? `unreadable record (${p.unreadable})` : 'live'}   owner ${p.owner.claudeSessionId ? String(p.owner.claudeSessionId).slice(0, 8) : 'unknown'}${p.owner.claudePid ? ` (pid ${p.owner.claudePid}${p.owner.hostname ? ` on ${p.owner.hostname}` : ''})` : ''}   last write ${p.lastWriteAt || 'unknown'}   ${p.livenessLine}`).join('\n');
}

/** True when `--track` names a track whose recorded owner is a DIFFERENT Claude session than the caller. */
function isForeignTrack(sessionsDir, number, track, identity) {
  const callerId = identity && identity.claudeSessionId ? identity.claudeSessionId : null;
  if (!callerId || !T.isTrackLetter(track)) return false;
  const st = T.trackState(sessionsDir, padNumber(number), track);
  const ownerId = st && st.owner ? st.owner.claudeSessionId : null;
  return Boolean(ownerId && ownerId !== callerId);
}

/**
 * assertCloseGuard(record) -> void   (throws LOUD, naming what is missing)
 * "present" = handoff is a non-null object; punchlist has at least one item.
 */
function assertCloseGuard(record) {
  const missing = [];
  const handoffPresent = record && record.handoff !== null && record.handoff !== undefined;
  const punchlistPresent = record && Array.isArray(record.punchlist) && record.punchlist.length > 0;
  if (!handoffPresent) missing.push('a handoff');
  if (!punchlistPresent) missing.push('a punchlist');
  if (missing.length) {
    throw new Error(
      `tpm-session-ops close: refusing to close session — missing ${missing.join(' and ')}. ` +
      'A session cannot be sealed without a handoff AND at least one punchlist item (#1115 close-guard).',
    );
  }
}

// ── IMPORT (#1115) ──────────────────────────────────────────────────────────────

function readFileText(file) {
  if (!file) throw new Error('import: a file path is required');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`import: cannot read file '${file}': ${e.message}`);
  }
}

/**
 * opImportHandoff({ sessionsDir, number, jsonFile? | txtFile?, next?, nextFile?, inFlight?, mustNotRedo?, now? })
 *   -> record
 * REPLACE-semantics. Exactly one source:
 *   jsonFile — a handoff object OR a full session record (`.handoff` extracted). Editable fields
 *              only are applied (mechanical fields in the file are IGNORED by importHandoff).
 *   txtFile  — the raw contents become the handoff `where`; the required `next` comes from `--next`
 *              or `--next-file`; optional `--in-flight`/`--must-not-redo` (repeatable) fill the arrays.
 *              (Interpretation of #1115 A "raw → handoff body", RAISED in HANDOFF: replace-semantics
 *              cannot invent the required `next`, so it must be supplied — we fail loud if absent.)
 */
function opImportHandoff(opts) {
  const o = opts || {};
  // gather: every source file is read before the lock (errors are deferred to where the old code threw them)
  const pre = {
    json: o.jsonFile ? preRead(o.jsonFile) : null,
    txt: o.txtFile ? preRead(o.txtFile) : null,
    nextFile: o.next == null && o.nextFile ? preRead(o.nextFile) : null,
  };
  return runMutating(o, 'import-handoff', () => opImportHandoffBody(o, pre));
}

function opImportHandoffBody(o, pre) {
  const track = ownTrack(o);
  let record = loadForWrite(o.sessionsDir, o.number, track);
  let handoffObj;

  if (o.jsonFile && o.txtFile) {
    throw new Error('import-handoff: pass EITHER --json-file OR --txt-file, not both');
  }
  if (o.jsonFile) {
    let parsed;
    try {
      parsed = JSON.parse(takePre(pre.json));
    } catch (e) {
      throw new Error(`import-handoff: '${o.jsonFile}' is not valid JSON: ${e.message}`);
    }
    // Accept a bare handoff object OR a full session record with a `.handoff`.
    handoffObj = (parsed && typeof parsed === 'object' && parsed.handoff && typeof parsed.handoff === 'object')
      ? parsed.handoff
      : parsed;
    if (!handoffObj || typeof handoffObj !== 'object') {
      throw new Error(`import-handoff: '${o.jsonFile}' has no handoff object`);
    }
  } else if (o.txtFile) {
    const where = takePre(pre.txt).replace(/\s+$/, '');   // trim trailing whitespace/newline
    const next = o.next != null ? o.next : (o.nextFile ? takePre(pre.nextFile).replace(/\s+$/, '') : undefined);
    if (!next || String(next).trim() === '') {
      throw new Error(
        'import-handoff --txt-file: handoff replace also needs a non-empty `next` — pass --next <str> ' +
        'or --next-file <file> (the required `next` cannot be invented from the where-text alone)',
      );
    }
    handoffObj = { where, next };
    if (o.inFlight && o.inFlight.length) handoffObj.in_flight = o.inFlight;
    if (o.mustNotRedo && o.mustNotRedo.length) handoffObj.must_not_redo = o.mustNotRedo;
  } else {
    throw new Error('import-handoff: a source is required — --json-file <f> OR --txt-file/--file <f>');
  }

  record = model.importHandoff(record, handoffObj);   // REPLACE; editable-only; re-stamps updatedAt
  return persist(record, pOpts(o, track));
}

/**
 * opImportLog({ sessionsDir, number, txtFile, type?, status?, why?, now? }) -> record   (APPEND-ONLY)
 * Appends ONE log entry whose body is the raw text file. Default type "log" with `--status` (default
 * "NOTE"); or type "decision" (`--decision`) whose `what` is the file and `why` from `--why`.
 * Existing entries are NEVER rewritten (monotonic seq preserved by the model).
 */
function opImportLog(opts) {
  const o = opts || {};
  const pre = preRead(o.txtFile);
  return runMutating(o, 'import-log', () => opImportLogBody(o, pre));
}

function opImportLogBody(o, pre) {
  const track = ownTrack(o);
  let record = loadForWrite(o.sessionsDir, o.number, track);
  const body = takePre(pre).replace(/\s+$/, '');
  if (body === '') throw new Error(`import-log: '${o.txtFile}' is empty — nothing to append`);
  let entry;
  if (o.type === 'decision') {
    if (!o.why || String(o.why).trim() === '') throw new Error('import-log --decision: --why <str> is required');
    entry = { type: 'decision', what: body, why: o.why };
  } else {
    entry = { type: 'log', status: o.status || 'NOTE', text: body };
  }
  record = model.importLogAddendum(record, [entry]);
  return persist(record, pOpts(o, track));
}

/**
 * opImportPunchlist({ sessionsDir, number, file, now? }) -> record   (ADD/merge)
 * Reads items from a file: a JSON array (of strings OR {text} objects), or a plain text file with
 * one item per non-empty line. Each becomes a new open item; state is NEVER set by import.
 */
function opImportPunchlist(opts) {
  const o = opts || {};
  const pre = preRead(o.file);
  return runMutating(o, 'import-punchlist', () => opImportPunchlistBody(o, pre));
}

function opImportPunchlistBody(o, pre) {
  const track = ownTrack(o);
  let record = loadForWrite(o.sessionsDir, o.number, track);
  const items = parsePunchlistItems(takePre(pre), o.file);
  if (!items.length) throw new Error(`import-punchlist: '${o.file}' yielded no items`);
  record = model.importPunchlist(record, items);
  return persist(record, pOpts(o, track));
}

// Parse punchlist items from raw file contents: JSON array first, else one-item-per-line text.
function parsePunchlistItems(raw, file) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    let arr;
    try {
      arr = JSON.parse(trimmed);
    } catch (e) {
      throw new Error(`import-punchlist: '${file}' looks like JSON but did not parse: ${e.message}`);
    }
    if (!Array.isArray(arr)) throw new Error(`import-punchlist: '${file}' JSON must be an array`);
    return arr.map((el) => (typeof el === 'string' ? { text: el } : { text: el && el.text, slug: el && el.slug }));
  }
  // plain text: one item per non-empty line
  return trimmed.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) => ({ text: l }));
}

// ── CLI ────────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const verb = argv[0];
  const o = { inFlight: [], mustNotRedo: [] };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`tpm-session-ops: ${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--sessions-dir': o.sessionsDir = next(); break;
      case '--session': case '--number': o.number = next(); break;
      case '--session-id': o.sessionId = next(); break;
      case '--track': o.track = next(); break;
      case '--tpm-version': o.tpmVersion = next(); break;
      case '--prior-session-path': case '--from': o.priorSessionPath = next(); break;
      case '--now': o.now = next(); break;
      case '--reason': o.reason = next(); break;
      case '--even-if-running': case '--confirm': o.confirm = true; break;
      // note
      case '--decision': case '--decide': o.type = 'decision'; break;
      case '--log': o.type = 'log'; break;
      case '--what': o.what = next(); break;
      case '--why': o.why = next(); break;
      case '--status': o.status = next(); break;
      case '--text': o.text = next(); break;
      // punchlist
      case '--action': o.action = next(); break;
      case '--slug': o.slug = next(); break;
      case '--item': o.item = next(); o.idOrSlug = o.idOrSlug || o.item; break;
      case '--id': o.idOrSlug = next(); break;
      // import
      case '--json-file': o.jsonFile = next(); break;
      // #2 (smoke): --txt-file and --file are ALIASES — every import verb accepts BOTH spellings.
      // import-handoff/import-log read o.txtFile; import-punchlist reads o.file; keep both in sync.
      case '--txt-file': case '--file': { const v = next(); o.txtFile = v; o.file = v; break; }
      case '--next': o.next = next(); break;
      case '--next-file': o.nextFile = next(); break;
      case '--in-flight': o.inFlight.push(next()); break;
      case '--must-not-redo': o.mustNotRedo.push(next()); break;
      case '-v': case '--verbose': o.verbose = true; break;   // F1: also print the written file paths
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`tpm-session-ops: unknown argument '${a}'`);
    }
  }
  return { verb, opts: o };
}

const USAGE = `tpm-session-ops — session write-ops + import (#1115) (run: tpm session <verb> …)

The verbs below are TOP-LEVEL session verbs — call them directly (\`tpm session open …\`, etc.).
The old \`ops\` grouping was removed (flatten); typing it now just hints at this flattened form.

Common:  --sessions-dir <dir>   store dir holding per-session folders session-<NNNN>/ (a SCRATCH or real
                                dir; created for open). OPTIONAL (F4): omitted → resolved from the LOCAL
                                project's .claude/claude-tpm/config.json (session.notes.sessionsDir); the
                                flag OVERRIDES; with NEITHER it FAILS LOUD (never defaults to a live store).
         --track <letter>       OPTIONAL: the track to act on (a letter a-z only; a session designator like 0001b is rejected). By default a write verb acts on YOUR track,
                                resolved from your Claude session id; a track owned by another session is refused.
         --session <NNNN>       session number (aka --number). ALWAYS 4-digit zero-padded: --session 1 is
                                normalized to 0001, so the folder (session-0001/) and stored meta.number agree.
         --now <iso>            reference time for punchlist age (default: now, local offset)
         --verbose, -v          also print the written .json / .md file paths (default: the transition line only)

Verbs:
  open          --session <NNNN> --session-id <id> [--tpm-version v] [--prior-session-path <json>]
  save          --session <NNNN>
  note          --session <NNNN> (--log --status NOTE --text "…" | --decision --what "…" --why "…")
  punchlist     --session <NNNN> --action add|close|reopen|drop|carry-in
                    add:      --text "…" [--slug s]
                    close/reopen/drop: --item <id|slug>   (an id is accepted as 123.4 or 123a.4; only items on YOUR
                                       track can be changed - another track's item is refused, naming its owner)
                    carry-in: --from <prior json> --item <id|slug>
  close         --session <NNNN>       (REFUSES unless a handoff AND a punchlist are present; seals ONLY your own track)
  close         --session <NNNN> --track <other instance's letter> [--reason "…"] --even-if-running
                    The ABANDONED SEAL of a track another Claude instance owns (a dead train). Writes a seal marker
                    file; the record is untouched, the close guard is skipped, NO handoff is written for it. Without
                    --even-if-running (alias --confirm) it only prints what would be sealed (track, last write, liveness)
                    and exits 4. Show the person that evidence and get an explicit yes first.
  unseal        --session <NNNN> --track <letter>    undo another instance's seal of YOUR track (renames the marker to
                    a hidden audit file); the person decides - ask first

Import (#1115) — --txt-file and --file are ALIASES; every import verb accepts BOTH spellings (#2 smoke):
  import-handoff   --session <NNNN> (--json-file <f> | (--txt-file|--file) <f> --next "…"|--next-file <f>
                        [--in-flight "…"]… [--must-not-redo "…"]…)      REPLACE
  import-log       --session <NNNN> (--txt-file|--file) <f> [--status NOTE | --decision --why "…"]   APPEND-ONLY
  import-punchlist --session <NNNN> (--file|--txt-file) <f>   (JSON array of strings/{text}, or one item per line)  ADD

Import honors the LOCKED editable table (mechanical fields ignored; state never set by import). Each
write's canonical JSON is atomic; the derived .md is regenerated after the JSON write succeeds.`;

// ── F1: per-verb state-transition success lines (mirrors the self-verifying task suite) ──────────
// Each ops verb reports WHAT HAPPENED (a state transition), not the identical `wrote <json> <md>`
// that made the six results indistinguishable. The written file paths move behind --verbose.

function lastLog(record) {
  const log = record && Array.isArray(record.log) ? record.log : [];
  return log.length ? log[log.length - 1] : null;
}

function openPunchlistCount(record) {
  const pl = record && Array.isArray(record.punchlist) ? record.punchlist : [];
  return pl.filter((it) => it && it.state === 'open').length;
}

// The display form of an id (Q8): a track-a id of a multi-track session prints as "123a.4"; otherwise as stored.
function isMultiTrackSession(opts) {
  try {
    if (!opts || !opts.sessionsDir || opts.number === undefined || opts.number === null) return false;
    return ids.sessionIsMulti(T.listFolder(opts.sessionsDir, padNumber(opts.number)));
  } catch (_e) { return false; }
}

function describePunchlist(opts, record) {
  const pl = record && Array.isArray(record.punchlist) ? record.punchlist : [];
  const action = opts.action;
  const multi = isMultiTrackSession(opts);
  if (action === 'add' || action === 'carry-in') {
    const it = pl[pl.length - 1];
    const verbWord = action === 'add' ? 'added' : 'carried in';
    return it ? `${verbWord} #${ids.displayItemId(it.id, multi)} [${it.slug}]` : `${verbWord} an item`;
  }
  const key = opts.idOrSlug;
  const it = model.findItem({ punchlist: pl }, key);
  const verbWord = action === 'close' ? 'closed' : action === 'reopen' ? 'reopened' : 'dropped';
  return it ? `${verbWord} #${ids.displayItemId(it.id, multi)} [${it.slug}]` : `${verbWord} '${key}'`;
}

/** describeResult(verb, opts, record) -> a one-line STATE-TRANSITION summary for stderr (F1). */
function describeResult(verb, opts, record) {
  const num = record && record.meta ? record.meta.number : opts.number;
  switch (verb) {
    case 'open': {
      const carried = record && Array.isArray(record.punchlist) ? record.punchlist.length : 0;
      return `session ${num} opened` + (carried ? ` · ${carried} punchlist item(s) carried forward` : '');
    }
    case 'save':
      return `session ${num} saved` + (record && record.handoff ? ' · handoff re-stamped' : '');
    case 'note': {
      const last = lastLog(record);
      const seq = last ? last.seq : '?';
      const kind = last && last.type === 'decision' ? 'decision' : (last && last.status ? last.status : 'NOTE');
      return `logged ${kind} (entry #${seq})`;
    }
    case 'punchlist':
      return describePunchlist(opts, record);
    case 'close': {
      // #5 (smoke): name WHERE carried items surface — "carried" alone had no visible destination.
      const open = openPunchlistCount(record);
      const dest = open > 0 ? " (surface in the next session's boot-read)" : '';
      return `session ${num} closed · handoff ✓ · ${open} open punchlist item(s) carried${dest}`;
    }
    case 'import-handoff':
      return 'handoff set (where + next)';
    case 'import-log': {
      const last = lastLog(record);
      return `appended ${last && last.type === 'decision' ? 'decision' : 'log'} (entry #${last ? last.seq : '?'})`;
    }
    case 'import-punchlist': {
      const n = record && Array.isArray(record.punchlist) ? record.punchlist.length : 0;
      return `punchlist now has ${n} item(s)`;
    }
    default:
      return `${verb} ok`;
  }
}

/**
 * prefixOnce(prefix, msg) -> string   (F3)
 * Apply the tool-name prefix EXACTLY once — an op may throw a message that ALREADY carries it (e.g.
 * `tpm-session-ops: sessionsDir is required` or `tpm-session-ops close: refusing …`), which produced
 * the doubled `tpm-session-ops: tpm-session-ops …`. Strip a leading `<toolname>` (optionally
 * `<toolname> <verb>`) + `:` before re-adding. Fixed at the FORMATTER SOURCE so it cannot recur.
 */
function prefixOnce(prefix, msg) {
  const bare = prefix.replace(/:\s*$/, '');
  const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^' + esc + '(?:[ \\t][\\w-]+)?:\\s*');
  return prefix + String(msg == null ? '' : msg).replace(re, '');
}

function dispatch(verb, opts) {
  switch (verb) {
    case 'open': return opOpen(opts);
    case 'save': return opSave(opts);
    case 'note': return opNote(opts);
    case 'punchlist': return opPunchlist(opts);
    case 'close': return opClose(opts);
    case 'unseal': return opUnseal(opts);
    case 'import-handoff': return opImportHandoff(opts);
    case 'import-log': return opImportLog(opts);
    case 'import-punchlist': return opImportPunchlist(opts);
    default: throw new Error(`tpm-session-ops: unknown verb '${verb}' — see --help`);
  }
}

function main(argv) {
  if (!argv.length || argv[0] === '-h' || argv[0] === '--help') {
    process.stdout.write(USAGE + '\n');
    return 0;
  }
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (e) {
    process.stderr.write(String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (parsed.opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    T.assertSessionNumber(parsed.opts.number);   // '0001b' is not a session number: the track is --track b
  } catch (e) {
    process.stderr.write(`${prefixOnce('tpm-session-ops: ', e.message)}\n`);
    process.stdout.write(`${JSON.stringify({ refused: true, code: e.code, message: e.message, details: null }, null, 2)}\n`);
    return e.exitCode || 2;
  }
  // #3 (smoke): normalize --session ONCE at the arg boundary to the canonical 4-digit form, so the
  // on-disk folder (session-NNNN/) and the stored meta.number always AGREE (`--session 1` ⇒ 0001).
  // Invalid input is left untouched to fail loud downstream (the model's canonicalNumber rejects it).
  if (parsed.opts.number != null && String(parsed.opts.number).trim() !== '') {
    const n = Number(parsed.opts.number);
    if (Number.isInteger(n) && n >= 0) parsed.opts.number = padNumber(parsed.opts.number);
  }
  try {
    // F4: --sessions-dir is OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). It
    // NEVER silently defaults to a live store (resolveSessionsDir throws loud when neither is present).
    if (!parsed.opts.sessionsDir) {
      parsed.opts.sessionsDir = sessionConfig.resolveSessionsDir(undefined, undefined).sessionsDir;
    }
    // `unseal`: the documented way back after another instance sealed a track (renames the seal marker).
    if (parsed.verb === 'unseal') {
      const r = opUnseal(parsed.opts);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.stderr.write(r.unsealed
        ? `tpm-session-ops unseal: track ${r.track} of ${r.number} un-sealed (marker kept as ${path.basename(r.auditPath)})\n`
        : `tpm-session-ops unseal: track ${r.track} of ${r.number} has no seal marker; nothing to do\n`);
      return 0;
    }
    const callerIdent = readIdentity({ withStartTime: false });
    const abandoned = parsed.verb === 'close' && parsed.opts.number != null && String(parsed.opts.number).trim() !== ''
      && parsed.opts.track && isForeignTrack(parsed.opts.sessionsDir, parsed.opts.number, parsed.opts.track, callerIdent);
    if (abandoned) {
      // Sealing ANOTHER instance's track: the abandoned seal. Always needs --even-if-running (alias --confirm).
      const r = opSealAbandoned(Object.assign({}, parsed.opts, { identity: readIdentity({ withStartTime: true }) }));
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      if (!r.sealed) {
        process.stderr.write(`${formatSealPlan([r.plan])}\nNOTHING was sealed. Show this to the person; only on an explicit yes re-run with --even-if-running.\n`);
        return 4;
      }
      process.stderr.write(r.already
        ? `tpm-session-ops close: track ${r.plan.track} of ${r.plan.number} was already sealed; nothing written\n`
        : `tpm-session-ops close: track ${r.plan.track} of ${r.plan.number} sealed as abandoned (no handoff was written for it; recorded in ${path.basename(T.trackPaths(parsed.opts.sessionsDir, r.plan.number, r.plan.track).sealedPath)})\n`);
      return 0;
    }
    if (parsed.opts.confirm || parsed.opts.reason !== undefined) {
      throw new T.TrackError('ETRACK_ARG', '--even-if-running / --reason only apply to `close --session N --track <another instance\'s letter>` (the abandoned seal). Nothing was written.');
    }
    // Write verbs act on MY track: each op resolves it itself (ownTrack, inside its lock), so --track passes through
    // untouched here. `open` claims the requested/first one.
    const record = dispatch(parsed.verb, parsed.opts);
    // F1: report the STATE TRANSITION (not the identical two paths). Paths move behind --verbose.
    process.stderr.write(`tpm-session-ops ${parsed.verb}: ${describeResult(parsed.verb, parsed.opts, record)}\n`);
    if (parsed.opts.verbose) {
      const { jsonPath, mdPath } = sessionPaths(parsed.opts.sessionsDir, record.meta.number, (record.meta && record.meta.track) || parsed.opts.track);
      process.stderr.write(`  wrote ${jsonPath}\n  wrote ${mdPath}\n`);
    }
    return 0;
  } catch (e) {
    process.stderr.write(prefixOnce('tpm-session-ops: ', e && e.message ? e.message : e) + '\n');
    if (e instanceof T.TrackError) {
      process.stdout.write(`${JSON.stringify({ refused: true, code: e.code, message: e.message, details: e.details || null }, null, 2)}\n`);
      return e.exitCode;
    }
    return 1;
  }
}

module.exports = {
  // ops
  opOpen, opSave, opNote, opPunchlist, opClose,
  // import
  opImportHandoff, opImportLog, opImportPunchlist,
  // guard + helpers (exported for tests)
  assertCloseGuard, sessionPaths, padNumber, parsePunchlistItems, persist, mutate, ownTrack, touchOwner,
  describeResult, prefixOnce, formatSealPlan, opSealAbandoned, opUnseal,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
