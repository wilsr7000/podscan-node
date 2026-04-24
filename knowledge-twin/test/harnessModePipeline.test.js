// test/harnessModePipeline.test.js — integration test for Phase 4 harness
// mode wiring in the pipeline.
//
// Exercises the full path from "playbook markdown with test-harness-meta
// header" to "ctx.harnessedTemplate ready for stageValidate" WITHOUT
// hitting any Edison flow. Each stage fn is called in sequence with the
// ctx object threaded through, and we assert the short-circuits fire
// correctly + produce a spliceable template with scenarios pre-configured.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const pipeline = require('../lib/stepFlowPipeline');
const { generateTestPlaybook } = require('../lib/testPlaybookGenerator');
const { buildOpenApi } = require('../lib/flowOpenApiExtractor');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Fixture: build a test-harness playbook in a tmp file so stagePlaybook
// can read it.
function writeFixturePlaybook() {
  // Build a minimal OpenAPI for a rewrite-style flow, then run the Phase 3
  // generator in deterministic mode to produce a harness playbook.
  const openApi = buildOpenApi({
    template: {
      label: 'Fix Me',
      name: 'fix_me',
      description: 'Rewrite text and return a diff.',
      formBuilder: {
        stepInputs: [
          { component: 'formTextBox', data: { variable: 'sourceText', validateRequired: true } },
          { component: 'formTextInput', data: { variable: 'findIntent', validateRequired: true } },
          { component: 'formTextInput', data: { variable: 'replaceIntent', validateRequired: true } },
        ],
      },
      data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }] },
      outputExample: { rewrittenText: 'x', diff: [{ before: 'a', after: 'b' }] },
    },
    gatewayPath: '/fix-me',
    flowId: 'flow-fixme',
  });
  return generateTestPlaybook({
    sourcePlaybook: '',
    openApi,
    target: {
      flowId: 'flow-fixme',
      flowUrl: 'http://127.0.0.1:9999/fix-me',
      label: 'Fix Me',
      name: 'fix_me',
    },
    opts: { llmMode: 'off' },
  });
}

(async () => {
  console.log('\n== stagePlaybook tags ctx.harnessMode on harness playbooks ==');

  await test('harness-playbook markdown → ctx.harnessMode=true', async () => {
    const gen = await writeFixturePlaybook();
    const tmp = path.join(os.tmpdir(), 'harness-pipeline-' + Date.now() + '.md');
    fs.writeFileSync(tmp, gen.markdown, 'utf8');
    try {
      const ctx = {
        opts: { playbookPath: tmp },
        log: () => {},
      };
      const s = await pipeline._stagePlaybook(ctx);
      assertEq(ctx.harnessMode, true, 'harnessMode flag set');
      assert(ctx.harnessMeta, 'harnessMeta populated');
      assertEq(ctx.harnessMeta.testHarnessFor, 'flow-fixme');
      assertEq(ctx.harnessMeta.targetFlowUrl, 'http://127.0.0.1:9999/fix-me');
      assert(Array.isArray(ctx.harnessMeta.scenarios));
      assert(ctx.harnessMeta.scenarios.length > 0, 'scenarios extracted');
      assertEq(s.data.harnessMode, true);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  await test('normal step playbook → ctx.harnessMode !== true', async () => {
    const tmp = path.join(os.tmpdir(), 'harness-pipeline-' + Date.now() + '-normal.md');
    fs.writeFileSync(tmp, '# Normal Step\n\n## Diagnosis\njust a step\n', 'utf8');
    try {
      const ctx = {
        opts: { playbookPath: tmp },
        log: () => {},
      };
      await pipeline._stagePlaybook(ctx);
      assert(!ctx.harnessMode, 'harnessMode not set');
      assert(!ctx.harnessMeta, 'harnessMeta not set');
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  console.log('\n== stageGenerateCode short-circuits in harness mode ==');

  await test('stageGenerateCode returns skipped result in harness mode', async () => {
    const ctx = {
      harnessMode: true,
      harnessMeta: { scenarios: [], testHarnessFor: 'x', targetFlowUrl: 'http://x' },
      log: () => {},
    };
    const s = await pipeline._stageGenerateCode(ctx);
    assertEq(s.data.skipped, true);
    assertEq(s.data.reason, 'harness-mode');
    // Must populate generatedCode / codeGenResult so downstream fallback chain works
    assertEq(ctx.generatedCode, '');
    assert(ctx.codeGenResult);
    assertEq(ctx.codeGenResult.source, 'harness-template');
  });

  console.log('\n== stageHarnessCode builds a real template from library files ==');

  await test('stageHarnessCode populates ctx.harnessedTemplate with baked-in scenarios', async () => {
    const scenarios = [
      { name: 'x', input: { a: 1 }, expect: { code: 'Y' } },
      { name: 'happy', input: {}, expect: { codeOneOfOrSuccess: [] } },
    ];
    const ctx = {
      harnessMode: true,
      harnessMeta: {
        testHarnessFor: 'flow-target-xyz',
        targetFlowUrl: 'https://em.edison.api.onereach.ai/http/acct/target',
        targetLabel: 'Target Flow',
        targetName: 'target',
        harnessTemplateLabel: 'Test Harness (Flow Tester)',
        scenarios,
      },
      log: () => {},
    };
    const s = await pipeline._stageHarnessCode(ctx);
    assertEq(s.data.harnessMode, true);
    assertEq(s.data.scenarioCount, scenarios.length);
    assert(ctx.harnessedTemplate, 'harnessedTemplate set');
    assertEq(ctx.harnessedTemplate.kind, 'logic');
    assertEq(ctx.harnessedTemplate.label, 'Target Flow Test Harness');

    // The stepInputs must include targetFlowUrl + scenarios with the
    // correct defaults baked into defaultValue fields.
    const inputs = ctx.harnessedTemplate.formBuilder.stepInputs;
    const target = inputs.find((i) => i.data.variable === 'targetFlowUrl');
    const scens = inputs.find((i) => i.data.variable === 'scenarios');
    assert(target, 'targetFlowUrl input present');
    assert(scens, 'scenarios input present');
    assert(target.data.defaultValue.includes('https://em.edison.api.onereach.ai/http/acct/target'));
    assert(scens.data.defaultValue.includes('"name":"x"'), 'scenarios JSON embedded in default');
    assert(scens.data.defaultValue.includes('"name":"happy"'));

    // The step code is the real Phase 1 harness logic (not empty, not a stub)
    assert(ctx.harnessedTemplate.template.includes('class TestHarness'));
    assert(ctx.harnessedTemplate.template.includes('runStep'));

    // Provenance block
    assert(ctx.harnessedTemplate._harnessMode);
    assertEq(ctx.harnessedTemplate._harnessMode.targetFlowId, 'flow-target-xyz');
    assertEq(ctx.harnessedTemplate._harnessMode.scenarioCount, 2);
  });

  console.log('\n== stageLocalScenarioRun skipped in harness mode ==');

  await test('stageLocalScenarioRun returns skipped result in harness mode', async () => {
    const ctx = {
      harnessMode: true,
      harnessedTemplate: { template: 'stub', label: 'x' },
      log: () => {},
    };
    const s = await pipeline._stageLocalScenarioRun(ctx);
    assertEq(s.data.skipped, true);
    assertEq(s.data.reason, 'harness-mode');
    assertEq(s.data.harnessMode, true);
    // Must NOT set ctx.testResults (no harness self-test)
    assert(!ctx.testResults);
  });

  console.log('\n== End-to-end: stages threaded together ==');

  await test('playbook → generateCode → harnessCode → localScenarioRun in harness mode', async () => {
    const gen = await writeFixturePlaybook();
    const tmp = path.join(os.tmpdir(), 'e2e-harness-' + Date.now() + '.md');
    fs.writeFileSync(tmp, gen.markdown, 'utf8');
    try {
      const ctx = {
        opts: { playbookPath: tmp },
        log: () => {},
      };
      await pipeline._stagePlaybook(ctx);
      assertEq(ctx.harnessMode, true);

      await pipeline._stageGenerateCode(ctx);
      // generatedCode is empty in harness mode; codeGenResult signals skip
      assertEq(ctx.generatedCode, '');

      await pipeline._stageHarnessCode(ctx);
      assert(ctx.harnessedTemplate, 'harnessed template built');
      const inputs = ctx.harnessedTemplate.formBuilder.stepInputs;
      const scens = inputs.find((i) => i.data.variable === 'scenarios');
      assert(scens.data.defaultValue.includes('"name"'), 'scenarios baked in');

      await pipeline._stageLocalScenarioRun(ctx);
      assert(!ctx.testResults, 'local-scenarios skip left testResults untouched');
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
