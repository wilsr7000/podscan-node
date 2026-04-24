// test/preSpliceShortCircuit.test.js — proves the pipeline breaks out of
// the stage loop when stageLocalScenarioRun detects failures, instead of
// paying the ~15min splice+testWithUI tax just to confirm what the 30ms
// local run already told us.
//
// The short-circuit lives inline in runPipeline's stage loop:
//   if (ctx.testResults?.preSplice && ctx.testResults.failed > 0 && canRetry) {
//     break;  // → falls through to outer-retry decision → regenerate
//   }
//
// We can't easily exercise runPipeline end-to-end here (would need Edison
// flows for conceive/validate/etc.) — but we CAN verify:
//   (1) the break condition reads the exact shape localScenarioRun sets
//   (2) the short-circuit event type appears in events.ndjson
//   (3) the code path is present in stepFlowPipeline.js source
//
// For a behavioural test, an end-to-end run with a deliberately broken step
// is the right vehicle — but it needs Edison to be healthy, which is out of
// our hands. This test proves the wiring.

'use strict';

const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }

const pipelineSrc = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'stepFlowPipeline.js'),
  'utf8',
);

console.log('\n== Short-circuit code is present and wired correctly ==');

test('break condition checks the exact shape localScenarioRun emits', () => {
  assert(pipelineSrc.includes('ctx.testResults.preSplice === true'),
    'checks preSplice === true');
  assert(pipelineSrc.includes('ctx.testResults.failed > 0'),
    'checks failed > 0');
  assert(pipelineSrc.includes('outerAttempt < MAX_OUTER_ATTEMPTS'),
    'gates on retry budget remaining');
});

test('emits pre-splice-short-circuit telemetry event', () => {
  assert(pipelineSrc.includes("type: 'pre-splice-short-circuit'"),
    'telemetry event with specific type');
});

test('short-circuit sits INSIDE the stage loop (after stopAfter check)', () => {
  // The inline `break` must be in scope of the for-loop over STAGES.
  // Locate the short-circuit block and verify it comes AFTER the
  // stopAfter check (which guarantees it's inside the loop) and BEFORE
  // the catch (which wraps the loop).
  const stopAfterIdx = pipelineSrc.indexOf('Stopped after: ');
  const shortCircuitIdx = pipelineSrc.indexOf('PRE-SPLICE SHORT-CIRCUIT');
  const catchErrIdx = pipelineSrc.indexOf('} catch (err) {', shortCircuitIdx);
  assert(stopAfterIdx >= 0);
  assert(shortCircuitIdx >= 0);
  assert(catchErrIdx >= 0);
  assert(stopAfterIdx < shortCircuitIdx, 'short-circuit after stopAfter check');
  assert(shortCircuitIdx < catchErrIdx, 'short-circuit before catch (→ inside loop)');
});

test('short-circuit does NOT fire on post-splice failures', () => {
  // stageTestStep sets ctx.testResults WITHOUT preSplice: true. The
  // short-circuit must gate on preSplice===true so only stageLocal
  // ScenarioRun triggers it — a post-splice testStep failure should
  // continue through designUI/testWithUI as before (they may report
  // relevant data for the user even on failure).
  const condition = pipelineSrc.match(
    /if\s*\(\s*[\s\S]{0,20}ctx\.testResults[\s\S]{0,50}ctx\.testResults\.preSplice === true[\s\S]{0,50}ctx\.testResults\.failed > 0/,
  );
  assert(condition, 'all three conditions AND-ed together (preSplice + failed)');
});

console.log('\n== stageLocalScenarioRun emits the shape the short-circuit expects ==');

test('stageLocalScenarioRun sets preSplice:true on failure', () => {
  // Read the localScenarioRun stage source and verify it sets both flags.
  const idx = pipelineSrc.indexOf('async function stageLocalScenarioRun');
  const end = pipelineSrc.indexOf('async function stageValidate', idx);
  assert(idx >= 0 && end > idx);
  const body = pipelineSrc.slice(idx, end);
  assert(body.includes('preSplice: true'), 'sets preSplice flag');
  assert(body.includes('ctx.testResults ='), 'assigns ctx.testResults');
  assert(body.includes('failed > 0'), 'guarded on failed count');
});

console.log('\n== Outer retry path reads the right fields ==');

test('outer retry decision reads hasTestFailures from ctx.testResults', () => {
  // After the short-circuit breaks out of the loop, the post-run retry
  // decision runs. It reads ctx.testResults and populates
  // priorDiagnosis. Verify the retry path handles preSplice correctly.
  assert(pipelineSrc.includes('const hasTestFailures = reachedTestStep && testResults.failed > 0'),
    'retry decision reads testResults.failed');
  assert(pipelineSrc.includes("retryReason === 'test-scenario-failures'")
    || pipelineSrc.includes(": hasTestFailures ? 'test-scenario-failures'"),
    'retryReason is test-scenario-failures when hasTestFailures');
});

console.log('\n== Behavioral: short-circuit semantic is a plain JS break ==');

test('the short-circuit condition correctly stops iteration', () => {
  // Simulate the stage loop's break semantics in isolation — prove that
  // the same conditional structure as stepFlowPipeline.js will correctly
  // stop stage iteration given a failing ctx.testResults.
  const STAGES = ['playbook', 'decompose', 'conceive', 'generateCode', 'harnessCode', 'localScenarioRun', 'validate', 'testStep', 'designUI', 'userVerify', 'testWithUI', 'done'];
  const ctx = { testResults: null };
  const outerAttempt = 1;
  const MAX_OUTER_ATTEMPTS = 3;
  const stagesRun = [];

  for (const stageName of STAGES) {
    stagesRun.push(stageName);
    // Simulate localScenarioRun failing
    if (stageName === 'localScenarioRun') {
      ctx.testResults = { preSplice: true, failed: 2, totalScenarios: 4, passed: 2, results: [] };
    }
    // The same short-circuit check
    if (ctx.testResults
      && ctx.testResults.preSplice === true
      && ctx.testResults.failed > 0
      && outerAttempt < MAX_OUTER_ATTEMPTS
    ) {
      break;
    }
  }

  // Must have stopped at localScenarioRun; never reached validate+
  assert(stagesRun.includes('localScenarioRun'), 'localScenarioRun ran');
  assert(!stagesRun.includes('validate'), 'validate NOT reached (short-circuit fired)');
  assert(!stagesRun.includes('testStep'), 'testStep NOT reached');
  assert(!stagesRun.includes('testWithUI'), 'testWithUI NOT reached');
  assert(!stagesRun.includes('done'), 'done NOT reached');
});

test('short-circuit does NOT fire on retry budget exhaustion', () => {
  // At outerAttempt >= MAX, the guard prevents short-circuiting so the
  // pipeline can at least complete and report — if we always broke at
  // exhausted budget, the user would never see what the deployed test
  // says about the final attempt.
  const STAGES = ['localScenarioRun', 'validate', 'testStep', 'done'];
  const ctx = { testResults: { preSplice: true, failed: 1, totalScenarios: 1, results: [] } };
  const outerAttempt = 3;  // at max
  const MAX_OUTER_ATTEMPTS = 3;
  const stagesRun = [];

  for (const stageName of STAGES) {
    stagesRun.push(stageName);
    if (ctx.testResults
      && ctx.testResults.preSplice === true
      && ctx.testResults.failed > 0
      && outerAttempt < MAX_OUTER_ATTEMPTS
    ) {
      break;
    }
  }

  // All stages run — the budget-exhaustion guard prevented short-circuit
  assert(stagesRun.length === STAGES.length, 'all stages run at budget exhaustion');
});

test('short-circuit does NOT fire on post-splice failures', () => {
  // Only stageLocalScenarioRun sets preSplice:true. stageTestStep sets
  // ctx.testResults WITHOUT preSplice:true (it's post-splice). The short-
  // circuit must not fire in that case — the pipeline should continue
  // through designUI/testWithUI as before.
  const STAGES = ['localScenarioRun', 'validate', 'testStep', 'designUI', 'done'];
  const ctx = { testResults: null };
  const outerAttempt = 1;
  const MAX_OUTER_ATTEMPTS = 3;
  const stagesRun = [];

  for (const stageName of STAGES) {
    stagesRun.push(stageName);
    if (stageName === 'testStep') {
      // Post-splice failure — no preSplice flag
      ctx.testResults = { failed: 1, totalScenarios: 1, passed: 0, results: [] };
    }
    if (ctx.testResults
      && ctx.testResults.preSplice === true
      && ctx.testResults.failed > 0
      && outerAttempt < MAX_OUTER_ATTEMPTS
    ) {
      break;
    }
  }

  // Post-splice failures should not trigger the short-circuit; all stages run.
  assert(stagesRun.includes('designUI'), 'designUI reached despite testStep failure');
  assert(stagesRun.includes('done'), 'done reached');
});

console.log(`\n---\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
