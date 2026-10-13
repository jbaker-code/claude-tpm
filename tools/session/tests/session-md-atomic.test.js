'use strict';
/**
 * session-md-atomic.test.js — DoD G (phase 10, #1173 session-side): the DERIVED session `.md` is written
 * atomically (temp file in the same dir -> rename), so a reader can never catch a torn / half-written `.md`
 * while another Claude instance saves. Mirrors the task-side test (task/tests/task-lock.test.js "D").
 *
 *   G1 spy: saveSession, a full ops sequence (open/save/note/punchlist/close) and the claim path write NO store
 *      file with a plain fs.writeFileSync; each `.md` arrives by rename.
 *   G2 the migrate writer (tpm-session-migrate runMigration) writes its derived `.md` by rename too.
 *   G3 FORCED interleaving (fs-barrier): a real `save` child is parked right before the rename that publishes
 *      the new `.md`. A reader polling meanwhile sees the OLD `.md` byte-for-byte (complete, never empty or
 *      partial) and the finished new content sits in a dot-less temp beside it; after release the `.md` is the
 *      new complete content, no temp is left, and the JSON (written first) was already new.
 *   G4 the JSON is still written BEFORE the `.md`, and a render/`.md` failure leaves the canonical JSON intact.
 *   G5 confirm-don't-regress: the canonical JSON, the track claim and the hint also arrive by rename/link.
 * Zero deps; hermetic; exits non-zero on failure.  Run: node tools/session/tests/session-md-atomic.test.js
 */
const { assert, tmpDir, fs, path } = require('./helpers/harness');
const { spawn } = require('child_process');
const barrier = require('../../tests/lib/fs-barrier');
const H = require('./helpers/track-helpers');
const model = require('../lib/session-model');
const ops = require('../tpm-session-ops');
const migrator = require('../tpm-session-migrate');
const { render } = require('../lib/session-converter');
const { T } = H;

const HANDOFF = { where: 'w', next: 'n', in_flight: [], must_not_redo: [] };
const ID = H.id('idMd', { hostname: null });

/** Run fn with fs.writeFileSync / fs.renameSync spied; returns { plain: [paths], renamedTo: [paths] }. */
function spied(fn) {
  const plain = []; const renamedTo = [];
  const realW = fs.writeFileSync; const realR = fs.renameSync;
  fs.writeFileSync = function spyW(p) { plain.push(String(p)); return realW.apply(this, arguments); };
  fs.renameSync = function spyR(a, b) { renamedTo.push(String(b)); return realR.apply(this, arguments); };
  try { fn(); } finally { fs.writeFileSync = realW; fs.renameSync = realR; }
  return { plain, renamedTo };
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('G1 saveSession and the whole ops flow write the derived .md by rename, never a plain writeFileSync', () => {
  const dir = tmpDir('md-g1-');
  const jp = path.join(dir, 'session-0001', 'session-0001.json'); const mp = path.join(dir, 'session-0001', 'session-0001.md');
  fs.mkdirSync(path.dirname(jp), { recursive: true });
  const rec = model.openSession({ number: '0001', sessionId: 'sid', tpmVersion: '0.2.0' });
  const a = spied(() => model.saveSession(rec, { jsonPath: jp, mdPath: mp, render: (r) => render(r, { now: '2026-10-07T10:00:00-07:00' }) }));
  assert.deepStrictEqual(a.plain, [], `no plain writeFileSync during saveSession; saw ${JSON.stringify(a.plain)}`);
  assert.ok(a.renamedTo.some((p) => /session-0001\.md$/.test(p)), 'the .md arrived by rename');
  assert.ok(a.renamedTo.some((p) => /session-0001\.json$/.test(p)), 'the canonical JSON arrived by rename');

  const sd = tmpDir('md-g1-ops-');
  const base = { sessionsDir: sd, number: '0001', identity: ID };
  const b = spied(() => {
    ops.opOpen(Object.assign({ sessionId: 'idMd' }, base));
    ops.opSave(base);
    ops.opNote(Object.assign({ type: 'log', status: 'NOTE', text: 'x' }, base));
    ops.opPunchlist(Object.assign({ action: 'add', text: 'item' }, base));
  });
  // the session lock writes its owner payload plainly INTO a private `.lock.new.*` directory that is then renamed into place
  // (phase 12, Q11); that is lock bookkeeping, not a store file, so it is not a plain store write
  const nonStore = b.plain.filter((p) => !/\.claim\./.test(p) && !/[\\/]\.lock\.new\./.test(p));
  assert.deepStrictEqual(nonStore, [], `no plain writeFileSync in any ops verb; saw ${JSON.stringify(nonStore)}`);
  assert.ok(b.renamedTo.some((p) => /session-0001\.md$/.test(p)), 'ops .md by rename');
  assert.ok(fs.existsSync(T.trackPaths(sd, '0001', 'a').mdPath));
});

test('G1b the track-claim path (a second track) also publishes its derived .md by rename', () => {
  const sd = tmpDir('md-g1b-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: HANDOFF });
  const s = spied(() => {
    T.claimTrack(sd, '0001', { identity: H.id('idB'), letters: 'any', tpmVersion: '0.2.0' });
  });
  assert.deepStrictEqual(s.plain.filter((p) => /\.md$/.test(p)), [], `no plain .md write; saw ${JSON.stringify(s.plain)}`);
  assert.ok(s.renamedTo.some((p) => /session-0001-b\.md$/.test(p)), 'b\'s .md arrived by rename');
});

test('G2 the migrate writer emits its derived .md atomically', () => {
  const out = tmpDir('md-g2-');
  const s = spied(() => migrator.runMigration({ inDir: path.join(__dirname, 'fixtures', 'legacy', 'session-0007-clean'), outDir: out, now: '2026-09-19T22:00:00-07:00' }));
  assert.deepStrictEqual(s.plain.filter((p) => p.startsWith(out)), [], `migrate wrote a store file plainly: ${JSON.stringify(s.plain)}`);
  assert.ok(s.renamedTo.some((p) => /session-0007\.md$/.test(p)), 'migrated .md arrived by rename');
});

test('G3 FORCED: a reader never catches a torn .md - parked before the .md rename, the old .md is intact; released, the new one is complete', async () => {
  const sd = tmpDir('md-g3-'); const wd = tmpDir('md-g3-sync-');
  H.putTrack(sd, '0001', 'a', { owner: 'idW', handoff: HANDOFF });
  const p = T.trackPaths(sd, '0001', 'a');
  const mdOld = fs.readFileSync(p.mdPath, 'utf8');
  const jsonOld = fs.readFileSync(p.jsonPath, 'utf8');
  const ready = path.join(wd, 'ready'); const wait = path.join(wd, 'wait');
  const env = H.cleanEnv({ CLAUDE_CODE_SESSION_ID: 'idW', CLAUDE_PID: String(process.pid) });
  Object.assign(env, barrier.env({ fn: 'renameSync', pattern: 'session-0001\\.md\\.[^/]*\\.tmp$', when: 'before', ready, wait, maxMs: 15000 }));
  let err = '';
  const child = spawn(process.execPath, [H.OPS, 'note', '--sessions-dir', sd, '--session', '1', '--log', '--status', 'NOTE', '--text', 'UNIQUE-NOTE-TEXT'], { env });
  child.stderr.on('data', (d) => { err += d; });
  const closed = new Promise((res) => child.on('close', res));
  const t0 = Date.now();
  while (!fs.existsSync(ready)) { if (Date.now() - t0 > 10000) { child.kill('SIGKILL'); throw new Error('writer never parked before the .md rename (is the .md written atomically?) ' + err); } await new Promise((r) => setTimeout(r, 15)); }
  // ---- the writer is mid-save: JSON already published, .md rename pending ----
  assert.strictEqual(fs.readFileSync(p.mdPath, 'utf8'), mdOld, 'a reader sees the OLD .md, complete and byte-identical (never empty/partial)');
  assert.ok(mdOld.length > 0);
  assert.notStrictEqual(fs.readFileSync(p.jsonPath, 'utf8'), jsonOld, 'the canonical JSON was written FIRST (already new)');
  assert.ok(/UNIQUE-NOTE-TEXT/.test(fs.readFileSync(p.jsonPath, 'utf8')));
  const tmps = fs.readdirSync(p.folder).filter((n) => /^session-0001\.md\..*\.tmp$/.test(n));
  assert.strictEqual(tmps.length, 1, `the new .md is being prepared in a temp beside it: ${fs.readdirSync(p.folder)}`);
  assert.ok(/UNIQUE-NOTE-TEXT/.test(fs.readFileSync(path.join(p.folder, tmps[0]), 'utf8')), 'the temp already holds the COMPLETE new content');
  fs.writeFileSync(wait, 'go');
  assert.strictEqual(await closed, 0, err);
  const mdNew = fs.readFileSync(p.mdPath, 'utf8');
  assert.notStrictEqual(mdNew, mdOld);
  assert.ok(/UNIQUE-NOTE-TEXT/.test(mdNew) && /## Handoff/.test(mdNew), 'the new .md is complete');
  assert.deepStrictEqual(fs.readdirSync(p.folder).filter((n) => n.endsWith('.tmp')), [], 'no temp left behind');
});

test('G4 order and failure: JSON first; a failing .md write leaves the canonical JSON intact and the old .md untouched', () => {
  const sd = tmpDir('md-g4-');
  H.putTrack(sd, '0001', 'a', { owner: 'idW', handoff: HANDOFF });
  const p = T.trackPaths(sd, '0001', 'a');
  const mdOld = fs.readFileSync(p.mdPath, 'utf8');
  const loaded = model.appendLog(model.loadSession(p.jsonPath), { type: 'log', status: 'NOTE', text: 'JSON-FIRST' });
  const realRename = fs.renameSync;
  const order = [];
  fs.renameSync = function failMd(a, b) {
    order.push(path.basename(String(b)));
    if (/\.md$/.test(String(b))) throw new Error('boom: simulated .md rename failure');
    return realRename.apply(this, arguments);
  };
  let threw = null;
  try { model.saveSession(loaded, { jsonPath: p.jsonPath, mdPath: p.mdPath, render: (r) => render(r, { now: '2026-10-07T10:00:00-07:00' }) }); } catch (e) { threw = e; } finally { fs.renameSync = realRename; }
  assert.ok(threw && /boom/.test(threw.message), 'the .md failure is loud: ' + (threw && threw.message));
  assert.deepStrictEqual(order, ['session-0001.json', 'session-0001.md'], 'JSON renamed first, then the .md');
  assert.ok(/JSON-FIRST/.test(fs.readFileSync(p.jsonPath, 'utf8')), 'canonical JSON has the change');
  assert.strictEqual(fs.readFileSync(p.mdPath, 'utf8'), mdOld, 'the old .md is untouched (not truncated)');
  assert.deepStrictEqual(fs.readdirSync(p.folder).filter((n) => n.endsWith('.tmp')), [], 'the failed temp was cleaned up');
});

test('G5 confirm-don\'t-regress: the hint and a second track\'s record are published atomically (rename / link), never by plain write', () => {
  const sd = tmpDir('md-g5-');
  H.putTrack(sd, '0001', 'a', { owner: 'idA', handoff: HANDOFF });
  const s = spied(() => {
    T.writeHint(sd);
    T.claimTrack(sd, '0001', { identity: H.id('idB'), letters: 'any', tpmVersion: '0.2.0' });
  });
  const bad = s.plain.filter((p) => /\.(json|md|sealed)$/.test(p) && !/\.claim\./.test(p));
  assert.deepStrictEqual(bad, [], `no plain write to a store file; saw ${JSON.stringify(s.plain)}`);
  assert.ok(s.renamedTo.some((p) => /\.current-session\.json$/.test(p)), 'the hint arrives by rename');
});

(async () => {
  let passed = 0; let failed = 0;
  for (const [name, fn] of cases) {
    try { await fn(); passed += 1; console.log(`  ok   - ${name}`); } catch (e) { failed += 1; console.log(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack : String(e)).split('\n').slice(0, 5).join('\n         ')}`); }
  }
  console.log(`\nsession-md-atomic.test: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
