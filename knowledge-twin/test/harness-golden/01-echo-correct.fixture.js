// Fixture 01: a correct echo-style target. Returns whatever it's told to.
// All scenarios should pass → verdict=pass.

module.exports = {
  id: '01-echo-correct',
  description: 'Target flow that echoes back the right codes for each test case. Harness should report verdict=pass on ALL scenarios.',
  validatedAgainst: '1.0.0',
  expectedVerdict: 'pass',
  expectedPerScenario: [
    { name: 'missing-input case', ok: true },
    { name: 'success case', ok: true },
    { name: 'custom-error case', ok: true },
  ],
  scenarios: [
    { name: 'missing-input case', input: { _tag: 'miss' }, expect: { code: 'MISSING_INPUT', messageIncludes: 'required' } },
    { name: 'success case', input: { _tag: 'ok' }, expect: { codeOneOfOrSuccess: [] } },
    { name: 'custom-error case', input: { _tag: 'custom' }, expect: { codeOneOf: ['CUSTOM_A', 'CUSTOM_B'] } },
  ],
  serverBehavior: (body /* , reqNum */) => {
    const tag = (body && body._tag) || 'default';
    if (tag === 'miss') return { code: 'MISSING_INPUT', message: 'the `foo` field is required' };
    if (tag === 'ok')   return { result: { worked: true } };  // no code → success
    if (tag === 'custom') return { code: 'CUSTOM_A', message: 'custom-a fired' };
    return { code: 'UNKNOWN' };
  },
};
