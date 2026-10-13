'use strict';
/**
 * fixed-multi.js — hand-built multi-track stores with FIXED timestamps for the phase-13 pickup tests (no clock, no
 * same-second ties unless a scenario asks for one). Records are schema-valid canonical envelopes, loaded back through
 * `trackState` before use (a record the real reader could not load would make a test prove nothing).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('../../lib/session-tracks');

const day = '2026-10-05';
const at = (hhmm, sec) => `${day}T${hhmm}:${sec || '00'}-07:00`;
const id = (c) => `${c.repeat(8)}-0000-4000-8000-${c.repeat(12)}`;
const DEAD_PID = 2147483000;   // far above any pid: process.kill(pid, 0) fails => "owner process gone"

/** mk(number, track, { opened, closed, owner, where, next, items, pid }) -> record. Item ids are stored form (track a: "N.k", b..z: "Nb.k"). */
function mk(number, track, o) {
  const x = o || {};
  const n = Number(number);
  const meta = {
    number, track, sessionIds: x.owner ? [x.owner] : [], claudeSessionId: x.owner || null,
    claudePid: x.pid || null, claudePidStartedAt: null, hostname: x.pid ? os.hostname() : null,
    openedAt: x.opened, closedAt: x.closed || null, tpmVersion: '0.2.0',
    lastWriter: { version: '0.2.0-dev', at: x.last || x.closed || x.opened },
  };
  return {
    schemaVersion: '1.0.0', kind: 'session', meta,
    handoff: x.handoff === undefined ? { where: x.where || `where ${number}${track}`, next: x.next || `next ${number}${track}`, in_flight: [], must_not_redo: [], updatedAt: x.last || x.closed || x.opened } : x.handoff,
    log: [],
    punchlist: (x.items || []).map((text, i) => ({
      id: `${n}${track === 'a' ? '' : track}.${i + 1}`, slug: `${number}${track}i${i + 1}`, text, state: 'open', createdAt: x.opened, events: [{ ts: x.opened, op: 'add' }],
    })),
  };
}

function put(sd, rec) {
  const p = T.trackPaths(sd, rec.meta.number, rec.meta.track);
  fs.mkdirSync(p.folder, { recursive: true });
  fs.writeFileSync(p.jsonPath, `${JSON.stringify(rec, null, 2)}\n`);
  return p;
}

function marker(sd, number, track, o) {
  const x = o || {};
  const p = T.trackPaths(sd, number, track);
  fs.mkdirSync(p.folder, { recursive: true });
  fs.writeFileSync(p.sealedPath, `${JSON.stringify({
    schema: 1, kind: 'seal-marker', number, track, reason: x.reason || 'abandoned', note: x.note === undefined ? null : x.note, sealedAt: x.at,
    sealedBy: { claudeSessionId: x.by || id('d'), claudePid: null, claudePidStartedAt: null, hostname: null, track: null },
    ownerAtSeal: { claudeSessionId: x.owner || null, claudePid: null, hostname: null }, lastSaveSeen: x.at, lastWriter: { version: '0.2.0-dev', at: x.at },
  }, null, 2)}\n`);
  return p;
}

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-multi-')); }

/** Prove every record loads through the real reader. */
function assertLoads(sd) {
  for (const n of T.listSessionNumbers(sd)) {
    for (const t of T.listFolder(sd, n).tracks) {
      const st = T.trackState(sd, n, t.track);
      if (st.state === 'unreadable') throw new Error(`fixture unreadable: ${n}${t.track}: ${st.message}`);
    }
  }
}

/** The three-track session of the output-shapes sample: a sealed by its owner, b sealed by a marker (record still open), c live (owner gone). */
function threeTrack(sd, number) {
  const n = number || '0001';
  put(sd, mk(n, 'a', { owner: id('a'), opened: at('00:00'), closed: at('00:05', '36'), where: 'Config work finished except the retry test.', next: 'Re-run the retry test under load.', items: ['fix flaky retry test'] }));
  put(sd, mk(n, 'b', { owner: id('b'), opened: at('00:01'), last: at('00:03'), where: 'Exporter half ported.', next: 'Finish exporter then docs.', items: ['port the exporter', 'write exporter docs'] }));
  marker(sd, n, 'b', { at: at('00:05', '36'), by: id('d'), reason: 'abandoned', note: 'owner window closed', owner: id('b') });
  put(sd, mk(n, 'c', { owner: id('c'), opened: at('00:02'), last: at('00:05', '36'), pid: DEAD_PID, where: 'Lock benchmark in progress.', next: 'Record numbers in the doc.', items: ['benchmark the lock'] }));
  assertLoads(sd);
  return { sd, number: n };
}

/** The straggler scenarios of the plan (S1 S2 S3), ported from the phase-11 `mk-straggler.js`. */
function straggler(sd, scenario) {
  const w = (number, track, opened, closed, owner, where, items) => put(sd, mk(number, track, { opened, closed, owner, where, items }));
  if (scenario === 'S1') {
    w('0123', 'a', at('09:00'), at('14:02'), id('a'), 'a: config done', ['123a open item']);
    w('0123', 'b', at('09:05'), at('15:40'), id('b'), 'b: exporter done', ['123b open item']);
    w('0123', 'c', at('09:10'), at('16:10'), id('c'), 'c: bench done', ['123c open item']);
    w('0124', 'a', at('14:10'), at('14:50'), id('d'), '124: side quest', ['124 open item']);
    w('0125', 'a', at('16:30'), null, id('e'), '125: just started', []);
  } else if (scenario === 'S2') {
    w('0123', 'a', at('09:00'), at('14:02'), id('a'), 'a: config done', ['123a open item']);
    w('0123', 'b', at('09:05'), at('15:40'), id('b'), 'b: exporter done', ['123b open item']);
    w('0123', 'c', at('09:10'), at('13:00'), id('c'), 'c: bench done', ['123c open item']);
    w('0124', 'a', at('13:30'), at('15:00'), id('d'), '124: ran while a,b live', ['124 open item']);
    w('0125', 'a', at('14:20'), at('15:50'), id('e'), '125: opened while b live', ['125 open item']);
    w('0126', 'a', at('16:00'), null, id('f'), '126: just started', []);
  } else if (scenario === 'S3') {
    w('0123', 'a', at('09:00'), null, id('a'), 'a: dead window', ['123a open item']);
    w('0123', 'b', at('09:05'), null, id('b'), 'b: dead window', ['123b open item']);
    for (const l of ['a', 'b']) marker(sd, '0123', l, { at: at('14:02'), by: id('d'), reason: 'seal-and-new', owner: id(l) });
    w('0124', 'a', at('14:02'), at('14:40'), id('d'), '124: opened by seal-and-new', ['124 open item']);
    w('0125', 'a', at('15:00'), null, id('e'), '125: just started', []);
  } else throw new Error(`unknown scenario ${scenario}`);
  assertLoads(sd);
  return sd;
}

module.exports = { at, id, mk, put, marker, scratch, assertLoads, threeTrack, straggler, DEAD_PID };
