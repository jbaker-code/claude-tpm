'use strict';
/**
 * session-ids.js — the ONE place that knows the shape of a punchlist item id and of a session designator.
 * Pure functions, no I/O, zero deps.
 *
 *   STORED   ::= <N> [ <b-z> ] "." <K>    track a: "123.4"   track b..z: "123b.4"   (what is written to disk)
 *   INPUT    ::= [ "#" ] <digits> [ <a-z> ] "." <digits>   leading zeros allowed; no letter = track a;
 *                "123.4" and "123a.4" are the SAME item (Q8: store 123.4, accept both, display 123a.4 when the
 *                session has more than one track)
 *   DISPLAY  ::= STORED, except track a in a multi-track session prints "123a.4"
 *
 * Anything that does not match INPUT is not an id (it may be a slug or a legacy migrated id) and is never rewritten.
 *
 *   parseItemId(s)             -> { number, track, seq, stored } | null
 *   canonicalItemId(s)         -> the stored form, or `s` unchanged when it is not id-shaped
 *   trackOfItemId(s)           -> 'a'..'z' | null      THE function that says which track an id belongs to
 *   displayItemId(stored, multi)
 *   sessionIsMulti(listFolderResult)
 *   storedPrefix(number, track)  -> '123' | '123b'
 *   fromSessionLabel(meta)       -> provenance label for a carry-in event: '0001' (track a / absent) or '0001b'
 */

const ID_RE = /^#?(\d+)([a-z])?\.(\d+)$/;

function parseItemId(s) {
  if (typeof s !== 'string') return null;
  const m = ID_RE.exec(s);
  if (!m) return null;
  const number = Number(m[1]);
  const track = m[2] || 'a';
  const seq = Number(m[3]);
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(seq)) return null;
  return { number, track, seq, stored: `${storedPrefix(number, track)}.${seq}` };
}

function canonicalItemId(s) {
  const p = parseItemId(s);
  return p ? p.stored : s;
}

function trackOfItemId(s) {
  const p = parseItemId(s);
  return p ? p.track : null;
}

/** displayItemId(stored, multi): a track-a id of a multi-track session gains its letter; everything else is as stored. */
function displayItemId(stored, multi) {
  if (!multi) return stored;
  const p = parseItemId(stored);
  if (!p || p.track !== 'a' || /[a-z]\./.test(String(stored))) return stored;
  return `${p.number}a.${p.seq}`;
}

/** sessionIsMulti(listFolder result) — the only definition of "multi": several tracks, or a lone track that is not a. */
function sessionIsMulti(lf) {
  const tracks = lf && Array.isArray(lf.tracks) ? lf.tracks : [];
  return tracks.length > 1 || (tracks.length === 1 && tracks[0].track !== 'a');
}

function storedPrefix(number, track) {
  const letter = typeof track === 'string' && /^[b-z]$/.test(track) ? track : '';
  return `${String(Number(number))}${letter}`;
}

function fromSessionLabel(meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const base = m.number === undefined || m.number === null ? '' : String(m.number);
  if (base === '') return '';
  return typeof m.track === 'string' && /^[b-z]$/.test(m.track) ? `${base}${m.track}` : base;
}

module.exports = { parseItemId, canonicalItemId, trackOfItemId, displayItemId, sessionIsMulti, storedPrefix, fromSessionLabel };
