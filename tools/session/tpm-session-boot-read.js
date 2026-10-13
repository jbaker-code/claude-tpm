#!/usr/bin/env node
/**
 * tpm-session-boot-read.js — the boot-time pickup emitter, REWORKED for the JSON-first note format.
 *
 * PURPOSE
 *   A PURE-READ verb whose stdout IS the boot pickup payload: `session open` (the tpm-session skill's
 *   boot ritual) calls it so prior state is pulled into context by a tool call, not by the model
 *   choosing to open a file. It emits, for the highest-numbered PRIOR session (never the just-opened
 *   current one):
 *     • the prior session's HANDOFF (where / next / in flight / must-not-redo), rendered from the
 *       canonical JSON via the new session model — the READ-FIRST slice,
 *     • the still-OPEN punchlist items (HEADLINES ONLY: id · text · slug),
 *     • the file locations of the canonical `session-NNNN.json` + derived `session-NNNN.md`,
 *     • a pointer to the derived `.md` / `tpm session export` for the full log + punchlist detail.
 *
 * FORMAT (rework, #1123 Stage C) — the notes are now ONE canonical `session-NNNN.json` (+ ONE derived
 *   `session-NNNN.md` with `## Handoff` / `## Punchlist` / `## Log` sections), nested under
 *   `<sessionsDir>/session-NNNN/`. The OLD boot-read parsed the retired three-file `.md` layout
 *   (`-handoff.md` / `-punchlist.md` / `-log.md`); this version reads the canonical JSON through
 *   `lib/session-model.loadSession` (read → migrate → validate) instead — no dependence on the old
 *   markdown parser or its v1.0 sentinel. The load path's migrate step REFUSES an unknown-NEWER
 *   schemaVersion, so a session written by a newer tool is skipped (never mis-read), not crashed on.
 *
 * MULTI-TRACK PICKUP (phase 13, multi-session epic). A session folder can hold several parallel TRACKS (a..z),
 *   one per Claude instance. The pickup is DERIVED, nothing is stored (decision Q1/R5): a track is "picked up" iff
 *   a later session (K < J < N, N = the session the caller owns) opened STRICTLY after that track settled (its
 *   seal time; its last write for a legacy left-open track; a live track never settles); a tie counts as NOT
 *   picked up, so a handoff is never hidden. The pickup set renders newest session first, tracks a..z, one block
 *   per track (state, handoff verbatim, open items, file locations), then ONE combined ordered list of the open
 *   items across the shown tracks. Sealed-ness comes ONLY from `trackState()` (a seal marker wins over a record
 *   whose `.md` still says "open"). A lone track a of a single-track session renders EXACTLY as before this phase.
 *
 * CONTRACT — NEVER crashes boot: exit 0 in ALL cases (no prior session, an unreadable dir, a
 *   corrupt / unknown-newer / partial prior JSON). Side-effect-free (reads only). Any failure
 *   degrades to a clean one-line message + exit 0.
 *
 * SESSIONS DIR
 *   `--sessions-dir <dir>` if given (used by tests + explicit callers). Otherwise resolved from the
 *   session config (the same value `tpm session config --sessions-dir` prints), best-effort — a
 *   resolution failure degrades to a clean message + exit 0, it never crashes boot.
 *
 * CLI
 *   tpm session boot-read [--sessions-dir <dir>] [--track <letter|claude-id-prefix>]
 *   tpm session boot-read --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const T = require('./lib/session-tracks');
const ids = require('./lib/session-ids');
const { readIdentity } = require('../lib/identity');

const NUMBER_RE = /^session-(\d{3,4})$/;

// meta.number / folder numbers are canonical zero-padded width-4; re-pad defensively so a 3-digit
// legacy folder and a 4-digit one compare + render the same way (tolerant, like the converter).
function padNumber(number) {
  const n = Number(number);
  if (Number.isFinite(n)) return String(n).padStart(4, '0');
  return String(number == null ? '' : number).padStart(4, '0');
}

// ---- sessions-dir resolution (best-effort; never throws) --------------------
function resolveSessionsDir(explicit) {
  if (explicit) return explicit;
  try {
    // In-process resolution == `tpm session config --sessions-dir`.
    // eslint-disable-next-line global-require
    const cfg = require('./tpm-session-config');
    const { resolved, projectRoot } = cfg.resolveSessionConfig();
    return cfg.sessionsDirAbs(resolved, projectRoot);
  } catch (err) {
    return null;
  }
}

// ---- current-session number (to EXCLUDE it; best-effort) --------------------
/**
 * callerContext(sessionsDir, identity) -> { number, fallback }
 *   number    the session THIS Claude instance demonstrably OWNS (`resolveCurrentSession().mine`, the highest if
 *             it owns several), or null. ONLY an owned session is excluded from the pickup.
 *   fallback  { number } when the open gate would "resume" a track the caller does NOT own (its Claude session id is
 *             unreadable, or the single unsealed record has no recorded owner): nothing is excluded and the pickup
 *             says so (reader honesty: never "first session" over a record we merely guessed was ours).
 * A resolver failure is not swallowed silently: it is noted on stderr.
 */
function callerContext(sessionsDir, identity) {
  try {
    // eslint-disable-next-line global-require
    const { resolveCurrentSession } = require('./tpm-session-current');
    const cur = resolveCurrentSession({ sessionsDir, identity });
    const mine = (cur && Array.isArray(cur.mine) ? cur.mine : []).map((m) => Number(m.number)).filter(Number.isFinite);
    if (mine.length) return { number: Math.max(...mine), fallback: null };
    if (cur && cur.state === 'open' && cur.number) return { number: null, fallback: { number: padNumber(cur.number) } };
    return { number: null, fallback: null };
  } catch (err) {
    process.stderr.write(`boot-read: could not resolve the current session (${err.message}); not excluding any session\n`);
    return { number: null, fallback: null };
  }
}

/** currentSessionNumber(sessionsDir) -> number | null : the session the caller OWNS (see callerContext). */
function currentSessionNumber(sessionsDir) {
  return callerContext(sessionsDir, undefined).number;
}

// ---- prior-session selection ------------------------------------------------
/** All `session-NNN(N)` numbers under sessionsDir, DESCENDING (highest first). [] on any read error. */
function listSessionNumbers(sessionsDir) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    return [];
  }
  const numbers = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = NUMBER_RE.exec(e.name);
    if (m) numbers.push(m[1]);
  }
  // numeric descending so session-0010 outranks session-0009 (string sort would not).
  return numbers.sort((a, b) => Number(b) - Number(a));
}

function sessionPaths(sessionsDir, number, track) {
  const p = T.trackPaths(sessionsDir, padNumber(number), track);
  return { folder: p.folder, jsonPath: p.jsonPath, mdPath: p.mdPath };
}

/**
 * findPrior(sessionsDir, currentNumber) -> { prior, skipped, noRecord }
 * `prior` = the highest PRIOR session (excluding the current one) holding a track record that LOADS through
 * the model (read→migrate→validate), or null. The lowest readable track letter is rendered; the other
 * tracks of that session are reported in `prior.otherTracks` (not rendered by this reader version).
 * HONEST: every record it could not read is listed in `skipped` ({number, track, reason}) — never silently
 * dropped — and folders holding no record at all are counted in `noRecord`.
 */
function findPrior(sessionsDir, currentNumber) {
  const skipped = [];
  let noRecord = 0;
  for (const n of listSessionNumbers(sessionsDir)) {
    if (currentNumber && padNumber(n) === padNumber(currentNumber)) continue;
    const lf = T.listFolder(sessionsDir, n);
    if (!lf.tracks.length) { noRecord += 1; continue; }
    const states = lf.tracks.map((t) => T.trackState(sessionsDir, n, t.track)).filter(Boolean);
    for (const st of states) {
      if (st.state === 'unreadable') skipped.push({ number: padNumber(n), track: st.track, reason: st.reason });
      else if (st.sealedBy === 'marker' && !st.record) skipped.push({ number: padNumber(n), track: st.track, reason: 'sealed, record unreadable' });
    }
    const readable = states.find((st) => st.record);
    if (!readable) continue;
    const paths = sessionPaths(sessionsDir, n, readable.track);
    const others = states.filter((st) => st !== readable).map((st) => st.track);
    return {
      prior: {
        number: padNumber(n), folder: paths.folder, jsonPath: paths.jsonPath, mdPath: paths.mdPath,
        record: readable.record, track: readable.track, otherTracks: others,
      },
      skipped,
      noRecord,
    };
  }
  return { prior: null, skipped, noRecord };
}

function describeSkipped(skipped) {
  return skipped
    .map((s) => `${s.number}${s.track === 'a' ? '' : ` track ${s.track}`} (${s.reason})`)
    .join(', ');
}

// ---- emit -------------------------------------------------------------------
function nonEmptyString(s) {
  return typeof s === 'string' && s.trim() !== '';
}

function bulleted(items) {
  return items.map((x) => '- ' + x).join('\n');
}

/** Render the handoff slice from the canonical `handoff` object (null-safe). */
function renderHandoff(h) {
  if (h === null || h === undefined) {
    return '(no handoff recorded yet — the prior session opened but never saved a handoff.)';
  }
  const blocks = [];
  if (nonEmptyString(h.where)) blocks.push('**Where we are:**\n' + h.where);
  if (nonEmptyString(h.next)) blocks.push('**Next:**\n' + h.next);
  if (Array.isArray(h.in_flight) && h.in_flight.length) blocks.push('**In flight:**\n' + bulleted(h.in_flight));
  if (Array.isArray(h.must_not_redo) && h.must_not_redo.length) {
    blocks.push('**Must not redo:**\n' + bulleted(h.must_not_redo));
  }
  return blocks.length ? blocks.join('\n\n') : '(handoff present but empty.)';
}

function emitNoPrior(sessionsDir, skipped, noRecord) {
  process.stdout.write(noPriorText(sessionsDir, skipped, noRecord));
}

// ---- the pickup rule (DERIVED; nothing is stored) ----------------------------
const msOf = (iso) => {
  const v = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isFinite(v) ? v : null;
};

/**
 * settleOf(trackState) -> ms | Infinity : when the track stopped changing. A sealed track settles at its seal time
 * (marker `sealedAt`, else the record's own close, both via trackState); a legacy record that was never closed and
 * has a later session ("superseded") settles at its last write; a live track never settles. An unknown time is
 * Infinity (= never picked up: the safe side).
 */
function settleOf(t) {
  if (t.state === 'sealed') { const v = msOf(t.sealedAt); return v === null ? Infinity : v; }
  if (t.superseded) { const v = msOf(t.lastWriteAt); return v === null ? Infinity : v; }
  return Infinity;
}

/**
 * pickupSet(scan, callerNumber) -> { sessions, pending, alreadyPickedUp, skipped, unrecognised, hollow }
 * PURE (takes a scan from `T.scanSessions(dir, { mode: 'all' })`, or a fabricated one): needs no clock, no process.
 *   N = the session the caller OWNS (+Infinity when it owns none). For every session K < N and every READABLE track t:
 *   pickedUp(t) = settle(t) is finite AND some session J, K < J < N, opened STRICTLY after settle(t)
 *   (openedMin(J) = the earliest `openedAt` of J's readable tracks). A tie is NOT picked up.
 * Unreadable tracks never enter the set; they are listed in `skipped` ({number, track, reason}).
 * `pending` / `alreadyPickedUp` hold { number, track (trackState), by } in render order: newest session first, tracks a..z.
 */
function pickupSet(scan, callerNumber) {
  const N = callerNumber === null || callerNumber === undefined ? Infinity : Number(callerNumber);
  const sessions = ((scan && scan.sessions) || []).filter((s) => Number(s.number) < N);
  const openedMin = new Map();
  for (const s of sessions) {
    const times = s.tracks.filter((t) => t.record).map((t) => msOf(t.openedAt)).filter((v) => v !== null);
    if (times.length) openedMin.set(s.number, Math.min(...times));
  }
  const pending = [];
  const alreadyPickedUp = [];
  const skipped = [];
  const hollow = [];
  const unrecognised = [];
  for (const s of sessions.slice().sort((x, y) => Number(y.number) - Number(x.number))) {   // newest first, like the render
    for (const u of s.unrecognised || []) unrecognised.push({ number: s.number, file: u.file, why: u.why });
    if (!s.tracks.length) { hollow.push(s.number); continue; }
    for (const t of s.tracks) {
      if (!t.record) {
        skipped.push({ number: padNumber(s.number), track: t.track, reason: t.state === 'unreadable' ? t.reason : 'sealed, record unreadable' });
        continue;
      }
      const when = settleOf(t);
      let by = null;
      if (when !== Infinity) {
        for (const j of sessions) {
          if (Number(j.number) > Number(s.number) && openedMin.has(j.number) && openedMin.get(j.number) > when) { by = j.number; break; }
        }
      }
      (by ? alreadyPickedUp : pending).push({ number: s.number, track: t, by });
    }
  }
  return { sessions, pending, alreadyPickedUp, skipped, unrecognised, hollow };
}

/** computePickup(sessionsDir, callerNumber) -> pickupSet over the FULL scan (a straggler can be older than the 20-folder window). */
function computePickup(sessionsDir, callerNumber) {
  return pickupSet(T.scanSessions(sessionsDir, { mode: 'all' }), callerNumber);
}

// ---- track selector (--track) -------------------------------------------------
/** parseSelector(sel) -> { match(trackState) } | { error } : a letter a..z, or a Claude session id prefix of >= 8 chars. */
function parseSelector(sel) {
  if (typeof sel !== 'string' || sel === '') return { error: 'empty' };
  if (/^[a-z]$/.test(sel)) return { match: (t) => t.track === sel };
  if (sel.length >= 8 && /^[0-9A-Za-z-]+$/.test(sel)) {
    const want = sel.toLowerCase();
    return { match: (t) => Boolean(t.owner && t.owner.claudeSessionId && String(t.owner.claudeSessionId).toLowerCase().startsWith(want)) };
  }
  return { error: 'neither a track letter (a-z) nor a Claude session id prefix of at least 8 characters' };
}

// ---- rendering ----------------------------------------------------------------
const short8 = (id) => (id ? String(id).slice(0, 8) : 'unknown');
const LIVENESS_CAP = 12;   // at most this many liveness lookups (each may spawn one `ps`); the rest say "not checked"

/** Only a name that LOOKS like a mis-named track record is worth a line (a stray `session-notes.md` is a permanent false alarm). */
const trackLike = (u) => /\.json$|\.sealed/.test(u.file);

function unrecognisedNote(list) {
  const hit = list.filter(trackLike);
  if (!hit.length) return null;
  return `note: ${hit.length} unrecognised file(s) in session folders, NOT treated as tracks: ${hit.map((u) => `${u.number}/${u.file} (${u.why})`).join('; ')}`;
}

/** How a track is described in one phrase. Sealed-ness is `trackState`'s verdict, never the record's `.md` or `closedAt`. */
function stateWords(t, ctx) {
  if (t.sealedBy === 'marker') {
    const m = t.marker || {};
    const by = m.sealedBy && m.sealedBy.claudeSessionId ? `claude ${short8(m.sealedBy.claudeSessionId)}` : 'another session';
    const note = m.note ? `, "${m.note}"` : '';
    return `SEALED AS ABANDONED ${t.sealedAt || '(time unknown)'} by ${by} (${m.reason || 'reason unknown'}${note}); no final handoff was written`;
  }
  if (t.state === 'sealed') return `SEALED by its owner ${t.sealedAt}`;
  if (t.superseded) return `LEFT OPEN (never closed; superseded by a later session); last save ${t.lastWriteAt || 'unknown'}`;
  let live = 'liveness not checked';
  if (ctx.livenessChecked < LIVENESS_CAP) {
    ctx.livenessChecked += 1;
    try { live = T.evidenceFor(t, ctx.identity, ctx.livenessOpts).line; } catch (_e) { live = 'liveness unknown'; }
  }
  return `STILL LIVE (handoff may not be final); last save ${t.lastWriteAt || 'unknown'}; ${live}`;
}

function openItems(record) {
  const items = record && Array.isArray(record.punchlist) ? record.punchlist : [];
  return items.filter((it) => it && it.state === 'open');
}

/** A lone track a of a session holding only track a: EXACTLY the pre-multi-track bytes. */
function renderSingle(entry, sessionsDir, notes) {
  const t = entry.track;
  const paths = sessionPaths(sessionsDir, t.number, t.track);
  const out = notes.slice();
  out.push(`== PRIOR SESSION ${padNumber(t.number)} · ${paths.folder}/ ==`);
  out.push(`files: ${paths.jsonPath} · ${paths.mdPath}   (canonical JSON + derived .md; the log reads newest-first)`);
  out.push('--- HANDOFF (read fully) ---');
  out.push(renderHandoff(t.record ? t.record.handoff : null));
  const open = openItems(t.record);
  out.push(`--- OPEN PUNCHLIST (${open.length}) ---`);
  if (open.length) {
    out.push(open.map((it) => `#${it.id} · ${it.text}  [${it.slug}]`).join('\n'));
    out.push(
      `for full detail: read ${paths.mdPath} (## Punchlist / ## Log), or run: ` +
        `tpm session export --sessions-dir ${sessionsDir} --session ${padNumber(t.number)} --style human`,
    );
  } else {
    out.push('(no open punchlist items)');
  }
  return out;
}

/** One track's block (lines) + its open items for the combined list. Never throws: a block that cannot be built says where to read. */
function trackBlock(t, session, multi, sessionsDir, ctx) {
  const n = padNumber(session.number);
  const p = T.trackPaths(sessionsDir, n, t.track);
  if (!t.record) {
    const why = t.state === 'unreadable' ? (t.reason || 'unreadable') : 'sealed, record unreadable';
    return { lines: [`=== TRACK ${t.track} · UNREADABLE (${why}) ===`, `read this file directly: ${p.jsonPath}${t.files && t.files.sealed ? `   (a seal marker exists beside it: ${p.sealedPath})` : ''}`], items: [] };
  }
  try {
    const marker = t.sealedBy === 'marker';
    const lines = [`=== TRACK ${t.track} · ${stateWords(t, ctx)} ===`];
    lines.push(`files: ${p.jsonPath} · ${p.mdPath}${marker ? '   (the .md banner may still say "open": the seal marker is authoritative)' : ''}`);
    lines.push(marker || t.superseded ? '--- LAST-SAVED HANDOFF (not a final handoff; read fully) ---' : '--- HANDOFF (read fully) ---');
    lines.push(renderHandoff(t.record.handoff));
    const open = openItems(t.record);
    lines.push(`--- OPEN PUNCHLIST (${open.length}) ---`);
    lines.push(open.length ? open.map((it) => `#${ids.displayItemId(it.id, multi)} · ${it.text}  [${it.slug}]`).join('\n') : '(no open punchlist items)');
    lines.push(`for full detail: read ${p.mdPath}, or run: tpm session export --sessions-dir ${sessionsDir} --session ${n} --track ${t.track} --style human`);
    const live = t.state === 'live' && !t.superseded;
    return { lines, items: open.map((it) => `#${ids.displayItemId(it.id, multi)} [track ${t.track}${live ? ', live' : ''}] · ${it.text}  [${it.slug}]`) };
  } catch (err) {
    return { lines: [`=== TRACK ${t.track} · COULD NOT BE RENDERED (${err.message}) ===`, `read this file directly: ${p.jsonPath}`], items: [] };
  }
}

/** The per-track layout: sessions newest first, tracks a..z, then ONE combined open-items list. */
function renderMulti(pu, shown, sessionsDir, notes, ctx) {
  const out = notes.slice();
  const items = [];
  const bySession = new Map();
  for (const e of shown) { if (!bySession.has(e.number)) bySession.set(e.number, []); bySession.get(e.number).push(e); }
  const numbers = [...bySession.keys()].sort((x, y) => Number(y) - Number(x));
  for (const n of numbers) {
    const session = pu.sessions.find((s) => s.number === n);
    const multi = ids.sessionIsMulti({ tracks: session.tracks });
    const count = session.tracks.length;
    const picked = pu.alreadyPickedUp.filter((e) => e.number === n);
    const head = count === 1 ? (session.tracks[0].track === 'a' ? 'single track' : `1 track (track ${session.tracks[0].track})`) : `${count} parallel tracks`;
    const pickedNote = picked.length ? ` (${picked.map((e) => `${e.track.track}: already picked up by session ${e.by}`).join('; ')})` : '';
    out.push(`== PRIOR SESSION ${padNumber(n)} · ${path.join(sessionsDir, `session-${padNumber(n)}`)}/ · ${head}${pickedNote} ==`);
    const wanted = new Set(bySession.get(n).map((e) => e.track.track));
    for (const t of session.tracks) {
      // unreadable tracks of a shown session always get their own "read this file directly" block
      if (!wanted.has(t.track) && t.record) continue;
      const b = trackBlock(t, session, multi, sessionsDir, ctx);
      out.push(...b.lines);
      items.push(...b.items);
    }
  }
  out.push(`== OPEN PUNCHLIST, ALL TRACKS ABOVE (${items.length}) ==`);
  out.push(items.length ? items.join('\n') : '(no open punchlist items)');
  out.push('These tracks ran independently (parallel trains, not a sequence). Reconcile them before acting; a LIVE track may still change.');
  return out;
}

/**
 * buildPickup(sessionsDir, caller, opts) -> string  (the whole stdout payload). `caller` = { number, fallback };
 * opts = { track (selector), identity, livenessOpts }. Pure given the store: it reads, it never writes.
 */
function buildPickup(sessionsDir, caller, opts) {
  const o = opts || {};
  const pu = computePickup(sessionsDir, caller.number);
  const notes = [];
  let pending = pu.pending;
  if (o.track !== undefined && o.track !== null) {
    const sel = parseSelector(o.track);
    if (sel.error) notes.push(`note: --track ${JSON.stringify(String(o.track))} ignored (${sel.error}); showing every pending track`);
    else {
      pending = pending.filter((e) => sel.match(e.track));
      if (!pending.length) {
        return `boot-read: no pending track matches --track ${o.track} under ${sessionsDir}. Run without --track to see every pending track.\n`;
      }
    }
  }
  if (!pending.length) return noPriorText(sessionsDir, pu.skipped, pu.hollow.length);

  const minShown = Math.min(...pending.map((e) => Number(e.number)));
  const topShown = Math.max(...pending.map((e) => Number(e.number)));
  const shownSessions = new Set(pending.map((e) => e.number));
  // Reader honesty. The records we could not read, newer than (or inside) what is shown, and not already rendered as blocks.
  const skipped = pu.skipped.filter((s) => Number(s.number) >= minShown && !shownSessions.has(s.number));
  const hollowNewer = pu.hollow.filter((n) => Number(n) > topShown);
  const strays = pu.unrecognised.filter((u) => Number(u.number) >= minShown);
  const lead = [];
  if (hollowNewer.length) {
    lead.push(`note: ${hollowNewer.length} newer session folder(s) hold no readable record (${hollowNewer.join(', ')}); a claim in progress or a crashed open - not shown`);
  }
  if (caller.fallback) {
    const idKnown = o.identity && o.identity.claudeSessionId;
    lead.push(`note: ${idKnown ? `the open track of session ${caller.fallback.number} has no recorded owner` : 'your Claude session id is unreadable'}, so no session was excluded as yours; session ${caller.fallback.number} is shown below and may be your own live session`);
  }
  const tail = [];
  if (skipped.length) tail.push(`note: ${skipped.length} newer record(s) were skipped (unreadable): ${describeSkipped(skipped)}`);
  const un = unrecognisedNote(strays);
  if (un) tail.push(un);

  const ctx = { identity: o.identity || {}, livenessOpts: o.livenessOpts, livenessChecked: 0 };
  const only = pending.length === 1 ? pending[0] : null;
  if (only && only.track.track === 'a') {
    const session = pu.sessions.find((s) => s.number === only.number);
    if (session && session.tracks.length === 1) {
      // The lone-track-a layout is today's bytes. One exception, for honesty (decisions.md 2026-10-08): a lone
      // track a that ANOTHER instance sealed by marker still reads "open" in its record/.md, so say so above the pickup.
      const mk = only.track.sealedBy === 'marker'
        ? [`note: track a of session ${padNumber(only.number)} was ${stateWords(only.track, ctx)}; the handoff below is its last save`] : [];
      return `${renderSingle(only, sessionsDir, [...lead, ...mk, ...tail]).join('\n')}\n`;
    }
  }
  return `${renderMulti(pu, pending, sessionsDir, [...lead, ...notes, ...tail], ctx).join('\n')}\n`;
}

function noPriorText(sessionsDir, skipped, noRecord) {
  const where = sessionsDir || '(unresolved sessions dir)';
  const sk = skipped || [];
  if (sk.length) {
    return `boot-read: no prior session found under ${where} — but ${sk.length} record(s) could not be read and were skipped: ${describeSkipped(sk)}. ` +
      'This is NOT necessarily the first session.\n';
  }
  if (noRecord) {
    return `boot-read: no prior session found under ${where} — ${noRecord} session folder(s) held no readable record. ` +
      'This is NOT necessarily the first session.\n';
  }
  return `boot-read: no prior session found under ${where} — this looks like the first session. Nothing to pick up.\n`;
}

// ---- CLI plumbing -----------------------------------------------------------
function printHelp() {
  process.stdout.write(
    [
      'Usage: tpm session boot-read [--sessions-dir <dir>] [--track <letter|claude-id-prefix>]',
      '',
      'Pure-read boot pickup: emits what the PRIOR session(s) left, track by track — each pending track\'s state',
      '(sealed by its owner / sealed by another instance / still live), its handoff verbatim, its open punchlist',
      'headlines and its JSON/.md locations, then one combined list of the open items. A track is "picked up" (left out)',
      'only when a later session opened strictly after it settled; a live track is always shown, labelled. A single-track',
      'prior session prints exactly as it always did. Never emits a session this Claude instance owns. --track narrows',
      'the pickup to one track (a letter, or the first 8+ characters of its owner\'s Claude session id).',
      'A corrupt / unknown-newer / partial record is SKIPPED, not crashed on — and LISTED (never silently dropped;',
      '"first session" is only said when nothing was skipped). Exits 0 for any VALID invocation regardless of store contents (a corrupt/unreadable track degrades to a "read this file directly" line and never crashes boot); a malformed usage such as --track with no value exits 2.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--sessions-dir') args.sessionsDir = argv[++i];
    else if (a === '--track') {
      const v = argv[i + 1];
      if (v === undefined || String(v).startsWith('-') || v === '') { args.trackMissing = true; } else { args.track = v; i += 1; }
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    process.exit(0);
  }
  if (args.trackMissing) {
    process.stderr.write('boot-read: --track needs a value (a track letter a-z, or a Claude session id prefix of at least 8 characters). usage: tpm session boot-read [--sessions-dir <dir>] [--track <letter|claude-id-prefix>]\n');
    process.exit(2);
  }

  // Everything below is best-effort: any failure degrades to a clean message, exit 0.
  try {
    const sessionsDir = resolveSessionsDir(args.sessionsDir);
    if (!sessionsDir) {
      process.stdout.write(
        'boot-read: could not resolve the sessions directory (config unreadable) — pass --sessions-dir, or read the latest session folder directly.\n',
      );
      process.exit(0);
    }

    let identity = {};
    try { identity = readIdentity({ withStartTime: false }); } catch (_e) { identity = {}; }
    const caller = callerContext(sessionsDir, identity);
    process.stdout.write(buildPickup(sessionsDir, caller, { track: args.track, identity }));
    process.exit(0);
  } catch (err) {
    // Last-resort guard: never crash boot.
    process.stdout.write(
      `boot-read: could not build a pickup slice (${err.message}) — open the latest session folder directly.\n`,
    );
    process.exit(0);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveSessionsDir,
  currentSessionNumber,
  callerContext,
  pickupSet,
  computePickup,
  buildPickup,
  parseSelector,
  listSessionNumbers,
  sessionPaths,
  findPrior,
  renderHandoff,
  padNumber,
};
