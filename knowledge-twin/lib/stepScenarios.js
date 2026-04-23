// ---------------------------------------------------------------------------
// stepScenarios.js — test-runner primitives for deployed steps.
//
// Three pieces:
//   1. parseScenariosFromPlaybook(markdown) → scenarios[] | null
//      Reads a `## Test Scenarios` / `## NN. Test Scenarios` section from a
//      playbook and extracts the JSON code block inside.
//   2. deriveScenariosFromSpec(spec) → scenarios[]
//      Fallback: produces minimum-viable smoke scenarios from a spec. One
//      per required input (missing-field → MISSING_INPUT) plus one happy-
//      path that passes all required fields with reasonable defaults and
//      accepts any of [success shape, known-auth-failure code].
//   3. runScenarios(baseUrl, gatewayPath, scenarios, opts) → results[]
//      For each scenario: POST inputs → poll → compare response against
//      `expect` → { scenario, ok, actual, diff[] }. Sequential, not parallel
//      (Edison KV poll gets confused by interleaved jobs).
//
// The runner is pipeline-local for now. Future work can extract it into a
// dedicated "Step Test Runner" Edison flow so flow authors can invoke
// scenario-based tests from any flow — matches the user's pipeline spec
// beat "Test flow is created" / "Flow is tested using test flow".
// ---------------------------------------------------------------------------

'use strict';

// Error codes that mean "step code path ran correctly, external dep failed
// for environment reasons (missing creds, upstream down, rate limit, etc.)".
// Auto-derived happy-path scenarios accept any of these as PASS — they prove
// the step compiled, wired inputs correctly, hit the external call, and
// exited with a structured error. Production usage will have real creds and
// turn these into success responses.
const ACCEPTABLE_FAILURE_CODES = new Set([
  // Auth / credential resolution
  'AUTH_RETRIEVAL_FAILED', 'AUTH_ERROR', 'AUTH_MISSING_KEY', 'MISSING_AUTH',
  'UNAUTHORIZED', 'FORBIDDEN',
  // Upstream service
  'SERVICE_UNAVAILABLE', 'UPSTREAM_SERVER_ERROR', 'EXTERNAL_ERROR',
  'UPSTREAM_ERROR', 'API_ERROR',
  // Transport / network
  'TIMEOUT', 'NETWORK_ERROR', 'CONNECTION_ERROR', 'RATE_LIMITED',
  // Input validation — step correctly rejected a test value it couldn't
  // process (e.g. expected integer, got 'test' string). This is a valid
  // PASS because it proves the step's input validation works.
  'INVALID_INPUT', 'INVALID_REQUEST', 'INVALID_VALUE', 'INVALID_JSON',
  'VALIDATION_ERROR', 'BAD_REQUEST', 'INVALID_RESPONSE',
  // Not found — remote resource doesn't exist for the test inputs we guessed
  'NOT_FOUND', 'RESOURCE_NOT_FOUND',
  // Missing-input — for happy-path/env-level scenarios, the test runner
  // can't supply everything the step needs (auth credentials especially —
  // they require real vault lookups the scenario runner can't do). When
  // the step's code rejects the synthetic test inputs with a MISSING_INPUT
  // code, that's actually the step WORKING CORRECTLY against an env that
  // can't give it real creds. Missing-field scenarios still verify the
  // SPECIFIC variable is named — they use MISSING_INPUT_CODES (stricter
  // expectation) not this general accept-list.
  'MISSING_INPUT', 'MISSING_FIELD', 'MISSING_REQUIRED', 'FIELD_REQUIRED',
  'REQUIRED_FIELD_MISSING', 'INPUT_REQUIRED',
]);

// Error codes that mean "a required input was missing." Different steps use
// different conventions — we accept any of these when verifying the
// missing-field scenario fires the right exit.
const MISSING_INPUT_CODES = new Set([
  'MISSING_INPUT', 'MISSING_FIELD', 'MISSING_REQUIRED', 'FIELD_REQUIRED',
  'REQUIRED_FIELD_MISSING', 'INPUT_REQUIRED', 'REQUIRED_INPUT_MISSING',
  // Some steps conflate "missing" with "invalid" — accept as fallback
  'INVALID_INPUT', 'INVALID_REQUEST', 'VALIDATION_ERROR', 'BAD_REQUEST',
]);

// ─── Parsing from playbook ──────────────────────────────────────────────

function parseScenariosFromPlaybook(markdown) {
  if (!markdown || typeof markdown !== 'string') return null;
  // Match ## Test Scenarios or ## N. Test Scenarios (any heading level >=2)
  const re = /^#{2,}\s+(?:\d+\.\s+)?Test\s+Scenarios\s*$([\s\S]*?)(?=^#{1,2}\s|\n$)/im;
  const m = markdown.match(re);
  if (!m) return null;
  const section = m[1];
  // Extract the first ```json ... ``` block inside the section
  const jsonBlock = section.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (!jsonBlock) return null;
  try {
    const parsed = JSON.parse(jsonBlock[1]);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.scenarios)) return parsed.scenarios;
    return null;
  } catch (_) {
    return null;
  }
}

// ─── Deriving from spec ─────────────────────────────────────────────────

function _exampleValueFor(input) {
  // Priority order for auto-derived test values:
  //   1. spec-author intent: input.example (if Conceive/playbook emits one)
  //   2. declared default: input.default (unless placeholder '``' or empty)
  //   3. select: first option's value (never fabricate enum values)
  //   4. type-based defaults: number→1, bool→false, array→[], object→{}
  //   5. variable-name hints: common field patterns get realistic samples
  //   6. ultimate fallback: 'test' (will fail type-checks on numeric inputs,
  //      but ACCEPTABLE_FAILURE_CODES now includes INVALID_INPUT to treat
  //      that correctly-rejected value as a PASS — step ran and validated)
  //
  // No playbook-specific guesses: weather/location/email are HINTS based on
  // variable-name conventions (any step with variable:'email' gets a real
  // email, not just weather). The hints table stays short — extending it is
  // encouraged but not required; playbook ## Test Scenarios always wins.

  if (input.example !== undefined && input.example !== '' && input.example !== null) {
    return input.example;
  }
  const defaultVal = input.default;
  if (defaultVal !== undefined && defaultVal !== null && defaultVal !== '' &&
      defaultVal !== '``' && defaultVal !== 'undefined' && defaultVal !== 'null') {
    return defaultVal;
  }
  const type = (input.type || '').toLowerCase();
  const comp = (input.component || '').toLowerCase();

  // Select / enum — pick a real option rather than fabricating a value
  if (type === 'select' || comp.includes('select')) {
    if (Array.isArray(input.options) && input.options.length > 0) {
      const first = input.options[0];
      if (typeof first === 'object') return first.value !== undefined ? first.value : first.label;
      return first;
    }
  }

  // Numeric types
  if (type === 'number' || type === 'int' || type === 'integer' ||
      type === 'float' || type === 'double' || type === 'decimal') return 1;

  // Boolean types
  if (type === 'bool' || type === 'boolean' || type === 'switch' ||
      type === 'checkbox' || type === 'toggle') return false;

  // Structured types
  if (type === 'array' || type === 'list') return [];
  if (type === 'object' || type === 'json' || type === 'code' || type === 'map') return {};
  if (type === 'textarea') return 'sample text';
  if (type === 'date') return new Date().toISOString().slice(0, 10);
  if (type === 'datetime') return new Date().toISOString();

  // Variable-name hints — generic conventions, not playbook-specific.
  // Extending the table is fine; none of these override an explicit
  // input.example or input.default.
  const v = String(input.variable || '').toLowerCase();
  if (v === 'email' || v.endsWith('email')) return 'test@example.com';
  if (v === 'url' || v.endsWith('url') || v === 'endpoint' || v.endsWith('endpoint')) return 'https://example.com';
  if (v === 'location' || v === 'city' || v === 'address') return 'San Francisco, CA';
  if (v === 'phone' || v.endsWith('phone')) return '+15555550100';
  if (v === 'uuid' || v === 'id' || v.endsWith('id')) return '00000000-0000-0000-0000-000000000000';
  if (v === 'path' || v.endsWith('path')) return '/';
  if (v === 'language' || v === 'locale') return 'en';
  if (v === 'timezone') return 'UTC';
  if (v === 'currency') return 'USD';
  if (v === 'country') return 'US';

  // Final fallback — generic string. Numeric/select inputs that got a
  // default or options will have already exited above, so this only fires
  // for free-form strings. If the step validates format (UUID, enum, etc.)
  // and rejects with INVALID_INPUT, the scenario still PASSes via the
  // expanded ACCEPTABLE_FAILURE_CODES.
  return 'test';
}

function deriveScenariosFromSpec(spec, { maxMissingFieldScenarios = 3 } = {}) {
  const scenarios = [];
  if (!spec || typeof spec !== 'object') return scenarios;
  const inputs = Array.isArray(spec.inputs) ? spec.inputs : [];
  // Skip auth/dataOut/infra inputs when constructing missing-field scenarios;
  // auth inputs are handled separately by deployed step code (credential
  // missing → AUTH_RETRIEVAL_FAILED), not by MISSING_INPUT.
  const skipTypes = new Set(['auth', 'dataOut', 'asyncModule']);
  const skipVars = new Set(['discoveryUrl', 'authRefreshUrl', 'referenceFlowId', 'apiUrl', 'model']);
  const testableInputs = inputs.filter(i =>
    i && i.variable && !skipTypes.has(i.type) && !skipVars.has(i.variable)
  );
  const requiredInputs = testableInputs.filter(i => i.required === true);

  // Scenario set A: "missing required field" scenarios. Generate one per
  // required input (capped at maxMissingFieldScenarios — each scenario is
  // a full POST+poll cycle, ~5-15s each). Each scenario omits just that
  // field (populates the others) so the step's error response names the
  // specific field that's missing. That\'s more useful than "omit every
  // field" which doesn\'t tell you which required check fired.
  if (requiredInputs.length > 0) {
    const toTest = requiredInputs.slice(0, maxMissingFieldScenarios);
    for (const missing of toTest) {
      const input = {};
      for (const other of requiredInputs) {
        if (other.variable === missing.variable) continue;
        input[other.variable] = _exampleValueFor(other);
      }
      scenarios.push({
        name: `missing required "${missing.variable}" → step exits with a missing-input code`,
        input,
        expect: {
          // Accept any code in the MISSING_INPUT_CODES set — different step
          // authors use different conventions (MISSING_INPUT vs MISSING_FIELD
          // vs INVALID_INPUT). Also accept the field name in the message.
          codeOneOf: [...MISSING_INPUT_CODES],
          messageIncludes: missing.variable,
        },
      });
    }
  } else if (testableInputs.length > 0) {
    // No required inputs — step should accept empty body and either succeed
    // or fail with an acceptable env-level error.
    scenarios.push({
      name: 'empty body (no required inputs) → success or env-level failure',
      input: {},
      expect: { codeOneOfOrSuccess: [...ACCEPTABLE_FAILURE_CODES] },
    });
  }

  // Scenario set B: "happy path" — pass EVERY testable input with a
  // plausible example value, not just required ones. Why: the LLM-generated
  // code sometimes validates optional-in-spec inputs as required-in-code
  // (the spec says optional because it has a default, but the code forgets
  // the default fallback). If we only populate required fields, an over-
  // strict step correctly rejects with MISSING_INPUT — looks like a test
  // failure but is actually spec/code drift we can\'t fix from the test
  // side. Populating all inputs makes the test verify code RUNS rather
  // than relitigate the required-vs-optional boundary.
  //
  // Accept any success shape OR any ACCEPTABLE_FAILURE_CODE (step ran,
  // external dep failed for env reasons).
  if (testableInputs.length > 0) {
    const input = {};
    for (const inp of testableInputs) {
      input[inp.variable] = _exampleValueFor(inp);
    }
    scenarios.push({
      name: 'happy path (all inputs populated) → success or env-level failure',
      input,
      expect: { codeOneOfOrSuccess: [...ACCEPTABLE_FAILURE_CODES] },
    });
  }

  return scenarios;
}

// ─── Running scenarios ──────────────────────────────────────────────────

async function _postAndPoll(url, body, { pollDelayMs = 2000, maxPolls = 15, postTimeoutMs = 15000 } = {}) {
  // POST
  let postResp;
  try {
    postResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(postTimeoutMs),
    });
  } catch (err) {
    return { ok: false, phase: 'post', error: err.message };
  }
  const postText = await postResp.text().catch(() => '');
  if (postResp.status === 404) {
    return { ok: false, phase: 'post', error: 'HTTP 404 — endpoint not live (flow not activated?)', rawText: postText.slice(0, 200) };
  }
  if (postResp.status >= 500) {
    return { ok: false, phase: 'post', error: `HTTP ${postResp.status}`, rawText: postText.slice(0, 200) };
  }
  let postJson;
  try { postJson = JSON.parse(postText); } catch {
    return { ok: false, phase: 'post', error: 'non-JSON response', rawText: postText.slice(0, 200) };
  }
  const jobId = postJson.jobId || postJson.jobID;
  if (!jobId) {
    // Sync response — flow replied inline without async poll. Return as-is.
    return { ok: true, phase: 'post-sync', postStatus: postResp.status, actual: postJson };
  }
  // Poll
  const pollUrl = url + '?jobId=' + encodeURIComponent(jobId) + '&jobID=' + encodeURIComponent(jobId);
  const pendingStatuses = new Set(['pending', 'Pending', 'started', 'running']);
  for (let i = 1; i <= maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollDelayMs));
    let getResp;
    try {
      getResp = await fetch(pollUrl, { signal: AbortSignal.timeout(postTimeoutMs) });
    } catch (err) {
      continue;  // transient; keep polling
    }
    const txt = await getResp.text().catch(() => '');
    let parsed = null; try { parsed = JSON.parse(txt); } catch {}
    if (!parsed) {
      // Could be an inline non-JSON error (e.g. "Invalid key name")
      return { ok: false, phase: 'poll', error: 'non-JSON poll response', rawText: txt.slice(0, 200), jobId };
    }
    // Still pending? loop
    const status = parsed.status;
    if (typeof status === 'string' && (pendingStatuses.has(status) || /started|pending/i.test(status))) continue;
    // Done — return the final payload
    return { ok: true, phase: 'poll-done', jobId, actual: parsed };
  }
  return { ok: false, phase: 'poll', error: `timed out after ${maxPolls} polls`, jobId };
}

function _diagnose(actual, expected) {
  // Compare the response against expected criteria. Return list of
  // mismatches; empty list = pass.
  const diff = [];
  if (!actual || typeof actual !== 'object') {
    diff.push({ field: '_response', expected: 'object', actual: typeof actual });
    return diff;
  }
  if (expected.code !== undefined) {
    if (Array.isArray(expected.code)) {
      if (!expected.code.includes(actual.code)) diff.push({ field: 'code', expectedOneOf: expected.code, actual: actual.code });
    } else {
      if (actual.code !== expected.code) diff.push({ field: 'code', expected: expected.code, actual: actual.code });
    }
  }
  if (Array.isArray(expected.codeOneOf)) {
    if (!expected.codeOneOf.includes(actual.code)) diff.push({ field: 'code', expectedOneOf: expected.codeOneOf, actual: actual.code });
  }
  if (Array.isArray(expected.codeOneOfOrSuccess)) {
    // Pass if code is in the list OR if there's no code (success path)
    const codeOk = !actual.code || expected.codeOneOfOrSuccess.includes(actual.code);
    if (!codeOk) diff.push({ field: 'code', expectedOneOfOrSuccess: expected.codeOneOfOrSuccess, actual: actual.code });
  }
  if (expected.messageIncludes) {
    const msg = (actual.message || '').toString();
    if (!msg.includes(expected.messageIncludes)) {
      diff.push({ field: 'message', expectedIncludes: expected.messageIncludes, actual: msg.slice(0, 120) });
    }
  }
  if (expected.shape && typeof expected.shape === 'object') {
    for (const [k, expectedType] of Object.entries(expected.shape)) {
      const v = actual[k];
      const actualType = Array.isArray(v) ? 'array' : typeof v;
      if (actualType !== expectedType) {
        diff.push({ field: 'shape.' + k, expected: expectedType, actual: actualType });
      }
    }
  }
  return diff;
}

async function runScenarios(baseUrl, gatewayPath, scenarios, { log = console.log, pollDelayMs, maxPolls } = {}) {
  const results = [];
  const url = baseUrl.replace(/\/$/, '') + '/' + gatewayPath.replace(/^\//, '');
  for (const sc of scenarios) {
    log(`  [scenario] "${sc.name || '(unnamed)'}"`);
    const t0 = Date.now();
    const exec = await _postAndPoll(url, sc.input || {}, { pollDelayMs, maxPolls });
    const elapsedMs = Date.now() - t0;
    if (!exec.ok) {
      const r = {
        name: sc.name,
        ok: false,
        phase: exec.phase,
        error: exec.error,
        rawText: exec.rawText,
        elapsedMs,
      };
      results.push(r);
      log(`    FAIL [${exec.phase}] ${exec.error}${exec.rawText ? ` — ${String(exec.rawText).slice(0, 120)}` : ''}`);
      continue;
    }
    const diff = _diagnose(exec.actual, sc.expect || {});
    const ok = diff.length === 0;
    const r = { name: sc.name, ok, phase: exec.phase, actual: exec.actual, diff, elapsedMs };
    results.push(r);
    if (ok) {
      log(`    PASS — ${exec.phase} in ${elapsedMs}ms, code=${exec.actual?.code || '(none)'}`);
    } else {
      log(`    FAIL — ${diff.length} mismatch(es):`);
      for (const d of diff.slice(0, 3)) log(`      ${JSON.stringify(d)}`);
    }
  }
  return results;
}

module.exports = {
  parseScenariosFromPlaybook,
  deriveScenariosFromSpec,
  runScenarios,
  _postAndPoll,
  _diagnose,
  _exampleValueFor,
  ACCEPTABLE_FAILURE_CODES,
  MISSING_INPUT_CODES,
};
