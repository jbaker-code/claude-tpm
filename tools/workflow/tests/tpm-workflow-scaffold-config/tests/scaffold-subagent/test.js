#!/usr/bin/env node
/**
 * scaffold-subagent.test.js — self-contained test for the epic-aware scaffolder.
 *
 * WHAT IT GUARDS (one assertion per Definition-of-Done row)
 *   1. epic-init creates 00-epic-plan/{epic-plan,punchlist,decisions}.md.
 *   2. add-phase auto-numbers append-only: fresh epic → 01-<slug>/; after a manual
 *      05-x/, next → 06-<slug>/ (max NN + 1, zero-padded 2 digits).
 *   3. add-phase drops the full phase skeleton (plan.md + findings/ tools/ tests/ tmp/).
 *   4. per-role charters are COPIED from the resolved charterFile paths:
 *      --team ship → charter-builder.md + charter-verifier.md (byte-equal to source);
 *      --team full → also charter-planning.md.
 *   5. per-role spawn-prompt stubs + per-subagent tmp subfolders:
 *      spawn-prompt-builder-r1.md etc.; tmp/builder-r1/, tmp/verifier-r1-v1/.
 *   6. add-round appends a kickback round (auto-numbered): --role builder →
 *      spawn-prompt-builder-r2.md + tmp/builder-r2/.
 *   7. roster resolved via config-resolver (team roles + each role's charter path).
 *   8. zero-dep + portable + --help + tested: `node <this>` exits 0 on all-pass;
 *      the CLI --help + an end-to-end CLI run are exercised as a child process.
 *
 * HOW TO RUN
 *   node tests/scaffold-subagent.test.js      # exit 0 = all pass, nonzero = a failure
 *
 * It builds scratch epics under os.tmpdir() and tears them down at the end (kept
 * on failure for inspection; the path is printed).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkScratch } = require('../../../../../tests/lib/scratch'); // shared: <bundle>/tmp/scratch/<run-slug>/

// The CANONICAL promoted tool at tools/workflow/ (four levels up) — run against the SHIPPED tool.
const { getDefaults } = require('../../../../tpm-workflow-config-resolver.js');
const FOLDERS = getDefaults().folders; // #1183: derive expected names from the shipped defaults
const scaffold = require('../../../../tpm-workflow-scaffold-subagent.js');
const SCAFFOLD_JS = path.resolve(__dirname, '..', '..', '..', '..', 'tpm-workflow-scaffold-subagent.js');

// ── tiny assert harness ────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed += 1; return; }
  failures.push(msg);
  process.stderr.write(`  ✗ ${msg}\n`);
}
function isDir(p) { return fs.existsSync(p) && fs.statSync(p).isDirectory(); }
function isFile(p) { return fs.existsSync(p) && fs.statSync(p).isFile(); }

// ── scratch workspace under <bundle>/tmp/scratch/<run-slug>/ (shared helper) ────────────────────────
const workspace = mkScratch('scaffold-v2-test');
let keepOnExit = false;

function main() {
  // Stub charters the config will point at (absolute paths so projectRoot is moot).
  const chartersDir = path.join(workspace, 'charters');
  fs.mkdirSync(chartersDir, { recursive: true });
  const charterSrc = {
    builder: path.join(chartersDir, 'builder.md'),
    verifier: path.join(chartersDir, 'verifier.md'),
    planning: path.join(chartersDir, 'planning.md'),
  };
  const charterBodies = {
    builder: '# Charter — builder\nSHIP IT. Do not stop until done.\n',
    verifier: '# Charter — verifier\nVerify the claim with a matching instrument.\n',
    planning: '# Charter — planning\nFormalize the ask; surface risks; do NOT build.\n',
  };
  fs.writeFileSync(charterSrc.builder, charterBodies.builder);
  fs.writeFileSync(charterSrc.verifier, charterBodies.verifier);
  fs.writeFileSync(charterSrc.planning, charterBodies.planning);

  // Stub config pointing each role's charterFile at the stub charters.
  const configPath = path.join(workspace, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    workflow: {
      subagentConfigs: [
        { name: 'planning', charterFile: charterSrc.planning },
        { name: 'builder', charterFile: charterSrc.builder },
        { name: 'verifier', charterFile: charterSrc.verifier },
      ],
    },
  }, null, 2));

  const epicPath = path.join(workspace, 'my-epic');
  const commonOpts = { quiet: true };

  // ── pre-task ack gate fixture + wrapper (2026-08-30) ──────────────────────
  // add-phase now REFUSES without a valid --pretask-ack receipt (the modes-plan §2
  // questions gate, made mechanical). Every DoD/tightening test below exercises the
  // NORMAL path, so route them through this thin wrapper that supplies a valid receipt;
  // the gate itself is tested explicitly in the PRE-TASK ACK GATE block further down
  // (which calls scaffold.addPhase directly). `realAddPhase` is captured without the
  // `addPhase(` call-token so this wrapper is not itself rewritten.
  const ackFile = path.join(workspace, 'pretask-ack.md');
  fs.writeFileSync(ackFile, '# Pre-task ack (test fixture)\n- **Accepted:** all defaults\n');
  const realAddPhase = scaffold.addPhase;
  const addPhase = (epic, phaseArgs, phaseOpts) => realAddPhase(epic, Object.assign({ pretaskAck: ackFile }, phaseArgs || {}), phaseOpts);

  // ── DoD 7: roster resolved via config-resolver ───────────────────────────
  const shipRoster = scaffold.resolveTeamRoster('ship', { configPath, startDir: workspace });
  check(shipRoster.roles.map((r) => r.name).join(',') === 'builder,verifier',
    `resolveTeamRoster('ship') → builder,verifier (got ${shipRoster.roles.map((r) => r.name).join(',')})`);
  check(shipRoster.roles[0].charterFile === charterSrc.builder,
    'roster carries the builder charterFile from resolved config');
  let threw = false;
  try { scaffold.resolveTeamRoster('nope', { configPath, startDir: workspace }); } catch (_e) { threw = true; }
  check(threw, 'resolveTeamRoster throws loudly on an unknown team');

  // ── DoD 1: epic-init ─────────────────────────────────────────────────────
  scaffold.epicInit(epicPath, commonOpts);
  const epicPlanDir = path.join(epicPath, '00-epic-plan');
  check(isFile(path.join(epicPlanDir, 'epic-plan.md')), 'epic-init: 00-epic-plan/epic-plan.md exists');
  check(isFile(path.join(epicPlanDir, 'punchlist.md')), 'epic-init: 00-epic-plan/punchlist.md exists');
  check(isFile(path.join(epicPlanDir, 'decisions.md')), 'epic-init: 00-epic-plan/decisions.md exists');

  // ── DoD 2: auto-number append-only — fresh epic → 01 ─────────────────────
  check(scaffold.nextPhaseNumber(epicPath) === 1, 'nextPhaseNumber = 1 on a fresh epic (only 00-epic-plan/)');
  const ph1 = addPhase(epicPath, { slug: 'build-parser', team: 'ship', configPath, startDir: workspace }, commonOpts);
  check(ph1.phaseFolder === '01-build-parser', `first add-phase → 01-build-parser (got ${ph1.phaseFolder})`);
  const p1 = ph1.phaseDir;

  // ── DoD 3: full phase skeleton ───────────────────────────────────────────
  check(isFile(path.join(p1, 'plan.md')), 'phase skeleton: plan.md');
  check(isDir(path.join(p1, FOLDERS.findings)), 'phase skeleton: findings/');
  check(isDir(path.join(p1, 'tools')), 'phase skeleton: tools/');
  check(isDir(path.join(p1, 'tests')), 'phase skeleton: tests/');
  check(isDir(path.join(p1, FOLDERS.tmp)), 'phase skeleton: tmp/');
  const planText = fs.readFileSync(path.join(p1, 'plan.md'), 'utf8');
  check(planText.includes('{{DOD}}') && planText.includes('{{MOTIVATION}}'), 'plan.md is a sentinel stub (has {{DOD}}, {{MOTIVATION}})');
  check(!/^## Charter/m.test(planText), 'plan.md carries NO charter/posture (charter is a separate file)');

  // ── DoD 4: charters COPIED (ship = builder + verifier, no planning) ──────
  check(isFile(path.join(p1, 'charter-builder.md')), 'ship: charter-builder.md dropped');
  check(isFile(path.join(p1, 'charter-verifier.md')), 'ship: charter-verifier.md dropped');
  check(!fs.existsSync(path.join(p1, 'charter-planning.md')), 'ship: NO charter-planning.md');
  check(fs.readFileSync(path.join(p1, 'charter-builder.md'), 'utf8') === charterBodies.builder,
    'charter-builder.md is a byte-equal COPY of the resolved charterFile (not a stub)');
  check(fs.readFileSync(path.join(p1, 'charter-verifier.md'), 'utf8') === charterBodies.verifier,
    'charter-verifier.md is a byte-equal COPY of the resolved charterFile');

  // ── DoD 5: per-role spawn-prompt stubs + per-subagent tmp subfolders ─────
  check(isFile(path.join(p1, 'spawn-prompt-builder-r1.md')), 'spawn-prompt-builder-r1.md at phase root');
  check(isFile(path.join(p1, 'spawn-prompt-verifier-r1.md')), 'spawn-prompt-verifier-r1.md at phase root');
  check(isDir(path.join(p1, FOLDERS.tmp, 'builder-r1')), 'tmp/builder-r1/ (per-subagent scratch)');
  check(isDir(path.join(p1, FOLDERS.tmp, 'verifier-r1-v1')), 'tmp/verifier-r1-v1/ (verifier gets -v<M> suffix)');
  check(!fs.existsSync(path.join(p1, FOLDERS.tmp, 'verifier-r1')), 'verifier scratch is -v1 suffixed, not a plain verifier-r1');

  // ── DoD 2 (cont.): append-only after a manual 05-x/ → 06 ─────────────────
  fs.mkdirSync(path.join(epicPath, '05-manual-thing'), { recursive: true });
  check(scaffold.nextPhaseNumber(epicPath) === 6, 'after manual 05-x/, nextPhaseNumber = 6 (max+1)');
  const ph6 = addPhase(epicPath, { slug: 'plan-it', team: 'full', configPath, startDir: workspace }, commonOpts);
  check(ph6.phaseFolder === '06-plan-it', `add-phase after 05 → 06-plan-it (got ${ph6.phaseFolder})`);

  // ── DoD 4 (cont.): full team also drops charter-planning.md ──────────────
  check(isFile(path.join(ph6.phaseDir, 'charter-planning.md')), 'full: charter-planning.md dropped');
  check(isFile(path.join(ph6.phaseDir, 'charter-builder.md')), 'full: charter-builder.md dropped');
  check(isFile(path.join(ph6.phaseDir, 'charter-verifier.md')), 'full: charter-verifier.md dropped');
  check(isFile(path.join(ph6.phaseDir, 'spawn-prompt-planning-r1.md')), 'full: spawn-prompt-planning-r1.md');
  check(isDir(path.join(ph6.phaseDir, FOLDERS.tmp, 'planning-r1')), 'full: tmp/planning-r1/ (planning is single → no -v)');

  // ── DoD 6: add-round appends an auto-numbered kickback round ──────────────
  check(scaffold.nextRoundNumber(p1, 'builder') === 2, 'nextRoundNumber(builder) = 2 after r1 exists');
  const rr = scaffold.addRound(p1, { role: 'builder', configPath, startDir: workspace }, commonOpts);
  check(rr.round === 2, `add-round --role builder → r2 (got r${rr.round})`);
  check(isFile(path.join(p1, 'spawn-prompt-builder-r2.md')), 'add-round: spawn-prompt-builder-r2.md');
  check(isDir(path.join(p1, FOLDERS.tmp, 'builder-r2')), 'add-round: tmp/builder-r2/');
  // a second add-round → r3 (proves the auto-numbering keeps climbing)
  const rr3 = scaffold.addRound(p1, { role: 'builder', configPath, startDir: workspace }, commonOpts);
  check(rr3.round === 3 && isFile(path.join(p1, 'spawn-prompt-builder-r3.md')), 'second add-round → r3');
  // add-round for the verifier gets a -v<M> tmp subfolder
  const rrv = scaffold.addRound(p1, { role: 'verifier', configPath, startDir: workspace }, commonOpts);
  check(isDir(path.join(p1, FOLDERS.tmp, `verifier-r${rrv.round}-v1`)), 'add-round verifier → tmp/verifier-r<N>-v1/');

  // ── bug-fixer loop naming: add-round --role bug-fixer ─────────────────────
  // The verify↔bug-fixer loop's fixer is in no team roster, so it joins via add-round.
  // Its scratch mirrors the verifier convention but WITHOUT -v<M> (single fixer, not a
  // blind M-of-count pair): tmp/bug-fixer-r<N>/. And add-round drops its charter (absent
  // → placeholder, since these stub configs give bug-fixer no charterFile override).
  const bf = scaffold.addRound(p1, { role: 'bug-fixer', configPath, startDir: workspace }, commonOpts);
  check(bf.round === 1, `add-round --role bug-fixer → r1 (fresh role in this phase; got r${bf.round})`);
  check(isFile(path.join(p1, 'spawn-prompt-bug-fixer-r1.md')), 'add-round bug-fixer: spawn-prompt-bug-fixer-r1.md');
  check(isDir(path.join(p1, FOLDERS.tmp, 'bug-fixer-r1')), 'add-round bug-fixer: tmp/bug-fixer-r1/ (plain -r<N>, no -v<M>)');
  check(!fs.existsSync(path.join(p1, FOLDERS.tmp, 'bug-fixer-r1-v1')), 'bug-fixer scratch is NOT -v suffixed (single fixer, not a blind pair)');
  check(isFile(path.join(p1, 'charter-bug-fixer.md')), 'add-round bug-fixer: charter-bug-fixer.md dropped (loop fixer is in no roster)');
  check(bf.charterNote && bf.charterNote.role === 'bug-fixer', 'add-round returns a charterNote for the dropped bug-fixer charter');
  // a second bug-fixer round → r2 scratch, and the existing charter is NOT clobbered
  const bf2 = scaffold.addRound(p1, { role: 'bug-fixer', configPath, startDir: workspace }, commonOpts);
  check(bf2.round === 2 && isDir(path.join(p1, FOLDERS.tmp, 'bug-fixer-r2')), 'second bug-fixer round → tmp/bug-fixer-r2/');
  check(bf2.charterNote === null, 'second bug-fixer round does NOT re-drop the charter (already present)');

  // ── add-round for a roster role keeps its add-phase charter (no clobber) ───
  // charter-verifier.md was copied at add-phase (byte-equal to the stub); a verifier
  // re-check round must NOT overwrite it with a placeholder.
  const verifierCharterBefore = fs.readFileSync(path.join(p1, 'charter-verifier.md'), 'utf8');
  const rrv2 = scaffold.addRound(p1, { role: 'verifier', configPath, startDir: workspace }, commonOpts);
  check(fs.readFileSync(path.join(p1, 'charter-verifier.md'), 'utf8') === verifierCharterBefore,
    'add-round verifier does NOT clobber the charter copied at add-phase');
  check(rrv2.charterNote === null, 'add-round verifier returns no charterNote (charter already present)');

  // ── resolveRoleCharter resolves a single role from subagentConfigs ─────────
  const rc = scaffold.resolveRoleCharter('verifier', { configPath, startDir: workspace });
  check(rc.role.name === 'verifier' && rc.role.charterFile === charterSrc.verifier,
    'resolveRoleCharter pulls a role\'s charterFile straight from subagentConfigs');

  // ── helper unit: tmpFolderNames + count>1 fan-out ─────────────────────────
  check(scaffold.tmpFolderNames('builder', 1, 1).join(',') === 'builder-r1', 'tmpFolderNames: lone builder → builder-r1');
  check(scaffold.tmpFolderNames('verifier', 2, 1).join(',') === 'verifier-r2-v1', 'tmpFolderNames: verifier → -v1');
  check(scaffold.tmpFolderNames('verifier', 1, 2).join(',') === 'verifier-r1-v1,verifier-r1-v2', 'tmpFolderNames: verifier count 2 → v1,v2');
  check(scaffold.tmpFolderNames('builder', 1, 3).join(',') === 'builder-r1-v1,builder-r1-v2,builder-r1-v3', 'tmpFolderNames: builder count 3 → v1..v3');
  check(scaffold.tmpFolderNames('bug-fixer', 4, 1).join(',') === 'bug-fixer-r4', 'tmpFolderNames: lone bug-fixer → bug-fixer-r4 (no -v)');

  // ═══════════════════════════════════════════════════════════════════════════
  // TIGHTENING ROUND (2026-08-29) — fixes #3 (env stub) #5 (--charter) #6 (case-
  // insensitive strip) #9 (planTemplateFile). Each new behavior has a matching
  // deliberate-mutation target (see findings/HANDOFF.md for the mutation matrix).
  // ═══════════════════════════════════════════════════════════════════════════

  // ── fix #6: dropCharter strips the ORCHESTRATOR NOTE case-INSENSITIVELY ───────
  // A consumer charter carrying a LOWERCASE `<!-- Orchestrator note … -->` (a natural
  // spelling, and a real posture leak) must be stripped — else it drops verbatim while
  // the case-insensitive lint FAILs it (fable-2 #2).
  const leakCharter = path.join(chartersDir, 'leaky.md');
  fs.writeFileSync(leakCharter,
    '# Charter — builder\n\n<!-- Orchestrator note: swap to the weaker mvp charter for the opt-down; SHIPPING is stronger. -->\n\nSHIP IT.\n');
  const leakOut = path.join(workspace, 'strip-lower.md');
  const leakNote = scaffold.dropCharter(leakOut, { name: 'builder', charterFile: leakCharter }, workspace, { quiet: true }, [], undefined);
  const leakBody = fs.readFileSync(leakOut, 'utf8');
  check(!/orchestrator note/i.test(leakBody), 'fix #6: LOWERCASE "Orchestrator note" is stripped (case-insensitive)');
  check(!leakBody.includes('weaker mvp'), 'fix #6: the posture-leak text does not survive the strip');
  check(leakBody.includes('SHIP IT.'), 'fix #6: the charter body below the note survives');
  check(leakNote.stripped === true, 'fix #6: dropCharter reports stripped=true when a note was removed');
  // regression: UPPERCASE note still stripped
  const upCharter = path.join(chartersDir, 'upper.md');
  fs.writeFileSync(upCharter, '# Charter — builder\n\n<!-- ORCHESTRATOR NOTE: leak here -->\n\nBODY.\n');
  const upOut = path.join(workspace, 'strip-upper.md');
  scaffold.dropCharter(upOut, { name: 'builder', charterFile: upCharter }, workspace, { quiet: true }, [], undefined);
  check(!/ORCHESTRATOR NOTE/.test(fs.readFileSync(upOut, 'utf8')), 'fix #6: UPPERCASE note still stripped (regression)');

  // ── fix #3: add-phase drops a comment-only tmp/subagent.env stub ──────────────
  const envStub = path.join(p1, FOLDERS.tmp, 'subagent.env');
  check(isFile(envStub), 'fix #3: add-phase drops tmp/subagent.env');
  const envStubTxt = fs.readFileSync(envStub, 'utf8');
  check(/comment-only STUB/i.test(envStubTxt), 'fix #3: the env stub is the comment-only stub');
  check(envStubTxt.split('\n').every((l) => l.trim() === '' || l.trimStart().startsWith('#')),
    'fix #3: the env stub is source-safe (every non-blank line is a comment)');
  check(ph1.envNote && ph1.envNote.fromTemplate === false, 'fix #3: envNote reports the built-in stub (no override)');

  // ── fix #3: consumer override — subagentEnvTemplate copied instead of the stub ─
  const envTemplate = path.join(workspace, 'emu.env.template');
  fs.writeFileSync(envTemplate, '# emulator env (consumer override)\nEMU_HOST=127.0.0.1\nEMU_PORT=9099\n');
  const envConfigPath = path.join(workspace, 'config-env.json');
  fs.writeFileSync(envConfigPath, JSON.stringify({
    version: 1,
    workflow: {
      subagentEnvTemplate: envTemplate,
      subagentConfigs: [
        { name: 'builder', charterFile: charterSrc.builder },
        { name: 'verifier', charterFile: charterSrc.verifier },
      ],
    },
  }, null, 2));
  const envEpic = path.join(workspace, 'env-epic');
  scaffold.epicInit(envEpic, commonOpts);
  const envPh = addPhase(envEpic, { slug: 'emu', team: 'ship', configPath: envConfigPath, startDir: workspace }, commonOpts);
  const envCopied = fs.readFileSync(path.join(envPh.phaseDir, FOLDERS.tmp, 'subagent.env'), 'utf8');
  check(envCopied === '# emulator env (consumer override)\nEMU_HOST=127.0.0.1\nEMU_PORT=9099\n',
    'fix #3: subagentEnvTemplate override is copied verbatim (the emulator-env hook)');
  check(envPh.envNote && envPh.envNote.fromTemplate === true && envPh.envNote.via === 'config',
    'fix #3: envNote reports fromTemplate + via=config for the override');

  // ── fix #9: add-phase seeds plan.md from a configured planTemplateFile ─────────
  const planTpl = path.join(workspace, 'plan.tpl.md');
  fs.writeFileSync(planTpl, '# Plan — {{PHASE}}\n\nCUSTOM TEMPLATE BODY for {{PHASE_SLUG}}.\n');
  const tplConfigPath = path.join(workspace, 'config-tpl.json');
  fs.writeFileSync(tplConfigPath, JSON.stringify({
    version: 1,
    workflow: {
      planTemplateFile: planTpl,
      subagentConfigs: [
        { name: 'builder', charterFile: charterSrc.builder },
        { name: 'verifier', charterFile: charterSrc.verifier },
      ],
    },
  }, null, 2));
  const tplEpic = path.join(workspace, 'tpl-epic');
  scaffold.epicInit(tplEpic, commonOpts);
  const tplPh = addPhase(tplEpic, { slug: 'seeded', team: 'ship', configPath: tplConfigPath, startDir: workspace }, commonOpts);
  const tplPlan = fs.readFileSync(path.join(tplPh.phaseDir, 'plan.md'), 'utf8');
  check(tplPlan.includes('CUSTOM TEMPLATE BODY'), 'fix #9: plan.md seeded from planTemplateFile');
  check(tplPlan.includes('# Plan — 01-seeded') && !tplPlan.includes('{{PHASE}}'), 'fix #9: {{PHASE}} expanded to the phase folder');
  check(tplPlan.includes('for 01-seeded.') && !tplPlan.includes('{{PHASE_SLUG}}'), 'fix #9: {{PHASE_SLUG}} expanded too');
  check(!tplPlan.includes('{{DOD}}'), 'fix #9: the built-in stub is NOT used when a template resolves');
  check(tplPh.planSeed && tplPh.planSeed.fromTemplate === true, 'fix #9: planSeed.fromTemplate true');
  // absent template → built-in stub (p1 was scaffolded with no planTemplateFile)
  check(ph1.planSeed && ph1.planSeed.fromTemplate === false, 'fix #9: no planTemplateFile → built-in stub (planSeed.fromTemplate false)');

  // ── fix #5: --charter re-charters ONE role via the tool (routed through dropCharter) ─
  const mvpCharter = path.join(chartersDir, 'mvp.md');
  fs.writeFileSync(mvpCharter,
    '# Charter — mvp\n\n<!-- ORCHESTRATOR NOTE: shipping is the stronger posture; this is the opt-down. -->\n\nMVP: the smallest thing that works.\n');
  const optEpic = path.join(workspace, 'opt-epic');
  scaffold.epicInit(optEpic, commonOpts);
  // multi-role team + explicit --role builder
  const optPh = addPhase(optEpic, { slug: 'optdown', team: 'ship', configPath, startDir: workspace, charter: mvpCharter, charterRole: 'builder' }, commonOpts);
  const optBuilder = fs.readFileSync(path.join(optPh.phaseDir, 'charter-builder.md'), 'utf8');
  check(optBuilder.includes('MVP: the smallest thing'), 'fix #5: --charter lands the chosen charter for the named role');
  check(!/orchestrator note/i.test(optBuilder), 'fix #5: the override still routes through the strip sentinel');
  check(fs.readFileSync(path.join(optPh.phaseDir, 'charter-verifier.md'), 'utf8') === charterBodies.verifier,
    'fix #5: --charter touches ONLY the named role (verifier keeps its default)');
  const optNote = optPh.charterNotes.find((n) => n.role === 'builder');
  check(optNote && optNote.override === true, 'fix #5: the re-chartered role is flagged override in charterNotes');
  // single-role team infers the target role (no --role needed)
  const solo = addPhase(optEpic, { slug: 'solo', team: 'build', configPath, startDir: workspace, charter: mvpCharter }, commonOpts);
  check(fs.readFileSync(path.join(solo.phaseDir, 'charter-builder.md'), 'utf8').includes('MVP:'),
    'fix #5: a single-role team infers the --charter target role');
  // multi-role team WITHOUT --role → loud error
  let ambig = false;
  try { addPhase(optEpic, { slug: 'x', team: 'full', configPath, startDir: workspace, charter: mvpCharter }, commonOpts); }
  catch (e) { ambig = /needs --role/.test(e.message); }
  check(ambig, 'fix #5: --charter on a multi-role team without --role errors loudly');
  // --role naming a non-roster role → loud error
  let badRole = false;
  try { addPhase(optEpic, { slug: 'x2', team: 'ship', configPath, startDir: workspace, charter: mvpCharter, charterRole: 'nobody' }, commonOpts); }
  catch (e) { badRole = /not in team/.test(e.message); }
  check(badRole, 'fix #5: --charter --role naming a non-roster role errors loudly');

  // ── fix #5: add-round --charter --force swaps an existing charter ──────────────
  // p1's charter-builder.md is the default builder stub; swap it to mvp via the tool.
  const swap = scaffold.addRound(p1, { role: 'builder', configPath, startDir: workspace, charter: mvpCharter }, { quiet: true, force: true });
  check(fs.readFileSync(path.join(p1, 'charter-builder.md'), 'utf8').includes('MVP:'), 'fix #5: add-round --charter --force swaps the charter');
  check(swap.charterNote && swap.charterNote.override === true, 'fix #5: add-round --charter sets the override note');
  // add-round --charter WITHOUT --force refuses to clobber an existing charter
  let noForce = false;
  try { scaffold.addRound(p1, { role: 'verifier', configPath, startDir: workspace, charter: mvpCharter }, { quiet: true }); }
  catch (e) { noForce = /pass --force/.test(e.message); }
  check(noForce, 'fix #5: add-round --charter refuses to overwrite an existing charter without --force');

  // ═══════════════════════════════════════════════════════════════════════════
  // TEST-HARDENING ROUND (28) — three guard-neutering mutants the canonical
  // suite left GREEN (fable-2 #4): the blocked-filename write guard, the --slug
  // path-traversal guard, and the subagent.env no-clobber guard. One killing
  // assertion each; each is deliberate-mutation-proved in tests/mutation-check.js.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── blocked-filename guard (writeFileGuarded refuses a report/summary/... name) ─
  // dropCharter routes its write through writeFileGuarded; a target whose basename
  // contains a blocked pattern must be REFUSED (a server-side-blocked name would be
  // handed to the orchestrator). Drive it through the exported dropCharter.
  let blockedThrew = false;
  const blockedTarget = path.join(workspace, 'my-summary.md'); // basename contains "summary"
  try {
    scaffold.dropCharter(blockedTarget, { name: 'x', charterFile: '' }, workspace, { quiet: true }, [], undefined);
  } catch (e) { blockedThrew = /blocked pattern/.test(e.message); }
  check(blockedThrew, 'blocked-filename guard: writeFileGuarded REFUSES a target basename containing a blocked pattern (e.g. "summary")');
  check(!fs.existsSync(blockedTarget), 'blocked-filename guard: the blocked-name file is NOT written');
  // control: a clean name writes fine
  const okTarget = path.join(workspace, 'charter-clean.md');
  let cleanOk = false;
  try { scaffold.dropCharter(okTarget, { name: 'clean', charterFile: '' }, workspace, { quiet: true }, [], undefined); cleanOk = fs.existsSync(okTarget); } catch (_e) { cleanOk = false; }
  check(cleanOk, 'blocked-filename guard: a NON-blocked charter name still writes (control)');

  // ── --slug path-traversal guard (addPhase rejects separators / .. / absolute) ──
  // `--slug ../../OUT` must never let a phase folder escape the epic. Use a fresh
  // throwaway epic so a surviving mutant only scribbles inside travEpic.
  const travEpic = path.join(workspace, 'trav-epic');
  scaffold.epicInit(travEpic, commonOpts);
  let travDotDot = false;
  try { addPhase(travEpic, { slug: '../escape', team: 'ship', configPath, startDir: workspace }, commonOpts); }
  catch (e) { travDotDot = /plain folder name/.test(e.message); }
  check(travDotDot, '--slug path-traversal guard: addPhase rejects a slug containing ".."');
  let travSep = false;
  try { addPhase(travEpic, { slug: 'a/b', team: 'ship', configPath, startDir: workspace }, commonOpts); }
  catch (e) { travSep = /plain folder name/.test(e.message); }
  check(travSep, '--slug path-traversal guard: addPhase rejects a slug containing a "/" separator');
  // control: a plain slug is accepted
  const travOk = addPhase(travEpic, { slug: 'plain-slug', team: 'ship', configPath, startDir: workspace }, commonOpts);
  check(/-plain-slug$/.test(travOk.phaseFolder), '--slug guard: a plain slug is still accepted (control)');

  // ── subagent.env no-clobber guard (dropSubagentEnv never overwrites an env) ────
  // The orchestrator may have populated tmp/subagent.env with real values; a later
  // scaffold pass must NOT clobber it. dropSubagentEnv returns null + leaves the
  // file byte-for-byte when one already exists.
  const clobberTmp = path.join(workspace, 'clobber-tmp');
  fs.mkdirSync(clobberTmp, { recursive: true });
  const preEnv = 'PRESEEDED=1\nEMU_HOST=127.0.0.1\n';
  fs.writeFileSync(path.join(clobberTmp, 'subagent.env'), preEnv);
  let noClobberOk = false;
  try {
    const note = scaffold.dropSubagentEnv(clobberTmp, {}, workspace, { quiet: true }, [], undefined);
    noClobberOk = (note === null) && (fs.readFileSync(path.join(clobberTmp, 'subagent.env'), 'utf8') === preEnv);
  } catch (_e) { noClobberOk = false; }
  check(noClobberOk, 'subagent.env no-clobber guard: dropSubagentEnv leaves an existing env untouched (returns null, content byte-identical)');
  // control: dropped fresh when absent
  const freshTmp = path.join(workspace, 'fresh-tmp');
  fs.mkdirSync(freshTmp, { recursive: true });
  const freshNote = scaffold.dropSubagentEnv(freshTmp, {}, workspace, { quiet: true }, [], undefined);
  check(freshNote && fs.existsSync(path.join(freshTmp, 'subagent.env')), 'subagent.env no-clobber guard: a fresh tmp/ still GETS the stub (control)');

  // ═══════════════════════════════════════════════════════════════════════════
  // PRE-TASK ACK GATE (2026-08-30) — add-phase enforces the modes-plan §2 questions
  // gate MECHANICALLY: no receipt / no acceptance line → refuse to scaffold. Closes the
  // "questions silently skipped" failure (session-007, twice). Each reject path is a
  // deliberate-mutation target (see tests/mutation-check.js). Calls scaffold.addPhase
  // DIRECTLY (not the ack-injecting wrapper) so the gate is what's under test.
  // ═══════════════════════════════════════════════════════════════════════════
  const gateEpic = path.join(workspace, 'gate-epic');
  scaffold.epicInit(gateEpic, commonOpts);
  // (a) NO --pretask-ack → refuse, and scaffold NOTHING
  let noAck = false;
  try { scaffold.addPhase(gateEpic, { slug: 'x', team: 'ship', configPath, startDir: workspace }, commonOpts); }
  catch (e) { noAck = /requires --pretask-ack/.test(e.message); }
  check(noAck, 'ack gate: add-phase with NO --pretask-ack is refused');
  check(!fs.existsSync(path.join(gateEpic, '01-x')), 'ack gate: a refused add-phase writes no phase folder');
  // (b) receipt with a PLACEHOLDER acceptance → refuse
  const badAck = path.join(gateEpic, '00-epic-plan', 'bad-ack.md');
  fs.writeFileSync(badAck, '# pretask\n- **Accepted:** {{FILL}}\n');
  let placeholderAck = false;
  try { scaffold.addPhase(gateEpic, { slug: 'x', team: 'ship', configPath, startDir: workspace, pretaskAck: badAck }, commonOpts); }
  catch (e) { placeholderAck = /empty or a placeholder/.test(e.message); }
  check(placeholderAck, 'ack gate: a receipt whose acceptance is a placeholder ("{{FILL}}") is refused');
  // (c) receipt that EXISTS but has no **Accepted:** line → refuse
  const noLineAck = path.join(gateEpic, '00-epic-plan', 'noline-ack.md');
  fs.writeFileSync(noLineAck, '# pretask\nWe talked about it, seemed fine.\n');
  let noLine = false;
  try { scaffold.addPhase(gateEpic, { slug: 'x', team: 'ship', configPath, startDir: workspace, pretaskAck: noLineAck }, commonOpts); }
  catch (e) { noLine = /no "\*\*Accepted:\*\*" line/.test(e.message); }
  check(noLine, 'ack gate: a receipt with no **Accepted:** line is refused');
  // (d) a nonexistent receipt path → refuse
  let missingAck = false;
  try { scaffold.addPhase(gateEpic, { slug: 'x', team: 'ship', configPath, startDir: workspace, pretaskAck: path.join(gateEpic, 'nope.md') }, commonOpts); }
  catch (e) { missingAck = /ack file not found/.test(e.message); }
  check(missingAck, 'ack gate: a nonexistent --pretask-ack path is refused');
  // (e) a VALID receipt → scaffolds + returns ackNote (control)
  const goodAck = path.join(gateEpic, '00-epic-plan', 'pretask-01.md');
  fs.writeFileSync(goodAck, '# pretask — research\n- **User response:** "all defaults"\n- **Accepted:** all defaults\n');
  const gatePh = scaffold.addPhase(gateEpic, { slug: 'go', team: 'ship', configPath, startDir: workspace, pretaskAck: goodAck }, commonOpts);
  check(gatePh.phaseFolder === '01-go' && gatePh.ackNote && gatePh.ackNote.value === 'all defaults',
    'ack gate: a valid receipt scaffolds and returns ackNote.value = the accept phrase (control)');
  // (f) readPretaskAck unit: freeform value ok; a negative ("no") is not
  check(scaffold.readPretaskAck(goodAck, { startDir: workspace }).ok === true, 'readPretaskAck: valid receipt → ok');
  const negAck = path.join(gateEpic, '00-epic-plan', 'neg-ack.md');
  fs.writeFileSync(negAck, '- **Accepted:** no\n');
  check(scaffold.readPretaskAck(negAck, { startDir: workspace }).ok === false, 'readPretaskAck: "**Accepted:** no" → not ok');

  // ── DoD 8: CLI is portable — --help exits 0, end-to-end epic-init exits 0 ──
  let helpOut = '';
  try {
    helpOut = execFileSync('node', [SCAFFOLD_JS, '--help'], { encoding: 'utf8' });
    check(/SUBCOMMANDS/.test(helpOut), 'CLI --help prints usage (exit 0)');
  } catch (e) { check(false, `CLI --help failed: ${e.message}`); }

  const cliEpic = path.join(workspace, 'cli-epic');
  try {
    execFileSync('node', [SCAFFOLD_JS, 'epic-init', cliEpic, '--quiet'], { encoding: 'utf8' });
    check(isFile(path.join(cliEpic, '00-epic-plan', 'epic-plan.md')), 'CLI epic-init end-to-end produces 00-epic-plan/epic-plan.md');
    execFileSync('node', [SCAFFOLD_JS, 'add-phase', cliEpic, '--slug', 'go', '--team', 'ship', '--config', configPath, '--pretask-ack', ackFile, '--quiet'],
      { encoding: 'utf8', cwd: workspace });
    check(isDir(path.join(cliEpic, '01-go', FOLDERS.tmp, 'verifier-r1-v1')), 'CLI add-phase end-to-end produces 01-go/tmp/verifier-r1-v1/');
    check(isFile(path.join(cliEpic, '01-go', FOLDERS.tmp, 'subagent.env')), 'CLI add-phase drops tmp/subagent.env (fix #3, end-to-end)');
    // CLI --charter (fix #5): the flag is parsed and routed to the named role.
    const cliMvp = path.join(workspace, 'cli-mvp-charter.md');
    fs.writeFileSync(cliMvp, '# Charter — mvp\n\nMVP via CLI flag.\n');
    execFileSync('node', [SCAFFOLD_JS, 'add-phase', cliEpic, '--slug', 'opt', '--team', 'ship', '--config', configPath, '--charter', cliMvp, '--role', 'builder', '--pretask-ack', ackFile, '--quiet'],
      { encoding: 'utf8', cwd: workspace });
    check(fs.readFileSync(path.join(cliEpic, '02-opt', 'charter-builder.md'), 'utf8').includes('MVP via CLI flag'),
      'CLI --charter routes the chosen charter to --role builder (fix #5, end-to-end)');
    // CLI enforces the ack gate too: add-phase WITHOUT --pretask-ack exits 1
    let cliNoAck = 0;
    try { execFileSync('node', [SCAFFOLD_JS, 'add-phase', cliEpic, '--slug', 'noack', '--team', 'ship', '--config', configPath, '--quiet'], { encoding: 'utf8', cwd: workspace, stdio: 'pipe' }); }
    catch (e) { cliNoAck = e.status; }
    check(cliNoAck === 1, 'CLI ack gate: add-phase without --pretask-ack exits 1 (fixture: session-007 skip)');
  } catch (e) { check(false, `CLI end-to-end failed: ${e.message}`); }

  // unknown subcommand exits nonzero
  let cliBadExit = 0;
  try { execFileSync('node', [SCAFFOLD_JS, 'bogus'], { encoding: 'utf8', stdio: 'pipe' }); }
  catch (e) { cliBadExit = e.status; }
  check(cliBadExit === 2, 'CLI unknown subcommand exits 2');

  // ── #1183: resolveBase (bare name -> devDir; separator/absolute -> as-is) ─────────────────
  const rb = scaffold.resolveBase;
  check(rb('my-epic', 'dev') === path.join('dev', 'my-epic'), 'resolveBase: bare name + devDir "dev" -> dev/my-epic');
  check(rb('my-epic', 'docs/plans') === path.join('docs/plans', 'my-epic'), 'resolveBase: bare name + custom devDir -> docs/plans/my-epic');
  check(rb('dev/x', 'docs') === 'dev/x', 'resolveBase: dev/x honored as-is (no double-prefix)');
  check(rb('sub/x', 'docs') === 'sub/x', 'resolveBase: sub/x honored as-is');
  check(rb('/abs/x', 'docs') === '/abs/x', 'resolveBase: absolute honored as-is');
  check(rb('a\\b', 'docs') === 'a\\b', 'resolveBase: backslash path honored as-is');
  check(rb('x') === path.join('dev', 'x'), 'resolveBase: devDir omitted -> shipped default "dev"');
  try {
    const rbWs = path.join(workspace, 'resolvebase-cli');
    fs.mkdirSync(rbWs, { recursive: true });
    const rbCfg = path.join(rbWs, 'config.json');
    fs.writeFileSync(rbCfg, JSON.stringify({ workflow: { devDir: 'mydev' } }));
    execFileSync('node', [SCAFFOLD_JS, 'epic-init', 'bare-epic', '--config', rbCfg, '--quiet'], { encoding: 'utf8', cwd: rbWs, stdio: 'pipe' });
    check(isDir(path.join(rbWs, 'mydev', 'bare-epic', '00-epic-plan')), 'CLI epic-init <bare> lands under configured devDir (mydev/bare-epic)');
    execFileSync('node', [SCAFFOLD_JS, 'epic-init', 'dev/sep-epic', '--config', rbCfg, '--quiet'], { encoding: 'utf8', cwd: rbWs, stdio: 'pipe' });
    check(isDir(path.join(rbWs, 'dev', 'sep-epic', '00-epic-plan')) && !isDir(path.join(rbWs, 'mydev', 'dev')), 'CLI epic-init dev/<epic> honored as-is (no double-prefix)');
  } catch (e) { check(false, `resolveBase CLI failed: ${e.message}`); }

  // ── report ───────────────────────────────────────────────────────────────
  process.stdout.write(`\n${failures.length ? 'FAIL' : 'PASS'} — ${passed} checks passed, ${failures.length} failed\n`);
  if (failures.length) {
    keepOnExit = true;
    process.stdout.write(`scratch kept for inspection: ${workspace}\n`);
    process.exit(1);
  }
}

try {
  main();
} catch (err) {
  keepOnExit = true;
  process.stderr.write(`\nUNCAUGHT: ${err.stack || err.message}\nscratch kept: ${workspace}\n`);
  process.exit(1);
} finally {
  if (!keepOnExit) {
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch (_e) { /* best-effort */ }
  }
}
