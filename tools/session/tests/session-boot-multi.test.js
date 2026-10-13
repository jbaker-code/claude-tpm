'use strict';
/**
 * session-boot-multi.test.js — phase 13 DoD A, D, E, F, G and the three reader-honesty fixes, through the REAL CLIs.
 *   A  per-track blocks (state, handoff verbatim, open items, file locations) + ONE combined list      -> golden/boot-read-3track.expected.txt
 *   D  a live / abandoned track is LABELLED, never hidden
 *   E  carry-forward keeps the source session AND track letter; the sealed source records stay byte-identical
 *   F  compose `open` carries the blocks and says several instances ran (generated in code)
 *   G  boot never crashes: a corrupt track degrades to "read this file directly", the others still print
 *   E1 a null id / an unowned record is never excluded as "yours";  E2 stray track-like files surface, session-notes.md does not;
 *   E3 a marker-sealed track carries its real state;  lone-a marker -> a `note:` line.
 * Every CLI runs with a clean env and an explicit fake Claude id / pid.
 *
 * Run: node tests/session-boot-multi.test.js        (re-capture the golden only deliberately: TPM_PIN_CAPTURE=1)
 */
const { assert, test, done, fs, path } = require('./helpers/harness');
const H = require('./helpers/track-helpers');
const F = require('./helpers/fixed-multi');
const tt = require('./helpers/three-track');
const br = require('../tpm-session-boot-read');
const compose = require('../tpm-session-compose');

const D = F.id('d');
const boot = (sd, who, extra) => H.run(H.BOOT_READ, ['--sessions-dir', sd, ...(extra || [])], who ? { id: who, pid: 77001 } : {});
const norm = (sd, s) => s.split(sd).join('<SD>');
const GOLDEN = path.join(__dirname, 'golden', 'boot-read-3track.expected.txt');

// ── A: the sample of output-shapes.md 2.2, byte for byte ─────────────────────────────
test('A: three-track prior (a sealed by owner, b sealed by marker, c live) -> the per-track pickup, golden', () => {
  const sd = F.scratch('bm-a-'); F.threeTrack(sd);
  const r = boot(sd, D);
  assert.strictEqual(r.code, 0);
  assert.strictEqual(r.stderr, '');
  const text = norm(sd, r.stdout);
  if (process.env.TPM_PIN_CAPTURE === '1') { fs.writeFileSync(GOLDEN, text); return; }
  assert.ok(fs.existsSync(GOLDEN), 'golden missing (capture with TPM_PIN_CAPTURE=1 after reading the output against output-shapes.md 2.2)');
  assert.strictEqual(text, fs.readFileSync(GOLDEN, 'utf8'));
});

test('A: per-track blocks come in letter order; the combined list is ordered and counts every open item', () => {
  const sd = F.scratch('bm-a2-'); F.threeTrack(sd);
  const out = boot(sd, D).stdout;
  const heads = [...out.matchAll(/^=== TRACK ([a-z]) · /gm)].map((m) => m[1]);
  assert.deepStrictEqual(heads, ['a', 'b', 'c']);
  assert.ok(/^== PRIOR SESSION 0001 · .*· 3 parallel tracks ==$/m.test(out));
  assert.ok(/^== OPEN PUNCHLIST, ALL TRACKS ABOVE \(4\) ==$/m.test(out));
  const list = out.split('== OPEN PUNCHLIST, ALL TRACKS ABOVE (4) ==\n')[1].split('\n');
  const want = ['#1a.1 [track a] · fix', '#1b.1 [track b] · port', '#1b.2 [track b] · write', '#1c.1 [track c, live] · bench'];
  want.forEach((w, i) => assert.ok(list[i].startsWith(w), `list line ${i}: ${list[i]}`));
  assert.ok(/ran independently/.test(list[4]));
  for (const t of ['a', 'b', 'c']) assert.ok(out.includes(`--session 0001 --track ${t} --style human`), `export hint for ${t}`);
});

test('A: the handoff is verbatim (all four parts, per track), items carry their display ids', () => {
  const sd = F.scratch('bm-a3-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), closed: F.at('08:30'), items: ['one'] }));
  const rec = F.mk('0001', 'b', { owner: F.id('b'), opened: F.at('08:01'), closed: F.at('08:31'), items: [] });
  rec.handoff = { where: 'WHERE-B', next: 'NEXT-B', in_flight: ['fl1', 'fl2'], must_not_redo: ['mnr1'], updatedAt: F.at('08:31') };
  F.put(sd, rec);
  const out = boot(sd, D).stdout;
  assert.ok(out.includes('**Where we are:**\nWHERE-B\n\n**Next:**\nNEXT-B\n\n**In flight:**\n- fl1\n- fl2\n\n**Must not redo:**\n- mnr1'));
  assert.ok(/^#1a\.1 · one /m.test(out), 'track a id gains its letter in a multi-track session');
});

// ── D: live / abandoned are labelled, not hidden ────────────────────────────────────
test('D: the live track says "handoff may not be final" + its last save + liveness; the abandoned one says who sealed, when, and why', () => {
  const sd = F.scratch('bm-d-'); F.threeTrack(sd);
  const out = boot(sd, D).stdout;
  assert.ok(/=== TRACK c · STILL LIVE \(handoff may not be final\); last save 2026-10-05T00:05:36-07:00; owner process gone ===/.test(out), out);
  assert.ok(/=== TRACK b · SEALED AS ABANDONED 2026-10-05T00:05:36-07:00 by claude dddddddd \(abandoned, "owner window closed"\); no final handoff was written ===/.test(out));
  assert.ok(/--- LAST-SAVED HANDOFF \(not a final handoff; read fully\) ---\n\*\*Where we are:\*\*\nExporter half ported\./.test(out), 'its last save is shown');
  assert.ok(/=== TRACK a · SEALED by its owner 2026-10-05T00:05:36-07:00 ===/.test(out));
});

test('E3: a marker-sealed track (record closedAt null, .md "open") is labelled from trackState, never from the record', () => {
  const sd = F.scratch('bm-e3-'); F.threeTrack(sd);
  const b = JSON.parse(fs.readFileSync(path.join(sd, 'session-0001', 'session-0001-b.json'), 'utf8'));
  assert.strictEqual(b.meta.closedAt, null, 'fixture: the record itself still says open');
  assert.ok(/TRACK b · SEALED AS ABANDONED/.test(boot(sd, D).stdout));
});

// ── --track narrowing ────────────────────────────────────────────────────────────────
test('--track b (letter) and --track <owner id prefix> narrow to that track; the combined list follows', () => {
  const sd = F.scratch('bm-t-'); F.threeTrack(sd);
  for (const sel of ['b', F.id('b').slice(0, 8), F.id('b').slice(0, 12).toUpperCase()]) {
    const r = boot(sd, D, ['--track', sel]);
    assert.strictEqual(r.code, 0);
    assert.deepStrictEqual([...r.stdout.matchAll(/^=== TRACK ([a-z]) · /gm)].map((m) => m[1]), ['b'], sel);
    assert.ok(/== OPEN PUNCHLIST, ALL TRACKS ABOVE \(2\) ==/.test(r.stdout));
  }
});
test('--track with a malformed or unmatched selector never crashes: a note / a clear message, exit 0', () => {
  const sd = F.scratch('bm-t2-'); F.threeTrack(sd);
  const bad = boot(sd, D, ['--track', 'bbbb']);
  assert.strictEqual(bad.code, 0);
  assert.ok(/note: --track "bbbb" ignored/.test(bad.stdout) && (bad.stdout.match(/^=== TRACK /gm) || []).length === 3, 'ignored with a note, all tracks shown');
  const none = boot(sd, D, ['--track', 'q']);
  assert.strictEqual(none.code, 0);
  assert.ok(/no pending track matches --track q/.test(none.stdout));
  assert.strictEqual(boot(sd, D, ['--track']).code, 2, 'a --track with no value is a usage error (phase 15)');
});

// ── G: boot never crashes ────────────────────────────────────────────────────────────
test('G: a corrupt track b degrades to "read this file directly"; a and c still print; exit 0', () => {
  const sd = F.scratch('bm-g-'); F.threeTrack(sd);
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-b.json'), '{ corrupt');
  fs.unlinkSync(path.join(sd, 'session-0001', 'session-0001-b.sealed'));
  const r = boot(sd, D);
  assert.strictEqual(r.code, 0);
  assert.ok(/=== TRACK b · UNREADABLE \(corrupt\) ===\nread this file directly: .*session-0001-b\.json/.test(r.stdout), r.stdout);
  assert.ok(/=== TRACK a · SEALED by its owner/.test(r.stdout) && /=== TRACK c · STILL LIVE/.test(r.stdout), 'the others still print');
  assert.ok(/ALL TRACKS ABOVE \(2\)/.test(r.stdout), 'the combined list counts only the readable tracks');
});
test('G: a marker with no record (and one with a corrupt marker) are blocks, never a crash', () => {
  const sd = F.scratch('bm-g2-'); F.threeTrack(sd);
  fs.unlinkSync(path.join(sd, 'session-0001', 'session-0001-b.json'));
  const r = boot(sd, D);
  assert.strictEqual(r.code, 0);
  assert.ok(/=== TRACK b · UNREADABLE \(sealed, record unreadable\) ===/.test(r.stdout), r.stdout);
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-b.sealed'), 'not json');
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-b.json'), JSON.stringify(F.mk('0001', 'b', { owner: F.id('b'), opened: F.at('00:01'), items: [] })));
  const r2 = boot(sd, D);
  assert.strictEqual(r2.code, 0);
  assert.ok(/TRACK b · SEALED AS ABANDONED \(time unknown\)|TRACK b · SEALED AS ABANDONED .* by another session \(reason unknown\)/.test(r2.stdout), r2.stdout);
});
test('G: a record that fails while RENDERING (a hostile punchlist) costs only its own block', () => {
  const sd = F.scratch('bm-g3-'); F.threeTrack(sd);
  const real = br.buildPickup;
  assert.strictEqual(typeof real, 'function');
  const pu = br.computePickup(sd, null);
  const c = pu.pending.find((e) => e.track.track === 'c').track;
  Object.defineProperty(c.record, 'punchlist', { get() { throw new Error('boom'); } });
  const T = require('../lib/session-tracks');
  const orig = T.scanSessions;
  T.scanSessions = (...a) => { const s = orig(...a); for (const x of s.sessions) for (const t of x.tracks) if (t.track === 'c') Object.defineProperty(t.record, 'punchlist', { get() { throw new Error('boom'); } }); return s; };
  try {
    const out = br.buildPickup(sd, { number: null, fallback: null }, { identity: {} });
    assert.ok(/=== TRACK c · COULD NOT BE RENDERED \(boom\) ===\nread this file directly:/.test(out), out);
    assert.ok(/=== TRACK a · SEALED/.test(out) && /=== TRACK b · SEALED AS ABANDONED/.test(out));
  } finally { T.scanSessions = orig; }
});
test('G: never crashes boot whatever the store looks like (exit 0): unreadable dir, a file named session-0001, junk in a track folder', () => {
  const sd = F.scratch('bm-g4-');
  fs.writeFileSync(path.join(sd, 'session-0001'), 'a file, not a folder');
  fs.mkdirSync(path.join(sd, 'session-0002'));
  fs.writeFileSync(path.join(sd, 'session-0002', 'session-0002-b.json'), '');
  fs.writeFileSync(path.join(sd, 'session-0002', 'session-0002.sealed'), '{}');
  assert.strictEqual(boot(sd, D).code, 0);
  assert.strictEqual(boot(path.join(sd, 'nope'), D).code, 0);
});

// ── E1: reader honesty ───────────────────────────────────────────────────────────────
test('E1: a caller with NO readable id, and one UNOWNED live record: the record is shown (never "first session") with a note', () => {
  const sd = F.scratch('bm-e1-');
  F.put(sd, F.mk('0001', 'a', { owner: null, opened: F.at('08:00'), where: 'UNOWNED-WORK', items: ['x'] }));
  const r = boot(sd, null);
  assert.strictEqual(r.code, 0);
  assert.ok(!/looks like the first session/.test(r.stdout), r.stdout);
  assert.ok(/UNOWNED-WORK/.test(r.stdout));
  assert.ok(/^note: your Claude session id is unreadable, so no session was excluded as yours; session 0001 is shown below and may be your own live session$/m.test(r.stdout), r.stdout);
});
test('E1: a caller WITH an id and one unowned live record: shown, with the "no recorded owner" note', () => {
  const sd = F.scratch('bm-e1b-');
  F.put(sd, F.mk('0001', 'a', { owner: null, opened: F.at('08:00'), where: 'UNOWNED-WORK' }));
  const r = boot(sd, F.id('z'));
  assert.ok(/UNOWNED-WORK/.test(r.stdout) && /the open track of session 0001 has no recorded owner/.test(r.stdout), r.stdout);
});
test('E1: a caller that OWNS a live session still has it excluded (no note, the lower session is the pickup)', () => {
  const sd = F.scratch('bm-e1c-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), closed: F.at('08:30'), where: 'LOWER' }));
  F.put(sd, F.mk('0002', 'a', { owner: F.id('z'), opened: F.at('09:00'), where: 'MINE-LIVE' }));
  const r = boot(sd, F.id('z'));
  assert.ok(/LOWER/.test(r.stdout) && !/MINE-LIVE/.test(r.stdout) && !/^note:/m.test(r.stdout), r.stdout);
});

// ── E2: strays and hollow folders ────────────────────────────────────────────────────
test('E2: a stray .json / .sealed-looking file is surfaced; session-notes.md is NOT; a hollow NEWER folder is noted', () => {
  const sd = F.scratch('bm-e2-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), closed: F.at('08:30'), items: [] }));
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-notes.md'), 'hand-written');
  assert.ok(!/unrecognised/.test(boot(sd, D).stdout), 'session-notes.md must not raise a permanent false alarm');
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-a.json'), '{}');
  fs.writeFileSync(path.join(sd, 'session-0001', 'session-0001-x.sealed.old'), '{}');
  fs.mkdirSync(path.join(sd, 'session-0003'));
  const out = boot(sd, D).stdout;
  assert.ok(/note: 2 unrecognised file\(s\) in session folders, NOT treated as tracks: .*session-0001-a\.json.*session-0001-x\.sealed\.old/.test(out), out);
  assert.ok(!/session-notes/.test(out));
  assert.ok(/note: 1 newer session folder\(s\) hold no readable record \(0003\); a claim in progress or a crashed open - not shown/.test(out), out);
});

// ── lone track a sealed by a marker ───────────────────────────────────────────────────
test('lone track a sealed by ANOTHER instance (marker): a `note:` line above the otherwise unchanged pickup', () => {
  const sd = F.scratch('bm-lone-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), last: F.at('08:10'), where: 'LONE-WORK', items: ['i'] }));
  F.marker(sd, '0001', 'a', { at: F.at('09:00'), by: F.id('d'), reason: 'abandoned', note: 'dead', owner: F.id('a') });
  const out = boot(sd, F.id('z')).stdout;
  assert.ok(out.startsWith('note: track a of session 0001 was SEALED AS ABANDONED 2026-10-05T09:00:00-07:00 by claude dddddddd (abandoned, "dead"); no final handoff was written; the handoff below is its last save\n== PRIOR SESSION 0001 · '), out);
  assert.ok(/--- HANDOFF \(read fully\) ---\n\*\*Where we are:\*\*\nLONE-WORK/.test(out));
  // everything below the note is today's single layout
  assert.ok(!/=== TRACK/.test(out));
});
test('lone track a sealed by a marker: `review` keeps stdout and says so on stderr', () => {
  const sd = F.scratch('bm-lone2-');
  F.put(sd, F.mk('0001', 'a', { owner: F.id('a'), opened: F.at('08:00'), last: F.at('08:10') }));
  F.marker(sd, '0001', 'a', { at: F.at('09:00'), by: F.id('d'), reason: 'abandoned', owner: F.id('a') });
  const r = H.run(path.join(H.OPS, '..', 'tpm-session-export.js'), ['--sessions-dir', sd, '--session', '0001', '--style', 'human'], {});
  assert.strictEqual(r.code, 0);
  assert.ok(/note: track a of session 0001 was SEALED AS ABANDONED/.test(r.stderr), r.stderr);
});

// ── E: carry-forward keeps the track of origin ────────────────────────────────────────
test('E: open --prior-session-path from track b stamps "0001b"; from track a stays "0001"; sealed sources are byte-identical', () => {
  const sd = F.scratch('bm-e-'); F.threeTrack(sd);
  const before = JSON.stringify(tt.shas(sd));
  const model = require('../lib/session-model');
  const bPath = path.join(sd, 'session-0001', 'session-0001-b.json');
  const aPath = path.join(sd, 'session-0001', 'session-0001.json');
  const NEW = F.id('n');
  for (const [src, want, srcId] of [[bPath, '0001b', '1b.1'], [aPath, '0001', '1a.1']]) {
    const dest = F.scratch('bm-e-dest-');
    const r = H.run(H.OPS, ['open', '--sessions-dir', dest, '--session', '2', '--session-id', NEW, '--prior-session-path', src], { id: NEW, pid: 4242 });
    assert.strictEqual(r.code, 0, r.stderr);
    const rec = model.loadSession(path.join(dest, 'session-0002', 'session-0002.json'));
    const carried = rec.punchlist.filter((it) => it.events.some((e) => e.op === 'carry-in'));
    assert.ok(carried.length >= 1);
    for (const it of carried) assert.strictEqual(it.events.find((e) => e.op === 'carry-in').fromSession, want, `${src}`);
    const md = fs.readFileSync(path.join(dest, 'session-0002', 'session-0002.md'), 'utf8');
    assert.ok(md.includes(`carried from ${want}`), md);
  }
  assert.strictEqual(JSON.stringify(tt.shas(sd)), before, 'the sealed source records (and markers) are byte-identical afterwards');
});
test('E: punchlist carry-in keeps the track too (phase 12 label), and both open paths agree', () => {
  const ids = require('../lib/session-ids');
  assert.strictEqual(ids.fromSessionLabel({ number: '0001', track: 'b' }), '0001b');
  assert.strictEqual(ids.fromSessionLabel({ number: '0001' }), '0001');
  assert.strictEqual(ids.fromSessionLabel({ number: '0001', track: 'a' }), '0001');
  const model = require('../lib/session-model');
  const prior = F.mk('0003', 'c', { owner: F.id('c'), opened: F.at('08:00'), items: ['carry me'] });
  for (const rec of [
    model.openSession({ number: '0004', sessionId: 's', priorSession: prior }),
    model.openTrack({ number: '0004', track: 'a', identity: {}, priorSession: prior }),
  ]) assert.strictEqual(rec.punchlist[0].events[0].fromSession, '0003c');
});

// ── F: compose ──────────────────────────────────────────────────────────────────────
test('F: pickupLead is generated in code: several instances -> says so + counts the blocks; single -> the original wording', () => {
  const multi = compose.pickupLead('x\n=== TRACK a · SEALED ===\n...\n=== TRACK b · STILL LIVE ===\n');
  assert.ok(/SEVERAL Claude instances ran in parallel \(2 track blocks below\)/.test(multi) && /read EVERY block/.test(multi));
  assert.strictEqual(compose.pickupLead('== PRIOR SESSION 0001 · x/ ==\n'), 'Prior-session pickup (pre-read by the composer; read it fully):');
});
test('F: `compose --mode open` for a multi-track prior includes the per-track blocks and the several-instances line; no template loop', () => {
  const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'bm-f-'));
  fs.mkdirSync(path.join(root, '.claude', 'claude-tpm'), { recursive: true });
  const sd = path.join(root, '.claude', 'claude-tpm', 'sessions');
  F.threeTrack(sd);
  const text = compose.compose('open', { config: { session: { enabled: true, notes: { enabled: true } }, tasks: { enabled: false } }, projectRoot: root, sessionsDir: sd, env: { CLAUDE_CODE_SESSION_ID: D } }).text;
  assert.ok(/SEVERAL Claude instances ran in parallel \(3 track blocks below\)/.test(text), text.slice(0, 400));
  for (const t of ['a', 'b', 'c']) assert.ok(text.includes(`=== TRACK ${t} · `), `track ${t} block present`);
  assert.ok(text.includes('== OPEN PUNCHLIST, ALL TRACKS ABOVE (4) =='));
  assert.ok(/Read each handoff FULLY/.test(text));
  const tpl = fs.readFileSync(path.join(__dirname, '..', 'templates', 'open.md'), 'utf8');
  assert.ok(!/tpm:(each|for|loop)/.test(tpl), 'the template engine has no loop; per-track repetition is generated in boot-read');
});
test('F: the save/footer templates are track-neutral (they name the track-b..z files too)', () => {
  const t = (n) => fs.readFileSync(path.join(__dirname, '..', 'templates', n), 'utf8');
  assert.ok(/session-NNNN-<letter>\.json/.test(t('_save-ritual.md')) && /session-NNNN-<letter>\.json/.test(t('_footer.md')));
});

// ── liveness seam + cap ───────────────────────────────────────────────────────────────
test('liveness comes through an injectable seam (no real pid needed) and is capped (each lookup may spawn one `ps`)', () => {
  const sd = F.scratch('bm-live-');
  const host = require('os').hostname();
  for (let i = 0; i < 15; i += 1) {
    const l = String.fromCharCode(97 + i);
    F.put(sd, F.mk('0001', l, { owner: F.id(l), opened: F.at('08:00'), pid: 4000 + i, items: [] }));
  }
  let probes = 0;
  const out = br.buildPickup(sd, { number: null, fallback: null }, { identity: { hostname: host, claudePid: 1 }, livenessOpts: { isAlive: () => { probes += 1; return true; }, startedAt: () => null } });
  assert.strictEqual((out.match(/owner process running/g) || []).length, 12);
  assert.strictEqual((out.match(/liveness not checked/g) || []).length, 3);
  assert.strictEqual(probes, 12);
});

done('session-boot-multi.test');
