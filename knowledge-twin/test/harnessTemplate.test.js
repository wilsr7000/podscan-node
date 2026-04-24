// test/harnessTemplate.test.js
// Tests for the hand-built Test Harness library step.
//
// Strategy: spin up a tiny in-process HTTP server that mimics the Edison
// flow protocol (POST → jobId → GET poll → final payload). The "target"
// behavior is scripted per test so we can verify the harness produces
// correct verdicts for both PASS and FAIL cases.
//
// The harness MUST:
//   - Report verdict='pass' when every scenario matches its expect rule
//   - Report verdict='fail' with structured diffs when any scenario mismatches
//   - Handle sync responses (no jobId) and async responses (with jobId) equivalently
//   - Treat unreachable URLs as __error__ (not as scenario failures)
//   - Honor failFast: true (stop on first failure)
//   - Match comparison semantics with lib/stepScenarios.js::_diagnose

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { runStepCodeLocally } = require('../lib/localStepRuntime');

const HARNESS_SRC = fs.readFileSync(path.join(__dirname, '..', 'library', 'steps', 'test-harness', 'logic.js'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------------------
// Mock Edison HTTP server. Test cases pass `responseSpec` per scenario.input;
// the server routes on the input body's `_tag` to pick the right response.
// ---------------------------------------------------------------------------

function makeServer({ responsesByTag, mode = 'async', latencyMs = 5 } = {}) {
  const jobs = new Map();
  let jobSeq = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST') {
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const tag = body._tag || 'default';
        const resp = responsesByTag[tag] || responsesByTag.default || { code: 'NO_MATCH' };

        if (mode === 'sync') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(resp));
          return;
        }

        const jobId = 'job-' + (++jobSeq);
        jobs.set(jobId, { deliverAt: Date.now() + latencyMs, resp });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jobId }));
        return;
      }
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const jobId = url.searchParams.get('jobId') || url.searchParams.get('jobID');
        const job = jobs.get(jobId);
        if (!job) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'not-found' }));
          return;
        }
        if (Date.now() < job.deliverAt) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ status: 'pending' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(job.resp));
        return;
      }
      res.writeHead(405).end();
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}/target`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function runHarness({ targetFlowUrl, scenarios, extraData = {} }) {
  return runStepCodeLocally({
    code: HARNESS_SRC,
    className: 'TestHarness',
    data: {
      targetFlowUrl,
      scenarios: JSON.stringify(scenarios),
      pollDelayMs: 50,
      maxPolls: 20,
      timeoutMs: 5000,
      ...extraData,
    },
    opts: { timeoutMs: 15000 },
  });
}

(async () => {
  console.log('\n== Golden: all correct scenarios → verdict=pass ==');

  await test('two passing scenarios → next exit, verdict=pass', async () => {
    const srv = await makeServer({
      responsesByTag: {
        a: { code: 'MISSING_INPUT', message: 'foo missing' },
        b: { code: null, result: 'ok' },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [
          { name: 'a', input: { _tag: 'a' }, expect: { code: 'MISSING_INPUT' } },
          { name: 'b', input: { _tag: 'b' }, expect: { codeOneOfOrSuccess: ['MISSING_INPUT'] } },
        ],
      });
      assert(r.ok, 'harness ran: ' + JSON.stringify(r));
      assertEq(r.exitId, 'next', 'exits via next');
      assertEq(r.exitPayload.verdict, 'pass', 'verdict=pass');
      assertEq(r.exitPayload.summary.passed, 2, '2 passed');
      assertEq(r.exitPayload.summary.failed, 0, '0 failed');
    } finally { await srv.close(); }
  });

  console.log('\n== Golden: behavioral assertion — diffNonEmpty / rewrittenDiffers ==');

  await test('diffNonEmpty fails when target returns empty diff array', async () => {
    // This simulates exactly the Find & Replace bug we hit — step returns
    // diff=[] when it should have populated it.
    const srv = await makeServer({
      responsesByTag: {
        a: { rewrittenText: 'same as input', diff: [], summary: 'no matches' },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [{
          name: 'rewrite should produce diff',
          input: { _tag: 'a', sourceText: 'same as input' },
          expect: { diffNonEmpty: true },
        }],
      });
      assertEq(r.exitPayload.verdict, 'fail', 'verdict=fail when diff empty');
      const sc = r.exitPayload.results[0];
      assertEq(sc.ok, false);
      assert(sc.diff.some((d) => d.field === 'diff'), 'diff field flagged: ' + JSON.stringify(sc.diff));
    } finally { await srv.close(); }
  });

  await test('rewrittenDiffers catches "step ran but did nothing"', async () => {
    // Target returns rewrittenText === input — the hallmark of a no-op rewrite step.
    const srv = await makeServer({
      responsesByTag: {
        a: { rewrittenText: 'I love country music', diff: [] },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [{
          name: 'concept rewrite must differ from input',
          input: { _tag: 'a', sourceText: 'I love country music' },
          expect: { rewrittenDiffers: true },
        }],
      });
      assertEq(r.exitPayload.verdict, 'fail', 'verdict=fail when rewrite = input');
      const sc = r.exitPayload.results[0];
      assert(sc.diff.some((d) => d.field === 'rewrittenText'), 'rewrittenText field flagged');
    } finally { await srv.close(); }
  });

  await test('rewrittenDiffers PASSES when rewrite actually differs', async () => {
    const srv = await makeServer({
      responsesByTag: {
        a: { rewrittenText: 'I love rap music', diff: [{ before: 'country', after: 'rap' }] },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [{
          name: 'concept rewrite differs from input',
          input: { _tag: 'a', sourceText: 'I love country music' },
          expect: { rewrittenDiffers: true, diffNonEmpty: true },
        }],
      });
      assertEq(r.exitPayload.verdict, 'pass', 'verdict=pass on real rewrite');
    } finally { await srv.close(); }
  });

  console.log('\n== Golden: mismatches produce structured diffs, verdict=fail ==');

  await test('code mismatch → failures exit with diff detail', async () => {
    const srv = await makeServer({
      responsesByTag: {
        a: { code: 'SOMETHING_ELSE', message: 'nope' },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [{
          name: 'expects MISSING_INPUT',
          input: { _tag: 'a' },
          expect: { code: 'MISSING_INPUT' },
        }],
      });
      assertEq(r.exitId, 'failures', 'exits via failures');
      assertEq(r.exitPayload.verdict, 'fail', 'verdict=fail');
      const sc = r.exitPayload.results[0];
      assertEq(sc.diff[0].field, 'code');
      assertEq(sc.diff[0].expected, 'MISSING_INPUT');
      assertEq(sc.diff[0].actual, 'SOMETHING_ELSE');
    } finally { await srv.close(); }
  });

  await test('messageIncludes substring check', async () => {
    const srv = await makeServer({
      responsesByTag: {
        a: { code: 'MISSING_INPUT', message: 'the "mode" input is required' },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [
          { name: 'contains mode', input: { _tag: 'a' }, expect: { messageIncludes: 'mode' } },
          { name: 'contains foo (false)', input: { _tag: 'a' }, expect: { messageIncludes: 'foo' } },
        ],
      });
      assertEq(r.exitPayload.summary.passed, 1);
      assertEq(r.exitPayload.summary.failed, 1);
    } finally { await srv.close(); }
  });

  console.log('\n== Golden: failFast ==');

  await test('failFast: true stops on first failure', async () => {
    const srv = await makeServer({
      responsesByTag: {
        a: { code: 'NO_MATCH' },
        b: { code: 'MISSING_INPUT' },
      },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [
          { name: 'a-fails', input: { _tag: 'a' }, expect: { code: 'MISSING_INPUT' } },
          { name: 'b-would-pass', input: { _tag: 'b' }, expect: { code: 'MISSING_INPUT' } },
        ],
        extraData: { failFast: true },
      });
      assertEq(r.exitPayload.verdict, 'fail');
      // Only the first failing scenario should be in results
      assertEq(r.exitPayload.results.length, 1);
      assertEq(r.exitPayload.results[0].name, 'a-fails');
    } finally { await srv.close(); }
  });

  console.log('\n== Golden: sync response (no jobId) works too ==');

  await test('sync target response is handled correctly', async () => {
    const srv = await makeServer({
      mode: 'sync',
      responsesByTag: { a: { code: 'OK', message: 'inline' } },
    });
    try {
      const r = await runHarness({
        targetFlowUrl: srv.url,
        scenarios: [{ name: 'sync', input: { _tag: 'a' }, expect: { code: 'OK' } }],
      });
      assertEq(r.exitPayload.verdict, 'pass');
      assertEq(r.exitPayload.results[0].phase, 'post-sync');
    } finally { await srv.close(); }
  });

  console.log('\n== Harness infrastructure failures → __error__ ==');

  await test('missing targetFlowUrl → __error__', async () => {
    const r = await runStepCodeLocally({
      code: HARNESS_SRC,
      className: 'TestHarness',
      data: { targetFlowUrl: '', scenarios: JSON.stringify([]) },
    });
    assertEq(r.exitId, '__error__');
    assertEq(r.exitPayload.code, 'MISSING_INPUT');
  });

  await test('scenarios not an array → __error__', async () => {
    const r = await runStepCodeLocally({
      code: HARNESS_SRC,
      className: 'TestHarness',
      data: { targetFlowUrl: 'https://example.com/x', scenarios: JSON.stringify({ wrong: 'shape' }) },
    });
    assertEq(r.exitId, '__error__');
    assertEq(r.exitPayload.code, 'INVALID_INPUT');
  });

  await test('scenarios is empty array → __error__', async () => {
    const r = await runStepCodeLocally({
      code: HARNESS_SRC,
      className: 'TestHarness',
      data: { targetFlowUrl: 'https://example.com/x', scenarios: JSON.stringify([]) },
    });
    assertEq(r.exitId, '__error__');
    assertEq(r.exitPayload.code, 'MISSING_INPUT');
  });

  await test('malformed targetFlowUrl → __error__', async () => {
    const r = await runStepCodeLocally({
      code: HARNESS_SRC,
      className: 'TestHarness',
      data: { targetFlowUrl: 'not-a-url', scenarios: JSON.stringify([{ name: 'x', input: {}, expect: {} }]) },
    });
    assertEq(r.exitId, '__error__');
    assertEq(r.exitPayload.code, 'INVALID_INPUT');
  });

  console.log('\n== Scenario-level runtime failures → ok=false but harness verdict=fail ==');

  await test('unreachable target → per-scenario runtime failure (not harness __error__)', async () => {
    const r = await runHarness({
      targetFlowUrl: 'http://127.0.0.1:1/unreachable',
      scenarios: [{ name: 'broken', input: {}, expect: { code: 'X' } }],
    });
    // The harness itself completed; it reports the scenario failed at runtime.
    assert(r.ok, 'harness finished');
    assertEq(r.exitId, 'failures');
    assertEq(r.exitPayload.verdict, 'fail');
    assertEq(r.exitPayload.results[0].ok, false);
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
