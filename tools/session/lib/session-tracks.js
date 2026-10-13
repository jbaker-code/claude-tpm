'use strict';
/**
 * session-tracks.js — the tracks store: naming, reading ("is this track sealed?"), ownership, claims, the hint.
 *
 * A session FOLDER `<sessionsDir>/session-NNNN/` holds one record per TRACK (one Claude instance each):
 *     track a      session-NNNN.json        (UNSUFFIXED — exactly today's name; Q3)        + .md derived
 *     track b..z   session-NNNN-b.json …                                                    + .md derived
 *     seal marker  session-NNNN[-x].sealed (read by trackState; written ONLY by sealByMarker, removed only by unsealTrack)
 * Each record is written only by the instance that owns it (meta.claudeSessionId). "Which session am I in"
 * is answered by Claude session id; `<sessionsDir>/.current-session.json` is a NON-AUTHORITATIVE hint kept
 * true (derived from the tracks) — new code never decides "current" from it (one narrow exception: the O-3
 * upgrade aid in tpm-session-current.js, which only ever CREATES a missing record).
 *
 * NO schemaVersion bump: per-track info rides in ADDITIVE `meta` keys (see session-schema.js).
 * Claims are lock-free exclusive creates: the session number by a non-recursive `mkdir`, the track record
 * by `link`-from-a-prepared-temp (io.exclusiveCreateFileSync — NOT `wx`).
 *
 * Reading is HONEST (decision B1): `scanSessions().skipped` / `.unrecognised` always list what could not be
 * read; nothing is silently dropped. `trackState()` is the ONE place "is this track sealed" is decided.
 *
 * Identity is never read from the environment here: callers pass an `identity` object
 * ({ claudeSessionId, claudePid, claudePidStartedAt, hostname }) obtained from tools/lib/identity.js.
 * Zero deps; Node built-ins only.
 */
const fs = require('fs');
const path = require('path');

const io = require('../../lib/io');
const { nowIsoTz } = require('../../lib/timestamp');
const { tpmVersion } = require('../../lib/tpm-version');
const { isProcessAlive, processStartedAt } = require('../../lib/identity');
const model = require('./session-model');
const ids = require('./session-ids');
const { withSessionLock } = require('./session-lock');
const { render } = require('./session-converter');

// ── constants ───────────────────────────────────────────────────────────────

const TRACK_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const MAX_TRACKS = 26;                 // Q9: hard cap (a-z)
const SCAN_WINDOW = 20;                // newest N session folders scanned by default
const CLAIM_GRACE_MS = 1500;           // how long a loser waits for a stalled creator's first record
const GATE_MAX_ROUNDS = 5;
const TRACK_FILE_RE = /^session-(\d+)(?:-([b-z]))?\.(json|md|sealed)$/;   // absent letter = track a
const FOLDER_RE = /^session-(\d{3,4})$/;
const HINT_FILENAME = '.current-session.json';

// ── errors ──────────────────────────────────────────────────────────────────

const EXIT_CODES = { ESESSION_FOREIGN_TRACK: 3, ESESSION_AMBIGUOUS: 3, ESEAL_NEEDS_CONFIRM: 4, ETRACK_SELECTOR: 2, ESESSION_DESIGNATOR: 2 };   // 3 = gate refusal, 4 = abandoned seal needs confirmation; every other code exits 1

class TrackError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'TrackError';
    this.code = code;
    this.exitCode = EXIT_CODES[code] || 1;
    this.details = details || null;
  }
}

// ── naming ──────────────────────────────────────────────────────────────────

function padNumber(number) {
  const n = Number(number);
  return Number.isFinite(n) ? String(n).padStart(4, '0') : String(number == null ? '' : number);
}

function isTrackLetter(x) {
  return typeof x === 'string' && /^[a-z]$/.test(x);
}

/** parseTrackFile('session-0123-b.json') -> { number:'0123', track:'b', ext:'json' } | null  (a = unsuffixed). */
function parseTrackFile(name) {
  const m = TRACK_FILE_RE.exec(String(name));
  if (!m) return null;
  return { number: padNumber(m[1]), track: m[2] || 'a', ext: m[3] };
}

/** trackPaths(sessionsDir, number, track='a') -> { number, track, folder, jsonPath, mdPath, sealedPath } */
function trackPaths(sessionsDir, number, track) {
  if (!sessionsDir) throw new TrackError('ETRACK_ARG', 'tpm-session: sessionsDir is required');
  if (number === undefined || number === null || String(number) === '') {
    throw new TrackError('ETRACK_ARG', 'tpm-session: session number is required');
  }
  const letter = track === undefined || track === null ? 'a' : track;
  if (!isTrackLetter(letter)) throw new TrackError('ETRACK_ARG', `tpm-session: track must be one letter a-z, got ${JSON.stringify(track)}`);
  const nnnn = padNumber(number);
  const folder = path.join(sessionsDir, `session-${nnnn}`);
  const stem = `session-${nnnn}${letter === 'a' ? '' : `-${letter}`}`;
  return {
    number: nnnn,
    track: letter,
    folder,
    jsonPath: path.join(folder, `${stem}.json`),
    mdPath: path.join(folder, `${stem}.md`),
    sealedPath: path.join(folder, `${stem}.sealed`),
  };
}

// ── folder listing ──────────────────────────────────────────────────────────

const LEGACY_THREE_FILE_RE = /^session-\d+-(handoff|log|punchlist)\.md$/;

/**
 * listFolder(sessionsDir, number) -> { number, tracks:[{track, files:{json,md,sealed}}], unrecognised:[{file, why}] }
 * One readdir. A hand-made `-a` file, a number mismatch, or any other `session-*` name is `unrecognised`
 * (reported, never silently ignored, never treated as a track). Dotfiles, `*.tmp` and the legacy 3-file
 * shape are ignored.
 */
function listFolder(sessionsDir, number) {
  const nnnn = padNumber(number);
  const folder = path.join(sessionsDir, `session-${nnnn}`);
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch (_e) {
    return { number: nnnn, tracks: [], unrecognised: [] };
  }
  const byLetter = new Map();
  const unrecognised = [];
  for (const name of names.sort()) {
    if (name.startsWith('.') || name.endsWith('.tmp')) continue;
    if (!name.startsWith('session-')) continue;
    if (LEGACY_THREE_FILE_RE.test(name)) continue;
    const parsed = parseTrackFile(name);
    if (!parsed) {
      unrecognised.push({
        file: name,
        why: /^session-\d+-a\./.test(name) ? 'suffix -a is not allowed (track a is unsuffixed)' : 'not a track file name',
      });
      continue;
    }
    if (parsed.number !== nnnn) {
      unrecognised.push({ file: name, why: `number ${parsed.number} does not match folder session-${nnnn}` });
      continue;
    }
    if (!byLetter.has(parsed.track)) byLetter.set(parsed.track, { track: parsed.track, files: { json: false, md: false, sealed: false } });
    byLetter.get(parsed.track).files[parsed.ext] = true;
  }
  const tracks = [];
  for (const letter of TRACK_LETTERS) {
    const t = byLetter.get(letter);
    if (!t) continue;
    if (!t.files.json && !t.files.sealed) {
      unrecognised.push({ file: path.basename(trackPaths(sessionsDir, nnnn, letter).mdPath), why: 'derived file without a record' });
      continue;
    }
    tracks.push(t);
  }
  return { number: nnnn, tracks, unrecognised };
}

// ── ownership ───────────────────────────────────────────────────────────────

/** ownerOf(meta) -> { claudeSessionId, source:'meta'|'legacy-sessionIds'|'none', claudePid, claudePidStartedAt, hostname } */
function ownerOf(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const evidence = {
    claudePid: m.claudePid === undefined ? null : m.claudePid,
    claudePidStartedAt: m.claudePidStartedAt === undefined ? null : m.claudePidStartedAt,
    hostname: m.hostname === undefined ? null : m.hostname,
  };
  if (Object.prototype.hasOwnProperty.call(m, 'claudeSessionId')) {
    const v = typeof m.claudeSessionId === 'string' && m.claudeSessionId ? m.claudeSessionId : null;
    return { claudeSessionId: v, source: 'meta', ...evidence };
  }
  if (Array.isArray(m.sessionIds) && m.sessionIds.length) {
    const last = m.sessionIds[m.sessionIds.length - 1];
    return { claudeSessionId: typeof last === 'string' && last ? last : null, source: 'legacy-sessionIds', ...evidence };
  }
  return { claudeSessionId: null, source: 'none', ...evidence };
}

/** Equality for the explicit-`--track` check, where a null on either side never blocks. */
function ownerMatches(callerId, ownerId) {
  if (callerId == null || ownerId == null) return true;
  return callerId === ownerId;
}

// ── reading one track ───────────────────────────────────────────────────────

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_e) { /* ignore */ }
}

function classifyLoadError(message) {
  const m = String(message || '');
  if (/newer schemaVersion|schemaVersion .*newer|unknown.*schemaVersion/i.test(m)) return 'newer-schema';
  if (/not valid JSON/i.test(m)) return 'corrupt';
  if (/cannot read/i.test(m)) return 'io';
  return 'invalid';
}

function statMtimeMs(p) {
  try { return fs.statSync(p).mtimeMs; } catch (_e) { return null; }
}

// Load a record, re-reading a few times when the file is empty/unparseable AND young (a creator that used
// the `wx` fallback may still be writing). A link-created file is never partial, so this is a no-op there.
function loadRecordRetrying(jsonPath) {
  let lastErr;
  for (let i = 0; i < 4; i += 1) {
    try {
      return { record: model.loadSession(jsonPath), error: null };
    } catch (err) {
      lastErr = err;
      const reason = classifyLoadError(err && err.message);
      if (reason !== 'corrupt') break;
      const mt = statMtimeMs(jsonPath);
      if (mt === null || Date.now() - mt > 5000) break;
      sleepMs(20);
    }
  }
  return { record: null, error: lastErr };
}

function readMarker(sealedPath) {
  let lastErr = null;
  for (let i = 0; i < 3; i += 1) {
    try {
      const raw = fs.readFileSync(sealedPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { marker: parsed, error: null };
      lastErr = new Error('marker is not a JSON object');
    } catch (err) {
      lastErr = err;
    }
    sleepMs(20);
  }
  return { marker: null, error: lastErr };
}

function newestIso(candidates) {
  let best = null;
  let bestMs = -Infinity;
  for (const c of candidates) {
    if (typeof c !== 'string') continue;
    const ms = Date.parse(c);
    if (Number.isFinite(ms) && ms > bestMs) { best = c; bestMs = ms; }
  }
  return best;
}

function lastWriteOf(record) {
  const meta = record.meta || {};
  const log = Array.isArray(record.log) ? record.log : [];
  return newestIso([
    record.handoff && record.handoff.updatedAt,
    log.length ? log[log.length - 1].ts : null,
    meta.lastWriter && meta.lastWriter.at,
    meta.openedAt,
  ]);
}

/**
 * trackState(sessionsDir, number, letter) -> state object | null (not a track). NEVER throws, NEVER writes.
 * state: 'live' | 'sealed' | 'unreadable'; sealedBy 'marker' (wins) | 'self' (meta.closedAt) | null.
 * This is the ONLY function that decides whether a track is sealed.
 */
function trackState(sessionsDir, number, letter) {
  const p = trackPaths(sessionsDir, number, letter);
  const files = {
    json: fs.existsSync(p.jsonPath),
    md: fs.existsSync(p.mdPath),
    sealed: fs.existsSync(p.sealedPath),
  };
  if (!files.json && !files.sealed) return null;
  const out = {
    number: p.number, track: p.track, state: 'live', sealedBy: null, record: null, marker: null, owner: null,
    openedAt: null, closedAt: null, sealedAt: null, lastWriteAt: null, reason: null, message: null, files, warnings: [],
    jsonPath: p.jsonPath,
  };
  let loaded = { record: null, error: null };
  if (files.json) loaded = loadRecordRetrying(p.jsonPath);
  if (loaded.record) {
    const meta = loaded.record.meta || {};
    out.record = loaded.record;
    out.owner = ownerOf(meta);
    out.openedAt = meta.openedAt || null;
    out.closedAt = meta.closedAt || null;
    out.lastWriteAt = lastWriteOf(loaded.record);
    if (meta.track !== undefined && meta.track !== p.track) out.warnings.push('track-mismatch');
  }
  if (files.sealed) {
    const m = readMarker(p.sealedPath);
    out.state = 'sealed';
    out.sealedBy = 'marker';
    out.marker = m.marker;
    if (!m.marker) out.warnings.push('marker-unreadable');
    out.sealedAt = (m.marker && typeof m.marker.sealedAt === 'string' && m.marker.sealedAt) || out.closedAt || null;
    if (!files.json) out.warnings.push('marker-without-record');
    else if (!loaded.record) out.warnings.push('record-unreadable');
    return out;
  }
  if (!loaded.record) {
    const mt = statMtimeMs(p.jsonPath);
    out.state = 'unreadable';
    out.reason = classifyLoadError(loaded.error && loaded.error.message);
    out.message = loaded.error ? String(loaded.error.message) : 'unreadable';
    out.lastWriteAt = mt === null ? null : nowIsoTz(new Date(mt));
    return out;
  }
  if (out.closedAt) {
    out.state = 'sealed';
    out.sealedBy = 'self';
    out.sealedAt = out.closedAt;
  }
  if (!files.md) out.warnings.push('md-missing');
  return out;
}

function isUnsealed(ts) {
  return ts.state === 'live' || (ts.state === 'unreadable' && ts.sealedBy === null);
}

// ── scanning ────────────────────────────────────────────────────────────────

function listSessionNumbers(sessionsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const nums = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = FOLDER_RE.exec(e.name);
    if (m) nums.push(padNumber(m[1]));
  }
  return nums.sort((a, b) => Number(a) - Number(b));
}

/**
 * scanSessions(sessionsDir, { mode='window'|'all', windowSize, extraNumbers }) ->
 *   { sessions:[{number, tracks:[trackState], unrecognised}], skipped:[], unrecognised:[], superseded:[], scanned }
 * `skipped` lists EVERY unreadable record (reader honesty). A legacy-shaped unsealed record (no meta.track)
 * whose number is lower than the highest session number holding any track is `superseded` (flagged on the
 * trackState; see isSuperseded) — it does not count as live. New-shape records are never superseded.
 */
function scanSessions(sessionsDir, opts) {
  const o = opts || {};
  const mode = o.mode === 'all' ? 'all' : 'window';
  const size = Number.isInteger(o.windowSize) ? o.windowSize : SCAN_WINDOW;
  const all = listSessionNumbers(sessionsDir);
  let chosen = all;
  if (mode === 'window') {
    const keep = new Set(all.slice(Math.max(0, all.length - size)));
    for (const n of o.extraNumbers || []) {
      if (n != null && all.includes(padNumber(n))) keep.add(padNumber(n));
    }
    chosen = all.filter((n) => keep.has(n));
  }
  const sessions = [];
  const skipped = [];
  const unrecognised = [];
  for (const n of chosen) {
    const lf = listFolder(sessionsDir, n);
    const tracks = [];
    for (const t of lf.tracks) {
      const st = trackState(sessionsDir, n, t.track);
      if (!st) continue;
      tracks.push(st);
      if (st.state === 'unreadable') {
        skipped.push({ number: n, track: st.track, file: path.basename(st.jsonPath), reason: st.reason, message: st.message });
      }
    }
    for (const u of lf.unrecognised) unrecognised.push({ number: n, file: u.file, why: u.why });
    sessions.push({ number: n, tracks, unrecognised: lf.unrecognised });
  }
  const withTracks = sessions.filter((s) => s.tracks.length);
  const highest = withTracks.length ? Number(withTracks[withTracks.length - 1].number) : null;
  const superseded = [];
  for (const s of sessions) {
    for (const st of s.tracks) {
      st.superseded = false;
      if (st.state === 'live' && st.record && highest !== null && Number(s.number) < highest
          && !(st.record.meta && st.record.meta.track !== undefined)) {
        st.superseded = true;
        superseded.push(brief(st));
      }
    }
  }
  return { sessions, skipped, unrecognised, superseded, scanned: { mode, folders: chosen.length } };
}

function brief(st) {
  const b = {
    number: st.number, track: st.track, state: st.state, sealedBy: st.sealedBy,
    owner: st.owner ? {
      claudeSessionId: st.owner.claudeSessionId, claudePid: st.owner.claudePid,
      claudePidStartedAt: st.owner.claudePidStartedAt, hostname: st.owner.hostname,
    } : null,
    openedAt: st.openedAt, lastWriteAt: st.lastWriteAt,
  };
  if (st.reason) { b.reason = st.reason; b.message = st.message; }
  return b;
}

/** All unsealed (live or unreadable-unsealed), non-superseded trackStates of a scan, ascending by number then letter. */
function unsealedTracks(scan) {
  const out = [];
  for (const s of scan.sessions) {
    for (const st of s.tracks) if (isUnsealed(st) && !st.superseded) out.push(st);
  }
  return out;
}

/** classify(unsealedStates, callerId) -> { mine, unowned, other, unreadable }  (trackState objects) */
function classify(states, callerId) {
  const c = { mine: [], unowned: [], other: [], unreadable: [] };
  for (const st of states) {
    if (st.state === 'unreadable') { c.unreadable.push(st); continue; }
    const id = st.owner ? st.owner.claudeSessionId : null;
    if (id === null) c.unowned.push(st);
    else if (callerId !== null && callerId !== undefined && id === callerId) c.mine.push(st);
    else c.other.push(st);
  }
  return c;
}

function byNumberTrackDesc(a, b) {
  const d = Number(b.number) - Number(a.number);
  return d !== 0 ? d : (a.track < b.track ? -1 : 1);
}

// ── claims ──────────────────────────────────────────────────────────────────

/** claimSessionFolder(sessionsDir, number) -> 'created' | 'exists'   (non-recursive mkdir of the folder). */
function claimSessionFolder(sessionsDir, number) {
  fs.mkdirSync(sessionsDir, { recursive: true });
  const folder = trackPaths(sessionsDir, number, 'a').folder;
  try {
    fs.mkdirSync(folder);
    return 'created';
  } catch (err) {
    if (err && err.code === 'EEXIST') return 'exists';
    throw err;
  }
}

function graceMs() {
  const v = Number(process.env.TPM_SESSION_CLAIM_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : CLAIM_GRACE_MS;
}

/** waitForFirstRecord(sessionsDir, number, ms) -> boolean  (true once any track file appears in the folder). */
function waitForFirstRecord(sessionsDir, number, ms) {
  const deadline = Date.now() + (ms === undefined ? graceMs() : ms);
  for (;;) {
    if (listFolder(sessionsDir, number).tracks.length) return true;
    if (Date.now() >= deadline) return false;
    sleepMs(20);
  }
}

/**
 * claimTrack(sessionsDir, number, { identity, tpmVersion, lastWriterVersion, letters, makeRecord, now, renderFn })
 *   -> { track, jsonPath, mdPath, record }      throws TrackError ETRACK_EXISTS | ETRACK_CAP
 * `letters: ['a']` (default) tries only the listed letters in order; `'any'` tries a..z. Each attempt builds
 * the record, validates it, and creates it with io.exclusiveCreateFileSync (link-from-temp). 'exists' moves
 * to the next letter; when none is left: ETRACK_EXISTS for a fixed list, ETRACK_CAP for 'any'.
 * The derived .md is written after the record exists; its failure does NOT unclaim (the JSON is the truth).
 */
function claimTrack(sessionsDir, number, opts) {
  const o = opts || {};
  const letters = o.letters === 'any' ? TRACK_LETTERS.slice(0, MAX_TRACKS) : (Array.isArray(o.letters) && o.letters.length ? o.letters : ['a']);
  const ver = o.tpmVersion === undefined ? null : o.tpmVersion;
  const lwv = o.lastWriterVersion === undefined ? tpmVersion() : o.lastWriterVersion;
  const renderFn = typeof o.renderFn === 'function' ? o.renderFn : render;
  const nnnn = padNumber(number);
  fs.mkdirSync(trackPaths(sessionsDir, nnnn, 'a').folder, { recursive: true });
  for (const letter of letters) {
    const p = trackPaths(sessionsDir, nnnn, letter);
    const record = typeof o.makeRecord === 'function'
      ? o.makeRecord(letter)
      : model.openTrack({ number: nnnn, track: letter, identity: o.identity, tpmVersion: ver, lastWriterVersion: lwv, now: o.now });
    model.validateRecord(record);
    const status = io.exclusiveCreateFileSync(p.jsonPath, `${JSON.stringify(record, null, 2)}\n`);
    if (status === 'created') {
      try {
        io.atomicWriteFileSync(p.mdPath, renderFn(record, { now: o.now || nowIsoTz() }));
      } catch (_e) { /* derived; `save` regenerates it */ }
      return { track: letter, jsonPath: p.jsonPath, mdPath: p.mdPath, record };
    }
  }
  if (o.letters === 'any') {
    throw new TrackError('ETRACK_CAP',
      `${MAX_TRACKS} tracks in session ${nnnn} (a-z all taken); seal the stale ones (close --track), or start the next session`);
  }
  throw new TrackError('ETRACK_EXISTS', `track ${letters.join('/')} of session ${nnnn} already exists`, { number: nnnn, letters });
}

// ── liveness evidence, adopt, parallel (open gate) ──────────────────────────

const START_TIME_TOLERANCE_MS = 2000;   // `ps lstart` has 1 s resolution

function sameInstant(a, b) {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= START_TIME_TOLERANCE_MS;
}

/**
 * livenessOf(owner, identity, { isAlive, startedAt }) -> { status:'running'|'gone'|'unknown', line, sameProcessNewSession }
 * EVIDENCE, never authority (PRD 4.4). Pid + start time, same host only:
 *   - owner pid not recorded                          -> unknown (no process id recorded)
 *   - recorded hostname null/different from this host -> unknown (recorded on another host)   — NEVER "gone"
 *   - same host, pid not alive                        -> gone
 *   - same host, alive, recorded start time differs from the live process's by > 2 s -> gone (pid reuse)
 *   - same host, alive (start time matches, or one side unknown)                    -> running
 * `sameProcessNewSession` = the owner's pid (+ start time when both known) IS the caller's own Claude process
 * but the Claude session ids differ: the signature of `/clear`. It is evidence FOR adopt; nothing acts on it.
 * `isAlive` / `startedAt` are injectable for tests.
 */
function livenessOf(owner, identity, opts) {
  const o = opts || {};
  const alive = typeof o.isAlive === 'function' ? o.isAlive : isProcessAlive;
  const started = typeof o.startedAt === 'function' ? o.startedAt : processStartedAt;
  const me = identity || {};
  const ow = owner || {};
  const out = { status: 'unknown', line: 'unknown (no process id recorded)', sameProcessNewSession: false };
  if (!Number.isSafeInteger(ow.claudePid) || ow.claudePid <= 1) return out;
  if (!ow.hostname || !me.hostname || ow.hostname !== me.hostname) {
    out.line = 'unknown (recorded on another host)';
    return out;
  }
  if (!alive(ow.claudePid)) {
    out.status = 'gone';
    out.line = 'owner process gone';
    return out;
  }
  let actual = null;
  if (ow.claudePidStartedAt) actual = started(ow.claudePid);
  if (ow.claudePidStartedAt && actual && !sameInstant(ow.claudePidStartedAt, actual)) {
    out.status = 'gone';
    out.line = `owner process gone (pid ${ow.claudePid} now belongs to a different, newer process)`;
    return out;
  }
  out.status = 'running';
  out.line = 'owner process running';
  if (me.claudePid === ow.claudePid && ow.claudeSessionId !== undefined
      && (me.claudeSessionId || null) !== (ow.claudeSessionId || null)) {
    const mine = ow.claudePidStartedAt ? (me.claudePidStartedAt || actual || started(me.claudePid)) : null;
    if (!ow.claudePidStartedAt || !mine || sameInstant(ow.claudePidStartedAt, mine)) out.sameProcessNewSession = true;
  }
  return out;
}

/** evidenceFor(trackState, identity) -> { liveness:{status,line,sameProcessNewSession} } shape used by the gate. */
function evidenceFor(st, identity, opts) {
  if (!st || st.state === 'unreadable' || !st.owner) {
    return { status: 'unknown', line: 'unknown (no process id recorded)', sameProcessNewSession: false };
  }
  return livenessOf(st.owner, identity, opts);
}

function findAdoptTarget(scan, letter, number) {
  const cands = [];
  for (const s of scan.sessions) {
    if (number && s.number !== padNumber(number)) continue;
    for (const st of s.tracks) if (st.track === letter) cands.push(st);
  }
  return cands;
}

/**
 * adoptTrack({ sessionsDir, track, number?, identity, evenIfRunning, now, lastWriterVersion, opts })
 *   -> { number, track, adopted:true|false, alreadyMine, from:{...}, liveness }
 * Re-points an UNSEALED track to the caller: meta.claudeSessionId + sessionIds (history) + claudePid /
 * claudePidStartedAt / hostname, and appends meta.adoptions[{at, from, via}]. The one deliberate cross-write
 * to a record another instance owns; it is an atomic rename-over followed by a re-read verification.
 * Refusals (TrackError, exit 1): EADOPT_NO_ID (caller has no readable Claude session id), EADOPT_NO_TRACK,
 * EADOPT_SEALED, EADOPT_UNREADABLE, EADOPT_RUNNING (owner process demonstrably running on this host and it
 * is not the caller's own process, unless evenIfRunning).
 */
function adoptTrack(o) {
  const identity = o.identity || {};
  const me = identity.claudeSessionId || null;
  const letter = o.track;
  if (!isTrackLetter(letter)) throw new TrackError('ETRACK_ARG', `--adopt needs one track letter a-z, got ${JSON.stringify(letter)}`);
  if (!me) {
    throw new TrackError('EADOPT_NO_ID', 'cannot adopt: your Claude session id is unreadable (CLAUDE_CODE_SESSION_ID is not set), so there is nothing to re-point the track to. Nothing was written.');
  }
  const hintInfo = readHint(o.sessionsDir);
  const scan = scanSessions(o.sessionsDir, { mode: o.number ? 'all' : 'window', extraNumbers: hintInfo.ok && hintInfo.hint.number ? [hintInfo.hint.number] : [] });
  const cands = findAdoptTarget(scan, letter, o.number);
  if (!cands.length) {
    throw new TrackError('EADOPT_NO_TRACK', `cannot adopt: no track ${letter}${o.number ? ` in session ${padNumber(o.number)}` : ''} exists in the scanned sessions. Nothing was written.`);
  }
  const unsealed = cands.filter((st) => isUnsealed(st) && !st.superseded);
  if (!unsealed.length) {
    const sealed = cands.filter((st) => st.state === 'sealed');
    if (sealed.length) {
      throw new TrackError('EADOPT_SEALED', `cannot adopt: track ${letter} of ${sealed[sealed.length - 1].number} is sealed (${sealed[sealed.length - 1].sealedBy}). A sealed track is finished; use --parallel or --next to start a new one. Nothing was written.`);
    }
    throw new TrackError('EADOPT_NO_TRACK', `cannot adopt: track ${letter} exists only as a superseded legacy record. Nothing was written.`);
  }
  unsealed.sort(byNumberTrackDesc);
  const target = unsealed[0];
  if (target.state === 'unreadable') {
    throw new TrackError('EADOPT_UNREADABLE', `cannot adopt: track ${letter} of ${target.number} cannot be read (${target.reason}); fix or seal it first. Nothing was written.`);
  }
  const fromOwner = {
    claudeSessionId: target.owner.claudeSessionId, claudePid: target.owner.claudePid, hostname: target.owner.hostname,
  };
  if (target.owner.claudeSessionId === me) {
    return { number: target.number, track: letter, adopted: false, alreadyMine: true, from: fromOwner, liveness: null };
  }
  const liveness = livenessOf(target.owner, identity, o.livenessOpts);
  if (liveness.status === 'running' && !liveness.sameProcessNewSession && !o.evenIfRunning) {
    throw new TrackError('EADOPT_RUNNING',
      `cannot adopt: the owner process of track ${letter} of ${target.number} is still running on this host (pid ${target.owner.claudePid}), and it is not your own process. `
      + 'Adopting it would take the track from a live session. If that session is truly finished or you are sure, re-run with --even-if-running. Nothing was written.',
      { number: target.number, track: letter, liveness });
  }
  // The rewrite below is a read-modify-write of a record its old owner may still be saving: take the session lock
  // (Q11) and RE-READ the record under it, so the adoption starts from what is on disk now, not from the scan.
  return withSessionLock(o.sessionsDir, target.number, 'adopt', () => {
  const fresh = trackState(o.sessionsDir, target.number, letter);
  if (!fresh || !fresh.record || fresh.state === 'sealed') {
    throw new TrackError('EADOPT_SEALED', `cannot adopt: track ${letter} of ${target.number} changed while adopting (now ${fresh ? fresh.state : 'gone'}). Nothing was written.`);
  }
  const at = o.now || nowIsoTz();
  const p = trackPaths(o.sessionsDir, target.number, letter);
  let rec = model.resumeSession(fresh.record, me);
  rec.meta.claudeSessionId = me;
  rec.meta.claudePid = identity.claudePid === undefined ? null : identity.claudePid;
  rec.meta.claudePidStartedAt = identity.claudePidStartedAt === undefined ? null : identity.claudePidStartedAt;
  rec.meta.hostname = identity.hostname === undefined ? null : identity.hostname;
  rec.meta.adoptions = (Array.isArray(rec.meta.adoptions) ? rec.meta.adoptions : []).concat([{
    at, from: fromOwner, via: o.evenIfRunning && liveness.status === 'running' && !liveness.sameProcessNewSession ? 'adopt --even-if-running' : 'adopt',
  }]);
  const lwv = o.lastWriterVersion === undefined ? tpmVersion() : o.lastWriterVersion;
  model.saveSession(rec, {
    jsonPath: p.jsonPath, mdPath: p.mdPath,
    render: (r) => (typeof o.renderFn === 'function' ? o.renderFn : render)(r, { now: at }),
    lastWriter: { version: lwv },
  });
  const back = model.loadSession(p.jsonPath);   // verification: a concurrent writer must not have undone it
  if (back.meta.claudeSessionId !== me) {
    throw new TrackError('ESESSION_RACE', `adopt of track ${letter} of ${target.number} was overwritten by a concurrent writer; re-run \`current --state\` and retry`);
  }
  return { number: target.number, track: letter, adopted: true, alreadyMine: false, from: fromOwner, liveness };
  });
}

/**
 * nextParallelTrack({ sessionsDir, number?, identity }) -> { number, track, recordPath, record }
 * Claims the next free track letter (a..z, never a sealed one) in the target session: the session holding
 * unsealed tracks (highest number if several), or `number` when given. The new track's punchlist is EMPTY
 * (decision Q6). ETRACK_CAP at 26. Refuses EPARALLEL_NO_TARGET (nothing to run in parallel to) and
 * EPARALLEL_NO_ID (the caller has no readable session id: an unowned track would be joinable by anyone).
 */
function claimParallelTrack(o) {
  const identity = o.identity || {};
  if (!identity.claudeSessionId) {
    throw new TrackError('EPARALLEL_NO_ID', 'cannot start a parallel track: your Claude session id is unreadable (CLAUDE_CODE_SESSION_ID is not set), so the new track could not be tied to you. Nothing was written.');
  }
  const hintInfo = readHint(o.sessionsDir);
  const scan = scanSessions(o.sessionsDir, { mode: o.number ? 'all' : 'window', extraNumbers: hintInfo.ok && hintInfo.hint.number ? [hintInfo.hint.number] : [] });
  let number = null;
  if (o.number) {
    number = padNumber(o.number);
    if (!scan.sessions.some((s) => s.number === number && s.tracks.length)) {
      throw new TrackError('EPARALLEL_NO_TARGET', `cannot start a parallel track: session ${number} does not exist. Nothing was written.`);
    }
  } else {
    const un = unsealedTracks(scan);
    if (!un.length) {
      throw new TrackError('EPARALLEL_NO_TARGET', 'cannot start a parallel track: no session has an unsealed track to run alongside. Use a plain --open. Nothing was written.');
    }
    un.sort(byNumberTrackDesc);
    number = un[0].number;
  }
  const mine = unsealedTracks(scan).filter((st) => st.number === number && st.owner && st.owner.claudeSessionId === identity.claudeSessionId);
  if (mine.length) {
    throw new TrackError('EPARALLEL_ALREADY_MINE', `cannot start a parallel track: you already own an unsealed track in session ${number} (track ${mine[0].track}); a plain --open returns it. Nothing was written.`);
  }
  const claimed = claimTrack(o.sessionsDir, number, {
    identity, tpmVersion: o.tpmVersion, letters: 'any', now: o.now, renderFn: o.renderFn,
  });
  return { number, track: claimed.track, recordPath: claimed.jsonPath, record: claimed.record };
}

// ── write-track resolution (conservative D6) ────────────────────────────────

function shortId(id) { return id ? String(id).slice(0, 8) : 'unknown'; }

/**
 * resolveWriteTrack({ sessionsDir, number, track, identity }) -> { track, state }
 * Ladder (see build-contract 8.3). A session with NO track files resolves to 'a' so the op's own
 * "no such record" error stays what it is today.
 */
function resolveWriteTrack(o) {
  const { sessionsDir, number } = o;
  const callerId = o.identity && o.identity.claudeSessionId ? o.identity.claudeSessionId : null;
  const nnnn = padNumber(number);
  if (o.track !== undefined && o.track !== null && o.track !== '') {
    if (!isTrackLetter(o.track)) throw new TrackError('ETRACK_ARG', `--track must be one letter a-z, got ${JSON.stringify(o.track)}`);
    const st = trackState(sessionsDir, nnnn, o.track);
    if (!st) throw new TrackError('ENO_TRACK', `session ${nnnn} has no track ${o.track}`);
    const oid = st.owner ? st.owner.claudeSessionId : null;
    if (!ownerMatches(callerId, oid)) {
      throw new TrackError('ENOT_OWNER',
        `track ${o.track} of ${nnnn} belongs to another Claude session (${shortId(oid)}...); this write was refused. Use \`tpm session current --open\` to choose`);
    }
    return { track: o.track, state: st.state };
  }
  const lf = listFolder(sessionsDir, nnnn);
  const states = lf.tracks.map((t) => trackState(sessionsDir, nnnn, t.track)).filter(Boolean);
  if (!states.length) return { track: 'a', state: null };
  const open = states.filter((s) => s.state === 'live');
  const c = classify(open, callerId);
  if (c.mine.length === 1) return { track: c.mine[0].track, state: c.mine[0].state };
  if (c.mine.length > 1) {
    throw new TrackError('ETRACK_AMBIGUOUS', `several tracks of ${nnnn} are yours (${c.mine.map((s) => s.track).join(', ')}); pass --track <letter>`);
  }
  // nothing live is mine. If MY track was sealed by someone else's marker, say so loudly (DoD D) rather than
  // reporting an ambiguity; a track I closed myself is not guarded (Q-C7).
  if (callerId !== null) {
    const sealedMine = states.filter((s) => s.sealedBy === 'marker' && s.owner && s.owner.claudeSessionId === callerId);
    if (sealedMine.length) assertWritable(sealedMine[sealedMine.length - 1]);
  }
  if (callerId === null) {
    const cand = open;
    if (cand.length === 1) return { track: cand[0].track, state: cand[0].state };
    if (cand.length > 1) {
      throw new TrackError('ETRACK_AMBIGUOUS', `your Claude session id is unreadable and ${cand.length} tracks of ${nnnn} are unsealed (${cand.map((s) => s.track).join(', ')}); pass --track <letter>`);
    }
  } else {
    if (c.unowned.length === 1 && !c.other.length) return { track: c.unowned[0].track, state: c.unowned[0].state };
    // Nothing unsealed is mine, but I may have closed my OWN track: closing never makes my later writes refuse
    // (Q-C7), and the unsealed tracks of other instances are not what is being asked about.
    const selfSealedMine = states.filter((s) => s.sealedBy === 'self' && s.owner && s.owner.claudeSessionId === callerId);
    if (selfSealedMine.length === 1) return { track: selfSealedMine[0].track, state: selfSealedMine[0].state };
    if (selfSealedMine.length > 1) {
      throw new TrackError('ETRACK_AMBIGUOUS', `several tracks of ${nnnn} are yours (${selfSealedMine.map((s) => s.track).join(', ')}); pass --track <letter>`);
    }
    if (c.other.length) {
      const names = c.other.map((s) => `track ${s.track} (${shortId(s.owner && s.owner.claudeSessionId)}...)`).join(', ');
      throw new TrackError('ENOT_OWNER',
        `${names} of ${nnnn} belong to another Claude session; this write was refused. Use \`tpm session current --open\` to choose`);
    }
    if (c.unowned.length > 1) {
      throw new TrackError('ETRACK_AMBIGUOUS', `${c.unowned.length} unowned tracks of ${nnnn} are unsealed; pass --track <letter>`);
    }
  }
  // nothing unsealed
  if (states.length === 1) return { track: states[0].track, state: states[0].state };
  throw new TrackError('ETRACK_AMBIGUOUS', `every track of ${nnnn} is sealed or unreadable (${states.map((s) => s.track).join(', ')}); pass --track <letter>`);
}


// ── read selectors, item location, designators (phase 12) ──────────────────────

/** A `--session` value is a number (or a comma list of numbers), never '0001b': pick the track with --track. */
function assertSessionNumber(value) {
  if (value === undefined || value === null) return;
  for (const part of String(value).split(',')) {
    const v = part.trim();
    if (/^\d+[a-z]$/i.test(v)) {
      throw new TrackError('ESESSION_DESIGNATOR', `--session takes a session number like 0001, not '${v}'; pick the track with --track ${v.slice(-1).toLowerCase()}.`);
    }
  }
}

/**
 * resolveTrackSelector(sessionsDir, number, selector) -> letter           (a READ narrowing; never writes)
 *   one char a-z            -> that letter; it must exist in the session (ENO_TRACK)
 *   >= 8 chars              -> case-insensitive prefix of a track OWNER's Claude session id; exactly one match
 *                              (none: ENO_TRACK, several: ETRACK_SELECTOR_AMBIGUOUS)
 *   anything else           -> ETRACK_SELECTOR (malformed, never "no result")
 * A sealed or unreadable track is selectable. Write verbs do NOT use this (their --track is a letter only).
 */
function resolveTrackSelector(sessionsDir, number, selector) {
  const nnnn = padNumber(number);
  if (typeof selector !== 'string' || !(isTrackLetter(selector) || selector.length >= 8)) {
    throw new TrackError('ETRACK_SELECTOR',
      `--track '${typeof selector === 'string' ? selector : String(selector)}' is not a track: give one letter a-z or at least 8 characters of a Claude session id. Nothing was read.`);
  }
  const lf = listFolder(sessionsDir, nnnn);
  const letters = lf.tracks.map((t) => t.track);
  if (isTrackLetter(selector)) {
    if (!letters.includes(selector)) {
      throw new TrackError('ENO_TRACK', `session ${nnnn} has no track '${selector}' (tracks: ${letters.join(', ') || 'none'}).`);
    }
    return selector;
  }
  const want = selector.toLowerCase();
  const owners = letters.map((l) => {
    const st = trackState(sessionsDir, nnnn, l);
    const id = st && st.owner ? st.owner.claudeSessionId : null;
    return { track: l, id };
  });
  const hits = owners.filter((o) => o.id && String(o.id).toLowerCase().startsWith(want));
  if (hits.length === 1) return hits[0].track;
  if (hits.length === 0) {
    throw new TrackError('ENO_TRACK',
      `no track of session ${nnnn} is owned by a Claude session starting '${selector}' (tracks: ${owners.map((o) => `${o.track} (${o.id ? `${shortId(o.id)}...` : 'unowned'})`).join(', ') || 'none'}).`);
  }
  throw new TrackError('ETRACK_SELECTOR_AMBIGUOUS', `'${selector}' matches more than one track of session ${nnnn} (${hits.map((h) => h.track).join(', ')}); use the track letter.`);
}

/**
 * locateItem(sessionsDir, number, idOrSlug, { exceptTrack }) -> null | { track, item, state }   (a READ, never writes)
 * Used only to name the owner when a write verb is asked to change an item that is not on the caller's own track.
 * An id-shaped input names its track by its letter (ids.trackOfItemId) and must carry this session's number; a slug or
 * legacy id is searched in the other readable tracks (several hits: EITEM_AMBIGUOUS). Never opens a record for writing.
 */
function locateItem(sessionsDir, number, idOrSlug, opts) {
  const except = opts && opts.exceptTrack ? opts.exceptTrack : null;
  const nnnn = padNumber(number);
  const parsed = ids.parseItemId(idOrSlug);
  const fromState = (st) => {
    if (!st || !st.record || st.track === except) return null;
    const list = Array.isArray(st.record.punchlist) ? st.record.punchlist : [];
    return list;
  };
  if (parsed) {
    if (parsed.number !== Number(nnnn)) return null;
    const st = trackState(sessionsDir, nnnn, parsed.track);
    const list = fromState(st);
    const item = list && list.find((it) => it.id === parsed.stored);
    return item ? { track: st.track, item, state: st } : null;
  }
  const hits = [];
  for (const t of listFolder(sessionsDir, nnnn).tracks) {
    if (t.track === except) continue;
    const st = trackState(sessionsDir, nnnn, t.track);
    const list = fromState(st);
    const item = list && list.find((it) => it.slug === idOrSlug || it.id === idOrSlug);
    if (item) hits.push({ track: st.track, item, state: st });
  }
  if (hits.length > 1) {
    throw new TrackError('EITEM_AMBIGUOUS',
      `'${idOrSlug}' matches items in tracks ${hits.map((h) => h.track).join(', ')} of session ${nnnn}; use the item id (e.g. #${ids.displayItemId(hits[0].item.id, true)}). Nothing was changed.`);
  }
  return hits[0] || null;
}

// ── sealing: the write guard, the abandoned seal (marker writer), un-seal ───────────────────────────────

/**
 * assertWritable(trackState) -> void. A track sealed by a MARKER (someone else sealed it) refuses every
 * write with ETRACK_SEALED, naming who sealed it and when and how to continue. A track the owner closed
 * itself (`sealedBy:'self'`) is NOT guarded here (Q-C7 = no): closing your own track never starts
 * refusing your own later writes. Reads "is sealed" off the trackState it is given, never off a file.
 */
function assertWritable(st) {
  if (!st || st.sealedBy !== 'marker') return;
  const m = st.marker;
  const by = m && m.sealedBy ? m.sealedBy : null;
  const who = by ? `claude ${shortId(by.claudeSessionId)}${by.hostname ? `, host ${by.hostname}` : ''}` : 'unknown instance (marker unreadable)';
  const when = st.sealedAt || 'an unknown time';
  const reason = m && m.reason ? m.reason : 'unknown';
  throw new TrackError('ETRACK_SEALED',
    `track ${st.track} of session ${st.number} was sealed by another session (${who}) at ${when} (reason: ${reason}). Nothing you saved earlier is lost. `
    + `To continue on this track, ask the person, then run: tpm session unseal --session ${st.number} --track ${st.track}. `
    + 'Or open a new track: tpm session current --open --parallel.',
    { number: st.number, track: st.track, sealedAt: st.sealedAt, sealedBy: by, reason });
}

/** sealPlan(trackState, identity, opts) -> the evidence printed before any abandoned seal. */
function sealPlan(st, identity, opts) {
  const lv = evidenceFor(st, identity, opts);
  const ow = st.owner || {};
  return {
    number: st.number, track: st.track, state: st.state, sealedBy: st.sealedBy,
    lastWriteAt: st.lastWriteAt, openedAt: st.openedAt,
    owner: { claudeSessionId: ow.claudeSessionId || null, claudePid: ow.claudePid === undefined ? null : ow.claudePid, hostname: ow.hostname === undefined ? null : ow.hostname },
    liveness: lv.status, livenessLine: lv.line,
    unreadable: st.state === 'unreadable' ? st.reason : null,
  };
}

/**
 * sealByMarker(sessionsDir, number, letter, { by, reason, note, confirm, now, livenessOpts, lastWriterVersion })
 *   -> { plan, sealed:boolean, already:boolean, marker }
 * The ABANDONED SEAL: seals ANOTHER instance's track by creating `session-NNNN[-x].sealed` (exclusive create).
 * Never opens the record for write, never runs the close guard, never writes a handoff on the owner's behalf.
 * Without `confirm` it writes NOTHING and returns { sealed:false, plan } (the CLI prints it and exits 4).
 * There is NO own-pid / liveness exemption: confirmation is always required. Refuses ESEAL_SELF (the target
 * is the caller's own track: use `close`), ENO_TRACK, ETRACK_ARG. Idempotent: a track already sealed returns
 * { sealed:true, already:true } and writes nothing.
 */
function sealByMarker(sessionsDir, number, letter, o) {
  const opts = o || {};
  const nnnn = padNumber(number);
  if (!isTrackLetter(letter)) throw new TrackError('ETRACK_ARG', `sealing needs one track letter a-z, got ${JSON.stringify(letter)}`);
  const by = opts.by || {};
  const callerId = by.claudeSessionId || null;
  const st = trackState(sessionsDir, nnnn, letter);
  if (!st) throw new TrackError('ENO_TRACK', `session ${nnnn} has no track ${letter}; nothing was written.`);
  const ownerId = st.owner ? st.owner.claudeSessionId : null;
  if (callerId && ownerId && callerId === ownerId) {
    throw new TrackError('ESEAL_SELF', `track ${letter} of ${nnnn} is YOUR OWN track; seal it with an ordinary \`close\` (handoff + punchlist), not the abandoned seal. Nothing was written.`);
  }
  const plan = sealPlan(st, by, opts.livenessOpts);
  if (st.state === 'sealed') return { plan, sealed: true, already: true, marker: st.marker };
  if (!opts.confirm) return { plan, sealed: false, already: false, marker: null };
  const at = opts.now || nowIsoTz();
  const mine = callerId
    ? listFolder(sessionsDir, nnnn).tracks.map((t) => trackState(sessionsDir, nnnn, t.track)).filter((x) => x && isUnsealed(x) && x.owner && x.owner.claudeSessionId === callerId)
    : [];
  const ow = st.owner || {};
  const marker = {
    schema: 1,
    kind: 'seal-marker',
    number: nnnn,
    track: letter,
    reason: opts.reason || 'abandoned',
    note: opts.note === undefined ? null : opts.note,
    sealedAt: at,
    sealedBy: {
      claudeSessionId: callerId, claudePid: by.claudePid === undefined ? null : by.claudePid,
      claudePidStartedAt: by.claudePidStartedAt === undefined ? null : by.claudePidStartedAt,
      hostname: by.hostname === undefined ? null : by.hostname, track: mine.length ? mine[0].track : null,
    },
    ownerAtSeal: { claudeSessionId: ow.claudeSessionId || null, claudePid: ow.claudePid === undefined ? null : ow.claudePid, hostname: ow.hostname === undefined ? null : ow.hostname },
    lastSaveSeen: st.lastWriteAt || null,
    lastWriter: { version: opts.lastWriterVersion === undefined ? tpmVersion() : opts.lastWriterVersion, at },
  };
  const p = trackPaths(sessionsDir, nnnn, letter);
  const r = io.exclusiveCreateFileSync(p.sealedPath, `${JSON.stringify(marker, null, 2)}\n`);
  if (r === 'exists') {
    const again = trackState(sessionsDir, nnnn, letter);
    return { plan, sealed: true, already: true, marker: again ? again.marker : null };
  }
  try { writeHint(sessionsDir, { ifPresent: true }); } catch (_e) { /* the hint is advisory */ }
  return { plan, sealed: true, already: false, marker };
}

/**
 * unsealTrack(sessionsDir, number, letter, { now }) -> { number, track, unsealed:boolean, already:boolean, auditPath }
 * The documented un-seal path: renames `<name>.sealed` to a hidden audit file `.<name>.sealed.unsealed-<ts>`
 * (kept as the trail; dotfiles are ignored by the folder listing). The record is not touched. A track with no
 * marker is "already unsealed" (exit 0) unless the OWNER closed it (`meta.closedAt`): that is not an abandoned
 * seal and is refused (EUNSEAL_NOT_MARKER). Manual equivalent: `mv session-NNNN-b.sealed <anywhere>`.
 */
function unsealTrack(sessionsDir, number, letter, o) {
  const opts = o || {};
  const nnnn = padNumber(number);
  if (!isTrackLetter(letter)) throw new TrackError('ETRACK_ARG', `unseal needs one track letter a-z, got ${JSON.stringify(letter)}`);
  const st = trackState(sessionsDir, nnnn, letter);
  if (!st) throw new TrackError('ENO_TRACK', `session ${nnnn} has no track ${letter}; nothing was changed.`);
  if (st.sealedBy === 'self') {
    throw new TrackError('EUNSEAL_NOT_MARKER', `track ${letter} of ${nnnn} was closed by its own owner (meta.closedAt), not sealed by another session; there is no seal marker to remove. Nothing was changed.`);
  }
  const p = trackPaths(sessionsDir, nnnn, letter);
  if (!st.files.sealed) return { number: nnnn, track: letter, unsealed: false, already: true, auditPath: null };
  const ts = String(opts.now || nowIsoTz()).replace(/[^0-9A-Za-z]/g, '');
  const audit = path.join(p.folder, `.${path.basename(p.sealedPath)}.unsealed-${ts}`);
  try {
    fs.renameSync(p.sealedPath, audit);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { number: nnnn, track: letter, unsealed: false, already: true, auditPath: null };
    throw err;
  }
  try { writeHint(sessionsDir, { ifPresent: true }); } catch (_e) { /* the hint is advisory */ }
  return { number: nnnn, track: letter, unsealed: true, already: false, auditPath: audit };
}

/** sessionSummary(sessionsDir, number) -> { number, tracks:[trackState], sealed:bool, unsealed:[trackState] } */
function sessionSummary(sessionsDir, number) {
  const nnnn = padNumber(number);
  const tracks = listFolder(sessionsDir, nnnn).tracks.map((t) => trackState(sessionsDir, nnnn, t.track)).filter(Boolean);
  const unsealed = tracks.filter(isUnsealed);
  return { number: nnnn, tracks, sealed: tracks.length > 0 && unsealed.length === 0, unsealed };
}

// ── the hint (.current-session.json): non-authoritative, kept TRUE ──────────

function hintPath(sessionsDir) {
  return path.join(sessionsDir, HINT_FILENAME);
}

/** readHint(sessionsDir) -> { path, present, ok, hint, error }  — never throws. */
function readHint(sessionsDir) {
  const p = hintPath(sessionsDir);
  if (!fs.existsSync(p)) return { path: p, present: false, ok: false, hint: null, error: null };
  try {
    const hint = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) throw new Error('hint is not a JSON object');
    return { path: p, present: true, ok: true, hint, error: null };
  } catch (err) {
    return { path: p, present: true, ok: false, hint: null, error: err.message };
  }
}

function toUtcIso(s) {
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * deriveHint(sessionsDir, { prior, scan }) -> hint object | null   (pure function of the track files)
 * closedAt is null iff ANY track of `number` is unsealed (rule H1); number = highest session with an
 * unsealed track, else the highest session holding any track. null when there are no sessions at all.
 */
function deriveHint(sessionsDir, opts) {
  const o = opts || {};
  const prior = o.prior && typeof o.prior === 'object' ? o.prior : null;
  const scan = o.scan || scanSessions(sessionsDir, { extraNumbers: prior && prior.number ? [prior.number] : [] });
  const unsealed = unsealedTracks(scan);
  let number;
  let closedAt = null;
  let chosen = null;
  if (unsealed.length) {
    unsealed.sort(byNumberTrackDesc);
    number = unsealed[0].number;
    chosen = unsealed.filter((s) => s.number === number).sort((a, b) => (a.track < b.track ? -1 : 1))[0];
  } else {
    const withTracks = scan.sessions.filter((s) => s.tracks.length);
    if (!withTracks.length) return null;
    const last = withTracks[withTracks.length - 1];
    number = last.number;
    const sealTimes = last.tracks.map((t) => t.sealedAt).filter(Boolean);
    closedAt = (prior && prior.closedAt && prior.number === number ? prior.closedAt : null)
      || toUtcIso(newestIso(sealTimes)) || new Date().toISOString();
    chosen = last.tracks[0];
  }
  const samePrior = prior && prior.number === number;
  const ownerId = chosen && chosen.owner ? chosen.owner.claudeSessionId : null;
  return {
    sessionId: samePrior && 'sessionId' in prior ? prior.sessionId : ownerId,
    number,
    openedAt: (samePrior && prior.openedAt) || (chosen && toUtcIso(chosen.openedAt)) || new Date().toISOString(),
    closedAt,
  };
}

/**
 * writeHint(sessionsDir, { prior, ifPresent }) -> { hint, written }
 * derive -> atomic write (skipped when byte-identical) -> derive again, rewrite if different (max 3 rounds),
 * so an interleaved seal/claim cannot leave it stale. `ifPresent:true` writes only when a hint file exists.
 */
function writeHint(sessionsDir, opts) {
  const o = opts || {};
  const cur = readHint(sessionsDir);
  if (o.ifPresent && !cur.present) return { hint: null, written: false };
  let prior = o.prior || (cur.ok ? cur.hint : null);
  let hint = null;
  let written = false;
  for (let i = 0; i < 3; i += 1) {
    hint = deriveHint(sessionsDir, { prior });
    if (!hint) return { hint: null, written };
    const text = `${JSON.stringify(hint, null, 2)}\n`;
    let existing = null;
    try { existing = fs.readFileSync(hintPath(sessionsDir), 'utf8'); } catch (_e) { /* absent */ }
    if (existing !== text) {
      fs.mkdirSync(sessionsDir, { recursive: true });
      io.atomicWriteFileSync(hintPath(sessionsDir), text);
      written = true;
    }
    const again = deriveHint(sessionsDir, { prior: hint });
    if (again && JSON.stringify(again) === JSON.stringify(hint)) break;
    prior = hint;
  }
  return { hint, written };
}

/**
 * advisoryLine(sessionsDir, verbPhrase) -> string | null
 * One stderr line for readers that do not yet understand tracks (doctor / export): track files other than
 * track a, and unrecognised `session-*` files, exist and are NOT checked/included by this version.
 * Cheap (names only, one readdir per folder). Never throws.
 */
function advisoryLine(sessionsDir, phrase) {
  try {
    const names = [];
    for (const n of listSessionNumbers(sessionsDir)) {
      const lf = listFolder(sessionsDir, n);
      for (const t of lf.tracks) {
        if (t.track !== 'a') names.push(`session-${n}-${t.track}.json`);
        else if (t.files.sealed) names.push(`session-${n}.sealed`);
      }
      for (const u of lf.unrecognised) names.push(u.file);
    }
    if (!names.length) return null;
    return `note: ${names.length} track record file(s) (${names.slice(0, 6).join(', ')}${names.length > 6 ? ', ...' : ''}) ${phrase || 'are not checked by this version'}`;
  } catch (_e) {
    return null;
  }
}

module.exports = {
  advisoryLine,
  TRACK_LETTERS, MAX_TRACKS, SCAN_WINDOW, CLAIM_GRACE_MS, GATE_MAX_ROUNDS, TRACK_FILE_RE, HINT_FILENAME,
  TrackError,
  padNumber, isTrackLetter, parseTrackFile, trackPaths,
  listFolder, listSessionNumbers, scanSessions, trackState, unsealedTracks, isUnsealed, brief,
  classify, ownerOf, ownerMatches, byNumberTrackDesc,
  claimSessionFolder, waitForFirstRecord, claimTrack, resolveWriteTrack, sessionSummary,
  livenessOf, evidenceFor, adoptTrack, claimParallelTrack,
  assertWritable, sealPlan, sealByMarker, unsealTrack,
  resolveTrackSelector, locateItem, assertSessionNumber,
  hintPath, readHint, deriveHint, writeHint,
};
