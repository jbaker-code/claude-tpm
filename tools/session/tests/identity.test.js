'use strict';
/**
 * identity.test.js — lib/identity.js: readIdentity / processStartedAt / isProcessAlive (DoD row C).
 *
 * Every case passes an explicit env + hostname (never the ambient CLAUDE_* of the invoking session).
 * Dead pids come from a child that has already exited; nothing hard-codes a pid.
 *
 * Run: node tools/session/tests/identity.test.js
 */
const { assert, test, done } = require('./helpers/harness');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { readIdentity, processStartedAt, isProcessAlive } = require('../../lib/identity');

const IDENT = path.join(__dirname, '..', '..', 'lib', 'identity.js');
const TZ = /[+-]\d{2}:\d{2}$/;

function deadPid() {
  const r = spawnSync(process.execPath, ['-e', '']);
  return r.pid;
}

test('I-1 reads session id, pid, start time and hostname from the injected env', () => {
  const id = readIdentity({ env: { CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_PID: String(process.pid) }, hostname: 'h1' });
  assert.strictEqual(id.claudeSessionId, 'abc');
  assert.strictEqual(id.claudePid, process.pid);
  assert.strictEqual(id.hostname, 'h1');
  assert.ok(TZ.test(id.claudePidStartedAt), 'local-offset ISO: ' + id.claudePidStartedAt);
  const expect = Date.now() - process.uptime() * 1000;
  assert.ok(Math.abs(Date.parse(id.claudePidStartedAt) - expect) < 5000, 'start within 5 s of now - uptime');
  assert.deepStrictEqual(Object.keys(id).sort(), ['claudePid', 'claudePidStartedAt', 'claudeSessionId', 'hostname']);
});

test('I-2 absent / non-object env gives all-null except hostname, and never throws', () => {
  for (const env of [{}, null, undefined, 'a string', 42]) {
    const id = readIdentity({ env: env === undefined ? {} : env, hostname: 'h' });
    assert.deepStrictEqual(id, { claudeSessionId: null, claudePid: null, claudePidStartedAt: null, hostname: 'h' }, String(env));
  }
});

test('I-3 garbage pid / session id values become null; padding is trimmed', () => {
  for (const bad of ['', '  ', 'abc', '0', '1', '-5', '1.5', '73289x', '99999999999999999999']) {
    assert.strictEqual(readIdentity({ env: { CLAUDE_PID: bad }, hostname: 'h', withStartTime: false }).claudePid, null, JSON.stringify(bad));
  }
  assert.strictEqual(readIdentity({ env: { CLAUDE_PID: ' 4242 ' }, hostname: 'h', withStartTime: false }).claudePid, 4242);
  assert.strictEqual(readIdentity({ env: { CLAUDE_CODE_SESSION_ID: '  ' }, hostname: 'h' }).claudeSessionId, null);
  assert.strictEqual(readIdentity({ env: { CLAUDE_CODE_SESSION_ID: ' x ' }, hostname: 'h' }).claudeSessionId, 'x');
});

test('I-4 a CLAUDE_PID that is not running: pid reported, start time null, no throw', () => {
  const pid = deadPid();
  const id = readIdentity({ env: { CLAUDE_PID: String(pid) }, hostname: 'h' });
  assert.strictEqual(id.claudePid, pid);
  assert.strictEqual(id.claudePidStartedAt, null);
});

test('I-5 withStartTime:false never runs ps', () => {
  let calls = 0;
  const id = readIdentity({ env: { CLAUDE_PID: '4242' }, hostname: 'h', withStartTime: false, run: () => { calls++; return { status: 0, stdout: '' }; } });
  assert.strictEqual(id.claudePidStartedAt, null);
  assert.strictEqual(calls, 0);
});

test('I-6 silence in-process: no stdout/stderr bytes, even for a dead pid', () => {
  const ow = process.stdout.write; const ew = process.stderr.write; let n = 0;
  process.stdout.write = () => { n++; return true; }; process.stderr.write = () => { n++; return true; };
  try {
    readIdentity({ env: {}, hostname: 'h' });
    readIdentity({ env: { CLAUDE_PID: String(deadPid()), CLAUDE_CODE_SESSION_ID: 's' }, hostname: 'h' });
    processStartedAt(deadPid()); isProcessAlive(deadPid());
  } finally { process.stdout.write = ow; process.stderr.write = ew; }
  assert.strictEqual(n, 0);
});

test('I-6b silence out-of-process: env stripped + dead pid -> empty stdout/stderr, exit 0', () => {
  const dead = deadPid();
  const code = `const i=require(${JSON.stringify(IDENT)});i.readIdentity({env:{}});i.readIdentity({env:{CLAUDE_PID:'${dead}',CLAUDE_CODE_SESSION_ID:'x'}});i.isProcessAlive(${dead});i.processStartedAt(${dead});`;
  const r = spawnSync(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, encoding: 'utf8', timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(r.stderr, '');
});

test('I-6c default env path: with the vars removed from process.env it returns nulls and never throws', () => {
  const keep = { a: process.env.CLAUDE_CODE_SESSION_ID, b: process.env.CLAUDE_PID };
  delete process.env.CLAUDE_CODE_SESSION_ID; delete process.env.CLAUDE_PID;
  try {
    const id = readIdentity();
    assert.strictEqual(id.claudeSessionId, null); assert.strictEqual(id.claudePid, null);
    assert.strictEqual(id.claudePidStartedAt, null); assert.strictEqual(id.hostname, os.hostname());
  } finally {
    if (keep.a !== undefined) process.env.CLAUDE_CODE_SESSION_ID = keep.a;
    if (keep.b !== undefined) process.env.CLAUDE_PID = keep.b;
  }
});

test('I-7 never throws when run throws, errors, returns junk or ps is unavailable', () => {
  const runs = [
    () => { throw new Error('boom'); },
    () => ({ error: new Error('ENOENT'), status: null, stdout: '' }),
    () => ({ status: 0, stdout: 12345 }),
    () => ({ status: 127, stdout: '' }),
    () => null,
    () => ({ status: 0, stdout: 'not a date at all\n' }),
    () => ({ status: 0, stdout: '   \n' }),
  ];
  for (const run of runs) {
    assert.strictEqual(processStartedAt(4242, { run }), null);
    assert.strictEqual(readIdentity({ env: { CLAUDE_PID: '4242' }, hostname: 'h', run }).claudePidStartedAt, null);
  }
});

test('I-8 ps parse: lstart text -> local-offset ISO; LC_ALL=C; argv; env not mutated', () => {
  const env = { PATH: 'x', LC_ALL: 'de_DE' };
  let seen;
  const out = processStartedAt(4242, { env, run: (cmd, args, o) => { seen = { cmd, args, o }; return { status: 0, stdout: 'Wed Oct  7 13:25:19 2026\n' }; } });
  assert.ok(TZ.test(out), out);
  assert.strictEqual(Date.parse(out), new Date('Wed Oct  7 13:25:19 2026').getTime());
  assert.strictEqual(seen.cmd, 'ps');
  assert.deepStrictEqual(seen.args, ['-o', 'lstart=', '-p', '4242']);
  assert.strictEqual(seen.o.env.LC_ALL, 'C');
  assert.strictEqual(env.LC_ALL, 'de_DE', 'caller env untouched');
  assert.deepStrictEqual(Object.keys(env).sort(), ['LC_ALL', 'PATH']);
});

test('I-9 isProcessAlive: own pid yes; exited child no; invalid pids no; EPERM counts as alive', () => {
  assert.strictEqual(isProcessAlive(process.pid), true);
  assert.strictEqual(isProcessAlive(deadPid()), false);
  for (const bad of [0, -1, 1, NaN, 1.5, '12', null, undefined, {}, Infinity]) assert.strictEqual(isProcessAlive(bad), false, String(bad));
  const real = process.kill;
  try {
    process.kill = () => { const e = new Error('eperm'); e.code = 'EPERM'; throw e; };
    assert.strictEqual(isProcessAlive(4242), true);
    process.kill = () => { const e = new Error('esrch'); e.code = 'ESRCH'; throw e; };
    assert.strictEqual(isProcessAlive(4242), false);
  } finally { process.kill = real; }
});

test('I-10 processStartedAt returns null for invalid pids without spawning', () => {
  let calls = 0;
  const run = () => { calls++; return { status: 0, stdout: 'Wed Oct  7 13:25:19 2026\n' }; };
  for (const bad of [0, -1, 1, NaN, 1.5, '12', null, undefined]) assert.strictEqual(processStartedAt(bad, { run }), null);
  assert.strictEqual(calls, 0);
});

test('I-11 hostname: injected wins; blank injected -> null; default is os.hostname()', () => {
  assert.strictEqual(readIdentity({ env: {}, hostname: 'box' }).hostname, 'box');
  assert.strictEqual(readIdentity({ env: {}, hostname: '  ' }).hostname, null);
  assert.strictEqual(readIdentity({ env: {} }).hostname, os.hostname());
});

test('I-12 a real ps round-trip for the running process matches now - uptime (skipped if ps is absent)', () => {
  const s = processStartedAt(process.pid);
  if (s === null) return; // no ps on this platform: documented unsupported
  assert.ok(Math.abs(Date.parse(s) - (Date.now() - process.uptime() * 1000)) < 5000, s);
});

done('identity.test.js');
