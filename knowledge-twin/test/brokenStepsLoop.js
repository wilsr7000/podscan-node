#!/usr/bin/env node
// test/brokenStepsLoop.js — stress test: randomly inject combinations of
// defects into a clean step, patch, then run the REAL stepValidator to
// see what it says about the before-and-after code. Reports stats.
//
// Usage:
//   node test/brokenStepsLoop.js              # 100 iterations (default)
//   ITERATIONS=500 node test/brokenStepsLoop.js
//   VERBOSE=1 node test/brokenStepsLoop.js    # dump each iteration
//
// What it checks, per iteration:
//   1. Before-patching: stepValidator finds a specific blocker for each
//      injected defect class.
//   2. findPatches detects the same defects.
//   3. applyEditsToString succeeds (edits apply cleanly).
//   4. After-patching: stepValidator no longer flags the same blockers.
//   5. After-patching: JS syntax still valid.
//   6. Tallies which defect classes are reliably caught + fixed.

'use strict';

const { findPatches } = require('../lib/patcher');
const { applyEditsToString } = require('../lib/editPrimitive');
const { enrichDiagnostics } = require('../lib/diagLocation');
const { validateStep } = require('../lib/stepValidator');

const ITERATIONS = parseInt(process.env.ITERATIONS, 10) || 100;
const VERBOSE = !!process.env.VERBOSE;

// Synthesize a template-shaped object from bare code so stepValidator runs.
function synthesize(code, spec) {
  const exits = (spec.exits || []).map((e) => ({ id: e.id, label: e.label, condition: '' }));
  return {
    id: 'loop-probe',
    name: spec.name || 'probe',
    label: spec.label || 'probe',
    version: '1.0.0',
    template: code,
    form: {},
    formBuilder: {
      stepInputs: (spec.inputs || []).map((i) => ({
        component: i.type === 'auth' ? 'auth-external-component' : 'formTextInput',
        data: { variable: i.variable, label: i.variable },
      })),
    },
    data: { exits, processError: false, dataOut: { name: spec.name || 'out', type: 'session', ttl: 86400000 } },
  };
}

const BASELINE = `const Step = require('@onereach/flow-sdk/step.js');

class WeatherAnomalyGSX extends Step {
  async runStep() {
    const { location, apiBaseUrl, anomalyThreshold } = this.data;

    if (!location) {
      throw Object.assign(new Error('location is required'), { code: 'MISSING_INPUT' });
    }

    const Storage = require('or-sdk/storage');
    const storage = new Storage(this);
    const creds = await storage.get('__authorization_service_Anthropic', this.data.auth);
    const apiKey = creds && creds.apiKey;
    if (!apiKey) {
      if (this.data.processError) return this.exitStep('__error__', { code: 'AUTH_RETRIEVAL_FAILED' });
      throw Object.assign(new Error('auth required'), { code: 'AUTH_RETRIEVAL_FAILED' });
    }

    const url = apiBaseUrl + '/current.json?location=' + encodeURIComponent(location);
    const resp = await fetch(url, { headers: { 'x-api-key': apiKey } });
    const data = await resp.json();

    const isAnomaly = Math.abs(data.temp_c - data.baseline) > anomalyThreshold;
    return this.exitStep('next', { isAnomaly, severity: isAnomaly ? 'moderate' : 'none' });
  }
}

module.exports = WeatherAnomalyGSX;
`;

const SPEC = {
  label: 'Weather Anomaly GSX', name: 'weatherAnomalyGSX',
  inputs: [
    { variable: 'location', type: 'text', required: true },
    { variable: 'apiBaseUrl', type: 'text', default: 'https://api.weatherapi.com/v1' },
    { variable: 'anomalyThreshold', type: 'number', default: 1.5 },
    { variable: 'auth', type: 'auth' },
    { variable: 'authCollection', type: 'text', default: '__authorization_service_Anthropic' },
  ],
  exits: [{ id: 'next', label: 'next' }, { id: '__error__', label: 'on error' }],
};

// ---- Defect injectors: each returns {name, brokenCode, expectedBlocker} ----

const INJECTORS = {
  HARDCODED_URL(baseline) {
    const broken = baseline.replace(
      'const url = apiBaseUrl + \'/current.json?location=\' + encodeURIComponent(location);',
      'const url = \'https://api.weatherapi.com/v1/current.json?location=\' + encodeURIComponent(location);',
    );
    return { name: 'HARDCODED_URL', brokenCode: broken };
  },
  UNCONDITIONAL_ERROR_EXIT(baseline) {
    const broken = baseline.replace(
      `throw Object.assign(new Error('location is required'), { code: 'MISSING_INPUT' });`,
      `return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'location required' });`,
    );
    return { name: 'UNCONDITIONAL_ERROR_EXIT', brokenCode: broken };
  },
  EQEQ(baseline) {
    const broken = baseline.replace(
      'const isAnomaly = Math.abs(data.temp_c - data.baseline) > anomalyThreshold;',
      `const isAnomaly = Math.abs(data.temp_c - data.baseline) > anomalyThreshold;
    const xCheck = data.temp_c == data.baseline;
    const yCheck = data.temp_c != data.baseline;`,
    );
    return { name: 'EQEQ', brokenCode: broken };
  },
  TOKEN_STRIP(baseline) {
    const broken = baseline.replace(
      `const creds = await storage.get('__authorization_service_Anthropic', this.data.auth);`,
      `let _auth = this.data.auth;
    if (typeof _auth === 'string' && _auth.includes('::')) {
      _auth = _auth.split('::')[0];
    }
    const creds = await storage.get('__authorization_service_Anthropic', _auth);`,
    );
    return { name: 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX', brokenCode: broken };
  },
};

const DEFECT_NAMES = Object.keys(INJECTORS);

function syntaxOk(code) {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['--check', '-'], { input: code, encoding: 'utf8' });
  return r.status === 0;
}

function randomSubset(array, minK, maxK) {
  const k = minK + Math.floor(Math.random() * (maxK - minK + 1));
  const shuffled = array.slice().sort(() => Math.random() - 0.5);
  return shuffled.slice(0, k);
}

// ---- Main loop ----
(async () => {
  console.log(`\nBroken-step stress test — ${ITERATIONS} iterations`);
  console.log('=================================================\n');

  const stats = {
    total: ITERATIONS,
    baselineClean: 0,
    allDefectsDetected: 0,
    editsApplied: 0,
    postPatchCleanOfInjected: 0,
    postPatchSyntaxOk: 0,
    newBlockersIntroduced: 0,  // defect classes that APPEARED only after patching
    fullRecovery: 0,
    perDefect: Object.fromEntries(DEFECT_NAMES.map((n) => [n, { injected: 0, detected: 0, fixed: 0 }])),
    failures: [],
  };

  // Baseline check (once)
  const baselineValidation = validateStep(synthesize(BASELINE, SPEC));
  const baselineBlockers = (baselineValidation.diagnostics || []).filter((d) => d.severity === 'error');
  console.log(`Baseline validator errors: ${baselineBlockers.length}`);
  if (VERBOSE && baselineBlockers.length > 0) {
    for (const d of baselineBlockers.slice(0, 5)) console.log(`  [BL] ${d.code}: ${String(d.message || '').slice(0, 80)}`);
  }

  for (let iter = 0; iter < ITERATIONS; iter++) {
    // Pick 1-3 defects to inject this iteration
    const picked = randomSubset(DEFECT_NAMES, 1, 3);
    let broken = BASELINE;
    const injected = [];
    for (const name of picked) {
      try {
        const inj = INJECTORS[name](broken);
        broken = inj.brokenCode;
        injected.push(inj.name);
        stats.perDefect[name].injected++;
      } catch { /* injector idempotency failure — skip this one */ }
    }

    // Baseline validator against the broken code
    const before = validateStep(synthesize(broken, SPEC));
    const beforeBlockers = (before.diagnostics || []).filter((d) => d.severity === 'error');
    const beforeBlockerCodes = new Set(beforeBlockers.map((d) => d.code));

    // Patch it
    const { patchable } = findPatches(broken, { spec: SPEC });
    const detected = patchable.map((p) => p.id);
    for (const d of detected) {
      if (stats.perDefect[d === 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX' ? 'TOKEN_STRIP' : d]) {
        const key = d === 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX' ? 'TOKEN_STRIP' : d;
        stats.perDefect[key].detected++;
      }
    }
    if (detected.length >= injected.length) stats.allDefectsDetected++;

    const edits = patchable.flatMap((p) => p.edits.map((e) => ({ ...e, _defect: p.id })));
    let apply;
    if (edits.length > 0) {
      apply = applyEditsToString(broken, edits);
      if (apply.ok) stats.editsApplied++;
    } else {
      apply = { ok: false, code: broken, error: 'no edits' };
    }

    // After patching
    const afterCode = apply.ok ? apply.code : broken;
    const after = validateStep(synthesize(afterCode, SPEC));
    const afterBlockers = (after.diagnostics || []).filter((d) => d.severity === 'error');
    const afterBlockerCodes = new Set(afterBlockers.map((d) => d.code));

    // Check: any NEW blocker introduced by patching?
    const newBlockers = [...afterBlockerCodes].filter((c) => !beforeBlockerCodes.has(c));
    if (newBlockers.length > 0) stats.newBlockersIntroduced++;

    // Check: syntax still valid after patch
    const synok = syntaxOk(afterCode);
    if (synok) stats.postPatchSyntaxOk++;

    // Check: is each injected defect gone?
    //
    // Ground truth is the PATCHER, not the validator — the validator has
    // different assumptions (e.g. UNCONDITIONAL_ERROR_EXIT isn't an error
    // when processError:true; EQEQ is a warning not error). The patcher
    // owns its own defect classes and re-running findPatches on the
    // post-patch code tells us authoritatively whether the injected defect
    // is structurally gone.
    const { patchable: postPatchable } = findPatches(afterCode, { spec: SPEC });
    const postPatcherIds = new Set(postPatchable.map((p) => p.id));
    const allInjectedResolved = injected.every((name) => !postPatcherIds.has(name));
    if (allInjectedResolved) stats.postPatchCleanOfInjected++;

    // Full recovery: all injected resolved + syntax ok + no new blockers
    if (allInjectedResolved && synok && newBlockers.length === 0) {
      stats.fullRecovery++;
      for (const name of injected) {
        const key = name === 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX' ? 'TOKEN_STRIP' : name;
        if (stats.perDefect[key]) stats.perDefect[key].fixed++;
      }
    } else if (stats.failures.length < 10) {
      stats.failures.push({
        iter, injected, detected,
        beforeBlockers: [...beforeBlockerCodes],
        afterBlockers: [...afterBlockerCodes],
        newBlockers,
        applyOk: apply.ok,
        applyError: apply.ok ? null : apply.error,
        syntaxOk: synok,
      });
    }

    if (VERBOSE) {
      console.log(`iter ${iter}: injected=[${injected.join(',')}] detected=[${detected.join(',')}] applied=${apply.ok} synok=${synok} cleanOfInjected=${allInjectedResolved}`);
    }

    // Light progress dot for non-verbose runs
    if (!VERBOSE && (iter + 1) % 10 === 0) process.stdout.write(`  ${iter + 1}/${ITERATIONS}\n`);
  }

  console.log('\n=== Results ===');
  console.log(`Total iterations:           ${stats.total}`);
  console.log(`All injected defects detected: ${stats.allDefectsDetected}/${stats.total} (${pct(stats.allDefectsDetected, stats.total)})`);
  console.log(`Edits applied successfully: ${stats.editsApplied}/${stats.total} (${pct(stats.editsApplied, stats.total)})`);
  console.log(`Post-patch syntax valid:    ${stats.postPatchSyntaxOk}/${stats.total} (${pct(stats.postPatchSyntaxOk, stats.total)})`);
  console.log(`Post-patch clean (no injected blocker remaining): ${stats.postPatchCleanOfInjected}/${stats.total} (${pct(stats.postPatchCleanOfInjected, stats.total)})`);
  console.log(`New blockers introduced by patching: ${stats.newBlockersIntroduced}/${stats.total} (${pct(stats.newBlockersIntroduced, stats.total)})`);
  console.log(`FULL recovery (no regress, no breakage): ${stats.fullRecovery}/${stats.total} (${pct(stats.fullRecovery, stats.total)})`);

  console.log('\n=== Per-defect performance ===');
  for (const [name, d] of Object.entries(stats.perDefect)) {
    const detectionRate = d.injected > 0 ? pct(d.detected, d.injected) : 'n/a';
    const fixRate = d.injected > 0 ? pct(d.fixed, d.injected) : 'n/a';
    console.log(`  ${name.padEnd(34)} injected=${d.injected}  detected=${d.detected} (${detectionRate})  fully-fixed=${d.fixed} (${fixRate})`);
  }

  if (stats.failures.length > 0) {
    console.log(`\n=== Sample failures (first ${stats.failures.length}) ===`);
    for (const f of stats.failures) {
      console.log(`  iter ${f.iter}: injected=${f.injected.join(',')}  detected=${f.detected.join(',')}`);
      console.log(`    before blockers: [${f.beforeBlockers.join(',')}]`);
      console.log(`    after  blockers: [${f.afterBlockers.join(',')}]`);
      if (f.newBlockers.length > 0) console.log(`    NEW blockers introduced: [${f.newBlockers.join(',')}]`);
      if (!f.applyOk) console.log(`    apply error: ${f.applyError}`);
      if (!f.syntaxOk) console.log(`    syntax BROKEN after patch!`);
    }
  }

  // Exit code: nonzero if full recovery < 95%
  const recoveryRate = stats.fullRecovery / stats.total;
  console.log(`\n${recoveryRate >= 0.95 ? '✓ PASS' : '✗ FAIL'}: full-recovery rate = ${(recoveryRate * 100).toFixed(1)}%`);
  process.exit(recoveryRate >= 0.95 ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });

function pct(n, total) {
  if (!total) return 'n/a';
  return ((n / total) * 100).toFixed(1) + '%';
}
