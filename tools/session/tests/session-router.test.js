'use strict';
/**
 * session-router.test.js — pins the FLATTEN of the `tpm session` router (round-05 session-CLI cleanup).
 *
 * The `ops` GROUPING was removed; its sub-verbs (open/save/note/punchlist/close/import-*) are now
 * TOP-LEVEL session verbs. The router dispatches each to tpm-session-ops.js with the sub-verb
 * re-injected as argv[0] (mirror of how `review` injects `--style human`). Clean break: the old
 * `ops` grouping token no longer works — the unknown-verb path HINTS at the flattened form.
 *
 * Covers:
 *   - the promoted verbs dispatch to the ops tool END-TO-END (functional, via the CLI);
 *   - a bare `ops` token is an unknown verb (exit 2) whose hint names the removed grouping;
 *   - `--help` lists the promoted verbs;
 *   - the VERBS table no longer carries `ops`, and OPS_VERBS holds the eight promoted verbs.
 *
 * Zero-dep, Node built-ins only; auto-discovered by run-all (ends in .test.js).
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');

const ROUTER = path.join(__dirname, '..', 'tpm-session-router.js');
const router = require('../tpm-session-router');
const run = (args) => spawnSync('node', [ROUTER, ...args], { encoding: 'utf8' });

// ── structural: the verb table was flattened ────────────────────────────────────────
test('VERBS no longer has `ops`; the ops sub-verbs (incl. unseal) are promoted to top-level', () => {
  assert.ok(!('ops' in router.VERBS), 'the `ops` grouping verb is gone from the table');
  for (const v of ['open', 'save', 'note', 'punchlist', 'close', 'unseal', 'import-handoff', 'import-log', 'import-punchlist']) {
    assert.strictEqual(router.VERBS[v], 'tpm-session-ops.js', `${v} maps to the ops tool`);
    assert.ok(router.OPS_VERBS.has(v), `${v} is in OPS_VERBS (gets its verb re-injected)`);
  }
  assert.strictEqual(router.OPS_VERBS.size, 9, 'exactly nine promoted ops sub-verbs (eight + unseal)');
});

// ── functional: a promoted verb dispatches to the ops tool end-to-end ────────────────
test('`session open …` (promoted) runs the ops tool and writes the session', () => {
  const dir = tmpDir('router-open-');
  const r = run(['open', '--sessions-dir', dir, '--session', '1', '--session-id', 'x']);
  assert.strictEqual(r.status, 0, 'promoted open exits 0: ' + r.stderr);
  assert.ok(fs.existsSync(path.join(dir, 'session-0001', 'session-0001.json')), 'the ops tool actually ran');
  assert.ok(/session 0001 opened/.test(r.stderr), 'ops transition line surfaced through the router');
});

test('`session close …` (promoted) reaches the ops close-guard', () => {
  const dir = tmpDir('router-close-');
  assert.strictEqual(run(['open', '--sessions-dir', dir, '--session', '2', '--session-id', 'x']).status, 0);
  const r = run(['close', '--sessions-dir', dir, '--session', '2']);   // no handoff/punchlist → guard refuses
  assert.strictEqual(r.status, 1, 'the close-guard refusal propagates through the router');
  assert.ok(/refusing to close/.test(r.stderr), 'the guard message came through: ' + r.stderr);
});

// ── clean break: the removed `ops` grouping token is an unknown verb with a helpful hint ──
test('a bare `ops` token is an unknown verb (exit 2) and HINTS at the removed grouping', () => {
  const r = run(['ops', 'open', '--session', '1']);
  assert.strictEqual(r.status, 2, 'unknown verb exits 2');
  assert.ok(/unknown verb 'ops'/.test(r.stderr), 'names ops as unknown: ' + r.stderr);
  assert.ok(/'ops' grouping was removed/.test(r.stderr), 'hint names the removed grouping');
  assert.ok(/session <verb>/.test(r.stderr) || /session open/.test(r.stderr), 'hint points at the flattened form');
});

// ── --help lists the promoted verbs ──────────────────────────────────────────────────
test('`session --help` lists the promoted write verbs', () => {
  const r = run(['--help']);
  assert.strictEqual(r.status, 0);
  for (const v of ['open', 'save', 'note', 'punchlist', 'close', 'import-handoff', 'import-log', 'import-punchlist']) {
    assert.ok(r.stdout.includes(v), `--help mentions ${v}`);
  }
});

done('session-router.test.js');
