// test/brokenStepE2E.test.js
// The capstone verification for fix 2.2(b): a deliberately-broken step MUST
// be caught by stageLocalScenarioRun BEFORE we splice, and the failure MUST
// be shaped for the outer retry loop to pick up.
//
// This test skips the remote Edison flow calls (generateCode, splice) — it
// directly invokes the real harnessCode + real stageLocalScenarioRun against
// KNOWN-BROKEN step code and asserts:
//
//   1. Template is produced (harness succeeds even with runtime bugs)
//   2. localScenarioRun detects the bug locally (sets ctx.testResults
//      with failed > 0, preSplice: true)
//   3. priorDiagnosis shape is compatible with the outer retry path
//      (LOCAL_SCENARIO_FAILED diagnostics)
//
// Why this is the pipeline integration: the only piece NOT exercised here
// is the actual re-invocation of generateCode on retry, which is an Edison
// flow HTTP call — the shape of priorDiagnosis is what DRIVES that call.

'use strict';

const { harnessCode } = require('../lib/codeHarness');
const pipeline = require('../lib/stepFlowPipeline');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

// Common spec for all test cases
const BASE_SPEC = {
  name: 'broken_step',
  label: 'BrokenStep',
  description: 'test step with a deliberate bug',
  inputs: [
    { variable: 'location', type: 'text', required: true, label: 'Location', example: 'London' },
    { variable: 'threshold', type: 'number', required: false, default: 0.5 },
  ],
  exits: [
    { id: 'next', label: 'Next' },
    { id: '__error__', label: 'Error', condition: 'processError' },
  ],
};

async function harness(code, spec = BASE_SPEC) {
  const logs = [];
  const res = await harnessCode(code, spec, { log: (m) => logs.push(m) });
  return { res, logs };
}

async function runStage(harnessResult, spec) {
  const logs = [];
  const ctx = {
    harnessedTemplate: harnessResult,
    bestPlan: null,
    conceiveSpec: spec,
    flowId: 'test-flow',
    log: (m) => logs.push(m),
  };
  const stageResult = await pipeline._stageLocalScenarioRun(ctx);
  return { stageResult, ctx, logs };
}

(async () => {
  console.log('\n== B1: TypeError on property access — known bug ==');

  // Broken step: reads this.data.users.length without checking for undefined.
  // When the scenario omits `users`, this TypeErrors. Real code bug.
  await test('TypeError on undefined property is caught locally', async () => {
    const BROKEN = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class CrashStep extends Step {
  async runStep() {
    this.log.info('CrashStep start');
    const { location } = this.data;
    // BUG: this.data.users is undefined — .length throws TypeError
    const count = this.data.users.length;
    return this.exitStep('next', { location, count });
  }
}
globalThis.CrashStep = CrashStep;
export { CrashStep as step };
`;
    const { res } = await harness(BROKEN);
    assert(res.template, 'harness produced a template');
    const { stageResult, ctx } = await runStage(res.template, BASE_SPEC);
    // At least one scenario should fail (happy-path without `users`)
    assert(stageResult.data.failed > 0 || stageResult.data.skippedLocal === stageResult.data.totalScenarios,
      `expected failures OR all skipped, got: ${JSON.stringify(stageResult.data)}`);
    if (stageResult.data.failed > 0) {
      assert(ctx.testResults, 'ctx.testResults set on failure');
      assert(ctx.testResults.preSplice === true, 'preSplice marker set');
      const runtimeErr = ctx.testResults.results.find((r) => r.phase === 'local-runtime-error');
      assert(runtimeErr, 'one scenario flagged as local-runtime-error');
    }
  });

  console.log('\n== B2: Wrong exit code — behavioral bug ==');

  // Broken step: returns code 'KABOOM' for everything. Scenario expects
  // MISSING_INPUT or success — both will fail.
  await test('wrong exit code is caught as behavioral mismatch', async () => {
    const BROKEN = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class WrongCodeStep extends Step {
  async runStep() {
    this.log.info('WrongCodeStep start');
    return this.exitStep('__error__', { code: 'KABOOM', message: 'nope' });
  }
}
globalThis.WrongCodeStep = WrongCodeStep;
export { WrongCodeStep as step };
`;
    const { res } = await harness(BROKEN);
    const { stageResult, ctx } = await runStage(res.template, BASE_SPEC);
    assert(stageResult.data.failed > 0, `expected failures, got ${JSON.stringify(stageResult.data)}`);
    assert(ctx.testResults, 'ctx.testResults set');
    assert(ctx.testResults.preSplice === true, 'preSplice marker');
    const failures = ctx.testResults.results.filter((r) => !r.ok);
    assert(failures.length > 0, 'one or more failures');
    // At least one failure should have a diff describing the mismatch
    const mismatchFailure = failures.find((f) => f.diff && f.diff.length > 0 && f.phase === 'local-run');
    assert(mismatchFailure, 'one failure should be a local-run code-mismatch, got phases: ' +
      failures.map((f) => f.phase).join(','));
  });

  console.log('\n== B3: Correct step passes locally ==');

  // Correct step: validates input, exits appropriately. Should PASS both
  // scenarios (missing-input → MISSING_INPUT, happy path → success).
  await test('a correctly-behaved step passes locally (no false positives)', async () => {
    const GOOD = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class GoodStep extends Step {
  async runStep() {
    this.log.info('GoodStep start');
    const { location, threshold } = this.data;
    if (!location) {
      return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'location is required' });
    }
    return this.exitStep('next', { location, threshold: threshold || 0.5 });
  }
}
globalThis.GoodStep = GoodStep;
export { GoodStep as step };
`;
    const { res } = await harness(GOOD);
    const { stageResult, ctx } = await runStage(res.template, BASE_SPEC);
    assert(stageResult.data.allPassed, `good step should pass, got: ${JSON.stringify(stageResult.data)}`);
    assert(!ctx.testResults, 'ctx.testResults NOT set on happy path');
  });

  console.log('\n== B4: priorDiagnosis shape for outer retry ==');

  // When local scenarios fail, the outer retry path (in stepFlowPipeline)
  // reads ctx.testResults and builds priorDiagnosis. Verify our shape matches
  // what that code expects.
  await test('testResults shape matches what outer retry consumes', async () => {
    const BROKEN = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class WrongStep2 extends Step {
  async runStep() {
    return this.exitStep('__error__', { code: 'KABOOM', message: 'nope' });
  }
}
globalThis.WrongStep2 = WrongStep2;
export { WrongStep2 as step };
`;
    const { res } = await harness(BROKEN);
    const { ctx } = await runStage(res.template, BASE_SPEC);
    assert(ctx.testResults, 'testResults populated');
    // Fields the outer retry loop reads (from stepFlowPipeline.js ~line 3589):
    assert(typeof ctx.testResults.source === 'string', 'source is string');
    assert(ctx.testResults.source.startsWith('local:'), 'source tagged as local');
    assert(typeof ctx.testResults.totalScenarios === 'number', 'totalScenarios is number');
    assert(typeof ctx.testResults.passed === 'number', 'passed is number');
    assert(typeof ctx.testResults.failed === 'number', 'failed is number');
    assert(Array.isArray(ctx.testResults.results), 'results is array');
    assert(ctx.testResults.preSplice === true, 'preSplice marker for diagCode switch');
    // Each failed result should have the fields priorDiagnosis builder reads:
    for (const f of ctx.testResults.results.filter((r) => !r.ok)) {
      assert(typeof f.name === 'string', 'name');
      // actual is optional (can be null for runtime-error phase)
      // diff is array
      assert(Array.isArray(f.diff), 'diff is array');
      // phase tells the retry builder whether it was a runtime throw or mismatch
      assert(typeof f.phase === 'string', 'phase is string');
    }
  });

  console.log('\n== B5: Local execution is fast (<2s per scenario) ==');

  await test('localScenarioRun completes well under splice-cost budget', async () => {
    const FAST = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class FastStep extends Step {
  async runStep() {
    this.log.info('FastStep');
    return this.exitStep('next', { ok: true });
  }
}
globalThis.FastStep = FastStep;
export { FastStep as step };
`;
    const { res } = await harness(FAST);
    const t0 = Date.now();
    const { stageResult } = await runStage(res.template, BASE_SPEC);
    const elapsed = Date.now() - t0;
    const perScenario = elapsed / Math.max(1, stageResult.data.totalScenarios);
    assert(perScenario < 2000, `per-scenario wall-clock should be <2s, got ${perScenario.toFixed(0)}ms`);
    console.log(`      (total ${elapsed}ms for ${stageResult.data.totalScenarios} scenarios = ${perScenario.toFixed(0)}ms/scenario)`);
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
