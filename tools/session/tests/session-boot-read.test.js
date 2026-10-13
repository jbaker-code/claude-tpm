'use strict';
/**
 * session-boot-read.test.js — the REWORKED boot pickup emitter (#1123 Stage C gap-fix).
 *
 * The old boot-read parsed the retired 3-file `.md` layout; this reworked one reads the canonical
 * `session-NNNN.json` via the session model. This suite pins the reworked contract against REAL
 * sessions built on disk with the model + converter:
 *   - emits the prior session's handoff (where/next/in_flight/must_not_redo) + OPEN punchlist
 *     headlines (done/dropped items excluded) + the JSON/.md file locations;
 *   - selects the HIGHEST prior session and EXCLUDES the current (open pointer) one;
 *   - ALWAYS exits 0 — no prior / empty dir / corrupt-JSON / unknown-newer never crash boot.
 *
 * Zero deps; hermetic (fresh OS-tmp sandbox per case). Exits non-zero on any failure.
 *
 * Run: node tests/session-boot-read.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const { spawnSync } = require('child_process');

const model = require('../lib/session-model');
const { render } = require('../lib/session-converter');
const br = require('../tpm-session-boot-read');
const TOOL = path.join(__dirname, '..', 'tpm-session-boot-read.js');

function runCli(args, extraEnv) {
  // Ambient identity is stripped so the run is hermetic; extraEnv plays a specific Claude instance.
  const env = Object.assign({}, process.env, extraEnv || {});
  if (!extraEnv) { delete env.CLAUDE_CODE_SESSION_ID; delete env.CLAUDE_PID; }
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const NOW = '2026-09-21T10:00:00-07:00';

// Build a REAL session on disk at <sessionsDir>/session-NNNN/session-NNNN.{json,md} with the model.
function buildSession(sessionsDir, number, spec) {
  const s = spec || {};
  let rec = model.openSession({ number, sessionId: `sid-${number}`, tpmVersion: '0.2.0' });
  if (s.sealed !== false) rec = model.closeSession(rec);   // a real PRIOR session is sealed (default)
  if (s.handoff) rec = model.importHandoff(rec, s.handoff);
  for (const item of s.open || []) rec = model.addPunchlist(rec, item);
  for (const item of s.closed || []) {
    rec = model.addPunchlist(rec, item);
    rec = model.closePunchlistItem(rec, item.slug);
  }
  const folder = path.join(sessionsDir, `session-${number}`);
  fs.mkdirSync(folder, { recursive: true });
  const jsonPath = path.join(folder, `session-${number}.json`);
  const mdPath = path.join(folder, `session-${number}.md`);
  model.saveSession(rec, { jsonPath, mdPath, render: (r) => render(r, { now: NOW }) });
  return { jsonPath, mdPath, folder };
}

// ── happy path ────────────────────────────────────────────────────────────────

test('emits the prior handoff + OPEN punchlist headline, excludes the closed item, exit 0', () => {
  const dir = tmpDir('br-happy-');
  buildSession(dir, '0001', {
    handoff: { where: 'mid-flight', next: 'run suites', in_flight: ['boot-read'], must_not_redo: ['no rm'] },
    open: [{ text: 'close the gaps', slug: 'gapAAA' }],
    closed: [{ text: 'already done', slug: 'doneBB' }],
  });
  const r = runCli(['--sessions-dir', dir]);
  assert.strictEqual(r.code, 0);
  assert.ok(/PRIOR SESSION 0001/.test(r.stdout), 'names the prior session');
  assert.ok(/Where we are:/.test(r.stdout) && /mid-flight/.test(r.stdout), 'emits handoff.where');
  assert.ok(/run suites/.test(r.stdout), 'emits handoff.next');
  assert.ok(/no rm/.test(r.stdout), 'emits must_not_redo');
  assert.ok(/OPEN PUNCHLIST \(1\)/.test(r.stdout), 'exactly one OPEN item counted');
  assert.ok(/close the gaps/.test(r.stdout) && /gapAAA/.test(r.stdout), 'open headline present');
  assert.ok(!/already done/.test(r.stdout), 'the CLOSED item is NOT emitted');
  assert.ok(/or run: tpm session export --sessions-dir /.test(r.stdout), 'pickup hint uses bare `tpm`');
  assert.ok(!/npx tpm/.test(r.stdout), 'no `npx tpm` in boot-read output');
});

// ── selection: highest prior, exclude current ───────────────────────────────────

test('picks the HIGHEST prior and EXCLUDES the current (open-pointer) session', () => {
  const dir = tmpDir('br-select-');
  buildSession(dir, '0001', { handoff: { where: 'oldest', next: 'x' } });
  buildSession(dir, '0002', { handoff: { where: 'middle here', next: 'y' } });
  // 0003 is the CURRENT session: an UNSEALED track owned by the caller's Claude session id (Q7: the
  // exclusion comes from the tracks + the caller's id, no longer from the hint file).
  buildSession(dir, '0003', { handoff: { where: 'current-open', next: 'z' }, sealed: false });
  const r = runCli(['--sessions-dir', dir], { CLAUDE_CODE_SESSION_ID: 'sid-0003' });
  assert.strictEqual(r.code, 0);
  assert.ok(/PRIOR SESSION 0002/.test(r.stdout), 'emits 0002 (highest that is not the current open one)');
  assert.ok(/middle here/.test(r.stdout));
  assert.ok(!/current-open/.test(r.stdout), 'the current open session is excluded');
});

// ── never crash boot (exit 0 in every degraded case) ────────────────────────────

test('empty sessions dir → clean "first session" message, exit 0', () => {
  const r = runCli(['--sessions-dir', tmpDir('br-empty-')]);
  assert.strictEqual(r.code, 0);
  assert.ok(/no prior session found/.test(r.stdout));
});

test('a corrupt prior JSON is SKIPPED, never crashes — exit 0', () => {
  const dir = tmpDir('br-corrupt-');
  const folder = path.join(dir, 'session-0005');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'session-0005.json'), 'not json{');
  const r = runCli(['--sessions-dir', dir]);
  assert.strictEqual(r.code, 0, 'a corrupt prior must never crash boot');
  assert.ok(/no prior session found/.test(r.stdout), 'the corrupt folder is skipped');
  // Reader honesty (DoD H): the skipped record is LISTED and the output never claims "first session".
  assert.ok(/1 record\(s\) could not be read and were skipped: 0005 \(corrupt\)/.test(r.stdout), r.stdout);
  assert.ok(!/looks like the first session/.test(r.stdout), 'must NOT say "this looks like the first session" over a skipped record');
});

test('a corrupt HIGHER prior is skipped but a VALID lower one is still emitted, exit 0', () => {
  const dir = tmpDir('br-mixed-');
  buildSession(dir, '0001', { handoff: { where: 'valid lower', next: 'x' } });
  const bad = path.join(dir, 'session-0009');
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, 'session-0009.json'), '{ broken');
  const r = runCli(['--sessions-dir', dir]);
  assert.strictEqual(r.code, 0);
  assert.ok(/PRIOR SESSION 0001/.test(r.stdout) && /valid lower/.test(r.stdout), 'falls through to the valid lower session');
  assert.ok(/note: 1 newer record\(s\) were skipped \(unreadable\): 0009 \(corrupt\)/.test(r.stdout), 'the skipped record is listed');
});

test('--help exits 0', () => {
  const r = runCli(['--help']);
  assert.strictEqual(r.code, 0);
  assert.ok(/Exits 0 for any VALID invocation/.test(r.stdout));
});

// ── module API ──────────────────────────────────────────────────────────────────

test('findPrior returns the highest loadable prior record, or null when none load', () => {
  const dir = tmpDir('br-api-');
  buildSession(dir, '0001', { handoff: { where: 'w', next: 'n' } });
  const found = br.findPrior(dir, null);
  assert.ok(found.prior && found.prior.number === '0001');
  assert.strictEqual(found.prior.record.handoff.where, 'w');
  assert.deepStrictEqual(found.skipped, []);
  const none = br.findPrior(tmpDir('br-api-empty-'), null);
  assert.strictEqual(none.prior, null);
  assert.deepStrictEqual(none.skipped, []);
});

done('session-boot-read.test');
