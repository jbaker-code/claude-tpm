'use strict';
/**
 * boot-pin-scenario.js — the single-track byte PIN for `boot-read` and `review` (phase 13, written BEFORE the
 * multi-track pickup so nothing could drift unnoticed). Builds several scratch stores that hold ONLY track a
 * (fixed, hand-built records: fixed timestamps, so no clock and no same-second ties), runs the real CLIs as named
 * Claude instances, and returns one deterministic transcript. `golden/boot-read-single-pin.txt` is that transcript
 * captured from the tree BEFORE phase 13's edits; session-boot-pin.test.js compares today's transcript to it.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const H = require('./track-helpers');

const REVIEW = path.join(H.OPS, '..', 'tpm-session-export.js');
const ID = (c) => `${c.repeat(8)}-0000-4000-8000-${c.repeat(12)}`;
const day = '2026-10-05';
const at = (hhmm) => `${day}T${hhmm}:00-07:00`;

/** A schema-valid single-track record with fixed timestamps (legacy shape when `legacy`, else new-shape track a). */
function mk(number, o) {
  const x = o || {};
  const n = Number(number);
  const meta = { number, sessionIds: [x.owner || 'legacy-sid'], openedAt: x.opened, closedAt: x.closed || null, tpmVersion: '0.2.0' };
  if (!x.legacy) Object.assign(meta, { track: 'a', claudeSessionId: x.owner || null, claudePid: null, claudePidStartedAt: null, hostname: null, lastWriter: { version: '0.2.0-dev', at: x.closed || x.opened } });
  return {
    schemaVersion: '1.0.0', kind: 'session', meta,
    handoff: x.handoff === undefined ? { where: `where ${number}`, next: `next ${number}`, in_flight: x.inFlight || [], must_not_redo: x.mnr || [], updatedAt: x.closed || x.opened } : x.handoff,
    log: [],
    punchlist: (x.items || []).map((text, i) => ({ id: `${n}.${i + 1}`, slug: `s${number}i${i + 1}`, text, state: 'open', createdAt: x.opened, events: [{ ts: x.opened, op: 'add' }] })),
  };
}

function put(sd, rec) {
  const p = H.T.trackPaths(sd, rec.meta.number, 'a');
  fs.mkdirSync(p.folder, { recursive: true });
  fs.writeFileSync(p.jsonPath, `${JSON.stringify(rec, null, 2)}\n`);
}

function store(root, name, build) {
  const sd = path.join(root, name);
  fs.mkdirSync(sd, { recursive: true });
  build(sd);
  return sd;
}

function transcript(opts) {
  const o = opts || {};
  const root = fs.mkdtempSync(path.join(o.tmpRoot || os.tmpdir(), 'tpm-bootpin-'));
  const out = [];
  const bootRead = (label, sd, who) => {
    const r = H.run(H.BOOT_READ, ['--sessions-dir', sd], who ? { id: who, pid: 77001 } : {});
    out.push(`$ boot-read [${label}]\nexit ${r.code}\n--- stdout\n${r.stdout.split(sd).join('<SD>')}--- stderr\n${r.stderr.split(sd).join('<SD>')}`);
  };
  const review = (label, sd, n) => {
    const r = H.run(REVIEW, ['--sessions-dir', sd, '--session', n, '--style', 'human', '--now', '2026-10-08T00:30:00-07:00'], {});
    out.push(`$ review [${label}]\nexit ${r.code}\n--- stdout\n${r.stdout.split(sd).join('<SD>')}--- stderr\n${r.stderr.split(sd).join('<SD>')}`);
  };

  // S-closed: one sealed session with a handoff + open items; a different instance and a no-identity caller ask.
  const closed = store(root, 'closed', (sd) => put(sd, mk('0001', { owner: ID('a'), opened: at('09:00'), closed: at('10:00'), items: ['fix flaky retry test', 'port the exporter'], inFlight: ['half-done thing'], mnr: ['do not rm'] })));
  bootRead('one sealed session, other instance', closed, ID('d'));
  bootRead('one sealed session, no identity', closed, null);
  review('one sealed session', closed, '0001');

  // S-chain: three sealed single-track sessions, spaced in time; the caller owns the live 0004. Only 0003 is shown.
  const chain = store(root, 'chain', (sd) => {
    put(sd, mk('0001', { owner: ID('a'), opened: at('08:00'), closed: at('08:30'), items: ['old item'] }));
    put(sd, mk('0002', { owner: ID('b'), opened: at('09:00'), closed: at('09:30'), items: [] }));
    put(sd, mk('0003', { owner: ID('c'), opened: at('10:00'), closed: at('10:30'), items: ['newest open item'] }));
    put(sd, mk('0004', { owner: ID('d'), opened: at('11:00'), closed: null, items: [] }));
  });
  bootRead('chain, caller owns 0004', chain, ID('d'));
  bootRead('chain, a stranger asks', chain, ID('z'));

  // S-legacy-left-open: a legacy record never closed (superseded) under a later closed session.
  const left = store(root, 'left', (sd) => {
    put(sd, mk('0001', { legacy: true, owner: 'sid-1', opened: at('08:00'), closed: null, items: ['stale open item'] }));
    put(sd, mk('0002', { owner: ID('b'), opened: at('09:00'), closed: at('09:30'), items: ['two'] }));
  });
  bootRead('legacy left-open under a later session', left, ID('z'));

  // S-nohandoff: a prior with no handoff and no open items, under a newer record that fails validation (skipped).
  const bare = store(root, 'bare', (sd) => {
    put(sd, mk('0001', { owner: ID('a'), opened: at('08:00'), closed: at('08:30'), handoff: null, items: [] }));
    put(sd, mk('0002', { owner: ID('b'), opened: at('09:00'), closed: at('09:30'), handoff: { where: '', next: '', in_flight: [], must_not_redo: [], updatedAt: at('09:30') }, items: [] }));
  });
  bootRead('no-handoff prior under an invalid newer record', bare, ID('z'));

  // S-skip: a corrupt NEWER record above a valid one; only a corrupt record; nothing at all; a hollow folder.
  const skip = store(root, 'skip', (sd) => {
    put(sd, mk('0001', { owner: ID('a'), opened: at('08:00'), closed: at('08:30'), items: ['one'] }));
    fs.mkdirSync(path.join(sd, 'session-0009'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'session-0009', 'session-0009.json'), '{ broken');
  });
  bootRead('corrupt newer above valid', skip, ID('z'));
  const onlyBad = store(root, 'onlybad', (sd) => {
    fs.mkdirSync(path.join(sd, 'session-0005'), { recursive: true });
    fs.writeFileSync(path.join(sd, 'session-0005', 'session-0005.json'), 'not json{');
  });
  bootRead('only a corrupt record', onlyBad, ID('z'));
  const empty = store(root, 'empty', () => {});
  bootRead('empty store', empty, ID('z'));
  const hollow = store(root, 'hollow', (sd) => { fs.mkdirSync(path.join(sd, 'session-0003'), { recursive: true }); });
  bootRead('only a hollow folder', hollow, ID('z'));

  // A stray non-track note beside a record (the real store has two of these): must stay silent.
  const stray = store(root, 'stray', (sd) => {
    put(sd, mk('0001', { owner: ID('a'), opened: at('08:00'), closed: at('08:30'), items: ['one'] }));
    fs.writeFileSync(path.join(sd, 'session-0001', 'session-notes.md'), 'hand-written\n');
  });
  bootRead('stray session-notes.md beside a record', stray, ID('z'));

  return { text: `${out.join('\n\n')}\n`, root };
}

module.exports = { transcript, mk, put, ID, at };
