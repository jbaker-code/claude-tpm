'use strict';
/**
 * task-lock.test.js — the task store lock, in-process (multi-session support, phase 04; DoD rows A, C, D, E, F, G
 * and the Amendments: reindex fail-loud, lastWriter stamp + doctor flag, reader ENOENT-retry, lock ordering).
 * The cross-PROCESS interleavings live in task-lock-interleave.test.js; the helper's own tests are
 * tools/session/tests/lock.test.js.
 *
 * Every store is an os.tmpdir scratch. Lock timing knobs come from TPM_LOCK_WAIT_MS / TPM_LOCK_STALE_MS (set and
 * restored around each case); stderr is captured, never printed. Run: node tools/task/tests/task-lock.test.js
 */
const {
  assert, test, done, withFailingFs, scratch, fs, indexJson, bodyPath, bodyMdPath, tmpOrphans,
} = require('./helpers/task-e2e-helpers');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const t = require('../tpm-task.js');
const model = require('../lib/task-model');
const conv = require('../lib/task-converter');
const doctor = require('../tpm-task-doctor');
const { nowIsoTz } = require('../lib/base').timestamp;

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────
function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}
function captureStderr(fn) {
  const real = process.stderr.write; let buf = '';
  process.stderr.write = function cap(s) { buf += String(s); return true; };
  try { const v = fn(); return { v, err: buf }; } catch (e) { e.captured = buf; throw e; } finally { process.stderr.write = real; }
}
function seed(dir) {
  t.opAdd({ tasksDir: dir, headline: 'seeded', labels: ['x'], summary: 's' });          // 1000
  t.opAddSubtask({ tasksDir: dir, id: '1000', text: 'sub' });
  t.opAdd({ tasksDir: dir, headline: 'second' });                                       // 1001
  return dir;
}
const lockOf = (dir) => path.join(dir, '.lock');
const strays = (dir) => fs.readdirSync(dir).filter((n) => n.startsWith('.lock'));
function deadPid() { return spawnSync(process.execPath, ['-e', '']).pid; }
/** Craft a lock directory by the documented layout (owner.json + .gitignore). */
function craftLock(dir, over) {
  const owner = Object.assign({ schema: 1, nonce: 'crafted-nonce-0001', pid: process.pid, host: 'some-other-host.example', at: nowIsoTz(), startedAt: null, version: '0.1.0', verb: 'crafted', claudePid: null, claudeSessionId: null }, over || {});
  fs.mkdirSync(lockOf(dir), { recursive: true });
  fs.writeFileSync(path.join(lockOf(dir), '.gitignore'), '*\n');
  fs.writeFileSync(path.join(lockOf(dir), 'owner.json'), JSON.stringify(owner, null, 2) + '\n');
  return owner;
}
function snapshot(dir) {
  const out = {};
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else out[path.relative(dir, f)] = fs.readFileSync(f, 'utf8'); } })(dir);
  return out;
}
const pad = (iso, deltaMs) => nowIsoTz(new Date(Date.parse(iso) + deltaMs));

// rename fault that spares the lock's own renames (see ops-persist-fault.test.js)
function withFailingFsAfterLock(fn) {
  const real = fs.renameSync;
  fs.renameSync = function stub(from, to) {
    if ([from, to].some((p) => /^\.lock(\.|$)/.test(path.basename(String(p))))) return real.apply(this, arguments);
    const e = new Error('injected fs.renameSync failure'); e.code = 'EIO'; throw e;
  };
  try { return fn(); } finally { fs.renameSync = real; }
}

// ── A: every mutating op holds the lock for its whole read-modify-write; releases on success AND on a throw ──
test('A: every op takes the lock (owner names the verb + version) and leaves NOTHING behind, success or throw', () => {
  const dir = seed(scratch('tpm-lock-a-'));
  const seen = [];
  const realRead = fs.readFileSync;
  // observe the lock from INSIDE each op: the first store read of the op happens with the lock held
  fs.readFileSync = function spy(p) {
    if (/(tasks-index|task-\d+)\.json$/.test(String(p)) && fs.existsSync(path.join(lockOf(dir), 'owner.json'))) {
      try { const o = JSON.parse(realRead.call(fs, path.join(lockOf(dir), 'owner.json'), 'utf8')); seen.push(o.verb); } catch (_e) { /* mid-swap */ }
    }
    return realRead.apply(this, arguments);
  };
  try {
    t.opAdd({ tasksDir: dir, headline: 'v-add' });
    t.opEdit({ tasksDir: dir, id: '1001', headline: 'v-edit' });
    t.opImport({ tasksDir: dir, id: '1001', jsonText: '{"headline":"v-import"}' });
    t.opAddSubtask({ tasksDir: dir, id: '1001', text: 'v' });
    t.opCheck({ tasksDir: dir, id: '1001', key: 'A' });
    t.opLabel({ tasksDir: dir, id: '1001', labels: ['l'] });
    t.opUnlabel({ tasksDir: dir, id: '1001', labels: ['l'] });
    t.opTransition('start', { tasksDir: dir, id: '1001' });
    t.opTransition('finish', { tasksDir: dir, id: '1001' });
    t.opTransition('reopen', { tasksDir: dir, id: '1001' });
    t.opTransition('drop', { tasksDir: dir, id: '1001' });
    t.opTransition('remove', { tasksDir: dir, id: '1001' });
    t.opReindex({ tasksDir: dir });
  } finally { fs.readFileSync = realRead; }
  for (const v of ['add', 'edit', 'import', 'add-subtask', 'check', 'label', 'unlabel', 'start', 'finish', 'reopen', 'drop', 'remove', 'reindex']) {
    assert.ok(seen.includes(v), `verb '${v}' read the store while holding a lock whose owner names it; saw ${JSON.stringify([...new Set(seen)])}`);
  }
  assert.deepStrictEqual(strays(dir), [], 'no lock (or leftover) after the successful ops');
  // throwing ops release too
  assert.throws(() => t.opTransition('finish', { tasksDir: dir, id: '1000' }), /subtask|open/i, 'close-guard throws');
  assert.throws(() => t.opEdit({ tasksDir: dir, id: '9999', headline: 'x' }), /./);
  assert.throws(() => t.opAdd({ tasksDir: dir }), /headline/);
  assert.deepStrictEqual(strays(dir), [], 'no lock left behind after ops that threw');
});

test('A: remove --hard holds the lock from the existence check to the last view write, and releases', () => {
  const dir = seed(scratch('tpm-lock-hard-'));
  const cfg = path.join(dir, '..', 'cfg-' + path.basename(dir) + '.json'); fs.writeFileSync(cfg, JSON.stringify({ tasks: { allowHardDelete: true } }));
  const verbs = [];
  const realUnlink = fs.unlinkSync;
  fs.unlinkSync = function spy(p) { if (/task-1001\.json$/.test(String(p))) { try { verbs.push(JSON.parse(fs.readFileSync(path.join(lockOf(dir), 'owner.json'), 'utf8')).verb); } catch (_e) { verbs.push('NO-LOCK'); } } return realUnlink.apply(this, arguments); };
  try { t.opHardRemove({ tasksDir: dir, id: '1001', config: cfg }); } finally { fs.unlinkSync = realUnlink; }
  assert.deepStrictEqual(verbs, ['remove --hard'], 'the body was unlinked while the lock was held');
  assert.deepStrictEqual(strays(dir), []);
  assert.deepStrictEqual(indexJson(dir).tasks.map((r) => r.id), ['1000']);
});

test('G: the lock directory ignores itself while held (.gitignore "*" written before the final name) and the owner carries version + verb', () => {
  const dir = seed(scratch('tpm-lock-g-'));
  let ign; let owner; let names;
  t.withStoreLock(dir, 'probe', () => {
    ign = fs.readFileSync(path.join(lockOf(dir), '.gitignore'), 'utf8');
    owner = JSON.parse(fs.readFileSync(path.join(lockOf(dir), 'owner.json'), 'utf8'));
    names = fs.readdirSync(lockOf(dir)).sort();
  });
  assert.strictEqual(ign, '*\n');
  assert.deepStrictEqual(names, ['.gitignore', 'owner.json']);
  assert.strictEqual(owner.verb, 'probe'); assert.strictEqual(owner.version, t.TPM_VERSION);
  assert.ok(t.TPM_VERSION && /^\d+\.\d+\.\d+/.test(t.TPM_VERSION), 'the running version is read from package.json: ' + t.TPM_VERSION);
  // the lock lives INSIDE the resolved tasks dir: a scratch --tasks-dir locks the scratch store only
  assert.strictEqual(t.lockDirFor(dir), path.join(dir, '.lock'));
});

test('A: a missing store dir is not created by a non-creating verb (a typo\'d --tasks-dir leaves no stray directory)', () => {
  const dir = path.join(scratch('tpm-lock-miss-'), 'nope');
  assert.throws(() => t.opEdit({ tasksDir: dir, id: '1000', headline: 'x' }), /./);
  assert.throws(() => t.opTransition('start', { tasksDir: dir, id: '1000' }), /./);
  assert.ok(!fs.existsSync(dir), 'edit/start on a missing store did not create it');
  t.opAdd({ tasksDir: dir, headline: 'first' });                    // add DOES create the store (brand-new project)
  assert.ok(fs.existsSync(bodyPath(dir, '1000'))); assert.deepStrictEqual(strays(dir), []);
});

test('ordering: stdin / --file / --body-txt-file are read BEFORE the lock is taken; a bad input never takes it', () => {
  const dir = seed(scratch('tpm-lock-order-'));
  const f = path.join(dir, '..', 'in-' + path.basename(dir) + '.txt'); fs.writeFileSync(f, 'body from file');
  const lockedAtRead = [];
  const realRead = fs.readFileSync;
  fs.readFileSync = function spy(p) { if (String(p) === f) lockedAtRead.push(fs.existsSync(lockOf(dir))); return realRead.apply(this, arguments); };
  try {
    t.opAdd({ tasksDir: dir, headline: 'with file', bodyTxtFile: f });
    t.opEdit({ tasksDir: dir, id: '1001', bodyTxtFile: f });
    const jf = f.replace(/\.txt$/, '.json'); fs.writeFileSync(jf, '{"headline":"from json file"}');
    lockedAtRead.length = 0;
    const realRead2 = fs.readFileSync;
    fs.readFileSync = function spy2(p) { if (String(p) === jf) lockedAtRead.push(fs.existsSync(lockOf(dir))); return realRead2.apply(this, arguments); };
    try { t.opImport({ tasksDir: dir, id: '1001', file: jf }); } finally { fs.readFileSync = realRead2; }
  } finally { fs.readFileSync = realRead; }
  assert.ok(lockedAtRead.length >= 1 && lockedAtRead.every((x) => x === false), 'inputs were read with no lock held: ' + JSON.stringify(lockedAtRead));
  assert.strictEqual(model.loadTask(bodyPath(dir, '1001')).headline, 'from json file');
  // error precedence unchanged: a missing file still reports the file, and takes no lock
  assert.throws(() => t.opImport({ tasksDir: dir, id: '1001', file: path.join(dir, 'nope.json') }), /cannot read file/);
  assert.throws(() => t.opAdd({ tasksDir: dir, headline: 'x', bodyTxtFile: path.join(dir, 'nope.txt') }), /cannot read file/);
  assert.deepStrictEqual(strays(dir), []);
});

test('ordering: the lock is taken AFTER assertNotOldFormatStore — a refused old-format store never gets a .lock', () => {
  const dir = scratch('tpm-lock-old-');
  const bucket = path.join(dir, 'bodies', '1000-1999'); fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'task-1000.md'), '# #1000 · a legacy task\n\n- **State:** open\n- **Created:** 2026-01-01\n\n## Summary\n\nold.\n');
  fs.writeFileSync(path.join(dir, 'task-index.md'), '# Tasks\n\n**Next ID:** 1001\n');
  const before = snapshot(dir);
  const r = captureStderr(() => t.main(['add', '--tasks-dir', dir, '--headline', 'nope']));
  assert.strictEqual(r.v, 1); assert.ok(/NOT been migrated/.test(r.err));
  assert.deepStrictEqual(snapshot(dir), before, 'old-format store untouched');
  assert.deepStrictEqual(strays(dir), [], 'no .lock created inside the un-migrated store');
});

// ── E: contention + stale locks behave as the contract says ───────────────────────────────────────────────────
test('E: a held (fresh, foreign) lock: the verb waits its budget then fails loud, actionable, and writes NOTHING (CLI exit 1, no doubled prefix)', () => {
  const dir = seed(scratch('tpm-lock-e1-'));
  craftLock(dir, { verb: 'edit', pid: process.pid });
  const before = snapshot(dir);
  const r = withEnv({ TPM_LOCK_WAIT_MS: '300' }, () => captureStderr(() => t.main(['add', '--tasks-dir', dir, '--headline', 'blocked'])));
  assert.strictEqual(r.v, 1, 'exit 1');
  assert.ok(/^tpm-task: gave up waiting 0 s for lock .*\.lock, held by pid \d+ on host some-other-host\.example, verb edit, version 0\.1\.0, taken /m.test(r.err), r.err);
  assert.ok(/It is not stale yet \(stale after 30 s\)\. Re-run in a moment\./.test(r.err), r.err);
  assert.ok(!/tpm-task: tpm-task:/.test(r.err), 'prefix applied once');
  assert.deepStrictEqual(snapshot(dir), before, 'nothing written, the foreign lock untouched');
  let code; try { withEnv({ TPM_LOCK_WAIT_MS: '200' }, () => captureStderr(() => t.opAdd({ tasksDir: dir, headline: 'blocked' }))); } catch (e) { code = e.code; }
  assert.strictEqual(code, 'ELOCK_TIMEOUT', 'callers branch on err.code');
});

test('E: a stale lock (foreign host, held > 30 s) is broken with the loud message naming the holder; the verb then proceeds; the leftover is kept', () => {
  const dir = seed(scratch('tpm-lock-e2-'));
  craftLock(dir, { host: 'old-laptop.example', pid: 4242, at: pad(nowIsoTz(), -120000), nonce: 'stale-nonce-0002', verb: 'edit' });
  const r = captureStderr(() => t.opAdd({ tasksDir: dir, headline: 'after stale' }));
  assert.ok(/tpm-task: breaking a stale lock .*\.lock\n\s+held by pid 4242 on host old-laptop\.example, verb edit/.test(r.err), r.err);
  assert.ok(/reason: held for 1\d\d s \(stale after 30 s\)/.test(r.err), r.err);
  assert.ok(/its write may be incomplete: run `tpm task doctor`; if it reports drift, `tpm task reindex`\./.test(r.err), r.err);
  assert.strictEqual(r.v.headline, 'after stale');
  const left = strays(dir); assert.strictEqual(left.length, 1); assert.ok(/^\.lock\.broken\./.test(left[0]));
  assert.ok(fs.existsSync(path.join(dir, left[0], '.gitignore')));
});

test('E: a dead holder on THIS host is broken after the confirm delay (pid not running), loudly', () => {
  const dir = seed(scratch('tpm-lock-e3-'));
  const dead = deadPid();
  craftLock(dir, { host: os.hostname(), pid: dead, nonce: 'dead-nonce-0003', verb: 'reindex' });
  const r = captureStderr(() => t.opAdd({ tasksDir: dir, headline: 'after dead' }));
  assert.ok(new RegExp('breaking a stale lock[\\s\\S]*held by pid ' + dead + ' on host ' + os.hostname().replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + ', verb reindex[\\s\\S]*reason: process ' + dead + ' is not running').test(r.err), r.err);
  assert.strictEqual(r.v.headline, 'after dead');
});

test('E: an owner-less lock directory is NEVER broken: the verb times out with the by-hand instruction', () => {
  const dir = seed(scratch('tpm-lock-e4-'));
  fs.mkdirSync(lockOf(dir)); fs.writeFileSync(path.join(lockOf(dir), '.gitignore'), '*\n');
  const r = withEnv({ TPM_LOCK_WAIT_MS: '300' }, () => captureStderr(() => t.main(['add', '--tasks-dir', dir, '--headline', 'x'])));
  assert.strictEqual(r.v, 1); assert.ok(/owner record is missing or unreadable/.test(r.err) && /by hand/.test(r.err), r.err);
  assert.ok(fs.existsSync(lockOf(dir)), 'left in place');
});

test('E: a fault mid-write (rename fault inside the critical section) throws loud and leaves NO lock; so does an fsync fault', () => {
  const dir = seed(scratch('tpm-lock-e5-'));
  const jsonBefore = fs.readFileSync(bodyPath(dir, '1000'), 'utf8');
  assert.throws(() => withFailingFsAfterLock(() => t.opEdit({ tasksDir: dir, id: '1000', headline: 'NOPE' })), /failed writing/);
  assert.deepStrictEqual(strays(dir), [], 'lock released after the faulted edit');
  assert.throws(() => withFailingFs('fsyncSync', () => t.opCheck({ tasksDir: dir, id: '1000', key: 'A' })), /failed writing/);
  assert.deepStrictEqual(strays(dir), [], 'lock released after the faulted check');
  assert.strictEqual(fs.readFileSync(bodyPath(dir, '1000'), 'utf8'), jsonBefore);
  assert.deepStrictEqual(tmpOrphans(dir), []);
  t.opEdit({ tasksDir: dir, id: '1000', headline: 'now it works' });   // and the store is usable straight away
});

// ── C: read verbs never wait ──────────────────────────────────────────────────────────────────────────────────
test('C: read verbs return at once, correctly, with the lock held by someone else (even with a 60 s wait budget configured)', () => {
  const dir = seed(scratch('tpm-lock-c-'));
  craftLock(dir, { pid: process.pid, verb: 'edit' });
  const before = snapshot(dir);
  const t0 = Date.now();
  withEnv({ TPM_LOCK_WAIT_MS: '60000' }, () => {
    assert.ok(/1001 \| open \|.*second/.test(t.opList({ tasksDir: dir })));
    assert.ok(/# #1000 · seeded/.test(t.opShow({ tasksDir: dir, id: '1000' })));
    assert.ok(/second/.test(t.opShowSelector({ tasksDir: dir, selectorArgv: ['all'] })));
    assert.deepStrictEqual(t.opLabels({ tasksDir: dir }), [{ label: 'x', ids: ['1000'] }]);
    assert.ok(t.opHistory({ tasksDir: dir, id: '1000' }).length >= 1);
    const r = doctor.runDoctor({ tasksDir: dir });
    assert.strictEqual(r.lock.status, 'HELD'); assert.strictEqual(r.exitCode, 0, 'a held lock is not a problem');
  });
  assert.ok(Date.now() - t0 < 5000, 'no read verb waited');
  assert.deepStrictEqual(snapshot(dir), before, 'reads wrote nothing');
});

// ── D: derived files are written atomically ───────────────────────────────────────────────────────────────────
test('D: the derived body .md and the three index views are written through atomicWriteFileSync (tmp -> rename), never a plain writeFileSync', () => {
  const dir = scratch('tpm-lock-d-');
  const plain = []; const renamedTo = [];
  const realW = fs.writeFileSync; const realR = fs.renameSync;
  fs.writeFileSync = function spy(p) { plain.push(String(p)); return realW.apply(this, arguments); };
  fs.renameSync = function spy(a, b) { renamedTo.push(String(b)); return realR.apply(this, arguments); };
  try {
    t.opAdd({ tasksDir: dir, headline: 'atomic' });
    t.opTransition('start', { tasksDir: dir, id: '1000' });
    t.opReindex({ tasksDir: dir });
  } finally { fs.writeFileSync = realW; fs.renameSync = realR; }
  const nonLock = plain.filter((p) => !/\/\.lock(\.[^/]*)?\/(owner\.json|\.gitignore)$/.test(p));
  assert.deepStrictEqual(nonLock, [], 'no plain writeFileSync to any store file; saw ' + JSON.stringify(nonLock));
  const base = (re) => renamedTo.some((p) => re.test(p));
  assert.ok(base(/task-1000\.md$/), 'body .md arrives by rename'); assert.ok(base(/task-index\.md$/));
  assert.ok(base(/finished-tasks-index\.md$/)); assert.ok(base(/removed-tasks-index\.md$/)); assert.ok(base(/tasks-index\.json$/));
  assert.ok(fs.existsSync(bodyMdPath(dir, '1000')));
});

test('D: the migrate writer (staging out-dir) also writes its derived .md and views atomically', () => {
  const migrate = require('../tpm-task-migrate');
  const src = scratch('tpm-lock-mig-in-');
  const bucket = path.join(src, 'bodies', '1000-1999'); fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'task-1000.md'), '# #1000 · a legacy task\n\n- **State:** open\n- **Created:** 2026-01-01\n\n## Summary\n\nold.\n');
  fs.writeFileSync(path.join(src, 'task-index.md'), '# Tasks\n\n**Next ID:** 1001\n');
  const out = path.join(scratch('tpm-lock-mig-out-'), 'staged');
  const plain = [];
  const realW = fs.writeFileSync;
  fs.writeFileSync = function spy(p) { plain.push(String(p)); return realW.apply(this, arguments); };
  try { migrate.runMigration({ inDir: src, outDir: out, emitDerived: true, now: '2026-10-07T12:00:00-07:00' }); } finally { fs.writeFileSync = realW; }
  assert.deepStrictEqual(plain, [], 'migrate wrote no store file with a plain writeFileSync: ' + JSON.stringify(plain));
  assert.ok(fs.existsSync(bodyMdPath(out, '1000')) && fs.existsSync(path.join(out, 'task-index.md')));
});

// ── B2: lastWriter stamp ──────────────────────────────────────────────────────────────────────────────────────
test('B2: every mutating verb stamps lastWriter {version, at} as a TOP-LEVEL key of tasks-index.json, under the lock; nothing else is reshaped', () => {
  const dir = scratch('tpm-lock-b2-');
  t.opAdd({ tasksDir: dir, headline: 'stamp me' });
  let idx = indexJson(dir);
  assert.deepStrictEqual(Object.keys(idx.lastWriter).sort(), ['at', 'version']);
  assert.strictEqual(idx.lastWriter.version, t.TPM_VERSION);
  assert.ok(/[+-]\d\d:\d\d$/.test(idx.lastWriter.at), 'local-offset timestamp: ' + idx.lastWriter.at);
  assert.deepStrictEqual(Object.keys(idx).sort(), ['counts', 'generatedAt', 'kind', 'labels', 'lastWriter', 'nextId', 'schemaVersion', 'startId', 'tasks'], 'only ONE new top-level key; the index shape is not reshaped');
  // each verb re-stamps (tamper the stamp, run the verb, see it replaced)
  const tamper = () => { const i = indexJson(dir); i.lastWriter = { version: '0.0.1', at: '2020-01-01T00:00:00-07:00' }; fs.writeFileSync(path.join(dir, 'tasks-index.json'), JSON.stringify(i, null, 2) + '\n'); };
  const ops = [
    () => t.opEdit({ tasksDir: dir, id: '1000', headline: 'e' }), () => t.opLabel({ tasksDir: dir, id: '1000', labels: ['q'] }), () => t.opUnlabel({ tasksDir: dir, id: '1000', labels: ['q'] }),
    () => t.opAddSubtask({ tasksDir: dir, id: '1000', text: 's' }), () => t.opCheck({ tasksDir: dir, id: '1000', key: 'A' }), () => t.opTransition('start', { tasksDir: dir, id: '1000' }),
    () => t.opImport({ tasksDir: dir, id: '1000', jsonText: '{"summary":"i"}' }), () => t.opReindex({ tasksDir: dir }), () => t.opAdd({ tasksDir: dir, headline: 'another' }),
  ];
  for (const op of ops) { tamper(); op(); assert.strictEqual(indexJson(dir).lastWriter.version, t.TPM_VERSION, 'verb re-stamped: ' + op); }
  // outside a store verb (the model API used directly) no stamp is added, and an existing one is preserved
  tamper();
  model.saveTask(model.loadTask(bodyPath(dir, '1000')), { tasksDir: dir });
  assert.strictEqual(indexJson(dir).lastWriter.version, '0.0.1', 'an unlocked direct model write does not forge a stamp');
});

test('B2: the stamp carries through a read-modify-write of an index an OLD tool wrote (unknown top-level keys preserved both ways)', () => {
  const dir = seed(scratch('tpm-lock-b2b-'));
  const i = indexJson(dir); i.futureKey = { keep: 'me' }; fs.writeFileSync(path.join(dir, 'tasks-index.json'), JSON.stringify(i, null, 2) + '\n');
  t.opEdit({ tasksDir: dir, id: '1001', headline: 'again' });
  assert.deepStrictEqual(indexJson(dir).futureKey, { keep: 'me' });
  assert.strictEqual(indexJson(dir).lastWriter.version, t.TPM_VERSION);
});

// ── B1(b): reindex fails loud ─────────────────────────────────────────────────────────────────────────────────
function newerBody(dir, id) {
  const p = bodyPath(dir, id);
  const rec = JSON.parse(fs.readFileSync(p, 'utf8')); rec.schemaVersion = '9.0.0';
  fs.writeFileSync(p, JSON.stringify(rec, null, 2) + '\n');
  return p;
}
test('B1(b): reindex REFUSES on an unknown-newer body: exit non-zero, lists count + names, writes NOTHING (old row kept)', () => {
  const dir = seed(scratch('tpm-lock-b1-'));
  t.opAdd({ tasksDir: dir, headline: 'third' });                                     // 1002
  newerBody(dir, '1001');
  const before = snapshot(dir);
  let err;
  try { t.opReindex({ tasksDir: dir }); } catch (e) { err = e; }
  assert.ok(err && err.code === 'EREINDEX_UNREADABLE', 'ReindexError thrown, got ' + (err && err.message));
  assert.strictEqual(err.skipped.length, 1); assert.strictEqual(err.skipped[0].id, '1001');
  assert.ok(/1 task body\(ies\) could not be read/.test(err.message) && /#1001 \(bodies\/1000-1999\/task-1001\.json\)/.test(err.message) && /newer schemaVersion/.test(err.message), err.message);
  assert.ok(/--drop-unreadable/.test(err.message), 'names the opt-in');
  assert.deepStrictEqual(snapshot(dir), before, 'index (and every file) unchanged: the old row is kept');
  assert.deepStrictEqual(strays(dir), []);
  assert.ok(indexJson(dir).tasks.some((r) => r.id === '1001'), 'the old row for 1001 is still in the index');
  const cli = captureStderr(() => t.main(['reindex', '--tasks-dir', dir]));
  assert.strictEqual(cli.v, 1, 'CLI exits non-zero'); assert.ok(/REFUSED/.test(cli.err) && /#1001/.test(cli.err), cli.err);
});

test('B1(b): --drop-unreadable is the ONLY way to discard: it drops the row, LISTS it (count + names), keeps the body file and the nextId floor', () => {
  const dir = seed(scratch('tpm-lock-b1d-'));
  newerBody(dir, '1001');
  const cli = captureStderr(() => t.main(['reindex', '--tasks-dir', dir, '--drop-unreadable']));
  assert.strictEqual(cli.v, 0, cli.err);
  assert.ok(/DROPPED 1 unreadable body\(ies\)/.test(cli.err) && /#1001 /.test(cli.err), cli.err);
  const idx = indexJson(dir);
  assert.deepStrictEqual(idx.tasks.map((r) => r.id), ['1000']); assert.strictEqual(idx.nextId, '1002', 'nextId never regresses');
  assert.ok(fs.existsSync(bodyPath(dir, '1001')), 'the unreadable body file is NOT deleted');
});

test('B1(b): a CORRUPT body is also refused (never silently skipped); a clean store reports no skips', () => {
  const dir = seed(scratch('tpm-lock-b1c-'));
  assert.deepStrictEqual(t.opReindex({ tasksDir: dir }).skipped, []);
  fs.writeFileSync(bodyPath(dir, '1001'), '{ not json');
  assert.throws(() => t.opReindex({ tasksDir: dir }), (e) => e.code === 'EREINDEX_UNREADABLE' && /#1001/.test(e.message));
});

test('B1(b): remove --hard keeps an unrelated unreadable body\'s old row (never drops it, never fails half-done) and warns', () => {
  const dir = seed(scratch('tpm-lock-b1h-'));
  t.opAdd({ tasksDir: dir, headline: 'purge me' });                                  // 1002
  newerBody(dir, '1001');
  const cfg = path.join(dir, '..', 'cfg2-' + path.basename(dir) + '.json'); fs.writeFileSync(cfg, JSON.stringify({ tasks: { allowHardDelete: true } }));
  const r = captureStderr(() => t.opHardRemove({ tasksDir: dir, id: '1002', config: cfg }));
  assert.deepStrictEqual(indexJson(dir).tasks.map((x) => x.id), ['1000', '1001'], 'purged row gone, unreadable row kept');
  assert.ok(/warning: kept the old index row for unreadable body #1001/.test(r.err), r.err);
});

// ── reader ENOENT-retry ───────────────────────────────────────────────────────────────────────────────────────
test('retry: a transient ENOENT on a file that exists (the mount\'s rename-over gap) is retried and the read succeeds; list/show/doctor survive it', () => {
  const dir = seed(scratch('tpm-lock-r-'));
  const realRead = fs.readFileSync;
  let fails = 2; let calls = 0;
  fs.readFileSync = function flaky(p) {
    if (/tasks-index\.json$/.test(String(p))) { calls++; if (fails > 0) { fails--; const e = new Error("ENOENT: no such file or directory, open '" + p + "'"); e.code = 'ENOENT'; throw e; } }
    return realRead.apply(this, arguments);
  };
  try { assert.ok(/second/.test(t.opList({ tasksDir: dir }))); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(calls, 3, 'two transient misses + the successful read');
  // task body read path and the derived-md read path
  fails = 1; let mdCalls = 0;
  fs.readFileSync = function flaky2(p) {
    if (/task-1000\.json$/.test(String(p)) && fails > 0) { fails--; const e = new Error("ENOENT: x '" + p + "'"); e.code = 'ENOENT'; throw e; }
    if (/task-1000\.md$/.test(String(p))) { mdCalls++; if (mdCalls === 1) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } }
    return realRead.apply(this, arguments);
  };
  try { assert.ok(/# #1000/.test(t.opShow({ tasksDir: dir, id: '1000' }))); assert.strictEqual(doctor.runDoctor({ tasksDir: dir }).summary.drift, 0); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(mdCalls, 2, 'the derived .md read was retried once');
});

test('retry: bounded (3 retries) and loud for a stranded name; a genuinely missing file fails at once with no retry', () => {
  const dir = seed(scratch('tpm-lock-r2-'));
  const realRead = fs.readFileSync; let calls = 0;
  fs.readFileSync = function stranded(p) {
    if (/tasks-index\.json$/.test(String(p))) { calls++; const e = new Error("ENOENT: no such file or directory, open '" + p + "'"); e.code = 'ENOENT'; throw e; }
    return realRead.apply(this, arguments);
  };
  try { assert.throws(() => t.opList({ tasksDir: dir }), /cannot read canonical file .*tasks-index\.json.*ENOENT/); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(calls, 4, '1 try + 3 bounded retries, then the loud error');
  const t0 = Date.now(); calls = 0;
  fs.readFileSync = function counting(p) { if (/task-4242\.json$/.test(String(p))) calls++; return realRead.apply(this, arguments); };
  try { assert.throws(() => t.opShow({ tasksDir: dir, id: '4242' }), /cannot read canonical file/); } finally { fs.readFileSync = realRead; }
  assert.strictEqual(calls, 1, 'a missing task is not retried'); assert.ok(Date.now() - t0 < 500);
});

// ── F: the doctor reports lock and id health ──────────────────────────────────────────────────────────────────
test('F: doctor reports a present-but-STALE lock (a problem, exit 1, report-only) and names the holder and the reason', () => {
  const dir = seed(scratch('tpm-lock-f1-'));
  craftLock(dir, { host: 'old-laptop.example', pid: 4242, at: pad(nowIsoTz(), -120000), verb: 'edit' });
  const before = snapshot(dir);
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.lock.status, 'STALE'); assert.strictEqual(r.exitCode, 1); assert.strictEqual(r.summary.lock, 'STALE');
  const txt = doctor.renderHuman(r);
  assert.ok(/Lock: STALE \(held for 1\d\d s \(stale after 30 s\)\) — held by pid 4242 on old-laptop\.example, verb edit/.test(txt), txt);
  assert.deepStrictEqual(snapshot(dir), before, 'report-only: the doctor did not break or touch the lock');
  assert.ok(fs.existsSync(lockOf(dir)));
});

test('F: doctor: an INCOMPLETE lock and an UNIGNORED lock are problems; a HELD fresh lock is not; leftovers are listed', () => {
  const a = seed(scratch('tpm-lock-f2a-'));
  fs.mkdirSync(lockOf(a)); fs.writeFileSync(path.join(lockOf(a), '.gitignore'), '*\n');
  const ra = doctor.runDoctor({ tasksDir: a });
  assert.strictEqual(ra.lock.status, 'INCOMPLETE'); assert.strictEqual(ra.exitCode, 1);
  assert.ok(/INCOMPLETE .*cannot be judged stale[\s\S]*by hand/.test(doctor.renderHuman(ra)));
  const b = seed(scratch('tpm-lock-f2b-'));
  craftLock(b, { pid: process.pid }); fs.unlinkSync(path.join(lockOf(b), '.gitignore'));
  const rb = doctor.runDoctor({ tasksDir: b });
  assert.strictEqual(rb.lock.status, 'UNIGNORED'); assert.strictEqual(rb.exitCode, 1);
  assert.ok(/UNIGNORED .*could be committed/.test(doctor.renderHuman(rb)));
  const c = seed(scratch('tpm-lock-f2c-'));
  craftLock(c, { pid: process.pid });
  const rc = doctor.runDoctor({ tasksDir: c });
  assert.strictEqual(rc.lock.status, 'HELD'); assert.strictEqual(rc.exitCode, 0); assert.ok(/Lock: HELD/.test(doctor.renderHuman(rc)));
  const d = seed(scratch('tpm-lock-f2d-'));
  fs.mkdirSync(path.join(d, '.lock.broken.123.456')); fs.writeFileSync(path.join(d, '.lock.broken.123.456', '.gitignore'), '*\n');
  fs.mkdirSync(path.join(d, '.lock.new.1.ab')); // no .gitignore: committable
  const rd = doctor.runDoctor({ tasksDir: d });
  assert.deepStrictEqual(rd.lock.leftovers, ['.lock.broken.123.456', '.lock.new.1.ab']);
  assert.deepStrictEqual(rd.lock.leftoversUnignored, ['.lock.new.1.ab']); assert.strictEqual(rd.exitCode, 1);
  assert.ok(/Lock leftovers \(2\)/.test(doctor.renderHuman(rd)) && /no \.gitignore in \.lock\.new\.1\.ab/.test(doctor.renderHuman(rd)));
});

test('F: doctor reports duplicate ids (two bodies sharing an id), a filename/id mismatch, a duplicate index row, a regressed nextId, unindexed bodies and orphan rows; all report-only', () => {
  // two bodies sharing one id: a copy of task-1000 sitting in another bucket directory
  const a = seed(scratch('tpm-lock-f3a-'));
  const other = path.join(a, 'bodies', '2000-2999'); fs.mkdirSync(other, { recursive: true });
  fs.copyFileSync(bodyPath(a, '1000'), path.join(other, 'task-1000.json'));
  const ra = doctor.runDoctor({ tasksDir: a });
  const dup = ra.ids.problems.find((p) => p.kind === 'DUPLICATE');
  assert.ok(dup && dup.id === '1000' && dup.files.length === 2, JSON.stringify(ra.ids));
  assert.strictEqual(ra.exitCode, 1); assert.ok(/DUPLICATE: 2 bodies share id 1000: .*task-1000\.json, .*task-1000\.json/.test(doctor.renderHuman(ra)));
  // in-file id differs from the filename
  const b = seed(scratch('tpm-lock-f3b-'));
  fs.copyFileSync(bodyPath(b, '1001'), path.join(path.dirname(bodyPath(b, '1001')), 'task-1005.json'));
  assert.ok(doctor.runDoctor({ tasksDir: b }).ids.problems.some((p) => p.kind === 'FILENAME-MISMATCH'));
  // two rows with one id, regressed counter, unindexed body, orphan row
  const c = seed(scratch('tpm-lock-f3c-'));
  const i = indexJson(c);
  i.tasks.push(Object.assign({}, i.tasks[0])); i.nextId = '1001';
  fs.writeFileSync(path.join(c, 'tasks-index.json'), JSON.stringify(i, null, 2) + '\n');
  const kinds = doctor.runDoctor({ tasksDir: c }).ids.problems.map((p) => p.kind).sort();
  assert.deepStrictEqual(kinds, ['DUP-ROW', 'NEXTID-REGRESSED']);
  const d = seed(scratch('tpm-lock-f3d-'));
  const j = indexJson(d); j.tasks = j.tasks.filter((r) => r.id !== '1001'); j.tasks.push({ id: '1999', state: 'open', headline: 'ghost', labels: [], path: 'bodies/1000-1999/task-1999.json' });
  fs.writeFileSync(path.join(d, 'tasks-index.json'), JSON.stringify(j, null, 2) + '\n');
  const kd = doctor.runDoctor({ tasksDir: d }).ids.problems.map((p) => p.kind).sort();
  assert.deepStrictEqual(kd, ['ORPHAN-ROW', 'UNINDEXED']);
  const before = snapshot(d); doctor.runDoctor({ tasksDir: d }); assert.deepStrictEqual(snapshot(d), before, 'report-only');
});

test('F: a healthy store (made by the verbs) prints NOTHING new: no lock, id or last-writer lines; exit 0', () => {
  const dir = seed(scratch('tpm-lock-f4-'));
  const r = doctor.runDoctor({ tasksDir: dir });
  assert.strictEqual(r.exitCode, 0); assert.strictEqual(r.lock.status, 'NONE'); assert.strictEqual(r.ids.status, 'OK'); assert.strictEqual(r.writer.status, 'OK');
  const txt = doctor.renderHuman(r);
  assert.ok(!/^(Lock|Id health|Last writer)/m.test(txt) && !/leftover/i.test(txt), 'no new lines on a healthy store:\n' + txt);
  assert.ok(/Clean — no problems found/.test(txt));
  // and a lock-held-by-me-now store still shows only the single HELD line
});

test('B2/F: doctor FLAGS a store last written by an UNSTAMPED or OLDER tpm (advisory: exit unchanged), silent for same/newer', () => {
  const dir = seed(scratch('tpm-lock-f5-'));
  const set = (lw) => { const i = indexJson(dir); if (lw === undefined) delete i.lastWriter; else i.lastWriter = lw; fs.writeFileSync(path.join(dir, 'tasks-index.json'), JSON.stringify(i, null, 2) + '\n'); };
  set(undefined);
  let r = doctor.runDoctor({ tasksDir: dir, runningVersion: '0.2.0-dev' });
  assert.strictEqual(r.writer.status, 'UNSTAMPED'); assert.strictEqual(r.exitCode, 0, 'advisory only');
  assert.ok(/Last writer: UNSTAMPED/.test(doctor.renderHuman(r)));
  set({ version: '0.1.0', at: '2026-01-01T00:00:00-07:00' });
  r = doctor.runDoctor({ tasksDir: dir, runningVersion: '0.2.0-dev' });
  assert.strictEqual(r.writer.status, 'OLDER'); assert.strictEqual(r.exitCode, 0);
  assert.ok(/Last writer: OLDER — this store was last written by tpm 0\.1\.0 \(at 2026-01-01T00:00:00-07:00\), older than this tpm 0\.2\.0-dev/.test(doctor.renderHuman(r)));
  set({ version: '0.2.0-dev', at: nowIsoTz() });
  assert.strictEqual(doctor.runDoctor({ tasksDir: dir, runningVersion: '0.2.0-dev' }).writer.status, 'OK');
  set({ version: '0.3.1', at: nowIsoTz() });
  const rn = doctor.runDoctor({ tasksDir: dir, runningVersion: '0.2.0-dev' });
  assert.strictEqual(rn.writer.status, 'OK'); assert.ok(!/Last writer/.test(doctor.renderHuman(rn)));
  set({ version: '0.1.9', at: nowIsoTz() });
  assert.strictEqual(doctor.runDoctor({ tasksDir: dir, runningVersion: '0.2.0' }).writer.status, 'OLDER');
  assert.deepStrictEqual(Object.keys(doctor.runDoctor({ tasksDir: dir }).summary).sort(), ['bodies', 'drift', 'idProblems', 'invalid', 'labelIndex', 'lock', 'oldFormat', 'unstamped', 'valid', 'writer']);
});

test('F: the doctor CLI (--json) carries lock/ids/writer and the human run exits 1 for a stale lock', () => {
  const dir = seed(scratch('tpm-lock-f6-'));
  craftLock(dir, { host: 'old-laptop.example', pid: 4242, at: pad(nowIsoTz(), -120000) });
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tpm-task-doctor.js'), '--tasks-dir', dir, '--json'], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.strictEqual(r.status, 1, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.strictEqual(j.lock.status, 'STALE'); assert.ok(j.ids && j.writer);
});

done('task-lock.test.js');
