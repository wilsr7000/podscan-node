// Fixture 02: a correct rewrite-style target. Produces a real transformation
// with a non-empty diff array. Tests the behavioral-assertion path
// (rewrittenDiffers + diffNonEmpty) on a working target.
//
// This is the scenario shape we would use to test a Find & Replace Agent
// whose implementation actually calls an LLM. We don't have such a step
// yet, but the harness + assertion pattern is what will verify one when
// we build it.

module.exports = {
  id: '02-rewrite-correct',
  description: 'Target flow that correctly rewrites sourceText: outputs rewrittenText ≠ sourceText and populates diff[]. Harness should report verdict=pass.',
  validatedAgainst: '1.0.0',
  expectedVerdict: 'pass',
  expectedPerScenario: [
    { name: 'concept rewrite produces diff', ok: true },
    { name: 'rewrite output differs from input', ok: true },
    { name: 'output shape contains rewrittenText as string', ok: true },
  ],
  scenarios: [
    {
      name: 'concept rewrite produces diff',
      input: { _tag: 'rewrite', sourceText: 'I love country music', findIntent: 'country', replaceIntent: 'rap' },
      expect: { diffNonEmpty: true },
    },
    {
      name: 'rewrite output differs from input',
      input: { _tag: 'rewrite', sourceText: 'I love country music', findIntent: 'country', replaceIntent: 'rap' },
      expect: { rewrittenDiffers: true },
    },
    {
      name: 'output shape contains rewrittenText as string',
      input: { _tag: 'rewrite', sourceText: 'hello', findIntent: 'h', replaceIntent: 'j' },
      expect: { shape: { rewrittenText: 'string' } },
    },
  ],
  serverBehavior: (body /* , reqNum */) => {
    if (body && body._tag === 'rewrite') {
      const src = (body && body.sourceText) || '';
      const find = (body && body.findIntent) || '';
      const repl = (body && body.replaceIntent) || '';
      // Simulate a real transformation — regex-escape just the literal find,
      // then replace once. Good enough for a fixture.
      const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'gi');
      const rewrittenText = src.replace(re, repl);
      const diff = rewrittenText !== src
        ? [{ before: find, after: repl, span: { start: src.toLowerCase().indexOf(find.toLowerCase()) } }]
        : [];
      return { rewrittenText, diff, summary: `replaced ${diff.length} occurrence(s)` };
    }
    return { code: 'UNKNOWN' };
  },
};
