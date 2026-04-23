// Fixture 04 (BROKEN): a rewrite step that doesn't actually rewrite — it
// returns sourceText unchanged and diff=[]. This is the exact bug we saw
// in the Find & Replace Agent (2026-04-23): step runs, returns valid-
// shaped JSON, but the transformation never happens.
//
// The harness MUST catch this with behavioral assertions. Scenarios
// specifically target rewrittenDiffers and diffNonEmpty. Expected verdict:
// fail, with structured diffs calling out the no-op.

module.exports = {
  id: '04-noop-rewrite-broken',
  description: 'Target flow that masquerades as a rewrite step but returns the input unchanged. Harness MUST catch this as a behavioral failure.',
  validatedAgainst: '1.0.0',
  expectedVerdict: 'fail',
  expectedPerScenario: [
    { name: 'rewrite produces diff',               ok: false },
    { name: 'rewrittenText differs from input',    ok: false },
    { name: 'shape check still passes (structure is fine)', ok: true },
  ],
  scenarios: [
    {
      name: 'rewrite produces diff',
      input: { _tag: 'rewrite', sourceText: 'I love country music', findIntent: 'country', replaceIntent: 'rap' },
      expect: { diffNonEmpty: true },
    },
    {
      name: 'rewrittenText differs from input',
      input: { _tag: 'rewrite', sourceText: 'I love country music', findIntent: 'country', replaceIntent: 'rap' },
      expect: { rewrittenDiffers: true },
    },
    {
      name: 'shape check still passes (structure is fine)',
      input: { _tag: 'rewrite', sourceText: 'hello', findIntent: 'h', replaceIntent: 'j' },
      expect: { shape: { rewrittenText: 'string', diff: 'array' } },
    },
  ],
  serverBehavior: (body /* , reqNum */) => {
    if (body && body._tag === 'rewrite') {
      // THE BUG: rewrittenText === sourceText, diff is empty.
      return {
        rewrittenText: body.sourceText || '',
        diff: [],
        summary: 'No matches found',
      };
    }
    return { code: 'UNKNOWN' };
  },
};
