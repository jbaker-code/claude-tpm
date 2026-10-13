'use strict';
/**
 * old-format-guard.test.js — #1114.B rollout guard: `tpm task` verbs REFUSE on an un-migrated
 * 0.1.0 markdown store, instead of silently seeding a fresh JSON store that resets ids and
 * overwrites the old tasks (the incident this guards against).
 *
 * Zero-dep, Node built-ins only; a tiny inline harness (exit NON-ZERO on any failure, per the
 * tool-conventions ship-tool bar). Every store is built in an os.tmpdir scratch — NEVER the live
 * store. Run: node tests/old-format-guard.test.js
 *
 * Covers (DoD):
 *  - POSITIVE: a clean old markdown store (bodies/<bucket>/task-<id>.md, no JSON, no index) is
 *    detected and `assertNotOldFormatStore` THROWS a migrate-pointing error; `main add` exits 1 and
 *    writes NOTHING (mutation-proven: the dir is byte-identical before/after).
 *  - READ verbs guard too: `main list` on the same old store exits 1 (no deceptive empty view).
 *  - NEGATIVE — already-migrated: a real JSON store (built via the model) is NOT blocked; add runs.
 *  - NEGATIVE — fresh empty store: an empty dir is NOT an old store; add mints the first task.
 *  - null/absent tasksDir is a no-op (the guard never throws on a missing dir).
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');

const model = require('../lib/task-model');
const converter = require('../lib/task-converter');
const task = require('../tpm-task');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   - ' + name);
  } catch (e) {
    failed++;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e);
    console.log('  FAIL - ' + name + '\n         ' + detail);
  }
}

function done(suite) {
  console.log(`\n${suite}: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'tpm-guard-')); }

/** A CLEAN old markdown store (bodies/<bucket>/task-<id>.md, no JSON, no tasks-index.json). */
function oldFormatStore() {
  const dir = scratch('tpm-guard-old-');
  const bucket = path.join(dir, 'bodies', '1000-1999');
  fs.mkdirSync(bucket, { recursive: true });
  fs.writeFileSync(path.join(bucket, 'task-1000.md'),
    '# #1000 · a legacy task\n\n- **State:** open\n- **Created:** 2026-01-01\n\n## Summary\n\nold.\n');
  fs.writeFileSync(path.join(bucket, 'task-1001.md'),
    '# #1001 · another legacy task\n\n- **State:** open\n- **Created:** 2026-01-02\n');
  fs.writeFileSync(path.join(dir, 'task-index.md'), '# Tasks\n\n**Next ID:** 1002\n');
  return dir;
}

/** A well-formed NEW-format JSON store via the real model (atomic JSON + derived .md + index). */
function migratedStore() {
  const dir = scratch('tpm-guard-new-');
  const rec = model.openTask({ headline: 'already migrated', tasksDir: dir });
  model.saveTask(rec, { tasksDir: dir, render: converter.render, indexRender: converter.renderIndexView });
  return dir;
}

/** Recursive {relpath -> size} snapshot, to prove a refused run wrote nothing. */
function snapshot(dir) {
  const out = {};
  (function walk(d) {
    for (const fn of fs.readdirSync(d).sort()) {
      const p = path.join(d, fn);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = st.size;
    }
  })(dir);
  return out;
}

// ── POSITIVE: the guard fires on a clean old store ────────────────────────────────

test('assertNotOldFormatStore THROWS on a clean old markdown store (names migrate + body count)', () => {
  const dir = oldFormatStore();
  assert.throws(
    () => task.assertNotOldFormatStore(dir),
    (e) => /NOT been migrated/.test(e.message) && /tpm task migrate/.test(e.message) && /2 task bodies/.test(e.message),
    'should throw a migrate-pointing error naming the 2 bodies',
  );
});

test('`add` on an old store EXITS 1 and writes NOTHING (mutation-proven)', () => {
  const dir = oldFormatStore();
  const before = snapshot(dir);
  const code = task.main(['add', '--tasks-dir', dir, '--headline', 'should never be written']);
  assert.strictEqual(code, 1, 'add must refuse with exit 1 on an un-migrated store');
  assert.deepStrictEqual(snapshot(dir), before, 'the old store must be byte-identical — no JSON seeded');
  assert.ok(!fs.existsSync(path.join(dir, 'tasks-index.json')), 'no tasks-index.json was created');
});

test('read verb `list` on an old store ALSO exits 1 (no deceptive empty view)', () => {
  const dir = oldFormatStore();
  const code = task.main(['list', '--tasks-dir', dir]);
  assert.strictEqual(code, 1, 'list must refuse rather than show an empty JSON store');
});

// ── NEGATIVE: the guard is inert on a migrated / fresh store ───────────────────────

test('already-migrated JSON store is NOT blocked — assert is a no-op and `add` runs', () => {
  const dir = migratedStore();
  assert.doesNotThrow(() => task.assertNotOldFormatStore(dir), 'a migrated store must pass the guard');
  const code = task.main(['add', '--tasks-dir', dir, '--headline', 'a new task on a migrated store']);
  assert.strictEqual(code, 0, 'add must succeed on a migrated store');
});

test('fresh EMPTY store is NOT an old store — `add` mints the first task', () => {
  const dir = scratch('tpm-guard-empty-');
  assert.doesNotThrow(() => task.assertNotOldFormatStore(dir), 'an empty dir is not an old store');
  const code = task.main(['add', '--tasks-dir', dir, '--headline', 'first task ever']);
  assert.strictEqual(code, 0, 'add must succeed on a fresh empty store');
  assert.ok(fs.existsSync(path.join(dir, 'tasks-index.json')), 'a JSON store was seeded on the fresh dir');
});

test('null / missing tasksDir is a no-op (never throws)', () => {
  assert.doesNotThrow(() => task.assertNotOldFormatStore(undefined));
  assert.doesNotThrow(() => task.assertNotOldFormatStore(''));
});

done('old-format-guard');
