#!/usr/bin/env node
/**
 * tpm-workflow-cost-ledger.js (v2 — epic-aware) — append a per-subagent cost row to a
 * working folder's ledger, print a running total, or ROLL UP an entire epic.
 *
 * PURPOSE. The orchestrator spawns workers + verifiers, and the harness reports
 * each one's token + tool-call usage in its completion notification. This tool
 * makes that durable: ONE row per spawned subagent, written at teardown into a
 * ledger that travels with the round.
 *
 * WHERE THE LEDGER LIVES.
 *   • Flat round (default): `<dir>/tmp/cost-ledger.md`  (via --dir).
 *   • Epic level: `<epic>/00-epic-plan/cost-ledger.md`  (via --epic-path) — the
 *     cross-phase home is charter-clean orchestrator state, so the epic's own
 *     ledger lives there, NOT in a tmp/ that gets swept.
 *
 * ROLLUP. `--rollup <epic>` scans every phase's `NN-<slug>/tmp/cost-ledger.md`
 * PLUS the epic-level `00-epic-plan/cost-ledger.md` and prints a per-phase
 * breakdown + the epic-wide token/tool-call totals. Read-only.
 *
 * A subagent CANNOT reliably introspect its own cumulative token count — so this
 * is an ORCHESTRATOR tool, fed from the completion notification. What a subagent
 * knows (its tool-call count) can be passed via --calls as a cross-check.
 *
 * PORTABILITY. Project-agnostic. No project paths, no domain knowledge.
 *
 * USAGE.
 *   # append a row to a flat round's ledger (<dir>/tmp/cost-ledger.md)
 *   tpm workflow cost --dir "<working folder>" \
 *     --agent round-w-8b3e --role worker --model opus \
 *     --tokens 715k --calls 198 --verdict ACCEPT --round "phase B" --note "ok"
 *
 *   # append a row to the EPIC ledger (<epic>/00-epic-plan/cost-ledger.md)
 *   tpm workflow cost --epic-path "<epic folder>" \
 *     --agent orch --role orchestrator --tokens 40k --round "epic bookkeeping"
 *
 *   # print the running total for a ledger (flat or epic)
 *   tpm workflow cost --dir "<working folder>" --summary
 *   tpm workflow cost --epic-path "<epic folder>" --summary
 *
 *   # roll the WHOLE epic up (per-phase breakdown + epic totals)
 *   tpm workflow cost --rollup "<epic folder>"
 *
 * FLAGS.
 *   --dir <path>        The round's working folder (its tmp/ gets the ledger).
 *   --epic-path <path>  Target the epic ledger at <path>/00-epic-plan/cost-ledger.md.
 *                       Mutually-exclusive alternative to --dir. Exactly one of
 *                       --dir / --epic-path / --rollup is required.
 *   --rollup <path>     Aggregate an epic: sum tokens/calls across every phase
 *                       ledger + the epic ledger. Read-only; prints and exits.
 *   --agent <name>     subagent label / uuid (e.g. round-w-8b3e).
 *   --role <role>      worker | verifier | design | fix-loop | ... (free text).
 *   --model <model>    opus | sonnet | fable | haiku | ... (free text).
 *   --tokens <n>       token count. Accepts 715000, "715k", "~715k", "1.2m".
 *   --calls <n>        tool-call count (the subagent-observable cross-check).
 *   --verdict <text>   ACCEPT | ACCEPT-W-EXC | FAIL | SHIPPED | n/a | ...
 *   --round <text>     round / phase label (free text).
 *   --note <text>      anything worth keeping (fix-loop count, retries, etc.).
 *   --session <ref>    attribute the row to a session (0012, 0012b, 12b or session-0012b); default: auto-resolved.
 *   --track <letter>   track letter a-z, used with --session (e.g. --session 0012 --track b).
 *   --date <YYYY-MM-DD> override the auto-stamped date (default: today, in --tz).
 *   --tz <IANA zone>   timezone for the auto-stamped date (default:
 *                      COST_LEDGER_TZ env var, else America/Los_Angeles).
 *   --summary          print totals for the target ledger and exit (no row written).
 *   --file <name>      ledger filename (default cost-ledger.md).
 *   --help, -h         print usage and exit 0.
 *
 * EXIT CODES.
 *   0  success (row appended, summary printed, rollup printed, or --help)
 *   2  usage error (no target, or both --dir and --epic-path, etc.)
 */

'use strict';
const fs = require('fs');
const path = require('path');
// Phase 18 — informational session stamp (shared resolver; never throws, never blocks).
const { resolveAttribution, toEventFields, parseExplicit } = require('../lib/attribution');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v === undefined || v.startsWith('--')) ? true : v;
}

if (arg('help') === true || arg('h') === true ||
    process.argv.includes('--help') || process.argv.includes('-h')) {
  // Print the header docstring's usage block.
  console.log('tpm workflow cost (v2) — append a subagent cost row, print a total, or roll up an epic.');
  console.log('');
  console.log('Targets (exactly one required):');
  console.log('  --dir <path>        flat round ledger at <path>/tmp/cost-ledger.md');
  console.log('  --epic-path <path>  epic ledger at <path>/00-epic-plan/cost-ledger.md');
  console.log('  --rollup <path>     aggregate all phase + epic ledgers under <path>');
  console.log('');
  console.log('Modifiers: --summary  --agent --role --model --tokens --calls --verdict');
  console.log('           --round --note --date --tz --file --help');
  console.log('  --session <ref>     attribute the row to a session (0012b, or 0012 with --track b); default: auto-resolved');
  console.log('  --track <letter>    track letter a-z, used with --session');
  process.exit(0);
}

/** Parse a token/call count that may carry ~, commas, or a k/m suffix. */
function parseCount(raw) {
  if (raw === undefined || raw === true) return null;
  let s = String(raw).trim().replace(/[~,\s]/g, '').toLowerCase();
  if (s === '' || s === 'n/a' || s === 'na') return null;
  let mult = 1;
  if (s.endsWith('k')) { mult = 1e3; s = s.slice(0, -1); }
  else if (s.endsWith('m')) { mult = 1e6; s = s.slice(0, -1); }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * mult);
}

/**
 * Today as YYYY-MM-DD in the given IANA timezone. Falls back to COST_LEDGER_TZ,
 * then to America/Los_Angeles.
 */
function todayInZone(tz) {
  const timeZone = tz || process.env.COST_LEDGER_TZ || 'America/Los_Angeles';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function fmt(n) { return n === null ? '—' : n.toLocaleString('en-US'); }
function cell(s) { return String(s === undefined || s === true ? '' : s).replace(/\|/g, '\\|').trim(); }

const HEADER = [
  '# Cost ledger',
  '',
  'One row per spawned subagent, written by the orchestrator at teardown from the completion',
  "notification's usage figures. `tokens` is authoritative (the subagent can't introspect its own);",
  '`calls` is the subagent-observable cross-check. Append-only — run `tpm-workflow-cost-ledger.js --summary` for totals.',
  '',
  '| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes | Session |',
  '|------|---------------|-------|------|-------|-------:|------:|---------|-------|---------|',
  '',
].join('\n');

const EPIC_PLAN_DIR = '00-epic-plan';
// A phase folder token: digits + optional lowercase letters, then '-'.
const PHASE_RE = /^(\d+[a-z]*)-/i;

/** Parse existing data rows from a ledger path (skip header/separator/blank). */
function readRows(ledgerPath) {
  if (!fs.existsSync(ledgerPath)) return [];
  return fs.readFileSync(ledgerPath, 'utf8').split('\n')
    .filter(l => l.trim().startsWith('|'))
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()))
    .filter(cols => cols.length >= 9 && cols[0] !== 'Date' && !/^-+$/.test(cols[0].replace(/:/g, '')));
}

/** Aggregate rows → { rows, tokens, calls, tokRows, callRows, byModel }. */
function aggregate(rows) {
  let tokens = 0, calls = 0, tokRows = 0, callRows = 0;
  const byModel = {};
  for (const r of rows) {
    const t = parseCount(r[5]); const c = parseCount(r[6]); const model = r[4] || '(none)';
    if (t !== null) { tokens += t; tokRows++; byModel[model] = (byModel[model] || 0) + t; }
    if (c !== null) { calls += c; callRows++; }
  }
  return { rows, tokens, calls, tokRows, callRows, byModel };
}

// --- argument resolution ------------------------------------------------------
const dirArg = arg('dir');
const epicArg = arg('epic-path');
const rollupArg = arg('rollup');
const ledgerName = (arg('file', 'cost-ledger.md') === true) ? 'cost-ledger.md' : arg('file', 'cost-ledger.md');

const hasDir = dirArg && dirArg !== true;
const hasEpic = epicArg && epicArg !== true;
const hasRollup = rollupArg && rollupArg !== true;

const targetCount = [hasDir, hasEpic, hasRollup].filter(Boolean).length;
if (targetCount === 0) {
  console.error('cost-ledger: one of --dir <folder>, --epic-path <epic>, or --rollup <epic> is REQUIRED.');
  process.exit(2);
}
if (targetCount > 1) {
  console.error('cost-ledger: --dir, --epic-path, and --rollup are mutually exclusive — pass exactly one.');
  process.exit(2);
}

// --- ROLLUP mode --------------------------------------------------------------
if (hasRollup) {
  const epic = rollupArg;
  if (!fs.existsSync(epic)) { console.error(`cost-ledger: epic folder not found: ${epic}`); process.exit(2); }

  // Collect (label -> ledgerPath) for the epic ledger + every phase ledger.
  const targets = [];
  const epicLedger = path.join(epic, EPIC_PLAN_DIR, ledgerName);
  if (fs.existsSync(epicLedger)) targets.push({ label: EPIC_PLAN_DIR, ledger: epicLedger });

  const children = fs.existsSync(epic)
    ? fs.readdirSync(epic, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.'))
    : [];
  const phaseDirs = children
    .filter(e => e.name !== EPIC_PLAN_DIR && PHASE_RE.test(e.name))
    .map(e => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const name of phaseDirs) {
    const ledger = path.join(epic, name, 'tmp', ledgerName);
    if (fs.existsSync(ledger)) targets.push({ label: name, ledger });
  }

  console.log(`Cost rollup — ${epic}`);
  if (!targets.length) {
    console.log('  (no ledgers found — looked for 00-epic-plan/' + ledgerName +
      ' and NN-*/tmp/' + ledgerName + ')');
    process.exit(0);
  }

  let gTokens = 0, gCalls = 0, gSub = 0, gTokRows = 0, gCallRows = 0;
  const gByModel = {};
  console.log('  Per-phase breakdown:');
  for (const t of targets) {
    const agg = aggregate(readRows(t.ledger));
    gTokens += agg.tokens; gCalls += agg.calls; gSub += agg.rows.length;
    gTokRows += agg.tokRows; gCallRows += agg.callRows;
    for (const [m, tok] of Object.entries(agg.byModel)) gByModel[m] = (gByModel[m] || 0) + tok;
    console.log(`    ${t.label}: ${agg.rows.length} subagent(s) · tokens ${fmt(agg.tokens)} · calls ${fmt(agg.calls)}`);
  }
  console.log('  ────');
  console.log(`  EPIC TOTAL: ${gSub} subagent(s) across ${targets.length} ledger(s)`);
  console.log(`    tokens: ${fmt(gTokens)} total (${gTokRows} row(s) with a token count)`);
  console.log(`    calls:  ${fmt(gCalls)} total (${gCallRows} row(s) with a call count)`);
  const models = Object.entries(gByModel).sort((a, b) => b[1] - a[1]);
  if (models.length > 1) for (const [m, tok] of models) console.log(`      ${m}: ${fmt(tok)}`);
  process.exit(0);
}

// --- resolve the single ledger path for append/summary ------------------------
let ledgerPath;
if (hasEpic) {
  ledgerPath = path.join(epicArg, EPIC_PLAN_DIR, ledgerName);
} else {
  ledgerPath = path.join(dirArg, 'tmp', ledgerName);
}

// --- SUMMARY mode -------------------------------------------------------------
if (arg('summary') === true) {
  const rows = readRows(ledgerPath);
  if (!rows.length) { console.log(`cost-ledger: no ledger at ${ledgerPath}`); process.exit(0); }
  const agg = aggregate(rows);
  console.log(`Cost ledger — ${ledgerPath}`);
  console.log(`  ${rows.length} subagent(s)`);
  console.log(`  tokens: ${fmt(agg.tokens)} total (${agg.tokRows} row(s) with a token count)`);
  console.log(`  calls:  ${fmt(agg.calls)} total (${agg.callRows} row(s) with a call count)`);
  const models = Object.entries(agg.byModel).sort((a, b) => b[1] - a[1]);
  if (models.length > 1) for (const [m, t] of models) console.log(`    ${m}: ${fmt(t)}`);
  process.exit(0);
}

// --- APPEND mode --------------------------------------------------------------
const tz = (arg('tz', null) && arg('tz') !== true) ? arg('tz') : null;
const date = (arg('date', null) && arg('date') !== true) ? arg('date') : todayInZone(tz);
// Optional --session/--track (same parseExplicit rules; malformed -> exit 2 before any write).
let explicitRef = null;
if (arg('session') !== undefined || arg('track') !== undefined) {
  const x = parseExplicit({
    session: arg('session') === true ? '' : arg('session'),
    track: arg('track') === true ? '' : arg('track'),
  });
  if (!x.ok) { console.error('cost-ledger: ' + x.error); process.exit(2); }
  explicitRef = x.ref;
}
let sessionCell = '';
try { sessionCell = toEventFields(resolveAttribution({ explicit: explicitRef })).session || ''; } catch (_e) { /* blank */ }
const row = `| ${[
  date,
  cell(arg('round', '')),
  cell(arg('agent', '')),
  cell(arg('role', '')),
  cell(arg('model', '')),
  fmt(parseCount(arg('tokens'))),
  fmt(parseCount(arg('calls'))),
  cell(arg('verdict', '')),
  cell(arg('note', '')),
  sessionCell,
].join(' | ')} |`;

fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
if (!fs.existsSync(ledgerPath)) fs.writeFileSync(ledgerPath, HEADER);
let body = fs.readFileSync(ledgerPath, 'utf8').replace(/\s*$/, '');
// Q-E: an existing ledger whose header is EXACTLY the shipped 9-col header gains a trailing Session column
// (header + separator only; old rows are left untouched — GFM tolerates short rows). Any other header is left alone.
const OLD_HDR = '| Date | Round / phase | Agent | Role | Model | Tokens | Calls | Verdict | Notes |';
const OLD_SEP = '|------|---------------|-------|------|-------|-------:|------:|---------|-------|';
{
  const lines = body.split('\n');
  const hi = lines.findIndex(l => l.trimEnd() === OLD_HDR);
  if (hi !== -1 && lines[hi + 1] !== undefined && lines[hi + 1].trimEnd() === OLD_SEP) {
    lines[hi] = OLD_HDR + ' Session |';
    lines[hi + 1] = OLD_SEP + '---------|';
    body = lines.join('\n');
  }
}
fs.writeFileSync(ledgerPath, body + '\n' + row + '\n');
console.log(`cost-ledger: appended to ${ledgerPath}`);
console.log(`  ${row}`);
