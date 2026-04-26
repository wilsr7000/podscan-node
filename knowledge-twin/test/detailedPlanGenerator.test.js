// test/detailedPlanGenerator.test.js — hermetic tests for the sectioned
// plan generator. Stubs the LLM per-section so we can assert orchestration
// (3 waves, section dependencies, partial-plan tolerance) without API calls.

'use strict';

const path = require('path');

// Install stub llmClient BEFORE loading the generator
const llmClientPath = path.resolve(__dirname, '..', 'lib', 'llmClient.js');

// Per-section response registry — test cases set these up.
const sectionResponses = new Map();
let llmCallLog = [];

require.cache[llmClientPath] = {
  id: llmClientPath,
  filename: llmClientPath,
  loaded: true,
  exports: {
    callAnthropicDirect: async (_key, system, user) => {
      // Identify section by matching the system prompt substring — each
      // section's system prompt is distinct enough to disambiguate.
      const sectionKey = [
        'identity', 'inputs', 'outputs', 'exits', 'ui', 'events',
        'integrations', 'useCases', 'logic',
      ].find((k) => {
        const keyword = ({
          identity: 'Extract the step',
          inputs: 'Enumerate every input',
          outputs: 'output schema precisely',
          exits: 'every exit the step',
          ui: 'UI designer',
          events: 'event emissions',
          integrations: 'external APIs',
          useCases: 'concrete real-world invocations',
          logic: 'clean pseudocode',
        })[k];
        return user.includes(keyword) || system.includes(keyword);
      });
      llmCallLog.push({ section: sectionKey || 'unknown', userLen: user.length });
      const canned = sectionResponses.get(sectionKey);
      if (canned && canned.error) return { error: canned.error };
      if (canned) return { raw: typeof canned === 'string' ? canned : JSON.stringify(canned) };
      // Default happy response per section
      return { raw: JSON.stringify(defaultResponse(sectionKey)) };
    },
    hasApiKey: (k) => Boolean(k),
    getApiKey: () => 'test-key',
  },
};

function defaultResponse(section) {
  switch (section) {
    case 'identity': return {
      name: 'sample_step', label: 'Sample Step', kind: 'logic', version: '1.0.0',
      description: 'Does a thing.', categories: ['Sample'], icon: 'cog', shape: 'circle', size: 'small',
    };
    case 'inputs': return [
      { variable: 'input1', label: 'Input 1', type: 'text', component: 'formTextInput', required: true, default: null, helpText: 'h', example: 'e', validation: {}, allowMergeFields: true, allowCodeMode: true, options: null, renderCondition: null },
    ];
    case 'outputs': return {
      dataOut: { name: 'result', type: 'session', ttl: 86400000 },
      schema: { ok: { type: 'boolean', required: true, description: 'success' } },
      example: { ok: true },
    };
    case 'exits': return [
      { id: 'next', label: 'Success', condition: '', when: 'happy' },
      { id: '__error__', label: 'Error', condition: 'processError', when: 'failure' },
    ];
    case 'ui': return { formLayout: 'vertical', groups: [{ label: 'Main', fields: ['input1'], collapsed: false }], renderConditions: [] };
    case 'events': return { emits: [], listens: [] };
    case 'integrations': return [];
    case 'useCases': return [{ title: 'UC1', description: 'desc', scenario: { context: 'x', exampleInputs: {}, expectedOutcome: 'y' } }];
    case 'logic': return {
      summary: 'Transforms input.',
      pseudocode: ['Validate', 'Compute', 'Exit next'],
      errorHandling: [{ case: 'missing input', action: 'exit __error__' }],
    };
    default: return {};
  }
}

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

function resetTestState() {
  sectionResponses.clear();
  llmCallLog = [];
}

(async () => {
  console.log('\n== Prompt builders (shape + size checks) ==');

  await test('identityPrompt includes the playbook excerpt and shape schema', () => {
    const { _identityPrompt } = require('../lib/detailedPlanGenerator');
    const { systemPrompt, userPrompt } = _identityPrompt('# The F&R agent\n\nRewrite text semantically.');
    assert(systemPrompt.length > 20);
    assert(userPrompt.includes('The F&R agent'));
    assert(userPrompt.includes('"name"'));
    assert(userPrompt.includes('"label"'));
    // Anti-framing guardrail
    assert(userPrompt.includes('GSX library step'), 'identity prompt has anti-framing guardrail');
  });

  await test('inputsPrompt asks for comprehensive input schema', () => {
    const { _inputsPrompt } = require('../lib/detailedPlanGenerator');
    const { userPrompt } = _inputsPrompt('playbook body');
    assert(userPrompt.includes('"variable"'));
    assert(userPrompt.includes('"component"'));
    assert(userPrompt.includes('auth-external-component'));
    assert(userPrompt.includes('renderCondition'));
  });

  await test('logicPrompt references the wave-1 sections it depends on', () => {
    const { _logicPrompt } = require('../lib/detailedPlanGenerator');
    const { userPrompt } = _logicPrompt('pb', {
      inputs: [{ variable: 'foo' }],
      outputs: { dataOut: { name: 'result' } },
      exits: [{ id: 'next' }],
      integrations: [],
    });
    assert(userPrompt.includes('"foo"'), 'prompt contains inputs');
    assert(userPrompt.includes('"next"'), 'prompt contains exits');
    assert(userPrompt.includes('result'), 'prompt contains outputs');
  });

  await test('truncateForPrompt clamps at budget, keeps head+tail', () => {
    const { _truncateForPrompt } = require('../lib/detailedPlanGenerator');
    const big = 'a'.repeat(5000) + 'TAIL_MARKER';
    const out = _truncateForPrompt(big, 1000);
    assert(out.length <= 1100, 'length clamped');
    assert(out.includes('...[truncated]...'));
    assert(out.includes('TAIL_MARKER'));
  });

  console.log('\n== Deterministic platformRequirements ==');

  await test('generatePlatformRequirements returns all 5 category arrays', () => {
    const { generatePlatformRequirements } = require('../lib/detailedPlanGenerator');
    const pr = generatePlatformRequirements();
    assert(Array.isArray(pr.reusability) && pr.reusability.length > 0);
    assert(Array.isArray(pr.logging) && pr.logging.length > 0);
    assert(Array.isArray(pr.exits) && pr.exits.length > 0);
    assert(Array.isArray(pr.auth) && pr.auth.length > 0);
    assert(Array.isArray(pr.errors) && pr.errors.length > 0);
  });

  console.log('\n== generateDetailedPlan — orchestration ==');

  await test('happy path: all 11 sections populated', async () => {
    resetTestState();
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    const plan = await generateDetailedPlan({
      playbookId: 'pb-1',
      playbook: '# F&R agent\n\nDescription here.',
      apiKey: 'test-key',
      log: () => {},
    });
    assertEq(plan.schemaVersion, '1.0.0');
    assertEq(plan.playbookId, 'pb-1');
    assert(plan.sections.identity, 'identity populated');
    assert(plan.sections.inputs, 'inputs populated');
    assert(plan.sections.outputs, 'outputs populated');
    assert(plan.sections.exits, 'exits populated');
    assert(plan.sections.ui, 'ui populated');
    assert(plan.sections.events, 'events populated');
    assert(plan.sections.platformRequirements, 'platformRequirements populated (deterministic)');
    assert(plan.sections.logic, 'logic populated');
    assert(plan.sections.integrations, 'integrations populated (empty array allowed)');
    assert(plan.sections.useCases, 'useCases populated');
    assert(plan.sections.testing, 'testing populated');
    assertEq(plan.sectionErrors, null, 'no section errors on happy path');
  });

  await test('wave 1 LLM calls dispatched in parallel', async () => {
    resetTestState();
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: 'k', log: () => {} });
    // At minimum: identity + inputs + outputs + exits + events + integrations +
    // useCases should have fired. (ui + logic fire later.)
    const wave1Sections = ['identity', 'inputs', 'outputs', 'exits', 'events', 'integrations', 'useCases'];
    const fired = new Set(llmCallLog.map((e) => e.section));
    for (const sec of wave1Sections) {
      assert(fired.has(sec), `${sec} fired`);
    }
    // Logic fires in wave 2, testing in wave 3 — all must end up in the log
    assert(fired.has('logic'), 'logic fired (wave 2)');
    assert(fired.has('ui'), 'ui fired (after wave 1 inputs ready)');
  });

  await test('partial failure: one section errors, others survive', async () => {
    resetTestState();
    sectionResponses.set('outputs', { error: 'API timeout' });
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    const plan = await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: 'k', log: () => {} });
    assertEq(plan.sections.outputs, null, 'outputs null on failure');
    assert(plan.sectionErrors, 'sectionErrors populated');
    assert(plan.sectionErrors.outputs, 'outputs error recorded');
    assert(plan.sections.identity, 'other sections survive');
    assert(plan.sections.logic, 'logic survives even though outputs failed');
  });

  await test('malformed JSON from LLM → section reported as error', async () => {
    resetTestState();
    sectionResponses.set('inputs', 'this is not json at all');
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    const plan = await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: 'k', log: () => {} });
    assertEq(plan.sections.inputs, null);
    assert(plan.sectionErrors.inputs);
    assert(plan.sectionErrors.inputs.match(/not parseable|JSON/i), 'error mentions JSON/parse');
  });

  await test('JSON response with markdown fences is parsed correctly', async () => {
    resetTestState();
    const fenced = '```json\n' + JSON.stringify({ name: 'foo', label: 'Foo', kind: 'logic', version: '1.0.0', description: 'd', categories: [], icon: 'x', shape: 'circle', size: 'small' }) + '\n```';
    sectionResponses.set('identity', fenced);
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    const plan = await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: 'k', log: () => {} });
    assertEq(plan.sections.identity.name, 'foo');
  });

  await test('no api key → all LLM sections error, deterministic sections still work', async () => {
    resetTestState();
    // Override hasApiKey to return false
    require.cache[llmClientPath].exports.hasApiKey = () => false;
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    const plan = await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: null, log: () => {} });
    assertEq(plan.sections.identity, null);
    assertEq(plan.sections.inputs, null);
    // Deterministic section still works
    assert(plan.sections.platformRequirements, 'platformRequirements still populated');
    assert(Array.isArray(plan.sections.platformRequirements.reusability));
    // Restore
    require.cache[llmClientPath].exports.hasApiKey = (k) => Boolean(k);
  });

  await test('logic sees inputs/outputs/exits from wave 1 in its prompt', async () => {
    resetTestState();
    // Track the logic prompt content
    let logicUser = null;
    require.cache[llmClientPath].exports.callAnthropicDirect = async (_key, system, user) => {
      const section = ['identity', 'inputs', 'outputs', 'exits', 'ui', 'events', 'integrations', 'useCases', 'logic'].find((k) => {
        const keyword = ({
          identity: 'Extract the step', inputs: 'Enumerate every input',
          outputs: 'output schema precisely', exits: 'every exit the step',
          ui: 'UI designer', events: 'event emissions',
          integrations: 'external APIs', useCases: 'concrete real-world invocations',
          logic: 'clean pseudocode',
        })[k];
        return user.includes(keyword) || system.includes(keyword);
      });
      llmCallLog.push({ section, userLen: user.length });
      if (section === 'logic') logicUser = user;
      return { raw: JSON.stringify(defaultResponse(section)) };
    };
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    await generateDetailedPlan({ playbookId: 'pb-1', playbook: 'x', apiKey: 'k', log: () => {} });
    assert(logicUser, 'logic prompt captured');
    // The default inputs include variable 'input1' — it should be in the logic prompt
    assert(logicUser.includes('input1'), 'logic prompt includes wave-1 inputs');
    assert(logicUser.includes('next'), 'logic prompt includes wave-1 exits');
  });

  console.log('\n== renderPlanAsMarkdown ==');

  await test('renderPlanAsMarkdown produces non-empty markdown with key sections', () => {
    const { renderPlanAsMarkdown } = require('../lib/detailedPlanGenerator');
    const plan = {
      schemaVersion: '1.0.0',
      playbookId: 'pb-1',
      generatedAt: new Date().toISOString(),
      sections: {
        identity: { name: 'foo', label: 'Foo Bar', kind: 'logic', description: 'does thing', categories: ['Utils'] },
        inputs: [{ variable: 'x', label: 'X', type: 'text', required: true, helpText: 'help' }],
        outputs: { dataOut: { name: 'r' }, schema: {}, example: {} },
        exits: [{ id: 'next', label: 'Success', when: 'ok' }],
        logic: { summary: 's', pseudocode: ['a', 'b'], errorHandling: [] },
        integrations: [],
        testing: { scenarios: [{ name: 'test1', expect: { code: 'X' } }] },
        useCases: [{ title: 'UC1', description: 'd' }],
        platformRequirements: { reusability: ['r1'], logging: ['l1'], exits: ['e1'], auth: ['a1'], errors: ['er1'] },
      },
      sectionErrors: null,
    };
    const md = renderPlanAsMarkdown(plan);
    assert(md.includes('# Detailed Plan'));
    assert(md.includes('Foo Bar'));
    assert(md.includes('## Inputs'));
    assert(md.includes('## Outputs'));
    assert(md.includes('## Exits'));
    assert(md.includes('## Logic'));
    assert(md.includes('## Test scenarios'));
    assert(md.includes('## Use cases'));
    assert(md.includes('## Platform requirements'));
  });

  await test('renderPlanAsMarkdown handles partial plans (missing sections)', () => {
    const { renderPlanAsMarkdown } = require('../lib/detailedPlanGenerator');
    const partial = {
      schemaVersion: '1.0.0',
      playbookId: 'pb-1',
      generatedAt: new Date().toISOString(),
      sections: {
        identity: { name: 'foo', label: 'Foo' },
        platformRequirements: { reusability: [], logging: [], exits: [], auth: [], errors: [] },
      },
      sectionErrors: { inputs: 'API timeout', outputs: 'malformed JSON' },
    };
    const md = renderPlanAsMarkdown(partial);
    assert(md.includes('Foo'));
    assert(md.includes('Generation errors'));
    assert(md.includes('inputs'));
    assert(md.includes('outputs'));
    assert(md.includes('API timeout'));
  });

  console.log('\n== Input validation ==');

  await test('throws on missing playbookId', async () => {
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    let caught = 0;
    try { await generateDetailedPlan({ playbook: 'x' }); } catch { caught++; }
    try { await generateDetailedPlan({ playbookId: '', playbook: 'x' }); } catch { caught++; }
    assertEq(caught, 2);
  });

  await test('throws on missing playbook', async () => {
    delete require.cache[require.resolve('../lib/detailedPlanGenerator')];
    const { generateDetailedPlan } = require('../lib/detailedPlanGenerator');
    let caught = 0;
    try { await generateDetailedPlan({ playbookId: 'pb-1' }); } catch { caught++; }
    assertEq(caught, 1);
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
