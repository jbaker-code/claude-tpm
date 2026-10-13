#!/usr/bin/env node
/**
 * tpm-session-current.js — current-session resolver + open gate (tracks store).
 *
 * PURPOSE
 *   Answers "has `open` already run for THIS Claude instance, and which track is mine?" and owns
 *   allocating the next `session-NNNN` folder number (highest existing `session-NNN(N)` + 1, zero-padded
 *   to 4 digits). Backs the skill's bare-invocation state check and the open ritual.
 *
 * MECHANISM — the tracks themselves are the truth; the Claude session id finds MY track
 *   A session folder holds one record per TRACK (`session-NNNN.json` = track a, `session-NNNN-b.json` …;
 *   see lib/session-tracks.js). Each record carries its owner (`meta.claudeSessionId`, taken from
 *   `$CLAUDE_CODE_SESSION_ID`, which the harness hands every Bash call — read through tools/lib/identity.js,
 *   never from process.env here). "Which session am I in" = the UNSEALED track whose recorded owner id equals
 *   the caller's. "Is a track sealed" is answered in exactly one place, `trackState()`.
 *
 *   `<sessionsDir>/.current-session.json` is kept as a NON-AUTHORITATIVE HINT:
 *     { "sessionId": "<id|null>", "number": "0020", "openedAt": "<UTC ISO>", "closedAt": "<UTC ISO>|null" }
 *   It is derived from the tracks and kept TRUE (closedAt is null iff any track of that session is still
 *   unsealed) so older tpm versions that read it keep working. New code never decides "which session is
 *   current" from it. The one narrow exception is the upgrade aid (O-3): when there is NO unsealed track,
 *   the hint is open, and its sessionId equals the caller's but its folder holds no track file, the missing
 *   record is CREATED there (track a) instead of allocating a new number. It never refuses, resumes or
 *   picks between tracks.
 *
 *   `--open` NEVER silently joins a track owned by a different Claude session: when the only unsealed
 *   tracks are someone else's (or unreadable), it exits 3 naming them and writes nothing. (The choices
 *   offered at that point are --adopt <track> / --parallel / --next, plus --seal-and-new, which abandoned-seals
 *   every foreign track (needs --even-if-running, else exit 4) and opens the next session.) The refusal carries EVIDENCE per track (letter, opened, last
 *   write, a same-host liveness line, and "same Claude process, new session id" when it applies); the tool
 *   never chooses between adopt and parallel — the skill asks the person and re-runs with a flag. A caller
 *   whose own id is unreadable falls back to the one remaining continuity rule: exactly one unsealed track ->
 *   that one; MORE than one -> hard refusal, resolved only by `--open --track <letter>` (adopt/parallel need
 *   an id and are refused).
 *
 *   A legacy record (written before tracks: no `meta.track`) that is unsealed but older than the newest
 *   session is `superseded` and does not block an open (a never-`close`d old record must not wedge the
 *   first open after upgrade).
 *
 * EXPORTS (also a CLI, see --help)
 *   resolveCurrentSession({ sessionsDir, identity?, mode? }) -> { state:'open'|'not-opened'|'foreign-open', number, track, sessionId, mine, foreign, unowned, superseded, skipped, unrecognised, scanned, hint, pointerPath, pointer }
 *   openSession({ sessionsDir, identity?, tpmVersion?, now?, adopt?, parallel?, next?, sealAndNew?, evenIfRunning?, track?, number? })
                                                              -> { number, track, sessionId, isNew, isNewSession, resumed, recordPath, pointerPath, gate }
                                                                 gate: 'resume'|'new-session'|'adopt'|'parallel'|'next-session'
 *   sealSession({ sessionsDir, identity? })                     -> { number, closedAt, hintClosed, unsealed }
 *   allocateNextNumber({ sessionsDir })                         -> "0020"
 *   readEnvSessionId()                                          -> string|null (via identity.js)
 *
 * CLI
 *   tpm session current --sessions-dir <dir> --state [--all]  # print resolved state as JSON
 *   tpm session current --sessions-dir <dir> --open           # open or resume MY track; exit 3 = refused (foreign/ambiguous)
 *   tpm session current --sessions-dir <dir> --open --adopt <track> [--even-if-running] [--session NNNN]
 *   tpm session current --sessions-dir <dir> --open --parallel [--session NNNN]
 *   tpm session current --sessions-dir <dir> --open --next
 *   tpm session current --sessions-dir <dir> --open --track <letter>   # pick a track explicitly (the only way out when the session id is unreadable)
 *   tpm session current --sessions-dir <dir> --seal           # close the HINT when no track is still unsealed
 *   tpm session current --sessions-dir <dir> --next-number    # print the next allocation (no side effect)
 *   tpm session current --help
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { readIdentity } = require('../lib/identity');
const T = require('./lib/session-tracks');
const ids = require('./lib/session-ids');

const POINTER_FILENAME = T.HINT_FILENAME;
// Allocation LISTING regex: matches BOTH the surviving 3-digit legacy folders (session-001..019) and
// the new 4-digit ones (session-NNNN) so numbering CONTINUES past the old sessions (19 → 0020) rather
// than restarting at 0001 (R-4). Allocation COUNTS folders to avoid reusing a number; it does NOT
// apply the v1.0 reader gate — the version gate is a READER concern only.
const NUMBER_RE = /^session-(\d{3,4})$/;

function readEnvSessionId() {
  return readIdentity({ withStartTime: false }).claudeSessionId;
}

function pointerPathFor(sessionsDir) {
  return path.join(sessionsDir, POINTER_FILENAME);
}

/**
 * Highest existing session-NNN(N) + 1, zero-padded to 4 digits ("0001" if none exist yet). Counts
 * BOTH surviving 3-digit legacy folders and 4-digit ones (NUMBER_RE) so a workspace at session-019
 * continues at 0020 rather than restarting (R-4). No v1.0 gate here — allocation counts folders.
 */
function allocateNextNumber({ sessionsDir }) {
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') entries = [];
    else throw err;
  }
  let highest = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = NUMBER_RE.exec(e.name);
    if (m) highest = Math.max(highest, parseInt(m[1], 10));
  }
  return String(highest + 1).padStart(4, '0');
}

// ── the decision (ONE implementation; resolveCurrentSession runs it read-only, openSession acts on it) ──

function whoShort(owner) {
  return owner && owner.claudeSessionId ? String(owner.claudeSessionId).slice(0, 8) : 'unknown';
}

function describeTrackLine(st, evidence) {
  const label = st.state === 'unreadable' ? 'unreadable' : 'live';
  const owner = st.state === 'unreadable'
    ? `(unreadable record: ${st.reason})`
    : `owner ${whoShort(st.owner)}${st.owner && st.owner.claudePid ? ` (pid ${st.owner.claudePid}${st.owner.hostname ? ` on ${st.owner.hostname}` : ''})` : ' (no process id recorded)'}`;
  const times = st.state === 'unreadable'
    ? `last write (file time) ${st.lastWriteAt || 'unknown'}`
    : `opened ${st.openedAt || 'unknown'}   last write ${st.lastWriteAt || 'unknown'}`;
  const lines = [`  track ${st.track} of ${st.number}   ${owner}   ${times}   [${label}]`];
  if (evidence) {
    lines.push(`            ${evidence.line}`);
    if (evidence.sameProcessNewSession) {
      lines.push('            same Claude process as yours, but a different Claude session id (typical after /clear) - evidence for --adopt; not acted on automatically');
    }
  }
  return lines.join('\n');
}

// Evidence for each blocking track (same-host liveness + the /clear signature). Read-only.
function evidenceList(tracks, identity) {
  return tracks.map((st) => T.evidenceFor(st, identity));
}

function refusalLines(tracks, identity) {
  const ev = evidenceList(tracks, identity);
  return { ev, lines: tracks.map((st, i) => describeTrackLine(st, ev[i])) };
}

const CHOICES = (number) => [
  'Choose one and re-run `current --open` with the flag (the person decides; the tool never picks):',
  '  --adopt <track>   that track is MINE (same train, new Claude session id, e.g. after /clear).',
  '                    A track whose owner process is still running on this host also needs --even-if-running.',
  `  --parallel        I am a SECOND train: claim the next free track letter in session ${number}.`,
  '  --next            leave those tracks alone and open the NEXT session number.',
  '  --seal-and-new    those tracks are DEAD: seal every foreign unsealed track (abandoned seal; no handoff is written for',
  '                    them) and open the NEXT session number. Needs --even-if-running; without it, it prints the tracks it',
  '                    would seal and exits 4. Show the person the evidence and get an explicit yes first.',
];

/**
 * decide(scan, identity) -> { action:'resume', track, warnings } | { action:'none' }
 *   | { action:'refuse', code, tracks:[trackState], evidence:[{status,line,sameProcessNewSession}], message }
 */
function decide(scan, identity) {
  const callerId = identity && identity.claudeSessionId ? identity.claudeSessionId : null;
  const unsealed = T.unsealedTracks(scan);
  const c = T.classify(unsealed, callerId);
  if (c.mine.length) {
    const sorted = c.mine.slice().sort(T.byNumberTrackDesc);
    return { action: 'resume', track: sorted[0], warnings: c.mine.length > 1 ? ['multiple-owned-tracks'] : [] };
  }
  if (callerId === null) {
    if (!unsealed.length) return { action: 'none' };
    if (unsealed.length === 1 && unsealed[0].state === 'live') return { action: 'resume', track: unsealed[0], warnings: [] };
    const { ev, lines } = refusalLines(unsealed, identity);
    return {
      action: 'refuse',
      code: 'ESESSION_AMBIGUOUS',
      tracks: unsealed,
      evidence: ev,
      message: [
        `current-session: cannot open - your Claude session id is unreadable and ${unsealed.length} unsealed track(s) exist; cannot tell which is yours.`,
        ...lines,
        'Nothing was written. Pick one explicitly with `current --open --track <letter>` (--adopt, --parallel and --seal-and-new need a readable session id).',
      ].join('\n'),
    };
  }
  if (c.other.length || c.unreadable.length) {
    const tracks = [...c.other, ...c.unreadable, ...c.unowned];
    const { ev, lines } = refusalLines(tracks, identity);
    return {
      action: 'refuse',
      code: 'ESESSION_FOREIGN_TRACK',
      tracks,
      evidence: ev,
      message: [
        `current-session: cannot open - session ${tracks[0].number} has an unsealed track owned by another Claude session.`,
        ...lines,
        'Not joining or overwriting those tracks. Nothing was written.',
        ...CHOICES(tracks[0].number),
      ].join('\n'),
    };
  }
  if (c.unowned.length === 1) return { action: 'resume', track: c.unowned[0], warnings: [] };
  if (c.unowned.length > 1) {
    const { ev, lines } = refusalLines(c.unowned, identity);
    return {
      action: 'refuse',
      code: 'ESESSION_AMBIGUOUS',
      tracks: c.unowned,
      evidence: ev,
      message: [
        `current-session: cannot open - ${c.unowned.length} unsealed tracks have no recorded owner; cannot tell which is yours.`,
        ...lines,
        'Nothing was written.',
        ...CHOICES(c.unowned[0].number),
      ].join('\n'),
    };
  }
  return { action: 'none' };
}

function briefWithEvidence(st, identity, ev) {
  const b = T.brief(st);
  b.liveness = ev || T.evidenceFor(st, identity);
  return b;
}

function hintNumbers(hintInfo) {
  return hintInfo.ok && hintInfo.hint && hintInfo.hint.number ? [hintInfo.hint.number] : [];
}

/** One row of the `tracks` array (info): the state word comes from trackState only, never from closedAt or the .md. */
function trackRow(st, mine) {
  let state = 'live';
  if (st.state === 'unreadable') state = 'unreadable';
  else if (st.sealedBy === 'marker') state = 'sealed-marker';
  else if (st.state === 'sealed') state = 'sealed-self';
  const ownerId = st.owner && st.owner.claudeSessionId ? String(st.owner.claudeSessionId).slice(0, 8) : null;
  const row = { track: st.track, state, mine: Boolean(mine), owner: ownerId, openedAt: st.openedAt, lastWriteAt: st.lastWriteAt, sealedAt: st.sealedAt };
  if (st.state === 'unreadable') row.reason = st.reason;
  return row;
}

/**
 * tracksOf(sessionsDir, number, callerId, mineTrack) -> array | null
 * Every track of ONE session, ascending a..z. null for a session with a lone track a (single-track output stays
 * byte-identical: no `tracks` key). Reads only.
 */
function tracksOf(sessionsDir, number, callerId, mineTrack) {
  if (number === null || number === undefined) return null;
  const nnnn = T.padNumber(number);
  const lf = T.listFolder(sessionsDir, nnnn);
  if (!ids.sessionIsMulti(lf)) return null;
  const rows = [];
  for (const t of lf.tracks) {
    const st = T.trackState(sessionsDir, nnnn, t.track);
    if (!st) continue;
    const oid = st.owner ? st.owner.claudeSessionId : null;
    const mine = (mineTrack !== null && mineTrack !== undefined) ? st.track === mineTrack : Boolean(callerId && oid && oid === callerId);
    rows.push(trackRow(st, mine));
  }
  return rows;
}

function selfBrief(st) {
  return { number: st.number, track: st.track, openedAt: st.openedAt, lastWriteAt: st.lastWriteAt };
}

/**
 * Resolve whether THIS Claude instance has an open track. `state:'open'` iff the open gate would resume
 * (same decision function, read-only). Foreign/unowned/unreadable/superseded tracks are listed. Never throws
 * on a missing or corrupt hint; throws only when the sessions DIRECTORY is unreadable (non-ENOENT).
 */
function resolveCurrentSession({ sessionsDir, identity, mode }) {
  const id = identity || readIdentity({ withStartTime: false });
  const hintInfo = T.readHint(sessionsDir);
  const scan = T.scanSessions(sessionsDir, { mode: mode === 'all' ? 'all' : 'window', extraNumbers: hintNumbers(hintInfo) });
  const unsealed = T.unsealedTracks(scan);
  const c = T.classify(unsealed, id.claudeSessionId || null);
  const decision = decide(scan, id);
  const open = decision.action === 'resume';
  const hintOut = {
    path: hintInfo.path, present: hintInfo.present, ok: hintInfo.ok,
    number: hintInfo.ok ? hintInfo.hint.number : null,
    closedAt: hintInfo.ok ? hintInfo.hint.closedAt : null,
    agreesWithTracks: null,
  };
  try {
    const want = T.deriveHint(sessionsDir, { prior: hintInfo.ok ? hintInfo.hint : null, scan });
    hintOut.agreesWithTracks = hintInfo.ok && want ? (want.number === hintInfo.hint.number && (want.closedAt === null) === !hintInfo.hint.closedAt) : (want ? false : null);
  } catch (_e) { /* informational */ }
  const out = {
    state: open ? 'open' : (decision.action === 'refuse' ? 'foreign-open' : 'not-opened'),
    number: open ? decision.track.number : null,
    track: open ? decision.track.track : null,
    sessionId: id.claudeSessionId || null,
    mine: c.mine.map(selfBrief),
    foreign: [...c.other, ...c.unreadable].map((st) => briefWithEvidence(st, id)),
    unowned: c.unowned.map(T.brief),
    superseded: scan.superseded,
    skipped: scan.skipped,
    unrecognised: scan.unrecognised,
    scanned: scan.scanned,
    hint: hintOut,
    pointerPath: pointerPathFor(sessionsDir),
    pointer: hintInfo.ok ? hintInfo.hint : null,
  };
  if (open && decision.warnings.length) out.warnings = decision.warnings;
  if (decision.action === 'refuse') {
    // 'foreign-open': a session is open but none of its unsealed tracks is mine. `blocking` is every track the
    // gate would refuse over (foreign + unreadable + unowned), each with liveness evidence.
    out.refusal = { code: decision.code };
    out.blocking = decision.tracks.map((st, i) => briefWithEvidence(st, id, decision.evidence[i]));
  }
  if (open && hintInfo.ok) out.pointerSessionId = hintInfo.hint.sessionId;
  // info: every track of the caller's session (or the session blocking the open). Additive; absent for a lone track a.
  try {
    let infoNumber = null;
    let mineTrack = null;
    if (open) { infoNumber = out.number; mineTrack = out.track; }
    else if (decision.action === 'refuse' && decision.tracks.length) infoNumber = decision.tracks[0].number;
    const rows = tracksOf(sessionsDir, infoNumber, id.claudeSessionId || null, mineTrack);
    if (rows) {
      out.tracks = rows;
      if (!open && infoNumber !== null) out.tracksOfSession = T.padNumber(infoNumber);
    }
  } catch (_e) { /* informational */ }
  return out;
}

function refusalError(decision, scan, identity) {
  return new T.TrackError(decision.code, decision.message, {
    tracks: decision.tracks.map((st, i) => briefWithEvidence(st, identity, decision.evidence && decision.evidence[i])),
    skipped: scan.skipped,
  });
}

/**
 * Open (or resume) MY track. The gate, in order: mine -> resume; caller id unreadable -> the one unsealed
 * track, else refuse; nobody is mine and a foreign/unreadable track is unsealed -> REFUSE (exit 3, nothing
 * written); no unsealed track -> claim a new session folder (mkdir) and track a (link). A lost claim
 * re-runs the gate (it then resumes or refuses) — two opens never return the same number-and-track.
 *
 * The refusal's way forward is ONE explicit choice flag (the tool never picks between them; the person does):
 *   adopt:'b' [evenIfRunning] [number]  re-point that unsealed track to MY Claude session id (T.adoptTrack)
 *   parallel [number]                   claim the next free track letter in the session holding unsealed tracks
 *   next                                skip the foreign refusal and open the NEXT session number, track a
 *   sealAndNew [evenIfRunning]          abandoned-seal EVERY foreign unsealed track (T.sealByMarker, reason 'seal-and-new'),
 *                                       then open the next session number. evenIfRunning is the confirmation and is ALWAYS
 *                                       required (no own-pid exemption); without it: ESEAL_NEEDS_CONFIRM (exit 4), nothing written
 *   track:'b'                           resume that unsealed track explicitly (the way out when MY id is unreadable)
 */
function openSession(opts) {
  const { sessionsDir, identity, tpmVersion: ver, now, renderFn } = opts;
  const id = identity || readIdentity({ withStartTime: false });
  const choices = [opts.adopt ? '--adopt' : null, opts.parallel ? '--parallel' : null, opts.next ? '--next' : null,
    opts.sealAndNew ? '--seal-and-new' : null, opts.track ? '--track' : null].filter(Boolean);
  if (choices.length > 1) {
    throw new T.TrackError('ETRACK_ARG', `choose exactly one of --adopt, --parallel, --next, --seal-and-new, --track (got ${choices.join(' + ')}). Nothing was written.`);
  }
  if (opts.evenIfRunning && !opts.adopt && !opts.sealAndNew) {
    throw new T.TrackError('ETRACK_ARG', '--even-if-running only applies to --adopt or --seal-and-new. Nothing was written.');
  }
  if (opts.number && !(opts.adopt || opts.parallel)) {
    throw new T.TrackError('ETRACK_ARG', '--session only applies to --adopt or --parallel. Nothing was written.');
  }
  let claimId = null;   // full identity (with process start time) read once, only when a claim/adopt is made
  const fullIdentity = () => {
    if (!claimId) claimId = identity ? identity : readIdentity({ withStartTime: true });
    return claimId;
  };
  const finish = (st, gate, isNew, extra) => {
    const hint = T.writeHint(sessionsDir);
    return Object.assign({
      number: st.number,
      track: st.track,
      sessionId: id.claudeSessionId || null,
      isNew,
      isNewSession: gate === 'new-session' || gate === 'next-session' || gate === 'seal-and-new',
      resumed: !isNew,
      recordPath: st.jsonPath,
      pointerPath: pointerPathFor(sessionsDir),
      gate,
      hint: hint.hint,
    }, extra || {});
  };
  // Claim a brand-new session number + track a. Returns the trackState, or null when the claim was lost
  // (someone else is in that folder / took track a) and the caller should re-gate or retry.
  const claimNewSession = (number0) => {
    let number = number0;
    let folderStatus = null;
    if (number === null) {
      number = allocateNextNumber({ sessionsDir });
      folderStatus = T.claimSessionFolder(sessionsDir, number);
      if (folderStatus === 'exists' && T.waitForFirstRecord(sessionsDir, number)) return null;
    } else {
      folderStatus = T.claimSessionFolder(sessionsDir, number);
    }
    try {
      const claimed = T.claimTrack(sessionsDir, number, {
        identity: fullIdentity(), tpmVersion: ver, letters: ['a'], now, renderFn,
      });
      return T.trackState(sessionsDir, number, claimed.track);
    } catch (err) {
      if (err && err.code === 'ETRACK_EXISTS') return null;
      throw err;
    }
  };

  if (opts.sealAndNew) {
    if (!id.claudeSessionId) {
      throw new T.TrackError('ESEAL_NO_ID', 'cannot --seal-and-new: your Claude session id is unreadable (CLAUDE_CODE_SESSION_ID is not set), so the seal could not record who sealed. Nothing was written.');
    }
    const hintInfo0 = T.readHint(sessionsDir);
    const scan0 = T.scanSessions(sessionsDir, { extraNumbers: hintNumbers(hintInfo0) });
    const unsealed0 = T.unsealedTracks(scan0);
    const mine0 = unsealed0.filter((st) => st.owner && st.owner.claudeSessionId === id.claudeSessionId);
    if (mine0.length) {
      throw new T.TrackError('ESEAL_HAVE_OPEN',
        `cannot --seal-and-new: you already own an unsealed track (track ${mine0[0].track} of ${mine0[0].number}). Close it first, or use a plain --open. Nothing was written.`);
    }
    const plans = unsealed0.map((st) => T.sealPlan(st, fullIdentity(), opts.livenessOpts));
    if (plans.length && !opts.evenIfRunning) {
      throw new T.TrackError('ESEAL_NEEDS_CONFIRM',
        ['current-session: --seal-and-new would seal these tracks as ABANDONED (no handoff is written for them, the owners are not asked):',
          ...plans.map((p) => `  track ${p.track} of ${p.number}   owner ${p.owner.claudeSessionId ? String(p.owner.claudeSessionId).slice(0, 8) : 'unknown'}   last write ${p.lastWriteAt || 'unknown'}   ${p.livenessLine}`),
          'NOTHING was sealed. Show the person this evidence; only on an explicit yes re-run with --seal-and-new --even-if-running.'].join('\n'),
        { plans });
    }
    const sealed = [];
    for (const st of unsealed0) {
      const r = T.sealByMarker(sessionsDir, st.number, st.track, {
        by: fullIdentity(), reason: 'seal-and-new', confirm: true, now, livenessOpts: opts.livenessOpts,
      });
      sealed.push({ number: st.number, track: st.track, already: r.already });
    }
    for (let round = 0; round < T.GATE_MAX_ROUNDS; round += 1) {
      const st = claimNewSession(null);
      if (st) return finish(st, 'seal-and-new', true, { sealed });
    }
    throw new T.TrackError('ESESSION_RACE', 'could not claim the next session after sealing; run `tpm session current --state` and retry');
  }
  if (opts.adopt) {
    const r = T.adoptTrack({
      sessionsDir, track: opts.adopt, number: opts.number, identity: fullIdentity(), evenIfRunning: Boolean(opts.evenIfRunning),
      now, renderFn, lastWriterVersion: opts.lastWriterVersion, livenessOpts: opts.livenessOpts,
    });
    const st = T.trackState(sessionsDir, r.number, r.track);
    return finish(st, r.alreadyMine ? 'resume' : 'adopt', false, { adopted: r.adopted, adoptedFrom: r.from });
  }
  if (opts.parallel) {
    const r = T.claimParallelTrack({ sessionsDir, number: opts.number, identity: fullIdentity(), tpmVersion: ver, now, renderFn });
    return finish(T.trackState(sessionsDir, r.number, r.track), 'parallel', true);
  }

  for (let round = 0; round < T.GATE_MAX_ROUNDS; round += 1) {
    const hintInfo = T.readHint(sessionsDir);
    const scan = T.scanSessions(sessionsDir, { extraNumbers: hintNumbers(hintInfo) });

    if (opts.track) {
      const letter = opts.track;
      if (!T.isTrackLetter(letter)) throw new T.TrackError('ETRACK_ARG', `--track must be one letter a-z, got ${JSON.stringify(letter)}`);
      const cands = T.unsealedTracks(scan).filter((st) => st.track === letter).sort(T.byNumberTrackDesc);
      if (!cands.length) throw new T.TrackError('ENO_TRACK', `no unsealed track ${letter} exists; nothing was written.`);
      const st = cands[0];
      const ownerId = st.owner ? st.owner.claudeSessionId : null;
      if (st.state === 'unreadable') throw new T.TrackError('ENO_TRACK', `track ${letter} of ${st.number} cannot be read (${st.reason}); nothing was written.`);
      if (id.claudeSessionId && ownerId && ownerId !== id.claudeSessionId) {
        throw new T.TrackError('ENOT_OWNER', `track ${letter} of ${st.number} belongs to another Claude session (${whoShort(st.owner)}...); --track cannot take it. Use --adopt ${letter} if it is yours. Nothing was written.`);
      }
      return finish(st, 'resume', false, { explicitTrack: true });
    }

    const decision = decide(scan, id);
    if (opts.next) {
      if (decision.action === 'resume' && decision.track.owner && id.claudeSessionId && decision.track.owner.claudeSessionId === id.claudeSessionId) {
        throw new T.TrackError('ENEXT_HAVE_OPEN',
          `cannot open the next session: you already own an unsealed track (track ${decision.track.track} of ${decision.track.number}). Close it first, or use a plain --open. Nothing was written.`);
      }
      const st = claimNewSession(null);
      if (st) return finish(st, 'next-session', true);
      continue;
    }
    if (decision.action === 'resume') return finish(decision.track, 'resume', false);
    if (decision.action === 'refuse') throw refusalError(decision, scan, id);

    // No unsealed track. O-3 (narrow upgrade aid): an OPEN hint naming THIS caller whose folder has no
    // track file at all -> create the missing record there instead of allocating a second number.
    const h = hintInfo.ok ? hintInfo.hint : null;
    let st;
    if (h && !h.closedAt && h.number && id.claudeSessionId && h.sessionId === id.claudeSessionId
        && T.listFolder(sessionsDir, h.number).tracks.length === 0) {
      st = claimNewSession(T.padNumber(h.number));
    } else {
      st = claimNewSession(null);
    }
    if (st) return finish(st, 'new-session', true);
  }
  throw new T.TrackError('ESESSION_RACE',
    'could not settle the open gate after 5 rounds; run `tpm session current --state` and retry');
}

/**
 * Close the HINT — only when no track of any scanned session is still unsealed. It never stamps a track
 * record and never seals a track (that is `close`). Re-derives the hint from the tracks, so it stays true.
 * Throws ENOTHING_OPEN only when there is no hint AND no unsealed track.
 */
function sealSession({ sessionsDir }) {
  const hintInfo = T.readHint(sessionsDir);
  const scan = T.scanSessions(sessionsDir, { extraNumbers: hintNumbers(hintInfo) });
  const unsealed = T.unsealedTracks(scan);
  const hasSessions = scan.sessions.some((s) => s.tracks.length);
  if (!hintInfo.present && !unsealed.length) {
    const err = new Error('current-session: nothing is currently open to seal.');
    err.code = 'ENOTHING_OPEN';
    throw err;
  }
  if (!unsealed.length && !hasSessions) {
    // a hint with no tracks behind it (hand-made / legacy pointer-only): close it as the old tool did.
    if (hintInfo.ok && !hintInfo.hint.closedAt) {
      const pointer = Object.assign({}, hintInfo.hint, { closedAt: new Date().toISOString() });
      fs.mkdirSync(sessionsDir, { recursive: true });
      require('../lib/io').atomicWriteFileSync(pointerPathFor(sessionsDir), `${JSON.stringify(pointer, null, 2)}\n`);
      return { number: pointer.number, closedAt: pointer.closedAt, hintClosed: true, unsealed: [] };
    }
    const err = new Error('current-session: nothing is currently open to seal.');
    err.code = 'ENOTHING_OPEN';
    throw err;
  }
  const { hint } = T.writeHint(sessionsDir);
  const list = unsealed.map((s) => ({ number: s.number, track: s.track }));
  if (list.length) {
    process.stderr.write(`current-session: hint left open - track ${list[0].track} of ${list[0].number} is still unsealed\n`);
  }
  return {
    number: hint ? hint.number : null,
    closedAt: hint ? hint.closedAt : null,
    hintClosed: Boolean(hint && hint.closedAt),
    unsealed: list,
  };
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: tpm session current [--sessions-dir <dir>] (--state [--all] | --open [<choice>] | --seal | --next-number) [--help]',
      '',
      'Resolves THIS Claude instance\'s track by its Claude session id; <dir>/.current-session.json is a',
      'non-authoritative hint kept true. Exit codes: 0 ok · 1 error · 3 open refused (foreign/ambiguous track) · 4 --seal-and-new needs confirmation.',
      '',
      'Flags:',
      '  --sessions-dir <dir>  OPTIONAL (F4). Omitted → resolved from the LOCAL project config.json',
      '                        (session.notes.sessionsDir); the flag OVERRIDES; with NEITHER, FAILS LOUD',
      '                        (never defaults to a live store). See tpm session config --sessions-dir.',
      '  --state               Print the resolved { state, number, track, sessionId, ... } as JSON. No side effect.',
      '                        --all scans every session folder, not just the newest 20.',
      '  --open                Open or resume MY track (idempotent), creating the folder + record; print JSON.',
      '                        Refuses (exit 3, JSON on stdout) when the only unsealed track is another session\'s.',
      '    <choice> (after an exit-3 refusal; exactly one — the person decides, the tool never picks):',
      '      --adopt <track> [--even-if-running] [--session NNNN]',
      '                        That unsealed track is MINE: re-point it to my Claude session id + process. Refused',
      '                        for a sealed/missing/unreadable track, or one whose owner process is demonstrably',
      '                        still running on this host (unless it is my own process, or --even-if-running).',
      '      --parallel [--session NNNN]',
      '                        I am a second train: claim the next free track letter (cap 26) in the session that',
      '                        holds the unsealed tracks. The new track starts with an EMPTY punchlist.',
      '      --next            Leave the other tracks alone and open the NEXT session number (track a).',
      '      --seal-and-new [--even-if-running]',
      '                        Those tracks are dead: abandoned-seal EVERY foreign unsealed track (no handoff is written',
      '                        for them; who/when is recorded in a .sealed marker) and open the NEXT session number.',
      '                        --even-if-running is the confirmation and is ALWAYS required; without it the tracks that',
      '                        would be sealed are printed and the exit code is 4. Un-seal: tpm session unseal.',
      '      --track <letter>  Resume that unsealed track explicitly (needed when my session id is unreadable',
      '                        and more than one track is unsealed).',
      '  --seal                Close the HINT when no track is still unsealed; prints { number, closedAt, hintClosed }.',
      '  --next-number         Print the next allocation ("0020") without writing anything.',
      '  --help                Show this message.',
      '',
      'Examples:',
      '  tpm session current --sessions-dir .claude/claude-tpm/sessions --state',
      '  tpm session current --sessions-dir .claude/claude-tpm/sessions --open',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') args.help = true;
    else if (a === '--state') args.state = true;
    else if (a === '--all') args.all = true;
    else if (a === '--open') args.open = true;
    else if (a === '--seal') args.seal = true;
    else if (a === '--next-number') args.nextNumber = true;
    else if (a === '--parallel') args.parallel = true;
    else if (a === '--next') args.next = true;
    else if (a === '--seal-and-new') args.sealAndNew = true;
    else if (a === '--even-if-running' || a === '--confirm') args.evenIfRunning = true;
    else if (a === '--adopt' || a === '--track' || a === '--session') {
      args[a.slice(2)] = argv[i + 1];
      i += 1;
    }
    else if (a === '--sessions-dir') {
      args.sessionsDir = argv[i + 1];
      i += 1;
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

  // F4: --sessions-dir is OPTIONAL — resolve (flag > local project config.json > FAIL LOUD). It
  // NEVER silently defaults to a live store; the resolver throws loud when neither is present.
  try {
    args.sessionsDir = require('./tpm-session-config').resolveSessionsDir(args.sessionsDir, undefined).sessionsDir;
  } catch (err) {
    process.stderr.write(`tpm session current: ${err.message}\n`);
    process.exit(1);
  }

  if (!args.state && !args.open && !args.seal && !args.nextNumber) {
    process.stderr.write('tpm session current: nothing to do — pass one of --state / --open / --seal / --next-number.\n\n');
    printHelp();
    process.exit(1);
  }

  try {
    if (args.state) {
      const st = resolveCurrentSession({ sessionsDir: args.sessionsDir, mode: args.all ? 'all' : 'window' });
      if (args.track !== undefined) {
        // --track narrows `tracks` to one track (letter or Claude-id prefix); a malformed or unknown value is an error.
        const num = st.number || st.tracksOfSession || null;
        if (num === null) throw new T.TrackError('ENO_TRACK', `--track '${args.track}': there is no session to narrow (state is ${st.state}).`);
        const letter = T.resolveTrackSelector(args.sessionsDir, num, args.track);
        if (Array.isArray(st.tracks)) st.tracks = st.tracks.filter((r) => r.track === letter);
      }
      process.stdout.write(`${JSON.stringify(st, null, 2)}\n`);
    } else if (args.open) {
      process.stdout.write(`${JSON.stringify(openSession({
        sessionsDir: args.sessionsDir,
        adopt: args.adopt, parallel: args.parallel, next: args.next, sealAndNew: args.sealAndNew,
        evenIfRunning: args.evenIfRunning, track: args.track, number: args.session,
      }), null, 2)}\n`);
    } else if (args.seal) {
      process.stdout.write(`${JSON.stringify(sealSession({ sessionsDir: args.sessionsDir }), null, 2)}\n`);
    } else if (args.nextNumber) {
      process.stdout.write(`${allocateNextNumber({ sessionsDir: args.sessionsDir })}\n`);
    }
    process.exit(0);
  } catch (err) {
    if (err instanceof T.TrackError && err.exitCode === 3) {
      process.stderr.write(`${err.message}\n`);
      process.stdout.write(`${JSON.stringify({ refused: true, code: err.code, tracks: (err.details && err.details.tracks) || [], skipped: (err.details && err.details.skipped) || [] }, null, 2)}\n`);
      process.exit(3);
    }
    process.stderr.write(`current-session: ${String(err.message).replace(/^current-session:\s*/, '')}\n`);
    if (err instanceof T.TrackError) {
      // gate-flag refusals (adopt/parallel/next/seal-and-new/track): machine-readable too, so the skill can branch on .code
      process.stdout.write(`${JSON.stringify({ refused: true, code: err.code, message: err.message, details: err.details || null }, null, 2)}\n`);
    }
    process.exit(err instanceof T.TrackError ? err.exitCode : 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  resolveCurrentSession,
  openSession,
  sealSession,
  allocateNextNumber,
  readEnvSessionId,
  pointerPathFor,
  decide,
};
