// test/testPlaybookGenerator.test.js — tests for Phase 3 playbook generator.
//
// Coverage:
//   - Deterministic mode (no API key / llmMode='off'): produces a usable
//     baseline playbook with structural + behavioral scenarios
//   - LLM mode (stubbed): merges LLM scenarios on top of deterministic,
//     dedups by name, respects maxScenarios budget
//   - Failure modes: LLM error / malformed response → degrades to
//     deterministic baseline, never throws
//   - Markdown shape: playbook parses back via the pipeline's own
//     parseScenariosFromPlaybook (round-trip integrity)
//   - Real-world: runs against the F&R source playbook + its extracted
//     OpenAPI; verifies behavioral scenarios are proposed for a transform step

'use strict';

const fs = require('fs');
const path = require('path');

// Stub the llmClient BEFORE loading the generator so the lazy require
// picks up our mock. Matches the pattern used by test/llmScenarios.test.js.
const llmClientPath = path.resolve(__dirname, '..', 'lib', 'llmClient.js');
let fakeResponse = null;
let fakeError = null;
let callCount = 0;
require.cache[llmClientPath] = {
  id: llmClientPath,
  filename: llmClientPath,
  loaded: true,
  exports: {
    callAnthropicDirect: async () => {
      callCount++;
      if (fakeError) return { error: fakeError };
      return { raw: fakeResponse };
    },
    hasApiKey: (k) => Boolean(k),
    getApiKey: () => 'test-key',
  },
};

const {
  generateTestPlaybook,
  buildDeterministicScenarios,
  buildPlaybookMarkdown,
  extractRelevantPlaybookSections,
  parseScenarioJson,
} = require('../lib/testPlaybookGenerator');
const { parseScenariosFromPlaybook } = require('../lib/stepScenarios');
const { buildOpenApi } = require('../lib/flowOpenApiExtractor');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ------ Fixture OpenAPI docs ------

function rewriteOpenApi() {
  return buildOpenApi({
    template: {
      label: 'Find & Replace Agent',
      name: 'find_replace',
      description: 'Rewrites source text by replacing concepts or patterns with replacement content, returning a diff.',
      formBuilder: {
        stepInputs: [
          { component: 'formTextBox', data: { variable: 'sourceText', validateRequired: true, helpText: 'text to transform' } },
          { component: 'formTextInput', data: { variable: 'findIntent', validateRequired: true } },
          { component: 'formTextInput', data: { variable: 'replaceIntent', validateRequired: true } },
          { component: 'formSelect', data: { variable: 'mode', options: [{ value: 'concept' }, { value: 'regex' }] } },
        ],
      },
      data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }] },
      outputExample: { rewrittenText: 'new', diff: [{ before: 'old', after: 'new' }], summary: 'ok' },
    },
    gatewayPath: '/fr',
    flowId: 'fr-1',
  });
}

function simpleOpenApi() {
  return buildOpenApi({
    template: {
      label: 'Echo',
      name: 'echo',
      description: 'Echoes the payload back.',
      formBuilder: {
        stepInputs: [
          { component: 'formTextInput', data: { variable: 'payload', validateRequired: true } },
        ],
      },
      data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }] },
      outputExample: { echo: 'x' },
    },
    gatewayPath: '/echo',
  });
}

(async () => {
  console.log('\n== Deterministic baseline ==');

  await test('rewrite-style flow gets behavioral assertions', () => {
    const scs = buildDeterministicScenarios(rewriteOpenApi());
    // Should include at least one rewrittenDiffers + one diffNonEmpty
    assert(scs.some((s) => s.expect.rewrittenDiffers === true), 'rewrittenDiffers scenario present');
    assert(scs.some((s) => s.expect.diffNonEmpty === true), 'diffNonEmpty scenario present');
  });

  await test('required-field scenarios generated per required field', () => {
    const scs = buildDeterministicScenarios(rewriteOpenApi());
    const missScenarios = scs.filter((s) => s.name.startsWith('missing required'));
    assert(missScenarios.length >= 3, 'at least 3 required-field scenarios, got ' + missScenarios.length);
  });

  await test('enum field generates alt-value scenario', () => {
    const scs = buildDeterministicScenarios(rewriteOpenApi());
    const enumScen = scs.find((s) => s.name.includes('enum "mode" alternate value'));
    assert(enumScen, 'enum alt-value scenario present');
    // The second option is 'regex' — make sure alt uses it (not 'concept', which is the first)
    assertEq(enumScen.input.mode, 'regex');
  });

  await test('happy path uses populated inputs', () => {
    const scs = buildDeterministicScenarios(rewriteOpenApi());
    const hp = scs.find((s) => s.name.startsWith('happy path'));
    assert(hp, 'happy path present');
    assert(hp.input.sourceText, 'sourceText populated');
    assert(hp.input.findIntent, 'findIntent populated');
  });

  await test('non-transform step gets no behavioral assertions', () => {
    const scs = buildDeterministicScenarios(simpleOpenApi());
    assert(!scs.some((s) => s.expect.rewrittenDiffers === true), 'no rewrittenDiffers');
    assert(!scs.some((s) => s.expect.diffNonEmpty === true), 'no diffNonEmpty');
  });

  await test('maxScenarios cap is respected', () => {
    // Force maxScenarios=2, expect only 2 scenarios emitted
    const scs = buildDeterministicScenarios(rewriteOpenApi(), { maxScenarios: 2 });
    assertEq(scs.length, 2);
  });

  console.log('\n== LLM augmentation (stubbed) ==');

  await test('merges LLM scenarios on top of deterministic, dedup by name', async () => {
    fakeResponse = JSON.stringify([
      { name: 'LLM: mode=concept with obvious country music reference → rap replacement in output', input: { sourceText: 'I love country music', findIntent: 'country music', replaceIntent: 'rap music', mode: 'concept' }, expect: { rewrittenDiffers: true, includes: ['rap'] } },
      { name: 'LLM: empty sourceText → input validation error', input: { sourceText: '', findIntent: 'x', replaceIntent: 'y' }, expect: { codeOneOf: ['INVALID_INPUT', 'MISSING_INPUT'] } },
    ]);
    fakeError = null;
    const r = await generateTestPlaybook({
      sourcePlaybook: 'source',
      openApi: rewriteOpenApi(),
      target: { flowId: 'f', flowUrl: 'u', label: 'F&R', name: 'f_r' },
      opts: { apiKey: 'x' },
    });
    assert(r.deterministicCount > 0, 'deterministic produced');
    assert(r.llmCount > 0, 'llm produced');
    assert(r.scenarios.some((s) => s._source === 'llm-behavioral'), 'llm-tagged scenario present');
    assert(r.scenarios.some((s) => s.name.startsWith('missing required')), 'deterministic scenario still present');
  });

  await test('LLM failure → silently falls back to deterministic, no throw', async () => {
    fakeError = 'Anthropic API 500';
    fakeResponse = null;
    const r = await generateTestPlaybook({
      sourcePlaybook: 'source',
      openApi: rewriteOpenApi(),
      target: { flowId: 'f', flowUrl: 'u', label: 'F&R' },
      opts: { apiKey: 'x' },
    });
    fakeError = null;
    assertEq(r.llmCount, 0);
    assert(r.deterministicCount > 0);
    assert(r.markdown.includes('## Test Scenarios'));
  });

  await test('malformed LLM response → drops it, deterministic baseline survives', async () => {
    fakeResponse = 'not JSON at all';
    fakeError = null;
    const r = await generateTestPlaybook({
      sourcePlaybook: 'source',
      openApi: rewriteOpenApi(),
      target: { flowId: 'f', flowUrl: 'u', label: 'F&R' },
      opts: { apiKey: 'x' },
    });
    assertEq(r.llmCount, 0);
    assert(r.deterministicCount > 0);
  });

  await test('llmMode=off skips the LLM entirely (no API call)', async () => {
    const callsBefore = callCount;
    const r = await generateTestPlaybook({
      sourcePlaybook: 'source',
      openApi: rewriteOpenApi(),
      target: { flowId: 'f', flowUrl: 'u', label: 'F&R' },
      opts: { apiKey: 'x', llmMode: 'off' },
    });
    assertEq(callCount, callsBefore, 'no API call made');
    assertEq(r.llmCount, 0);
  });

  console.log('\n== Markdown round-trip ==');

  await test('generated markdown parses back via parseScenariosFromPlaybook', async () => {
    fakeResponse = null; fakeError = null;
    const r = await generateTestPlaybook({
      sourcePlaybook: '',
      openApi: rewriteOpenApi(),
      target: { flowId: 'f', flowUrl: 'u', label: 'F&R', name: 'f_r' },
      opts: { llmMode: 'off' },
    });
    const parsed = parseScenariosFromPlaybook(r.markdown);
    assert(Array.isArray(parsed), 'parses back as array');
    assertEq(parsed.length, r.scenarios.length, 'round-trips all scenarios');
    assertEq(parsed[0].name, r.scenarios[0].name);
  });

  await test('markdown includes test-harness-meta HTML comment (for Phase 4 detection)', async () => {
    const r = await generateTestPlaybook({
      sourcePlaybook: '',
      openApi: rewriteOpenApi(),
      target: { flowId: 'flow-xyz', flowUrl: 'https://example.com/fr', label: 'F&R', name: 'f_r' },
      opts: { llmMode: 'off' },
    });
    assert(r.markdown.includes('<!-- test-harness-meta'), 'has meta comment');
    assert(r.markdown.includes('testHarnessFor: flow-xyz'), 'has target flow id');
    assert(r.markdown.includes('harnessTemplateLabel: Test Harness (Flow Tester)'), 'names the template');
  });

  console.log('\n== Real-world: F&R source playbook + extracted OpenAPI ==');

  await test('generates behavioral scenarios for the real F&R deployed flow', async () => {
    const sourcePlaybook = fs.readFileSync(
      '/Users/richardwilson/podscan/knowledge-twin/.pipeline-jobs/2026-04-23T16-52-50-43f9m1/playbook-original.md',
      'utf8',
    );
    const deployedTemplate = JSON.parse(fs.readFileSync(
      '/Users/richardwilson/podscan/knowledge-twin/.pipeline-jobs/2026-04-23T16-52-50-43f9m1/template-deployed.json',
      'utf8',
    ));
    const openApi = buildOpenApi({
      template: deployedTemplate,
      gatewayPath: '/gsx',
      flowId: 'f751cbe6-1d61-4928-9d6f-8d02ef3c34e6',
    });
    fakeResponse = null; fakeError = null;  // deterministic-only for this test
    const r = await generateTestPlaybook({
      sourcePlaybook,
      openApi,
      target: {
        flowId: 'f751cbe6-1d61-4928-9d6f-8d02ef3c34e6',
        flowUrl: 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/gsx',
        label: 'Find & Replace Agent',
        name: 'gsx',
      },
      opts: { llmMode: 'off' },
    });
    // Must include behavioral assertions since the real template has
    // "transform / replace / diff / summar" cues
    const hasRewriteCheck = r.scenarios.some((s) => s.expect.rewrittenDiffers === true);
    const hasDiffCheck = r.scenarios.some((s) => s.expect.diffNonEmpty === true);
    assert(hasRewriteCheck, 'has rewrittenDiffers assertion for transform step');
    assert(hasDiffCheck, 'has diffNonEmpty assertion for transform step');
    assert(r.scenarios.length >= 4, `at least 4 scenarios generated, got ${r.scenarios.length}`);
    // Markdown must include metadata for Phase 4
    assert(r.markdown.includes('testHarnessFor: f751cbe6-1d61-4928-9d6f-8d02ef3c34e6'));
    // Save the real artifact as an inspection target
    fs.writeFileSync('/tmp/fr-test-playbook.md', r.markdown);
  });

  console.log('\n== extractRelevantPlaybookSections ==');

  await test('extracts How to Win / Coherent Actions / Pre-Mortem sections', () => {
    const md = [
      '# some title',
      '## Document',
      'ignored section',
      '## How to Win',
      'guiding policy',
      '## Coherent Actions',
      'moves',
      '## Something Else',
      'ignored too',
      '## Pre-Mortem',
      'risks',
    ].join('\n\n');
    const out = extractRelevantPlaybookSections(md);
    assert(out.includes('guiding policy'), 'has How to Win');
    assert(out.includes('moves'), 'has Coherent Actions');
    assert(out.includes('risks'), 'has Pre-Mortem');
    assert(!out.includes('ignored section'), 'skips Document');
  });

  console.log('\n== parseScenarioJson (robustness) ==');

  await test('parses fenced JSON', () => {
    const p = parseScenarioJson('```json\n[{"name":"x","input":{},"expect":{}}]\n```');
    assert(Array.isArray(p) && p.length === 1);
  });

  await test('parses JSON with leading prose', () => {
    const p = parseScenarioJson('Here you go: [{"name":"x","input":{},"expect":{}}] hope that helps');
    assert(Array.isArray(p) && p.length === 1);
  });

  await test('returns null for unparseable garbage', () => {
    assertEq(parseScenarioJson('this is garbage'), null);
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
