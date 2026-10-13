'use strict';
/**
 * attribution.test.js — the shared session-attribution resolver (tools/lib/attribution.js + sessions-dir.js).
 * Grammar table, parseExplicit matrix, sessionMatches, lookupTrack over REAL session-suite records, the
 * resolveAttribution precedence + degradation matrix, no-throw / no-print, and the PARITY tests that guard the
 * lib's re-implementation of session-tracks.js (SCAN_WINDOW, regexes, ownerOf, classify) against drift.
 * Pure + hermetic (scratch dirs only; explicit env objects; never the live sessions dir). Exits non-zero on failure.
 * Run: node tools/session/tests/attribution.test.js
 */
const { assert, test, done, tmpDir, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const A = require('../../lib/attribution');
const SD = require('../../lib/sessions-dir');
const ids = require('../lib/session-ids');
const T = H.T;

// ── grammar ──────────────────────────────────────────────────────────────────────────────────────
test('A-1 normalisation table: every row of the contract grammar', () => {
  const ok = [
    ['0012b', 'session-0012b'], ['0012', 'session-0012'], ['0012a', 'session-0012'], ['12b', 'session-0012b'],
    ['session-0012b', 'session-0012b'], ['session-0012', 'session-0012'], [' 0012b ', 'session-0012b'], ['00012b', 'session-0012b'],
    ['1', 'session-0001'], ['9999z', 'session-9999z'],
  ];
  for (const [i, want] of ok) assert.strictEqual(A.normalizeStored(i), want, JSON.stringify(i));
  const bad = ['0012B', '0012bb', '0012-b', 'b', '0000', '0', '12345', '10000', '', '   ', '4f1c2d3e-aaaa-bbbb-cccc-1234567890ab',
    '0012b;rm', '$(whoami)', 'Session-0012b', 'session_0012b', 'session-session-0012', '9'.repeat(400), undefined, null, 12, {}, []];
  for (const i of bad) assert.strictEqual(A.parseSessionRef(i), null, JSON.stringify(i));
});

test('A-2 Ref shape: track null when no letter, a pins; stored/bare treat null as a', () => {
  assert.deepStrictEqual(A.parseSessionRef('12'), { number: '0012', track: null, stored: 'session-0012', bare: '0012' });
  assert.deepStrictEqual(A.parseSessionRef('12a'), { number: '0012', track: 'a', stored: 'session-0012', bare: '0012' });
  assert.deepStrictEqual(A.parseSessionRef('session-0012c'), { number: '0012', track: 'c', stored: 'session-0012c', bare: '0012c' });
  assert.strictEqual(A.storedForm('0012', 'a'), 'session-0012');
  assert.strictEqual(A.storedForm('0012', null), 'session-0012');
  assert.strictEqual(A.storedForm('0012', 'b'), 'session-0012b');
});

test('A-3 DIVERGENCE from fromSession is pinned: .bare equals fromSessionLabel for a..z; stored never equals it', () => {
  for (const letter of 'abcdefghijklmnopqrstuvwxyz') {
    const meta = { number: 12, track: letter };
    const ref = A.parseSessionRef('session-0012' + letter);
    assert.strictEqual(ref.bare, ids.fromSessionLabel(meta).padStart(ref.bare.length, '0'), letter);
    assert.strictEqual(ref.bare.replace(/^0+/, ''), ids.fromSessionLabel(meta), letter);
    assert.notStrictEqual(ref.stored, ref.bare);
    assert.ok(ref.stored.startsWith('session-'));
  }
  assert.strictEqual(A.parseSessionRef('session-0012b').bare, '0012b');
});

// ── parseExplicit ─────────────────────────────────────────────────────────────────────────────────
test('A-4 parseExplicit matrix (every row of contract 2.4)', () => {
  const x = (s, t) => A.parseExplicit({ session: s, track: t });
  assert.deepStrictEqual(x(undefined, undefined), { ok: true, ref: null });
  assert.strictEqual(x(undefined, 'b').ok, false);
  assert.match(x(undefined, 'b').error, /--track needs --session/);
  for (const bad of ['', 'junk', '0012B', '99999']) { const r = x(bad, undefined); assert.strictEqual(r.ok, false, bad); assert.match(r.error, /--session/); }
  assert.strictEqual(x('0012b', undefined).ref.stored, 'session-0012b');
  assert.strictEqual(x('0012', undefined).ref.track, null);
  for (const bad of ['B', 'bb', '', '-b', ' b', '1']) { const r = x('0012', bad); assert.strictEqual(r.ok, false, JSON.stringify(bad)); assert.match(r.error, /--track/); }
  assert.strictEqual(x('0012b', 'b').ref.stored, 'session-0012b');
  assert.strictEqual(x('0012a', 'b').ok, false);
  assert.match(x('0012b', 'c').error, /disagree/);
  assert.strictEqual(x('0012', 'b').ref.stored, 'session-0012b');
  assert.strictEqual(x('0012', 'a').ref.stored, 'session-0012');
  assert.strictEqual(x('12', 'c').ref.bare, '0012c');
  assert.strictEqual(A.parseExplicit(null).ok, true);
});

// ── sessionMatches ──────────────────────────────────────────────────────────────────────────────────
test('A-5 sessionMatches: bare number = any track; a letter pins; a pins track a; both sides normalised; non-strings never match', () => {
  const f = (s) => A.parseSessionRef(s);
  assert.ok(A.sessionMatches('session-0012b', f('12')));
  assert.ok(A.sessionMatches('session-0012', f('12')));
  assert.ok(A.sessionMatches('session-0012', f('12a')));
  assert.ok(!A.sessionMatches('session-0012b', f('12a')));
  assert.ok(A.sessionMatches('session-0012b', f('0012b')));
  assert.ok(!A.sessionMatches('session-0012', f('12b')));
  assert.ok(A.sessionMatches('0012b', f('session-0012b')), 'a hand-edited bare stored value still matches');
  assert.ok(!A.sessionMatches('session-0013', f('12')));
  for (const v of [undefined, null, 12, {}, '', 'garbage']) assert.ok(!A.sessionMatches(v, f('12')), String(v));
  assert.ok(!A.sessionMatches('session-0012', null));
});

// ── lookupTrack over real records ────────────────────────────────────────────────────────────────
function store() { return tmpDir('attr-'); }
const own = (sd, n, t, spec) => H.putTrack(sd, n, t, spec);

test('A-6 lookupTrack: live / self-sealed / marker-sealed / none / blank inputs', () => {
  const sd = store();
  own(sd, '0040', 'a', { owner: 'idA' });
  assert.deepStrictEqual(A.lookupTrack(sd, 'idA'), { number: '0040', track: 'a', stored: 'session-0040', state: 'live' });
  assert.strictEqual(A.lookupTrack(sd, 'idZ'), null);
  assert.strictEqual(A.lookupTrack(sd, ''), null);
  assert.strictEqual(A.lookupTrack(sd, null), null);
  assert.strictEqual(A.lookupTrack(null, 'idA'), null);
  assert.strictEqual(A.lookupTrack(path.join(sd, 'nope'), 'idA'), null);
  const s2 = store();
  own(s2, '0041', 'a', { owner: 'idS', sealed: true });
  assert.strictEqual(A.lookupTrack(s2, 'idS').state, 'self-sealed', 'Q-D: a self-closed track still matches');
  const s3 = store();
  own(s3, '0042', 'b', { owner: 'idM' });
  H.putMarker(s3, '0042', 'b');
  assert.strictEqual(A.lookupTrack(s3, 'idM'), null, 'marker-sealed never matches');
});

test('A-7 lookupTrack tie-breaks: live beats newer self-sealed; newer live beats older; two-in-one -> null; track letters', () => {
  let sd = store();
  own(sd, '0010', 'a', { owner: 'idA' }); own(sd, '0011', 'a', { owner: 'idA', sealed: true });
  assert.strictEqual(A.lookupTrack(sd, 'idA').stored, 'session-0010', 'live beats the NEWER self-sealed');
  sd = store();
  own(sd, '0010', 'a', { owner: 'idA' }); own(sd, '0011', 'b', { owner: 'idA' });
  assert.strictEqual(A.lookupTrack(sd, 'idA').stored, 'session-0011b', 'newest live wins; letter from the file name');
  sd = store();
  own(sd, '0012', 'a', { owner: 'idA' }); own(sd, '0012', 'b', { owner: 'idA' });
  assert.strictEqual(A.lookupTrack(sd, 'idA'), null, 'two live tracks of the same id in the newest session: never guess');
  sd = store();
  own(sd, '0012', 'a', { owner: 'idA', sealed: true }); own(sd, '0012', 'c', { owner: 'idA', sealed: true });
  assert.strictEqual(A.lookupTrack(sd, 'idA'), null, 'two self-sealed at the top: null');
  sd = store();
  own(sd, '0012', 'a', { owner: 'idA' }); own(sd, '0012', 'b', { owner: 'idB' });
  assert.strictEqual(A.lookupTrack(sd, 'idB').stored, 'session-0012b');
  assert.strictEqual(A.lookupTrack(sd, 'idA').stored, 'session-0012');
});

test('A-8 lookupTrack ownership: legacy sessionIds owner; own claudeSessionId:null does NOT fall to sessionIds', () => {
  let sd = store();
  own(sd, '0005', 'a', { owner: 'legacyId', legacy: true });
  assert.strictEqual(A.lookupTrack(sd, 'legacyId').stored, 'session-0005');
  sd = store();
  const jp = own(sd, '0006', 'a', { owner: 'idX' });
  const rec = JSON.parse(fs.readFileSync(jp, 'utf8'));
  rec.meta.claudeSessionId = null; rec.meta.sessionIds = ['idX'];
  fs.writeFileSync(jp, JSON.stringify(rec));
  assert.strictEqual(A.lookupTrack(sd, 'idX'), null);
});

test('A-9 lookupTrack skips bad records only; ignores a hand-made -a file; window of 20 folders', () => {
  const sd = store();
  own(sd, '0001', 'a', { owner: 'idA' });
  fs.mkdirSync(path.join(sd, 'session-0002'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0002', 'session-0002.json'), '{"meta":');             // truncated
  fs.mkdirSync(path.join(sd, 'session-0003'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0003', 'session-0003.json'), '[]');
  fs.mkdirSync(path.join(sd, 'session-0004'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0004', 'session-0004.json'), 'null');
  fs.mkdirSync(path.join(sd, 'session-0005'), { recursive: true });
  fs.writeFileSync(path.join(sd, 'session-0005', 'session-0005.json'), '{}');
  fs.writeFileSync(path.join(sd, 'session-0005', 'session-0005-a.json'), JSON.stringify({ meta: { claudeSessionId: 'idA' } }));
  assert.strictEqual(A.lookupTrack(sd, 'idA').stored, 'session-0001', 'corrupt siblings are skipped, the good track still matches');
  // window: 21 newest-later folders push 0001 out of the scan
  const w = store();
  own(w, '0001', 'a', { owner: 'idOld' });
  for (let n = 2; n <= 21; n += 1) own(w, String(n).padStart(4, '0'), 'a', { owner: 'idOther' });
  assert.strictEqual(A.lookupTrack(w, 'idOld'), null, 'the 21st-oldest folder is outside SCAN_WINDOW');
  assert.strictEqual(A.lookupTrack(w, 'idOther').stored, 'session-0021');
});

test('A-10 sessions dir that is a FILE, or a dir with an unreadable folder, is blank', () => {
  const d = tmpDir('attr-f-');
  const f = path.join(d, 'afile'); fs.writeFileSync(f, 'x');
  assert.strictEqual(A.lookupTrack(f, 'idA'), null);
  const sd = store();
  own(sd, '0001', 'a', { owner: 'idA' });
  const folder = path.join(sd, 'session-0001');
  fs.chmodSync(folder, 0o000);
  try { assert.strictEqual(A.lookupTrack(sd, 'idA'), null); } finally { fs.chmodSync(folder, 0o755); }
});

// ── PARITY with the session suite ────────────────────────────────────────────────────────────────
test('A-11 PARITY: constants and regexes copied from session-tracks.js have not drifted', () => {
  assert.strictEqual(A.SCAN_WINDOW, T.SCAN_WINDOW, 'SCAN_WINDOW drifted from session-tracks.js');
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'session-tracks.js'), 'utf8');
  assert.ok(src.includes('const FOLDER_RE = /^session-(\\d{3,4})$/;'), 'FOLDER_RE drifted in session-tracks.js');
  const libSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', 'attribution.js'), 'utf8');
  assert.ok(libSrc.includes('const FOLDER_RE = /^session-(\\d{3,4})$/;'), 'FOLDER_RE drifted in attribution.js');
  assert.ok(libSrc.includes(`const TRACK_FILE_RE = ${T.TRACK_FILE_RE.toString()};`), 'TRACK_FILE_RE drifted from session-tracks.js');
});

/** The pick the contract rule yields over the SUITE's own classification (scanSessions + classify). */
function suitePick(sd, callerId) {
  const scan = T.scanSessions(sd, { mode: 'window' });
  const states = [];
  for (const s of scan.sessions) for (const st of s.tracks) states.push(st);
  const mine = T.classify(states, callerId).mine
    .filter((st) => st.state === 'live' || (st.state === 'sealed' && st.sealedBy === 'self'));
  for (const want of ['live', 'sealed']) {
    const pool = mine.filter((st) => st.state === want);
    if (!pool.length) continue;
    const top = Math.max(...pool.map((st) => Number(st.number)));
    const atTop = pool.filter((st) => Number(st.number) === top);
    if (atTop.length !== 1) return null;
    return `session-${atTop[0].number}${atTop[0].track === 'a' ? '' : atTop[0].track}`;
  }
  return null;
}

test('A-12 PARITY: lookupTrack equals the suite scanSessions+classify pick across a mixed store', () => {
  const sd = store();
  own(sd, '0001', 'a', { owner: 'idA', sealed: true });
  own(sd, '0002', 'a', { owner: 'idA' });
  own(sd, '0002', 'b', { owner: 'idB' });
  own(sd, '0003', 'a', { owner: 'idC', sealed: true });
  own(sd, '0003', 'b', { owner: 'idC' });
  own(sd, '0003', 'c', { owner: 'idC' });                       // two live for idC at the top -> null
  own(sd, '0004', 'a', { owner: 'idD' }); H.putMarker(sd, '0004', 'a');   // marker-sealed
  own(sd, '0005', 'a', { owner: 'idE', sealed: true });
  own(sd, '0006', 'a', { owner: 'idF', legacy: true });
  own(sd, '0007', 'd', { owner: 'idG' });
  for (const id of ['idA', 'idB', 'idC', 'idD', 'idE', 'idF', 'idG', 'idNobody']) {
    const lib = A.lookupTrack(sd, id);
    assert.strictEqual(lib ? lib.stored : null, suitePick(sd, id), `parity for ${id}`);
  }
});

// ── resolveAttribution ───────────────────────────────────────────────────────────────────────────────
function mine() {
  const sd = store();
  own(sd, '0040', 'b', { owner: 'idMe' });
  return sd;
}
test('A-13 precedence: flag > env > lookup > blank, with sessionVia per rung', () => {
  const sd = mine();
  const env = { CLAUDE_CODE_SESSION_ID: 'idMe', CLAUDE_PID: '4242', TPM_SESSIONS_DIR: sd };
  assert.deepStrictEqual(A.resolveAttribution({ env }), { session: 'session-0040b', sessionVia: 'lookup' });
  assert.deepStrictEqual(A.resolveAttribution({ env: Object.assign({ TPM_SESSION_ID: '41' }, env) }), { session: 'session-0041', sessionVia: 'env' }, 'env beats a disagreeing lookup');
  assert.deepStrictEqual(A.resolveAttribution({ env: Object.assign({ TPM_SESSION_ID: '41' }, env), explicit: '12b' }), { session: 'session-0012b', sessionVia: 'flag' });
  assert.deepStrictEqual(A.resolveAttribution({ env, explicit: { session: '0012', track: 'c' } }), { session: 'session-0012c', sessionVia: 'flag' });
  assert.deepStrictEqual(A.resolveAttribution({ env: Object.assign({ TPM_SESSION_ID: 'garbage' }, env) }), { session: 'session-0040b', sessionVia: 'lookup' }, 'malformed env falls through');
  assert.deepStrictEqual(A.resolveAttribution({ env: {} }), { session: null, sessionVia: null });
  assert.deepStrictEqual(A.resolveAttribution({ env: { TPM_SESSION_ID: '0012a' } }), { session: 'session-0012', sessionVia: 'env' });
  assert.deepStrictEqual(A.resolveAttribution({ env: { CLAUDE_CODE_SESSION_ID: 'idMe' }, sessionsDir: sd, claudeSessionId: undefined }), { session: 'session-0040b', sessionVia: 'lookup' });
  assert.deepStrictEqual(A.resolveAttribution({ env: {}, claudeSessionId: 'idMe', sessionsDir: sd }), { session: 'session-0040b', sessionVia: 'lookup' }, 'claudeSessionId override');
});

test('A-14 degradation rows 1-11: each falls to blank without throwing', () => {
  const sd = mine();
  const base = { CLAUDE_CODE_SESSION_ID: 'idMe', CLAUDE_PID: '4242' };
  const blank = { session: null, sessionVia: null };
  assert.deepStrictEqual(A.resolveAttribution({ env: Object.assign({ TPM_SESSIONS_DIR: path.join(sd, 'gone') }, base) }), blank, '1 dir deleted');
  assert.deepStrictEqual(A.resolveAttribution({ env: { TPM_SESSIONS_DIR: sd } }), blank, '2 no claude id');
  for (const g of ['garbage', '4f1c2d3e-aaaa-bbbb-cccc-1234567890ab', '0012B', '99999', '   ', '']) {
    assert.deepStrictEqual(A.resolveAttribution({ env: { TPM_SESSION_ID: g, TPM_SESSIONS_DIR: path.join(sd, 'gone') } }), blank, '3 ' + g);
  }
  const file = path.join(tmpDir('attr-f2-'), 'f'); fs.writeFileSync(file, 'x');
  assert.deepStrictEqual(A.resolveAttribution({ env: Object.assign({ TPM_SESSIONS_DIR: file }, base) }), blank, '4 dir is a file');
  assert.deepStrictEqual(A.resolveAttribution({ env: base, explicit: 'junk' }), { session: null, sessionVia: null }, '11 malformed explicit to the resolver falls through (no sessions dir => blank)');
});

test('A-15 project-config rows 6-8: module disabled, unparseable config, outside any project', () => {
  const root = tmpDir('attr-proj-');
  const cfgDir = path.join(root, '.claude', 'claude-tpm');
  fs.mkdirSync(cfgDir, { recursive: true });
  const sd = path.join(cfgDir, 'sessions');
  own(sd, '0040', 'a', { owner: 'idMe' });
  const env = { CLAUDE_CODE_SESSION_ID: 'idMe' };
  const opts = { env, startDir: root };
  assert.strictEqual(SD.resolveSessionsDirQuiet(opts), sd, 'default dir under the marked project');
  assert.strictEqual(A.resolveAttribution(opts).session, 'session-0040');
  fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ not json');
  assert.strictEqual(A.resolveAttribution(opts).session, 'session-0040', '7 unparseable config -> default dir');
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ session: { enabled: false } }));
  assert.strictEqual(A.resolveAttribution(opts).session, null, '6 module disabled -> blank');
  assert.strictEqual(A.resolveAttribution({ env: { CLAUDE_CODE_SESSION_ID: 'idMe', TPM_SESSIONS_DIR: sd }, startDir: root }).session, 'session-0040', 'env dir still answers when disabled');
  fs.writeFileSync(path.join(cfgDir, 'config.json'), JSON.stringify({ session: { notes: { sessionsDir: 'custom/sess' } } }));
  own(path.join(root, 'custom', 'sess'), '0050', 'c', { owner: 'idMe' });
  assert.strictEqual(A.resolveAttribution(opts).session, 'session-0050c', 'configured notes.sessionsDir, relative to the root');
  // user layer wins
  const userCfg = path.join(root, 'user.json');
  fs.writeFileSync(userCfg, JSON.stringify({ session: { notes: { sessionsDir: sd } } }));
  assert.strictEqual(A.resolveAttribution({ env: Object.assign({ CLAUDE_TPM_USER_CONFIG: userCfg }, env), startDir: root }).session, 'session-0040', 'user layer overrides the project dir');
  const bare = tmpDir('attr-noproj-');
  assert.strictEqual(SD.resolveSessionsDirQuiet({ env: {}, startDir: bare }), null, '8 outside a project');
});

test('A-16 never throws and never prints, even with hostile input', () => {
  const rw = process.stdout.write; const re = process.stderr.write; let printed = '';
  process.stdout.write = (s) => { printed += s; return true; };
  process.stderr.write = (s) => { printed += s; return true; };
  const hostile = [
    undefined, null, 5, 'x', [], {}, { env: null }, { env: 'str' }, { explicit: {} }, { explicit: 12 }, { explicit: { session: {} } },
    { env: { get TPM_SESSION_ID() { throw new Error('boom'); } } },
    { env: { get CLAUDE_CODE_SESSION_ID() { throw new Error('boom'); } } },
    { sessionsDir: 12, env: { CLAUDE_CODE_SESSION_ID: 'x' } }, { startDir: 12, env: { CLAUDE_CODE_SESSION_ID: 'x' } },
    { get env() { throw new Error('boom'); } },
  ];
  try {
    for (const h of hostile) {
      const r = A.resolveAttribution(h);
      assert.ok(r && 'session' in r && 'sessionVia' in r);
    }
    A.parseExplicit({ get session() { throw new Error('boom'); } });
    A.lookupTrack({}, {}); SD.resolveSessionsDirQuiet({ get env() { throw new Error('boom'); } });
  } finally { process.stdout.write = rw; process.stderr.write = re; }
  assert.strictEqual(printed, '', 'nothing printed');
});

test('A-17 toEventFields: both keys or none; via must be a known rung', () => {
  assert.deepStrictEqual(A.toEventFields({ session: 'session-0001', sessionVia: 'env' }), { session: 'session-0001', sessionVia: 'env' });
  for (const bad of [null, undefined, {}, { session: null, sessionVia: null }, { session: '', sessionVia: 'env' }, { session: 'session-0001', sessionVia: 'bogus' }, { session: 'session-0001' }]) {
    assert.deepStrictEqual(A.toEventFields(bad), {});
  }
  assert.deepStrictEqual(A.VIA, ['flag', 'env', 'lookup']);
});

test('A-18 isolation audit: attribution.js / sessions-dir.js import nothing from tools/session|task|workflow', () => {
  for (const f of ['attribution.js', 'sessions-dir.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'lib', f), 'utf8');
    const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    for (const r of reqs) assert.ok(!/(session|task|workflow)\//.test(r) || r === './sessions-dir', `${f} requires ${r}`);
    assert.ok(reqs.every((r) => /^(\.\/(identity|sessions-dir|paths|tpm-config-overlay)|fs|path)$/.test(r)), `${f} requires ${reqs.join(',')}`);
  }
});

done('attribution.test.js');
