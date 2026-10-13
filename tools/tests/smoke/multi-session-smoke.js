#!/usr/bin/env node
/*
 * multi-session-smoke.js — LIVE two-instance smoke for multi-session support (tracks + store locks + attribution).
 *
 * WHAT IT DOES
 *   Creates a scratch project, starts TWO real headless `claude -p` processes against it at the same time (each has
 *   its own genuine Claude session id and process id), and has each run a FIXED list of `tpm` commands through a tiny
 *   logging wrapper (harness/step.js). Results are read from the files the wrapper writes (steps.jsonl + the stores),
 *   never from what the model says. A third short instance then opens after both close (the two-block pickup).
 *   `--lone` instead runs ONE instance open -> save -> task add -> close and asserts it meets no gate/refusal/lock.
 *   `--launcher` runs a real `tpm-child-launch.sh --headless` child and shows the child's task history attributing to
 *   the parent via TPM_SESSION_ID (the documented #1175 known limitation; observed, not asserted as a bug).
 *
 * NOT part of any default test run (spawns real `claude`, costs a few cents, needs network + auth).
 *   Invoke explicitly:  node tools/tests/smoke/multi-session-smoke.js --yes [--lone | --launcher] [--model haiku]
 *
 * PREREQUISITES  `claude` on PATH (Claude Code, logged in), node >= 18. Nothing is installed or modified outside the scratch dir.
 * COST           ~3-4 haiku sessions of ~10 short tool calls each (a few cents); ~1-3 minutes wall clock.
 * SAFETY
 *   - Runs ONLY in a scratch dir (default <workspace>/tmp/multi-smoke-<ts>/; refuses a dir inside this tool tree).
 *   - Permission posture is a SCOPED ALLOW-LIST, never --dangerously-skip-permissions: only `Bash(node ./harness/step.js:*)`
 *     is allowed (and only the Bash tool exists), so a deviating model cannot run anything else (it is denied, not prompted).
 *     step.js itself only ever execs `node <this tree>/tools/tpm.js <args>`.
 *   - Exactly two overlapping real instances (a third only after both finished). Child env is stripped of the caller's
 *     CLAUDE and TPM env ids so each child resolves its own.
 *
 * EXIT 0 = every assertion passed; 1 = an assertion failed; 2 = usage/prereq.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const TREE = path.resolve(__dirname, '..', '..', '..'); // the claude-tpm tree this script lives in
const TPM = path.join(TREE, 'tools', 'tpm.js');
const LAUNCHER = path.join(TREE, 'tools', 'child-session', 'tpm-child-launch.sh');

function usage(code) {
  process.stderr.write([
    'usage: node multi-session-smoke.js --yes [--lone | --launcher] [--model haiku] [--scratch <dir>] [--timeout <secs>]',
    '  --yes       required: acknowledges this spawns real `claude` processes (cost + network).',
    '  --lone      one instance, open -> save -> task add -> close; asserts no gate/refusal/lock.',
    '  --launcher  real tpm-child-launch.sh --headless child; observes the child TPM_SESSION_ID attribution.',
    '  --scratch   scratch dir (default <workspace>/tmp/multi-smoke-<ts>); must not be inside the tool tree.',
    '', ''].join('\n'));
  process.exit(code);
}
const argv = process.argv.slice(2);
const opt = { model: 'haiku', timeout: 240, mode: 'pair', yes: false, scratch: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--yes') opt.yes = true;
  else if (a === '--lone') opt.mode = 'lone';
  else if (a === '--launcher') opt.mode = 'launcher';
  else if (a === '--model') opt.model = argv[++i];
  else if (a === '--scratch') opt.scratch = argv[++i];
  else if (a === '--timeout') opt.timeout = Number(argv[++i]);
  else if (a === '-h' || a === '--help') usage(0);
  else { process.stderr.write('unknown arg: ' + a + '\n'); usage(2); }
}
if (!opt.yes) { process.stderr.write('refusing to run without --yes (spawns real claude processes).\n'); usage(2); }
if (cp.spawnSync('claude', ['--version'], { encoding: 'utf8' }).status !== 0) { process.stderr.write('`claude` not found on PATH.\n'); process.exit(2); }

const ts = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '');
const SCRATCH = path.resolve(opt.scratch || path.join(TREE, '..', 'tmp', `multi-smoke-${opt.mode}-${ts}`));
if (SCRATCH === TREE || SCRATCH.startsWith(TREE + path.sep)) { process.stderr.write('scratch dir must not be inside the tool tree.\n'); process.exit(2); }
const HARNESS = path.join(SCRATCH, 'harness');
fs.mkdirSync(path.join(SCRATCH, '.claude', 'claude-tpm'), { recursive: true });
fs.mkdirSync(path.join(HARNESS, 'marks'), { recursive: true });
fs.writeFileSync(path.join(HARNESS, 'handoff.txt'), 'smoke handoff text\n');

// ---- the logging wrapper the instances are allowed to run (the ONLY thing on the allow-list) ----
fs.writeFileSync(path.join(HARNESS, 'step.js'), `'use strict';
// usage: node ./harness/step.js <inst> <label> [--wait <mark,mark>] -- <tpm args...>
const fs = require('fs'), path = require('path'), cp = require('child_process');
const TPM = ${JSON.stringify(TPM)};
const argv = process.argv.slice(2);
const inst = argv[0], label = argv[1];
let i = 2, wait = [];
if (argv[i] === '--wait') { wait = argv[i + 1].split(','); i += 2; }
if (argv[i] === '--') i++;
const args = argv.slice(i);
const root = path.resolve(__dirname, '..');
const marks = path.join(__dirname, 'marks');
const t0 = Date.now();
let waited = 0;
for (const m of wait) { while (!fs.existsSync(path.join(marks, m))) { if (Date.now() - t0 > 150000) { waited = -1; break; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); } }
const startedAt = new Date().toISOString();
let rc = 0, out = '';
if (args.length) {
  const r = cp.spawnSync(process.execPath, [TPM, ...args], { cwd: root, encoding: 'utf8' });
  rc = r.status == null ? 255 : r.status; out = (r.stdout || '') + (r.stderr || '');
}
const rec = { inst, label, args, rc, startedAt, endedAt: new Date().toISOString(), waitTimedOut: waited === -1,
  claudeSessionId: process.env.CLAUDE_CODE_SESSION_ID || null, claudePid: process.env.CLAUDE_PID || null,
  tpmSessionIdEnv: process.env.TPM_SESSION_ID || null, out };
fs.appendFileSync(path.join(__dirname, 'steps.jsonl'), JSON.stringify(rec) + '\\n');
fs.writeFileSync(path.join(marks, inst + '-' + label), startedAt);
console.log(inst + ' ' + label + ' done (exit ' + rc + ')');
process.exit(0); // always 0: the model must not react to a non-zero (some refusals are the expected result)
`);

const SD = '--sessions-dir=.claude/claude-tpm/sessions';
const TD = '--tasks-dir=.claude/claude-tpm/tasks';
const S = (...a) => ['session', ...a, '--sessions-dir', '.claude/claude-tpm/sessions'];
const T = (...a) => ['task', ...a, '--tasks-dir', '.claude/claude-tpm/tasks'];
void SD; void TD;
// step = [label, waitMarks|null, tpmArgs]
const HF = ['import-handoff', '--session', '0001', '--txt-file', 'harness/handoff.txt', '--next', 'next-step'];
const PLANS = {
  I1: [
    ['a01', null, S('current', '--open')],
    ['a02', null, S('save', '--session', '0001')],
    ['a03', null, S('punchlist', '--session', '0001', '--action', 'add', '--text', 'I1-item')],
    ['a04', ['I2-b04'], S('punchlist', '--session', '0001', '--action', 'close', '--item', '1b.1')], // refused: I2's item
    ['a05', ['I2-b05'], T('add', '--headline', 'I1-task-1')],
    ['a06', null, T('add', '--headline', 'I1-task-2')],
    ['a07', null, T('add', '--headline', 'I1-task-3')],
    ['a08', ['I2-b07'], S(...HF)],
    ['a09', null, S('close', '--session', '0001')],
  ],
  I2: [
    ['b01', ['I1-a01'], S('current', '--open')], // refused: I1's live track
    ['b02', null, S('current', '--open', '--parallel')],
    ['b03', null, S('save', '--session', '0001')],
    ['b04', null, S('punchlist', '--session', '0001', '--action', 'add', '--text', 'I2-item')],
    ['b05', ['I1-a04'], S('punchlist', '--session', '0001', '--action', 'close', '--item', '1a.1')], // refused: I1's item
    ['b06', null, T('add', '--headline', 'I2-task-1')],
    ['b07', null, T('add', '--headline', 'I2-task-2')],
    ['b08', null, T('add', '--headline', 'I2-task-3')],
    ['b09', ['I1-a08'], S(...HF)],
    ['b10', null, S('close', '--session', '0001')],
  ],
  I3: [
    ['c01', null, S('current', '--open')],
    ['c02', null, S('boot-read')],
  ],
  LONE: [
    ['l01', null, S('current', '--open')],
    ['l02', null, S('save', '--session', '0001')],
    ['l03', null, T('add', '--headline', 'lone-task-1')],
    ['l04', null, S('punchlist', '--session', '0001', '--action', 'add', '--text', 'lone-item')], // the pre-existing close guard needs one
    ['l05', null, S(...HF)],
    ['l06', null, S('close', '--session', '0001')],
  ],
};
// the I2 b04 -> a04 / b05 -> a05 sync points above reference "end of step" marks; a05/b06 start together (see wait lists).
// task adds overlap: a05 waits for I2-b05 end, b06 waits for I1-a04 end (via b05's wait). Good enough overlap + no deadlock.

function promptFor(inst) {
  const lines = PLANS[inst].map(([label, wait, args], n) => {
    const w = wait ? ` --wait ${wait.join(',')}` : '';
    return `${n + 1}. node ./harness/step.js ${inst} ${label}${w} -- ${args.join(' ')}`;
  });
  return [
    'You are a command runner. Run EVERY numbered command below, in order, each as its own separate Bash tool call, copied EXACTLY as written (do not edit, quote, reorder, combine, skip or add anything).',
    'Some commands wait up to a couple of minutes for another process; just let them finish. A command that prints "(exit 1)" or similar is EXPECTED - do not retry or react, just go on to the next one.',
    'Do not run any other command. After the last one reply with the single word DONE.',
    '', ...lines, ''].join('\n');
}

function cleanEnv() {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE|ANTHROPIC_CODE)/.test(k) && !/^(CLAUDE_CONFIG_DIR)$/.test(k)) continue;
    if (/^TPM_/.test(k) || k === 'CLAUDECODE') continue;
    e[k] = v;
  }
  return e;
}
function spawnClaude(inst) {
  const args = ['-p', promptFor(inst), '--model', opt.model, '--tools', 'Bash',
    '--allowedTools', 'Bash(node ./harness/step.js:*)', '--setting-sources', 'project', '--output-format', 'json'];
  fs.writeFileSync(path.join(HARNESS, `prompt-${inst}.txt`), promptFor(inst));
  const child = cp.spawn('claude', args, { cwd: SCRATCH, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => child.kill('SIGTERM'), opt.timeout * 1000);
  return new Promise((res) => child.on('close', (code) => { clearTimeout(timer); fs.writeFileSync(path.join(HARNESS, `claude-${inst}.json`), out); res({ inst, code, out }); }));
}

const results = [];
function check(row, name, ok, detail) {
  results.push({ row, name, ok: !!ok, detail: detail || '' });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  [${row}] ${name}${detail ? '  -- ' + detail : ''}\n`);
}
function steps() {
  const f = path.join(HARNESS, 'steps.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const step = (label) => steps().find((s) => s.label === label);
function tpmDirect(args) { // run by this script itself with a stripped env, never the caller's ids
  const r = cp.spawnSync(process.execPath, [TPM, ...args], { cwd: SCRATCH, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  return { rc: r.status, out: (r.stdout || '') + (r.stderr || '') };
}
function locksLeft() {
  const found = [];
  (function walk(d) { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) { if (n.name !== 'harness') walk(p); } else if (/lock/i.test(n.name)) found.push(p); } })(path.join(SCRATCH, '.claude'));
  return found;
}
function readTasks() {
  const dir = path.join(SCRATCH, '.claude', 'claude-tpm', 'tasks', 'bodies');
  const out = [];
  if (!fs.existsSync(dir)) return out;
  (function walk(d) { for (const n of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, n.name); if (n.isDirectory()) walk(p); else if (/^task-\d+\.json$/.test(n.name)) out.push(JSON.parse(fs.readFileSync(p, 'utf8'))); } })(dir);
  return out;
}
function bodyMdCount() {
  const dir = path.join(SCRATCH, '.claude', 'claude-tpm', 'tasks', 'bodies');
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/^task-\d+\.md$/.test(e.name)) n++; } })(dir);
  return n;
}
function doctors(row) {
  const td = tpmDirect(['task', 'doctor', '--tasks-dir', '.claude/claude-tpm/tasks']);
  const sd = tpmDirect(['session', 'doctor', '--sessions-dir', '.claude/claude-tpm/sessions']);
  check(row, 'task doctor clean', td.rc === 0 && /Clean/.test(td.out), `rc=${td.rc}`);
  check(row, 'session doctor clean', sd.rc === 0 && /0 invalid/.test(sd.out) && /0 drift/.test(sd.out), `rc=${sd.rc}`);
  const l = locksLeft();
  check(row, 'no lock left behind', l.length === 0, l.join(', '));
}

async function runPair() {
  process.stdout.write(`scratch: ${SCRATCH}\nmodel: ${opt.model}\n`);
  const p1 = spawnClaude('I1');
  // start I2 only once I1's first step has really run, so I1 owns track a (otherwise the race decides who is "first")
  const t0 = Date.now();
  while (!fs.existsSync(path.join(HARNESS, 'marks', 'I1-a01')) && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 500));
  const p2 = spawnClaude('I2');
  await Promise.all([p1, p2]);
  const need = PLANS.I1.length + PLANS.I2.length;
  check('B', `all ${need} fixed steps of both instances ran`, steps().filter((s) => /^I[12]$/.test(s.inst)).length === need, `got ${steps().length}`);
  const s = (l) => step(l) || { rc: -1, out: '', claudeSessionId: null };
  const a01 = s('a01'), b01 = s('b01'), b02 = s('b02');
  check('B', 'two distinct real Claude session ids', a01.claudeSessionId && s('b01').claudeSessionId && a01.claudeSessionId !== s('b01').claudeSessionId, `${a01.claudeSessionId} / ${b01.claudeSessionId}`);
  check('B', 'two distinct real Claude pids', a01.claudePid && b01.claudePid && a01.claudePid !== b01.claudePid, `${a01.claudePid} / ${b01.claudePid}`);
  check('B', 'I1 open -> track a, new session', a01.rc === 0 && /"track": "a"/.test(a01.out));
  check('B', "I2 open REFUSED (exit 3) listing I1's track, reported running/live",
    b01.rc === 3 && /track a of 0001/.test(b01.out) && /owner process running/.test(b01.out) && /\[live\]/.test(b01.out) && /"status": "running"/.test(b01.out), `rc=${b01.rc}`);
  check('B', 'I2 opens a parallel track b', b02.rc === 0 && /"track": "b"/.test(b02.out) && /"gate": "parallel"/.test(b02.out));
  check('B', 'both save', s('a02').rc === 0 && s('b03').rc === 0);
  check('B', 'both add punchlist items (1.1 or 1a.1 / 1b.1; track a prints bare if added before track b existed)', /added #1a?\.1/.test(s('a03').out) && /added #1b\.1/.test(s('b04').out));
  check('B', "I1 refused closing I2's item (ECROSS_TRACK, nothing changed)", s('a04').rc !== 0 && /ECROSS_TRACK/.test(s('a04').out) && /Nothing was changed/.test(s('a04').out));
  check('B', "I2 refused closing I1's item (ECROSS_TRACK, nothing changed)", s('b05').rc !== 0 && /ECROSS_TRACK/.test(s('b05').out) && /Nothing was changed/.test(s('b05').out));
  // concurrent task adds
  const adds = ['a05', 'a06', 'a07', 'b06', 'b07', 'b08'].map(s);
  check('B', 'all six task adds succeeded', adds.every((x) => x.rc === 0 && /created task #\d+/.test(x.out)));
  const ids = adds.map((x) => (x.out.match(/created task #(\d+)/) || [])[1]);
  check('B', 'every task id is distinct', new Set(ids).size === 6 && ids.every(Boolean), ids.join(','));
  const tasks = readTasks();
  check('B', 'every task body present (6 json + 6 md)', tasks.length === 6 && bodyMdCount() === 6, `json=${tasks.length} md=${bodyMdCount()}`);
  const overlap = (() => { const x = s('a05'), y = s('b06'); return x.startedAt < y.endedAt && y.startedAt < x.endedAt || Math.abs(Date.parse(x.startedAt) - Date.parse(y.startedAt)) < 15000; })();
  check('B', 'the two instances task-added at overlapping times', overlap, `${s('a05').startedAt} vs ${s('b06').startedAt}`);
  const sessOf = (hl) => { const t = tasks.find((x) => x.headline === hl); const c = t && (t.history || []).find((h) => h.op === 'create'); return c ? c.session : null; };
  const i1ok = ['I1-task-1', 'I1-task-2', 'I1-task-3'].every((h) => sessOf(h) === 'session-0001');
  const i2ok = ['I2-task-1', 'I2-task-2', 'I2-task-3'].every((h) => sessOf(h) === 'session-0001b');
  check('B', "task history carries each instance's own session+track (I1 session-0001, I2 session-0001b)", i1ok && i2ok,
    tasks.map((t) => `${t.headline}=${sessOf(t.headline)}`).join(' '));
  check('B', 'both close (own track sealed)', s('a09').rc === 0 && /closed/.test(s('a09').out) && s('b10').rc === 0 && /closed/.test(s('b10').out));
  // third instance: two-block pickup
  const p3 = await spawnClaude('I3');
  void p3;
  const c01 = s('c01'), c02 = s('c02');
  check('B', 'third open ran (new session, track a) once both were sealed', c01.rc === 0 && /"track": "a"/.test(c01.out), `rc=${c01.rc}`);
  check('B', 'third instance pickup prints a two-block pickup (TRACK a + TRACK b, 2 parallel tracks)',
    c02.rc === 0 && /2 parallel tracks/.test(c02.out) && /=== TRACK a /.test(c02.out) && /=== TRACK b /.test(c02.out) && /OPEN PUNCHLIST, ALL TRACKS/.test(c02.out), `rc=${c02.rc}`);
  doctors('C');
}

async function runLone() {
  process.stdout.write(`scratch: ${SCRATCH}\nmodel: ${opt.model}\n`);
  PLANS.I1 = PLANS.LONE; // single instance
  const r = await spawnClaude('LONE'.replace('LONE', 'I1'));
  void r;
  const st = steps();
  check('E', 'all 6 lone steps ran', st.length === 6, `got ${st.length}`);
  check('E', 'every step exit 0', st.every((x) => x.rc === 0), st.map((x) => x.label + '=' + x.rc).join(' '));
  const bad = st.filter((x) => /refused|ESESSION|ECROSS|cannot open|lock|Not joining|gate/i.test(x.out) && !/"gate": "new-session"/.test(x.out) || /\block\b.*(held|wait|stale)/i.test(x.out));
  check('E', 'no gate/refusal/lock message in any output', bad.length === 0, bad.map((x) => x.label).join(','));
  check('E', 'open gave a new session (gate new-session)', /"gate": "new-session"/.test((step('l01') || {}).out || ''));
  check('E', 'closed', /closed/.test((step('l06') || {}).out || ''));
  doctors('E');
}

function runLauncher() {
  // Real launcher child. Caller env: fake parent ids (a live track of session 0001 owned by "parent-id"), launcher resolves it.
  process.stdout.write(`scratch: ${SCRATCH}\n`);
  const env = cleanEnv();
  env.CLAUDE_CODE_SESSION_ID = 'smoke-parent-id'; env.CLAUDE_PID = String(process.pid);
  const direct = (args, e) => cp.spawnSync(process.execPath, [TPM, ...args], { cwd: SCRATCH, encoding: 'utf8', env: e });
  const o = direct(S('current', '--open'), env);
  check('L', 'parent track opened in scratch (fake parent id)', o.status === 0, `rc=${o.status}`);
  // The launcher is run from a scratch COPY of the tool dirs it needs (so its tmp/sessions/ folder is NOT written into the
  // product tree). It hard-codes --dangerously-skip-permissions for --headless children; the owner approved a SCOPED
  // allow-list only, so a PATH shim `claude` rewrites that one flag into the scoped posture before exec'ing the real claude.
  const copy = path.join(SCRATCH, 'launcher-copy');
  for (const d of ['lib', 'session', 'child-session']) fs.cpSync(path.join(TREE, 'tools', d), path.join(copy, 'tools', d), { recursive: true });
  const real = cp.spawnSync('bash', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
  const shimDir = path.join(HARNESS, 'shim');
  fs.mkdirSync(shimDir, { recursive: true });
  fs.writeFileSync(path.join(shimDir, 'claude'), `#!/usr/bin/env bash
args=(); for a in "$@"; do [ "$a" = "--dangerously-skip-permissions" ] && continue; args+=("$a"); done
echo "shim: $(date -u +%FT%TZ) scoped posture; dropped --dangerously-skip-permissions" >> ${JSON.stringify(path.join(HARNESS, 'shim.log'))}
exec ${JSON.stringify(real)} "\${args[@]}" --model ${opt.model} --tools Bash --allowedTools 'Bash(node ./harness/step.js:*)' --setting-sources project
`, { mode: 0o755 });
  env.PATH = shimDir + path.delimiter + env.PATH;
  const child = cp.spawnSync('bash', [path.join(copy, 'tools', 'child-session', 'tpm-child-launch.sh'), SCRATCH, '--headless',
    'Run exactly this one Bash command, then reply DONE: node ./harness/step.js CH ch1 -- ' + T('add', '--headline', 'child-task').join(' ')],
  { cwd: SCRATCH, encoding: 'utf8', env, timeout: opt.timeout * 1000 });
  fs.writeFileSync(path.join(HARNESS, 'launcher-out.txt'), (child.stdout || '') + (child.stderr || ''));
  const ch = step('ch1');
  check('L', "launcher --headless child ran the wrapper (child is a separate claude: own session id)", !!ch && ch.claudeSessionId && ch.claudeSessionId !== 'smoke-parent-id', ch ? ch.claudeSessionId : 'child step never ran (see harness/launcher-out.txt)');
  if (ch) {
    check('L', "child saw TPM_SESSION_ID of the parent's track (session-0001)", ch.tpmSessionIdEnv === 'session-0001', String(ch.tpmSessionIdEnv));
    const tasks = readTasks();
    const c = tasks.find((t) => t.headline === 'child-task');
    const ev = c && (c.history || []).find((h) => h.op === 'create');
    check('L', "child's task history attributes to the PARENT (session-0001, via env) - #1175 known limitation, observed", !!ev && ev.session === 'session-0001' && ev.sessionVia === 'env', ev ? JSON.stringify(ev) : 'no event');
  }
}

(async () => {
  try {
    if (opt.mode === 'pair') await runPair();
    else if (opt.mode === 'lone') await runLone();
    else runLauncher();
  } catch (e) { check('X', 'smoke ran without an exception', false, e.stack); }
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(SCRATCH, 'smoke-results.json'), JSON.stringify(results, null, 2));
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed. Evidence: ${HARNESS}/steps.jsonl, claude-*.json; results: ${SCRATCH}/smoke-results.json\n`);
  process.exit(failed.length ? 1 : 0);
})();
