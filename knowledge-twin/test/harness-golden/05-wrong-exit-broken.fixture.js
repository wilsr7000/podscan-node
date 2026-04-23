// Fixture 05 (BROKEN): a step that always exits with the same code
// regardless of input. This models the "step doesn't branch on mode" bug
// from the Find & Replace retry (attempt 1): every scenario gets the same
// response, even when scenarios specifically test different paths.
//
// Harness MUST catch this — the scenarios expect different exit codes for
// different inputs, and the target returns the same code for all of them.
// Expected verdict: fail with code-mismatch diffs on 2 of 3 scenarios.

module.exports = {
  id: '05-wrong-exit-broken',
  description: 'Target flow that always returns the same error code regardless of input. Harness MUST catch this as behavioral failure for scenarios expecting different codes.',
  validatedAgainst: '1.0.0',
  expectedVerdict: 'fail',
  expectedPerScenario: [
    { name: 'expects MISSING_INPUT — gets KABOOM', ok: false },
    { name: 'expects success — gets KABOOM (so acceptable-failure-list blocks it)', ok: false },
    { name: 'expects KABOOM (this scenario actually matches reality)', ok: true },
  ],
  scenarios: [
    {
      name: 'expects MISSING_INPUT — gets KABOOM',
      input: { _tag: 'miss' },
      expect: { code: 'MISSING_INPUT' },
    },
    {
      name: 'expects success — gets KABOOM (so acceptable-failure-list blocks it)',
      input: { _tag: 'happy', foo: 'bar' },
      expect: { codeOneOfOrSuccess: ['MISSING_INPUT', 'INVALID_INPUT'] },
    },
    {
      name: 'expects KABOOM (this scenario actually matches reality)',
      input: { _tag: 'any' },
      expect: { code: 'KABOOM' },
    },
  ],
  serverBehavior: () => {
    // THE BUG: always returns KABOOM, regardless of input
    return { code: 'KABOOM', message: 'something broke' };
  },
};
