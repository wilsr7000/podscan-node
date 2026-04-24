// test/flowOpenApiExtractor.test.js — tests for Phase 2 OpenAPI extraction.
//
// Coverage:
//   - inputsToSchema: component type mapping, required array, defaults,
//     enums, auth inputs excluded from body
//   - inferSchemaFromValue: recursive object inference, array item inference,
//     primitive detection, depth cap
//   - exitsToResponseVariants: per-exit shapes, error/timeout tagging,
//     success uses outputExample
//   - buildOpenApi: full document shape, path, servers, security, components,
//     x-edison extension
//   - Real-world: runs against the deployed F&R template from the last
//     pipeline job to verify it handles messy real input without throwing

'use strict';

const fs = require('fs');
const path = require('path');
const {
  buildOpenApi,
  inputsToSchema,
  inferSchemaFromValue,
  exitsToResponseVariants,
  buildScenarioHints,
} = require('../lib/flowOpenApiExtractor');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function assertDeep(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: deep-mismatch\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(b)}`); }

(async () => {
  console.log('\n== inputsToSchema ==');

  await test('required inputs land in required array', () => {
    const stepInputs = [
      { component: 'formTextInput', data: { variable: 'name', validateRequired: true, helpText: 'who' } },
      { component: 'formTextInput', data: { variable: 'opt', validateRequired: false } },
    ];
    const { schema } = inputsToSchema(stepInputs);
    assertDeep(schema.required, ['name'], 'required');
    assertEq(schema.properties.name.type, 'string');
  });

  await test('auth inputs are NOT in body schema; listed in authVars', () => {
    const { schema, authVars } = inputsToSchema([
      { component: 'auth-external-component', data: { variable: 'auth' } },
      { component: 'formTextInput', data: { variable: 'query', validateRequired: true } },
    ]);
    assert(!('auth' in (schema.properties || {})), 'auth not in body');
    assert('query' in schema.properties, 'query in body');
    assertDeep(authVars, ['auth'], 'authVars');
  });

  await test('enum options are applied from data.options', () => {
    const { schema } = inputsToSchema([
      { component: 'formSelect', data: { variable: 'mode', options: [{ value: 'concept' }, { value: 'regex' }] } },
    ]);
    assertDeep(schema.properties.mode.enum, ['concept', 'regex']);
  });

  await test('numeric default is coerced to number', () => {
    const { schema } = inputsToSchema([
      { component: 'formNumber', data: { variable: 'limit', defaultValue: '`42`' } },
    ]);
    assertEq(schema.properties.limit.type, 'number');
    assertEq(schema.properties.limit.default, 42);
  });

  await test('boolean default is coerced from string', () => {
    const { schema } = inputsToSchema([
      { component: 'formSwitch', data: { variable: 'active', defaultValue: 'true' } },
    ]);
    assertEq(schema.properties.active.type, 'boolean');
    assertEq(schema.properties.active.default, true);
  });

  await test('backtick-wrapped default string is unwrapped', () => {
    const { schema } = inputsToSchema([
      { component: 'formTextInput', data: { variable: 'mode', defaultValue: '`concept`' } },
    ]);
    assertEq(schema.properties.mode.default, 'concept');
  });

  await test('empty backtick-wrapped default is dropped', () => {
    const { schema } = inputsToSchema([
      { component: 'formTextInput', data: { variable: 'x', defaultValue: '``' } },
    ]);
    assert(!('default' in schema.properties.x), 'no default on empty ``');
  });

  await test('formJson produces oneOf object/array schema', () => {
    const { schema } = inputsToSchema([
      { component: 'formJson', data: { variable: 'cfg' } },
    ]);
    assert(Array.isArray(schema.properties.cfg.oneOf));
    assertEq(schema.properties.cfg.oneOf[0].type, 'object');
    assertEq(schema.properties.cfg.oneOf[1].type, 'array');
  });

  console.log('\n== inferSchemaFromValue ==');

  await test('null → type null', () => {
    assertDeep(inferSchemaFromValue(null), { type: 'null' });
  });

  await test('primitives produce type + example', () => {
    assertEq(inferSchemaFromValue('hi').type, 'string');
    assertEq(inferSchemaFromValue(42).type, 'integer');
    assertEq(inferSchemaFromValue(3.14).type, 'number');
    assertEq(inferSchemaFromValue(true).type, 'boolean');
  });

  await test('array infers item schema from first element', () => {
    const s = inferSchemaFromValue([{ a: 1 }, { a: 2 }]);
    assertEq(s.type, 'array');
    assertEq(s.items.type, 'object');
    assertEq(s.items.properties.a.type, 'integer');
  });

  await test('nested object infers recursively', () => {
    const s = inferSchemaFromValue({ outer: { inner: 'x' } });
    assertEq(s.properties.outer.properties.inner.type, 'string');
  });

  await test('depth cap bottoms out at generic object', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } };
    const s = inferSchemaFromValue(deep, { depth: 0, maxDepth: 2 });
    // At depth 2 we stop recursing into properties
    assert(s.type === 'object', 'is object');
  });

  console.log('\n== exitsToResponseVariants ==');

  await test('error and timeout exits produce {code,message} schema', () => {
    const v = exitsToResponseVariants([
      { id: '__error__', condition: 'processError' },
      { id: '__timeout__', condition: 'processTimeout' },
    ], { ok: true });
    assertEq(v.error.tag, 'error');
    assertEq(v.timeout.tag, 'timeout');
    assertDeep(v.error.schema.required, ['code', 'message']);
  });

  await test('success exit uses outputExample as schema source', () => {
    const v = exitsToResponseVariants([{ id: 'next', label: 'Next' }], { rewrittenText: 'hi', diff: [] });
    assertEq(v.next.tag, 'success');
    assertEq(v.next.schema.type, 'object');
    assertEq(v.next.schema.properties.rewrittenText.type, 'string');
  });

  console.log('\n== buildOpenApi ==');

  await test('full doc has standard OpenAPI 3.0 shape', () => {
    const tpl = {
      name: 'weather',
      label: 'Weather',
      description: 'Get weather',
      version: '1.0.0',
      formBuilder: {
        stepInputs: [
          { component: 'formTextInput', data: { variable: 'location', validateRequired: true, helpText: 'city name' } },
        ],
      },
      data: {
        exits: [{ id: 'next', label: 'Next' }, { id: '__error__', condition: 'processError' }],
      },
      outputExample: { temperature: 22, unit: 'C' },
    };
    const doc = buildOpenApi({ template: tpl, gatewayPath: '/weather', accountId: 'acct-x' });
    assertEq(doc.openapi, '3.0.3');
    assertEq(doc.info.title, 'Weather');
    assertEq(doc.info.version, '1.0.0');
    assertEq(doc.servers[0].url, 'https://em.edison.api.onereach.ai/http/acct-x');
    assert('/weather' in doc.paths, 'path exists');
    assert(doc.paths['/weather'].post, 'POST op');
    assert(doc.paths['/weather'].get, 'GET op');
    assertEq(doc.paths['/weather'].get.parameters[0].name, 'jobId');
  });

  await test('auth input produces securitySchemes + security on POST', () => {
    const tpl = {
      label: 'Auth Flow',
      formBuilder: {
        stepInputs: [
          { component: 'auth-external-component', data: { variable: 'auth' } },
          { component: 'formTextInput', data: { variable: 'q', validateRequired: true } },
        ],
      },
      data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }] },
    };
    const doc = buildOpenApi({ template: tpl, gatewayPath: 'auth' });
    assert(doc.components.securitySchemes?.ApiAuth, 'securitySchemes.ApiAuth');
    const postOp = doc.paths['/auth'].post;
    assert(Array.isArray(postOp.security), 'POST.security array');
    assertEq(postOp.security[0].ApiAuth.length, 0);  // scopes array empty for apiKey
  });

  await test('x-edison extension carries metadata for downstream consumers', () => {
    const tpl = {
      label: 'X',
      formBuilder: {
        stepInputs: [
          { component: 'formTextInput', data: { variable: 'q', validateRequired: true } },
          { component: 'formSelect', data: { variable: 'mode', options: [{ value: 'a' }, { value: 'b' }] } },
        ],
      },
      data: { exits: [{ id: 'next' }, { id: '__error__', condition: 'processError' }] },
    };
    const doc = buildOpenApi({ template: tpl, gatewayPath: 'x', flowId: 'flow-abc' });
    assertEq(doc['x-edison'].flowId, 'flow-abc');
    assertEq(doc['x-edison'].gatewayPath, '/x');
    assertDeep(doc['x-edison'].harnessScenarioHints.requiredFields, ['q']);
    assertEq(doc['x-edison'].harnessScenarioHints.enumFields[0].name, 'mode');
  });

  await test('behaviorCues picks up transform-style keywords in description', () => {
    const tpl = {
      description: 'A step that REWRITES source text and returns a diff',
      formBuilder: { stepInputs: [] },
      data: { exits: [] },
    };
    const doc = buildOpenApi({ template: tpl, gatewayPath: 'x' });
    const cues = doc['x-edison'].harnessScenarioHints.behaviorCues;
    assert(cues.includes('rewrite'), 'rewrite cue');
    assert(cues.includes('diff'), 'diff cue');
  });

  console.log('\n== Real-world: F&R deployed template ==');

  await test('handles the real deployed F&R template without throwing', () => {
    const fr = JSON.parse(fs.readFileSync(
      '/Users/richardwilson/podscan/knowledge-twin/.pipeline-jobs/2026-04-23T16-52-50-43f9m1/template-deployed.json',
      'utf8',
    ));
    const doc = buildOpenApi({
      template: fr,
      gatewayPath: '/gsx',
      flowId: 'f751cbe6-1d61-4928-9d6f-8d02ef3c34e6',
    });
    assertEq(doc.info.title, fr.label);  // GSX
    assert('/gsx' in doc.paths, 'path /gsx');
    const postOp = doc.paths['/gsx'].post;
    const bodySchema = postOp.requestBody.content['application/json'].schema;
    // The real template has sourceText, findIntent, replaceIntent as required
    assert(bodySchema.properties.sourceText, 'sourceText present');
    assert(bodySchema.properties.findIntent, 'findIntent present');
    assert(bodySchema.properties.replaceIntent, 'replaceIntent present');
    assert(bodySchema.required.includes('sourceText'), 'sourceText required');
    // Exits should include success (next) + error variants
    assert('next' in doc.components.schemas, 'next exit variant');
    // x-edison hints for the playbook generator
    const hints = doc['x-edison'].harnessScenarioHints;
    assert(hints.requiredFields.length >= 3, 'at least 3 required fields detected');
    assert(hints.behaviorCues.length > 0, 'behavior cues detected for a rewrite step');
    // Compact stringify sanity check — the doc must serialize
    const s = JSON.stringify(doc);
    assert(s.length > 1000, 'doc stringifies to substantial payload');
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
