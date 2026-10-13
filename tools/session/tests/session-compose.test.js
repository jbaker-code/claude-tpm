'use strict';
/**
 * session-compose.test.js — the tpm-session composer (#1155): mode normalization, per-mode composition
 * over a config matrix, the proseInjections / templates precedence ladder (#1153), reading-list pointers
 * (#1154), read-only/idempotent behaviour, banner parity with the engine, injection safety.
 *
 * Run: node tests/session-compose.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const c = require('../tpm-session-compose');
const overlay = require('../../lib/tpm-config-overlay');
const engine = require('../../lib/tpm-template');

function cfg(over) {
  const d = overlay.loadDefaults();
  return overlay.deepMerge(d, over || {});
}
function proj() {
  const root = tmpDir('compose-');
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm', 'sessions'), { recursive: true });
  return root;
}
function w(root, rel, text) {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
}
function run(mode, over, extra) {
  const root = (extra && extra.root) || proj();
  return c.compose(mode, Object.assign({ config: cfg(over), projectRoot: root, pickup: 'PICKUP-TEXT',
    sessionsDir: path.join(root, '.claude', 'claude-tpm', 'sessions'), env: {} }, extra || {}));
}

// ── mode normalization ──
test('alias table: every documented alias resolves to its mode', () => {
  const t = { start: 'open', begin: 'open', boot: 'open', end: 'close', finish: 'close', wrap: 'close',
    write: 'save', store: 'save', checkpoint: 'save', snapshot: 'save', record: 'save', note: 'save',
    status: 'info', current: 'info', which: 'info', where: 'info', show: 'info' };
  for (const [a, m] of Object.entries(t)) assert.strictEqual(c.normalizeMode(a).mode, m, a);
  for (const m of ['open', 'save', 'close', 'info']) assert.strictEqual(c.normalizeMode(m).mode, m);
});
test('misspellings (opn, clos, sav, stat) resolve; normalization strips case/punctuation', () => {
  assert.strictEqual(c.normalizeMode('opn').mode, 'open');
  assert.strictEqual(c.normalizeMode('clos').mode, 'close');
  assert.strictEqual(c.normalizeMode('sav').mode, 'save');
  assert.strictEqual(c.normalizeMode('stat').mode, 'info');
  assert.strictEqual(c.normalizeMode('  WRAP,  up!! ').mode, 'close');
});
test('empty/auto -> auto; reap-shaped -> reap redirect; unmatched/ambiguous -> ambiguous (never guessed)', () => {
  assert.strictEqual(c.normalizeMode('').kind, 'auto');
  assert.strictEqual(c.normalizeMode(undefined).kind, 'auto');
  assert.strictEqual(c.normalizeMode('auto').kind, 'auto');
  assert.strictEqual(c.normalizeMode('clean up strays').kind, 'reap');
  assert.strictEqual(c.normalizeMode('kill').kind, 'reap');
  assert.strictEqual(c.normalizeMode('frobnicate').kind, 'ambiguous');
  assert.strictEqual(c.normalizeMode('start end').kind, 'ambiguous');
});
test('compose: reap -> /tpm-reap redirect text; ambiguous -> the mode table', () => {
  assert.ok(/\/tpm-reap/.test(run('sweep').text));
  const a = run('zzz');
  assert.ok(/\| `open` \|/.test(a.text) && a.mode === null);
});
test('bare invocation is state-aware: not-opened -> open; open pointer -> save', () => {
  const root = proj();
  const sd = path.join(root, '.claude', 'claude-tpm', 'sessions');
  assert.strictEqual(run('', null, { root }).mode, 'open');
  fs.writeFileSync(path.join(sd, '.current-session.json'), '{}'); // pointer name varies — use the real tool below
  const cur = require('../tpm-session-current');
  fs.rmSync(path.join(sd, '.current-session.json'), { force: true });
  const opened = cur.openSession({ sessionsDir: sd });
  assert.strictEqual(run('', null, { root }).mode, 'save');
  // Tracks store: `--seal` no longer stamps a blind "closed" — the hint closes only when no track is
  // unsealed, so the lone record is CLOSED first (what `close` does), then `--seal`.
  const model = require('../lib/session-model');
  const rec = model.loadSession(opened.recordPath);
  model.saveSession(model.closeSession(rec), { jsonPath: opened.recordPath });
  cur.sealSession({ sessionsDir: sd });
  assert.strictEqual(run('', null, { root }).mode, 'open');
});

// ── per-mode composition + config matrix ──
test('open: every boot step present; echo line; footer last-ish; no npx; no directive residue', () => {
  const r = run('open');
  for (const needle of ['tpm session current --open', 'tpm reading-list orchestrator', 'PICKUP-TEXT',
    'tpm-session` → save session notes', 'tpm-task', 'Print the footer', 'tpm session current --state',
    'subagent must never run this skill', 'Reading "open"']) {
    assert.ok(r.text.includes(needle), `missing: ${needle}`);
  }
  assert.ok(!/npx tpm/.test(r.text) && !/<!--\s*tpm:/.test(r.text));
  assert.ok(!/hygiene/i.test(r.text.split('MOTD')[1] || ''), 'hygiene never listed');
});
test('open: notes off drops pickup; tasks off drops the queue; showTPMOpenMessage off drops the MOTD; module off hides its skill', () => {
  const r = run('open', { session: { notes: { enabled: false }, showTPMOpenMessage: false }, tasks: { enabled: false } });
  assert.ok(!r.text.includes('PICKUP-TEXT') && !r.text.includes('task queue') && !r.text.includes('reach for'));
  const m = run('open', { workflow: { enabled: false }, tasks: { enabled: false } });
  assert.ok(!m.text.includes('tpm-workflow') && !m.text.includes('tpm-task') && m.text.includes('tpm-session'));
});
test('session.enabled:false -> one-line disabled message, no procedure (all modes)', () => {
  for (const mode of ['open', 'save', 'close', 'info']) {
    const r = run(mode, { session: { enabled: false } });
    assert.ok(/disabled by config/.test(r.text), mode);
    assert.ok(!r.text.includes('Boot sequence') && !r.text.includes('Reconcile the punchlist'), mode);
  }
});
test('save: 3-step ritual + footer; notes disabled -> skip line, no ritual', () => {
  const r = run('save');
  assert.ok(r.text.includes('Reconcile the punchlist') && r.text.includes('import-handoff') && r.text.includes('Footer'));
  const off = run('save', { session: { notes: { enabled: false } } });
  assert.ok(/notes disabled by config/i.test(off.text) && !off.text.includes('Reconcile the punchlist'));
});
test('close: reap -> save ritual -> seal -> /export -> sign-off -> footer; close message off drops the sign-off; notes off drops ritual+seal', () => {
  const r = run('close');
  for (const n of ['/tpm-reap', 'Reconcile the punchlist', 'current --seal', '/export', 'Terse sign-off', 'LAST thing you emit']) {
    assert.ok(r.text.includes(n), n);
  }
  assert.ok(!run('close', { session: { showTPMCloseMessage: false } }).text.includes('Terse sign-off'));
  const off = run('close', { session: { notes: { enabled: false } } });
  assert.ok(!off.text.includes('Reconcile the punchlist') && !off.text.includes('--seal') && off.text.includes('/tpm-reap'));
});
test('info: footer only', () => {
  const r = run('info');
  assert.ok(r.text.includes('Footer') && !r.text.includes('Boot sequence'));
});
test('additionalOpen/CloseMessage file content is appended after the MOTD / sign-off; missing file -> warning', () => {
  const root = proj();
  w(root, 'extra-open.md', 'CONSUMER-OPEN-NOTE\n');
  w(root, 'extra-close.md', 'CONSUMER-CLOSE-NOTE\n');
  const o = run('open', { session: { additionalOpenMessage: 'extra-open.md' } }, { root });
  assert.ok(o.text.indexOf('CONSUMER-OPEN-NOTE') > o.text.indexOf('reach for'));
  const cl = run('close', { session: { additionalCloseMessage: 'extra-close.md' } }, { root });
  assert.ok(cl.text.indexOf('CONSUMER-CLOSE-NOTE') > cl.text.indexOf('Terse sign-off'));
  const miss = run('open', { session: { additionalOpenMessage: 'nope.md' } }, { root });
  assert.ok(miss.warnings.some((x) => x.startsWith('additional-file-missing')) && /tpm notes/.test(miss.text));
});

// ── #1153 precedence ladder ──
test('prose: no marker -> location before/after wrap the body (before first, after last)', () => {
  const root = proj();
  w(root, 'b.md', 'BEFORE-PROSE'); w(root, 'a.md', 'AFTER-PROSE');
  const r = run('open', { session: { proseInjections: [
    { mode: 'open', file: 'b.md', location: 'before' }, { mode: 'open', file: 'a.md', location: 'after' },
    { mode: 'close', file: 'b.md', location: 'before' }] } }, { root });
  const t = r.text;
  assert.ok(t.indexOf('BEFORE-PROSE') < t.indexOf('Boot sequence') && t.indexOf('AFTER-PROSE') > t.indexOf('LAST thing'));
  assert.strictEqual(t.split('BEFORE-PROSE').length, 2, 'once only; the close-mode entry is not applied to open');
  assert.ok(!run('close', null, { root }).text.includes('BEFORE-PROSE'));
});
test('prose: a `tpm:inject prose` marker in an override template places ALL prose there, location ignored', () => {
  const root = proj();
  w(root, 'p1.md', 'P-ONE'); w(root, 'p2.md', 'P-TWO');
  w(root, 'my-open.md', 'HEAD\n<!-- tpm:inject prose -->\nTAIL\n');
  const r = run('open', { session: { templates: { open: 'my-open.md' }, proseInjections: [
    { mode: 'open', file: 'p1.md', location: 'after' }, { mode: 'open', file: 'p2.md', location: 'before' }] } }, { root });
  assert.ok(/HEAD\n+P-ONE\n+P-TWO\n+TAIL/.test(r.text), r.text);
  assert.ok(!r.text.includes('Boot sequence'), 'override replaced the shipped template wholesale');
});
test('Q2: a templates.<mode> override WITHOUT a marker does NOT suppress proseInjections (before/after wrap it)', () => {
  const root = proj();
  w(root, 'p1.md', 'P-ONE'); w(root, 'my-open.md', 'ONLY-BODY\n');
  const r = run('open', { session: { templates: { open: 'my-open.md' },
    proseInjections: [{ mode: 'open', file: 'p1.md', location: 'before' }] } }, { root });
  assert.ok(/P-ONE\n+ONLY-BODY/.test(r.text));
});
test('prose marker obeys tpm:if gating (marker in an OFF region drops the prose)', () => {
  const root = proj();
  w(root, 'p1.md', 'P-ONE');
  w(root, 'my-save.md', 'X\n<!-- tpm:if tasks.enabled -->\n<!-- tpm:inject prose -->\n<!-- tpm:endif -->\nY\n');
  const on = run('save', { session: { templates: { save: 'my-save.md' }, proseInjections: [{ mode: 'save', file: 'p1.md', location: 'before' }] } }, { root });
  const off = run('save', { tasks: { enabled: false }, session: { templates: { save: 'my-save.md' }, proseInjections: [{ mode: 'save', file: 'p1.md', location: 'before' }] } }, { root });
  assert.ok(on.text.includes('P-ONE') && !off.text.includes('P-ONE'));
});
test('prose: missing file / bad entry -> skipped + visible composer warning; boot still renders', () => {
  const r = run('open', { session: { proseInjections: [
    { mode: 'open', file: 'ghost.md', location: 'before' }, { mode: 'bogus', file: 'x', location: 'before' },
    { mode: 'open', file: 'x', location: 'middle' }] } });
  assert.ok(r.warnings.some((x) => x.startsWith('prose-file-missing')));
  assert.strictEqual(r.warnings.filter((x) => x.startsWith('bad-prose-entry')).length, 2);
  assert.ok(r.text.includes('Boot sequence') && /tpm notes \(composer\)/.test(r.text));
});
test('injection safety: directive-looking text inside a prose file stays literal (never re-scanned)', () => {
  const root = proj();
  w(root, 'evil.md', '<!-- tpm:if session.enabled -->\nSMUGGLED\n<!-- tpm:endif -->');
  w(root, 'my.md', 'T\n<!-- tpm:inject prose -->\n');
  const r = run('save', { session: { templates: { save: 'my.md' }, proseInjections: [{ mode: 'save', file: 'evil.md', location: 'before' }] } }, { root });
  assert.ok(r.text.includes('<!-- tpm:if session.enabled -->\nSMUGGLED'));
});
test('templates override: missing file falls back to the shipped template + template-override-missing', () => {
  const r = run('open', { session: { templates: { open: 'ghost-template.md' } } });
  assert.ok(r.text.includes('Boot sequence') && r.warnings.some((x) => x.startsWith('template-override-missing')));
});

// ── #1154 reading list ──
test('readingList: orchestrator+all pointers listed in order; subagent skipped; missing/bad -> warning', () => {
  const root = proj();
  w(root, 'docs/a.md', 'a'); w(root, 'docs/b.md', 'b'); w(root, 'docs/s.md', 's');
  const r = run('open', { session: { readingList: [
    { audience: 'all', file: 'docs/a.md' }, { audience: 'subagent', file: 'docs/s.md' },
    { audience: 'orchestrator', file: 'docs/b.md' }, { audience: 'all', file: 'docs/ghost.md' }, { audience: 'nobody', file: 'x' }] } }, { root });
  assert.ok(r.text.indexOf('docs/a.md') < r.text.indexOf('docs/b.md') && !r.text.includes('docs/s.md'));
  assert.ok(r.warnings.some((x) => x.startsWith('reading-file-missing')) && r.warnings.some((x) => x.startsWith('bad-reading-entry')));
  assert.ok(!run('save', { session: { readingList: [{ audience: 'all', file: 'docs/a.md' }] } }, { root }).text.includes('docs/a.md'));
});

// ── purity / parity / degrade ──
test('compose is read-only + idempotent (twice => identical text; sessions dir unchanged)', () => {
  const root = proj();
  const sd = path.join(root, '.claude', 'claude-tpm', 'sessions');
  const before = fs.readdirSync(sd);
  const a = run('open', null, { root }).text; const b = run('open', null, { root }).text;
  assert.strictEqual(a, b);
  assert.deepStrictEqual(fs.readdirSync(sd), before);
});
test('degradedBanner is byte-identical to the engine banner', () => {
  const r = engine.render('body\n', { config: [] });
  assert.ok(r.degraded);
  assert.ok(r.text.startsWith(c.degradedBanner(r.degradedReason, 'empty')), JSON.stringify(r.text));
});
test('render throwing / shipped template missing => EMERGENCY_BOOT (non-empty literal procedure), not a throw', () => {
  const t = run('open', null, { renderFn: () => { throw new Error('boom'); } });
  assert.ok(t.emergency && t.text.includes('EMERGENCY BOOT') && t.text.includes('boom') && t.text.includes('tpm reading-list orchestrator'));
  const m = run('open', null, { templatesDir: path.join(tmpDir('empty-'), 'none') });
  assert.ok(m.emergency && m.text.includes('tpm session current --open'));
  assert.ok(!/npx tpm/.test(c.EMERGENCY_BOOT));
});
test('pickup (real boot-read): compose BEFORE vs AFTER `current --open` yields the identical prior-session pickup', () => {
  const root = proj();
  const sd = path.join(root, '.claude', 'claude-tpm', 'sessions');
  const model = require('../lib/session-model');
  const { render } = require('../lib/session-converter');
  let rec = model.openSession({ number: '0001', sessionId: 'sid', tpmVersion: '0.2.0' });
  rec = model.importHandoff(rec, { where: 'WHERE-MARK', next: 'NEXT-MARK' });
  rec = model.addPunchlist(rec, { text: 'open item', slug: 'itemAA' });
  rec = model.closeSession(rec);   // a real PRIOR session is sealed (an unsealed null-owner record would be resumed by `--open`)
  const folder = path.join(sd, 'session-0001'); fs.mkdirSync(folder, { recursive: true });
  model.saveSession(rec, { jsonPath: path.join(folder, 'session-0001.json'), mdPath: path.join(folder, 'session-0001.md'),
    render: (r) => render(r, { now: '2026-09-21T10:00:00-07:00' }) });
  // The caller is a REAL Claude instance (it has a session id). A caller with NO readable id owns nothing, so since
  // phase 13 (reader honesty E1) the session it opens is not excluded as "yours" - see session-boot-multi.test.js.
  const SID = 'cccccccc-3333-4333-8333-cccccccccccc';
  const mk = () => c.compose('open', { config: cfg(), projectRoot: root, sessionsDir: sd, env: { CLAUDE_CODE_SESSION_ID: SID } }).text;
  const before = mk();
  require('../tpm-session-current').openSession({ sessionsDir: sd, identity: { claudeSessionId: SID, claudePid: null, claudePidStartedAt: null, hostname: null } });
  const after = mk();
  assert.ok(before.includes('WHERE-MARK') && before.includes('NEXT-MARK'));
  const strip = (t) => t.replace(/session-0002[^\n]*/g, '');
  assert.strictEqual(strip(before), strip(after));
});

done('session-compose.test');
