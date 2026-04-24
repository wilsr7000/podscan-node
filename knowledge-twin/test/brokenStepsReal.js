#!/usr/bin/env node
// test/brokenStepsReal.js — run the patcher against REAL pipeline-generated
// step code from past .pipeline-jobs/. This is the "breadth" test — does
// the patcher behave sensibly across many real step shapes and spec shapes,
// not just the synthesized WeatherAnomaly?
//
// For each sample:
//   1. Load codegen-result.json (has the LLM-produced code + spec)
//   2. Run the step validator BEFORE patching
//   3. Run findPatches + applyEditsToString
//   4. Run the step validator AFTER patching
//   5. Report: detected defects, applied, validator-error delta,
//      new-blockers-introduced (critical).

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { findPatches } = require('../lib/patcher');
const { applyEditsToString } = require('../lib/editPrimitive');
const { validateStep } = require('../lib/stepValidator');
const { enrichDiagnostics } = require('../lib/diagLocation');

const VERBOSE = !!process.env.VERBOSE;

// Synthesize a template-shaped object for validator input.
function synthesize(code, spec) {
  spec = spec || { inputs: [], exits: [] };
  const exits = (spec.exits || []).map((e) => ({ id: e.id, label: e.label, condition: '' }));
  const hasProcessError = exits.some((e) => e.id === '__error__' || /error/i.test(e.id));
  return {
    id: 'real-probe',
    name: spec.name || 'probe',
    label: spec.label || 'probe',
    version: '1.0.0',
    description: spec.description || '',
    template: code,
    form: {},
    formBuilder: {
      stepInputs: (spec.inputs || []).map((i) => ({
        component: i.type === 'auth' ? 'auth-external-component' : 'formTextInput',
        data: { variable: i.variable, label: i.label || i.variable },
      })),
    },
    data: {
      exits,
      processError: hasProcessError,
      processTimeout: false,
      dataOut: spec.dataOut || { name: spec.name || 'out', type: 'session', ttl: 86400000 },
    },
  };
}

function parses(code) {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');
  // Real pipeline-generated step code uses ESM syntax (top-level await +
  // export). To syntax-check, write to a temp .mjs file so Node parses in
  // module mode.
  const tmp = path.join(os.tmpdir(), `parse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    const r = spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' });
    return r.status === 0;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function blockerCodes(result) {
  return new Set((result.diagnostics || []).filter((d) => d.severity === 'error').map((d) => d.code));
}

function setDiff(a, b) {
  return [...a].filter((x) => !b.has(x));
}

// ---- Main ----
(async () => {
  const files = fs.readdirSync('.pipeline-jobs')
    .filter((d) => fs.existsSync(path.join('.pipeline-jobs', d, 'codegen-result.json')))
    .map((d) => path.join('.pipeline-jobs', d, 'codegen-result.json'))
    .slice(-20);  // last 20 runs

  if (files.length === 0) {
    console.log('No codegen-result.json files found in .pipeline-jobs/');
    process.exit(0);
  }

  console.log(`\nPatcher × ${files.length} real pipeline-generated steps\n`);
  console.log('═'.repeat(100));

  const overall = {
    samples: files.length,
    parseBaseline: 0,
    cleanBaseline: 0,
    detectedDefects: 0,
    appliedSuccess: 0,
    syntaxHeld: 0,
    newBlockersIntroduced: 0,
    validatorErrorsReduced: 0,
    validatorErrorsUnchanged: 0,
    validatorErrorsIncreased: 0,
    byPatcherId: new Map(),
  };

  for (const f of files) {
    const jobDir = path.basename(path.dirname(f));
    let blob;
    try { blob = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) {
      console.log(`  ✗ ${jobDir}: parse ${e.message}`);
      continue;
    }
    const code = blob.result?.code || blob.code || '';
    const spec = blob.spec || blob.fullSpec || null;
    if (!code) {
      console.log(`  — ${jobDir}: no code field`);
      continue;
    }

    const parsesBase = parses(code);
    if (parsesBase) overall.parseBaseline++;

    // BEFORE
    let before;
    try {
      before = validateStep(synthesize(code, spec));
      before.diagnostics = enrichDiagnostics(before.diagnostics || [], code);
    } catch (e) {
      console.log(`  ✗ ${jobDir}: validator threw: ${e.message}`);
      continue;
    }
    const beforeBlockers = blockerCodes(before);
    if (beforeBlockers.size === 0) overall.cleanBaseline++;

    // Patcher
    const { patchable } = findPatches(code, { spec });
    if (patchable.length > 0) overall.detectedDefects++;
    for (const p of patchable) {
      overall.byPatcherId.set(p.id, (overall.byPatcherId.get(p.id) || 0) + 1);
    }

    const edits = patchable.flatMap((p) => p.edits);
    const apply = edits.length > 0
      ? applyEditsToString(code, edits)
      : { ok: true, code, editsApplied: 0 };

    if (apply.ok) overall.appliedSuccess++;

    const afterCode = apply.ok ? apply.code : code;
    const afterParses = parses(afterCode);
    if (afterParses) overall.syntaxHeld++;

    // AFTER
    let after;
    try {
      after = validateStep(synthesize(afterCode, spec));
    } catch (e) {
      console.log(`  ✗ ${jobDir}: validator threw after-patch: ${e.message}`);
      continue;
    }
    const afterBlockers = blockerCodes(after);

    const newBlockers = setDiff(afterBlockers, beforeBlockers);
    const fixed = setDiff(beforeBlockers, afterBlockers);
    if (newBlockers.length > 0) overall.newBlockersIntroduced++;
    if (afterBlockers.size < beforeBlockers.size) overall.validatorErrorsReduced++;
    else if (afterBlockers.size === beforeBlockers.size) overall.validatorErrorsUnchanged++;
    else overall.validatorErrorsIncreased++;

    // Per-sample summary line
    const specLabel = (spec && (spec.label || spec.name)) || '(no spec)';
    const line = [
      jobDir.slice(11, 25).padEnd(15),
      `"${specLabel}"`.padEnd(32).slice(0, 32),
      `code=${code.length}b`.padEnd(11),
      `pre=${beforeBlockers.size}err`.padEnd(9),
      `det=[${[...patchable].map((p) => p.id.slice(0, 8)).join(',').slice(0, 20)}]`.padEnd(24),
      apply.ok ? `applied=${apply.editsApplied || 0}` : `apply_FAIL(${apply.error})`,
      `post=${afterBlockers.size}err`.padEnd(10),
      fixed.length > 0 ? `fix:[${fixed.map((c) => c.slice(0, 10)).join(',')}]` : '',
      newBlockers.length > 0 ? ` NEW_BUGS:[${newBlockers.join(',')}]` : '',
    ].join(' ');
    console.log(line);

    if (VERBOSE && patchable.length > 0) {
      for (const p of patchable) {
        console.log(`    [${p.id}] ${p.rationale}  (${p.edits.length} edit${p.edits.length !== 1 ? 's' : ''})`);
      }
    }
  }

  console.log('═'.repeat(100));
  console.log(`\nOverall:`);
  console.log(`  Samples processed:               ${overall.samples}`);
  console.log(`  Code parses as JS (baseline):    ${overall.parseBaseline}/${overall.samples}`);
  console.log(`  Clean baseline (0 validator errs): ${overall.cleanBaseline}/${overall.samples}`);
  console.log(`  Samples where patcher found defects: ${overall.detectedDefects}/${overall.samples}`);
  console.log(`  Edits applied successfully:      ${overall.appliedSuccess}/${overall.samples}`);
  console.log(`  Syntax held post-patch:          ${overall.syntaxHeld}/${overall.samples}`);
  console.log(`  Validator err count REDUCED:     ${overall.validatorErrorsReduced}/${overall.samples}`);
  console.log(`  Validator err count UNCHANGED:   ${overall.validatorErrorsUnchanged}/${overall.samples}`);
  console.log(`  Validator err count INCREASED:   ${overall.validatorErrorsIncreased}/${overall.samples}`);
  console.log(`  NEW blockers introduced by patching: ${overall.newBlockersIntroduced}/${overall.samples} ${overall.newBlockersIntroduced === 0 ? '✓' : '⚠'}`);

  console.log(`\nPatcher hit counts across real samples:`);
  const sorted = [...overall.byPatcherId.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id, n] of sorted) console.log(`  ${id.padEnd(38)} ${n}`);

  // Pass criterion: no new blockers across all real samples.
  const pass = overall.newBlockersIntroduced === 0 && overall.syntaxHeld === overall.samples;
  console.log(`\n${pass ? '✓ PASS' : '✗ FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
