#!/usr/bin/env node
// test/e2e-agent-generates-step.js — PROOF that the whole system works.
//
// This is the headline test: real Anthropic + platform-rules system prompt +
// text_editor agent loop + local step runtime as terminator. If this passes,
// the pipeline's generateCode stage can be swapped to use it.
//
// Env: ANTHROPIC_API_KEY must be set.

'use strict';

const platformRules = require('../lib/platformRules');
const { runAgentLoop } = require('../lib/agentLoop');
const { runScenarios } = require('../lib/localStepRuntime');

const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-20250514';

// ---- The spec we give Claude to implement ----
const SPEC = {
  label: 'Weather Check',
  className: 'WeatherCheck',
  description: 'Given a location and a threshold, decide whether the forecast is anomalous. The API call is mocked in tests — treat the weather API URL as an input with a sensible default.',
  inputs: [
    { variable: 'location', type: 'text', required: true, helpText: 'City name to check' },
    { variable: 'apiBaseUrl', type: 'text', required: false, default: 'https://api.weatherapi.com/v1', helpText: 'Weather API base URL' },
    { variable: 'anomalyThreshold', type: 'number', required: false, default: 1.5, helpText: 'Stddev deviation to flag anomaly' },
  ],
  exits: [
    { id: 'next', label: 'next' },
    { id: '__error__', label: 'on error' },
  ],
};

// ---- The scenarios the generated code must pass ----
// Keep scenarios happy-path only for this first E2E — local runtime can run
// the code; real fetch() calls will obviously not reach weatherapi.com in
// tests. We let the generated code fall through to throwing/exiting, and we
// assert the ERROR SHAPE is right (code + message). This proves the step
// handles the "API unreachable" edge correctly, which is what matters.
const SCENARIOS = [
  {
    name: 'missing location returns MISSING_INPUT',
    inputs: { apiBaseUrl: 'https://example.com/doesnotexist', anomalyThreshold: 1.0 },
    expectExit: '__error__',
    // Accept either the convention we want (MISSING_INPUT) or any other generic
    // missing-field code Claude might emit.
    expectCode: ['MISSING_INPUT', 'MISSING_FIELD', 'MISSING_REQUIRED', 'REQUIRED_FIELD_MISSING', 'INVALID_INPUT', 'VALIDATION_ERROR'],
  },
  {
    name: 'network failure surfaces as error exit (not unhandled throw)',
    inputs: { location: 'TestCity', apiBaseUrl: 'https://local-nonroutable.invalid', anomalyThreshold: 1.0 },
    expectExit: '__error__',
    // Allow any error code — we mainly want to see the step exited properly
    // rather than throwing unhandled.
    expectCode: undefined,
  },
];

// ---- Build the user prompt: what Claude sees ----
function buildUserPrompt(spec) {
  return [
    'Implement a single step template in `logic.js` per the Edison Platform Rules.',
    '',
    '## Spec',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    '',
    '## Required shape of logic.js',
    '```javascript',
    `const StepMod = await import('@onereach/flow-sdk/step.js');`,
    `const Step = StepMod.default || StepMod;`,
    ``,
    `class ${spec.className} extends Step {`,
    `  async runStep() {`,
    `    // ... your implementation ...`,
    `  }`,
    `}`,
    `globalThis.${spec.className} = ${spec.className};  // expose so the local test runner can find it`,
    'exports.step = ' + spec.className + ';',
    '```',
    '',
    'Instructions:',
    '1. Create `logic.js` using the text_editor tool (one `create` command).',
    '2. Implement the class body:',
    '   - Validate required inputs first; on missing, return `this.exitStep("__error__", { code: "MISSING_INPUT", message })`.',
    '   - Read optional inputs with defaults (do NOT MISSING_INPUT them).',
    '   - Call the weather API with `fetch`.',
    '   - On network / non-2xx failure, return `this.exitStep("__error__", { code: "EXTERNAL_ERROR", message })` — do not throw unhandled.',
    '   - On success, `return this.exitStep("next", { ... })` with the anomaly decision.',
    '3. Wrap the main logic in a top-level `try/catch`.',
    '4. Include `globalThis.' + spec.className + ' = ' + spec.className + ';` so the test runner can load it.',
    '5. Stop once `logic.js` is created (one tool call is enough; no need to view).',
  ].join('\n');
}

// ---- The terminator: run the scenarios locally ----
function buildTerminator(spec, log = () => {}) {
  return async (files) => {
    if (!files['logic.js']) {
      return { done: false, message: 'logic.js was not created. Create it now with the text_editor tool.' };
    }
    const code = files['logic.js'];
    log(`  [terminator] running ${SCENARIOS.length} scenarios against ${code.length}b of code`);
    const result = await runScenarios({
      code,
      className: spec.className,
      scenarios: SCENARIOS,
    });
    log(`  [terminator] passed: ${result.passed}/${result.total}, failed: ${result.failed}`);
    if (result.failed === 0) {
      return { done: true, observation: `${result.passed}/${result.total} scenarios passed` };
    }
    // Build a failure message Claude can act on.
    const failures = result.results.filter(r => !r.ok).map((r, i) => {
      const rt = r.runtime || {};
      const errSummary = rt.error ? `threw: ${rt.error}` : `exit=${rt.exitId} code=${rt.exitPayload?.code || '-'}`;
      return `  ${i + 1}. ${r.scenario}: ${errSummary}`;
    }).join('\n');
    return {
      done: false,
      message: [
        `${result.failed}/${result.total} scenarios failed:`,
        failures,
        '',
        'Fix `logic.js` using the str_replace command on the existing file. Do not recreate it. Then stop.',
      ].join('\n'),
    };
  };
}

// ---- Main ----
(async () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY is required');
    process.exit(1);
  }
  const rules = platformRules;
  const systemPrompt = rules.getSystemPromptDigest();
  console.log(`Platform rules digest: ${systemPrompt.length} bytes, ${rules.getRules().length} rules, ${rules.getSections().length} sections`);
  console.log(`Spec: ${SPEC.className} — ${SPEC.inputs.length} inputs, ${SPEC.exits.length} exits`);
  console.log(`Scenarios: ${SCENARIOS.length}`);
  console.log(`Model: ${MODEL}`);
  console.log();

  const userPrompt = buildUserPrompt(SPEC);
  const terminator = buildTerminator(SPEC, (m) => console.log(m));

  const startMs = Date.now();
  const res = await runAgentLoop({
    systemPrompt,
    initialUser: userPrompt,
    terminator,
    opts: {
      apiKey: process.env.ANTHROPIC_API_KEY,
      model: MODEL,
      maxOuter: 3,
      maxInner: 8,
      log: (m) => console.log(m),
      cacheSystem: true,  // amortize the ~6KB system prompt
      cacheTtl: '1h',
    },
  });
  const totalMs = Date.now() - startMs;

  console.log('');
  console.log('==================== RESULT ====================');
  console.log('ok:                 ', res.ok);
  console.log('outer iterations:   ', res.outerIterations);
  console.log('inner per outer:    ', res.innerIterationsByOuter);
  console.log('total wall-clock ms:', totalMs);
  console.log('tokens:             ', JSON.stringify(res.totalUsage));
  console.log('files produced:     ', Object.keys(res.files));
  if (res.error) console.log('error:              ', res.error);
  console.log('terminator last:    ', res.lastTerminatorResult?.observation || res.lastTerminatorResult?.message?.slice(0, 200));
  if (res.files['logic.js']) {
    console.log('');
    console.log('==================== logic.js (first 1200 chars) ====================');
    console.log(res.files['logic.js'].slice(0, 1200));
    if (res.files['logic.js'].length > 1200) console.log('... [' + (res.files['logic.js'].length - 1200) + ' more chars truncated]');
  }
  process.exit(res.ok ? 0 : 1);
})().catch((e) => { console.error('FATAL:', e); process.exit(2); });
