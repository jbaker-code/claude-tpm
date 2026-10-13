'use strict';
/**
 * three-track.js — a fixed three-track session for the collated-read tests: track a closed by its owner, track b
 * sealed by someone else's marker (its record still says meta.closedAt = null and its .md says "open"), track c live.
 * Built with the real model + track-helpers (never hand-edited JSON), so the files are what the tools write.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./track-helpers');
const { render } = require('../../lib/session-converter');

const IDS = { a: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', b: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb', c: 'cccccccc-3333-4333-8333-cccccccccccc' };

function save(sd, n, track, rec) {
  const p = H.T.trackPaths(sd, n, track);
  H.model.saveSession(rec, { jsonPath: p.jsonPath, mdPath: p.mdPath, render: (r) => render(r, { now: H.NOW }) });
}

function build(sd, number) {
  const n = number || '0001';
  const model = H.model;
  const ho = (t) => ({ where: `work of track ${t}`, next: `next of track ${t}`, in_flight: [], must_not_redo: [] });
  const put = (track, items, after) => {
    const jp = H.putTrack(sd, n, track, { owner: IDS[track], handoff: ho(track) });
    let rec = model.loadSession(jp);
    for (const it of items) rec = model.addPunchlist(rec, it);
    if (after) rec = after(rec);
    save(sd, n, track, rec);
  };
  // a: two items, one closed, then the track closed by its owner
  put('a', [{ text: 'wire the config loader', slug: 'cfgload' }, { text: 'fix flaky retry test', slug: 'retry01' }],
    (r) => model.closeSession(model.closePunchlistItem(r, 'cfgload')));
  // b: sealed by someone else's marker (record untouched: closedAt null)
  put('b', [{ text: 'port the exporter', slug: 'exportr' }, { text: 'write exporter docs', slug: 'expdoc' }]);
  H.putMarker(sd, n, 'b', {
    schema: 1, kind: 'seal-marker', sealedAt: '2026-10-07T11:00:00-07:00', reason: 'abandoned', note: null,
    sealedBy: { claudeSessionId: 'zzzzzzzz-9999-4999-8999-zzzzzzzzzzzz', hostname: 'h' },
  });
  // c: live
  put('c', [{ text: 'benchmark the lock', slug: 'bench01' }]);
  return { sd, number: n, ids: IDS };
}

/** relative path -> sha256 of every file under dir (recursive): proves a call wrote nothing / touched only its own file. */
function shas(dir) {
  const out = {};
  (function walk(d) {
    for (const nm of fs.readdirSync(d).sort()) {
      const p = path.join(d, nm);
      if (fs.statSync(p).isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    }
  }(dir));
  return out;
}

module.exports = { build, IDS, shas };
