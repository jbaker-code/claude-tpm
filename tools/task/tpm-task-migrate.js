#!/usr/bin/env node
'use strict';
/**
 * tpm-task-migrate.js — the OPT-IN, convert-on-demand OLD→NEW task-store migrator (#1114.B).
 *
 * Converts a WHOLE old markdown task store (the current `../claude-tpm/tools/task/` format:
 * `task-index.md` / `finished-tasks-index.md` / `removed-tasks-index.md` + thousand-bucketed
 * `bodies/<lo>-<hi>/task-<id>.md` landmark-markdown bodies) into the new canonical JSON store
 * (`bodies/<lo>-<hi>/task-<id>.json` envelopes + `tasks-index.json` incl. the #1071 label
 * reverse-index + the three derived human `.md` index views on `--emit-derived`).
 *
 * It COMPOSES the blessed base lib + the task kind modules — it re-implements none of the
 * write/validate/index path, and it re-uses the SAME lenient parser that WROTE the live bodies:
 *   - lib/legacy-task-format.js  · parseBody / parseIndex  — VERBATIM copy of the retired
 *                                   `tpm-task-format.js` (build-plan §2d/R3: no second parser).
 *   - lib/base.js (→ shared)     · envelope.writeEnvelope (ATOMIC) / validate.validateEnvelope /
 *                                   version.CURRENT / timestamp.nowIsoTz.
 *   - lib/task-schema.js         · validatePayload / TASK_KIND / STATES / isIsoTz.
 *   - lib/task-model.js          · reindex / bodyPathFor / readIndex / writeIndex / loadTask /
 *                                   writeIndexViews (so the index + label-map + views come free).
 *   - lib/task-converter.js      · render / renderIndexView — the derived `.md` (--emit-derived).
 *
 * ── SAFETY RAILS (build-plan §2a; Jason's locked rulings) ──
 *  - CONVERT-ON-DEMAND, WHOLE STORE per run. NO scan-and-auto-convert (that suggest-only behavior
 *    is the DOCTOR's, #1119/04). Nothing happens unless a human runs this with explicit flags.
 *  - `--in` and `--out-dir` are REQUIRED, NO defaults (tool-conventions no-defaults). It refuses
 *    if `--out-dir` is (or is inside) `--in`, or if `--out-dir` resolves inside a live
 *    `.claude/claude-tpm/tasks` tree — READ-ONLY on the input, WRITE-ONLY under `--out-dir`.
 *  - STRICT ALL-OR-NOTHING (T-Q4): the migration unit is the WHOLE store. If ANY body cannot be
 *    converted (missing title/State/Created, bad state, id/filename mismatch, malformed subtask),
 *    the run REFUSES LOUD naming EVERY offender and writes NOTHING (no partial store). `--dry-run`
 *    lists all failures in one pass so it is one fix pass, not whack-a-mole. A store that already
 *    holds any `task-<id>.json` body or a `tasks-index.json` is REFUSED (never half-convert).
 *  - VALIDATE-BEFORE-WRITE: every assembled record runs through validateEnvelope and FAILS LOUD
 *    (naming the unfillable field) rather than ever writing an invalid `task-<id>.json`.
 *
 * ── T-Q1: DATE-ONLY → ISO-TZ PROMOTION (the load-bearing ruling; a DELIBERATE, DOCUMENTED
 *    divergence from the session migrator's Q-C "never synthesize a timestamp") ──
 *  Old bodies carry only `- **Created:** YYYY-MM-DD` (date granularity — no time, no offset). The
 *  schema needs `timestamps.createdAt` as a non-null local-offset ISO-8601 value. Task granularity
 *  IS coarser (the render itself shortens to YYYY-MM-DD), so the DATE is the real datum and only
 *  display-precision is absent (unlike session's SEALED-banner, which had no real date at all). So:
 *    - promote the real date to `<date>T00:00:00<offset>`; `<offset>` = an explicit `--offset
 *      ±HH:MM` or (default) the runner-local offset, always recorded in a provenance note;
 *    - Started/Ended/Reopened get the same date→ISO promotion (nullable — absent stays null);
 *    - `updatedAt` is stamped with the REAL materialization time (`nowIsoTz`), never promoted;
 *    - a body with NO `Created` at all is REFUSED — the required createdAt has no real value and
 *      NOTHING beyond this one date-promotion is ever fabricated.
 *
 * ── T-Q5: HISTORY SEED ── each migrated task seeds a single `history:[{at:createdAt, op:"create"}]`
 *    event (matches `openTask`), not `[]`.
 * ── 02 shape: old `- **End action:** <text>` → `endAction:{ action:<text> }` (no refs in old data).
 *
 * ── NODE-INVOKABLE, NO BIN ── run via bare `node tpm-task-migrate.js …`; programmatic callers
 *    `require()` it for `runMigration(...)` / `parseOldBody(...)` / `detectStore(...)` (the DOCTOR
 *    imports `detectStore` as the ONE old-format detector — build-plan §3e).
 *
 * Zero third-party deps; Node built-ins only.
 *
 * USAGE
 *   node tpm-task-migrate.js --in <oldTasksDir> --out-dir <newTasksDir> \
 *       [--offset ±HH:MM] [--dry-run] [--emit-derived] [--force] [--now <iso>]
 */
const fs = require('fs');
const path = require('path');

const base = require('./lib/base');
const { KNOWN_KINDS, writeEnvelope } = base.envelope;
const { validateEnvelope } = base.validate;
const { CURRENT } = base.version;
const { nowIsoTz } = base.timestamp;

const { validatePayload, TASK_KIND, STATES, isIsoTz } = require('./lib/task-schema');
const model = require('./lib/task-model');
const converter = require('./lib/task-converter');
const fmt = require('./lib/legacy-task-format');

class MigrateError extends Error {}
function refuse(msg) { throw new MigrateError(msg); }

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET_RE = /^[+-]\d{2}:\d{2}$/;

// ── T-Q1 date promotion ────────────────────────────────────────────────────

/** Derive the runner-local `±HH:MM` offset from a `nowIsoTz()`-shaped stamp (CI may be UTC). */
function localOffset(now) {
  const s = now || nowIsoTz();
  const m = /([+-]\d{2}:\d{2})$/.exec(s);
  if (!m) throw new Error(`localOffset: cannot derive a local offset from '${s}'`);
  return m[1];
}

/**
 * promoteDate(raw, offset, where) -> ISO-TZ | refuse
 * A DATE-ONLY `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00<offset>` (T-Q1). An already-ISO-TZ value passes
 * through (defensive; old data is date-only). Anything else is REFUSED — no other fabrication.
 */
function promoteDate(raw, offset, where) {
  const v = String(raw == null ? '' : raw).trim();
  if (isIsoTz(v)) return v;
  if (!DATE_ONLY_RE.test(v)) {
    refuse(`${where}: unparseable date ${JSON.stringify(raw)} — expected YYYY-MM-DD `
      + `(T-Q1 promotes date-only to T00:00:00 at ${offset}; nothing else is fabricated).`);
  }
  return `${v}T00:00:00${offset}`;
}

function _optDate(field, offset, id, label, notes) {
  if (!field || !String(field.value).trim()) return null;
  const v = promoteDate(field.value, offset, `task-${id} ${label}`);
  notes.push(`task-${id}: ${label.toLowerCase()}At promoted from date-only '${String(field.value).trim()}' → '${v}' (T-Q1).`);
  return v;
}

// ── one OLD body → validated-shape record + provenance notes ─────────────────

/**
 * parseOldBody({ raw, id?, offset?, now? }) -> { record, notes }   (throws MigrateError on refusal)
 * Parses ONE old markdown body (via the copied lenient `legacy-task-format.parseBody`) and assembles
 * the canonical `kind:"task"` record. Does NOT validate/write (runMigration does). Refuses a body
 * missing the title / State / Created, a state ∉ STATES, an id/filename mismatch, or an empty
 * headline/subtask. `id` (from the filename) is authoritative when supplied.
 */
function parseOldBody(opts) {
  const o = opts || {};
  const raw = o.raw;
  if (typeof raw !== 'string') refuse('parseOldBody: `raw` body text is required');
  const fileId = o.id != null && String(o.id).trim() !== '' ? String(o.id).trim() : null;
  const now = o.now || nowIsoTz();
  const offset = o.offset || localOffset(now);
  if (!OFFSET_RE.test(offset)) refuse(`invalid offset '${offset}' — expected ±HH:MM.`);

  const p = fmt.parseBody(raw);
  const where = fileId ? `task-${fileId}` : 'body';

  if (p.titleIdx === -1 || p.number == null) {
    refuse(`${where}: missing the '# #<id> · <headline>' title line — not a task body.`);
  }
  const titleId = String(p.number);
  if (fileId && titleId !== fileId) {
    refuse(`${where}: title id #${titleId} disagrees with the filename id ${fileId} — refusing (id ambiguity).`);
  }
  const id = fileId || titleId;
  const headline = String(p.headline || '').trim();
  if (!headline) refuse(`task-${id}: empty headline.`);

  const stateField = p.fields.State;
  if (!stateField || !String(stateField.value).trim()) refuse(`task-${id}: missing '- **State:**'.`);
  const state = String(stateField.value).trim();
  if (!STATES.includes(state)) refuse(`task-${id}: state '${state}' is not one of ${STATES.join('|')}.`);

  const createdField = p.fields.Created;
  if (!createdField || !String(createdField.value).trim()) {
    refuse(`task-${id}: missing '- **Created:**' — T-Q1 refuses a body with no real date (a timestamp `
      + `is never fabricated). Add the Created date by hand, then re-run.`);
  }

  const notes = [];
  const createdAt = promoteDate(createdField.value, offset, `task-${id} Created`);
  notes.push(`task-${id}: createdAt promoted from date-only '${String(createdField.value).trim()}' → '${createdAt}' (T-Q1, offset ${offset}).`);

  const startedAt = _optDate(p.fields.Started, offset, id, 'Started', notes);
  const endedAt = _optDate(p.fields.Ended, offset, id, 'Ended', notes);
  const reopenedAt = _optDate(p.fields.Reopened, offset, id, 'Reopened', notes);

  const subtasks = [];
  if (p.subtasks && Array.isArray(p.subtasks.items)) {
    p.subtasks.items.forEach((it) => {
      const text = String(it.text || '').trim();
      if (!text) refuse(`task-${id}: subtask ${it.letter} has empty text.`);
      subtasks.push({ key: it.letter, text, state: it.checked ? 'done' : 'open' });
    });
  }

  // old `End action: <text>` → { action: <text>, refs: [] } (T-Q3 shape; no refs in old data). null otherwise.
  let endAction = null;
  const eaField = p.fields['End action'];
  if (eaField && String(eaField.value).trim()) {
    endAction = { action: String(eaField.value).trim(), refs: [] };
    notes.push(`task-${id}: 'End action' → endAction.action (refs [] per T-Q3).`);
  }

  const summary = p.summary && String(p.summary.value).trim() !== '' ? p.summary.value : null;
  const context = p.context && String(p.context.value).trim() !== '' ? p.context.value : null;

  const record = {
    schemaVersion: CURRENT,
    kind: TASK_KIND,
    id,
    state,
    headline,
    labels: [],                       // old store has no labels
    summary,
    context,
    subtasks,
    timestamps: {
      createdAt,
      updatedAt: now,                 // REAL materialization time (T-Q1) — never promoted
      startedAt,
      endedAt,
      reopenedAt,
    },
    endAction,
    history: [{ at: createdAt, op: 'create' }],   // T-Q5: single honest {op:"create"} seed
  };
  notes.push(`task-${id}: history seeded [{op:"create"}] (T-Q5); updatedAt = real now '${now}'.`);
  return { record, notes };
}

// ── store detection (the ONE old-format detector; the DOCTOR imports this) ────

/**
 * detectStore(inDir) -> { inDir, bodies:[{id, path}], marker } | throws MigrateError
 *
 * Recognises a CLEAN old task store: a `bodies/<lo>-<hi>/task-<id>.md` tree with NO canonical JSON
 * body and NO `tasks-index.json` (a partly-migrated store is REFUSED — never half-convert). Reads
 * the `**Next ID:**` marker from `task-index.md` and returns it verbatim (the nextId floor, T-Q4;
 * null when absent). Bodies are returned sorted by numeric id. Refuses (with a clear reason the
 * doctor surfaces) when the dir is unreadable, has no bodies/ tree, holds JSON bodies / an index,
 * or has no old `.md` bodies at all.
 */
function detectStore(inDir) {
  if (!inDir) refuse('detectStore: inDir is required');
  let stat;
  try { stat = fs.statSync(inDir); } catch (e) { refuse(`cannot read '${inDir}': ${e.message}`); }
  if (!stat.isDirectory()) refuse(`'${inDir}' is not a directory.`);

  if (fs.existsSync(path.join(inDir, 'tasks-index.json'))) {
    refuse(`refusing '${inDir}': a tasks-index.json is already present — this store is already `
      + `(partly) migrated. Migrate a CLEAN old store into a fresh --out-dir.`);
  }

  const bodiesDir = path.join(inDir, 'bodies');
  if (!fs.existsSync(bodiesDir)) {
    refuse(`refusing '${inDir}': no bodies/ directory — not an old task store `
      + `(expected bodies/<lo>-<hi>/task-<id>.md).`);
  }

  const mdBodies = [];
  const jsonBodies = [];
  for (const bucket of fs.readdirSync(bodiesDir)) {
    const bdir = path.join(bodiesDir, bucket);
    let bstat;
    try { bstat = fs.statSync(bdir); } catch (_) { continue; }
    if (!bstat.isDirectory()) continue;
    for (const fn of fs.readdirSync(bdir)) {
      if (/^task-(\d+)\.json$/.test(fn)) { jsonBodies.push(fn); continue; }
      const mm = /^task-(\d+)\.md$/.exec(fn);
      if (mm) mdBodies.push({ id: mm[1], path: path.join(bdir, fn) });
    }
  }
  if (jsonBodies.length) {
    const sample = jsonBodies.slice(0, 5).join(', ') + (jsonBodies.length > 5 ? ', …' : '');
    refuse(`refusing '${inDir}': found ${jsonBodies.length} canonical JSON task body(ies) (${sample}) `
      + `beside the old .md bodies — this store is already (partly) migrated. Refusing to half-convert.`);
  }
  if (!mdBodies.length) {
    refuse(`refusing '${inDir}': no old task bodies found (expected bodies/<lo>-<hi>/task-<id>.md).`);
  }
  mdBodies.sort((a, b) => (Number(a.id) - Number(b.id)) || (a.id < b.id ? -1 : 1));

  // The `**Next ID:**` marker (task-index.md ONLY; survives an empty open table). Preserve it as
  // the nextId floor (T-Q4). Absent → null (noted; reindex then floors at max(bodyId)+1).
  let marker = null;
  const idxPath = path.join(inDir, 'task-index.md');
  if (fs.existsSync(idxPath)) {
    try {
      const parsed = fmt.parseIndex(fs.readFileSync(idxPath, 'utf8'));
      if (parsed && parsed.nextId != null) marker = String(parsed.nextId);
    } catch (_) { /* a malformed index just means "no marker" — bodies are truth */ }
  }
  return { inDir, bodies: mdBodies, marker };
}

// ── path guards (ported from the session migrator) ───────────────────────────

function resolve(p) { return path.resolve(p); }

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Refuse an --out-dir that resolves inside a live .claude/claude-tpm/tasks tree. */
function looksLikeLiveTasks(outDir) {
  const norm = resolve(outDir).split(path.sep).join('/');
  return /(^|\/)\.claude\/claude-tpm\/tasks(\/|$)/.test(norm);
}

// ── the migrate operation (whole store) ───────────────────────────────────────

/**
 * runMigration(opts) -> result
 *   opts.inDir       — REQUIRED old task-store dir (read-only).
 *   opts.outDir      — REQUIRED output dir (write-only; ≠ inDir + not a live tasks tree).
 *   opts.offset      — OPTIONAL ±HH:MM for the T-Q1 date promotion (default: runner-local).
 *   opts.dryRun      — parse + validate + report; write nothing.
 *   opts.emitDerived — also write each task-<id>.md + the three human index .md views.
 *   opts.force       — overwrite existing target JSON bodies.
 *   opts.now         — reference materialization stamp (default nowIsoTz(); injectable for goldens).
 *   opts.loadTask    — injected loader (default task-model.loadTask) for the post-write round-trip.
 *
 * result = { inDir, outDir, marker, offset, records, count, refusals, notes, written, valid,
 *            indexPath, bodyPaths, mdPaths, index?, refusalMessage? }
 */
function runMigration(opts) {
  const o = opts || {};
  const { inDir, outDir } = o;
  if (!inDir) refuse('--in is required (no default)');
  if (!outDir) refuse('--out-dir is required (no default)');
  if (resolve(inDir) === resolve(outDir) || isInside(resolve(outDir), resolve(inDir))) {
    refuse(`--out-dir '${outDir}' is (or is inside) --in '${inDir}'; write output somewhere else.`);
  }
  if (looksLikeLiveTasks(outDir)) {
    refuse(`--out-dir '${outDir}' resolves inside a live .claude/claude-tpm/tasks tree — refusing to write there.`);
  }
  const now = o.now || nowIsoTz();
  const offset = o.offset || localOffset(now);
  if (!OFFSET_RE.test(offset)) refuse(`invalid --offset '${offset}' — expected ±HH:MM.`);

  const store = detectStore(inDir);   // throws MigrateError on partial / ambiguous / empty

  const notes = [];
  notes.push(o.offset
    ? `offset: explicit --offset ${offset} used for every date promotion (T-Q1).`
    : `offset: no --offset given — using the runner-local offset ${offset} (T-Q1 provenance; these are Jason's own tasks in his own tz).`);
  notes.push(store.marker != null
    ? `nextId floor: preserved the old '**Next ID:** ${store.marker}' marker from task-index.md (T-Q4).`
    : `nextId floor: no '**Next ID:**' marker in task-index.md — nextId will floor at max(bodyId)+1.`);

  // Parse + validate EVERY body; collect ALL refusals so --dry-run lists them in one pass.
  const records = [];
  const refusals = [];
  for (const b of store.bodies) {
    let raw;
    try { raw = fs.readFileSync(b.path, 'utf8'); }
    catch (e) { refusals.push({ id: b.id, path: b.path, reason: `unreadable: ${e.message}` }); continue; }
    try {
      const parsed = parseOldBody({ raw, id: b.id, offset, now });
      validateEnvelope(parsed.record, { payloadValidator: validatePayload, knownKinds: KNOWN_KINDS });
      records.push({ id: b.id, record: parsed.record, path: b.path });
      for (const n of parsed.notes) notes.push(n);
    } catch (e) {
      refusals.push({ id: b.id, path: b.path, reason: e.message });
    }
  }

  const result = {
    inDir: resolve(inDir),
    outDir: resolve(outDir),
    marker: store.marker,
    offset,
    records: records.map((r) => r.record),
    count: records.length,
    total: store.bodies.length,
    refusals,
    notes,
    written: false,
    valid: refusals.length === 0,
    indexPath: null,
    bodyPaths: [],
    mdPaths: [],
  };

  // ALL-OR-NOTHING (T-Q4): any refusal → NO write, loud failure naming EVERY offender.
  if (refusals.length) {
    const lines = refusals.map((r) => `  - task-${r.id} (${r.path}): ${r.reason}`);
    const msg = `refusing to migrate '${inDir}': ${refusals.length} of ${store.bodies.length} `
      + `body(ies) cannot be converted (STRICT all-or-nothing whole-store; NO partial write). `
      + `Fix by hand, then re-run:\n${lines.join('\n')}`;
    if (o.dryRun) { result.refusalMessage = msg; return result; }
    refuse(msg);
  }

  if (o.dryRun) return result;   // clean → nothing written; main prints the would-write summary

  // Pre-write existence guard — never clobber a target without --force.
  const existing = records
    .map((r) => model.bodyPathFor(outDir, r.id))
    .filter((jp) => fs.existsSync(jp));
  if (existing.length && !o.force) {
    refuse(`output already holds ${existing.length} target body file(s) (e.g. ${existing[0]}) — pass --force to overwrite.`);
  }

  // Write each canonical JSON body (ATOMIC, base writeEnvelope). Index/derived come after.
  const bodyPaths = [];
  for (const r of records) {
    const jsonPath = model.bodyPathFor(outDir, r.id);
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    writeEnvelope(jsonPath, r.record);
    bodyPaths.push(jsonPath);
  }

  // Build tasks-index.json (counts + the #1071 label reverse-index, all derived) via the model's
  // reindex — flooring nextId with the old marker (T-Q4). Seed the marker as the prior high-water
  // so `_recount` floors nextId = max(marker, max(bodyId)+1, startId).
  if (store.marker != null) {
    const seed = model.readIndex(outDir);   // fresh empty (no index yet)
    seed.nextId = String(store.marker);
    model.writeIndex(outDir, seed);
  }
  const index = model.reindex(outDir, { startId: model.DEFAULT_START_ID });
  const indexPath = model.indexPathFor(outDir);

  // Optional derived human files (--emit-derived): body .md + the three index .md views.
  const mdPaths = [];
  if (o.emitDerived) {
    for (const r of records) {
      const md = model.bodyPathFor(outDir, r.id).replace(/\.json$/, '.md');
      base.io.atomicWriteFileSync(md, converter.render(r.record, { now }));   // atomic like every other store write (#1173)
      mdPaths.push(md);
    }
    model.writeIndexViews(outDir, index, converter.renderIndexView);
  }

  // Round-trip proof: every written body loads cleanly through the canonical load path.
  const load = typeof o.loadTask === 'function' ? o.loadTask : model.loadTask;
  for (const jp of bodyPaths) load(jp);

  result.written = true;
  result.indexPath = indexPath;
  result.bodyPaths = bodyPaths;
  result.mdPaths = mdPaths;
  result.index = index;
  return result;
}

// ── CLI ────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--in': opts.inDir = next(); break;
      case '--out-dir': opts.outDir = next(); break;
      case '--offset': opts.offset = next(); break;
      case '--now': opts.now = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--emit-derived': opts.emitDerived = true; break;
      case '--force': opts.force = true; break;
      case '-h': case '--help': opts.help = true; break;
      default: throw new Error(`unknown argument '${a}'`);
    }
  }
  return opts;
}

const USAGE = `tpm-task-migrate — OPT-IN whole-store old-markdown→JSON task migrator (#1114.B)
  run: tpm task migrate --in <oldTasksDir> --out-dir <newTasksDir> [flags]

  --in <dir>       REQUIRED  old task store (task-index.md + bodies/<lo>-<hi>/task-<id>.md); READ-ONLY
  --out-dir <dir>  REQUIRED  where the JSON store is written (must differ from --in;
                             refused inside a live .claude/claude-tpm/tasks tree)
  --offset ±HH:MM  T-Q1 offset for the date→T00:00:00 promotion (default: runner-local, noted)
  --dry-run        parse + validate + report (lists ALL failures at once); write nothing
  --emit-derived   also write each task-<id>.md + the three human index .md views
  --force          overwrite existing target JSON bodies
  --now <iso>      reference materialization stamp for updatedAt (default: now; injectable)
  --help           show this usage

Convert-on-demand ONLY; the WHOLE store per run. Detection + suggestion is the DOCTOR's job (#1119),
NOT the migrator's. STRICT all-or-nothing: one unparseable body refuses the whole run (no partial
write). No timestamp is fabricated beyond the T-Q1 date-only→T00:00:00 promotion.`;

function main(argv) {
  let opts;
  try {
    opts = parseArgv(argv);
  } catch (e) {
    process.stderr.write('tpm-task-migrate: ' + String(e.message) + '\n\n' + USAGE + '\n');
    return 2;
  }
  if (opts.help) { process.stdout.write(USAGE + '\n'); return 0; }
  try {
    const res = runMigration(opts);
    // A dry-run that found refusals returns a result carrying refusalMessage → report + exit 1.
    if (res.refusalMessage) {
      process.stderr.write('tpm-task-migrate (refused, dry-run):\n' + res.refusalMessage + '\n');
      return 1;
    }
    const lines = [];
    lines.push(`store ${res.inDir} → ${res.written ? 'WROTE' : 'DRY-RUN (nothing written)'}`);
    lines.push(`  out:        ${res.outDir}`);
    lines.push(`  bodies:     ${res.count} task(s) converted${res.written ? '' : ' (would write)'}`);
    if (res.indexPath) lines.push(`  index:      ${res.indexPath} (nextId ${res.index.nextId})`);
    if (res.mdPaths.length) lines.push(`  derived md: ${res.mdPaths.length} body view(s) + 3 index view(s)`);
    lines.push(`  validation: PASS (schema ${CURRENT}, kind ${TASK_KIND})`);
    for (const n of res.notes) lines.push(`  note:       ${n}`);
    process.stderr.write(lines.join('\n') + '\n');
    return 0;
  } catch (e) {
    const tag = e instanceof MigrateError ? 'tpm-task-migrate (refused)' : 'tpm-task-migrate';
    process.stderr.write(tag + ': ' + String(e.message) + '\n');
    return 1;
  }
}

module.exports = {
  runMigration,
  parseOldBody,
  detectStore,
  promoteDate,
  localOffset,
  MigrateError,
  main,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
