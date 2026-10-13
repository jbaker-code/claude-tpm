#!/usr/bin/env node
'use strict';
/**
 * tpm-session-doctor.js — the READ-ONLY session-store validator / drift detector (#1119 + the
 * folded #1114 A/D "detect old-format + suggest migrate").
 *
 * It (a) schema+version-validates every canonical `session-<NNNN>.json` — discovered in the CANONICAL
 * NESTED per-session-folder layout (`session-<NNNN>/session-<NNNN>.json`, the live store's real shape
 * per the LOCKED spec, Q-F) — and
 * reports corruption / invalidity / unknown-newer-version loud + structured; (b) detects human-file
 * DRIFT by recomputing the content hash of the current JSON and comparing it to the
 * `(generated from: <12hex>)` token stamped in the derived `.md` banner (Q-D); and (c) detects OLD-FORMAT 3-file sessions with
 * no JSON counterpart and PRINTS a ready-to-run `tpm-session-migrate.js` suggestion.
 *
 * ── STRICTLY READ-ONLY ── the doctor NEVER writes, mutates, migrates, converts, or re-renders
 * ANYTHING. There is no `--fix`, no write path of any kind. It recomputes + compares only. A
 * fixing doctor would violate both the read-only remit and the never-auto-migrate rule (conversion
 * is `tpm-session-migrate.js`, run explicitly by a human).
 *
 * ── COMPOSES the blessed lib — re-implements no validation/hash/detection ──
 *   - lib/envelope.js       · readEnvelope(path)          — fail-loud read (+ _raw on-disk bytes).
 *   - lib/version.js        · migrate(record)             — refuse-unknown-NEWER guard.
 *   - lib/validate.js       · validateEnvelope(record,…)  — envelope + kind gate.
 *   - lib/session-schema.js · validatePayload             — the LOCKED payload validator.
 *   - lib/hash.js           · hashRecord(record)          — the SHARED content hash (drift anchor).
 *   - tpm-session-migrate   · detectShape(dir)            — the ONE old-format detector (collision C-A).
 *
 * ── DRIFT SEMANTICS (Q-D.4) ── the doctor hashes the RAW on-disk record (readEnvelope._raw), NOT
 *  the post-`migrate` in-memory record, because the banner was stamped from the on-disk bytes at
 *  save. Moot today (no migrations registered → raw === migrated); it matters only once real
 *  migrations exist, at which point hashing raw keeps the compare meaningful against a banner made
 *  from older bytes.
 *
 * ── NODE-INVOKABLE ── run via `tpm session doctor …` (routed), or bare `node tools/session/tpm-session-doctor.js …`;
 *  programmatic callers `require()` it for `runDoctor(...)`.
 *
 * Zero third-party deps; Node built-ins only.
 *
 * TRACKS (multi-session support) ── a session folder holds one record per track (`session-NNNN.json` = a, `-b`..`-z`), each
 *  drift-checked against ITS OWN `.md`; sealed-ness is read from trackState only. Report-only trouble checks: stale / owner-gone
 *  unsealed tracks (with the abandoned-seal hint), marker without record, duplicate track claims, file-name vs meta.track,
 *  `.lock*` and `*.tmp` leftovers. See tpm-session-doctor.md.
 *
 * USAGE
 *   node tpm-session-doctor.js --sessions-dir <dir> [--json] [--strict] [--track <t>] [--stale-after <3d>]
 *
 * FLAGS
 *   --sessions-dir <dir>  Optional (resolved from the project root via TPM_PROJECT_ROOT or the walk-up; this
 *                         flag is an explicit override). The sessions store. Canonical JSON is discovered in the nested
 *                         per-session-folder layout (session-<NNNN>/session-<NNNN>.json, the live
 *                         store's canonical shape); old-format 3-file subdirectories are detected
 *                         too. READ-ONLY.
 *   --json                Emit the structured report as JSON instead of human text.
 *   --strict              Promote advisories (drift / unstamped / old-format / number-form) to a
 *                         non-zero exit (2). By default only a validation FAIL exits non-zero (1).
 *   --help                Show this usage.
 *
 * EXIT CODES
 *   0  no validation FAILs (advisories allowed).
 *   1  at least one validation FAIL (unreadable / unknown-newer / schema-invalid).
 *   2  --strict + at least one advisory (and no hard FAIL).
 */
const fs = require('fs');
const path = require('path');

const { KNOWN_KINDS, readEnvelope } = require('../lib/envelope');
const { migrate } = require('../lib/version');
const { validateEnvelope } = require('../lib/validate');
const { validatePayload } = require('./lib/session-schema');
const { hashRecord } = require('../lib/hash');
const { detectShape, MigrateError } = require('./tpm-session-migrate');
const T = require('./lib/session-tracks');
const ids = require('./lib/session-ids');
const collate = require('./lib/session-collate');
const lockLib = require('../lib/lock');

// A track record inside a per-session folder: track a `session-NNNN.json`, track b..z `session-NNNN-b.json`.
const SESSION_JSON_RE = /^session-(\d+)(?:-([b-z]))?\.json$/;
const SESSION_FOLDER_RE = /^session-(\d+)$/;
const DEFAULT_STALE_MS = 3 * 24 * 3600 * 1000;                   // an unsealed track with no write for this long is "stale"
const TMP_LEFTOVER_MS = 60 * 1000;                               // a *.tmp younger than this may be a write in flight
// The `(generated from: <12hex>)` token on banner line 2 (wording per Q-D.2, Jason 2026-09-20;
// was ` · gen-from <12hex>`). The literal `(generated from: ` prefix + a 12-hex run cannot collide
// with the abbreviated id (which contains `…` and dashes). The closing `)` is a hard boundary, so
// no negative-lookahead is needed to hold the 12-char edge — unlike the old token whose trailing
// italic `_` (a word char) defeated a `\b`.
const GEN_FROM_RE = /\(generated from:\s+([0-9a-f]{12})\)/;
const CANON_NUMBER_RE = /^\d{4,}$/;                              // canonical stored form (zero-padded width-4+)

// ── per-session checks (canonical JSON) ──────────────────────────────────────

/**
 * checkSession(dir, name) -> result row
 *   { file, number, validate:{status,stage?,problem?}, drift:{status,bannerHash?,currentHash?},
 *     numberForm:{status,detail?} }
 * Read → migrate → validate with granular try/catch so the FAILING STAGE is labeled rather than
 * crashing the run. Drift + number-form run off the RAW on-disk bytes whenever the file was readable.
 */
function checkSession(dir, name) {
  const jsonPath = path.join(dir, name);
  const m = SESSION_JSON_RE.exec(name);
  const fileNumber = m ? m[1] : null;
  const fileTrack = m ? (m[2] || 'a') : null;
  const mdName = name.replace(/\.json$/, '.md');                    // THIS record's own derived file (track b -> session-NNNN-b.md)
  const result = {
    file: name,
    track: fileTrack,
    number: null,
    validate: { status: 'OK' },
    drift: { status: 'NONE' },
    numberForm: { status: 'OK' },
  };

  // read (fail-loud) → capture raw on-disk bytes
  let raw = null;
  try {
    raw = readEnvelope(jsonPath)._raw;
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'read', problem: e.message };
    return result; // nothing else is trustworthy without a parse
  }
  result.number = raw && raw.meta ? raw.meta.number : null;

  // migrate (refuse-unknown-newer fires here)
  let migrated = null;
  try {
    migrated = migrate(raw);
  } catch (e) {
    result.validate = { status: 'FAIL', stage: 'migrate', problem: e.message };
  }

  // validate (schema + kind + payload)
  if (migrated) {
    try {
      validateEnvelope(migrated, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
    } catch (e) {
      result.validate = { status: 'FAIL', stage: 'validate', problem: e.message };
    }
  }

  // drift + number-form: use raw (readable), independent of the validate verdict
  result.drift = checkDrift(dir, fileNumber, raw, mdName);
  result.numberForm = checkNumberForm(raw, fileNumber);
  return result;
}

/**
 * checkDrift(dir, fileNumber, raw) -> { status, bannerHash?, currentHash? }
 * READ-ONLY: recompute hashRecord(raw) and compare to the `.md` banner's `(generated from: …)`
 * token. Never re-renders, never rewrites.
 */
function checkDrift(dir, fileNumber, raw, mdName) {
  if (fileNumber == null || raw == null) return { status: 'NONE' };
  const mdPath = path.join(dir, mdName || `session-${fileNumber}.md`);
  if (!fs.existsSync(mdPath)) return { status: 'NONE' }; // no derived file → nothing to drift-check
  const md = fs.readFileSync(mdPath, 'utf8');
  const currentHash = hashRecord(raw);
  const bm = GEN_FROM_RE.exec(md);
  if (!bm) return { status: 'UNSTAMPED', currentHash }; // .md predates the hash
  const bannerHash = bm[1];
  if (bannerHash === currentHash) return { status: 'OK', bannerHash, currentHash };
  return { status: 'DRIFT', bannerHash, currentHash };
}

/**
 * checkNumberForm(raw, fileNumber) -> { status, detail? }  (rest-of-#1119 advisory)
 * P02 normalizes + `validatePayload` asserts non-empty (covered by the validate stage); this ADDS a
 * cheap advisory that meta.number is the canonical zero-padded form AND agrees with the filename.
 */
function checkNumberForm(raw, fileNumber) {
  const num = raw && raw.meta ? raw.meta.number : undefined;
  if (typeof num !== 'string' || !CANON_NUMBER_RE.test(num)) {
    return { status: 'WARN', detail: `meta.number ${JSON.stringify(num)} is not the canonical zero-padded form (/^\\d{4,}$/)` };
  }
  if (fileNumber != null && num !== fileNumber) {
    return { status: 'WARN', detail: `meta.number "${num}" disagrees with the filename number "${fileNumber}"` };
  }
  return { status: 'OK' };
}

// ── old-format detection (subdirectories) ────────────────────────────────────

function dirHasCanonicalJson(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((n) => SESSION_JSON_RE.test(n) || /^session-\d+(?:-[b-z])?\.sealed$/.test(n));
  } catch (_e) {
    return false;
  }
}

function dirHasLegacyMarkup(dirPath) {
  try {
    return fs.readdirSync(dirPath).some((n) => {
      const low = n.toLowerCase();
      return low.endsWith('.md') || low.endsWith('.txt');
    });
  } catch (_e) {
    return false;
  }
}

/**
 * checkOldFormat(dirPath, subName) -> oldFormat row | null
 *  - clean marked-3-file + NO session-<NNNN>.json  → migratable, with a ready-to-run suggestion.
 *  - clean marked-3-file + HAS the json            → null (already migrated; nothing to report).
 *  - detectShape refuses BUT the dir looks like a legacy session (markup, no canonical json) →
 *    not-auto-migratable advisory (names detectShape's reason). NEVER converts.
 *  - anything else (a new-format dir, an unrelated dir) → null (skip silently).
 */
function checkOldFormat(dirPath, subName) {
  let shape;
  try {
    shape = detectShape(dirPath);
  } catch (e) {
    if (!(e instanceof MigrateError)) throw e; // an unexpected error is a real bug, not a refusal
    if (dirHasCanonicalJson(dirPath)) return null; // has canonical data already
    if (!dirHasLegacyMarkup(dirPath)) return null; // not a session dir at all
    return { dir: subName, migratable: false, reason: e.message };
  }
  const jsonPath = path.join(dirPath, `session-${shape.number}.json`);
  if (fs.existsSync(jsonPath)) return null; // clean trio but already migrated
  return {
    dir: subName,
    number: shape.number,
    migratable: true,
    // The doctor is read-only: it names the migrator + a placeholder out-dir; the human runs it.
    suggestion: `tpm session migrate --in "${dirPath}" --out-dir "<choose-an-output-dir>"`,
  };
}

// ── track-aware checks (report-only) ──────────────────────────────────────────

const short8 = (id) => (id ? String(id).slice(0, 8) : 'unowned');
const issue = (code, message, severity) => ({ code, severity: severity || 'advisory', message });

function fmtAge(ms) {
  const h = ms / 3600000;
  return h >= 48 ? `${Math.floor(h / 24)}d` : `${Math.max(0, Math.floor(h))}h`;
}

/** The actionable way out for an unsealed track nobody is writing: the abandoned seal (needs --confirm; deletes nothing). */
function sealHint(number, track) {
  return `to retire it: tpm session close --session ${number} --track ${track} --confirm --reason "abandoned" (an abandoned seal: nothing is deleted or rewritten; its last save stays readable)`;
}

function stateWord(ts) {
  if (!ts) return 'unknown';
  if (ts.state === 'unreadable' && ts.sealedBy === null) return 'unreadable';
  if (ts.sealedBy === 'marker') return 'sealed-marker';
  if (ts.state === 'sealed') return 'sealed-self';
  return 'live';
}

/** The text after "OK ·" in a multi-track row. Sealed-ness comes from trackState only. */
function stateText(ts) {
  const w = stateWord(ts);
  const owner = ts.owner && ts.owner.claudeSessionId ? ` · owner ${short8(ts.owner.claudeSessionId)}` : '';
  if (w === 'sealed-self') return `SEALED by owner ${ts.sealedAt || ''}`.trim() + owner;
  if (w === 'sealed-marker') return `SEALED by marker (${collate.stateWordOf(ts).replace(/^sealed by marker \(|\)$/g, '')} ${ts.sealedAt || ''})`.replace(/ \)$/, ')') + owner;
  if (w === 'unreadable') return 'unreadable';
  return 'live' + owner;
}

/**
 * auditTrack(ts, ctx) -> [issue]   the per-track trouble checks. Reads trackState only (never closedAt, never the .md).
 */
function auditTrack(ts, ctx) {
  const out = [];
  const stem = `session-${ts.number}${ts.track === 'a' ? '' : `-${ts.track}`}`;
  for (const w of ts.warnings || []) {
    if (w === 'marker-without-record') out.push(issue('MARKER-WITHOUT-RECORD', `seal marker ${stem}.sealed has no matching record (${stem}.json is missing); the track reads as sealed but its content is gone`));
    else if (w === 'marker-unreadable') out.push(issue('MARKER-UNREADABLE', `seal marker ${stem}.sealed cannot be parsed; the track still reads as sealed (a marker that exists wins)`));
    else if (w === 'track-mismatch') out.push(issue('TRACK-MISMATCH', `${stem}.json is named for track ${ts.track} but its meta.track says ${JSON.stringify(ts.record && ts.record.meta && ts.record.meta.track)}`));
    else if (w === 'md-missing') out.push(issue('MD-MISSING', `${stem}.md (the derived file) is missing; the next save re-renders it`, 'info'));
  }
  if (ts.record && ts.track !== 'a' && ts.record.meta && ts.record.meta.track === undefined) {
    out.push(issue('TRACK-MISMATCH', `${stem}.json is named for track ${ts.track} but its meta.track is absent`));
  }
  if (ts.sealedBy === 'marker' && ts.record) {
    out.push(issue('MARKER-STALE-RECORD', 'the record and .md may still read "open" - expected, the marker is authoritative', 'info'));
  }
  if (ts.state === 'live' && !ts.superseded) {
    const hint = sealHint(ts.number, ts.track);
    const last = Date.parse(ts.lastWriteAt || '');
    if (Number.isFinite(last) && ctx.nowMs - last > ctx.staleMs) {
      out.push(issue('STALE', `unsealed track with no write for ${fmtAge(ctx.nowMs - last)} (last ${ts.lastWriteAt}; limit ${fmtAge(ctx.staleMs)}); ${hint}`));
    }
    const lv = T.livenessOf(ts.owner, { hostname: ctx.hostname }, { isAlive: ctx.isAlive, startedAt: ctx.startedAt });
    if (lv.status === 'gone') out.push(issue('OWNER-GONE', `unsealed track whose owner is gone (${lv.line}); ${hint}`));
  }
  return out;
}

function auditLocks(subPath, sub, nowMs) {
  const out = [];
  let ins;
  try {
    ins = lockLib.inspect(path.join(subPath, '.lock'), { now: () => nowMs });
  } catch (_e) {
    return out;
  }
  if (ins.state === 'stale') out.push(issue('LOCK-STALE', `${sub}/.lock is stale (${ins.stale && ins.stale.reason ? ins.stale.reason : 'old'}); the next writer breaks it, or remove it by hand once no tpm verb is running`));
  else if (ins.state === 'incomplete') out.push(issue('LOCK-INCOMPLETE', `${sub}/.lock has no readable owner record; it is never auto-broken - remove it by hand once no tpm verb is running`));
  else if (ins.state === 'held') out.push(issue('LOCK-HELD', `${sub}/.lock is held right now (a tpm verb is writing)`, 'info'));
  if (ins.state !== 'none' && !ins.gitignore) out.push(issue('LOCK-NO-GITIGNORE', `${sub}/.lock has no .gitignore (it could be committed)`, 'info'));
  if (ins.leftovers && ins.leftovers.length) out.push(issue('LOCK-LEFTOVER', `${sub}: leftover lock file(s) ${ins.leftovers.join(', ')} (a crashed or broken lock; safe to remove once no tpm verb is running)`));
  return out;
}

function auditTmpLeftovers(subPath, sub, nowMs) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(subPath); } catch (_e) { return out; }
  const old = [];
  for (const n of names) {
    if (!/\.tmp$/.test(n) || n.startsWith('.lock')) continue;
    try {
      if (nowMs - fs.statSync(path.join(subPath, n)).mtimeMs > TMP_LEFTOVER_MS) old.push(n);
    } catch (_e) { /* gone */ }
  }
  if (old.length) out.push(issue('LEFTOVER-TMP', `${sub}: leftover temp file(s) ${old.join(', ')} (an interrupted write; safe to remove)`));
  return out;
}

/** A name that LOOKS like a mis-named track record is worth a line; `session-notes.md` is a permanent false alarm. */
const trackLike = (u) => /\.json$|\.sealed/.test(u.file);

/**
 * inspectFolder(root, sub, number, ctx) -> { rows, notes, found }
 * One session folder: a row per track record (each paired with ITS OWN .md), folder-level notes.
 */
function inspectFolder(root, sub, number, ctx) {
  const subPath = path.join(root, sub);
  const lf = T.listFolder(root, number);
  const multi = ids.sessionIsMulti(lf);
  const rows = [];
  const notes = [];
  const claims = new Map();                                    // claimed track -> [file]
  for (const t of lf.tracks) {
    const ts = T.trackState(root, number, t.track);
    if (!ts) continue;
    if (ts.state === 'live' && ts.record && ts.record.meta && ts.record.meta.track === undefined
        && Number(number) < ctx.highest) ts.superseded = true;
    if (ctx.filter && !ctx.filter(ts)) continue;
    const jsonName = path.basename(ts.jsonPath);
    let row;
    if (t.files.json) {
      row = checkSession(subPath, jsonName);
      row.file = path.join(sub, jsonName);
    } else {
      const sealedName = path.basename(T.trackPaths(root, number, t.track).sealedPath);
      row = { file: path.join(sub, sealedName), track: t.track, number: null, validate: { status: 'NO-RECORD' }, drift: { status: 'NONE' }, numberForm: { status: 'OK' } };
    }
    row.track = t.track;
    row.multi = multi;
    row.state = stateWord(ts);
    row.stateText = stateText(ts);
    row.issues = auditTrack(ts, ctx);
    if (ts.record && ts.record.meta && typeof ts.record.meta.track === 'string') {
      const k = ts.record.meta.track;
      if (!claims.has(k)) claims.set(k, []);
      claims.get(k).push(jsonName);
    }
    rows.push(row);
  }
  for (const [track, files] of claims) {
    if (files.length > 1) {
      const msg = `${files.join(' and ')} both claim track ${track}; each track has exactly one record (keep the real one, move the other out of the folder)`;
      const mine = rows.filter((r) => files.includes(path.basename(r.file)));
      // One fault -> one finding: a claim collision is the CONSEQUENCE of a file whose name disagrees with its
      // meta.track. When any claimant already carries TRACK-MISMATCH, fold the collision into that finding
      // (no DUPLICATE-TRACK on either row); DUPLICATE-TRACK stays only for a collision with no mismatched claimant.
      const mismatched = mine.filter((r) => r.issues.some((i) => i.code === 'TRACK-MISMATCH'));
      if (mismatched.length) {
        for (const r of mismatched) {
          const others = files.filter((f) => f !== path.basename(r.file)).join(' and ');
          for (const i of r.issues) if (i.code === 'TRACK-MISMATCH') i.message += `; it collides with ${others}, which also claims track ${track} (keep the real record, move the other out of the folder)`;
        }
      } else {
        // defensive: unreachable for on-disk data (two files claim one track only when a name disagrees -> TRACK-MISMATCH)
        for (const r of mine) r.issues.push(issue('DUPLICATE-TRACK', msg));
      }
    }
  }
  if (!ctx.filter) {
    const trackA = lf.tracks.find((t) => t.track === 'a' && t.files.json);
    for (const u of lf.unrecognised) {
      if (u.why === 'derived file without a record') notes.push({ dir: sub, ...issue('MD-WITHOUT-RECORD', `${u.file}: a derived file with no record beside it`, 'info') });
      else if (trackLike(u)) {
        if (/^session-\d+-a\.json$/.test(u.file) && trackA) notes.push({ dir: sub, ...issue('DUPLICATE-TRACK', `${u.file} and ${path.basename(trackA ? T.trackPaths(root, number, 'a').jsonPath : '')} both claim track a (a is the unsuffixed file); move the extra one out of the folder`) });
        else notes.push({ dir: sub, ...issue('UNRECOGNISED', `${u.file}: ${u.why}; not treated as a track`) });
      }
    }
    for (const x of auditLocks(subPath, sub, ctx.nowMs)) notes.push({ dir: sub, ...x });
    for (const x of auditTmpLeftovers(subPath, sub, ctx.nowMs)) notes.push({ dir: sub, ...x });
  }
  return { rows, notes, found: lf.tracks.length > 0 };
}

// ── the doctor run ────────────────────────────────────────────────────────────

/**
 * runDoctor(opts) -> report
 *   opts.sessionsDir — REQUIRED. Directory to inspect (READ-ONLY).
 *   opts.strict      — promote advisories to a non-zero exit.
 *   opts.staleMs     — an unsealed track with no write for longer than this is reported (default 3 days).
 *   opts.track       — narrow to one track (letter or Claude id prefix of the owner).
 *   opts.now / opts.isAlive / opts.startedAt / opts.hostname — test seams.
 * Returns { sessionsDir, results, oldFormat, notes, summary, exitCode }. Writes nothing.
 */
function runDoctor(opts) {
  const options = opts || {};
  const sessionsDir = options.sessionsDir;
  if (!sessionsDir) throw new Error('runDoctor: opts.sessionsDir is required (no default)');
  const strict = !!options.strict;

  let entries;
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (e) {
    throw new Error(`runDoctor: cannot read --sessions-dir '${sessionsDir}': ${e.message}`);
  }

  // Discovery: NESTED per-session folders are THE canonical layout (json-format-spec §"On-disk naming
  // + location", Q-F) — `session-<NNNN>/` holds one record per TRACK (`session-<NNNN>.json` = track a,
  // `session-<NNNN>-b.json` … = tracks b..z), each with its own derived `.md`. Dot-names (`.lock`, hint)
  // are never sessions. A subdir WITHOUT any track record falls through to old-format detect + suggest.
  const results = [];
  const oldFormat = [];
  const notes = [];
  const subdirs = entries.filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name).sort();

  const nowMs = options.now instanceof Date ? options.now.getTime() : (Number.isFinite(options.now) ? options.now : Date.now());
  let hostname = options.hostname;
  if (hostname === undefined) { try { hostname = require('os').hostname(); } catch (_e) { hostname = null; } }
  const ctx = {
    nowMs,
    staleMs: Number.isFinite(options.staleMs) && options.staleMs > 0 ? options.staleMs : DEFAULT_STALE_MS,
    hostname,
    isAlive: options.isAlive,
    startedAt: options.startedAt,
    highest: -1,
    filter: null,
  };
  const canonical = (sub) => {
    const m = SESSION_FOLDER_RE.exec(sub);
    return m && sub === `session-${T.padNumber(m[1])}` ? m[1] : null;
  };
  for (const sub of subdirs) {
    const n = canonical(sub);
    if (n !== null && T.listFolder(sessionsDir, n).tracks.length) ctx.highest = Math.max(ctx.highest, Number(n));
  }
  if (options.track !== undefined && options.track !== null && options.track !== '') {
    const sel = String(options.track);
    if (!(T.isTrackLetter(sel) || sel.length >= 8)) {
      throw new T.TrackError('ETRACK_SELECTOR', `--track '${sel}' is not a track: give one letter a-z or at least 8 characters of a Claude session id. Nothing was read.`);
    }
    ctx.filter = (ts) => (T.isTrackLetter(sel)
      ? ts.track === sel
      : Boolean(ts.owner && ts.owner.claudeSessionId && String(ts.owner.claudeSessionId).toLowerCase().startsWith(sel.toLowerCase())));
  }

  for (const sub of subdirs) {
    const subPath = path.join(sessionsDir, sub);
    const n = canonical(sub);
    if (n !== null) {
      const r = inspectFolder(sessionsDir, sub, n, ctx);
      if (r.found) {
        results.push(...r.rows);
        notes.push(...r.notes);
        continue;                      // a folder holding track records is current-format, never an old-format candidate
      }
      if (!ctx.filter) notes.push(...r.notes);
    }
    if (ctx.filter) continue;
    let subEntries;
    try {
      subEntries = fs.readdirSync(subPath);
    } catch (_e) {
      subEntries = [];
    }
    const nestedJson = subEntries.filter((nm) => SESSION_JSON_RE.test(nm)).sort();
    if (nestedJson.length) {
      for (const name of nestedJson) {
        const row = checkSession(subPath, name);
        row.file = path.join(sub, name);
        row.issues = [];
        results.push(row);
      }
      continue;
    }
    const row = checkOldFormat(subPath, sub);
    if (row) oldFormat.push(row);
  }
  if (ctx.filter && !results.length) {
    throw new T.TrackError('ENO_TRACK', `no track matches --track '${options.track}' in any session folder.`);
  }

  // The hint is non-authoritative; say so when it disagrees with the tracks (informational).
  let hint = null;
  try {
    const cur = require('./tpm-session-current').resolveCurrentSession({ sessionsDir, identity: { claudeSessionId: null }, mode: 'all' });
    if (cur.hint && cur.hint.present) {
      hint = { ok: cur.hint.ok, agreesWithTracks: cur.hint.agreesWithTracks };
      if (!ctx.filter && (cur.hint.agreesWithTracks === false || !cur.hint.ok)) {
        notes.push({ dir: '.', ...issue('HINT-DISAGREES', cur.hint.ok ? '.current-session.json disagrees with the tracks (it is non-authoritative and is re-derived by the next session write)' : '.current-session.json is unreadable (it is non-authoritative and is re-derived by the next session write)', 'info') });
      }
    }
  } catch (_e) { /* informational */ }

  const all = [];
  for (const r of results) for (const i of (r.issues || [])) all.push(i);
  for (const nt of notes) all.push(nt);
  const adv = (code) => all.filter((i) => i.severity === 'advisory' && i.code === code).length;

  const valid = results.filter((r) => r.validate.status === 'OK').length;
  const invalid = results.filter((r) => r.validate.status === 'FAIL').length;
  const drift = results.filter((r) => r.drift.status === 'DRIFT').length;
  const unstamped = results.filter((r) => r.drift.status === 'UNSTAMPED').length;
  const numberWarn = results.filter((r) => r.numberForm.status === 'WARN').length;
  const migratable = oldFormat.filter((o) => o.migratable).length;
  const trackAdvisories = all.filter((i) => i.severity === 'advisory').length;

  const advisories = drift + unstamped + numberWarn + oldFormat.length + trackAdvisories;
  let exitCode = 0;
  if (invalid > 0) exitCode = 1;
  else if (strict && advisories > 0) exitCode = 2;

  return {
    sessionsDir,
    results,
    oldFormat,
    notes,
    hint,
    summary: {
      sessions: results.length,
      valid,
      invalid,
      drift,
      unstamped,
      numberWarn,
      oldFormat: oldFormat.length,
      migratable,
      trackAdvisories,
      stale: adv('STALE'),
      ownerGone: adv('OWNER-GONE'),
    },
    exitCode,
  };
}

// ── report rendering ──────────────────────────────────────────────────────────

function renderHuman(report) {
  const lines = [];
  for (const r of report.results) {
    let line = '  ' + r.file + '  ';
    if (r.validate.status === 'FAIL') {
      line += `FAIL [${r.validate.stage}]: ${r.validate.problem}`;
    } else if (r.validate.status === 'NO-RECORD') {
      line += 'NO RECORD';
    } else {
      const tags = ['OK'];
      if (r.multi && r.stateText) tags.push(r.stateText);
      if (r.drift.status === 'DRIFT') tags.push(`DRIFT (banner ${r.drift.bannerHash} · current ${r.drift.currentHash})`);
      else if (r.drift.status === 'UNSTAMPED') tags.push('UNSTAMPED (.md has no "generated from" token — re-save to stamp)');
      if (r.numberForm.status === 'WARN') tags.push(`WARN: ${r.numberForm.detail}`);
      line += tags.join(' · ');
    }
    for (const i of (r.issues || [])) {
      line += i.severity === 'info' ? ` · note: ${i.message}` : ` · ${i.code}: ${i.message}`;
    }
    lines.push(line);
  }

  const s = report.summary;
  lines.unshift(
    `session doctor · ${report.sessionsDir}\n` +
    `${s.sessions} ${report.results.some((r) => r.multi) ? 'track record(s)' : 'session(s)'} · ${s.valid} valid · ${s.invalid} invalid · ${s.drift} drift · ${s.oldFormat} old-format`,
  );

  if (report.notes && report.notes.length) {
    lines.push('');
    lines.push(`Folder notes (${report.notes.length}):`);
    for (const n of report.notes) lines.push(`  ${n.dir}  ${n.severity === 'info' ? 'note' : n.code}: ${n.message}`);
  }

  if (report.oldFormat.length) {
    lines.push('');
    lines.push(`Old-format sessions (${report.oldFormat.length}; ${s.migratable} auto-migratable):`);
    for (const o of report.oldFormat) {
      if (o.migratable) lines.push(`  ${o.dir}  → ${o.suggestion}`);
      else lines.push(`  ${o.dir}  not auto-migratable — ${o.reason}`);
    }
    if (s.migratable) {
      lines.push('');
      lines.push(`Detection + suggestion ONLY — the doctor never converts. Run the command(s) above by hand (${s.migratable} session(s)).`);
    }
  }
  return lines.join('\n');
}

// ── CLI ──────────────────────────────────────────────────────────────────────

/** '36h' | '3d' | '90m' | '48' (hours) -> ms. */
function parseDuration(v) {
  const m = /^(\d+(?:\.\d+)?)([mhd]?)$/.exec(String(v).trim());
  if (!m || !(Number(m[1]) > 0)) throw new Error(`--stale-after '${v}' is not a duration (use 90m, 36h or 3d)`);
  const unit = m[2] || 'h';
  return Math.round(Number(m[1]) * { m: 60000, h: 3600000, d: 86400000 }[unit]);
}

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--sessions-dir': opts.sessionsDir = next(); break;
      case '--json': opts.json = true; break;
      case '--strict': opts.strict = true; break;
      case '--track': opts.track = next(); break;
      case '--stale-after': opts.staleMs = parseDuration(next()); break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument '${a}'`);
    }
  }
  return opts;
}

const USAGE = `tpm-session-doctor — READ-ONLY session-store validator + drift detector (#1119)
  run: tpm session doctor [--sessions-dir <dir>] [--json] [--strict] [--track <letter|claude-id>] [--stale-after <3d|36h|90m>]

  --sessions-dir <dir>  OPTIONAL (F4)  the sessions store (READ-ONLY). Omitted → resolved from the LOCAL
                                  project's .claude/claude-tpm/config.json (session.notes.sessionsDir); the
                                  flag OVERRIDES; with NEITHER, FAILS LOUD (never defaults to a live store).
                                  Canonical session-<NNNN>.json is found nested per-session
                                  (session-<NNNN>/session-<NNNN>.json); old-format 3-file dirs detected too
  --json                emit the structured report as JSON
  --strict              promote advisories (drift / unstamped / old-format / number-form) to exit 2
  --track <t>           only that track (a letter, or >= 8 chars of its owner's Claude session id)
  --stale-after <d>     report an UNSEALED track with no write for longer than this (default 3d; 90m, 36h, 3d)
  --help                show this usage

Per-track checks (report-only): stale unsealed track; unsealed track whose owner process is gone (each with the
"close --track x --confirm" hint); seal marker without a record; two records claiming one track; file name vs meta.track;
leftover .lock* / *.tmp files.

Exit: 0 = healthy (advisories allowed) · 1 = a validation FAIL · 2 = --strict + an advisory.
STRICTLY READ-ONLY: no --fix, no write path. Old-format sessions are DETECTED + a migrate command
is SUGGESTED; the doctor never converts (that is tpm session migrate, run explicitly by a human).`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write('tpm-session-doctor: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  // F4: --sessions-dir is OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). Never a
  // silent live-store default; resolveSessionsDir throws loud when neither a flag nor a local config.
  try {
    opts.sessionsDir = require('./tpm-session-config').resolveSessionsDir(opts.sessionsDir, undefined).sessionsDir;
  } catch (e) {
    process.stderr.write('tpm-session-doctor: ' + String(e.message) + '\n');
    return 1;
  }
  try {
    const report = runDoctor(opts);
    if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(renderHuman(report) + '\n');
    return report.exitCode;
  } catch (e) {
    process.stderr.write('tpm-session-doctor: ' + String(e.message) + '\n');
    return e instanceof T.TrackError ? e.exitCode : 1;
  }
}

module.exports = {
  runDoctor,
  checkSession,
  checkDrift,
  checkNumberForm,
  checkOldFormat,
  auditTrack,
  renderHuman,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
