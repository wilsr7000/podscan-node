// test/llmScenarios.test.js
// Tests for deriveScenariosWithLLM + deriveScenariosAugmented (fix D).
//
// Uses a stub llmClient (via require.cache injection) to avoid making real
// API calls in unit tests. The stub returns a known JSON array so we can
// verify parsing, shape validation, and merge behavior.

'use strict';

const path = require('path');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Install a fake llmClient in the require cache BEFORE stepScenarios loads it.
// stepScenarios uses lazy require('./llmClient') inside deriveScenariosWithLLM,
// so we just need the cache entry to exist at call-time.
const llmClientPath = path.resolve(__dirname, '..', 'lib', 'llmClient.js');
let fakeResponse = null;
let fakeError = null;
let callCount = 0;
require.cache[llmClientPath] = {
  id: llmClientPath,
  filename: llmClientPath,
  loaded: true,
  exports: {
    callAnthropicDirect: async (_key, _system, _user, _opts) => {
      callCount++;
      if (fakeError) return { error: fakeError };
      return { raw: fakeResponse };
    },
    hasApiKey: (k) => Boolean(k),
    getApiKey: () => 'test-key',
  },
};

const { deriveScenariosWithLLM, deriveScenariosAugmented, deriveScenariosFromSpec } = require('../lib/stepScenarios');

const SAMPLE_SPEC = {
  name: 'weather_step',
  label: 'Weather',
  description: 'Get weather for a location',
  inputs: [
    { variable: 'location', type: 'text', required: true, example: 'London' },
    { variable: 'units', type: 'select', required: false, default: 'celsius', options: ['celsius', 'fahrenheit'] },
    { variable: 'threshold', type: 'number', required: false, default: 0.5 },
  ],
  exits: [{ id: 'next', label: 'Next' }, { id: '__error__', label: 'Error' }],
};

(async () => {
  console.log('\n== deriveScenariosWithLLM — parsing ==');

  await test('parses bare JSON array response', async () => {
    fakeResponse = JSON.stringify([
      { name: 'empty location string', input: { location: '' }, expect: { codeOneOf: ['MISSING_INPUT', 'INVALID_INPUT'] } },
      { name: 'negative threshold', input: { location: 'x', threshold: -1 }, expect: { codeOneOfOrSuccess: ['INVALID_INPUT'] } },
    ]);
    fakeError = null;
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 2);
    assertEq(out[0].name, 'empty location string');
    assertEq(out[0]._source, 'llm-edge-case');
  });

  await test('parses response inside ```json fence', async () => {
    fakeResponse = '```json\n[{"name":"test","input":{},"expect":{}}]\n```';
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 1);
    assertEq(out[0].name, 'test');
  });

  await test('parses response with leading prose (extracts balanced brackets)', async () => {
    fakeResponse = 'Here are the scenarios:\n[{"name":"x","input":{},"expect":{}}]\nhope this helps!';
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 1);
    assertEq(out[0].name, 'x');
  });

  await test('drops scenarios missing required fields', async () => {
    fakeResponse = JSON.stringify([
      { name: 'valid', input: {}, expect: {} },
      { input: {} },  // missing name
      { name: 'bad input', input: 'not-an-object' },  // wrong type
      'not-an-object',  // entirely wrong
    ]);
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 1);
    assertEq(out[0].name, 'valid');
  });

  await test('respects maxScenarios cap', async () => {
    fakeResponse = JSON.stringify(Array.from({ length: 10 }, (_, i) => ({
      name: `scenario ${i}`, input: {}, expect: {},
    })));
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x', maxScenarios: 3 });
    assertEq(out.length, 3);
  });

  console.log('\n== deriveScenariosWithLLM — graceful degradation ==');

  await test('returns [] when API errors', async () => {
    fakeError = 'Anthropic API 500';
    fakeResponse = null;
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    fakeError = null;
    assertEq(out.length, 0);
  });

  await test('returns [] when response is not parseable JSON', async () => {
    fakeResponse = 'this is definitely not JSON';
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 0);
  });

  await test('returns [] when response is a JSON object (not array)', async () => {
    fakeResponse = '{"scenarios": [{"name":"x"}]}';
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: 'x' });
    assertEq(out.length, 0);
  });

  await test('returns [] with empty spec', async () => {
    const out = await deriveScenariosWithLLM({ spec: { inputs: [] }, apiKey: 'x' });
    assertEq(out.length, 0);
  });

  await test('returns [] without API key', async () => {
    // override hasApiKey to return false
    const saved = require.cache[llmClientPath].exports.hasApiKey;
    require.cache[llmClientPath].exports.hasApiKey = () => false;
    const out = await deriveScenariosWithLLM({ spec: SAMPLE_SPEC, apiKey: null });
    require.cache[llmClientPath].exports.hasApiKey = saved;
    assertEq(out.length, 0);
  });

  console.log('\n== deriveScenariosAugmented — merge behavior ==');

  await test('deterministic + LLM scenarios both included, deterministic FIRST', async () => {
    fakeResponse = JSON.stringify([
      { name: 'llm edge 1', input: {}, expect: {} },
      { name: 'llm edge 2', input: {}, expect: {} },
    ]);
    fakeError = null;
    const out = await deriveScenariosAugmented(SAMPLE_SPEC, { apiKey: 'x', useLLM: true });
    const deterministic = deriveScenariosFromSpec(SAMPLE_SPEC);
    assert(out.length > deterministic.length, 'augmented > deterministic');
    // First N should be the deterministic scenarios
    for (let i = 0; i < deterministic.length; i++) {
      assertEq(out[i].name, deterministic[i].name, `pos ${i}`);
    }
    // Remaining should be LLM-sourced
    const llmTail = out.slice(deterministic.length);
    assert(llmTail.every((s) => s._source === 'llm-edge-case'), 'tail are LLM-sourced');
  });

  await test('useLLM=false returns just deterministic (no API call made)', async () => {
    const before = callCount;
    const out = await deriveScenariosAugmented(SAMPLE_SPEC, { apiKey: 'x', useLLM: false });
    const deterministic = deriveScenariosFromSpec(SAMPLE_SPEC);
    assertEq(out.length, deterministic.length);
    assertEq(callCount, before, 'no LLM call made');
  });

  await test('LLM failure returns deterministic set (cleanly degraded)', async () => {
    fakeError = 'boom';
    fakeResponse = null;
    const out = await deriveScenariosAugmented(SAMPLE_SPEC, { apiKey: 'x', useLLM: true });
    fakeError = null;
    const deterministic = deriveScenariosFromSpec(SAMPLE_SPEC);
    assertEq(out.length, deterministic.length, 'fallback to deterministic');
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
