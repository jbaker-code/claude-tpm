'use strict';
/**
 * session-collate.js — the merged, track-attributed read of ONE session (shared by export/review now; boot-read
 * and doctor/info in the next phases).
 *
 *   collateSession(sessionsDir, number, { track? }) -> { number, multi, narrowed, tracks:[...] }
 *       tracks ascending a..z; each is a T.trackState object plus `readable`. The ONLY source of state is
 *       T.trackState: a track sealed by someone else's marker still has a JSON record whose meta.closedAt is null
 *       and a .md that says "open", so nothing here ever reads closedAt or the .md to decide sealed-ness.
 *   stateWordOf(ts)  -> the banner word: 'open' | 'closed' | 'sealed by marker (<reason>)'
 *   stateCellOf(ts)  -> the table cell: 'live' | 'sealed (closed)' | 'sealed (<reason>)' | 'unreadable (<reason>)'
 *   renderSessionHuman(collation, { now, render }) -> string
 *       single layout (a lone track a): exactly render(record, { now }) - today's bytes;
 *       merged layout: a title + table, each track's full section (display ids, state overlay, track label), then
 *       the combined open punchlist; narrowed: just that track's section.
 *   markerNote(ts) -> stderr line for a marker-sealed track
 *
 * Reads only. Never writes, never rewrites a record before render (the banner hash would stop matching the file).
 */
const T = require('./session-tracks');
const ids = require('./session-ids');
const { render: defaultRender } = require('./session-converter');

function markerReason(ts) {
  if (!ts.marker) return 'unreadable marker';
  return ts.marker.reason || 'unknown';
}

function stateWordOf(ts) {
  if (ts.sealedBy === 'marker') return `sealed by marker (${markerReason(ts)})`;
  return ts.state === 'sealed' ? 'closed' : 'open';
}

function readableOf(ts) { return Boolean(ts.record); }

function unreadableReason(ts) {
  return ts.reason || (ts.warnings && ts.warnings[0]) || 'no readable record';
}

function stateCellOf(ts) {
  if (!readableOf(ts)) return `unreadable (${unreadableReason(ts)})`;
  if (ts.sealedBy === 'marker') return `sealed (${markerReason(ts)})`;
  if (ts.state === 'sealed') return 'sealed (closed)';
  return 'live';
}

function collateSession(sessionsDir, number, opts) {
  const o = opts || {};
  const nnnn = T.padNumber(number);
  const lf = T.listFolder(sessionsDir, nnnn);
  const multi = ids.sessionIsMulti(lf);
  let letters = lf.tracks.map((t) => t.track);
  let narrowed = null;
  if (o.track !== undefined && o.track !== null && o.track !== '') {
    narrowed = T.resolveTrackSelector(sessionsDir, nnnn, o.track);
    letters = [narrowed];
  }
  const tracks = [];
  for (const l of letters) {
    const ts = T.trackState(sessionsDir, nnnn, l);
    if (!ts) continue;
    tracks.push(Object.assign(ts, { readable: readableOf(ts) }));
  }
  return { number: nnnn, multi, narrowed, tracks };
}

const short8 = (id) => (id ? String(id).slice(0, 8) : 'unowned');

function unreadableBlock(ts, number) {
  const stem = `session-${number}${ts.track === 'a' ? '' : `-${ts.track}`}`;
  return [
    `# Session ${number} · track ${ts.track} — UNREADABLE`,
    '',
    `> The record ${stem}.json cannot be read (${unreadableReason(ts)}: ${ts.message || 'no readable record'}). Read the file directly: ${ts.jsonPath}`,
  ].join('\n') + '\n';
}

function sectionOf(ts, number, now, renderFn, multi) {
  if (!ts.readable) return unreadableBlock(ts, number);
  return renderFn(ts.record, {
    now,
    displayId: (id) => ids.displayItemId(id, multi),
    stateWord: stateWordOf(ts),
    trackLabel: true,
  });
}

function renderSessionHuman(col, opts) {
  const o = opts || {};
  const now = o.now;
  const renderFn = typeof o.render === 'function' ? o.render : defaultRender;
  if (!col.multi) {
    const ts = col.tracks[0];
    if (!ts.readable) throw new Error(ts.message || `cannot read track ${ts.track} of session ${col.number}`);
    return renderFn(ts.record, { now });                       // today's bytes, no options
  }
  if (col.narrowed) {
    return col.tracks.map((ts) => sectionOf(ts, col.number, now, renderFn, true)).join('\n\n');
  }
  const k = col.tracks.length;
  const only = col.tracks.length === 1 && col.tracks[0].track !== 'a';
  const head = only ? `1 track (track ${col.tracks[0].track})` : `${k} parallel tracks`;
  const rows = col.tracks.map((ts) => `| ${ts.track} | ${stateCellOf(ts)} | ${short8(ts.owner && ts.owner.claudeSessionId)} | ${ts.openedAt || '-'} | ${ts.lastWriteAt || '-'} |`);
  const parts = [`# Session ${col.number} · ${head}\n\n| track | state | owner | opened | last write |\n|---|---|---|---|---|\n${rows.join('\n')}\n`];
  for (const ts of col.tracks) parts.push(sectionOf(ts, col.number, now, renderFn, true));
  const lines = [];
  for (const ts of col.tracks) {
    if (!ts.readable) continue;
    for (const it of (ts.record.punchlist || [])) {
      if (it && it.state === 'open') lines.push(`\`#${ids.displayItemId(it.id, true)}\` [track ${ts.track}] ${it.text}`);
    }
  }
  parts.push(`## Open punchlist, all tracks (${lines.length})\n\n${lines.length ? lines.map((l, i) => `${i + 1}. ${l}`).join('\n') : '_No open items on any track._'}\n`);
  return parts.join('\n\n');
}

/** The stderr line for a marker-sealed track in a JSON read (its record still says meta.closedAt = null). */
function jsonMarkerNote(ts) {
  const { closedAt } = ts;   // trackState's copy of what the record says - quoted for the reader, never used to decide anything
  return `note: track ${ts.track} of ${ts.number} is sealed by a marker (${markerReason(ts)}); its JSON record still says meta.closedAt = ${JSON.stringify(closedAt)} - the marker is authoritative`;
}

/** The stderr line for a lone track a sealed by a marker in a human read (stdout stays byte-identical). */
function humanMarkerNote(ts) {
  const m = ts.marker || {};
  const by = m.sealedBy && m.sealedBy.claudeSessionId ? `claude ${String(m.sealedBy.claudeSessionId).slice(0, 8)}` : 'another session';
  const note = m.note ? `, "${m.note}"` : '';
  return `note: track ${ts.track} of session ${ts.number} was SEALED AS ABANDONED ${ts.sealedAt || '(time unknown)'} by ${by} (${m.reason || 'reason unknown'}${note}); its JSON record and .md still read "open" - the marker is authoritative`;
}

module.exports = { collateSession, stateWordOf, stateCellOf, renderSessionHuman, jsonMarkerNote, humanMarkerNote, unreadableReason };
