// test/localScenarioStage.test.js — unit-test the pre-splice local scenario
// stage (stageLocalScenarioRun). This stage is the biggest reliability win
// from the 2026-04 reliability audit (fix 2.2b): it runs scenarios through
// the in-process local runtime BEFORE splice so code defects trigger outer
// retry without paying the 30-90s splice+activate tax.
//
// The stage MUST:
//   1. Skip cleanly when there's no harnessed template or no scenarios.
//   2. PASS correctly-behaving code with valid inputs.
//   3. FAIL (populate ctx.testResults with failed>0, preSplice:true) when the
//      step throws a runtime error or returns the wrong exit.
//   4. SKIP scenarios whose step imports an unmocked or-sdk package, without
//      counting them as failures (deployed testStep will cover those).
//   5. Set ctx.testResults with shape compatible with stageTestStep, so the
//      existing outer retry loop picks up local failures without changes.

'use strict';

const { _stageLocalScenarioRun } = require('../lib/stepFlowPipeline');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${e.stack?.split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Baseline: a harnessed template shape compatible with what codeHarness
// produces. Contains: template (full logic.js), formBuilder.stepInputs,
// data.exits, label, name.
function mkHarnessed({ code, inputs = [], exits = ['next', '__error__'] }) {
  return {
    name: 'mock_step',
    label: 'MockStep',
    description: 'test',
    version: '1.0.0',
    template: code,
    data: {
      exits: exits.map((e) => ({ id: e, label: e })),
    },
    formBuilder: {
      stepInputs: inputs.map((i) => ({
        component: i.component || 'formTextInput',
        data: {
          variable: i.variable,
          label: i.label || i.variable,
          validateRequired: Boolean(i.required),
          defaultValue: i.default,
        },
      })),
    },
  };
}

function mkCtx(harnessed, { bestPlan = null, conceiveSpec = null, flowId = 'test-flow' } = {}) {
  const logs = [];
  return {
    ctx: {
      harnessedTemplate: harnessed,
      bestPlan,
      conceiveSpec,
      flowId,
      log: (m) => logs.push(m),
    },
    logs,
  };
}

const HAPPY_STEP_CODE = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class HappyStep extends Step {
  async runStep() {
    const name = this.data.name;
    if (!name) {
      return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'name required' });
    }
    return this.exitStep('next', { greeting: 'hello ' + name });
  }
}
globalThis.HappyStep = HappyStep;
`;

const CRASHING_STEP_CODE = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class CrashingStep extends Step {
  async runStep() {
    // TypeError: this.data.users is undefined, .length crashes
    const count = this.data.users.length;
    return this.exitStep('next', { count });
  }
}
globalThis.CrashingStep = CrashingStep;
`;

const WRONG_EXIT_STEP_CODE = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class WrongExitStep extends Step {
  async runStep() {
    // Step ships a custom error code that doesn't match the scenario's expect.
    return this.exitStep('__error__', { code: 'UNEXPECTED_BANANA', message: 'nope' });
  }
}
globalThis.WrongExitStep = WrongExitStep;
`;

const UNMOCKED_SDK_STEP_CODE = `
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
// Import a package that isn't in our sdkMocks — module load fails, stage
// should label this 'local-skipped' not failed.
const mystery = require('or-sdk/kitchen-sink-9000');

class UnmockedSDKStep extends Step {
  async runStep() {
    return this.exitStep('next', { ok: true });
  }
}
globalThis.UnmockedSDKStep = UnmockedSDKStep;
`;

(async () => {
  console.log('\n== stageLocalScenarioRun — skip cases ==');

  await test('skips when no harnessed template', async () => {
    const { ctx } = mkCtx(null);
    const r = await _stageLocalScenarioRun(ctx);
    assertEq(r.data.skipped, true, 'should skip');
    assertEq(r.data.reason, 'no harnessed template', 'reason');
    assert(!ctx.testResults, 'testResults not set');
  });

  await test('skips when template has no Step class', async () => {
    const { ctx } = mkCtx(mkHarnessed({ code: '// no Step class here' }));
    const r = await _stageLocalScenarioRun(ctx);
    assertEq(r.data.skipped, true, 'should skip');
    assertEq(r.data.reason, 'no class extends Step', 'reason');
  });

  await test('skips when no scenarios available (empty spec)', async () => {
    // formBuilder.stepInputs is empty → deriveScenariosFromSpec returns []
    const harnessed = mkHarnessed({
      code: HAPPY_STEP_CODE.replace('HappyStep', 'EmptyStep'),
      inputs: [],
    });
    const { ctx } = mkCtx(harnessed);
    const r = await _stageLocalScenarioRun(ctx);
    assertEq(r.data.skipped, true, 'should skip when no scenarios derivable');
  });

  console.log('\n== stageLocalScenarioRun — happy path ==');

  await test('passes when step code runs correctly against derived scenarios', async () => {
    const harnessed = mkHarnessed({
      code: HAPPY_STEP_CODE,
      inputs: [{ variable: 'name', required: true, example: 'Alice' }],
    });
    const { ctx, logs } = mkCtx(harnessed);
    const r = await _stageLocalScenarioRun(ctx);
    // We expect deriveScenariosFromSpec to produce at least 1 missing-required
    // scenario (that should pass, step returns MISSING_INPUT which matches
    // codeOneOfOrSuccess) + 1 happy-path scenario (that should pass: code is
    // undefined/null on success, which codeOneOfOrSuccess accepts).
    assert(r.data.totalScenarios > 0, 'should have derived scenarios');
    assertEq(r.data.failed, 0, `expected 0 failures, got ${r.data.failed}: ${logs.join('\n')}`);
    assert(r.data.allPassed, 'allPassed flag');
    assert(!ctx.testResults, 'testResults NOT set on happy path');
  });

  console.log('\n== stageLocalScenarioRun — failure path ==');

  await test('FAILS when step throws TypeError (real code bug)', async () => {
    const harnessed = mkHarnessed({
      code: CRASHING_STEP_CODE.replace('class CrashingStep', 'class CrashingStepA'),
      inputs: [{ variable: 'users', required: false }],
    });
    // Replace globalThis attachment in template too
    harnessed.template = harnessed.template.replace('globalThis.CrashingStep', 'globalThis.CrashingStepA');
    const { ctx } = mkCtx(harnessed);
    // Force class name pickup
    const r = await _stageLocalScenarioRun(ctx);
    assert(r.data.failed > 0, 'should have failed scenarios (happy-path crashes)');
    assert(ctx.testResults, 'testResults populated');
    assertEq(ctx.testResults.preSplice, true, 'preSplice flag set');
    assert(ctx.testResults.failed > 0, 'testResults.failed > 0');
    // The happy-path scenario should have phase 'local-runtime-error'
    const runtimeErr = ctx.testResults.results.find((x) => x.phase === 'local-runtime-error');
    assert(runtimeErr, 'at least one scenario should have local-runtime-error phase');
  });

  await test('FAILS on wrong exit code vs codeOneOfOrSuccess', async () => {
    // This step ALWAYS returns UNEXPECTED_BANANA. deriveScenariosFromSpec for
    // a step with a required input will produce:
    //   - missing-required scenario: expect codeOneOfOrSuccess=['MISSING_INPUT',...]
    //     → UNEXPECTED_BANANA is NOT in that list → FAIL
    //   - happy-path scenario: expect success (no code field) → UNEXPECTED_BANANA
    //     is a code → FAIL too
    const harnessed = mkHarnessed({
      code: WRONG_EXIT_STEP_CODE,
      inputs: [{ variable: 'name', required: true, example: 'Bob' }],
    });
    const { ctx } = mkCtx(harnessed);
    const r = await _stageLocalScenarioRun(ctx);
    assert(r.data.failed > 0, `expected failures; stage=${JSON.stringify(r.data)}`);
    assert(ctx.testResults, 'testResults populated');
    assertEq(ctx.testResults.preSplice, true, 'preSplice flag');
  });

  console.log('\n== stageLocalScenarioRun — graceful degradation ==');

  await test('SKIPS (does not fail) scenarios that use unmocked SDKs', async () => {
    const harnessed = mkHarnessed({
      code: UNMOCKED_SDK_STEP_CODE,
      inputs: [{ variable: 'name', required: false }],
    });
    const { ctx } = mkCtx(harnessed);
    const r = await _stageLocalScenarioRun(ctx);
    // All scenarios should skip locally (unmockable SDK); stage succeeds.
    assertEq(r.data.failed, 0, `unmockable SDK should not count as failure; got ${r.data.failed}`);
    assert(r.data.skippedLocal > 0, 'should have local-skipped scenarios');
    assert(!ctx.testResults, 'testResults NOT set when only skipped');
  });

  console.log('\n== stageLocalScenarioRun — shape compatibility with testStep ==');

  await test('ctx.testResults has shape compatible with outer retry', async () => {
    const harnessed = mkHarnessed({
      code: WRONG_EXIT_STEP_CODE,
      inputs: [{ variable: 'name', required: true, example: 'Carol' }],
    });
    const { ctx } = mkCtx(harnessed);
    await _stageLocalScenarioRun(ctx);
    const t = ctx.testResults;
    assert(t, 'testResults set');
    assertEq(typeof t.source, 'string', 'source is string');
    assert(t.source.startsWith('local:'), 'source tagged as local');
    assertEq(typeof t.totalScenarios, 'number', 'totalScenarios is number');
    assertEq(typeof t.passed, 'number', 'passed is number');
    assertEq(typeof t.failed, 'number', 'failed is number');
    assert(Array.isArray(t.results), 'results is array');
    assert(t.results.every((r) => typeof r.name !== 'undefined'), 'each result has a name');
    assert(t.results.every((r) => typeof r.ok === 'boolean'), 'each result has ok');
    assertEq(t.preSplice, true, 'preSplice marker');
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
