#!/usr/bin/env node
'use strict';
/**
 * tpm-attribution-lockin.test.js — locks in session attribution (multi-session support, phase 19, DoD A).
 *
 * A cross-suite regression net over what phases 17/18 shipped, written independently of the builders' own tests:
 *   R   the shared resolver (tools/lib/attribution.js): flag > TPM_SESSION_ID > lookup > blank; every degraded
 *       input falls through to blank and never throws / never prints; a second track resolves to its own letter.
 *   T   task CLI: every mutating verb stamps `session` + `sessionVia`; read verbs stamp nothing; `list --session`;
 *       old / hand-edited history loads, validates and renders; history disabled writes nothing.
 *   W   workflow artifacts: cost-ledger `Session` column, signoff token `tpmSession`/`tpmSessionVia`,
 *       the `<!-- tpm-session … -->` comment after the spawn marker.
 *   L   the child launcher, `--print-cmd` only, run from a SCRATCH COPY of tools/ (so <next>/tmp/sessions is not touched).
 *
 * ISOLATION: the resolver is IMPORTED (never re-implemented). Every child gets an EXPLICIT env — PATH + a SCRATCH
 * HOME (a mkdtemp dir, never the real one) + fake CLAUDE_CODE_SESSION_ID / CLAUDE_PID + a scratch TPM_SESSIONS_DIR.
 * Scratch dirs only; nothing of the invoking session reaches a child.
 * Run: node tools/tests/tpm-attribution-lockin.test.js   (exit 0 = green)
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkScratch } = require('./lib/scratch');

// This process must not carry a live session's identity into the in-process resolver calls.
for (const v of ['TPM_PROJECT_ROOT', 'TPM_HOME', 'CLAUDE_PROJECT_DIR', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'TPM_SESSION_ID', 'TPM_SESSIONS_DIR']) delete process.env[v];

const TOOLS = path.resolve(__dirname, '..');
const A = require(path.join(TOOLS, 'lib', 'attribution.js'));
const H = require(path.join(TOOLS, 'session', 'tests', 'helpers', 'track-helpers'));
const TASK = path.join(TOOLS, 'task', 'tpm-task.js');
const DOCTOR = path.join(TOOLS, 'task', 'tpm-task-doctor.js');
const WF = path.join(TOOLS, 'workflow');

const ROOT = mkScratch('attr-lockin');
const HOME = path.join(ROOT, 'home');           // a SCRATCH home — never the invoking user's home
fs.mkdirSync(HOME, { recursive: true });
let seq = 0;
function fresh(name) { const d = path.join(ROOT, name + '-' + (seq++)); fs.mkdirSync(d, { recursive: true }); return d; }
function sessionsDirWith(tracks) { // tracks: [[number, letter, owner, extra?]]
  const s = path.join(fresh('sess'));
  for (const [n, l, o, x] of tracks) H.putTrack(s, n, l, Object.assign({ owner: o }, x || {}));
  return s;
}

let pass = 0; let fail = 0; const failures = [];
function test(name, fn) {
  try { fn(); pass += 1; process.stdout.write(`  ok   - ${name}\n`); } catch (e) {
    fail += 1; failures.push(name);
    process.stdout.write(`  FAIL - ${name}\n         ${(e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n         ') : String(e))}\n`);
  }
}

/** Run fn with process.stdout/stderr.write captured; returns { value, out } and rethrows nothing silently. */
function quiet(fn) {
  const so = process.stdout.write; const se = process.stderr.write; let out = '';
  process.stdout.write = (c) => { out += String(c); return true; };
  process.stderr.write = (c) => { out += String(c); return true; };
  try { return { value: fn(), out }; } finally { process.stdout.write = so; process.stderr.write = se; }
}
const BLANK = { session: null, sessionVia: null };
function resolveQuietly(opts) {
  const r = quiet(() => A.resolveAttribution(opts));
  assert.strictEqual(r.out, '', 'the resolver prints nothing: ' + JSON.stringify(r.out));
  return r.value;
}

// ═══ R: the resolver ═══════════════════════════════════════════════════════════════════════════════════════════
test('R-1 resolution order: flag > TPM_SESSION_ID > lookup > blank (each rung proven against the one below)', () => {
  const sd = sessionsDirWith([['0040', 'b', 'idMe']]);
  const base = { sessionsDir: sd, claudeSessionId: 'idMe' };
  assert.deepStrictEqual(resolveQuietly({ ...base, explicit: '0003c', env: { TPM_SESSION_ID: '0007' } }), { session: 'session-0003c', sessionVia: 'flag' });
  assert.deepStrictEqual(resolveQuietly({ ...base, env: { TPM_SESSION_ID: '0007' } }), { session: 'session-0007', sessionVia: 'env' });
  assert.deepStrictEqual(resolveQuietly({ ...base, env: {} }), { session: 'session-0040b', sessionVia: 'lookup' });
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: sd, claudeSessionId: 'someone-else', env: {} }), BLANK);
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: sd, env: {} }), BLANK, 'no identity at all -> blank');
  // object form of the flag and the track-a stored form (no letter)
  assert.deepStrictEqual(resolveQuietly({ explicit: { session: '12', track: 'a' }, env: {} }), { session: 'session-0012', sessionVia: 'flag' });
  assert.deepStrictEqual(resolveQuietly({ explicit: { session: '12', track: 'b' }, env: {} }), { session: 'session-0012b', sessionVia: 'flag' });
});

test('R-2 garbage / UUID / out-of-range TPM_SESSION_ID is ignored (falls to lookup), never thrown, never printed', () => {
  const sd = sessionsDirWith([['0040', 'a', 'idMe']]);
  for (const bad of ['garbage', '0012B', '99999', '0', '   ', '', '0012-b', '$(whoami)', '123e4567-e89b-12d3-a456-426614174000', 'session-session-0012']) {
    assert.deepStrictEqual(resolveQuietly({ sessionsDir: sd, claudeSessionId: 'idMe', env: { TPM_SESSION_ID: bad } }),
      { session: 'session-0040', sessionVia: 'lookup' }, 'env=' + JSON.stringify(bad));
    assert.deepStrictEqual(resolveQuietly({ env: { TPM_SESSION_ID: bad } }), BLANK, 'no lookup either: ' + JSON.stringify(bad));
  }
  assert.deepStrictEqual(resolveQuietly({ env: { TPM_SESSION_ID: 12 } }), BLANK, 'non-string env value');
});

test('R-3 a malformed explicit flag handed to the RESOLVER falls through (the CLI refuses it earlier)', () => {
  const sd = sessionsDirWith([['0040', 'a', 'idMe']]);
  assert.deepStrictEqual(resolveQuietly({ explicit: 'junk', sessionsDir: sd, claudeSessionId: 'idMe', env: {} }), { session: 'session-0040', sessionVia: 'lookup' });
  assert.deepStrictEqual(resolveQuietly({ explicit: 'junk', env: { TPM_SESSION_ID: '5' } }), { session: 'session-0005', sessionVia: 'env' });
});

test('R-4 degraded sessions dir: missing, a plain FILE, chmod 000 -> blank, no throw, no output', () => {
  const root = fresh('deg');
  const missing = path.join(root, 'nope');
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: missing, claudeSessionId: 'idMe', env: {} }), BLANK);
  const asFile = path.join(root, 'afile'); fs.writeFileSync(asFile, 'not a dir');
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: asFile, claudeSessionId: 'idMe', env: {} }), BLANK);
  const locked = sessionsDirWith([['0040', 'a', 'idMe']]);
  const canLock = typeof process.getuid === 'function' && process.getuid() !== 0;
  if (canLock) {
    // positive control first: the same dir resolves while readable
    assert.strictEqual(resolveQuietly({ sessionsDir: locked, claudeSessionId: 'idMe', env: {} }).sessionVia, 'lookup');
    fs.chmodSync(locked, 0o000);
    try { assert.deepStrictEqual(resolveQuietly({ sessionsDir: locked, claudeSessionId: 'idMe', env: {} }), BLANK); } finally { fs.chmodSync(locked, 0o755); }
  }
});

test('R-5 corrupt records are skipped; the other tracks still match (truncated, [], null, {}, no meta)', () => {
  const sd = sessionsDirWith([['0040', 'b', 'idMe']]);
  const folder = path.join(sd, 'session-0040');
  const bad = { c: '{ "meta": {', d: '[]', e: 'null', f: '{}', g: '{"meta": 3}' };
  for (const [l, body] of Object.entries(bad)) fs.writeFileSync(path.join(folder, `session-0040-${l}.json`), body);
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: sd, claudeSessionId: 'idMe', env: {} }), { session: 'session-0040b', sessionVia: 'lookup' });
  const onlyBad = fresh('onlybad'); fs.mkdirSync(path.join(onlyBad, 'session-0041'), { recursive: true });
  fs.writeFileSync(path.join(onlyBad, 'session-0041', 'session-0041-b.json'), '{ truncated');
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: onlyBad, claudeSessionId: 'idMe', env: {} }), BLANK);
});

test('R-6 hostile opts / env never throw (null, throwing getters, non-object)', () => {
  const boom = {}; Object.defineProperty(boom, 'TPM_SESSION_ID', { get() { throw new Error('boom'); }, enumerable: true });
  for (const o of [undefined, null, 42, 'x', { env: null }, { env: boom }, { env: boom, claudeSessionId: 'x', sessionsDir: 5 }, { explicit: boom }]) {
    assert.doesNotThrow(() => { const r = resolveQuietly(o); assert.ok(r && 'session' in r && 'sessionVia' in r); }, JSON.stringify(Object.keys(o || {})));
  }
});

test('R-7 module disabled (session.enabled false, no explicit dir) -> blank; the enabled control resolves', () => {
  const proj = fresh('proj'); const cfgDir = path.join(proj, '.claude', 'claude-tpm'); fs.mkdirSync(cfgDir, { recursive: true });
  const sd = path.join(cfgDir, 'sessions'); H.putTrack(sd, '0040', 'b', { owner: 'idMe' });
  const cfg = path.join(cfgDir, 'config.json');
  const env = { CLAUDE_TPM_USER_CONFIG: path.join(proj, 'no-user-config.json') };
  fs.writeFileSync(cfg, JSON.stringify({ session: { enabled: true } }));
  assert.deepStrictEqual(resolveQuietly({ startDir: proj, claudeSessionId: 'idMe', env }), { session: 'session-0040b', sessionVia: 'lookup' }, 'control: default dir under the project');
  fs.writeFileSync(cfg, JSON.stringify({ session: { enabled: false } }));
  assert.deepStrictEqual(resolveQuietly({ startDir: proj, claudeSessionId: 'idMe', env }), BLANK, 'module disabled');
  assert.deepStrictEqual(resolveQuietly({ startDir: proj, explicit: '3', claudeSessionId: 'idMe', env }), { session: 'session-0003', sessionVia: 'flag' }, 'disabled module does not stop the flag');
  assert.deepStrictEqual(resolveQuietly({ startDir: proj, claudeSessionId: 'idMe', env: { ...env, TPM_SESSION_ID: '7' } }), { session: 'session-0007', sessionVia: 'env' }, 'nor the env override');
  fs.writeFileSync(cfg, '{ not json');
  assert.deepStrictEqual(resolveQuietly({ startDir: proj, claudeSessionId: 'idMe', env }), { session: 'session-0040b', sessionVia: 'lookup' }, 'unparseable project config -> default dir');
});

test('R-8 a second track resolves to the right letter (and a subagent sharing the orchestrator id gets the same track)', () => {
  const sd = sessionsDirWith([['0040', 'a', 'idA'], ['0040', 'b', 'idB'], ['0040', 'c', 'idC']]);
  const r = (id) => resolveQuietly({ sessionsDir: sd, claudeSessionId: id, env: {} });
  assert.strictEqual(r('idA').session, 'session-0040');
  assert.strictEqual(r('idB').session, 'session-0040b');
  assert.strictEqual(r('idC').session, 'session-0040c');
  assert.strictEqual(r('idB').session, 'session-0040b', 'same id again (a subagent) -> same track');
  assert.strictEqual(r('idZ').session, null);
});

test('R-9 lookup rules: live beats a newer self-sealed; marker-sealed never matches; two live tracks for one id -> blank', () => {
  const live = sessionsDirWith([['0040', 'a', 'idMe'], ['0041', 'a', 'idMe', { sealed: true }]]);
  assert.strictEqual(resolveQuietly({ sessionsDir: live, claudeSessionId: 'idMe', env: {} }).session, 'session-0040');
  const marker = sessionsDirWith([['0040', 'b', 'idMe']]); H.putMarker(marker, '0040', 'b');
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: marker, claudeSessionId: 'idMe', env: {} }), BLANK);
  const twice = sessionsDirWith([['0040', 'a', 'idMe'], ['0040', 'b', 'idMe']]);
  assert.deepStrictEqual(resolveQuietly({ sessionsDir: twice, claudeSessionId: 'idMe', env: {} }), BLANK, 'never guess');
});

// ═══ T: the task CLI ═══════════════════════════════════════════════════════════════════════════════════════════
function dirs() { const base = fresh('t'); const tasks = path.join(base, 'tasks'); const sessions = path.join(base, 'sessions'); fs.mkdirSync(sessions, { recursive: true }); return { base, tasks, sessions }; }
/** Run tpm-task.js as one Claude instance with an EXPLICIT env. o.id === null -> no identity; o.env merges last. */
function run(d, args, o) {
  const x = o || {};
  const env = { PATH: process.env.PATH, HOME };
  if (x.id !== null) { env.CLAUDE_CODE_SESSION_ID = x.id || 'idMe'; env.CLAUDE_PID = String(x.pid || 4242); }
  env.TPM_SESSIONS_DIR = x.sessionsDir || d.sessions;
  Object.assign(env, x.env || {});
  const r = spawnSync(process.execPath, [TASK, ...args, '--tasks-dir', d.tasks], { encoding: 'utf8', env, cwd: d.base, timeout: 30000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}
const ok = (r, m) => assert.strictEqual(r.code, 0, (m || '') + ' exit ' + r.code + ' ' + r.stderr);
const bodyFile = (d, id) => path.join(d.tasks, 'bodies', `${Math.floor(id / 1000) * 1000}-${Math.floor(id / 1000) * 1000 + 999}`, `task-${id}.json`);
function body(d, id) { const j = JSON.parse(fs.readFileSync(bodyFile(d, id), 'utf8')); return j.payload || j; }
const evs = (d, id) => body(d, id).history;
const lastEv = (d, id) => { const e = evs(d, id); return e[e.length - 1]; };

test('T-1 EVERY mutating verb stamps session + sessionVia (both keys, stored form); read verbs stamp nothing', () => {
  const d = dirs(); H.putTrack(d.sessions, '0040', 'b', { owner: 'idMe' });
  const want = (label, id) => { const e = lastEv(d, id); assert.strictEqual(e.session, 'session-0040b', label); assert.strictEqual(e.sessionVia, 'lookup', label); };
  ok(run(d, ['add', '--headline', 'one']), 'add'); want('add', 1000);
  ok(run(d, ['edit', '1000', '--headline', 'two'])); want('edit', 1000);
  ok(run(d, ['add-subtask', '1000', 'A', '--text', 'st'])); want('add-subtask', 1000);
  ok(run(d, ['check', '1000', 'A'])); want('check', 1000);
  ok(run(d, ['label', '1000', 'foo'])); want('label', 1000);
  ok(run(d, ['unlabel', '1000', 'foo'])); want('unlabel', 1000);
  const imp = path.join(d.base, 'imp.json'); fs.writeFileSync(imp, JSON.stringify({ headline: 'imported' }));
  ok(run(d, ['import', '1000', '--file', imp])); want('import', 1000);
  for (const verb of ['start', 'finish', 'reopen', 'drop', 'reopen', 'remove', 'reopen']) { ok(run(d, [verb, '1000']), verb); want(verb, 1000); }
  for (const e of evs(d, 1000)) {
    assert.strictEqual('session' in e, 'sessionVia' in e, 'both keys or neither');
    assert.ok(/^session-\d{4}[b-z]?$/.test(e.session), 'stored form: ' + e.session);
  }
  const n = evs(d, 1000).length;
  for (const a of [['show', '1000'], ['list'], ['history', '1000'], ['labels'], ['reindex']]) ok(run(d, a), a[0]);
  assert.strictEqual(evs(d, 1000).length, n, 'read verbs / reindex append no event');
});

test('T-2 flag (both positions, both spellings) > env > lookup; env beats a disagreeing lookup; track a has no letter', () => {
  const d = dirs(); H.putTrack(d.sessions, '0040', 'a', { owner: 'idMe' });
  ok(run(d, ['add', '--headline', 'x']));
  assert.deepStrictEqual([lastEv(d, 1000).session, lastEv(d, 1000).sessionVia], ['session-0040', 'lookup']);
  ok(run(d, ['--session', '12b', 'start', '1000'], { env: { TPM_SESSION_ID: '41' } }));
  assert.deepStrictEqual([lastEv(d, 1000).session, lastEv(d, 1000).sessionVia], ['session-0012b', 'flag'], 'flag before the verb');
  ok(run(d, ['edit', '1000', '--headline', 'q', '--session', '0012', '--track', 'c']));
  assert.strictEqual(lastEv(d, 1000).session, 'session-0012c', 'two-flag form, flag after the verb');
  ok(run(d, ['edit', '1000', '--headline', 'q2'], { env: { TPM_SESSION_ID: '41b' } }));
  assert.deepStrictEqual([lastEv(d, 1000).session, lastEv(d, 1000).sessionVia], ['session-0041b', 'env']);
  ok(run(d, ['edit', '1000', '--headline', 'q3'], { env: { TPM_SESSION_ID: 'garbage' } }));
  assert.deepStrictEqual([lastEv(d, 1000).session, lastEv(d, 1000).sessionVia], ['session-0040', 'lookup'], 'garbage env is silently ignored');
  ok(run(d, ['edit', '1000', '--headline', 'q4', '--session', '0012a']));
  assert.strictEqual(lastEv(d, 1000).session, 'session-0012', 'explicit a is stored without a letter');
});

test('T-3 degraded environments: the verb still exits 0, stdout is byte-identical, the event omits BOTH keys', () => {
  const baseline = run(dirs(), ['add', '--headline', 'same'], { id: null });
  ok(baseline);
  const cases = {
    'sessions dir deleted': { sessionsDir: path.join(ROOT, 'deleted-sessions') },
    'no Claude id': { id: null },
    'garbage TPM_SESSION_ID': { env: { TPM_SESSION_ID: 'garbage' } },
    'UUID TPM_SESSION_ID': { env: { TPM_SESSION_ID: '123e4567-e89b-12d3-a456-426614174000' } },
    'sessions dir is a file': (() => { const f = path.join(fresh('f'), 'afile'); fs.writeFileSync(f, 'x'); return { sessionsDir: f }; })(),
  };
  for (const [label, o] of Object.entries(cases)) {
    const d = dirs(); const r = run(d, ['add', '--headline', 'same'], o);
    ok(r, label);
    assert.strictEqual(r.stdout.replace(/\d{4}-\d\d-\d\dT[\d:+-]+/g, 'TS'), baseline.stdout.replace(/\d{4}-\d\d-\d\dT[\d:+-]+/g, 'TS'), label + ': stdout identical');
    assert.ok(!/session|attribut/i.test(r.stderr), label + ': attribution prints nothing: ' + r.stderr);
    assert.deepStrictEqual(Object.keys(lastEv(d, 1000)), ['at', 'op'], label + ': both keys omitted (no null)');
  }
});

test('T-4 malformed explicit flags exit 2 and write nothing', () => {
  const d = dirs(); ok(run(d, ['add', '--headline', 'one']));
  const snap = () => JSON.stringify(fs.readdirSync(d.tasks, { recursive: true }).sort().map((f) => { try { return [f, fs.readFileSync(path.join(d.tasks, f), 'utf8')]; } catch (_e) { return [f]; } }));
  const before = snap();
  for (const a of [['edit', '1000', '--headline', 'z', '--session', 'junk'], ['edit', '1000', '--headline', 'z', '--session', '0012B'], ['edit', '1000', '--headline', 'z', '--track', 'b'],
    ['edit', '1000', '--headline', 'z', '--session', '0012b', '--track', 'c'], ['start', '1000', '--session', '99999'], ['list', '--session', 'x']]) {
    const r = run(d, a); assert.strictEqual(r.code, 2, a.join(' ') + ' ' + r.stderr);
    assert.strictEqual(snap(), before, 'store untouched after ' + a.join(' '));
  }
});

test('T-5 list --session: bare number = every track, letter pins, `a` pins the lettered-less track, unmatched -> empty', () => {
  const d = dirs();
  ok(run(d, ['add', '--headline', 'Ta', '--session', '12']));      // 1000 session-0012
  ok(run(d, ['add', '--headline', 'Tb', '--session', '12b']));     // 1001 session-0012b
  ok(run(d, ['add', '--headline', 'Tc', '--session', '13']));      // 1002 session-0013
  ok(run(d, ['add', '--headline', 'Tn'], { id: null }));           // 1003 blank
  const rows = (args) => (run(d, ['list'].concat(args)).stdout.match(/^\| (\d+) \|/gm) || []).map((s) => s.replace(/\D/g, ''));
  assert.deepStrictEqual(rows(['--session', '12']), ['1000', '1001']);
  assert.deepStrictEqual(rows(['--session', '0012']), ['1000', '1001']);
  assert.deepStrictEqual(rows(['--session', '12a']), ['1000']);
  assert.deepStrictEqual(rows(['--session', '12b']), ['1001']);
  assert.deepStrictEqual(rows(['--session', '12', '--track', 'b']), ['1001']);
  assert.deepStrictEqual(rows(['--session', 'session-0013']), ['1002']);
  assert.deepStrictEqual(rows(['--session', '99']), []);
  assert.deepStrictEqual(rows(['--session', '12', '--state', 'all']), ['1000', '1001']);
});

test('T-6 old / hand-edited history loads, validates, renders; and a mixed store is doctor-clean', () => {
  const d = dirs(); ok(run(d, ['add', '--headline', 'old one'], { id: null }));
  assert.deepStrictEqual(Object.keys(evs(d, 1000)[0]), ['at', 'op'], 'an old-shape event');
  // hand-edit hostile attribution values into an old file: wrong types must not make the record unreadable
  const f = bodyFile(d, 1000); const j = JSON.parse(fs.readFileSync(f, 'utf8')); const b = j.payload || j;
  b.history.push({ at: '2026-01-01T00:00:00-07:00', op: 'state', from: 'open', to: 'in-progress', session: 42, sessionVia: ['x'] });
  b.history.push({ at: '2026-01-02T00:00:00-07:00', op: 'edit', field: 'headline', value: 'old one', session: '0012b' }); // bare, legacy-looking
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n');
  for (const a of [['show', '1000'], ['history', '1000'], ['history', '1000', '--json'], ['list'], ['list', '--state', 'all'], ['reindex']]) { const r = run(d, a); ok(r, a.join(' ')); }
  assert.match(run(d, ['history', '1000']).stdout, /state open → in-progress/);
  // the bare, hand-edited value still matches `list --session` (both sides are normalised)
  assert.ok(/\| 1000 \|/.test(run(d, ['list', '--session', '12b', '--state', 'all']).stdout), 'bare stored 0012b matches --session 12b');
  assert.ok(!/\| 1000 \|/.test(run(d, ['list', '--session', '13', '--state', 'all']).stdout));
  ok(run(d, ['edit', '1000', '--headline', 'new'], { id: 'idMe' })); // appends next to the odd events
  const r = spawnSync(process.execPath, [DOCTOR, '--tasks-dir', d.tasks], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME }, cwd: d.base });
  assert.strictEqual(r.status, 0, 'doctor clean: ' + r.stdout + r.stderr);
});

test('T-7 history disabled writes nothing (no event, no attribution) while the same call with history on stamps', () => {
  const d = dirs(); H.putTrack(d.sessions, '0040', 'a', { owner: 'idMe' });
  ok(run(d, ['--history', 'off', 'add', '--headline', 'quiet']));
  assert.deepStrictEqual(evs(d, 1000), [], 'no history at all');
  assert.ok(!/session/.test(fs.readFileSync(bodyFile(d, 1000), 'utf8')), 'no attribution anywhere in the body');
  ok(run(d, ['--history', 'off', 'edit', '1000', '--headline', 'quiet2', '--session', '12b']));
  assert.deepStrictEqual(evs(d, 1000), [], 'even with an explicit flag');
  ok(run(d, ['--history', 'on', 'add', '--headline', 'loud']));
  assert.strictEqual(lastEv(d, 1001).session, 'session-0040', 'positive control');
});

// ═══ W: workflow artifacts ═════════════════════════════════════════════════════════════════════════════════════
function wf(script, args, env, cwd) {
  return spawnSync(process.execPath, [path.join(WF, script), ...args], { env: Object.assign({ PATH: process.env.PATH, HOME }, env || {}), cwd, encoding: 'utf8', timeout: 30000 });
}
const sessW = sessionsDirWith([['0012', 'b', 'fake-id-1']]);
const withSess = { TPM_SESSIONS_DIR: sessW, CLAUDE_CODE_SESSION_ID: 'fake-id-1', CLAUDE_PID: '99999' };
const noSess = { TPM_SESSIONS_DIR: path.join(ROOT, 'missing-sessions') };

test('W-1 cost ledger: trailing Session column stamped; blank cell with no session; --session wins; bad flag exits 2; old 9-col ledger survives', () => {
  const dir = fresh('p');
  assert.strictEqual(wf('tpm-workflow-cost-ledger.js', ['--dir', dir, '--agent', 'a', '--tokens', '1k'], withSess).status, 0);
  assert.strictEqual(wf('tpm-workflow-cost-ledger.js', ['--dir', dir, '--agent', 'b', '--tokens', '1k'], noSess).status, 0);
  assert.strictEqual(wf('tpm-workflow-cost-ledger.js', ['--dir', dir, '--agent', 'c', '--tokens', '1k', '--session', '7'], withSess).status, 0);
  const led = fs.readFileSync(path.join(dir, 'tpm-tmp', 'cost-ledger.md'), 'utf8').split('\n');
  assert.ok(/\| Notes \| Session \|$/.test(led.find((l) => l.startsWith('| Date'))), 'header ends with Session');
  const rowOf = (agent) => led.find((l) => new RegExp('\\| ' + agent + ' \\|').test(l));
  assert.ok(/\| session-0012b \|$/.test(rowOf('a')), 'lookup-stamped: ' + rowOf('a'));
  assert.ok(/\| {2}\|$/.test(rowOf('b')) && !/session-/.test(rowOf('b')), 'blank cell: ' + rowOf('b'));
  assert.ok(/\| session-0007 \|$/.test(rowOf('c')), 'flag wins over lookup');
  assert.strictEqual(wf('tpm-workflow-cost-ledger.js', ['--dir', dir, '--agent', 'z', '--session', 'zz'], noSess).status, 2);
  const out = wf('tpm-workflow-cost-ledger.js', ['--dir', dir, '--summary'], noSess).stdout;
  assert.match(out, /3 subagent/);
  const old = fresh('old'); fs.mkdirSync(path.join(old, 'tpm-tmp'), { recursive: true });
  fs.writeFileSync(path.join(old, 'tpm-tmp', 'cost-ledger.md'), '# Cost ledger\n\n| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes |\n|------|---------------|-------|------|-------|-------:|------:|---------|-------|\n| 2026-01-01 | r | a | b | m | 1,000 | 2 | ok | n |\n');
  assert.match(wf('tpm-workflow-cost-ledger.js', ['--dir', old, '--summary'], noSess).stdout, /1 subagent/, 'old ledger still summarises');
  assert.strictEqual(wf('tpm-workflow-cost-ledger.js', ['--dir', old, '--agent', 'z', '--tokens', '2k'], withSess).status, 0);
  const up = fs.readFileSync(path.join(old, 'tpm-tmp', 'cost-ledger.md'), 'utf8');
  assert.ok(up.includes('| 2026-01-01 | r | a | b | m | 1,000 | 2 | ok | n |\n'), 'old row untouched');
  assert.match(up, /\| Notes \| Session \|\n/);
  assert.match(wf('tpm-workflow-cost-ledger.js', ['--dir', old, '--summary'], noSess).stdout, /2 subagent/);
});

test('W-2 signoff token carries tpmSession / tpmSessionVia (lookup, flag), omits both when blank; `session` key not reused', () => {
  const mk = () => { const p = fresh('proj'); fs.mkdirSync(path.join(p, '.claude', 'claude-tpm'), { recursive: true }); return p; };
  const tok = (p, n) => JSON.parse(fs.readFileSync(path.join(p, 'tpm-tmp', 'tpm-signoff', n + '.json'), 'utf8'));
  let p = mk();
  assert.strictEqual(wf('tpm-workflow-signoff.js', ['questions'], withSess, p).status, 0);
  let t = tok(p, 'questions');
  assert.strictEqual(t.tpmSession, 'session-0012b'); assert.strictEqual(t.tpmSessionVia, 'lookup');
  assert.strictEqual(t.session, undefined, 'the pre-existing `session` field is not reused'); assert.strictEqual(t.sessionId, 'fake-id-1');
  p = mk();
  assert.strictEqual(wf('tpm-workflow-signoff.js', ['questions', '--session', '5c'], withSess, p).status, 0);
  t = tok(p, 'questions'); assert.deepStrictEqual([t.tpmSession, t.tpmSessionVia], ['session-0005c', 'flag']);
  p = mk();
  assert.strictEqual(wf('tpm-workflow-signoff.js', ['questions'], noSess, p).status, 0);
  t = tok(p, 'questions'); assert.ok(!('tpmSession' in t) && !('tpmSessionVia' in t), 'both omitted');
  assert.strictEqual(wf('tpm-workflow-signoff.js', ['questions', '--session', 'zz'], noSess, p).status, 2);
});

test('W-3 compose: the <!-- tpm-session --> comment follows the marker line; absent when blank; flag via; bad flag exits 2', () => {
  const base = ['--role', 'builder', '--phase-dir', 'dev/x/01-a', '--plan', 'plan.md', '--charter', 'charter-builder.md'];
  let out = wf('tpm-workflow-compose-spawn-prompt.js', base, withSess).stdout.split('\n');
  assert.match(out[1], /^<!-- tpm-workflow-spawn phase="dev\/x\/01-a" role="builder" -->$/);
  assert.strictEqual(out[2], '<!-- tpm-session session="session-0012b" via="lookup" -->');
  assert.strictEqual(out[3], '', 'blank line after the comment');
  out = wf('tpm-workflow-compose-spawn-prompt.js', base.concat(['--session', '12', '--track', 'c']), withSess).stdout.split('\n');
  assert.strictEqual(out[2], '<!-- tpm-session session="session-0012c" via="flag" -->');
  out = wf('tpm-workflow-compose-spawn-prompt.js', base, noSess).stdout.split('\n');
  assert.ok(!out.some((l) => l.includes('tpm-session')), 'no comment when blank');
  assert.strictEqual(out[2], '');
  assert.strictEqual(wf('tpm-workflow-compose-spawn-prompt.js', base.concat(['--session', 'zz']), noSess).status, 2);
});

// ═══ L: the child launcher (--print-cmd, scratch COPY) ═════════════════════════════════════════════════════════
function launcherCopy() {
  const s = fresh('launcher'); fs.mkdirSync(path.join(s, 'tools', 'child-session'), { recursive: true });
  fs.cpSync(path.join(TOOLS, 'lib'), path.join(s, 'tools', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(TOOLS, 'child-session', 'tpm-child-launch.sh'), path.join(s, 'tools', 'child-session', 'tpm-child-launch.sh'));
  const child = path.join(s, 'child-proj'); fs.mkdirSync(child, { recursive: true });
  return { script: path.join(s, 'tools', 'child-session', 'tpm-child-launch.sh'), child, root: s };
}
function launch(env) {
  const c = launcherCopy();
  const r = spawnSync('bash', [c.script, c.child, '--print-cmd'], { env: Object.assign({ PATH: process.env.PATH, HOME }, env), encoding: 'utf8', timeout: 30000 });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '', root: c.root };
}
test('L-1 launcher --print-cmd exports TPM_SESSION_ID (stored form) for the resolved session; nothing when none resolves; a caller export is kept', () => {
  const sd = sessionsDirWith([['0012', 'b', 'idL']]);
  let r = launch({ TPM_SESSIONS_DIR: sd, CLAUDE_CODE_SESSION_ID: 'idL', CLAUDE_PID: '777' });
  assert.strictEqual(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("TPM_SESSION_ID='session-0012b' claude"), r.stdout);
  r = launch({ TPM_SESSIONS_DIR: sd, CLAUDE_CODE_SESSION_ID: 'nobody', CLAUDE_PID: '777' });
  assert.strictEqual(r.code, 0, r.stderr); assert.ok(!r.stdout.includes('TPM_SESSION_ID'), 'unresolved -> nothing set');
  r = launch({ TPM_SESSIONS_DIR: path.join(ROOT, 'gone'), CLAUDE_CODE_SESSION_ID: 'idL', CLAUDE_PID: '777' });
  assert.strictEqual(r.code, 0, 'a missing sessions dir never fails the launch'); assert.ok(!r.stdout.includes('TPM_SESSION_ID'));
  r = launch({ TPM_SESSIONS_DIR: sd });
  assert.strictEqual(r.code, 0); assert.ok(!r.stdout.includes('TPM_SESSION_ID'), 'no identity -> nothing set');
  r = launch({ TPM_SESSIONS_DIR: sd, CLAUDE_CODE_SESSION_ID: 'idL', CLAUDE_PID: '777', TPM_SESSION_ID: '99' });
  // '99' (not the stored form) so a launcher that re-resolved and overwrote the caller's export would be visible
  assert.ok(r.stdout.includes("TPM_SESSION_ID='99' claude") && !r.stdout.includes('session-0012b'), 'caller export kept verbatim: ' + r.stdout);
  assert.ok(fs.existsSync(path.join(r.root, 'tmp', 'sessions')), 'the launcher wrote under the SCRATCH copy, not the real tree');
});

process.stdout.write(`\ntpm-attribution-lockin.test.js: ${pass} passed, ${fail} failed\n`);
if (fail) { process.stdout.write('failed: ' + failures.join(' | ') + '\n'); process.exit(1); }
