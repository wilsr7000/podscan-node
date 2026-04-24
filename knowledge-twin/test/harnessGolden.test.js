// test/harnessGolden.test.js — differential verification of the Test Harness
// library step against a curated set of golden-truth fixtures.
//
// Each fixture in test/harness-golden/*.fixture.js declares:
//   - serverBehavior: a function(body, reqNum) → response, driving a mock target
//   - scenarios: what the harness will run against that mock target
//   - expectedVerdict: 'pass' or 'fail' — the truth the harness MUST produce
//   - expectedPerScenario: [{ name, ok }] — per-scenario truth
//
// For each fixture:
//   1. Start an in-process HTTP server wired to serverBehavior
//   2. Run the harness step (loaded from library/steps/test-harness/logic.js)
//   3. Assert the harness's verdict + per-scenario results match the fixture
//   4. Tear the server down
//
// Cross-validation semantics:
//   - 3 "correct" fixtures (01, 02, 03) — harness MUST say all pass
//   - 2 "broken" fixtures  (04, 05)     — harness MUST catch the specific
//     behavioral bugs they model (no-op rewrite; always-same-exit)
//
// If this suite passes, the harness template correctly distinguishes
// correct target flows from broken ones — which is what we need to trust
// it for every other target flow the pipeline tests.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { runStepCodeLocally } = require('../lib/localStepRuntime');

const HARNESS_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'library', 'steps', 'test-harness', 'logic.js'),
  'utf8',
);

const GOLDEN_DIR = path.join(__dirname, 'harness-golden');

function startMockTarget(behavior, { mode = 'async', latencyMs = 5 } = {}) {
  const jobs = new Map();
  let jobSeq = 0;
  let reqCount = 0;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST') {
        reqCount++;
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch {}
        const resp = behavior(body, reqCount) || { code: 'NO_RESP' };

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

async function runHarnessAgainst(targetUrl, scenarios) {
  return runStepCodeLocally({
    code: HARNESS_SRC,
    className: 'TestHarness',
    data: {
      targetFlowUrl: targetUrl,
      scenarios: JSON.stringify(scenarios),
      pollDelayMs: 25,
      maxPolls: 30,
      timeoutMs: 5000,
    },
    opts: { timeoutMs: 20000 },
  });
}

let passed = 0, failed = 0;
async function runFixture(fixturePath) {
  // Fresh require to pick up any in-session changes during debug cycles.
  delete require.cache[require.resolve(fixturePath)];
  const f = require(fixturePath);
  const label = `${path.basename(fixturePath, '.fixture.js')}`;

  const srv = await startMockTarget(f.serverBehavior);
  try {
    const r = await runHarnessAgainst(srv.url, f.scenarios);
    if (!r.ok) {
      console.log(`  ✗ [${label}] harness failed to run: ${r.error}`);
      failed++;
      return;
    }
    const payload = r.exitPayload || {};
    const actualVerdict = payload.verdict;
    const expectedVerdict = f.expectedVerdict;
    if (actualVerdict !== expectedVerdict) {
      console.log(`  ✗ [${label}] verdict mismatch: expected "${expectedVerdict}" got "${actualVerdict}"`);
      if (payload.results) {
        for (const r of payload.results) {
          console.log(`        scenario "${r.name}" ok=${r.ok} ${r.diff && r.diff.length ? JSON.stringify(r.diff).slice(0,200) : ''}`);
        }
      }
      failed++;
      return;
    }

    // Per-scenario truth check
    const actualMap = new Map((payload.results || []).map((x) => [x.name, x]));
    for (const expected of f.expectedPerScenario || []) {
      const actual = actualMap.get(expected.name);
      if (!actual) {
        console.log(`  ✗ [${label}] missing expected scenario "${expected.name}" in results`);
        failed++;
        return;
      }
      if (actual.ok !== expected.ok) {
        console.log(`  ✗ [${label}] scenario "${expected.name}": expected ok=${expected.ok} got ok=${actual.ok}`);
        if (actual.diff && actual.diff.length) {
          console.log(`        diff: ${JSON.stringify(actual.diff).slice(0, 200)}`);
        }
        failed++;
        return;
      }
    }

    console.log(`  ✓ [${label}] verdict=${actualVerdict}, ${payload.summary.passed}/${payload.summary.total} scenarios match declared truth`);
    passed++;
  } finally {
    await srv.close();
  }
}

(async () => {
  const fixtures = fs.readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith('.fixture.js'))
    .sort()
    .map((f) => path.join(GOLDEN_DIR, f));

  console.log(`\n== Harness Golden Set (${fixtures.length} fixtures) ==`);
  console.log('  Differential verification: harness template vs known-truth targets\n');

  for (const fx of fixtures) {
    await runFixture(fx);
  }

  console.log(`\n---\n${passed} fixtures passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\n  The harness template produced a verdict that disagrees with');
    console.log('  a hand-verified golden fixture. DO NOT SHIP this harness');
    console.log('  revision — either fix the harness or revise the fixture.');
    process.exit(1);
  }
})();
