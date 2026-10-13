'use strict';
/**
 * session-export-migrate-tracks.test.js — phase 14 DoD C and D.
 *  C: export covers EVERY track of a session (each identifiable), `--track` narrows, a single-track session exports exactly
 *     the bare envelope it always did, `--combine per-file --out` keeps one file per track (nothing overwritten), the old
 *     "not included by this version" advisory is gone.
 *  D: migrate leaves a multi-track (current-format) folder alone and refuses it as a SOURCE with a clear message; legacy
 *     3-file folders migrate exactly as before; migrating INTO a folder that already holds sibling tracks is refused
 *     explicitly (even with --force) and writes nothing.
 * Run: node tests/session-export-migrate-tracks.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const TT = require('./helpers/three-track');
const migrator = require('../tpm-session-migrate');

const EXPORT = path.join(H.OPS, '..', 'tpm-session-export.js');
const MIGRATE = path.join(H.OPS, '..', 'tpm-session-migrate.js');
const FIX = path.join(__dirname, 'fixtures', 'legacy');
const PINNED_NOW = '2026-09-19T22:00:00-07:00';
const exp = (sd, args) => H.run(EXPORT, ['--sessions-dir', sd, ...args]);

// ── C ────────────────────────────────────────────────────────────────────────

test('C-1 JSON export of a three-track session is an array a,b,c, each identifiable by meta.track; the advisory is gone', () => {
  const sd = tmpDir('xm-1-'); TT.build(sd, '0001');
  const r = exp(sd, ['--session', '1', '--style', 'json']);
  assert.strictEqual(r.code, 0, r.stderr);
  const recs = JSON.parse(r.stdout);
  assert.deepStrictEqual(recs.map((x) => x.meta.track || 'a'), ['a', 'b', 'c']);
  assert.ok(!/not included by this version/.test(r.stderr));
  assert.ok(/track b of 0001 is sealed by a marker/.test(r.stderr), 'the marker-sealed track is called out on stderr');
});

test('C-2 human export names every track; --track narrows (letter and id prefix); narrowed JSON is one bare envelope', () => {
  const sd = tmpDir('xm-2-'); TT.build(sd, '0001');
  const all = exp(sd, ['--session', '1', '--style', 'human']).stdout;
  assert.ok(/3 parallel tracks/.test(all) && /track b/.test(all) && /track c/.test(all));
  const b = JSON.parse(exp(sd, ['--session', '1', '--style', 'json', '--track', 'b']).stdout);
  assert.ok(!Array.isArray(b) && b.meta.track === 'b');
  const c = JSON.parse(exp(sd, ['--session', '1', '--style', 'json', '--track', 'cccccccc']).stdout);
  assert.strictEqual(c.meta.track, 'c');
  assert.strictEqual(exp(sd, ['--session', '1', '--track', 'bbbb']).code, 2);
  assert.strictEqual(exp(sd, ['--session', '1b']).code, 2);
});

test('C-3 single-track session: JSON export is the bare envelope, identical to the file on disk', () => {
  const sd = tmpDir('xm-3-'); const f = H.putTrack(sd, '0001', 'a', { owner: 'idA' });
  const out = exp(sd, ['--session', '1', '--style', 'json']);
  assert.deepStrictEqual(JSON.parse(out.stdout), JSON.parse(fs.readFileSync(f, 'utf8')));
  assert.strictEqual(out.stderr, '');
});

test('C-4 --combine per-file --out keeps one file per track (nothing overwritten)', () => {
  const sd = tmpDir('xm-4-'); TT.build(sd, '0001'); const out = tmpDir('xm-4-out-');
  const r = exp(sd, ['--session', '1', '--style', 'both', '--combine', 'per-file', '--out', out]);
  assert.strictEqual(r.code, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(out).sort(), ['session-0001-b.json', 'session-0001-c.json', 'session-0001.json', 'session-0001.md']);
  assert.deepStrictEqual(['a', 'b', 'c'].map((t) => JSON.parse(fs.readFileSync(path.join(out, t === 'a' ? 'session-0001.json' : `session-0001-${t}.json`), 'utf8')).meta.track || 'a'), ['a', 'b', 'c']);
});

test('C-5 export is a pure read: the whole store is byte-identical afterwards', () => {
  const sd = tmpDir('xm-5-'); TT.build(sd, '0001'); const before = TT.shas(sd);
  exp(sd, ['--session', '1', '--style', 'both']); exp(sd, ['--last', '1', '--track', 'b']);
  assert.deepStrictEqual(TT.shas(sd), before);
});

// ── D ────────────────────────────────────────────────────────────────────────

test('D-1 a multi-track folder given as the SOURCE is refused as current-format; nothing is touched or written', () => {
  const sd = tmpDir('xm-d1-'); TT.build(sd, '0001'); const out = tmpDir('xm-d1-out-');
  const before = TT.shas(sd);
  const r = H.run(MIGRATE, ['--in', path.join(sd, 'session-0001'), '--out-dir', out]);
  assert.strictEqual(r.code, 1);
  assert.ok(/current-format session folder/.test(r.stderr) && /nothing to migrate/.test(r.stderr), r.stderr);
  assert.ok(!/mixed\/pre-format/.test(r.stderr));
  assert.deepStrictEqual(TT.shas(sd), before);
  assert.deepStrictEqual(fs.readdirSync(out), []);
  assert.throws(() => migrator.detectShape(path.join(sd, 'session-0001')), /current-format/);
});

test('D-2 a current-format folder of only -b is also refused as a source (no "mixed/pre-format")', () => {
  const sd = tmpDir('xm-d2-'); H.putTrack(sd, '0001', 'b', { owner: 'idB' });
  assert.throws(() => migrator.detectShape(path.join(sd, 'session-0001')), /current-format/);
});

test('D-3 a legacy marked 3-file folder still migrates byte-for-byte to the frozen golden', () => {
  const out = tmpDir('xm-d3-');
  const res = migrator.runMigration({ inDir: path.join(FIX, 'session-0021'), outDir: out, now: PINNED_NOW });
  assert.strictEqual(fs.readFileSync(res.outPath, 'utf8'), fs.readFileSync(path.join(FIX, 'session-0021.expected.json'), 'utf8'));
});

test('D-4 migrating INTO a folder that already holds sibling tracks is refused (also with --force and --dry-run); siblings byte-identical; no track a added', () => {
  const out = tmpDir('xm-d4-'); H.putTrack(out, '0021', 'b', { owner: 'idB' }); H.putMarker(out, '0021', 'c', undefined);
  const before = TT.shas(out);
  for (const extra of [[], ['--force'], ['--dry-run']]) {
    const r = H.run(MIGRATE, ['--in', path.join(FIX, 'session-0021'), '--out-dir', out, '--now', PINNED_NOW, ...extra]);
    assert.strictEqual(r.code, 1, extra.join(' '));
    assert.ok(/already holds other track file\(s\) \(session-0021-b\.json/.test(r.stderr), r.stderr);
  }
  assert.deepStrictEqual(TT.shas(out), before);
  assert.ok(!fs.existsSync(path.join(out, 'session-0021', 'session-0021.json')));
});

test('D-5 migrating again into a folder holding only the earlier migration of the same session behaves as before (refuses without --force, overwrites with it)', () => {
  const out = tmpDir('xm-d5-');
  migrator.runMigration({ inDir: path.join(FIX, 'session-0021'), outDir: out, now: PINNED_NOW });
  assert.throws(() => migrator.runMigration({ inDir: path.join(FIX, 'session-0021'), outDir: out, now: PINNED_NOW }), /already exists/);
  assert.ok(migrator.runMigration({ inDir: path.join(FIX, 'session-0021'), outDir: out, now: PINNED_NOW, force: true }).written);
});

test('D-6 a freshly migrated session is accepted by the track-aware doctor (current-format, no old-format suggestion)', () => {
  const out = tmpDir('xm-d6-');
  migrator.runMigration({ inDir: path.join(FIX, 'session-0021'), outDir: out, now: PINNED_NOW });
  const rep = require('../tpm-session-doctor').runDoctor({ sessionsDir: out });
  assert.strictEqual(rep.oldFormat.length, 0); assert.strictEqual(rep.results.length, 1); assert.strictEqual(rep.summary.invalid, 0);
});

done('session-export-migrate-tracks.test.js');
