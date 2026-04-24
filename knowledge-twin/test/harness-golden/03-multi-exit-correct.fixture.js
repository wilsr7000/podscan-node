// Fixture 03: a correct multi-exit target. Branches on input to take different
// exits (next/unavailable/error), each with distinct payloads. Exercises the
// harness's ability to verify exit-specific behavior across several paths.

module.exports = {
  id: '03-multi-exit-correct',
  description: 'Target flow that routes to different exits based on input. Harness should correctly match each scenario to its expected exit code.',
  validatedAgainst: '1.0.0',
  expectedVerdict: 'pass',
  expectedPerScenario: [
    { name: 'next path', ok: true },
    { name: 'unavailable path', ok: true },
    { name: 'error path', ok: true },
    { name: 'timeout path (acceptable failure)', ok: true },
  ],
  scenarios: [
    { name: 'next path',        input: { _tag: 'next' },        expect: { codeOneOfOrSuccess: [] } },
    { name: 'unavailable path', input: { _tag: 'unavailable' }, expect: { code: 'UNAVAILABLE' } },
    { name: 'error path',       input: { _tag: 'error' },       expect: { code: 'INTERNAL_ERROR', messageIncludes: 'internal' } },
    { name: 'timeout path (acceptable failure)', input: { _tag: 'timeout' }, expect: { codeOneOf: ['TIMEOUT', 'NETWORK_ERROR'] } },
  ],
  serverBehavior: (body /* , reqNum */) => {
    const tag = (body && body._tag) || 'default';
    if (tag === 'next')        return { result: 'ok' };  // no code → success
    if (tag === 'unavailable') return { code: 'UNAVAILABLE', message: 'service temporarily out', status: 'unavailable' };
    if (tag === 'error')       return { code: 'INTERNAL_ERROR', message: 'internal server boom' };
    if (tag === 'timeout')     return { code: 'TIMEOUT', message: 'upstream took too long' };
    return { code: 'UNKNOWN' };
  },
};
