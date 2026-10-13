'use strict';
/**
 * baseline-scenario.js — the single-track byte baseline (phase 12, Step 0). Builds a scratch store holding ONLY
 * track a, runs every read verb and every write verb through the real CLI, and returns one deterministic
 * transcript (stdout + stderr + exit code of each call). `golden/single-track-baseline.txt` is that transcript
 * captured from the tree BEFORE phase 12; the tests compare today's transcript to it byte for byte.
 * Deterministic on purpose: the read fixture is a fixed record (fixed timestamps), the write verbs print no clock
 * values, the scratch path is replaced by <SD>.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const H = require('./track-helpers');

const FIXTURE = path.join(__dirname, '..', 'golden', 'session-0021.fixture.json');
const NOW = '2026-09-20T00:00:00-07:00';
const ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function cli(script, args, sd, o) {
  const r = H.run(script, args, o);
  return `$ ${path.basename(script)} ${args.map((a) => String(a).split(sd).join('<SD>')).join(' ')}\nexit ${r.code}\n--- stdout\n${r.stdout.split(sd).join('<SD>')}--- stderr\n${r.stderr.split(sd).join('<SD>')}`;
}

function transcript(opts) {
  const o = opts || {};
  const sd = fs.mkdtempSync(path.join(o.tmpRoot || os.tmpdir(), 'tpm-baseline-'));
  const out = [];
  // read verbs against the fixed record (session 0021, track a only)
  const folder = path.join(sd, 'session-0021');
  fs.mkdirSync(folder, { recursive: true });
  fs.copyFileSync(FIXTURE, path.join(folder, 'session-0021.json'));
  const EXPORT = path.join(H.OPS, '..', 'tpm-session-export.js');
  out.push(cli(EXPORT, ['--sessions-dir', sd, '--session', '21', '--style', 'human', '--now', NOW], sd));
  out.push(cli(EXPORT, ['--sessions-dir', sd, '--session', '21', '--style', 'json'], sd));
  out.push(cli(EXPORT, ['--sessions-dir', sd, '--last', '1', '--style', 'both', '--combine', 'one-file', '--now', NOW], sd));
  // write verbs through the real CLI, as the one instance that owns track a
  const w = (args) => cli(H.OPS, [args[0], '--sessions-dir', sd, ...args.slice(1)], sd, { id: ID, pid: 4242 });
  out.push(w(['open', '--session', '1', '--session-id', ID]));
  out.push(w(['punchlist', '--session', '1', '--action', 'add', '--text', 'first thing', '--slug', 'first']));
  out.push(w(['punchlist', '--session', '1', '--action', 'add', '--text', 'second thing', '--slug', 'second']));
  out.push(w(['note', '--session', '1', '--log', '--status', 'NOTE', '--text', 'hello']));
  out.push(w(['note', '--session', '1', '--decision', '--what', 'w', '--why', 'y']));
  out.push(w(['save', '--session', '1']));
  out.push(w(['punchlist', '--session', '1', '--action', 'close', '--item', 'first']));
  out.push(w(['punchlist', '--session', '1', '--action', 'reopen', '--item', '1.1']));
  out.push(w(['punchlist', '--session', '1', '--action', 'drop', '--item', 'second']));
  out.push(w(['punchlist', '--session', '1', '--action', 'close', '--item', 'nonesuch']));
  const txt = path.join(sd, 'in.txt');
  fs.writeFileSync(txt, 'imported line\n');
  out.push(w(['import-handoff', '--session', '1', '--txt-file', txt, '--next', 'go on']));
  out.push(w(['import-log', '--session', '1', '--txt-file', txt]));
  out.push(w(['import-punchlist', '--session', '1', '--txt-file', txt]));
  out.push(w(['close', '--session', '1']));
  // read the produced record back (the transcript contains no clock values: --now fixed; but the record has
  // real timestamps, so only the structure is pinned here: ids, slugs, states)
  const rec = JSON.parse(fs.readFileSync(path.join(sd, 'session-0001', 'session-0001.json'), 'utf8'));
  out.push(`punchlist: ${rec.punchlist.map((i) => `${i.id}/${/^(first|second)$/.test(i.slug) ? i.slug : 'auto'}/${i.state}`).join(' ')}\nlog: ${rec.log.map((l) => `${l.seq}:${l.type}`).join(' ')}\nresidue: ${fs.readdirSync(path.join(sd, 'session-0001')).sort().join(' ')}`);
  const text = out.join('\n=====\n') + '\n';
  if (!o.keep) fs.rmSync(sd, { recursive: true, force: true });
  return text;
}

module.exports = { transcript };

if (require.main === module) process.stdout.write(transcript());
