'use strict';
/**
 * base.js — the ONE indirection to the shared base lib (OQ5: reference-in-place).
 *
 * ── THE SINGLE SHARED-LIB PATH ──
 * PROMOTED (Stage A / #1123): the base lib is now the ONE physical copy at this bundle's
 * `tools/lib/`. task-tooling reaches it through THIS file — the only place the shared-lib path is
 * spelled. The session and task suites share one copy so they cannot diverge (#1121). This is the
 * one file a future relayout rewrites (as its own docstring foretold at promotion).
 *
 * ── WHAT IS RE-EXPORTED ── the 9 kind-agnostic base modules + the shared `paths` (#1058):
 *   io · envelope · version · validate · update · normalize · timestamp · exportScaffold ·
 *   hash (renamed from session-hash, §5 R-a) · paths (new shared, §5 R-b) · lock · identity (multi-session).
 * The three kind-SPECIFIC modules (task-schema / task-model / task-converter) are NOT here —
 * they live under task-tooling/lib/ and are built by phases 03–05.
 *
 * Runs as plain `node <file>` with zero deps, so a computed `require(BASE + '/<name>')` is fine
 * (no bundler; §3 blesses this over a static-analyzable literal).
 *
 * EXAMPLE
 *   const base = require('./base');
 *   const { readEnvelope } = base.envelope;
 *   const { hashRecord }   = base.hash;
 *   const root = base.paths.findRoot({ startDir: __dirname, marker: '.claude/claude-tpm' });
 */

const path = require('path');

// The ONE indirection to the blessed shared base lib (#1121). PROMOTED (Stage A / #1123): the base
// lib now lives at the 0.2.0 tree's tools/lib/ as the single physical copy. From tools/task/lib/ walk
// up two (lib → task → tools) then into the sibling tools/lib/. This is the one file the promotion
// rewrites (as its own docstring foretold); every task consumer keeps requiring it unchanged.
const BASE = path.join(__dirname, '..', '..', 'lib');

// Basename → export key. Basenames are the on-disk filenames (export-scaffold, hash, paths).
const MODULES = {
  io:             'io',
  envelope:       'envelope',
  version:        'version',
  validate:       'validate',
  update:         'update',
  normalize:      'normalize',
  timestamp:      'timestamp',
  exportScaffold: 'export-scaffold',
  hash:           'hash',        // ← renamed from session-hash (§5 R-a)
  paths:          'paths',       // ← new shared paths module (§5 R-b)
  lock:           'lock',        // ← the shared directory lock (multi-session support; callers use it through the namespace)
  identity:       'identity',    // ← the Claude session/pid identity reader (lock.js's sibling)
  attribution:    'attribution', // ← the shared session-attribution resolver (task history; workflow stamps later)
};

const exported = {};
for (const [key, basename] of Object.entries(MODULES)) {
  exported[key] = require(path.join(BASE, basename));
}

module.exports = exported;

// `node lib/base.js` → a self-check that every base module loaded (loadable/inspectable per convention).
if (require.main === module) {
  const keys = Object.keys(exported);
  for (const k of keys) {
    if (exported[k] == null || typeof exported[k] !== 'object') {
      console.error(`base.js: module '${k}' did not load to an object`);
      process.exit(1);
    }
  }
  console.log(`base.js OK — ${keys.length} base modules re-exported: ${keys.join(', ')}`);
}
