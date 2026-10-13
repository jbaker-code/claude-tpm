'use strict';
/**
 * base-load.test.js (F1) — the CI gate for the ONE cross-sandbox indirection `lib/base.js`.
 *
 * Before P08 base.js had only a run-as-main self-check (no suite), so a future regression that
 * dropped a re-exported base module would go UNCAUGHT. This suite asserts base.js re-exports ALL
 * the kind-agnostic base modules AND that each carries the shared export the task tooling composes,
 * so a missing/renamed module (e.g. the `session-hash → hash` rename regressing) fails the build.
 *
 * Node built-ins only; zero deps. Run: node tests/base-load.test.js  (also via run-all).
 */
const { assert, test, done } = require('./helpers/task-e2e-helpers');

const base = require('../lib/base');

// The 10 base modules the phase-02 seam promises (01-plan §3 / §5, 02 HANDOFF) + lock/identity (multi-session phase 04) + attribution (phase 17).
const EXPECTED_MODULES = [
  'io', 'envelope', 'version', 'validate', 'update',
  'normalize', 'timestamp', 'exportScaffold', 'hash', 'paths',
  'lock', 'identity', 'attribution',   // multi-session support (phase 04): the shared directory lock + identity reader
];

// A representative export per module — the exact one the task lib composes — so a module that loads
// to the WRONG thing (empty stub / partial) is caught, not just an absent key.
const EXPECTED_EXPORTS = {
  io: ['atomicWriteFileSync', 'readCanonicalSync'],
  envelope: ['readEnvelope', 'writeEnvelope', 'KNOWN_KINDS'],
  version: ['migrate', 'CURRENT'],
  validate: ['validateEnvelope'],
  update: ['applyUpdate'],
  normalize: ['normalizeArray'],
  timestamp: ['nowIsoTz'],
  exportScaffold: ['selectRecords'],
  hash: ['hashRecord'],
  paths: ['findRoot'],
  lock: ['withLock', 'acquire', 'inspect', 'isStale', 'LockError'],
  identity: ['readIdentity', 'isProcessAlive'],
  attribution: ['resolveAttribution', 'parseSessionRef'],
};

test('base.js re-exports EXACTLY the 13 expected base modules (no more, no fewer)', () => {
  const keys = Object.keys(base).sort();
  assert.deepStrictEqual(keys, EXPECTED_MODULES.slice().sort(),
    'base.js must re-export exactly the 13 base modules');
});

test('every re-exported base module loaded to a live object (not a null/stub)', () => {
  for (const name of EXPECTED_MODULES) {
    assert.ok(name in base, `base.${name} missing`);
    assert.ok(base[name] != null && typeof base[name] === 'object',
      `base.${name} must load to an object (got ${base[name] === null ? 'null' : typeof base[name]})`);
  }
});

test('each base module carries the shared export the task tooling composes', () => {
  for (const [name, fns] of Object.entries(EXPECTED_EXPORTS)) {
    for (const fn of fns) {
      assert.ok(fn in base[name], `base.${name}.${fn} must be present (base.js seam / rename regression guard)`);
    }
    // the function-shaped exports really are callable functions
    for (const fn of fns) {
      const v = base[name][fn];
      const mustBeFn = fn !== 'KNOWN_KINDS' && fn !== 'CURRENT';
      if (mustBeFn) assert.strictEqual(typeof v, 'function', `base.${name}.${fn} must be a function`);
    }
  }
});

test('the shared base lib is genuinely wired (hash + paths work through the seam)', () => {
  // hash: deterministic 12-hex over a canonicalised record (order-independent).
  const h1 = base.hash.hashRecord({ z: 1, a: 2 });
  const h2 = base.hash.hashRecord({ a: 2, z: 1 });
  assert.ok(/^[0-9a-f]{12}$/.test(h1), 'hashRecord returns a 12-hex digest');
  assert.strictEqual(h1, h2, 'hashRecord is canonical (key order independent)');
  // paths: findRoot walks up to the project marker without throwing.
  const root = base.paths.findRoot({ startDir: __dirname, marker: '.claude/claude-tpm' });
  assert.strictEqual(typeof root, 'string', 'findRoot returns the project root path');
  assert.ok(root.length > 0, 'findRoot resolved a non-empty root');
});

done('base-load.test.js');
