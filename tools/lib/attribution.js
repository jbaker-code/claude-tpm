'use strict';
/**
 * attribution.js — which tpm session is making this change? (never throws, never prints)
 *
 * The shared resolver behind task-history (and, later, workflow) session attribution. Attribution is
 * INFORMATIONAL: nothing here may block a write, and no code may branch on the answer.
 *
 * STORED FORM: `session-0012b` (track a: `session-0012`). Event keys `session` + `sessionVia`
 * (`flag` | `env` | `lookup`), written together or omitted together (blank = both omitted, never null).
 * WARNING: this DIVERGES from the session suite's `fromSession` label (bare `0012b`, track a `0012`,
 * tools/session/lib/session-ids.js). The two intentionally differ — do NOT unify them, and compare ONLY
 * through `sessionMatches` / `normalizeStored`, never raw strings.
 *
 * API
 *   parseSessionRef(value)          -> Ref | null      Ref = { number:'0012', track:'b'|'a'|null, stored, bare }
 *   storedForm(number, track)       -> string
 *   normalizeStored(value)          -> string | null
 *   parseExplicit({session,track})  -> { ok:true, ref:Ref|null } | { ok:false, error }   (the CLI validator)
 *   sessionMatches(stored, ref)     -> boolean         (list --session; normalises BOTH sides)
 *   lookupTrack(sessionsDir, claudeSessionId) -> { number, track, stored, state } | null
 *   resolveAttribution(opts?)       -> { session, sessionVia }    flag > TPM_SESSION_ID > lookup > blank
 *   toEventFields(attr)             -> {} | { session, sessionVia }
 *   VIA
 *
 * Imports ONLY ./identity and ./sessions-dir (nothing from tools/session|task|workflow). The track scan
 * re-implements a read-only subset of session-tracks.js (SCAN_WINDOW, FOLDER_RE, TRACK_FILE_RE, ownerOf);
 * tools/session/tests/attribution.test.js holds the parity test that guards against drift.
 * Zero third-party deps; Node built-ins only. Self-check: `node tools/lib/attribution.js`.
 */
const fs = require('fs');
const path = require('path');
const { readIdentity } = require('./identity');
const { resolveSessionsDirQuiet } = require('./sessions-dir');

const VIA = ['flag', 'env', 'lookup'];
const SCAN_WINDOW = 20;                                          // = session-tracks.js SCAN_WINDOW
const FOLDER_RE = /^session-(\d{3,4})$/;                         // = session-tracks.js FOLDER_RE
const TRACK_FILE_RE = /^session-(\d+)(?:-([b-z]))?\.(json|md|sealed)$/;   // = session-tracks.js TRACK_FILE_RE
const REF_RE = /^(?:session-)?(\d+)([a-z])?$/;

function pad(n) { return String(n).padStart(4, '0'); }

function storedForm(number, track) {
  return 'session-' + number + (track && track !== 'a' ? track : '');
}

function parseSessionRef(value) {
  try {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (v === '') return null;
    const m = REF_RE.exec(v);
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > 9999) return null;
    const number = pad(n);
    const track = m[2] || null;
    return { number, track, stored: storedForm(number, track), bare: number + (track && track !== 'a' ? track : '') };
  } catch (_e) {
    return null;
  }
}

function normalizeStored(value) {
  const r = parseSessionRef(value);
  return r ? r.stored : null;
}

function parseExplicit(flags) {
  try {
    const f = flags && typeof flags === 'object' ? flags : {};
    const hasS = f.session !== undefined;
    const hasT = f.track !== undefined;
    if (!hasS && !hasT) return { ok: true, ref: null };
    if (!hasS) return { ok: false, error: '--track needs --session' };
    const ref = parseSessionRef(f.session);
    if (!ref) {
      return { ok: false, error: `--session: '${f.session}' is not a session reference (use 0012, 0012b, 12b or session-0012b; number 1-9999, track a-z lowercase)` };
    }
    if (!hasT) return { ok: true, ref };
    if (typeof f.track !== 'string' || !/^[a-z]$/.test(f.track)) {
      return { ok: false, error: `--track: '${f.track}' is not a track letter (one lowercase letter a-z)` };
    }
    if (ref.track !== null && ref.track !== f.track) {
      return { ok: false, error: `--session '${f.session}' and --track '${f.track}' disagree` };
    }
    const track = f.track;
    return { ok: true, ref: { number: ref.number, track, stored: storedForm(ref.number, track), bare: ref.number + (track !== 'a' ? track : '') } };
  } catch (e) {
    return { ok: false, error: '--session: could not be read' };
  }
}

function sessionMatches(storedValue, filterRef) {
  try {
    const s = parseSessionRef(storedValue);
    if (!s || !filterRef || typeof filterRef !== 'object') return false;
    if (s.number !== filterRef.number) return false;
    if (filterRef.track === null || filterRef.track === undefined) return true;   // bare number: any track
    return (s.track || 'a') === filterRef.track;
  } catch (_e) {
    return false;
  }
}

// ── lookup ──────────────────────────────────────────────────────────────────────

/** The track-owner id (session-tracks.js ownerOf): an OWN `claudeSessionId` key wins even if null; else last of sessionIds. */
function ownerId(meta) {
  if (Object.prototype.hasOwnProperty.call(meta, 'claudeSessionId')) {
    return typeof meta.claudeSessionId === 'string' && meta.claudeSessionId ? meta.claudeSessionId : null;
  }
  if (Array.isArray(meta.sessionIds) && meta.sessionIds.length) {
    const last = meta.sessionIds[meta.sessionIds.length - 1];
    return typeof last === 'string' && last ? last : null;
  }
  return null;
}

function lookupTrack(sessionsDir, claudeSessionId) {
  try {
    if (typeof claudeSessionId !== 'string' || claudeSessionId === '') return null;
    if (typeof sessionsDir !== 'string' || sessionsDir === '') return null;
    let entries;
    try { entries = fs.readdirSync(sessionsDir, { withFileTypes: true }); } catch (_e) { return null; }
    const folders = entries
      .filter((d) => d.isDirectory() && FOLDER_RE.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(FOLDER_RE.exec(a)[1]) - Number(FOLDER_RE.exec(b)[1]))
      .slice(-SCAN_WINDOW);
    const cands = [];   // { n, number, track, state }
    for (const folder of folders) {
      const number = pad(Number(FOLDER_RE.exec(folder)[1]));
      let names;
      try { names = fs.readdirSync(path.join(sessionsDir, folder)); } catch (_e) { continue; }
      const byLetter = new Map();
      for (const name of names) {
        if (name.startsWith('.') || name.endsWith('.tmp')) continue;
        const m = TRACK_FILE_RE.exec(name);
        if (!m || pad(Number(m[1])) !== number) continue;
        const letter = m[2] || 'a';
        if (!byLetter.has(letter)) byLetter.set(letter, { json: false, sealed: false });
        if (m[3] === 'json') byLetter.get(letter).json = true;
        else if (m[3] === 'sealed') byLetter.get(letter).sealed = true;
      }
      for (const [letter, files] of byLetter) {
        if (files.sealed) continue;     // marker-sealed never matches
        if (!files.json) continue;
        try {
          const file = letter === 'a' ? `session-${number}.json` : `session-${number}-${letter}.json`;
          const rec = JSON.parse(fs.readFileSync(path.join(sessionsDir, folder, file), 'utf8'));
          if (!rec || typeof rec !== 'object' || Array.isArray(rec)) continue;
          const meta = rec.meta;
          if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
          if (ownerId(meta) !== claudeSessionId) continue;
          cands.push({ n: Number(number), number, track: letter, state: meta.closedAt ? 'self-sealed' : 'live' });
        } catch (_e) { /* skip this file only */ }
      }
    }
    for (const state of ['live', 'self-sealed']) {
      const pool = cands.filter((c) => c.state === state);
      if (!pool.length) continue;
      const top = Math.max(...pool.map((c) => c.n));
      const atTop = pool.filter((c) => c.n === top);
      if (atTop.length !== 1) return null;   // never guess
      const c = atTop[0];
      return { number: c.number, track: c.track, stored: storedForm(c.number, c.track), state: c.state };
    }
    return null;
  } catch (_e) {
    return null;
  }
}

// ── the entry point ───────────────────────────────────────────────────────────────

function blank() { return { session: null, sessionVia: null }; }

function resolveAttribution(opts) {
  try {
    const o = opts && typeof opts === 'object' ? opts : {};
    // 1. explicit flag (already validated by the CLI; a malformed one handed here falls through silently)
    if (o.explicit !== undefined && o.explicit !== null) {
      let ref = null;
      if (typeof o.explicit === 'string') ref = parseSessionRef(o.explicit);
      else if (typeof o.explicit === 'object') {
        if (typeof o.explicit.stored === 'string') ref = parseSessionRef(o.explicit.stored);
        else {
          const x = parseExplicit({ session: o.explicit.session, track: o.explicit.track });
          ref = x.ok ? x.ref : null;
        }
      }
      if (ref) return { session: ref.stored, sessionVia: 'flag' };
    }
    const env = o.env !== undefined && o.env !== null && typeof o.env === 'object' ? o.env : process.env;
    // 2. TPM_SESSION_ID (malformed -> silently unset)
    const envRef = parseSessionRef(env.TPM_SESSION_ID);
    if (envRef) return { session: envRef.stored, sessionVia: 'env' };
    // 3. Claude-id lookup (no id -> the sessions dir is never even resolved)
    const id = typeof o.claudeSessionId === 'string' && o.claudeSessionId
      ? o.claudeSessionId
      : (o.claudeSessionId === undefined ? readIdentity({ env, withStartTime: false }).claudeSessionId : null);
    if (!id) return blank();
    const dir = resolveSessionsDirQuiet({ sessionsDir: o.sessionsDir, env, startDir: o.startDir });
    if (!dir) return blank();
    const hit = lookupTrack(dir, id);
    if (hit) return { session: hit.stored, sessionVia: 'lookup' };
    return blank();
  } catch (_e) {
    return blank();
  }
}

function toEventFields(attr) {
  try {
    if (attr && typeof attr.session === 'string' && attr.session !== '' && VIA.includes(attr.sessionVia)) {
      return { session: attr.session, sessionVia: attr.sessionVia };
    }
  } catch (_e) { /* {} */ }
  return {};
}

module.exports = {
  parseSessionRef, storedForm, normalizeStored, parseExplicit, sessionMatches,
  lookupTrack, resolveAttribution, toEventFields, VIA, SCAN_WINDOW,
};

if (require.main === module) {
  const ok = parseSessionRef('12b') && parseSessionRef('12b').stored === 'session-0012b'
    && parseSessionRef('0012a').stored === 'session-0012' && parseSessionRef('0012B') === null
    && resolveAttribution({ env: {} }).session === null;
  if (!ok) { process.stderr.write('attribution.js self-check FAILED\n'); process.exit(1); }
  process.stdout.write('attribution.js OK\n');
}
