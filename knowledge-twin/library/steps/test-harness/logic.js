// ---------------------------------------------------------------------------
// Test Harness — runs a scenario suite against a deployed Edison flow endpoint.
//
// This step is the TRUST ANCHOR for the pipeline's behavioral-verification
// layer. It is hand-built and NOT pipeline-generated — every test harness we
// deploy splices its scenarios into THIS template's code without regenerating
// the runner. That breaks the "who tests the tester" recursion cycle: the
// harness template is validated once (unit tests + golden-set of correct and
// deliberately-broken fixture flows), versioned, and reused across every
// target.
//
// Contract:
//   Inputs:
//     targetFlowUrl — full URL to POST the scenario's input to
//     scenarios     — JSON array of { name, input, expect }
//     timeoutMs     — per-scenario wall-clock cap (default 30 000)
//     pollDelayMs   — interval between polls     (default 2 500)
//     maxPolls      — cap on polls per scenario  (default 20)
//     failFast      — stop on first failure      (default false)
//
//   Exits:
//     next         — all scenarios passed
//     failures     — at least one scenario failed (with structured diffs)
//     __error__    — harness infrastructure broken (bad URL, invalid scenarios,
//                    catch-all for unexpected throws)
//     __timeout__  — overall step-level timeout from Edison
//
//   Output (harnessResult merge field):
//     verdict      — 'pass' | 'fail'
//     summary      — { total, passed, failed, skipped, durationMs }
//     results[]    — per-scenario detail with diff array on failure
//
// Comparison semantics MATCH lib/stepScenarios.js::_diagnose — that function
// is the canonical one used by the pipeline's stageTestStep. Keeping the same
// rules here means a scenario that passes locally in the harness will also
// pass in the pipeline's inline tester and vice-versa.
// ---------------------------------------------------------------------------

const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

// ---------------------------------------------------------------------------
// _diagnose — keep in lock-step with lib/stepScenarios.js::_diagnose. Copied
// inline so the deployed step has no dependency on the pipeline repo.
// ---------------------------------------------------------------------------
function _diagnose(actual, expected) {
  const diff = [];
  if (!actual || typeof actual !== 'object') {
    diff.push({ field: '_response', expected: 'object', actual: typeof actual });
    return diff;
  }
  if (expected.code !== undefined) {
    if (Array.isArray(expected.code)) {
      if (!expected.code.includes(actual.code)) {
        diff.push({ field: 'code', expectedOneOf: expected.code, actual: actual.code });
      }
    } else if (actual.code !== expected.code) {
      diff.push({ field: 'code', expected: expected.code, actual: actual.code });
    }
  }
  if (Array.isArray(expected.codeOneOf)) {
    if (!expected.codeOneOf.includes(actual.code)) {
      diff.push({ field: 'code', expectedOneOf: expected.codeOneOf, actual: actual.code });
    }
  }
  if (Array.isArray(expected.codeOneOfOrSuccess)) {
    const codeOk = !actual.code || expected.codeOneOfOrSuccess.includes(actual.code);
    if (!codeOk) {
      diff.push({ field: 'code', expectedOneOfOrSuccess: expected.codeOneOfOrSuccess, actual: actual.code });
    }
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
  if (Array.isArray(expected.includes)) {
    // Generic "response contains these substrings" check — useful for prose
    // outputs where exact match is brittle but presence of key phrases is
    // meaningful. Checks every stringifiable field of the response.
    const blob = JSON.stringify(actual).toLowerCase();
    for (const needle of expected.includes) {
      if (typeof needle !== 'string') continue;
      if (!blob.includes(needle.toLowerCase())) {
        diff.push({ field: 'includes', expectedSubstring: needle, present: false });
      }
    }
  }
  if (expected.diffNonEmpty === true) {
    // Behavioral assertion: the target flow's own `diff` field (if any)
    // should contain at least one entry — indicating a real transformation
    // occurred. Common for find-and-replace, rewrite, or edit steps.
    const targetDiff = actual.diff;
    if (!Array.isArray(targetDiff) || targetDiff.length === 0) {
      diff.push({ field: 'diff', expected: 'non-empty array', actual: Array.isArray(targetDiff) ? 'empty array' : typeof targetDiff });
    }
  }
  if (expected.rewrittenDiffers === true) {
    // Behavioral assertion: actual.rewrittenText should NOT equal the input
    // we posted in scenario.input.sourceText (or equivalent). Catches the
    // "step ran but did nothing" failure mode.
    // NOTE: the harness populates _inputSourceText into the actual payload
    // so this check has the before-text available. If the target is not
    // a rewrite step, the caller shouldn't use this assertion.
    const srcField = expected.rewrittenSourceField || 'rewrittenText';
    const beforeField = expected.rewrittenBeforeField || '_inputSourceText';
    const before = actual[beforeField];
    const after = actual[srcField];
    if (typeof before === 'string' && before.length > 0 && before === after) {
      diff.push({ field: srcField, expected: 'differs from input', actual: 'identical to input' });
    }
  }
  return diff;
}

// ---------------------------------------------------------------------------
// _postAndPoll — POST + async-poll an Edison flow. Shape mirrors the
// pipeline's own lib/stepScenarios.js _postAndPoll but written to run INSIDE
// an Edison step (uses fetch, AbortSignal from the global).
// ---------------------------------------------------------------------------
async function _postAndPoll(url, body, { pollDelayMs, maxPolls, postTimeoutMs }) {
  let postResp;
  try {
    postResp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(postTimeoutMs),
    });
  } catch (err) {
    return { ok: false, phase: 'post', error: `POST threw: ${err.message}` };
  }
  const postText = await postResp.text().catch(() => '');
  if (postResp.status === 404) {
    return { ok: false, phase: 'post', error: 'HTTP 404 — endpoint not live', rawText: postText.slice(0, 200) };
  }
  if (postResp.status >= 500) {
    return { ok: false, phase: 'post', error: `HTTP ${postResp.status}`, rawText: postText.slice(0, 200) };
  }
  let postJson;
  try { postJson = JSON.parse(postText); }
  catch { return { ok: false, phase: 'post', error: 'non-JSON response', rawText: postText.slice(0, 200) }; }

  const jobId = postJson.jobId || postJson.jobID;
  if (!jobId) {
    // Sync response — the target returned inline.
    return { ok: true, phase: 'post-sync', postStatus: postResp.status, actual: postJson };
  }

  // Async — poll. Target flows accept either `jobId` or `jobID` casing;
  // send both so legacy/current shapes both match.
  const encoded = encodeURIComponent(String(jobId));
  const pollUrl = url + '?jobId=' + encoded + '&jobID=' + encoded;
  const pendingStatuses = new Set(['pending', 'Pending', 'started', 'running', 'Running']);

  for (let i = 1; i <= maxPolls; i++) {
    await new Promise((r) => setTimeout(r, pollDelayMs));
    let getResp;
    try {
      getResp = await fetch(pollUrl, { signal: AbortSignal.timeout(postTimeoutMs) });
    } catch {
      continue; // transient — keep polling
    }
    const txt = await getResp.text().catch(() => '');
    let parsed = null; try { parsed = JSON.parse(txt); } catch {}
    if (!parsed) {
      return { ok: false, phase: 'poll', error: 'non-JSON poll response', rawText: txt.slice(0, 200), jobId };
    }
    const status = parsed.status;
    if (typeof status === 'string' && (pendingStatuses.has(status) || /started|pending/i.test(status))) {
      continue;
    }
    return { ok: true, phase: 'poll-done', jobId, actual: parsed };
  }
  return { ok: false, phase: 'poll', error: `timed out after ${maxPolls} polls`, jobId };
}

// ---------------------------------------------------------------------------
// _inferSourceText — pull the canonical "before text" out of a scenario's
// input so the rewrittenDiffers assertion has something to compare against.
// Checks common field names in preference order.
// ---------------------------------------------------------------------------
function _inferSourceText(input) {
  if (!input || typeof input !== 'object') return null;
  const fields = ['sourceText', 'inputText', 'text', 'content', 'body'];
  for (const f of fields) {
    if (typeof input[f] === 'string' && input[f].length > 0) return input[f];
  }
  return null;
}

class TestHarness extends Step {
  async runStep() {
    const t0 = Date.now();
    this.log.info('Test Harness start', {
      targetFlowUrl: String(this.data.targetFlowUrl || '').slice(0, 80),
    });

    // --- Validate inputs ---
    const targetFlowUrl = (this.data.targetFlowUrl && this.data.targetFlowUrl !== 'undefined')
      ? String(this.data.targetFlowUrl).trim()
      : '';
    if (!targetFlowUrl) {
      return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'targetFlowUrl is required' });
    }
    if (!/^https?:\/\//.test(targetFlowUrl)) {
      return this.exitStep('__error__', { code: 'INVALID_INPUT', message: `targetFlowUrl must start with http:// or https://, got "${targetFlowUrl.slice(0, 80)}"` });
    }

    let scenarios = this.data.scenarios;
    if (typeof scenarios === 'string') {
      try { scenarios = JSON.parse(scenarios); }
      catch (parseErr) {
        return this.exitStep('__error__', { code: 'INVALID_INPUT', message: `scenarios JSON parse failed: ${parseErr.message}` });
      }
    }
    if (!Array.isArray(scenarios)) {
      return this.exitStep('__error__', { code: 'INVALID_INPUT', message: `scenarios must be an array, got ${typeof scenarios}` });
    }
    if (scenarios.length === 0) {
      return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'scenarios array is empty' });
    }

    const timeoutMs = Number(this.data.timeoutMs) || 30_000;
    const pollDelayMs = Number(this.data.pollDelayMs) || 2_500;
    const maxPolls = Number(this.data.maxPolls) || 20;
    const failFast = this.data.failFast === true || this.data.failFast === 'true';

    // --- Run scenarios ---
    const results = [];
    let passed = 0, failed = 0, skipped = 0;

    for (let i = 0; i < scenarios.length; i++) {
      const sc = scenarios[i];
      if (!sc || typeof sc !== 'object') {
        skipped++;
        results.push({ name: `#${i}`, ok: false, phase: 'skip', error: 'scenario is not an object', diff: [{ field: '_scenario', error: 'not-an-object' }], elapsedMs: 0 });
        if (failFast) break;
        continue;
      }
      const name = typeof sc.name === 'string' && sc.name.length > 0 ? sc.name : `scenario-${i}`;
      const input = (sc.input && typeof sc.input === 'object') ? sc.input : {};
      const expect = (sc.expect && typeof sc.expect === 'object') ? sc.expect : {};
      const sourceTextForBefore = _inferSourceText(input);

      this.log.info(`Scenario "${name}" starting`, {
        inputKeys: Object.keys(input).slice(0, 10),
        expectKeys: Object.keys(expect),
      });

      const scT0 = Date.now();
      const exec = await _postAndPoll(targetFlowUrl, input, {
        pollDelayMs,
        maxPolls,
        postTimeoutMs: timeoutMs,
      });
      const elapsedMs = Date.now() - scT0;

      if (!exec.ok) {
        failed++;
        const r = {
          name,
          ok: false,
          phase: exec.phase,
          error: exec.error,
          rawText: exec.rawText,
          diff: [{ field: '_runtime', error: exec.error }],
          elapsedMs,
        };
        results.push(r);
        this.log.warn(`Scenario "${name}" runtime failure`, { phase: exec.phase, error: String(exec.error || '').slice(0, 200) });
        if (failFast) break;
        continue;
      }

      // Augment actual with _inputSourceText so rewrittenDiffers assertions
      // can compare before/after. Non-destructive: only added when the input
      // had one of the canonical source fields.
      const actual = Object.assign({}, exec.actual || {});
      if (sourceTextForBefore !== null) {
        actual._inputSourceText = sourceTextForBefore;
      }

      const diff = _diagnose(actual, expect);
      if (diff.length === 0) {
        passed++;
        results.push({ name, ok: true, phase: exec.phase, actual, diff: [], elapsedMs });
        this.log.info(`Scenario "${name}" PASS`, { phase: exec.phase, elapsedMs });
      } else {
        failed++;
        results.push({ name, ok: false, phase: exec.phase, actual, diff, elapsedMs });
        this.log.warn(`Scenario "${name}" FAIL`, { mismatches: diff.length, firstDiff: diff[0] });
        if (failFast) break;
      }
    }

    const durationMs = Date.now() - t0;
    const summary = {
      total: scenarios.length,
      passed,
      failed,
      skipped,
      durationMs,
    };
    const verdict = failed === 0 ? 'pass' : 'fail';

    this.log.vital('Test Harness complete', { verdict, ...summary });

    const payload = {
      verdict,
      summary,
      results,
      targetFlowUrl,
      harnessVersion: '1.0.0',
    };

    if (verdict === 'pass') {
      return this.exitStep('next', payload);
    }
    return this.exitStep('failures', payload);
  }
}

// Global export for both the local runtime (checks globalThis.<className>)
// and Edison's Lambda wrapper (picks up the named class at require time).
globalThis.TestHarness = TestHarness;
// Edison's runtime doesn't need the CommonJS export, but leaving a named
// ESM export makes the file consumable by any tool that wants to import it
// directly without going through the Lambda wrapper.
export { TestHarness as step };
