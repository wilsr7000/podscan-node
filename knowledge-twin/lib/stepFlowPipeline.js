// ---------------------------------------------------------------------------
// stepFlowPipeline — end-to-end step iteration pipeline
//
// Orchestrates a step from playbook through decompose, conceive, code gen,
// validation, UI design, and approval. Calls live Edison flows at each stage
// with tagging and verification gates.
//
// Build locally first; can be inlined into an Edison flow later.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
const BASE_URL = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}`;

const STAGES = [
  'playbook',
  'decompose',
  'templateFinder',
  'conceive',
  'generateCode',
  'harnessCode',
  'localScenarioRun',  // run scenarios locally (in-process) BEFORE splice — catches code bugs 30-90s earlier (fix 2.2b)
  'validate',
  'testStep',    // run scenario-based tests against the deployed step endpoint
  'designUI',
  'userVerify',
  'testWithUI',
  'done',
];

const BOT_ID = '04d0d009-0468-4a63-be90-cde64bd797df';
const STUDIO_BASE = `https://studio.edison.onereach.ai/flows/${BOT_ID}`;

const ENDPOINTS = {
  templateFinder:  { path: 'flow-template-discovery', flowId: '064be225-4512-4aef-aefa-e9c8d1d6f550', maxPolls: 30, pollDelay: 3000 },
  conceive:        { path: 'conceive-step',        flowId: 'a7206f84-9dd9-4d83-9cd8-091dfee94be6', maxPolls: 40, pollDelay: 4000 },
  generateCode:    { path: 'generate-step-code',   flowId: 'c5d5ee49-23d4-470b-9406-804efc41c823', maxPolls: 60, pollDelay: 10000, initialWait: 40000 },
  stepValidator:   { path: 'step-validator',         flowId: 'c6a07be9-f013-4644-b998-4245813732ce', maxPolls: 30, pollDelay: 3000 },
  spliceStep:      { path: 'splice-step',          flowId: '021297fa-b6c1-4dcb-a1a6-4b9b5bbfbc2e', maxPolls: 60, pollDelay: 5000 },
  fetchLogs:       { path: 'fetch-flow-logs',      flowId: '887fad89-52cd-4fe2-9cf8-9a1b1aa1f23d', maxPolls: 20, pollDelay: 3000 },
  designStep:      { path: 'design-step',          flowId: '0ad31746-2e87-4bb0-8766-77e857d4543d', maxPolls: 60, pollDelay: 5000 },
};

// Map pipeline stage names to the Edison flow ID that stage invokes. Used by
// the log-capture hook (see runPipeline) to grab post-stage forensics. Stages
// that run in-process (playbook, decompose, harnessCode, testStep fetches
// from ctx.flowId, done) are not in this map.
const STAGE_FLOW_IDS = {
  templateFinder: '064be225-4512-4aef-aefa-e9c8d1d6f550',
  conceive:       'a7206f84-9dd9-4d83-9cd8-091dfee94be6',
  generateCode:   'c5d5ee49-23d4-470b-9406-804efc41c823',
  validate:       '021297fa-b6c1-4dcb-a1a6-4b9b5bbfbc2e',  // splice-step
  designUI:       '0ad31746-2e87-4bb0-8766-77e857d4543d',
  testWithUI:     '021297fa-b6c1-4dcb-a1a6-4b9b5bbfbc2e',  // splice-step (re-run)
};

// Validator codes that represent REAL CODE BUGS (not spec/template shape).
// An error-severity diagnostic with one of these codes should trigger a retry
// of Generate Step Code with the diagnostic piped back. Both stageGenerateCode
// (first-pass validation on raw LLM output) and stageHarnessCode (second-pass
// validation on the wrapped template, matching the user's "step validator
// called again" beat in the pipeline spec) consult this set.
//
// Deliberately excludes TEMPLATE_* codes (label length, name, description —
// those come from Conceive/harness, not Generate Step Code), EXIT_CONDITION_
// SYNTAX_ERROR (condition text is passed through from the spec), and form-
// shape codes (INPUT_*, FORM_*, DATAOUT_*). Retrying generateCode for those
// wouldn't fix anything — the LLM doesn't control them.
const CODE_LEVEL_BLOCKERS = new Set([
  // Phase 0 / 1 — structure
  'SYNTAX_ERROR', 'RAW_CODE_NO_STEP_CLASS', 'RAW_CODE_NO_EXITSTEP',
  'RAW_CODE_NO_EXPORT', 'RAW_CODE_USES_PARAMS',
  // Phase 2 — code quality / reusability
  'STEP_LOGIC_HARDCODED_MERGE_REF', 'STEP_LOGIC_READS_API_INPUT',
  'HARDCODED_URL', 'HARDCODED_MODEL', 'HARDCODED_COLLECTION',
  'HARDCODED_THRESHOLD', 'SECRET_IN_CODE',
  'NO_EVAL', 'NO_NEW_FUNCTION', 'THROW_ERROR_OBJECT',
  'ASYNC_NO_AWAIT', 'EXITSTEP_NO_RETURN', 'END_NO_RETURN',
  'MERGEFIELD_NO_GET', 'MERGEFIELD_GET_NO_AWAIT',
  // Phase 3 — exits (code-level only; spec-level condition issues excluded)
  'EXIT_NOT_DEFINED', 'ERROR_EXIT_CALLED_BUT_DISABLED',
  // Phase 4 — auth resolution (code uses wrong pattern)
  'AUTH_NO_KV_RESOLUTION', 'AUTH_PLAIN_TEXT_INPUT',
]);

// ---------------------------------------------------------------------------
// Job persistence — each run gets a folder under .pipeline-jobs/
// ---------------------------------------------------------------------------

const JOBS_DIR = path.join(__dirname, '..', '.pipeline-jobs');

function generateJobId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${ts}-${rand}`;
}

function jobDir(jobId) {
  return path.join(JOBS_DIR, jobId);
}

// ---------------------------------------------------------------------------
// Event stream — append-only JSONL written to .pipeline-jobs/<jobId>/events.ndjson
// The dashboard server tails these files; the pipeline is the producer.
// Writing is fire-and-forget: never throws, never blocks the stage.
// ---------------------------------------------------------------------------

function appendEvent(pipelineJobId, event) {
  if (!pipelineJobId) return;
  try {
    const dir = jobDir(pipelineJobId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ t: new Date().toISOString(), pipelineJobId, ...event }) + '\n';
    fs.appendFileSync(path.join(dir, 'events.ndjson'), line);
  } catch (_) {
    // never crash a pipeline because of a log write
  }
}

function ensureJobDir(jobId) {
  const dir = jobDir(jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveJobState(jobId, ctx) {
  const dir = ensureJobDir(jobId);

  const state = {
    jobId,
    timestamp: new Date().toISOString(),
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    completedStages: ctx.completedStages.map(s => ({
      name: s.name, durationMs: s.durationMs, data: s.data,
    })),
    lastStage: ctx.completedStages.length > 0
      ? ctx.completedStages[ctx.completedStages.length - 1].name
      : null,
  };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state, null, 2));

  if (ctx.playbook) {
    fs.writeFileSync(path.join(dir, 'playbook-original.md'), ctx.playbook);
  }
  if (ctx.bestPlan) {
    fs.writeFileSync(path.join(dir, 'plan-best.md'), ctx.bestPlan);
  }
  if (ctx.objective) {
    fs.writeFileSync(path.join(dir, 'objective.json'), JSON.stringify(ctx.objective, null, 2));
  }
  if (ctx.planEvaluation) {
    const evalSummary = {
      initialScore: ctx.planEvaluation.initialEvaluation.summary.weightedMean,
      bestScore: ctx.planEvaluation.bestEvaluation.summary.weightedMean,
      completed: ctx.planEvaluation.completed,
      iterations: ctx.planEvaluation.iterations.length,
      judges: ctx.planEvaluation.bestEvaluation.judges.map(j => ({
        id: j.id, score: j.score, findings: j.findings.length, strengths: j.strengths.length,
      })),
    };
    fs.writeFileSync(path.join(dir, 'evaluation.json'), JSON.stringify(evalSummary, null, 2));
  }
  if (ctx.templateMatches) {
    fs.writeFileSync(path.join(dir, 'template-matches.json'), JSON.stringify(ctx.templateMatches, null, 2));
  }
  if (ctx.codeGenResult) {
    fs.writeFileSync(path.join(dir, 'codegen-result.json'), JSON.stringify(ctx.codeGenResult, null, 2));
  }
  if (ctx.harnessResult) {
    const { template, ...rest } = ctx.harnessResult;
    fs.writeFileSync(path.join(dir, 'harness-result.json'), JSON.stringify(rest, null, 2));
    if (template) {
      fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(template, null, 2));
    }
  }
  if (ctx.validationResult) {
    fs.writeFileSync(path.join(dir, 'validation-result.json'), JSON.stringify(ctx.validationResult, null, 2));
  }
  if (ctx.deployedTemplate) {
    // Post-fix template as spliced onto the live flow. Distinct from
    // template.json (which harnessCode writes pre-fix). Having both lets
    // you diff what the pipeline generated vs what actually shipped.
    fs.writeFileSync(path.join(dir, 'template-deployed.json'), JSON.stringify(ctx.deployedTemplate, null, 2));
  }
  if (ctx.testResults) {
    // Scenario-based test results for the deployed step endpoint. One file
    // per pipeline run; use to triage post-deploy regressions or to drive
    // the future outer-retry loop (gap #13 — re-run earlier stages when
    // test scenarios fail).
    fs.writeFileSync(path.join(dir, 'test-results.json'), JSON.stringify(ctx.testResults, null, 2));
  }
  if (ctx.logResult) {
    fs.writeFileSync(path.join(dir, 'flow-logs.json'), JSON.stringify(ctx.logResult, null, 2));
  }
  if (ctx.uiResult) {
    fs.writeFileSync(path.join(dir, 'ui-result.json'), JSON.stringify(ctx.uiResult, null, 2));
  }

  return dir;
}

function loadJobState(jobId) {
  const dir = jobDir(jobId);
  const statePath = path.join(dir, 'state.json');
  if (!fs.existsSync(statePath)) throw new Error(`Job not found: ${jobId}`);
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function loadJobPlan(jobId) {
  const dir = jobDir(jobId);
  const planPath = path.join(dir, 'plan-best.md');
  if (fs.existsSync(planPath)) return fs.readFileSync(planPath, 'utf8');
  const origPath = path.join(dir, 'playbook-original.md');
  if (fs.existsSync(origPath)) return fs.readFileSync(origPath, 'utf8');
  return null;
}

// ---------------------------------------------------------------------------
// KV Storage — persist pipeline state to Edison KV (same API the flows use)
// ---------------------------------------------------------------------------

const KV_BASE = `${BASE_URL}/keyvalue`;
const KV_COLLECTION = 'step-pipeline-jobs';

async function kvPut(key, value) {
  try {
    await fetch(`${KV_BASE}?id=${encodeURIComponent(KV_COLLECTION)}&key=${encodeURIComponent(key)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: KV_COLLECTION, key, itemValue: JSON.stringify(value) }),
    });
    return true;
  } catch (err) {
    console.warn('[kv] put failed:', err.message);
    return false;
  }
}

async function kvGet(key, collection = KV_COLLECTION) {
  try {
    const resp = await fetch(`${KV_BASE}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`);
    const data = await resp.json();
    if (data.Status === 'No data found.') return null;
    if (data.value) {
      try { return JSON.parse(data.value); } catch { return data.value; }
    }
    return null;
  } catch (err) {
    console.warn('[kv] get failed:', err.message);
    return null;
  }
}

async function saveJobToKV(jobId, ctx) {
  const payload = {
    jobId,
    timestamp: new Date().toISOString(),
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    lastStage: ctx.completedStages.length > 0
      ? ctx.completedStages[ctx.completedStages.length - 1].name : null,
    completedStages: ctx.completedStages.map(s => ({
      name: s.name, durationMs: s.durationMs, data: s.data,
    })),
    bestPlan: ctx.bestPlan || null,
    objective: ctx.objective || null,
    evaluation: ctx.planEvaluation ? {
      initialScore: ctx.planEvaluation.initialEvaluation.summary.weightedMean,
      bestScore: ctx.planEvaluation.bestEvaluation.summary.weightedMean,
      completed: ctx.planEvaluation.completed,
      judges: ctx.planEvaluation.bestEvaluation.judges.map(j => ({
        id: j.id, score: j.score, findings: j.findings.length,
      })),
    } : null,
  };

  const ok = await kvPut(jobId, payload);
  return ok;
}

async function loadJobFromKV(jobId) {
  return kvGet(jobId);
}

// ---------------------------------------------------------------------------
// Stage runner: strict pass/fail + retry-then-abort
// ---------------------------------------------------------------------------
//
// Every pipeline stage is a pair of functions:
//   runFn(ctx, { attempt, priorFailures }) → rawResult
//   verifyFn(rawResult, ctx)               → { ok: true, ...extra } | { ok: false, reason: '...', retryable: bool }
//
// The runner loops up to maxAttempts:
//   1. run → result (may throw; treated as run-failure)
//   2. verify(result) → verdict
//   3. If ok, merge any { ...extra } onto ctx via contextKeys mapping and return result
//   4. If !ok and retryable !== false, wait briefly and retry
//   5. If exhausted, throw with structured reason
//
// Callers never accept soft success. A stage is either verified-good after ≤N
// attempts, or the pipeline aborts here. No "we tried, moving on."
async function runStageWithVerify(ctx, name, runFn, verifyFn, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  const retryDelayMs = opts.retryDelayMs ?? 3000;
  const s = startStage(name);
  const failures = [];
  // Per-attempt audit trail — persisted to stages.<name>.data.attempts so
  // WISER UI (or any KV-reading tool) can render "attempt 1 failed with X,
  // attempt 2 with Y, attempt 3 auto-repaired Z, passed on attempt 3" from
  // the playbook alone, without needing the local events.ndjson.
  const attemptAudit = [];

  function auditEntry(attempt, outcome, extra) {
    return {
      n: attempt,
      at: new Date().toISOString(),
      outcome,  // 'passed' | 'failed' | 'threw'
      ...extra,
    };
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let result, verdict;
    try {
      result = await runFn(ctx, { attempt, priorFailures: [...failures] });
    } catch (err) {
      const reason = `run threw: ${err.message}`;
      ctx.log(`  [${name}] attempt ${attempt}/${maxAttempts} THREW: ${err.message}`);
      failures.push({ attempt, phase: 'run', reason, error: err.message });
      attemptAudit.push(auditEntry(attempt, 'threw', { phase: 'run', error: err.message }));
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, retryDelayMs)); continue; }
      break;
    }

    try {
      verdict = await verifyFn(result, ctx);
    } catch (err) {
      const reason = `verify threw: ${err.message}`;
      ctx.log(`  [${name}] attempt ${attempt}/${maxAttempts} VERIFY THREW: ${err.message}`);
      failures.push({ attempt, phase: 'verify', reason, error: err.message, result });
      attemptAudit.push(auditEntry(attempt, 'threw', { phase: 'verify', error: err.message }));
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, retryDelayMs)); continue; }
      break;
    }

    if (verdict && verdict.ok) {
      ctx.log(`  [${name}] PASS on attempt ${attempt}/${maxAttempts}`);
      attemptAudit.push(auditEntry(attempt, 'passed', {
        source: result?.source,
        codeLength: result?.codeLength,
        autoRepaired: verdict?.autoRepaired || null,
      }));
      // Merge verify-extra + result into ctx per the stage's contextKeys (if any).
      if (opts.onPass) opts.onPass(result, verdict, ctx);
      return endStage(s, { ...result, ...verdict, attempt, attempts: attemptAudit });
    }

    const reason = verdict?.reason || 'verify returned !ok with no reason';
    ctx.log(`  [${name}] attempt ${attempt}/${maxAttempts} VERIFY FAIL: ${reason}`);
    // Store the full verdict so the next attempt's run() can reach structured
    // fields like verdict.validatorDiagnostics. Without this, retry code
    // could only see the `reason` string and had no way to pipe structured
    // diagnostics back to the flow.
    failures.push({ attempt, phase: 'verify', reason, result, verdict });
    attemptAudit.push(auditEntry(attempt, 'failed', {
      reason: reason.slice(0, 300),
      blockers: Array.isArray(verdict?.validatorDiagnostics)
        ? verdict.validatorDiagnostics.map(d => ({ code: d.code, message: String(d.message || '').slice(0, 200) }))
        : [],
      autoRepaired: verdict?.autoRepaired || null,  // if verify() attempted auto-repair
      source: result?.source,
      codeLength: result?.codeLength,
    }));
    if (verdict?.retryable === false) {
      ctx.log(`  [${name}] marked non-retryable — aborting stage`);
      break;
    }
    if (attempt < maxAttempts) await new Promise(r => setTimeout(r, retryDelayMs));
  }

  const err = new Error(`[${name}] FAILED after ${failures.length} attempt(s). Last reason: ${failures[failures.length - 1]?.reason || 'unknown'}`);
  err.stage = name;
  err.failures = failures;
  err.attempts = attemptAudit;  // so the error handler upstream can persist it
  throw err;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Options for callAsyncFlow from pipeline ctx (monitor + extra log flow IDs). */
function asyncFlowOpts(ctx) {
  const o = ctx.opts || {};
  const extra = Array.isArray(o.monitorLogFlowIds) ? o.monitorLogFlowIds : [];
  const envFlows = (process.env.STEP_PIPELINE_MONITOR_LOG_FLOWS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const ids = [...new Set([...extra, ...envFlows, ctx.flowId].filter(Boolean))];
  // When the pipeline is emitting events (dashboard mode), force monitor on so
  // logs get fetched every tick — that's where mid-flight progress actually is.
  const dashboardOn = !!ctx.jobId && process.env.STEP_PIPELINE_DASHBOARD !== '0';
  return {
    log: ctx.log,
    monitor:
      o.monitor === true ||
      dashboardOn ||
      process.env.STEP_PIPELINE_MONITOR === '1' ||
      process.env.STEP_PIPELINE_MONITOR === 'true',
    monitorLogFlowIds: ids,
    monitorLogEvery: o.monitorLogEvery,
    pipelineJobId: ctx.jobId,
    currentStage: ctx.currentStage || null,
    onPollTick: o.onPollTick,
    kvEvery: parseInt(process.env.STEP_PIPELINE_KV_EVERY, 10) || 1,
  };
}

async function callAsyncFlow(endpointKey, body, opts = {}) {
  const ep = ENDPOINTS[endpointKey];
  if (!ep) throw new Error(`Unknown endpoint: ${endpointKey}`);
  const url = `${BASE_URL}/${ep.path}`;
  const maxPolls = opts.maxPolls || ep.maxPolls;
  const pollDelay = opts.pollDelay || ep.pollDelay;
  const log = opts.log || console.log;
  const monitor = opts.monitor === true || process.env.STEP_PIPELINE_MONITOR === '1'
    || process.env.STEP_PIPELINE_MONITOR === 'true';
  /** @type {string[]} Extra flow IDs to pull logs for while polling (always includes ENDPOINTS flowId). */
  const monitorLogFlowIds = Array.isArray(opts.monitorLogFlowIds) ? opts.monitorLogFlowIds : [];
  const monitorLogEvery = Math.max(1, parseInt(opts.monitorLogEvery, 10) || parseInt(process.env.STEP_PIPELINE_MONITOR_LOG_EVERY, 10) || 1);
  const kvEvery = Math.max(1, parseInt(opts.kvEvery, 10) || 1);
  const pipelineJobId = opts.pipelineJobId || null;
  const currentStage = opts.currentStage || endpointKey;
  let flowPollMonitor = null;
  if (monitor) {
    try {
      flowPollMonitor = require('./flowPollMonitor');
    } catch (_) {}
  }

  log(`  POST /${ep.path}`);
  appendEvent(pipelineJobId, {
    type: 'remote-post',
    stage: currentStage,
    endpoint: endpointKey,
    path: ep.path,
    flowId: ep.flowId,
  });
  let postResp;
  try {
    postResp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    appendEvent(pipelineJobId, {
      type: 'remote-error', stage: currentStage, endpoint: endpointKey,
      error: `network: ${err.message}`,
    });
    throw new Error(`Network error calling ${endpointKey} (/${ep.path}): ${err.message}`);
  }

  if (!postResp.ok && postResp.status >= 500) {
    const text = await postResp.text().catch(() => '');
    throw new Error(`${endpointKey} returned HTTP ${postResp.status} — flow may be inactive. Activate it in Edison Studio then retry. Response: ${text.slice(0, 200)}`);
  }

  let postBody;
  const contentType = postResp.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    postBody = await postResp.json();
  } else {
    const text = await postResp.text();
    if (text.includes('no handler') || text.includes('Cannot') || text.includes('Not Found')) {
      throw new Error(`${endpointKey} endpoint not responding (/${ep.path}) — flow is likely inactive. Activate in Edison Studio: ${STUDIO_BASE}/${ep.flowId}\nResponse: ${text.slice(0, 200)}`);
    }
    try { postBody = JSON.parse(text); } catch {
      throw new Error(`${endpointKey} returned non-JSON: ${text.slice(0, 200)}`);
    }
  }

  if (postBody.error === 'no handler' || postBody.error === 'Not Found') {
    throw new Error(`${endpointKey} (/${ep.path}) has no handler — flow is inactive. Activate it in Edison Studio then retry.`);
  }

  const jobId = postBody.jobId;
  if (!jobId) {
    if (postBody.flowId || postBody.templateId || postBody.result) {
      log('  (Received sync response — no polling needed)');
      return postBody;
    }
    throw new Error(`No jobId from ${endpointKey}: ${JSON.stringify(postBody).slice(0, 300)}`);
  }
  log(`  jobId: ${jobId}`);

  if (ep.initialWait) {
    log(`  Waiting ${(ep.initialWait / 1000).toFixed(0)}s before polling...`);
    await new Promise(r => setTimeout(r, ep.initialWait));
  }

  const encodedJob = encodeURIComponent(jobId);
  // Some flows (Generate Step Code) use request.body.playbookID as the KV
  // collection name for job storage — the poll GET needs it too, else the
  // Get Value from Storage step throws "Invalid collection name: cannot be
  // undefined, empty or an object". Pass it through as a query param so the
  // flow's merge-field binding `request.body.playbookID` still resolves.
  const pbParam = body && body.playbookID
    ? `&playbookID=${encodeURIComponent(body.playbookID)}`
    : '';
  const pollUrl = `${url}?jobId=${encodedJob}&jobID=${encodedJob}${pbParam}`;
  const pendingStatuses = new Set([
    'pending',
    'started',
    'job started',
    'started use get and this job id to check status',
    // "no job found with that jobID" means KV lookup during the poll didn't
    // find an entry yet — the async flow is still running and hasn't written
    // the result to KV. Transient, NOT terminal. Treat it as pending so we
    // keep polling until the job actually completes. (Observed 2026-04-22
    // on design-step: flow takes ~30-60s for the Anthropic call + save,
    // but pipeline's first poll fires at 5s.)
    'no job found with that jobid',
  ]);
  const inProgressPrefixes = [
    'loading', 'generating', 'configuring', 'evaluating',
    'saving', 'analyzing', 'enhancing', 'wiring', 'building',
    'activating', 'deploying', 'validating',
  ];

  for (let i = 0; i < maxPolls; i++) {
    await new Promise(r => setTimeout(r, pollDelay));
    let getResp;
    try {
      getResp = await fetch(pollUrl);
    } catch (err) {
      log(`    Poll error: ${err.message}`);
      continue;
    }
    const getBody = await getResp.json().catch(() => ({}));

    if (getBody.error === 'no handler') {
      throw new Error(`${endpointKey} (/${ep.path}) went offline during polling — flow deactivated?`);
    }

    const rawStatus = getBody.status || getBody.result?.status || getBody.value?.status || 'unknown';
    const status = typeof rawStatus === 'string' ? rawStatus.toLowerCase() : rawStatus;
    const elapsedSec = ((i + 1) * pollDelay / 1000).toFixed(0);

    // Collect the three live signals for the dashboard: job body, flow logs, KV snapshot.
    // Log text is only fetched every Nth tick (chatty); KV every Nth tick too (cheap but not free).
    let logsSummary = null;
    let logsText = null;
    if (monitor) {
      log('');
      if (flowPollMonitor) {
        log(flowPollMonitor.summarizeJobResponse(`${endpointKey}/${ep.path}`, i + 1, elapsedSec, getBody));
        if ((i + 1) % monitorLogEvery === 0 && ep.flowId) {
          const ids = [...new Set([ep.flowId, ...monitorLogFlowIds].filter(Boolean))];
          for (const fid of ids) {
            try {
              const lr = await flowPollMonitor.fetchFlowLogsWithPoll(fid, { maxPolls: 12, pollDelay: 2000 });
              log(flowPollMonitor.summarizeLogFetch(fid.slice(0, 8), lr));
              if (fid === ep.flowId && lr && lr.ok) {
                logsText = String(lr.text || '').slice(-4000);
                logsSummary = flowPollMonitor.scanLogText(logsText);
              }
            } catch (e) {
              log(`[logs:${fid.slice(0, 8)}] Skipped: ${e.message}`);
            }
          }
        }
      } else {
        log(`[${endpointKey}] Poll ${i + 1}/${maxPolls} (~${elapsedSec}s): status=${status}`);
      }
    }

    // KV snapshot — read the remote collection keyed by the Edison job id.
    // Convention: the remote flow's collection name matches its HTTP path
    // (e.g. step-code-pipeline, conceive-step). If the flow doesn't KV-log,
    // this returns null silently.
    let kvSnapshot = null;
    if (pipelineJobId && (i + 1) % kvEvery === 0) {
      try {
        kvSnapshot = await kvGet(jobId, ep.path);
      } catch (_) {}
    }

    // Emit a per-tick event to the dashboard feed.
    appendEvent(pipelineJobId, {
      type: 'poll-tick',
      stage: currentStage,
      endpoint: endpointKey,
      path: ep.path,
      flowId: ep.flowId,
      attempt: i + 1,
      maxPolls,
      elapsedSec: Number(elapsedSec),
      remoteJobId: jobId,
      status,
      body: getBody,
      kv: kvSnapshot,
      logs: logsText ? { text: logsText, flags: logsSummary ? logsSummary.hits : [] } : null,
    });
    if (typeof opts.onPollTick === 'function') {
      try {
        opts.onPollTick({
          endpoint: endpointKey, attempt: i + 1, elapsedSec, status,
          remoteJobId: jobId, body: getBody, kv: kvSnapshot, logs: logsText,
        });
      } catch (_) {}
    }

    if (status === 'error' || status === 'failed') {
      const errMsg = getBody.result?.error || getBody.error || getBody.message || 'unknown error';
      appendEvent(pipelineJobId, {
        type: 'remote-error', stage: currentStage, endpoint: endpointKey,
        remoteJobId: jobId, error: errMsg,
      });
      throw new Error(`${endpointKey} job failed: ${errMsg}`);
    }

    if (pendingStatuses.has(status)) {
      if (!monitor) {
        process.stdout.write(`    Poll ${i + 1}/${maxPolls} (${elapsedSec}s): ${status}    \r`);
      }
      continue;
    }

    const isInProgress = inProgressPrefixes.some(p => status.startsWith && status.startsWith(p))
      || (status === 'completed' && !getBody.result);
    if (isInProgress) {
      if (!monitor) {
        process.stdout.write(`    Poll ${i + 1}/${maxPolls} (${elapsedSec}s): ${status}    \r`);
      }
      continue;
    }

    if (!monitor) process.stdout.write('\n');
    appendEvent(pipelineJobId, {
      type: 'remote-completed',
      stage: currentStage,
      endpoint: endpointKey,
      remoteJobId: jobId,
      status,
    });
    return getBody;
  }

  appendEvent(pipelineJobId, {
    type: 'remote-timeout',
    stage: currentStage,
    endpoint: endpointKey,
    remoteJobId: jobId,
    maxPolls,
  });
  throw new Error(`Polling timed out for ${endpointKey} after ${maxPolls} polls (${(maxPolls * pollDelay / 1000).toFixed(0)}s)`);
}

async function checkEndpointAlive(endpointKey, log) {
  const ep = ENDPOINTS[endpointKey];
  if (!ep) return true;
  try {
    const resp = await fetch(`${BASE_URL}/${ep.path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const body = await resp.text();
    if (body.includes('no handler')) {
      log(`  WARNING: ${endpointKey} (/${ep.path}) is INACTIVE`);
      log(`  Activate: ${STUDIO_BASE}/${ep.flowId}`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Derive a flow label from a playbook, mirroring what Conceive Step does.
//
// Why duplicated here: we need to check for an existing flow with the
// SAME label BEFORE calling conceive, so we can pass flowId=existing and
// avoid a second flow being spawned at the same gateway path. Conceive
// itself derives the label inside its own runtime, which is too late.
//
// Logic: first look for a canonical "name:" field inside the machine-generated
// `## Pipeline Spec` section (this is what conceive writes when it re-parses);
// otherwise fall back to the first markdown H1 heading. This matches
// conceive's priority order (playbook spec block > explicit label > H1).
//
// Returns a trimmed label string, or null if nothing usable found.
// ---------------------------------------------------------------------------

function _deriveFlowLabelFromPlaybook(markdown) {
  if (!markdown || typeof markdown !== 'string') return null;

  // Look for `label:` in the Pipeline Spec section first (the canonical
  // source when a prior conceive run has enriched the playbook).
  const specSection = markdown.match(/##\s*Pipeline Spec[\s\S]*?(?=\n##\s|$)/i);
  if (specSection) {
    const m = specSection[0].match(/^\s*label:\s*['"]?([^'"\n]+)['"]?\s*$/m);
    if (m && m[1].trim()) return m[1].trim();
  }

  // Fall back to the first H1.
  const h1 = markdown.match(/^#\s+(.+)$/m);
  if (h1 && h1[1].trim()) return h1[1].trim();

  return null;
}

// ---------------------------------------------------------------------------
// Runtime activation — force Lambda redeploy after splice.
//
// Why: /splice-step with { activate: true } saves the template and flips the
// stored-flow isActive bit, but does NOT trigger the upsertLayer/upsertLambda
// cycle that actually redeploys the runtime. Without this extra step the new
// flow's HTTP gateway path keeps returning 404 "no handler" until a cold
// start or manual activation.
//
// See known-issues.js:SPLICE_WITHOUT_RUNTIME_ACTIVATION. lib/safe-splice.js
// handles this for its own callers; this helper brings the pipeline's splice
// stages (stageValidate / stageTestWithUI) to parity so the flow is live the
// moment a splice stage completes.
//
// Returns { ok, elapsedSec, error? } — never throws (activation is a
// post-splice hardening step; failures log loudly but don't fail the stage).
// ---------------------------------------------------------------------------

async function activateFlowRuntime(flowId, { log = console.log, maxRetries = 3, retryBackoffMs = 8000 } = {}) {
  const start = Date.now();
  const dh = require('./deployHelper');
  const token = await dh.getToken();
  const api = dh.initFlowsApi(token);
  const flow = await api.getFlow(flowId);

  // Retry on transient Lambda-layer filesystem errors. The Edison activation
  // flow sometimes hits ENOTEMPTY when cleaning /tmp/.../.npm/_cacache — the
  // directory is still populated from the prior Lambda container. These
  // errors clear on subsequent attempts as the container's GC catches up.
  // See known-issues: PIPELINE_ACTIVATE_LAMBDA_ENOTEMPTY_RETRY.
  const RETRYABLE_PATTERNS = [
    /ENOTEMPTY/i,
    /EACCES/i,
    /EBUSY/i,
    /Unexpected token ':'/i,   // stale /tmp file being read while mid-write
  ];

  let lastErr = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      log(`  [runtime-activate] deployer.activateFlow flow=${flowId.slice(0, 8)} v=${String(flow.version || '').slice(0, 8)}${attempt > 1 ? ` (attempt ${attempt}/${maxRetries})` : ''}...`);
      await api.deployer.activateFlow(flow);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      log(`  [runtime-activate] OK in ${elapsed}s — runtime now serving the new template`);
      return { ok: true, elapsedSec: Number(elapsed), attempts: attempt };
    } catch (err) {
      lastErr = err;
      const msg = err?.message || err?.errorMessage || JSON.stringify(err || {}).slice(0, 200);
      const retryable = RETRYABLE_PATTERNS.some(re => re.test(msg));
      if (retryable && attempt < maxRetries) {
        const backoffSec = (retryBackoffMs * attempt / 1000).toFixed(1);
        log(`  [runtime-activate] attempt ${attempt}/${maxRetries} hit transient Lambda error: ${msg.slice(0, 120)}`);
        log(`  [runtime-activate] retrying in ${backoffSec}s...`);
        await new Promise((r) => setTimeout(r, retryBackoffMs * attempt));
        continue;
      }
      // Not retryable OR out of attempts — fall through to legacy error handling
      break;
    }
  }

  // All retries exhausted (or first attempt non-retryable)
  const err = lastErr;
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  // The deployer sometimes throws plain objects (e.g. Lambda REJECTED_TRIGGERS
  // comes back as { errorMessage, errorType, errorData }) rather than Error
  // instances, so err.message is undefined. Extract the most informative
  // field available, and surface trigger-rejection details specifically
  // since that's the common "two flows share a gateway path" failure mode.
  const msg = err?.message
    || err?.errorMessage
    || err?.errorType
    || (typeof err === 'string' ? err : null)
    || JSON.stringify(err || {}).slice(0, 300)
    || 'unknown';
  log(`  [runtime-activate] FAILED in ${elapsed}s: ${msg}`);
  if (err?.errorType === 'REJECTED_TRIGGERS' && Array.isArray(err?.errorData)) {
    for (const rej of err.errorData) {
      const other = rej?.rejectReason?.flowId || '(unknown flow)';
      const trigger = rej?.params?.name || '(unknown trigger)';
      log(`  [runtime-activate]   trigger "${trigger}" already owned by flow ${String(other).slice(0, 8)}`);
    }
    log(`  [runtime-activate] Path collision: another flow owns this gateway path. Delete the old flow or rename this one's HTTP path, then re-activate.`);
  }
  log(`  [runtime-activate] Flow is saved + flagged active but runtime may still serve the old template until next cold start.`);
  return { ok: false, elapsedSec: Number(elapsed), error: msg, errorType: err?.errorType, raw: err };
}

// ---------------------------------------------------------------------------
// Playbook → full spec for code generation
// ---------------------------------------------------------------------------

function buildSpecFromPlaybook(markdown, objective) {
  const text = String(markdown || '');
  const sections = {};
  let currentKey = null;
  for (const line of text.split('\n')) {
    const h2 = line.match(/^##\s+(\d+)\.\s+(.+)/);
    if (h2) { currentKey = h2[1]; sections[currentKey] = []; continue; }
    if (currentKey) sections[currentKey].push(line);
  }
  const sec = (n) => (sections[n] || []).join('\n');

  const obj = objective || {};

  const behaviorSec = sec('3');
  const whatMatch = behaviorSec.match(/###\s+What does this step do\?\s*\n([\s\S]*?)(?=###|$)/);
  const logicMatch = behaviorSec.match(/###\s+Logic summary\s*\n([\s\S]*?)(?=###|$)/);
  const errorMatch = behaviorSec.match(/###\s+Error handling\s*\n([\s\S]*?)(?=###|$)/);

  const behavior = whatMatch ? whatMatch[1].trim() : (obj.behavior || '');
  const logicSummary = logicMatch ? logicMatch[1].trim() : '';
  const errorHandling = errorMatch ? errorMatch[1].trim() : '';

  const codeNotesSec = sec('11');
  const libMatch = codeNotesSec.match(/###\s+Libraries\s*\/?\s*APIs?\s*\n([\s\S]*?)(?=###|$)/);
  const followMatch = codeNotesSec.match(/###\s+Patterns to follow\s*\n([\s\S]*?)(?=###|$)/);
  const avoidMatch = codeNotesSec.match(/###\s+Patterns to avoid\s*\n([\s\S]*?)(?=###|$)/);
  const codeNotes = [
    libMatch ? libMatch[1].trim() : '',
    followMatch ? followMatch[1].trim() : '',
    avoidMatch ? avoidMatch[1].trim() : '',
  ].filter(Boolean).join('\n\n');

  const fullDescription = [
    obj.description || '',
    behavior ? `\n\nBehavior: ${behavior}` : '',
    logicSummary ? `\n\nLogic summary:\n${logicSummary}` : '',
    errorHandling ? `\n\nError handling:\n${errorHandling}` : '',
    codeNotes ? `\n\nCode notes:\n${codeNotes}` : '',
  ].join('');

  const inputsSec = sec('5');
  const inputs = [];
  const inputBlocks = inputsSec.split(/###\s+(?:Input:|Select input|Switch input)/i).slice(1);
  for (const ib of inputBlocks) {
    if (/example/i.test(ib.split('\n')[0])) continue;
    const input = {};
    const rows = ib.split('\n').filter(l => l.trim().startsWith('|') && !l.trim().startsWith('|--'));
    if (rows.length < 2) continue;
    const hdr = rows[0].split('|').map(c => c.trim()).filter(Boolean);
    for (const r of rows.slice(1)) {
      const cells = r.split('|').map(c => c.trim()).filter(Boolean);
      const field = (cells[0] || '').replace(/\*+/g, '').trim().toLowerCase();
      const value = (cells[1] || '').replace(/^`+|`+$/g, '').replace(/^"+|"+$/g, '').trim();
      if (field === 'variable') input.variable = value;
      else if (field === 'label') input.label = value;
      else if (field === 'type') input.type = value;
      else if (field === 'required') input.required = value === 'true';
      else if (field === 'default') input.default = value;
      else if (field === 'helptext') input.helpText = value;
      else if (field === 'rendercondition') input.renderCondition = value;
    }
    if (input.variable) inputs.push(input);
  }

  let exits;
  if (Array.isArray(obj.exits) && obj.exits.length > 0) {
    exits = obj.exits.map(e => ({
      id: e.id,
      label: e.label || (e.id === '__error__' ? 'on error' : e.id === '__timeout__' ? 'on timeout' : e.id),
      condition: e.condition || (e.id === '__error__' ? 'processError' : e.id === '__timeout__' ? 'processTimeout' : ''),
    }));
  } else {
    exits = (obj.exitIds || ['next', '__error__']).map(id => ({
      id,
      label: id === '__error__' ? 'on error' : id === '__timeout__' ? 'on timeout' : id,
      condition: id === '__error__' ? 'processError' : id === '__timeout__' ? 'processTimeout' : '',
    }));
  }

  return {
    name: obj.name || 'step',
    label: obj.label || 'Step',
    description: fullDescription,
    kind: obj.kind || 'logic',
    inputs,
    exits,
    dataOut: obj.dataOutName ? { name: obj.dataOutName, type: 'session', ttl: 86400000 } : undefined,
    outputExample: obj.outputExample || {},
    behavior,
    logicSummary,
    errorHandling,
    codeNotes,
  };
}

function startStage(name) {
  return { name, startMs: Date.now() };
}

function endStage(info, data) {
  info.durationMs = Date.now() - info.startMs;
  info.data = data;
  return info;
}

// ---------------------------------------------------------------------------
// Stage implementations
// ---------------------------------------------------------------------------

async function stagePlaybook(ctx) {
  const s = startStage('playbook');
  const { playbookPath } = ctx.opts;

  // Resolution order:
  //   1. --playbook <file>                    → read from local markdown file
  //   2. playbookHandle's KV entry source.md  → WISER/resume path: re-use the
  //                                             markdown already stored in KV
  //                                             (see ensurePlaybook — it keeps
  //                                             source.markdown across re-runs)
  //   3. otherwise                            → error
  let markdown = null;
  let source = null;

  if (playbookPath) {
    if (!fs.existsSync(playbookPath)) throw new Error(`Playbook not found: ${playbookPath}`);
    markdown = fs.readFileSync(playbookPath, 'utf8');
    source = `local file ${playbookPath}`;
  } else if (ctx.playbookHandle) {
    // Pull from KV — the orchestrator's ensurePlaybook already seeded/preserved
    // source.markdown. This is the path a WISER-triggered run takes when the
    // playbook lives in KV rather than a file on disk.
    const playbookStore = require('./playbookStore');
    const entry = await playbookStore.getPlaybook(
      ctx.playbookHandle.id,
      ctx.playbookHandle.collection,
      ctx.playbookHandle.key,
    );
    if (!entry) throw new Error(`Playbook KV entry not found: ${ctx.playbookHandle.collection}/${ctx.playbookHandle.id}`);
    markdown = entry.source?.markdown || '';
    if (!markdown) throw new Error(`Playbook KV entry has no source.markdown — pass --playbook <file> to seed it`);
    source = `KV ${ctx.playbookHandle.collection}/${ctx.playbookHandle.id}`;
  } else {
    throw new Error('--playbook <file> or --playbook-id <id> is required');
  }

  if (!markdown.includes('##')) {
    throw new Error('Playbook must contain at least one ## section heading');
  }

  const sectionNumbers = [];
  for (const line of markdown.split('\n')) {
    const m = line.match(/^##\s+(\d+)\.\s+/);
    if (m) sectionNumbers.push(m[1]);
  }

  ctx.playbook = markdown;
  ctx.log(`  Loaded from ${source} (${markdown.length} chars, sections: ${sectionNumbers.join(', ')})`);

  return endStage(s, {
    source, chars: markdown.length, sections: sectionNumbers,
    path: playbookPath || null,
  });
}

async function stageDecompose(ctx) {
  const s = startStage('decompose');

  const {
    evaluateStepPlan,
    runStepPlanIteration,
    extractObjective,
    enrichPlaybookToTacticalSpec,
  } = require('./stepPlanIteration');

  const focus = ctx.opts.focus || undefined;
  const maxIterations = ctx.opts.maxIterations || 6;

  // ── LLM enrichment pre-pass ─────────────────────────────────────
  // Translates strategic playbooks (WISER-format briefs) into tactical
  // step-plan markdown the judges can iterate on. Pass-through for
  // already-tactical input. Result lands in stages.decompose.data so
  // the WISER Playbooks UI can show "here's what we extracted from
  // your playbook" side-by-side with the original strategic brief.
  //
  // Requires ANTHROPIC_KEY / ANTHROPIC_API_KEY env var OR --api-key CLI flag.
  // If absent, enrichment gracefully degrades to pass-through — downstream
  // Conceive has its own LLM extractor that will pick up the slack (using
  // Edison's in-flow auth-external-component which reads the Anthropic KV).
  const { getApiKey } = require('./llmClient');
  const apiKey = ctx.opts.apiKey || getApiKey() || process.env.ANTHROPIC_API_KEY;
  ctx.log('  Pre-pass: enriching playbook (strategic → tactical)...');
  const enrichment = await enrichPlaybookToTacticalSpec(ctx.playbook, {
    apiKey,
    log: (m) => ctx.log(`    [enrich] ${m}`),
  });
  ctx.log(`  Enrichment kind=${enrichment.kind}, confidence=${enrichment.confidence?.toFixed(2) || 'n/a'}, gaps=${enrichment.gaps?.length || 0}`);
  if (enrichment.extracted) {
    ctx.log(`  Extracted: name="${enrichment.extracted.name}" label="${enrichment.extracted.label}" inputs=${enrichment.extracted.inputs?.length || 0} exits=${enrichment.extracted.exits?.length || 0} scenarios=${enrichment.extracted.testScenarios?.length || 0}`);
  }
  if (enrichment.gaps?.length > 0) {
    for (const g of enrichment.gaps.slice(0, 5)) ctx.log(`    gap: ${g}`);
  }

  // Use the enriched step-plan markdown as the iteration starting point.
  // For tactical input this is identical to ctx.playbook.
  const planToIterate = enrichment.stepPlan || ctx.playbook;

  ctx.log('  Running 6-judge evaluation...');
  const iterResult = await runStepPlanIteration(planToIterate, { focus, maxIterations });

  ctx.bestPlan = iterResult.bestPlan;
  ctx.objective = extractObjective(iterResult.bestPlan);
  ctx.planEvaluation = iterResult;
  // Stash extracted spec for downstream stages (conceive/generateCode can
  // skip re-extraction if extracted is present + confidence is decent).
  if (enrichment.extracted) ctx.extractedSpec = enrichment.extracted;

  ctx.log(`  Initial: ${iterResult.initialEvaluation.summary.weightedMean} → Best: ${iterResult.bestEvaluation.summary.weightedMean}`);
  ctx.log(`  Iterations: ${iterResult.iterations.length}, Completed: ${iterResult.completed}`);
  ctx.log(`  Objective: ${ctx.objective.name} — ${ctx.objective.label}`);
  ctx.log(`  Exits: ${ctx.objective.exitIds.join(', ')}`);
  ctx.log(`  Test scenarios: ${ctx.objective.scenarios.length}`);

  for (const j of iterResult.bestEvaluation.judges) {
    ctx.log(`    ${j.id.padEnd(16)} ${j.score.toFixed(2)}/10 (${j.findings.length} findings)`);
  }

  return endStage(s, {
    // enrichment summary
    enrichmentKind: enrichment.kind,
    enrichmentConfidence: enrichment.confidence,
    enrichmentGaps: enrichment.gaps || [],
    extractedName: enrichment.extracted?.name || null,
    extractedLabel: enrichment.extracted?.label || null,
    extractedInputCount: enrichment.extracted?.inputs?.length || 0,
    extractedExitCount: enrichment.extracted?.exits?.length || 0,
    extractedScenarioCount: enrichment.extracted?.testScenarios?.length || 0,
    // iteration results
    initialScore: iterResult.initialEvaluation.summary.weightedMean,
    bestScore: iterResult.bestEvaluation.summary.weightedMean,
    iterations: iterResult.iterations.length,
    completed: iterResult.completed,
    objectiveName: ctx.objective.name,
    scenarioCount: ctx.objective.scenarios.length,
    // full derived artifacts — written to KV so WISER UI can render them
    extracted: enrichment.extracted,
    stepPlan: iterResult.bestPlan,
  });
}

/** Natural-language intent for POST /flow-template-discovery (OpenAPI `intent` field). */
function buildTemplateDiscoveryIntent(objective) {
  if (!objective || typeof objective !== 'object') {
    return 'Find reusable step templates for a general automation task.';
  }
  const lines = [];
  if (objective.name) lines.push(`Step name: ${objective.name}`);
  if (objective.label) lines.push(`Label: ${objective.label}`);
  if (objective.kind) lines.push(`Kind: ${objective.kind}`);
  if (objective.description) lines.push(`Description: ${objective.description}`);
  if (objective.behavior) lines.push(`Expected behavior: ${objective.behavior}`);
  return lines.length
    ? lines.join('\n')
    : 'Find reusable step templates for a general automation task.';
}

async function stageTemplateFinder(ctx) {
  const s = startStage('templateFinder');
  const alive = await checkEndpointAlive('templateFinder', ctx.log);
  if (!alive) {
    ctx.log('  Skipping Template Finder — flow is inactive');
    ctx.templateMatches = [];
    return endStage(s, { matchCount: 0, skipped: true, reason: 'flow inactive' });
  }
  ctx.log('  Searching for matching templates...');

  const finderBody = { intent: buildTemplateDiscoveryIntent(ctx.objective) };
  const llm = process.env.STEP_PIPELINE_TEMPLATE_DISCOVERY_LLM;
  if (llm) finderBody.llmModel = llm;

  const result = await callAsyncFlow('templateFinder', finderBody, asyncFlowOpts(ctx));

  const raw = result.result ?? result;
  const matches = Array.isArray(raw?.matches) && raw.matches.length
    ? raw.matches
    : Array.isArray(raw?.steps) && raw.steps.length
      ? raw.steps
      : [];
  ctx.templateMatches = matches;
  ctx.log(`  Found ${matches.length} template match(es)`);
  for (const m of matches.slice(0, 5)) {
    ctx.log(`    ${m.label || m.name || m.id} (${m.confidence || 'unknown'})`);
  }

  return endStage(s, { matchCount: matches.length, matches: matches.slice(0, 5) });
}

// Conceive (inception) — create a flow, verify every check passes, then done.
//   run:    POST /conceive-step → flowId + templateId
//   verify: EVERY check below must pass before reporting done:
//           - flowId returned
//           - api.getFlow(flowId) succeeds (flow exists on Edison)
//           - templateId returned and present in the flow's stepTemplates
//           - flow has a Wait-for-HTTP gateway step
//           - gateway has a non-empty HTTP path
//           - flow has a placeholder step (something splice can replace)
//   retry:  3× then abort. Pipeline never writes "conceive complete" to KV
//           unless every check above passed.
async function stageConceive(ctx) {
  const alive = await checkEndpointAlive('conceive', ctx.log);
  if (!alive) {
    throw new Error('Conceive flow is inactive — cannot create step. Activate it first.');
  }

  const PLACEHOLDER_LABEL_RE = /^(Your Step Here|Add Your .* Step Here|Template Step|Blank Step|Placeholder)$/i;

  // Collision-avoidance: look for an existing flow in the target bot whose
  // label matches what conceive would derive from this playbook. If found,
  // we pass its flowId so conceive updates in place rather than creating a
  // duplicate flow that would then fight the existing one for the HTTP
  // gateway path (Lambda rejects the second activate with REJECTED_TRIGGERS).
  //
  // Only runs when the caller hasn't already pinned a flowId. Match is by
  // exact label equality — the same criterion splice uses elsewhere. If zero
  // or multiple matches, we don't guess: conceive makes a new flow, and any
  // later collision surfaces through activateFlowRuntime's logging.
  let reuseFlowId = null;
  if (!ctx.opts.flowId) {
    try {
      const botId = ctx.opts.botId || BOT_ID;
      const expectedLabel = _deriveFlowLabelFromPlaybook(ctx.bestPlan);
      if (expectedLabel) {
        const dh = require('./deployHelper');
        const token = await dh.getToken();
        const api = dh.initFlowsApi(token);
        const listed = await api.listFlows({ botId, limit: 500 });
        const items = (listed.items || listed).filter(f => (f.botId || '') === botId);
        const matches = items.filter(f => (f.data?.label || '').trim() === expectedLabel.trim());
        if (matches.length === 1) {
          reuseFlowId = matches[0].id;
          ctx.log(`  Found existing flow with matching label "${expectedLabel}" → reusing ${reuseFlowId.slice(0, 8)} (avoids gateway-path collision)`);
        } else if (matches.length > 1) {
          ctx.log(`  WARNING: ${matches.length} flows share label "${expectedLabel}" — cannot auto-pick, letting conceive create a new one`);
          ctx.log(`    existing: ${matches.map(f => f.id.slice(0, 8)).join(', ')}`);
        }
      }
    } catch (e) {
      ctx.log(`  [collision-check] skipped: ${e.message}`);
    }
  }

  async function run(ctx, { attempt }) {
    ctx.log(`  Creating flow (attempt ${attempt}, playbookID=${ctx.playbookID})...`);
    const body = {
      playbook: ctx.bestPlan,
      botId: ctx.opts.botId || BOT_ID,
      // Playbook KV state machine — Conceive v1.7.0+ reads its prior-run
      // state from KV on entry and writes stages.conceive back on exit.
      // playbookCollection/playbookKey let the orchestrator override the
      // KV location; defaults to 'playbooks' collection keyed by playbookID.
      playbookID: ctx.playbookID,
      playbookCollection: ctx.playbookHandle?.collection || 'playbooks',
      playbookKey: ctx.playbookHandle?.key || ctx.playbookID,
    };
    // Forward the caller's Anthropic credential when available. Conceive's
    // `_resolveApiKey` treats body.apiKey as priority-1, falling back to the
    // auth-external-component on the step. Passing it from env keeps the
    // pipeline working regardless of whether the step's collection is
    // populated in this account. Never logged.
    const envKey = ctx.opts.apiKey || process.env.ANTHROPIC_API_KEY;
    if (envKey) body.apiKey = envKey;
    if (ctx.opts.flowId) body.flowId = ctx.opts.flowId;
    else if (reuseFlowId) body.flowId = reuseFlowId;
    if (ctx.templateMatches?.length > 0) body.templateMatch = ctx.templateMatches[0];
    const result = await callAsyncFlow('conceive', body, asyncFlowOpts(ctx));
    const payload = result.result || result;  // async vs sync response
    const flowId = payload.flowId || result.flowId;
    const templateId = payload.templateId || result.templateId;
    // Conceive Step v1.2.0+ returns the parsed spec; v1.5.0+ also returns
    // the enriched playbook markdown (same input with a canonical
    // `## Pipeline Spec (machine-generated)` section appended). Capture
    // both so downstream stages never need to re-parse.
    const spec = payload.spec || null;
    const enrichedPlaybook = payload.playbook || null;
    // placeholderStepId is conceive's own resolution of the splice target.
    // On a fresh flow it's the placeholder step ("Your Step Here"); on a
    // reused flow it's the step whose label matches spec.label. Capturing
    // it here lets verify short-circuit its own splice-target search in
    // the reuse path (where the step's .type still references the PRIOR
    // run's templateId, not the new one conceive just registered).
    const placeholderStepId = payload.placeholderStepId || result.placeholderStepId;
    return { flowId, templateId, spec, enrichedPlaybook, placeholderStepId, raw: result };
  }

  async function verify(result, ctx) {
    // Check 1: run produced a flowId.
    if (!result?.flowId) {
      return { ok: false, reason: `conceive did not return a flowId: ${JSON.stringify(result?.raw || {}).slice(0, 180)}` };
    }
    // Check 2: run produced a templateId.
    if (!result?.templateId) {
      return { ok: false, reason: 'conceive did not return a templateId' };
    }

    // Check 3: flow actually exists on Edison.
    let flow;
    try {
      const dh = require('./deployHelper');
      const token = await dh.getToken();
      const api = dh.initFlowsApi(token);
      flow = await api.getFlow(result.flowId);
    } catch (err) {
      return { ok: false, reason: `flow "${result.flowId}" does not exist on Edison: ${err.message}` };
    }

    // Check 4: templateId is in the flow's stepTemplates.
    const tpls = flow.data?.stepTemplates || [];
    const tplById = new Map(tpls.map(t => [t.id, t]));
    if (!tplById.has(result.templateId)) {
      return { ok: false, reason: `template "${result.templateId}" is not in the flow's stepTemplates` };
    }

    // Check 5: flow has a gateway step with an HTTP path.
    const steps = flow.data?.trees?.main?.steps || [];
    const gw = steps.find(s => s.isGatewayStep);
    if (!gw) return { ok: false, reason: 'flow has no Wait-for-HTTP gateway step' };
    const httpPath = String(gw.data?.path || '').replace(/`/g, '').replace(/^\/+/, '');
    if (!httpPath) return { ok: false, reason: 'gateway step has no HTTP path' };

    // Check 6: flow has a splice target.
    //
    // Resolution order:
    //   1. result.placeholderStepId — conceive's own answer. Conceive already
    //      decides the splice target (label-match on reuse, placeholder-regex
    //      on fresh). If it returned an id AND that id resolves to a real
    //      step on the canvas, trust it.
    //   2. Placeholder regex — fresh-clone fallback for older conceive
    //      versions (pre-1.5.x) that didn't return placeholderStepId.
    //   3. step.type === templateId — reuse fallback when conceive reports
    //      the template already lives on canvas under the new UUID.
    //
    // Conceive's templateId changes every run (fresh UUID on each scaffold),
    // so on the reuse path the canvas step's .type still references the
    // PRIOR run's templateId — don't rely on it as the primary matcher.
    let target = null;
    let targetSource = '';
    if (result.placeholderStepId) {
      target = steps.find(s => s.id === result.placeholderStepId);
      if (target) targetSource = 'conceive.placeholderStepId';
    }
    if (!target) {
      target = steps.find(s => {
        const stepLbl = s.label || '';
        const tplLbl = tplById.get(s.type)?.label || '';
        return PLACEHOLDER_LABEL_RE.test(stepLbl) || PLACEHOLDER_LABEL_RE.test(tplLbl);
      });
      if (target) targetSource = 'placeholder regex';
    }
    if (!target) {
      target = steps.find(s => s.type === result.templateId);
      if (target) targetSource = 'type === templateId';
    }
    if (!target) {
      return { ok: false, reason: `flow has no splice target (conceive reported placeholderStepId="${result.placeholderStepId || '(none)'}" — not found on canvas; no placeholder-regex match; no step with type === "${String(result.templateId).slice(0, 8)}")` };
    }

    const flowLabel = flow.data?.label || '(no label)';
    const tplLabel = tplById.get(result.templateId)?.label || '';
    ctx.log(`  verified: "${flowLabel}" — template "${tplLabel}", target=${target.id.slice(0, 8)} via ${targetSource}, path=/${httpPath}`);
    return {
      ok: true,
      flowLabel,
      httpPath,
      placeholderStepId: target.id,
    };
  }

  return await runStageWithVerify(ctx, 'conceive', run, verify, {
    onPass: (result, verdict, ctx) => {
      ctx.flowId = result.flowId;
      ctx.templateId = result.templateId;
      ctx.flowLabel = verdict.flowLabel;
      ctx.httpPath = verdict.httpPath;
      ctx.placeholderStepId = verdict.placeholderStepId;
      // Stash the parsed spec from Conceive so downstream stages use it
      // directly instead of re-parsing the playbook with a weaker parser.
      if (result.spec && typeof result.spec === 'object') {
        ctx.conceiveSpec = result.spec;
        const s = result.spec;
        ctx.log(`  conceiveSpec captured: "${s.label || '?'}" (${(s.inputs || []).length} inputs, ${(s.exits || []).length} exits)`);
      } else {
        ctx.log('  WARNING: conceive did not return spec — pipeline will fall back to buildSpecFromPlaybook');
      }
      // Replace ctx.bestPlan with the Conceive-enriched playbook (has a
      // canonical `## Pipeline Spec` section appended). This means any
      // stage that still re-parses the playbook text gets the right
      // spec-shaped markdown to parse.
      if (result.enrichedPlaybook && typeof result.enrichedPlaybook === 'string' && result.enrichedPlaybook.length > ctx.bestPlan.length) {
        const added = result.enrichedPlaybook.length - ctx.bestPlan.length;
        ctx.log(`  playbook enriched by conceive (+${added} chars — canonical Pipeline Spec section appended)`);
        ctx.bestPlan = result.enrichedPlaybook;
      }
    },
  });
}

// autoRepairKnownBlockers is defined inside stageGenerateCode() below (takes
// only parameters — no closure over stage state). Module-level reference so
// stageHarnessCode can pipe it into harnessCode()'s post-logging validator
// pass, where addStrategicLogging's LLM edits have been observed to
// reintroduce HARDCODED_URL literals AFTER stageGenerateCode's own auto-repair
// already fired. Assigned at the top of stageGenerateCode — which always runs
// before stageHarnessCode in the pipeline order — so by the time harness is
// called, this reference is populated.
let _autoRepairKnownBlockersRef = null;

// Generate Code — call the LLM to produce runnable step code.
//
// PASS requires ALL of:
//   - `source` is one of ACCEPTABLE_SOURCES (NOT deterministic-fallback/*)
//   - `code` length > 500 chars
//   - `code` contains `class` + `extends Step`
//   - `code` contains at least one `exitStep(` call
//   - `code` parses as valid JS (via validateStep structural check)
//   - no `error`-severity validator diagnostics of runtime-fatal codes
//
// FAIL modes:
//   - source === 'deterministic-fallback' / 'deterministic-no-storage' / 'deterministic-no-key'
//     → LLM couldn't generate real code; the step is a placeholder
//   - code length < 500 → truncated / stub
//   - missing Step class or exitStep → runtime won't execute
//   - syntax errors → won't load
//
// Retry: 3×. Each retry escalates context — prior failures become
// priorDiagnosis which the stage forwards as patchInstructions.
async function stageGenerateCode(ctx) {
  const alive = await checkEndpointAlive('generateCode', ctx.log);
  if (!alive) {
    throw new Error('Generate Step Code flow is inactive. Activate it first.');
  }

  // Prefer the spec parsed by Conceive Step (richer parser: HTML, YAML,
  // name-keyed sections, first-wins drift-correction). Fall back to the
  // pipeline's local parser only when Conceive didn't return a spec (older
  // conceive-step version, or non-pipeline callers).
  let fullSpec;
  if (ctx.conceiveSpec && typeof ctx.conceiveSpec === 'object' && (ctx.conceiveSpec.label || ctx.conceiveSpec.name)) {
    fullSpec = ctx.conceiveSpec;
    ctx.log(`  Spec (from conceive): ${fullSpec.name} — ${fullSpec.label} (${(fullSpec.inputs || []).length} inputs, ${(fullSpec.exits || []).length} exits)`);
  } else {
    fullSpec = buildSpecFromPlaybook(ctx.bestPlan, ctx.objective);
    ctx.log(`  Spec (from pipeline parser fallback): ${fullSpec.name} — ${fullSpec.label} (${(fullSpec.inputs || []).length} inputs, ${(fullSpec.exits || []).length} exits)`);
  }

  // If decompose's enrichment produced a richer input list than whatever
  // fullSpec arrived with, merge the additional inputs in. This matters for
  // autoRepairKnownBlockers: if the enriched spec has 14 inputs (including
  // `weatherApiUrl` with a URL default) but conceive's extracted spec
  // thinned that down to 1 (just `location`), auto-repair can't find the
  // URL input to substitute against and falls back to synthetic replacement
  // which keeps the hardcoded URL alive in the code as a fallback literal.
  // Merging is non-destructive — fullSpec's own inputs win on name clashes;
  // enriched-only inputs get added to the tail.
  const enrichedInputs = ctx.extractedSpec?.inputs;
  if (Array.isArray(enrichedInputs) && enrichedInputs.length > (fullSpec.inputs?.length || 0)) {
    const seen = new Set((fullSpec.inputs || []).map((i) => i.variable));
    const extras = enrichedInputs.filter((i) => i && i.variable && !seen.has(i.variable));
    if (extras.length > 0) {
      fullSpec = {
        ...fullSpec,
        inputs: [...(fullSpec.inputs || []), ...extras],
      };
      ctx.log(`  Spec inputs augmented with ${extras.length} enriched-only input(s): ${extras.map((i) => i.variable).join(', ')} (total ${(fullSpec.inputs || []).length})`);
    }
  }

  // Sources that count as "real code" — LLM actually produced something.
  const ACCEPTABLE_SOURCES = new Set(['llm', 'patch', 'patch-no-change', 'patch-reusability-gated']);
  const REJECTED_SOURCES = new Set(['deterministic-fallback', 'deterministic', 'deterministic-no-storage', 'deterministic-no-key', 'patch-unchanged', 'provided', 'unknown']);

  // (CODE_LEVEL_BLOCKERS lifted to module-level so stageHarnessCode can
  // reuse it for its own validator-retry loop — matches the user's "step
  // validator called again" beat in the pipeline spec.)

  // ── Auto-repair for well-understood validator blockers ───────────────
  //
  // Applies deterministic post-generation rewrites for the two classes of
  // blocker the LLM consistently fails to self-correct:
  //
  //   HARDCODED_URL       — for EVERY unique URL string literal flagged by
  //                         the validator, injects a variable at the top of
  //                         runStep() that resolves from the best-matching
  //                         spec input (with the spec's declared default as
  //                         fallback — NOT the LLM's possibly-hallucinated
  //                         URL), then replaces every `"URL"` literal in the
  //                         code with that variable reference. Works
  //                         regardless of syntactic position (declaration,
  //                         fetch arg, string concat, template literal).
  //
  //   AUTH_NO_KV_RESOLUTION — injects the canonical
  //                           `require('or-sdk/storage') + storage.get()` block
  //                           at the top of runStep() when the code has
  //                           `this.data.auth` reads but no or-sdk/storage
  //                           resolution.
  //
  // Why: the LLM consistently ignores patch prompts for these specific
  // patterns (observed 3/3 retries failing identically on the Weather
  // WISER playbook, 2026-04-22). Deterministic rewriting bypasses the
  // LLM compliance problem entirely.
  //
  // Returns { code: <maybe-rewritten>, applied: [{code, summary}, ...] }.
  function autoRepairKnownBlockers(code, spec, blockers, { log = () => {} } = {}) {
    // Shim over lib/patcher.js — atomic, syntax-validated, all-or-nothing
    // batches. Returns the SAME shape as the old implementation so the two
    // call sites (verify() in stageGenerateCode + codeHarness post-logging
    // re-check) continue to work unchanged.
    //
    // New guarantees the old impl didn't have:
    //   - each repair is a validated Edit (oldText matches exactly once)
    //   - the post-edit code is syntax-checked before being returned
    //   - any edit failure rolls back and returns the unchanged code
    //   - edit records are structured (Edit Primitive provenance hashes)
    //
    // New defects covered beyond HARDCODED_URL + AUTH_NO_KV_RESOLUTION:
    //   - AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX (the ::token:: bug from 2026-04-22)
    //   - UNCONDITIONAL_ERROR_EXIT (wraps in processError gate + throw)
    //   - EQEQ (loose equality → strict, string-safe)
    //   - TEMPLATE_HELP_DUPLICATES_DESCRIPTION (step.json skeleton)
    const { findPatches } = require('./patcher');
    const { applyEditsToString } = require('./editPrimitive');
    const blockerCodes = new Set(blockers.map((b) => b.code));
    const { patchable } = findPatches(code, { spec });
    // Only apply patches whose defect id matches a current blocker (or the
    // broad rewrites that always fire when the underlying pattern is present
    // in code, e.g. the ::token:: fix).
    const relevant = patchable.filter((p) => blockerCodes.has(p.id) || p.severity === 'error');
    if (relevant.length === 0) return { code, applied: [] };
    const allEdits = relevant.flatMap((p) => p.edits.map((e) => ({ ...e, _sourceDefect: p.id })));
    const applyResult = applyEditsToString(code, allEdits);
    if (!applyResult.ok) {
      log('edit batch rejected (' + applyResult.error + ') — no repairs applied. Details: ' + String(applyResult.details || '').slice(0, 120));
      return { code, applied: [] };
    }
    // Build the legacy-shaped applied[] so downstream logging + audit trail
    // continue to work. Group edits back by their source defect id.
    const appliedByDefect = new Map();
    for (const e of allEdits) {
      const id = e._sourceDefect;
      if (!appliedByDefect.has(id)) appliedByDefect.set(id, []);
      appliedByDefect.get(id).push(e);
    }
    const applied = [];
    for (const [defectId, edits] of appliedByDefect) {
      const rationales = edits.map((e) => e.rationale).filter(Boolean).join('; ');
      applied.push({
        code: defectId,
        summary: rationales || ('' + edits.length + ' edit(s)'),
        editCount: edits.length,
        // Provenance: stable hashes let downstream provenance writers dedup.
        oldHash: applyResult.oldHash,
        newHash: applyResult.newHash,
      });
      log('[' + defectId + '] ' + (rationales || (edits.length + ' edit(s) applied')));
    }
    return { code: applyResult.code, applied, oldHash: applyResult.oldHash, newHash: applyResult.newHash };
  }
  // Expose for stageHarnessCode's post-logging validator pass (see comment
  // on _autoRepairKnownBlockersRef near line 1301 for rationale).
  _autoRepairKnownBlockersRef = autoRepairKnownBlockers;

  // Build a template-shaped object from raw code + spec, so the validator
  // can fire rules that need spec context (e.g. AUTH_NO_KV_RESOLUTION looks
  // at stepInputs to find auth-external-component; EXIT_NOT_DEFINED
  // compares exitStep() ids to data.exits; ERROR_EXIT_CALLED_BUT_DISABLED
  // needs data.processError to know if the error exit is enabled).
  //
  // processError / processTimeout are derived from exit conditions the same
  // way Conceive's scaffolder does — any exit with condition:'processError'
  // flips processError to true. Without this, the probe would falsely fire
  // ERROR_EXIT_CALLED_BUT_DISABLED on every step that has an __error__ exit,
  // because my synthetic template would default both flags to undefined.
  function synthesizeTemplate(code, spec) {
    const exits = (spec.exits || []).map(e => ({
      id: e.id, label: e.label || e.id, condition: e.condition || '', stepId: '',
    }));
    const hasProcessError = exits.some(e =>
      e.condition === 'processError' || e.id === '__error__' || e.id === 'error');
    const hasProcessTimeout = exits.some(e =>
      e.condition === 'processTimeout' || e.id === '__timeout__' || e.id === 'timeout');
    return {
      id: 'validation-probe',
      name: spec.name || 'probe',
      label: spec.label || 'probe',
      version: '1.0.0',
      description: spec.description || '',
      template: code,
      form: {},
      formBuilder: {
        stepInputs: (spec.inputs || []).map(inp => ({
          component: inp.type === 'auth' ? 'auth-external-component' : 'formTextInput',
          data: { variable: inp.variable, label: inp.label || inp.variable, helpText: inp.helpText || '' },
        })),
      },
      data: {
        exits,
        dataOut: spec.dataOut || { name: (spec.name || 'out'), type: 'session', ttl: 86400000 },
        processError: hasProcessError,
        processTimeout: hasProcessTimeout,
        ...(hasProcessTimeout ? { timeoutDuration: '`120 sec`' } : {}),
      },
    };
  }

  async function run(ctx, { attempt, priorFailures }) {
    // The Generate Code flow (v2.1.0+) owns exemplar lookup, explicit rules,
    // and post-gen defect repair — the pipeline doesn't inject them. POST
    // → check response shape → pass/fail → retry × 3 → abort. That's it.
    const body = {
      flowId: ctx.flowId,
      templateId: ctx.templateId,
      spec: fullSpec,
      mode: 'generate',
      level: '1',
      model: 'claude-opus-4-6',
      apiUrl: 'https://api.anthropic.com/v1/messages',
      maxRetries: '2',
      patchInstructions: '',
      logicSource: '',
      existingTemplate: '',
      validationResults: '',
      playbookID: ctx.playbookID,
    };

    // Corrective retry — either caller-supplied priorDiagnosis (outer e2e
    // retry) OR our own previous-attempt failures (inner stage retry).
    const allPrior = [
      ...(ctx.priorDiagnosis?.reasons || []),
      ...(priorFailures || []).map(f => f.reason),
    ].filter(Boolean);

    // Aggregate actual validator diagnostics from prior attempts. The flow's
    // prompt has a "## Step Validator Findings" section that consumes these
    // (validationResults.diagnostics). Piping them through closes the feedback
    // loop: pipeline validates → flow's LLM sees what to fix → re-generates.
    const priorDiagnostics = [];
    for (const f of (priorFailures || [])) {
      if (Array.isArray(f?.verdict?.validatorDiagnostics)) {
        priorDiagnostics.push(...f.verdict.validatorDiagnostics);
      }
    }

    if (attempt > 1 || allPrior.length > 0) {
      const lastGoodCode = ctx.priorDiagnosis?.lastCode || (priorFailures?.[0]?.result?.result?.code) || (priorFailures?.[0]?.result?.code) || '';
      const instructionParts = [
        'This is a corrective retry. The previous attempt(s) failed these acceptance gates:',
        ...allPrior.map((r, i) => `  ${i + 1}. ${r}`),
      ];

      // Fold the structured validator diagnostics directly into the patch
      // instructions. The Generate Step Code flow's buildPatchPrompt does
      // NOT pass externalDiags into its prompt — so validator findings
      // sent only via validationResults would be invisible to the LLM in
      // patch mode. Inlining them here guarantees they reach the model,
      // with the same "code + fix" shape as the Step Validator Findings
      // section in generate mode.
      if (priorDiagnostics.length > 0) {
        instructionParts.push('');
        instructionParts.push('## Step Validator Findings (MUST fix these exactly)');
        instructionParts.push('A step validator ran against your previous output. Each finding below is a REAL code bug blocking deployment. Address every one — do not leave any unfixed.');
        for (const d of priorDiagnostics.slice(0, 15)) {
          instructionParts.push(`- [${d.severity || 'error'}] ${d.code}: ${d.message || ''}`);
          if (d.fix) instructionParts.push(`  Fix: ${d.fix}`);
        }
      }

      // Runtime-log forensics from prior test-step or stage failures. When
      // the outer retry fires because a scenario failed at runtime, the
      // pipeline fetched the deployed step's flow logs and captured error
      // snippets. Feed those to the LLM so it sees the actual stack trace /
      // error lines rather than just the scenario-level code mismatch.
      const runtimeSnippets = ctx.priorDiagnosis?.runtimeLogSnippets || [];
      if (runtimeSnippets.length > 0) {
        instructionParts.push('');
        instructionParts.push('## Runtime Logs from the Deployed Step (actual runtime errors)');
        instructionParts.push('The code you produced previously deployed, but FAILED at runtime. These lines were captured from the deployed step\'s CloudWatch logs. Address the root cause here — the scenario-level errors above are downstream symptoms:');
        for (const s of runtimeSnippets) {
          const flagStr = Array.isArray(s.flags) && s.flags.length ? ` [${s.flags.join(',')}]` : '';
          instructionParts.push(`  L${s.lineNum}${flagStr}: ${String(s.text).slice(0, 300)}`);
        }
      }

      // Canonical patterns for the recurring hard cases. These get inlined
      // on EVERY retry (not gated on runtime logs) because the LLM
      // consistently ignores plain diagnostics-text for these — it needs
      // to see the exact required code shape.
      //
      // Note: the pipeline ALSO has a deterministic auto-repair step
      // (autoRepairKnownBlockers in verify()) that rewrites these patterns
      // in the generated code without re-asking the LLM. This prompt
      // section is a belt-and-suspenders attempt to get the LLM to
      // produce correct output on its own; the auto-repair is the
      // last-mile safety net.
      if (priorDiagnostics.some(d => d.code === 'AUTH_NO_KV_RESOLUTION')) {
        instructionParts.push('');
        instructionParts.push('## CANONICAL AUTH PATTERN (use this EXACT shape — previous attempts IGNORED this fix)');
        instructionParts.push('Previous attempts failed AUTH_NO_KV_RESOLUTION. Copy this block VERBATIM into runStep(). Do not skip, do not paraphrase, do not merge with other logic.');
        instructionParts.push('```javascript');
        instructionParts.push(`// Unwrap the auth component's object shape
let auth = this.data.auth;
if (typeof auth === 'object' && auth !== null) auth = auth.auth || auth.authSelected || '';
if (!auth) return this.exitStep('__error__', { code: 'MISSING_INPUT', message: 'auth credential is required' });

// Respect inherited-auth pattern
const collection = (this.data.authCollection && this.data.authCollection !== 'undefined')
  ? this.data.authCollection
  : '__authorization_service_Default';
if (auth === 'inherited') {
  if (typeof this.getShared === 'function') auth = await this.getShared(\`shared_\${collection}\`);
} else if (typeof this.setShared === 'function') {
  await this.setShared(\`shared_\${collection}\`, auth);
}

// Resolve the credential through or-sdk/storage (this is the bit the validator scans for)
const Storage = require('or-sdk/storage');
const storage = new Storage(this);
const creds = await storage.get(collection, auth).catch(() => null);
const apiKey = creds && (creds.apiKey || creds.token || creds.auth);
if (!apiKey) return this.exitStep('__error__', { code: 'AUTH_RETRIEVAL_FAILED', message: 'Could not resolve API credential' });`);
        instructionParts.push('```');
        instructionParts.push('The `require("or-sdk/storage")` + `storage.get(collection, auth)` call is what the validator scans for. Code that skips it — even if it reads this.data.auth — will continue to fail AUTH_NO_KV_RESOLUTION.');
      }

      if (priorDiagnostics.some(d => d.code === 'HARDCODED_URL')) {
        instructionParts.push('');
        instructionParts.push('## CANONICAL URL PATTERN (use this EXACT shape — previous attempts IGNORED this fix)');
        instructionParts.push('Previous attempts failed HARDCODED_URL. The URL you hardcoded must come from `this.data.<inputVariable>` instead. Every API/service URL must be a SPEC INPUT that the flow author can override.');
        instructionParts.push('');
        instructionParts.push('WRONG (what previous attempts did):');
        instructionParts.push('```javascript');
        instructionParts.push('const weatherApiUrl = "https://api.weatherapi.com/v1";  // ← HARDCODED_URL blocker');
        instructionParts.push('```');
        instructionParts.push('');
        instructionParts.push('RIGHT (use the spec input with its declared default):');
        instructionParts.push('```javascript');
        instructionParts.push('const weatherApiUrl = (this.data.weatherApiUrl && this.data.weatherApiUrl !== \'undefined\')');
        instructionParts.push('  ? this.data.weatherApiUrl');
        instructionParts.push('  : \'https://api.open-meteo.com/v1/forecast\';  // ← matches the spec input\'s default');
        instructionParts.push('```');
        instructionParts.push('');
        instructionParts.push('Every input declared in the spec has a default. READ those inputs from this.data.<variable>, fall back to the spec\'s default when undefined. DO NOT pick your own URL from training memory.');
      }

      instructionParts.push('');
      instructionParts.push('Produce a corrected step that passes all gates. Specifically:');
      instructionParts.push('- Re-check inputs/exits match the spec exactly.');
      instructionParts.push('- Ensure the code is real, not a deterministic-fallback stub.');
      instructionParts.push('- Ensure the code has `class X extends Step` and calls exitStep().');
      instructionParts.push('- Do not reintroduce any of the failures listed above.');

      body.mode = 'patch';
      body.patchInstructions = instructionParts.join('\n');
      // Also send structured diagnostics via validationResults in case the
      // flow updates in the future to consume them in patch mode (currently
      // only generate mode uses validationDiags in its prompt).
      body.validationResults = JSON.stringify({
        failures: allPrior,
        diagnostics: priorDiagnostics,
      });
      if (lastGoodCode && lastGoodCode.length > 200) body.logicSource = lastGoodCode;
      const diagCount = priorDiagnostics.length;
      ctx.log(`  [attempt ${attempt}] corrective: ${allPrior.length} prior failure(s)` +
        (diagCount > 0 ? `, ${diagCount} validator diagnostic(s) inlined into patch prompt` : '') +
        (priorDiagnostics.some(d => d.code === 'AUTH_NO_KV_RESOLUTION') ? ' + canonical auth pattern' : ''));
    } else {
      ctx.log(`  [attempt ${attempt}] generating fresh from spec`);
    }

    const raw = await callAsyncFlow('generateCode', body, asyncFlowOpts(ctx));
    const r = raw.result || raw.value || raw;
    return {
      source: r.source || 'unknown',
      code: r.code || '',
      codeLength: (r.code || '').length,
      llmAttempts: r.llmAttempts || 0,
      rating: r.rating,
      reflexion: r.reflexion,
      reusabilityReport: r.reusabilityReport,
      formBuilder: r.formBuilder,
      raw,  // kept for downstream harness stage
    };
  }

  async function verify(result, ctx) {
    ctx.log(`  Source: ${result.source}, code: ${result.codeLength} chars, LLM attempts: ${result.llmAttempts}`);
    if (result.reflexion) ctx.log(`  Reflexion: score=${result.reflexion.score}, passed=${result.reflexion.passed}`);
    if (result.rating) ctx.log(`  Rating: L${result.rating.level} ${result.rating.levelName || ''}, score=${result.rating.score}, passed=${result.rating.passed}`);

    if (!result.source) return { ok: false, reason: 'no source field in response — generateCode may have errored' };
    if (REJECTED_SOURCES.has(result.source)) {
      return { ok: false, reason: `unacceptable source "${result.source}" — the LLM did not produce real code. Spec may be too vague or LLM call failed.` };
    }
    if (!ACCEPTABLE_SOURCES.has(result.source)) {
      return { ok: false, reason: `unknown source "${result.source}" — not in accept-list` };
    }
    if (result.codeLength < 500) {
      return { ok: false, reason: `code too short (${result.codeLength} chars) — probably stub/truncated` };
    }

    // Note: the Generate Code flow (v2.1.0+) runs its own post-gen defect
    // repair inside the step. The pipeline no longer duplicates that work.

    if (!/class\s+\w+\s+extends\s+Step/.test(result.code)) {
      return { ok: false, reason: 'code missing `class X extends Step` — runtime won\'t load as a step' };
    }
    if (!/\.exitStep\s*\(/.test(result.code)) {
      return { ok: false, reason: 'code has no exitStep() call — will never advance the flow' };
    }

    // Full validator gate — catches the recurring defects that the basic
    // shape checks above miss: STEP_LOGIC_READS_API_INPUT (step couples to
    // httpCall gateway), AUTH_NO_KV_RESOLUTION (reads creds without
    // storage.get), hardcoded URLs/models, etc. We synthesize a template
    // so rules that need spec context (exits, stepInputs) fire correctly.
    //
    // Auto-repair first pass: for well-understood patterns (HARDCODED_URL
    // where the variable name matches a spec input; AUTH_NO_KV_RESOLUTION
    // where the step reads this.data.auth without storage.get) we rewrite
    // the code ourselves rather than asking the LLM to re-generate. The
    // LLM has proven unreliable at complying with these specific fixes
    // even when the patch prompt spells them out explicitly — 3 attempts
    // in a row produced the same blocker on the Weather WISER playbook
    // (2026-04-22). Deterministic post-gen repair is the last-mile fix.
    //
    // Retry payload (for blockers we could NOT auto-repair): diagnostics
    // come back to the flow via validationResults, and the flow's prompt
    // has a "## Step Validator Findings" section that feeds them to the
    // LLM — closing the loop between "pipeline validates" and "LLM knows
    // what to fix on the next attempt".
    // Declared outside the try so the success return at the end of verify()
    // can reference it — prior scoping bug surfaced in E2E #4 when auto-repair
    // was (correctly) captured but the return path couldn't see the binding.
    let autoRepairApplied = null;
    try {
      const { validateStep } = require('./stepValidator');
      const { enrichDiagnostics } = require('./diagLocation');
      let synth = synthesizeTemplate(result.code, fullSpec);
      let v = validateStep(synth);
      // Enrich every diagnostic with {startLine, endLine, snippet} so
      // downstream patchers (LLM or deterministic) can reference locations
      // directly instead of re-scanning the code. Idempotent.
      v.diagnostics = enrichDiagnostics(v.diagnostics || [], result.code);
      let blockers = (v.diagnostics || []).filter(d => d.severity === 'error' && CODE_LEVEL_BLOCKERS.has(d.code));

      if (blockers.length > 0) {
        const repair = autoRepairKnownBlockers(result.code, fullSpec, blockers, { log: (m) => ctx.log(`    [auto-repair] ${m}`) });
        if (repair.applied.length > 0) {
          ctx.log(`  auto-repair applied ${repair.applied.length} fix(es): ${repair.applied.map(a => `[${a.code}] ${a.summary}`).join('; ')}`);
          result.code = repair.code;
          result.codeLength = repair.code.length;
          result.source = result.source + '+auto-repaired';
          autoRepairApplied = repair.applied;
          // Re-validate after repair to see if any blockers remain
          synth = synthesizeTemplate(result.code, fullSpec);
          v = validateStep(synth);
          v.diagnostics = enrichDiagnostics(v.diagnostics || [], result.code);
          blockers = (v.diagnostics || []).filter(d => d.severity === 'error' && CODE_LEVEL_BLOCKERS.has(d.code));
          ctx.log(`  after auto-repair: ${blockers.length} blocker(s) remaining`);

          // Provenance: write applied-edit records to the playbook KV so
          // post-mortem diagnosis can reconstruct exactly what was patched,
          // by whom (deterministic vs llm), with what rationale. Best-effort
          // — never blocks the pipeline on a KV write failure.
          if (ctx.playbookHandle && Array.isArray(autoRepairApplied) && autoRepairApplied.length > 0) {
            try {
              const { createSessionLog, persistToPlaybook } = require('./editProvenance');
              const sLog = createSessionLog();
              for (const a of autoRepairApplied) {
                sLog.add({
                  stage: 'generateCode',
                  file: 'in-memory:result.code',
                  defectId: a.code,
                  source: 'deterministic',
                  rationale: a.summary,
                  oldHash: a.oldHash,
                  newHash: a.newHash,
                  editCount: a.editCount,
                });
              }
              // Fire-and-forget; don't await in the hot path.
              persistToPlaybook(ctx.playbookHandle, sLog.all()).catch(() => {});
            } catch { /* provenance must not break the pipeline */ }
          }
        }
      }

      if (blockers.length > 0) {
        // Before giving up to the outer retry (which does full-file regen via
        // the remote generate-step-code flow — the "LLM creates new bugs" loop
        // we want to avoid), try the AGENT LOOP: Claude uses text_editor_20250728
        // to make narrow str_replace edits guided by the specific remaining
        // blockers. Succeeds when the validator shows 0 blockers. Falls back
        // to the outer retry if no API key, no convergence, or explicitly
        // disabled via AGENT_LOOP_RETRY=off.
        const agentLoopDisabled = process.env.AGENT_LOOP_RETRY === 'off';
        const hasKey = !!(ctx.opts?.apiKey || process.env.ANTHROPIC_API_KEY);
        if (!agentLoopDisabled && hasKey) {
          try {
            const { tryAgentLoopRepair } = require('./agentLoopRepair');
            ctx.log(`  [agent-repair] attempting surgical fixes for ${blockers.length} blocker(s)...`);
            const agentRes = await tryAgentLoopRepair({
              code: result.code,
              spec: fullSpec,
              blockers,
              synthesizeTemplate,
              CODE_LEVEL_BLOCKERS,
              opts: {
                apiKey: ctx.opts?.apiKey,
                model: ctx.opts?.agentModel,
                maxOuter: 3,
                maxInner: 10,
                log: (m) => ctx.log(`    ${m}`),
              },
            });
            ctx.log(`  [agent-repair] ${agentRes.ok ? 'CONVERGED' : 'INSUFFICIENT'} — ` +
              `outer=${agentRes.outerIterations} inner=${JSON.stringify(agentRes.innerIterationsByOuter)} ` +
              `edits=${agentRes.applied.length} remaining=${agentRes.remainingBlockers.length} ` +
              `ms=${agentRes.totalMs} usage=${JSON.stringify(agentRes.totalUsage || {})}`);
            if (agentRes.ok) {
              // Apply the agent-loop result: update in-memory code, mark source,
              // log applied edits, and exit the verify block with success.
              result.code = agentRes.code;
              result.codeLength = agentRes.code.length;
              result.source = result.source + '+agent-repaired';
              const agentApplied = (agentRes.applied || []).map((e) => ({
                code: 'AGENT_LOOP',
                summary: `${e.command} ${e.path || 'logic.js'}` + (e.oldText ? ` (${e.oldText.slice(0, 40).replace(/\n/g, ' ')}...)` : ''),
                editCount: 1,
              }));
              autoRepairApplied = [...(autoRepairApplied || []), ...agentApplied];
              // Provenance for the agent loop's edits.
              if (ctx.playbookHandle && agentApplied.length > 0) {
                try {
                  const { createSessionLog, persistToPlaybook } = require('./editProvenance');
                  const sLog = createSessionLog();
                  for (const e of agentApplied) {
                    sLog.add({ stage: 'generateCode', file: 'in-memory:result.code', defectId: e.code, source: 'llm', rationale: e.summary });
                  }
                  persistToPlaybook(ctx.playbookHandle, sLog.all()).catch(() => {});
                } catch { /* ignore */ }
              }
              blockers = [];  // cleared — skip the "return ok:false" branch below
            }
          } catch (err) {
            ctx.log(`  [agent-repair] error: ${err.message} — falling back to outer retry`);
          }
        } else if (!hasKey) {
          ctx.log('  [agent-repair] skipped (no ANTHROPIC_API_KEY) — falling back to full-file retry');
        } else if (agentLoopDisabled) {
          ctx.log('  [agent-repair] disabled via AGENT_LOOP_RETRY=off');
        }
      }

      if (blockers.length > 0) {
        const reason = `${blockers.length} code-level validator blocker(s): ` +
          blockers.map(b => `[${b.code}] ${String(b.message || '').slice(0, 80)}`).join('; ');
        return {
          ok: false,
          reason,
          autoRepaired: autoRepairApplied,  // audit trail: what was attempted even though blockers remain
          validatorDiagnostics: blockers.map(b => ({
            code: b.code, severity: b.severity, message: b.message,
            fix: b.fix || b.llmFix || '',
          })),
        };
      }
      // Log non-blocker findings so the user sees what's suboptimal but
      // shippable. Useful for tuning CODE_LEVEL_BLOCKERS over time.
      const errOther = (v.diagnostics || []).filter(d => d.severity === 'error' && !CODE_LEVEL_BLOCKERS.has(d.code));
      if (errOther.length > 0) {
        ctx.log(`  ${errOther.length} non-blocker validator error(s) (spec/template-level — not retried here):`);
        for (const d of errOther.slice(0, 3)) ctx.log(`    [${d.code}] ${String(d.message).slice(0, 100)}`);
      }
    } catch (err) {
      ctx.log(`  validator check skipped: ${err.message}`);
    }

    ctx.log(`  *** code generated: source=${result.source}, ${result.codeLength} chars ***`);
    return { ok: true, autoRepaired: autoRepairApplied };
  }

  return await runStageWithVerify(ctx, 'generateCode', run, verify, {
    maxAttempts: 3,
    retryDelayMs: 5000,
    onPass: (result, _verdict, ctx) => {
      ctx.codeGenResult = result.raw;
      ctx.generatedCode = result.code;
      ctx.generatedSource = result.source;
      ctx.generatedFormBuilder = result.formBuilder;
    },
  });
}

async function stageHarnessCode(ctx) {
  // Harness is a pure transform on (code, spec). If the wrapped template has
  // code-level validator blockers, the right fix is to regenerate the code —
  // re-wrapping the same broken code will produce the same broken template.
  //
  // So each harness retry invokes stageGenerateCode first with the harness-
  // level blockers piped back as diagnostics. That closes the user's "step
  // validator called again, fixes made by code generator" beat (pipeline
  // spec step #7): harness-level validation → loop back to code gen.
  //
  // Budget: 2 harness attempts. Each attempt runs generateCode's own 3-retry
  // loop internally, so worst case = 6 LLM calls. Enough to fix real issues,
  // bounded against runaway retries.

  async function run(ctx, { attempt, priorFailures }) {
    // On retry, regenerate the code with accumulated harness blockers piped
    // into generateCode's ctx.priorDiagnosis.
    if (attempt > 1) {
      const harnessDiags = [];
      for (const f of (priorFailures || [])) {
        if (Array.isArray(f?.verdict?.harnessDiagnostics)) {
          harnessDiags.push(...f.verdict.harnessDiagnostics);
        }
      }
      if (harnessDiags.length > 0) {
        ctx.log(`  [harness-retry] regenerating code with ${harnessDiags.length} harness-level blocker(s) piped back`);
        for (const d of harnessDiags.slice(0, 5)) {
          ctx.log(`    [BLK→regen] ${d.code}: ${String(d.message || '').slice(0, 100)}`);
        }
        ctx.priorDiagnosis = {
          reasons: harnessDiags.map(d => `[${d.code}] ${String(d.message || '').slice(0, 120)}`),
          diagnostics: harnessDiags,
          lastCode: ctx.generatedCode || '',
          phase: 'harness-retry',
        };
        // Re-run generateCode — this refreshes ctx.codeGenResult, ctx.generatedCode.
        // Clear prior retry state so generateCode counts from attempt 1.
        await stageGenerateCode(ctx);
      }
    }

    const codeGenResult = ctx.codeGenResult?.result || ctx.codeGenResult || {};
    const code = codeGenResult.code || '';
    if (!code) {
      return { skipped: true, reason: 'no code' };
    }

    // Prefer the spec parsed by Conceive Step (richer parser — handles HTML,
    // YAML, name-keyed sections). Fall back to local pipeline parser only if
    // Conceive didn't return one. Without this, harnessCode builds a template
    // labeled "Step" from the weak parser, and downstream splice label-match
    // fails (canvas has "WeatherAnomalyDetector", template has "Step").
    const spec = (ctx.conceiveSpec && typeof ctx.conceiveSpec === 'object' && (ctx.conceiveSpec.label || ctx.conceiveSpec.name))
      ? ctx.conceiveSpec
      : buildSpecFromPlaybook(ctx.bestPlan, ctx.objective);
    ctx.log(`  Harnessing "${spec.label}" (${code.length} chars, ${(spec.inputs || []).length} inputs, ${(spec.exits || []).length} exits, attempt ${attempt})`);

    // Read current version from Edison if updating an existing template
    let currentVersion = null;
    try {
      const dh = require('./deployHelper');
      const token = await dh.getToken();
      const flowsApi = dh.initFlowsApi(token);
      const flow = await flowsApi.getFlow(ctx.flowId);
      const existingTpl = (flow.data?.stepTemplates || []).find(t => t.id === ctx.templateId);
      if (existingTpl?.version) {
        currentVersion = existingTpl.version;
        ctx.log(`  Existing template version: ${currentVersion}`);
      }
    } catch { /* first build — no existing version */ }

    const { harnessCode } = require('./codeHarness');
    // Probe injection: driven by --inject-probe CLI flag or
    // ctx.opts.injectProbe. Values:
    //   'off' (default) — no probe, cleanest production output
    //   'runtime'       — injected with EDISON_STEP_PROBE env-flag gate;
    //                     prod sets env to disable
    //   'always'        — injected unconditionally (for dev / pipeline
    //                     testing where we always want the traces)
    const injectProbe = ctx.opts.injectProbe || 'off';
    // Pass the same autoRepair function stageGenerateCode uses so the harness
    // can re-apply HARDCODED_URL / AUTH_NO_KV_RESOLUTION fixes AFTER
    // addStrategicLogging's LLM edits (which have been observed to reintroduce
    // URL literals into log statements after generateCode's auto-repair fired).
    // Ref is populated at the top of stageGenerateCode which always runs first.
    const harnessResult = await harnessCode(code, spec, {
      log: ctx.log,
      currentVersion,
      injectProbe,
      autoRepairKnownBlockers: _autoRepairKnownBlockersRef,
    });

    return { harnessResult };
  }

  async function verify(runOut, ctx) {
    if (runOut.skipped) {
      return { ok: true };  // Nothing to validate; log-only skip
    }
    const result = runOut.harnessResult;
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    const warnings = result.diagnostics.filter(d => d.severity === 'warning');
    const blockers = errors.filter(d => CODE_LEVEL_BLOCKERS.has(d.code));

    if (blockers.length > 0) {
      // Surface the blockers clearly and stash them for the next run() to
      // forward to generateCode. retryable flag is implicit — only non-
      // blocker errors survive to the "ship anyway" path.
      const reason = `${blockers.length} harness-level code blocker(s): ` +
        blockers.map(b => `[${b.code}] ${String(b.message || '').slice(0, 80)}`).join('; ');
      return {
        ok: false,
        reason,
        harnessDiagnostics: blockers.map(b => ({
          code: b.code,
          severity: b.severity,
          message: b.message,
          fix: b.fix || b.llmFix || '',
        })),
      };
    }

    // No code-level blockers. Log remaining non-blocker errors + warnings
    // for visibility — they ship with the template (matches prior "save
    // anyway" behavior for spec/template-level issues like EXIT_CONDITION_
    // SYNTAX_ERROR that come from Conceive).
    if (result.valid) {
      ctx.log('  Template is deploy-ready');
    } else {
      const nonBlockerErrs = errors.filter(d => !CODE_LEVEL_BLOCKERS.has(d.code));
      ctx.log(`  Template has ${nonBlockerErrs.length} non-blocker error(s), ${warnings.length} warning(s) — shipping (not retryable at harness)`);
      for (const d of nonBlockerErrs.slice(0, 3)) {
        ctx.log(`    [NON-BLK ERR] ${d.code}: ${String(d.message).slice(0, 150)}`);
      }
    }
    if (warnings.length > 0) {
      ctx.log(`  ${warnings.length} warning(s):`);
      for (const d of warnings.slice(0, 5)) {
        ctx.log(`    [WARN] ${d.code}: ${String(d.message).slice(0, 150)}`);
      }
    }
    // Summary fields for the stage-result payload (backward compat with
    // pre-retry behavior that endStage'd with these keys).
    return {
      ok: true,
      valid: result.valid,
      version: result.version,
      errors: errors.length,
      warnings: warnings.length,
      fixes: (result.fixes || []).length,
      codeLength: (result.template?.template || '').length,
      inputs: (result.template?.formBuilder?.stepInputs || []).length,
    };
  }

  return await runStageWithVerify(ctx, 'harnessCode', run, verify, {
    maxAttempts: 2,  // 1 initial + 1 retry with code regen
    retryDelayMs: 3000,
    onPass: (runOut, _verdict, ctx) => {
      if (runOut.skipped) return;  // no template to stash
      ctx.harnessResult = runOut.harnessResult;
      ctx.harnessedTemplate = runOut.harnessResult.template;
    },
  });
}

// ---------------------------------------------------------------------------
// stageLocalScenarioRun — run the same scenario suite stageTestStep runs, but
// execute each scenario against an in-process mock Edison runtime instead of a
// deployed HTTP endpoint. Runs BEFORE splice/activate, so a code defect that
// would have failed the deployed scenario catches ~30-90s earlier and triggers
// outer-retry regeneration without paying the splice tax.
//
// Why this is the biggest reliability win:
//   • Splice + activate is 30-90s; subprocess scenario run is 200-500ms.
//   • Every "generator wrote wrong exit id / didn't read this.data.foo / threw
//     TypeError on empty array" bug gets caught here.
//   • Failures populate ctx.testResults with shape identical to stageTestStep,
//     so the existing outer retry loop picks them up and regenerates.
//
// Graceful degradation:
//   • No harnessed template → skip.
//   • No scenarios available (playbook or spec-derivable) → skip.
//   • Step imports an SDK we haven't mocked (module load failed) → skip THAT
//     scenario (label 'local-skipped'), don't fail the stage. The deployed
//     testStep will cover it.
//   • Step calls gateway-only APIs (triggers.on, thread.fork) → local runtime
//     throws "not supported"; skip the scenario.
//
// Failure cases (trigger outer retry):
//   • Step runs but returns wrong exit id / wrong code / missing required field.
//   • Step throws a hard runtime error (TypeError, ReferenceError) from code
//     bugs the validator didn't catch.
// ---------------------------------------------------------------------------
async function stageLocalScenarioRun(ctx) {
  const s = startStage('localScenarioRun');

  const harnessed = ctx.harnessedTemplate;
  if (!harnessed || !harnessed.template) {
    ctx.log('  [local-scenarios] no harnessed template — skip');
    return endStage(s, { skipped: true, reason: 'no harnessed template' });
  }

  // Extract className. The final template is
  //   class FooGSX extends Step { ... }
  // possibly wrapped in an IIFE. Match the first occurrence.
  const classMatch = /class\s+(\w+)\s+extends\s+Step\b/.exec(harnessed.template);
  if (!classMatch) {
    ctx.log('  [local-scenarios] no "class X extends Step" in template — skip');
    return endStage(s, { skipped: true, reason: 'no class extends Step' });
  }
  const className = classMatch[1];

  // Gather scenarios. Identical prioritization to stageTestStep so local +
  // remote runs operate on the SAME scenario set — if something passes local,
  // it should have a fighting chance at passing remote.
  const { parseScenariosFromPlaybook, deriveScenariosFromSpec, _diagnose } = require('./stepScenarios');

  let scenarios = null;
  let source = null;
  if (typeof ctx.bestPlan === 'string' && ctx.bestPlan.length > 0) {
    scenarios = parseScenariosFromPlaybook(ctx.bestPlan);
    if (scenarios && scenarios.length > 0) source = 'playbook';
  }

  // Derive from harnessed template's formBuilder when no playbook scenarios —
  // same path stageTestStep uses (line 2444-2491). The template's formBuilder
  // is the most accurate spec post-harness because buildStepTemplate rebuilds
  // it from the actual this.data reads in code.
  let spec = null;
  if (!scenarios || scenarios.length === 0) {
    const tplInputs = harnessed.formBuilder?.stepInputs || [];
    if (tplInputs.length > 0) {
      const COMPONENT_TO_TYPE = {
        formTextInput: 'text', formTextBox: 'text', formTextArea: 'textarea', formTextarea: 'textarea',
        formNumber: 'number', formNumberInput: 'number', formSwitch: 'boolean', formCheckbox: 'boolean',
        formSelectExpression: 'select', formSelect: 'select', formRadio: 'select',
        formDate: 'date', formCode: 'code', formJson: 'json',
        'auth-external-component': 'auth',
      };
      const convertedInputs = tplInputs.map((inp) => {
        const comp = Array.isArray(inp.component) ? inp.component[0] : (inp.component || '');
        const d = inp.data || {};
        const type = COMPONENT_TO_TYPE[comp] || 'text';
        let options;
        if (Array.isArray(d.options)) {
          options = d.options.map((o) => (typeof o === 'object' ? { value: o.value, label: o.label } : { value: o, label: o }));
        }
        return {
          variable: d.variable,
          label: d.label || d.variable,
          type,
          required: d.validateRequired === true,
          default: d.defaultValue,
          example: d.example,
          helpText: d.helpText || '',
          options,
          config: type === 'auth' ? { collection: d.keyValueCollection || d.collection } : undefined,
        };
      }).filter((i) => i.variable);
      spec = {
        name: harnessed.name || 'step',
        label: harnessed.label || 'Step',
        description: harnessed.description || '',
        inputs: convertedInputs,
        exits: harnessed.data?.exits || [],
      };
      scenarios = deriveScenariosFromSpec(spec);
      source = 'spec-derived:template';
    }
  }

  if (!scenarios || scenarios.length === 0) {
    ctx.log('  [local-scenarios] no scenarios available — skip');
    return endStage(s, { skipped: true, reason: 'no scenarios', source });
  }

  // Prepare mock storage for any auth inputs in the spec. Without this, steps
  // that call storage.get() will return undefined → typical step code errors
  // out with MISSING_AUTH, which is a FALSE negative (the step would work in
  // prod with real creds). Seed with dummy creds keyed by the merge-field-
  // encoded authId pattern the step expects.
  const mockStorage = {};
  const authInputs = ((spec || ctx.conceiveSpec || {}).inputs || []).filter((i) => {
    if (!i) return false;
    if (i.type === 'auth') return true;
    const coll = i?.config?.collection || i?.data?.keyValueCollection || i?.keyValueCollection;
    return typeof coll === 'string' && /^__authorization_service_/.test(coll);
  });
  for (const ai of authInputs) {
    const coll = ai?.config?.collection || ai?.data?.keyValueCollection || ai?.keyValueCollection || '__authorization_service_Default';
    if (!mockStorage[coll]) mockStorage[coll] = {};
    // The Edison auth pattern stores creds at `service::token::<label>`. We
    // seed with a wildcard-ish entry; if the code computes a specific authId
    // we won't hit it, but we also don't block the run.
    mockStorage[coll]['service::token::__stub__'] = {
      accessToken: 'stub-access-token',
      refreshToken: 'stub-refresh-token',
      tokenType: 'bearer',
      expiresAt: Date.now() + 3600_000,
    };
  }

  // SDK mocks: stubs for the common or-sdk packages steps pull in. Any step
  // that requires an unmocked or-sdk/* will hit "module load failed"; we
  // detect that below and mark the scenario 'local-skipped' rather than
  // failing.
  const sdkMocks = {
    'or-sdk/llm': "function(_t) { return { generate: async () => ({ text: 'stub', output: 'stub', choices: [{ text: 'stub' }], usage: { prompt_tokens: 0, completion_tokens: 0 } }) }; }",
    'or-sdk/http': "function(_t) { return { request: async () => ({ status: 200, body: {}, headers: {} }), get: async () => ({ status: 200, body: {} }), post: async () => ({ status: 200, body: {} }) }; }",
    'or-sdk/users': "function(_t) { return { get: async (id) => ({ id, email: 'stub@example.com', name: 'Stub User' }) }; }",
    'or-sdk/files': "function(_t) { return { get: async () => ({ id: 'stub', content: '' }), put: async () => ({ id: 'stub' }) }; }",
  };

  const { runStepCodeLocally } = require('./localStepRuntime');

  ctx.log(`  [local-scenarios] running ${scenarios.length} scenario(s) from ${source} locally against ${className}...`);

  const results = [];
  let passed = 0, failed = 0, skippedLocal = 0;
  const skipReasons = [];

  for (const sc of scenarios) {
    const t0 = Date.now();
    let exec;
    try {
      exec = await runStepCodeLocally({
        code: harnessed.template,
        className,
        data: sc.input || {},
        opts: {
          timeoutMs: 8000,
          mockStorage,
          sdkMocks,
          // Seed a config with the canonical accountId so `this.config.accountId`
          // reads don't fail when the step logs it.
          config: { accountId: ACCOUNT_ID, flowId: ctx.flowId, botId: BOT_ID },
        },
      });
    } catch (err) {
      exec = { ok: false, error: `harness threw: ${err.message}` };
    }
    const elapsedMs = Date.now() - t0;

    // Detect "can't run this scenario locally" cases — NOT failures.
    // The local runtime reports these as various error strings depending on
    // whether the step code used require(), dynamic import(), or touched a
    // gateway-only API.
    const errMsg = String(exec.error || '');
    const isUnmockable =
      // CommonJS `require('or-sdk/*')` in the ESM child → "require is not defined"
      /require is not defined/i.test(errMsg)
      // Dynamic `import('or-sdk/*')` for a package we haven't stubbed
      || /Failed to resolve module specifier/i.test(errMsg)
      || /Cannot find module/i.test(errMsg)
      // Package referenced via `require()`/`import()` but not in the Node.js
      // resolution path (e.g. or-sdk/* that we haven't seeded into sdkMocks)
      || /module load failed.*or-sdk\//i.test(errMsg)
      // Gateway-only APIs the local runtime explicitly refuses
      || /not supported in local runtime/i.test(errMsg)
      || /triggers\.(on|fork|emit|waitBroadcast)/i.test(errMsg)
      || /thread\.(fork|waitBroadcast|callExit)/i.test(errMsg);
    if (!exec.ok && isUnmockable) {
      skippedLocal++;
      skipReasons.push(`"${sc.name}": ${errMsg.slice(0, 120)}`);
      ctx.log(`    SKIP (local) "${sc.name}" — ${errMsg.slice(0, 120)}`);
      // Still record it so the log has a row per scenario.
      results.push({
        name: sc.name,
        ok: true,  // don't count as failure; remote testStep will cover it
        phase: 'local-skipped',
        actual: null,
        diff: [],
        elapsedMs,
        skipReason: errMsg.slice(0, 200),
      });
      continue;
    }

    // Hard runtime failure (TypeError, ReferenceError, throw) — real bug.
    if (!exec.ok) {
      failed++;
      results.push({
        name: sc.name,
        ok: false,
        phase: 'local-runtime-error',
        error: errMsg,
        actual: null,
        diff: [{ field: '_runtime', error: errMsg.slice(0, 300) }],
        elapsedMs,
      });
      ctx.log(`    FAIL "${sc.name}" — runtime threw: ${errMsg.slice(0, 150)}`);
      continue;
    }

    // Step ran. Build an "actual" shape matching what the deployed endpoint
    // would return: exitPayload (usually { code, message, ... }) with exitId
    // stashed alongside for diagnostics.
    const actual = Object.assign({}, exec.exitPayload || {});
    if (actual.code === undefined && exec.exitId && exec.exitId !== 'next' && exec.exitId !== 'end') {
      // Some steps exit via __error__ / __timeout__ / custom exits without a
      // code field in the payload — surface the exitId so _diagnose can match.
      actual.code = actual.code || exec.exitId;
    }
    const diff = _diagnose(actual, sc.expect || {});
    const ok = diff.length === 0;

    const r = { name: sc.name, ok, phase: 'local-run', actual, diff, elapsedMs, exitId: exec.exitId };
    results.push(r);
    if (ok) {
      passed++;
      ctx.log(`    PASS "${sc.name}" (${elapsedMs}ms, code=${actual.code || '(none)'}, exit=${exec.exitId})`);
    } else {
      failed++;
      ctx.log(`    FAIL "${sc.name}" — ${diff.length} mismatch(es):`);
      for (const d of diff.slice(0, 3)) ctx.log(`      ${JSON.stringify(d)}`);
    }
  }

  ctx.log(`  [local-scenarios] ${passed}/${scenarios.length} passed, ${failed} failed, ${skippedLocal} skipped (unmockable)`);

  // If any scenarios failed, populate ctx.testResults so the outer retry loop
  // regenerates WITHOUT paying the splice+deploy tax. Shape is fully
  // compatible with stageTestStep's output (outer retry treats them the same).
  if (failed > 0) {
    ctx.testResults = {
      source: 'local:' + source,
      gatewayPath: null,
      totalScenarios: scenarios.length,
      passed,
      failed,
      skippedLocal,
      results,
      runAt: new Date().toISOString(),
      preSplice: true,
    };
  }

  return endStage(s, {
    source,
    totalScenarios: scenarios.length,
    passed,
    failed,
    skippedLocal,
    allPassed: failed === 0,
    preSplice: true,
  });
}

async function stageValidate(ctx) {
  const s = startStage('validate');

  const harnessed = ctx.harnessedTemplate;
  if (!harnessed || !harnessed.template) {
    ctx.log('  WARNING: No harnessed template — nothing to install');
    return endStage(s, { skipped: true });
  }

  // Advisory log: did the harness inject the step probe?
  if (/@probe-begin/.test(harnessed.template || '')) {
    ctx.log('  [validate] step probe present in template (stepTraces KV will be populated at runtime)');
  }

  ctx.log(`  Installing "${harnessed.label}" v${harnessed.version} via splice-step flow...`);

  // ── safe-splice pre-check: capture baseline FV3 diagnostics before we modify
  // the flow, so we can diff after and flag regressions. This is a flow-level
  // check (the whole canvas, all steps, merge-field graph) that the template-
  // level validator inside harnessCode can't see. Runs ~2–3 minutes on large
  // flows; skips quietly if FV3 is unavailable.
  //
  // 2026-04-21: brought to parity with stageTestWithUI so EVERY splice stage
  // has flow-level validation. Previously only testWithUI wrapped in safe-
  // splice — stageValidate just called splice directly and shipped whatever
  // came out. That let flow-shape regressions (orphaned refs, stale merge
  // fields, broken wiring that template-level validation can't see) slip
  // through silently when running --stop-after validate.
  let spliceBaseline = null;
  try {
    const { validateFlow } = require('./safe-splice');
    ctx.log('  [safe-splice] capturing baseline validation...');
    spliceBaseline = await validateFlow(ctx.flowId, { log: ctx.log });
    ctx.log('  [safe-splice] baseline: ' + JSON.stringify(spliceBaseline.counts || { errors: 0 }));
  } catch (err) {
    ctx.log('  [safe-splice] baseline validation failed (continuing anyway): ' + err.message);
  }

  // Prepare template for splice — preserve existing templateId so the splice
  // updates in-place, strip pipeline-internal fields, enforce Edison DB
  // varchar(255) limits. This is the SAME preparation stageTestWithUI
  // does — kept in sync here.
  const tpl = JSON.parse(JSON.stringify(harnessed));
  tpl.id = ctx.templateId;

  const ALLOWED = new Set(['id','version','cacheVersion','label','icon','iconType','iconUrl','shape','description','isGatewayStep','publishedBy','categories','recommended','tags','template','form','formBuilder','data','reporting','outputExample','help','modules','dateCreated','dateModified','rawMode','tour','migrations','hooks']);
  for (const k of Object.keys(tpl)) { if (!ALLOWED.has(k)) delete tpl[k]; }
  if (!tpl.form) tpl.form = { component: null };

  if (typeof tpl.description === 'string' && tpl.description.length > 255) {
    tpl.description = tpl.description.slice(0, 252) + '...';
    ctx.log('  Truncated description to 255 chars');
  }
  if (typeof tpl.help === 'string' && tpl.help.length > 255) {
    tpl.help = tpl.help.slice(0, 252) + '...';
  }
  if (typeof tpl.iconUrl === 'string' && tpl.iconUrl.length > 255) {
    tpl.iconType = 'default';
    tpl.icon = 'code';
    tpl.iconUrl = '';
    ctx.log('  Icon URL exceeded 255 chars — switched to default Material icon');
  }

  // ── Pre-splice known-issue fixes: proactive template cleanup for bugs
  // that stepValidator/harnessCode surfaced but the pipeline shipped anyway
  // (non-blocker errors). These are ALWAYS run — no delta check — because
  // they correct spec/template-level issues that FV3 won\'t catch later
  // (e.g. EXIT_CONDITION_NON_JS_STRING: natural-language exit conditions
  // leaked in from Conceive). Fix-loop entries gated on phase === 'pre-splice'
  // fire here; entries gated on 'post-splice' fire in the loop below.
  try {
    const { runKnownIssueFixes: runPreFixes } = require('./known-issues');
    const preBefore = JSON.stringify(tpl);
    const preCtx = {
      phase: 'pre-splice',
      template: tpl,  // mutable
      log: ctx.log,
    };
    const preResult = runPreFixes('pre-splice', preCtx);
    const preMutated = JSON.stringify(tpl) !== preBefore;
    if (preResult.applied > 0) {
      ctx.log(`  [pre-splice fix] applied ${preResult.applied} known-issue fix(es); templateMutated=${preMutated}`);
    }
  } catch (err) {
    ctx.log('  [pre-splice fix] runKnownIssueFixes failed (continuing anyway): ' + err.message);
  }

  // ── Splice + activate + validate, with a known-issue auto-fix loop on
  // regression. Each iteration:
  //   1. splice template into flow (via splice-step flow — CLAUDE.md rule)
  //   2. activateFlow at runtime so the gateway path starts serving
  //   3. safe-splice re-validate + diff against baseline
  //   4. if the delta has new errors/warnings, run runKnownIssueFixes against
  //      { template, delta } to auto-repair known regressions
  //   5. if any fix mutated the template, loop back and re-splice
  //
  // Cap at 2 iterations to prevent runaway loops when a fix introduces a new
  // regression. Each fix that mutated the template bumps template version so
  // FV3 sees fresh content on the re-check.
  let spliceResult = null;
  let flowVersion = '(unknown)';
  let stepId = ctx.placeholderStepId || '?';
  let activation = { ok: false, elapsedSec: 0 };
  let safeSpliceDelta = null;
  let safeSpliceOk = true;
  let fixLoopIterations = 0;
  let fixesApplied = [];
  const FIX_LOOP_MAX_ITER = 2;

  for (let iter = 0; iter < FIX_LOOP_MAX_ITER; iter++) {
    // Splice. Pass the playbook KV context so splice-step v3.4.0+ participates
    // in the state machine — it'll write stages.splice back when it exits.
    const spliceBody = {
      flowUrl: ctx.flowId,
      template: JSON.stringify(tpl),
      activate: true,
    };
    if (ctx.placeholderStepId) spliceBody.stepId = ctx.placeholderStepId;
    if (ctx.playbookID) {
      spliceBody.playbookID = ctx.playbookID;
      spliceBody.playbookCollection = ctx.playbookCollection || 'playbooks';
      spliceBody.playbookKey = ctx.playbookKey || ctx.playbookID;
    }

    const result = await callAsyncFlow('spliceStep', spliceBody, asyncFlowOpts(ctx));
    spliceResult = result.result || result;

    // Splice can return structured refusal codes. Surface each one clearly so
    // the failure mode (validator blockers, lock, label miss, etc.) lands
    // in the log instead of a vague "no flow id/version".
    if (spliceResult.status === 'blocked' || spliceResult.code === 'VALIDATION_BLOCKED') {
      const blockers = spliceResult.validation?.blockers || [];
      ctx.log(`  SPLICE BLOCKED: ${blockers.length} validator blocker(s):`);
      for (const b of blockers) {
        ctx.log(`    [${b.code || 'UNKNOWN'}] ${(b.message || '').slice(0, 200)}`);
        if (b.fix) ctx.log(`      → fix: ${String(b.fix).slice(0, 200)}`);
      }
      throw new Error(`Splice validator blocked: ${blockers.map(b => b.code).join(', ') || 'unknown'}`);
    }
    if (spliceResult.code === 'LABEL_NOT_FOUND' || spliceResult.code === 'DUPLICATE_LABEL' || spliceResult.code === 'TEMPLATE_NO_LABEL') {
      ctx.log(`  SPLICE TARGET RESOLUTION FAILED: [${spliceResult.code}] ${spliceResult.message || ''}`);
      if (spliceResult.available) ctx.log(`    available labels: ${spliceResult.available}`);
      throw new Error(`Splice target resolution failed: ${spliceResult.code} — ${spliceResult.message || ''}`);
    }
    if (spliceResult.status === 'error' || spliceResult.code === 'FLOW_LOCKED') {
      const msg = spliceResult.message || spliceResult.jobId || 'unknown splice error';
      ctx.log(`  SPLICE FAILED: ${msg}`);
      throw new Error(`Splice failed: ${msg}`);
    }
    if (!spliceResult.flowId && !spliceResult.flowVersion) {
      ctx.log('  SPLICE FAILED: response had neither flowId nor flowVersion');
      ctx.log('  Response: ' + JSON.stringify(spliceResult).slice(0, 300));
      throw new Error('Splice returned no flow id/version');
    }

    flowVersion = spliceResult.flowVersion || '(unknown)';
    stepId = spliceResult.stepId || ctx.placeholderStepId || '?';
    const iterTag = iter === 0 ? '' : ` (fix-loop iter ${iter})`;
    ctx.log(`  Installed via splice${iterTag}: flowVersion=${String(flowVersion).slice(0, 8)} step=${String(stepId).slice(0, 8)} gateway=${spliceResult.gatewayConfigured}`);
    if (iter === 0) ctx.log(`  Studio: ${STUDIO_BASE}/${ctx.flowId}`);

    // Force runtime activation so the HTTP gateway path starts serving
    // immediately. Splice's activate:true alone doesn't redeploy the Lambda.
    activation = await activateFlowRuntime(ctx.flowId, { log: ctx.log });

    // safe-splice post-check: re-validate and diff against baseline.
    safeSpliceDelta = null;
    safeSpliceOk = true;
    if (spliceBaseline) {
      try {
        const { validateFlow, diffDiagnostics, printDelta } = require('./safe-splice');
        ctx.log('  [safe-splice] re-validating post-splice...');
        const after = await validateFlow(ctx.flowId, { log: ctx.log });
        safeSpliceDelta = diffDiagnostics(spliceBaseline, after);
        const newIssues = safeSpliceDelta.newErrors.length + safeSpliceDelta.newWarnings.length;
        if (newIssues > 0) {
          safeSpliceOk = false;
          ctx.log(`\n  🚨 SAFE-SPLICE REGRESSION: ${safeSpliceDelta.newErrors.length} new error(s), ${safeSpliceDelta.newWarnings.length} new warning(s)`);
          printDelta(safeSpliceDelta, { log: ctx.log });
          ctx.log(`  Baseline version: ${spliceBaseline.flowVersion}`);
          ctx.log(`  Current  version: ${after.flowVersion}`);
        } else {
          ctx.log('  [safe-splice] no regressions introduced ✓');
        }
      } catch (err) {
        ctx.log('  [safe-splice] post-validation failed (continuing anyway): ' + err.message);
      }
    }

    // ── Auto-fix loop: if there's a regression, try known-issue fixes
    // against the template. Registry entries mutate ctx.template to repair.
    // If anything mutated, re-splice next iteration with the fixed template.
    const hasRegression = !safeSpliceOk && safeSpliceDelta;
    const canIterate = iter < FIX_LOOP_MAX_ITER - 1;
    if (!hasRegression || !canIterate) {
      if (hasRegression) {
        ctx.log(`  [fix-loop] regression persists after ${iter + 1} iteration(s); shipping with regression. Add known-issue entries to lib/known-issues.js to enable auto-repair on future runs.`);
      }
      fixLoopIterations = iter + 1;
      break;
    }

    ctx.log(`  [fix-loop] regression detected — running known-issue fixes (iter ${iter + 1}/${FIX_LOOP_MAX_ITER})...`);
    const { runKnownIssueFixes } = require('./known-issues');
    const beforeHash = JSON.stringify(tpl);
    const fixCtx = {
      phase: 'post-splice',
      template: tpl,       // mutable — fixes rewrite template in place
      delta: safeSpliceDelta,
      log: ctx.log,
      iteration: iter + 1,
    };
    const { applied } = runKnownIssueFixes('post-splice', fixCtx);
    const afterHash = JSON.stringify(tpl);
    const templateMutated = beforeHash !== afterHash;
    fixesApplied.push({ iteration: iter + 1, applied, templateMutated });

    if (applied === 0) {
      ctx.log(`  [fix-loop] no known-issue fixes matched — shipping with regression`);
      fixLoopIterations = iter + 1;
      break;
    }
    ctx.log(`  [fix-loop] applied ${applied} known-issue fix(es); templateMutated=${templateMutated}`);
    if (!templateMutated) {
      // Fixes may have suppressed false-positives in delta without touching
      // the template. Re-inspect the post-fix delta to decide if we're done.
      const remaining = safeSpliceDelta.newErrors.length + safeSpliceDelta.newWarnings.length;
      ctx.log(`  [fix-loop] delta-only fix(es); ${remaining} issue(s) remain after suppression`);
      if (remaining === 0) safeSpliceOk = true;
      fixLoopIterations = iter + 1;
      break;
    }
    ctx.log(`  [fix-loop] template mutated — re-splicing...`);
    // Loop back to top to re-splice with fixed template
  }

  // Record the final post-fix template that actually shipped to the flow.
  // harnessCode wrote the pre-fix snapshot to template.json; this gives
  // callers the artifact that matches the live deployed state.
  ctx.deployedTemplate = tpl;

  // ── Activation-failure classification ────────────────────────────────
  // If the runtime activation failed after all internal retries, distinguish
  // infra flakiness (ENOTEMPTY, REJECTED_TRIGGERS, network) from code-defect
  // failures (SyntaxError, ReferenceError, Cannot find module). Code defects
  // go back through the outer retry loop as priorDiagnosis so generateCode
  // can see the compile-time error and patch its output. Infra failures are
  // logged and the pipeline continues (the template is saved; a later cold
  // start or manual activate will pick it up).
  //
  // This is the learning-loop closer for the "Lambda compiler disagrees
  // with our generator" class of bugs — the one area where no pre-splice
  // validator can check because the wrap is applied by Edison's Lambda
  // build, not by anything we own.
  ctx.activationFailure = null;
  if (!activation.ok) {
    const rawErr = String(activation.error || '').slice(0, 1500);
    const CODE_DEFECT_PATTERNS = [
      /SyntaxError/i,
      /Unexpected token/,
      /ReferenceError/,
      /TypeError:.+is not a function/,
      /Cannot find (?:module|package)/i,
      /EINVALIDPACKAGENAME/i,
      /Invalid package name/i,
      /node --check/i,
    ];
    const isCodeDefect = CODE_DEFECT_PATTERNS.some((re) => re.test(rawErr));
    if (isCodeDefect) {
      // Fetch flow logs for richer context — we want the full stack frame
      // and compile error surrounding line, not just activation.error.
      let activationLogs = null;
      try {
        const { fetchStageLogs } = require('./flowLogs');
        activationLogs = await fetchStageLogs(ctx.flowId, {
          tailChars: 6000, maxErrorSnippets: 10, limit: 30, maxPolls: 4,
        });
      } catch { /* best effort */ }
      ctx.activationFailure = {
        category: 'code-defect',
        error: rawErr,
        errorType: activation.errorType || null,
        logs: activationLogs,
      };
      ctx.log(`  [activation] CODE DEFECT detected — will be fed back to generateCode as priorDiagnosis for outer retry`);
    } else {
      ctx.activationFailure = {
        category: 'infra',
        error: rawErr,
        errorType: activation.errorType || null,
      };
      ctx.log(`  [activation] failure classified as INFRA — will not trigger code retry`);
    }
  }

  ctx.validationResult = {
    flowVersion, saved: true, viaSplice: true,
    runtimeActivated: activation.ok,
    activationFailure: ctx.activationFailure,
    safeSplice: safeSpliceDelta ? {
      ok: safeSpliceOk,
      newErrors: safeSpliceDelta.newErrors.length,
      newWarnings: safeSpliceDelta.newWarnings.length,
      resolvedErrors: safeSpliceDelta.resolvedErrors.length,
      resolvedWarnings: safeSpliceDelta.resolvedWarnings.length,
    } : { skipped: true },
    fixLoop: { iterations: fixLoopIterations, fixesApplied },
  };
  return endStage(s, {
    flowVersion, saved: true, viaSplice: true,
    runtimeActivated: activation.ok,
    runtimeActivationSec: activation.elapsedSec,
    activationFailure: ctx.activationFailure,
    safeSplice: ctx.validationResult.safeSplice,
    fixLoop: ctx.validationResult.fixLoop,
  });
}

// stageTestStep — run scenario-based tests against the deployed step endpoint.
//
// Scenarios come from, in order of preference:
//   1. `## Test Scenarios` JSON block in the playbook (caller-curated)
//   2. Derived from spec (auto: missing-required-field + happy-path smoke)
//
// For each scenario: POST → poll → compare response against `expect`.
// Results persisted to ctx.testResults and job-dir artifact test-results.json.
// Pipeline continues even on test failures — the outer retry loop (gap #13,
// future work) reads ctx.testResults to decide whether to re-run upstream
// stages. For now, stage succeeds if the runner COMPLETED (regardless of
// pass/fail ratio) so --stop-after testStep always reaches designUI.
//
// Matches the user's pipeline spec beats:
//   * "Test flow is created"       (pipeline-local runner for now; extract
//                                    to a dedicated Edison flow in phase 2)
//   * "Flow is tested using test flow"
async function stageTestStep(ctx) {
  const s = startStage('testStep');

  // Need a live gateway path to test against.
  const gatewayPath = ctx.httpPath || ctx.validationResult?.httpPath || null;
  if (!gatewayPath) {
    ctx.log('  No gateway path on ctx — skipping step tests (validate stage did not report httpPath)');
    return endStage(s, { skipped: true, reason: 'no gateway path' });
  }

  const { parseScenariosFromPlaybook, deriveScenariosFromSpec, runScenarios } = require('./stepScenarios');

  // Source scenarios
  let scenarios = null;
  let source = null;
  if (typeof ctx.bestPlan === 'string' && ctx.bestPlan.length > 0) {
    scenarios = parseScenariosFromPlaybook(ctx.bestPlan);
    if (scenarios && scenarios.length > 0) source = 'playbook';
  }
  if (!scenarios || scenarios.length === 0) {
    // Pick the spec that matches what's ACTUALLY deployed. Priority:
    //   1. Harnessed template's formBuilder — 1-to-1 with deployed step's
    //      this.data reads. If the LLM generated code with 13 inputs but
    //      Conceive's spec-extractor only caught 2, the formBuilder has
    //      all 13 (built from the code's actual usage). Using Conceive's
    //      spec would produce happy-path scenarios that omit 11 inputs,
    //      which the step legitimately rejects with MISSING_INPUT on
    //      fields nobody remembered to populate.
    //   2. Conceive spec (ctx.conceiveSpec) — lighter-weight, works when
    //      the template hasn't been built yet (testStep running standalone).
    //   3. buildSpecFromPlaybook fallback (weakest parser).
    let spec;
    let specSource;
    const tplInputs = ctx.harnessedTemplate?.formBuilder?.stepInputs || ctx.deployedTemplate?.formBuilder?.stepInputs || null;
    if (Array.isArray(tplInputs) && tplInputs.length > 0) {
      // Convert formBuilder stepInputs → spec.inputs shape deriveScenariosFromSpec expects.
      const COMPONENT_TO_TYPE = {
        formTextInput: 'text', formTextBox: 'text', formTextArea: 'textarea', formTextarea: 'textarea',
        formNumber: 'number', formNumberInput: 'number', formSwitch: 'boolean', formCheckbox: 'boolean',
        formSelectExpression: 'select', formSelect: 'select', formRadio: 'select',
        formDate: 'date', formCode: 'code', formJson: 'json',
        'auth-external-component': 'auth',
      };
      const convertedInputs = tplInputs.map(inp => {
        const comp = Array.isArray(inp.component) ? inp.component[0] : (inp.component || '');
        const d = inp.data || {};
        const type = COMPONENT_TO_TYPE[comp] || 'text';
        // Extract options for select
        let options;
        if (Array.isArray(d.options)) {
          options = d.options.map(o => typeof o === 'object' ? { value: o.value, label: o.label } : { value: o, label: o });
        }
        return {
          variable: d.variable,
          label: d.label || d.variable,
          type,
          required: d.validateRequired === true,
          default: d.defaultValue,
          example: d.example,
          helpText: d.helpText || '',
          options,
        };
      }).filter(i => i.variable);
      spec = {
        name: ctx.harnessedTemplate?.name || ctx.deployedTemplate?.name || 'step',
        label: ctx.harnessedTemplate?.label || ctx.deployedTemplate?.label || 'Step',
        description: ctx.harnessedTemplate?.description || '',
        inputs: convertedInputs,
        exits: ctx.harnessedTemplate?.data?.exits || ctx.deployedTemplate?.data?.exits || [],
      };
      specSource = 'template';
    } else if (ctx.conceiveSpec && typeof ctx.conceiveSpec === 'object' && (ctx.conceiveSpec.label || ctx.conceiveSpec.name)) {
      spec = ctx.conceiveSpec;
      specSource = 'conceive';
    } else {
      spec = buildSpecFromPlaybook(ctx.bestPlan, ctx.objective);
      specSource = 'playbook-parser';
    }
    ctx.log(`  Spec source for scenarios: ${specSource} (${(spec.inputs || []).length} input(s))`);
    scenarios = deriveScenariosFromSpec(spec);
    source = 'spec-derived:' + specSource;
  }

  if (!scenarios || scenarios.length === 0) {
    ctx.log('  No scenarios available (neither playbook section nor spec-derivable) — skipping tests');
    return endStage(s, { skipped: true, reason: 'no scenarios', source });
  }

  ctx.log(`  Running ${scenarios.length} scenario(s) from ${source} against /${gatewayPath}`);

  const results = await runScenarios(BASE_URL, gatewayPath, scenarios, {
    log: ctx.log,
    pollDelayMs: 2500,
    maxPolls: 20,
  });

  const passed = results.filter(r => r.ok).length;
  const failed = results.length - passed;
  ctx.log(`\n  Test summary: ${passed}/${results.length} passed, ${failed} failed`);

  // Flow-log forensics on scenario failures. When a scenario returns 404,
  // 5xx, or an unexpected code, fetch the deployed step's flow logs so the
  // test result carries the actual stack trace. Critical for outer-retry:
  // stage 13 will pipe these into generateCode's patchInstructions instead
  // of only the "code=FOO mismatch" one-liner.
  //
  // Lambda logs can lag — the fetchStageLogs helper has a propagation
  // delay + retry-on-empty that handles the 5-15s gap.
  if (failed > 0 && ctx.flowId) {
    try {
      const { fetchStageLogs, formatLogsSnapshot } = require('./flowLogs');
      ctx.log(`  [flow-logs] capturing deployed-step logs for ${failed} failed scenario(s)...`);
      const snapshot = await fetchStageLogs(ctx.flowId, {
        tailChars: 5000, maxErrorSnippets: 10, limit: 25, maxPolls: 6,
      });
      if (snapshot.ok && snapshot.errorCount > 0) {
        ctx.log(formatLogsSnapshot(snapshot, { maxSnippets: 5 }));
      } else if (!snapshot.ok) {
        ctx.log(`  [flow-logs] unavailable: ${snapshot.reason}`);
      } else {
        ctx.log(`  [flow-logs] ${snapshot.textLength} chars, no error flags`);
      }
      // Attach the same snapshot to every failed scenario so test-results.json
      // downstream consumers (outer retry, playbook-view) can pull it without
      // re-fetching. Passing scenarios skip it (passing scenarios = working
      // code = no forensics needed).
      for (const r of results) {
        if (!r.ok) r.flowLogs = snapshot;
      }
    } catch (err) {
      ctx.log(`  [flow-logs] capture failed (continuing): ${err.message}`);
    }
  }

  ctx.testResults = {
    source,
    gatewayPath,
    totalScenarios: scenarios.length,
    passed,
    failed,
    results,
    runAt: new Date().toISOString(),
  };

  return endStage(s, {
    source,
    totalScenarios: scenarios.length,
    passed,
    failed,
    allPassed: failed === 0,
  });
}

async function stageDesignUI(ctx) {
  const s = startStage('designUI');
  const alive = await checkEndpointAlive('designStep', ctx.log);
  if (!alive) {
    throw new Error('Design Step flow is inactive. Activate it first.');
  }
  ctx.log('  Building async module UI...');

  // playbookID is required in the body so the design-step flow can use it
  // as its per-playbook KV collection name. Without it, the flow's poll
  // step tries `storage.get(undefined, jobId)` and returns "Invalid key
  // name: cannot be undefined" — the "no job found" symptom we were
  // seeing on every run. Same pattern generateCode + conceive follow.
  // Forward the caller's Anthropic credential when available — matches
  // Conceive Step's pattern. DesignStep v2.1.3+ treats body.apiKey as
  // priority-1 in _resolveApiKey, falling back to the auth-external-component
  // on the step. This lets the pipeline run regardless of whether the
  // Anthropic auth collection is populated on the design-step flow itself.
  const body = {
    action: 'buildAsyncUI',
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    uiPlan: ctx.bestPlan,
    playbookID: ctx.playbookID,
    playbookCollection: ctx.playbookCollection || 'playbooks',
    playbookKey: ctx.playbookKey || ctx.playbookID,
  };
  const envKey = ctx.opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (envKey) body.apiKey = envKey;

  const result = await callAsyncFlow('designStep', body, asyncFlowOpts(ctx));

  ctx.uiResult = result;
  const status = result.result?.status || result.status || 'unknown';
  ctx.log(`  UI build status: ${status}`);

  return endStage(s, { status });
}

async function stageUserVerify(ctx) {
  const s = startStage('userVerify');
  const studioUrl = `https://studio.edison.onereach.ai/flows/${ctx.flowId}`;
  ctx.log(`\n  *** USER ACTION REQUIRED ***`);
  ctx.log(`  Open the step in Edison Studio:`);
  ctx.log(`    ${studioUrl}`);
  ctx.log(`  Inspect the UI, take a screenshot, then add tag "Ready For UI Testing"`);
  ctx.log(`  Waiting for tag...\n`);

  // TODO: poll flow metadata for the tag
  // For now, just pause
  ctx.log('  [stub] User verify stage — skipping poll, proceeding');

  return endStage(s, { studioUrl });
}

async function stageTestWithUI(ctx) {
  const s = startStage('testWithUI');

  // ── safe-splice pre-check: capture baseline validation state before we modify
  // the flow, so we can diff diagnostics after splice and refuse to declare
  // success when the modification makes the flow strictly worse (CLAUDE.md rule).
  // Runs /validate-flow-v3 — this can take ~2-3 min on large flows.
  let spliceBaseline = null;
  try {
    const { validateFlow } = require('./safe-splice');
    ctx.log('  [safe-splice] capturing baseline validation...');
    spliceBaseline = await validateFlow(ctx.flowId, { log: ctx.log });
    ctx.log('  [safe-splice] baseline: ' + JSON.stringify(spliceBaseline.counts || { errors: 0 }));
  } catch (err) {
    ctx.log('  [safe-splice] baseline validation failed (continuing anyway): ' + err.message);
  }

  ctx.log('  Splicing template into flow + activating...');

  // Build the splice request — needs flowUrl and the full template JSON
  const spliceBody = { flowUrl: ctx.flowId };
  if (ctx.harnessResult?.template) {
    const tpl = JSON.parse(JSON.stringify(ctx.harnessResult.template));
    const ALLOWED = new Set(['id','version','cacheVersion','label','icon','iconType','iconUrl','shape','description','isGatewayStep','publishedBy','categories','recommended','tags','template','form','formBuilder','data','reporting','outputExample','help','modules','dateCreated','dateModified','rawMode','tour','migrations','hooks']);
    for (const k of Object.keys(tpl)) { if (!ALLOWED.has(k)) delete tpl[k]; }
    if (!tpl.form) tpl.form = { component: null };

    // Enforce Edison DB varchar(255) limits before sending to splice
    if (typeof tpl.description === 'string' && tpl.description.length > 255) {
      tpl.description = tpl.description.slice(0, 252) + '...';
      ctx.log('  Truncated description to 255 chars');
    }
    if (typeof tpl.iconUrl === 'string' && tpl.iconUrl.length > 255) {
      tpl.iconType = 'default';
      tpl.icon = 'code';
      tpl.iconUrl = '';
      ctx.log('  Icon URL exceeded 255 chars — switched to default Material icon');
    }

    spliceBody.template = JSON.stringify(tpl);
  }
  spliceBody.activate = true;
  // Pass playbook KV context so splice-step v3.4.0+ writes stages.splice.
  if (ctx.playbookID) {
    spliceBody.playbookID = ctx.playbookID;
    spliceBody.playbookCollection = ctx.playbookCollection || 'playbooks';
    spliceBody.playbookKey = ctx.playbookKey || ctx.playbookID;
  }

  const result = await callAsyncFlow('spliceStep', spliceBody, asyncFlowOpts(ctx));

  // Verify splice result
  const spliceResult = result.result || result;
  const flowId = spliceResult.flowId;
  const stepId = spliceResult.stepId;
  const label = spliceResult.label;
  const gatewayConfigured = spliceResult.gatewayConfigured;

  if (spliceResult.status === 'error') {
    const errMsg = spliceResult.message || spliceResult.jobId || 'unknown splice error';
    ctx.log(`  SPLICE FAILED: ${errMsg}`);
    throw new Error(`Splice failed: ${errMsg}`);
  }

  if (!flowId) {
    ctx.log('  SPLICE FAILED: no flowId in response');
    ctx.log('  Response: ' + JSON.stringify(spliceResult).slice(0, 300));
    throw new Error('Splice returned no flowId');
  }

  ctx.log(`  Splice OK: flow=${flowId.slice(0, 8)} step=${(stepId || '?').slice(0, 8)} label=${label} gateway=${gatewayConfigured}`);

  if (!gatewayConfigured) {
    ctx.log('  WARNING: gateway not configured — step inputs may not be wired from HTTP body');
  }

  // Force runtime activation so the smoke test below actually hits the new
  // template. Splice's own activate:true doesn't redeploy the Lambda —
  // without this call the smoke test either races the cold start or gets
  // a stale response. See known-issues.js:SPLICE_WITHOUT_RUNTIME_ACTIVATION.
  const activation = await activateFlowRuntime(ctx.flowId, { log: ctx.log });

  // --- Post-splice endpoint smoke test ---
  const gatewayPath = spliceResult.gatewayPath;
  if (gatewayPath) {
    ctx.log(`  Smoke-testing endpoint /${gatewayPath}...`);
    // activateFlowRuntime already waited for the full deploy (~45s); only
    // the tiny remainder of edge-cache propagation matters now.
    await new Promise(r => setTimeout(r, 2000));
    try {
      const testUrl = `${BASE_URL}/${gatewayPath}`;
      const probe = await fetch(testUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      if (probe.status === 404) {
        ctx.log('  ENDPOINT TEST FAILED: 404 — flow may not be active');
      } else {
        const probeBody = await probe.text().catch(() => '');
        const hasJobId = probeBody.includes('jobId') || probeBody.includes('jobID');
        ctx.log(`  Endpoint responded: HTTP ${probe.status}${hasJobId ? ' (async jobId returned)' : ''}`);
      }
    } catch (e) {
      ctx.log(`  Endpoint test error: ${e.message}`);
    }
  } else {
    ctx.log('  No gatewayPath in splice result — skipping endpoint test');
  }

  // ── safe-splice post-check: re-validate and diff against baseline.
  // Regressions are logged loudly but do NOT throw — existing pipeline flow
  // is preserved. Caller can inspect stageResult.data.safeSplice.delta to
  // decide how to react.
  let safeSpliceDelta = null;
  let safeSpliceOk = true;
  if (spliceBaseline) {
    try {
      const { validateFlow, diffDiagnostics, printDelta } = require('./safe-splice');
      ctx.log('  [safe-splice] re-validating post-splice...');
      const after = await validateFlow(ctx.flowId, { log: ctx.log });
      safeSpliceDelta = diffDiagnostics(spliceBaseline, after);
      const newIssues = safeSpliceDelta.newErrors.length + safeSpliceDelta.newWarnings.length;
      if (newIssues > 0) {
        safeSpliceOk = false;
        ctx.log(`\n  🚨 SAFE-SPLICE REGRESSION: ${safeSpliceDelta.newErrors.length} new error(s), ${safeSpliceDelta.newWarnings.length} new warning(s)`);
        printDelta(safeSpliceDelta, { log: ctx.log });
        ctx.log(`  Baseline version: ${spliceBaseline.flowVersion}`);
        ctx.log(`  Current  version: ${after.flowVersion}`);
        ctx.log(`  Revert manually in Studio if needed (CLAUDE.md forbids saveFlow rollback).`);
      } else {
        ctx.log('  [safe-splice] no regressions introduced ✓');
      }
    } catch (err) {
      ctx.log('  [safe-splice] post-validation failed (continuing anyway): ' + err.message);
    }
  }

  return endStage(s, {
    flowId,
    stepId,
    label,
    gatewayConfigured,
    gatewayPath,
    exitWiring: spliceResult.exitWiring,
    inputs: spliceResult.inputs,
    runtimeActivated: activation.ok,
    runtimeActivationSec: activation.elapsedSec,
    safeSplice: safeSpliceDelta ? {
      ok: safeSpliceOk,
      newErrors: safeSpliceDelta.newErrors.length,
      newWarnings: safeSpliceDelta.newWarnings.length,
      resolvedErrors: safeSpliceDelta.resolvedErrors.length,
      resolvedWarnings: safeSpliceDelta.resolvedWarnings.length,
    } : { skipped: true },
  });
}

async function stageDone(ctx) {
  const s = startStage('done');

  ctx.log('\n  ════════════════════════════════════════════');
  ctx.log('  PIPELINE COMPLETE');
  ctx.log('  ════════════════════════════════════════════');
  ctx.log(`  Flow ID:     ${ctx.flowId || '(not yet created)'}`);
  ctx.log(`  Template ID: ${ctx.templateId || '(not yet created)'}`);
  if (ctx.planEvaluation) {
    ctx.log(`  Plan score:  ${ctx.planEvaluation.bestEvaluation.summary.weightedMean}`);
  }
  ctx.log(`  Stages run:  ${ctx.completedStages.length}`);
  for (const stage of ctx.completedStages) {
    ctx.log(`    ${stage.name.padEnd(18)} ${stage.durationMs}ms`);
  }
  if (ctx.flowId) {
    ctx.log(`\n  Studio: https://studio.edison.onereach.ai/flows/${ctx.flowId}`);
  }

  return endStage(s, {
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    stageCount: ctx.completedStages.length,
  });
}

// ---------------------------------------------------------------------------
// Stage registry
// ---------------------------------------------------------------------------

const STAGE_FNS = {
  playbook: stagePlaybook,
  decompose: stageDecompose,
  templateFinder: stageTemplateFinder,
  conceive: stageConceive,
  generateCode: stageGenerateCode,
  harnessCode: stageHarnessCode,
  localScenarioRun: stageLocalScenarioRun,
  validate: stageValidate,
  testStep: stageTestStep,
  designUI: stageDesignUI,
  userVerify: stageUserVerify,
  testWithUI: stageTestWithUI,
  done: stageDone,
};

// ---------------------------------------------------------------------------
// Pipeline runner
// ---------------------------------------------------------------------------

async function runPipeline(opts = {}) {
  const { stopAfter, resumeFrom, onProgress, onStageStart, onStageError } = opts;

  if (!opts.monitor && (process.env.STEP_PIPELINE_MONITOR === '1' || process.env.STEP_PIPELINE_MONITOR === 'true')) {
    opts.monitor = true;
  }

  const jobId = opts.jobId || generateJobId();

  const ctx = {
    opts,
    jobId,
    playbook: null,
    bestPlan: null,
    objective: null,
    planEvaluation: null,
    templateMatches: null,
    flowId: opts.flowId || null,
    templateId: opts.templateId || null,
    codeGenResult: null,
    harnessResult: null,
    harnessedTemplate: null,
    validationResult: null,
    logResult: null,
    uiResult: null,
    // priorDiagnosis: { reasons: [...], stageData: {...}, lastCode: '...' } — set by
    // the e2e runner on retry so stageGenerateCode can ask the LLM for a patch
    // instead of a blind regenerate.
    priorDiagnosis: opts.priorDiagnosis || null,
    // playbookID is passed to downstream flows (generate-step-code, others)
    // as a KV collection namespace — keeps each playbook's activity in its
    // own collection for cross-flow audit visibility. Falls back to the
    // jobId if the caller didn't provide a caseId.
    playbookID: opts.playbookID || opts.caseId || jobId,
    completedStages: [],
    log: opts.log || console.log,
  };

  if (opts.jobId && resumeFrom) {
    let saved = null;
    let source = 'none';

    try {
      saved = loadJobState(opts.jobId);
      source = 'local';
    } catch (_) {}

    if (!saved) {
      saved = await loadJobFromKV(opts.jobId);
      if (saved) source = 'kv';
    }

    if (saved) {
      ctx.flowId = saved.flowId || ctx.flowId;
      ctx.templateId = saved.templateId || ctx.templateId;
      const origPlaybookPath = path.join(jobDir(opts.jobId), 'playbook-original.md');
      if (fs.existsSync(origPlaybookPath)) {
        ctx.playbook = fs.readFileSync(origPlaybookPath, 'utf8');
      }
      if (saved.bestPlan) {
        ctx.bestPlan = saved.bestPlan;
        const { extractObjective } = require('./stepPlanIteration');
        ctx.objective = extractObjective(saved.bestPlan);
      } else {
        const planMd = loadJobPlan(opts.jobId);
        if (planMd) {
          ctx.bestPlan = planMd;
          const { extractObjective } = require('./stepPlanIteration');
          ctx.objective = extractObjective(planMd);
        }
      }

      const dir = jobDir(opts.jobId);
      const codegenPath = path.join(dir, 'codegen-result.json');
      if (fs.existsSync(codegenPath)) {
        try { ctx.codeGenResult = JSON.parse(fs.readFileSync(codegenPath, 'utf8')); } catch {}
      }
      const validationPath = path.join(dir, 'validation-result.json');
      if (fs.existsSync(validationPath)) {
        try { ctx.validationResult = JSON.parse(fs.readFileSync(validationPath, 'utf8')); } catch {}
      }
      ctx.log(`  Resumed job: ${opts.jobId} (from ${source})`);
      ctx.log(`  Flow ID:     ${ctx.flowId || '(none)'}`);
      ctx.log(`  Template ID: ${ctx.templateId || '(none)'}`);
      ctx.log(`  Last stage:  ${saved.lastStage || '(none)'}`);
    } else {
      ctx.log(`  Warning: job ${opts.jobId} not found locally or in KV`);
    }
  }

  const dir = ensureJobDir(jobId);
  ctx.log(`  Job ID: ${jobId}`);
  ctx.log(`  Job dir: ${dir}`);

  // ── Playbook KV state machine ─────────────────────────────────────────
  // Create (or resume) a playbook KV entry that acts as the pipeline's
  // durable state machine. Each stage reads the current playbook, does its
  // work, and writes its result back to the stage's slot. The handle
  // { id, collection, key } is stored on ctx so stages can update their
  // slot; it\'s also passed into any flow that needs to re-read playbook
  // state (body.playbookID / body.playbookCollection / body.playbookKey).
  //
  // When opts.playbookHandle is provided, we attach to the existing KV
  // entry (used for --resume-from). Otherwise create a fresh one seeded
  // with the source markdown.
  let playbookHandle;
  try {
    const playbookStore = require('./playbookStore');
    if (opts.playbookHandle && opts.playbookHandle.id) {
      playbookHandle = opts.playbookHandle;
      ctx.log(`  Playbook KV: resuming ${playbookHandle.collection}/${playbookHandle.id}`);
    } else {
      // Read the source markdown up front if we have a path. stagePlaybook
      // will re-read it but passing the contents here gets the KV entry
      // seeded immediately.
      let sourceMd = '';
      if (opts.playbookPath) {
        try { sourceMd = fs.readFileSync(opts.playbookPath, 'utf8'); } catch {}
      }
      // Honor caller-supplied playbookID (e.g. WISER Playbooks' existing id)
      // so the KV key matches the upstream system — the WISER UI can pull
      // pipeline state via GET /keyvalue?id=<collection>&key=<wiser-id>
      // without a separate lookup table. Idempotent re-runs preserve prior
      // stages — see playbookStore.ensurePlaybook for semantics.
      //
      // Config (botId/flowUrl) gets merged into playbook.config so flows
      // can read them without needing to be passed explicitly each call.
      // WISER may have already written config to KV — existing values are
      // preserved; CLI-supplied values overlay.
      const configPatch = {};
      if (opts.botId) configPatch.botId = opts.botId;
      if (opts.flowUrl) configPatch.flowUrl = opts.flowUrl;
      playbookHandle = await playbookStore.ensurePlaybook(sourceMd, {
        id: opts.playbookID || undefined,
        collection: opts.playbookCollection || undefined,
        originalPath: opts.playbookPath || null,
        config: Object.keys(configPatch).length > 0 ? configPatch : undefined,
      });
      const createdVerb = playbookHandle.reused ? 'reused existing' : 'created';
      ctx.log(`  Playbook KV: ${createdVerb} ${playbookHandle.collection}/${playbookHandle.id}${playbookHandle.reused ? ` (prior stages: ${playbookHandle.priorStages || 0})` : ''}`);
    }
    ctx.playbookHandle = playbookHandle;
    // Keep playbookID in sync with the KV handle. Downstream flow bodies
    // (generate-step-code's `playbookID` field, conceive's KV audit, etc.)
    // will use this same value so their per-playbook KV writes land in
    // the same collection namespace.
    ctx.playbookID = playbookHandle.id;
    // Also propagate collection + key so every stage body-builder picks up
    // the same shape. Flows default to 'playbooks' collection + id-as-key
    // when these are missing, but being explicit makes `playbook-view`
    // easier to reason about and eliminates off-by-one bugs if we ever
    // want per-pipeline-attempt KV namespacing.
    ctx.playbookCollection = playbookHandle.collection || 'playbooks';
    ctx.playbookKey = playbookHandle.key || playbookHandle.id;
  } catch (err) {
    ctx.log(`  [playbook-kv] WARN: could not create playbook KV entry (${err.message}). Pipeline will proceed but state-machine writes will be skipped.`);
    ctx.playbookHandle = null;
  }

  appendEvent(jobId, {
    type: 'pipeline-started',
    stages: STAGES,
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    studioBase: STUDIO_BASE,
    studioUrl: ctx.flowId ? `${STUDIO_BASE}/${ctx.flowId}` : null,
    playbookPath: opts.playbookPath || null,
    playbookHandle: ctx.playbookHandle || null,
    resumeFrom: resumeFrom || null,
    stopAfter: stopAfter || null,
  });

  // Record the current pipeline job on the playbook KV entry so WISER (or
  // any other consumer) can pull the playbook and immediately know which
  // run to track. Overwrites any prior `job` — previous runs are still
  // findable via the history[] timeline (pipeline-started events record
  // their own jobId too).
  if (ctx.playbookHandle) {
    try {
      const pbStore = require('./playbookStore');
      await pbStore.setJob(ctx.playbookHandle, {
        id: jobId,
        startedAt: new Date().toISOString(),
        status: 'running',
        resumeFrom: resumeFrom || null,
        stopAfter: stopAfter || null,
        completedAt: null,
      });
      await pbStore.appendHistory(ctx.playbookHandle, {
        event: 'pipeline-started',
        note: `job=${jobId}${resumeFrom ? ` resumeFrom=${resumeFrom}` : ''}${stopAfter ? ` stopAfter=${stopAfter}` : ''}`,
      });
    } catch (err) {
      ctx.log(`  [playbook-kv] WARN: could not write job pointer (${err.message})`);
    }
  }

  // ── Outer retry loop ─────────────────────────────────────────────────
  // Wraps the stage-iteration so we can re-enter from a later stage (e.g.
  // generateCode) when testStep reports scenario failures. Matches the user's
  // pipeline-spec beat #13: "if failed goes back through the pipeline up to
  // three times."
  //
  // Retry trigger: ctx.testResults.failed > 0 after a full run. We accumulate
  // failure context into ctx.priorDiagnosis so the re-run of generateCode can
  // ask the LLM for a corrective patch. Conceive/decompose/templateFinder
  // outputs are preserved across retries (no need to re-clone the flow).
  //
  // Cap: 3 attempts total (1 initial + 2 retries). If still failing after 3,
  // we ship and let the user inspect test-results.json.
  const MAX_OUTER_ATTEMPTS = 3;
  let outerAttempt = 0;
  let pipelineError = null;
  let currentResumeFrom = resumeFrom;

  while (outerAttempt < MAX_OUTER_ATTEMPTS) {
    outerAttempt++;
    let started = !currentResumeFrom;
    let stoppedEarly = false;
    let innerError = null;

    if (outerAttempt > 1) {
      ctx.log(`\n${'═'.repeat(60)}`);
      ctx.log(`  OUTER RETRY ${outerAttempt}/${MAX_OUTER_ATTEMPTS} — re-entering at ${currentResumeFrom}`);
      ctx.log(`  Carrying ${ctx.priorDiagnosis?.reasons?.length || 0} test failure(s) as patch instructions`);
      ctx.log(`${'═'.repeat(60)}`);
      appendEvent(jobId, {
        type: 'outer-retry-started',
        attempt: outerAttempt,
        resumeFrom: currentResumeFrom,
        testFailures: ctx.priorDiagnosis?.reasons?.length || 0,
      });
    }

    try {
      for (const stageName of STAGES) {
        if (!started) {
          if (stageName === currentResumeFrom) {
            started = true;
          } else {
            if (outerAttempt === 1) appendEvent(jobId, { type: 'stage-skipped', stage: stageName });
            continue;
          }
        }

        const fn = STAGE_FNS[stageName];
        if (!fn) throw new Error(`No implementation for stage: ${stageName}`);

        ctx.log(`\n[${'='.repeat(60)}]`);
        ctx.log(`[STAGE] ${stageName}${outerAttempt > 1 ? ` (outer attempt ${outerAttempt}/${MAX_OUTER_ATTEMPTS})` : ''}`);
        ctx.log(`[${'='.repeat(60)}]`);

        ctx.currentStage = stageName;
        const stageStartedAt = Date.now();
        appendEvent(jobId, { type: 'stage-started', stage: stageName, outerAttempt });

        if (onStageStart) {
          try { onStageStart({ stage: stageName, jobId, at: stageStartedAt, outerAttempt }); } catch {}
        }

        // Playbook KV: mark stage running. Non-fatal — if KV is unreachable
        // the pipeline still runs, just loses durable state tracking.
        if (ctx.playbookHandle) {
          try {
            const playbookStore = require('./playbookStore');
            await playbookStore.updateStage(ctx.playbookHandle, stageName, {
              status: 'running',
              note: outerAttempt > 1 ? `outer-retry ${outerAttempt}/${MAX_OUTER_ATTEMPTS}` : null,
            });
          } catch (err) {
            ctx.log(`  [playbook-kv] stage-start update failed (continuing): ${err.message}`);
          }
        }

        let stageResult;
        try {
          stageResult = await fn(ctx);
        } catch (err) {
          const errMsg = (err && err.message) || String(err);
          appendEvent(jobId, {
            type: 'stage-error', stage: stageName,
            durationMs: Date.now() - stageStartedAt, error: errMsg,
            outerAttempt,
          });
          if (onStageError) {
            try { onStageError({ stage: stageName, jobId, error: errMsg, outerAttempt }); } catch {}
          }
          // Flow-log capture on error — ALWAYS grab logs when a stage
          // throws, so the KV entry has forensics for post-mortem diagnosis
          // even when the pipeline aborts here.
          let errorLogs = null;
          const errStageFlowId = STAGE_FLOW_IDS[stageName];
          if (errStageFlowId) {
            try {
              const { fetchStageLogs, formatLogsSnapshot } = require('./flowLogs');
              ctx.log(`  [flow-logs] capturing ${stageName} logs after error (flow=${errStageFlowId.slice(0, 8)})...`);
              errorLogs = await fetchStageLogs(errStageFlowId, {
                tailChars: 6000, maxErrorSnippets: 12, limit: 30, maxPolls: 6,
              });
              if (errorLogs.ok && errorLogs.errorCount > 0) {
                ctx.log(formatLogsSnapshot(errorLogs, { maxSnippets: 5 }));
              }
            } catch { /* don\'t mask the real stage error */ }
          }
          // Playbook KV: record the error + any logs we got for it
          if (ctx.playbookHandle) {
            try {
              const playbookStore = require('./playbookStore');
              await playbookStore.updateStage(ctx.playbookHandle, stageName, {
                status: 'error',
                note: errMsg.slice(0, 300),
                logs: errorLogs,
              });
            } catch { /* KV failure shouldn\'t hide the real error */ }
          }

          // ── Diagnose & fix: pull library reference steps, diff against
          //    broken state, attach priorDiagnosis for the NEXT outer-retry
          //    generateCode attempt. Library-only (per user directive
          //    2026-04-22); never pulls from local account. See
          //    lib/stageDiagnose.js for classification + diff logic.
          try {
            const { diagnose } = require('./stageDiagnose');
            const libraryClient = require('./libraryClient');
            // Initialize library client if not already; cached by libraryClient.
            const client = await libraryClient.init().catch(() => null);
            // Best-effort: broken step's current state (not always available
            // for every stage; diagnose tolerates nulls).
            let stepInstance = null;
            let template = null;
            try {
              if (ctx.flowId) {
                const dh = require('./deployHelper');
                const token = await dh.getToken();
                const flowsApi = dh.initFlowsApi(token);
                const flow = await flowsApi.getFlow(ctx.flowId);
                const steps = flow.data?.trees?.main?.steps || [];
                stepInstance = steps.find(s => s.label && (s.label.includes(stageName) || s.id === ctx.placeholderStepId)) || steps[0];
                const tpls = flow.data?.stepTemplates || [];
                template = tpls.find(t => t.id === stepInstance?.type)?.template || null;
              }
            } catch { /* best effort — diagnose works without */ }
            const diagnosis = await diagnose({
              stage: stageName,
              error: errMsg,
              stepInstance,
              template,
              libraryClient, client,
              log: (m) => ctx.log(`  [diagnose] ${m}`),
            });
            if (diagnosis.priorDiagnosis) {
              ctx.log(`  [diagnose] class=${diagnosis.failureClass}; ${diagnosis.findings.length} finding(s); attaching to ctx.priorDiagnosis for next retry`);
              // Merge with any existing priorDiagnosis from prior attempts.
              const existing = ctx.priorDiagnosis || { reasons: [], diagnostics: [] };
              ctx.priorDiagnosis = {
                reasons: [...(existing.reasons || []), ...diagnosis.priorDiagnosis.reasons],
                diagnostics: [...(existing.diagnostics || []), ...diagnosis.priorDiagnosis.diagnostics],
                phase: 'diagnose',
                failureClass: diagnosis.failureClass,
                references: diagnosis.priorDiagnosis.references,
              };
              appendEvent(jobId, {
                type: 'diagnose-findings',
                stage: stageName,
                failureClass: diagnosis.failureClass,
                findingCount: diagnosis.findings.length,
                references: diagnosis.priorDiagnosis.references?.map(r => r.label),
              });
            } else {
              ctx.log(`  [diagnose] class=${diagnosis.failureClass}; no actionable findings`);
            }
          } catch (diagErr) {
            // Diagnose is never allowed to hide the real stage error.
            ctx.log(`  [diagnose] skipped (${diagErr.message?.slice(0, 100)})`);
          }

          innerError = err;
          throw err;
        }
        ctx.completedStages.push(stageResult);

        saveJobState(jobId, ctx);
        await saveJobToKV(jobId, ctx);

        // Flow-log capture — on completion, if this stage invoked an Edison
        // flow AND (took a long time OR stageResult hints at trouble via
        // safeSplice regressions/test failures), fetch the flow's tail logs
        // and attach to the stage KV slot. Gives durable forensics without
        // requiring a CloudWatch dive. Fetch is bounded (~15s max); never
        // throws. Happy-path short-duration stages skip the fetch to keep
        // the pipeline fast.
        let flowLogsSnapshot = null;
        const stageFlowId = STAGE_FLOW_IDS[stageName];
        const stageDurationMs = Date.now() - stageStartedAt;
        const hasRegression = stageResult?.data?.safeSplice && !stageResult.data.safeSplice.ok;
        const hasTestFail = stageResult?.data?.failed > 0;
        const slowStage = stageDurationMs > 60000;
        const shouldCaptureLogs = stageFlowId && (hasRegression || hasTestFail || slowStage);
        if (shouldCaptureLogs) {
          try {
            const { fetchStageLogs, formatLogsSnapshot } = require('./flowLogs');
            ctx.log(`  [flow-logs] capturing ${stageName} logs (flow=${stageFlowId.slice(0, 8)})...`);
            flowLogsSnapshot = await fetchStageLogs(stageFlowId, {
              tailChars: 4000, maxErrorSnippets: 8, limit: 20, maxPolls: 6,
            });
            if (flowLogsSnapshot.ok) {
              if (flowLogsSnapshot.errorCount > 0) {
                ctx.log(formatLogsSnapshot(flowLogsSnapshot, { maxSnippets: 3 }));
              } else {
                ctx.log(`  [flow-logs] ${flowLogsSnapshot.textLength} chars, no error flags`);
              }
            } else {
              ctx.log(`  [flow-logs] unavailable: ${flowLogsSnapshot.reason}`);
            }
          } catch (err) {
            ctx.log(`  [flow-logs] capture failed (continuing): ${err.message}`);
          }
        }

        // Playbook KV: mark stage done with its result data. The data
        // captured here matches what events.ndjson summarizes, but lives
        // durably in KV so it survives restarts + can be read by flows
        // that need to see prior-stage state (once flows migrate to the
        // fetch-and-update pattern).
        if (ctx.playbookHandle) {
          try {
            const playbookStore = require('./playbookStore');
            // KV stage data keeps the FULL stageResult.data (no summary
            // truncation) — WISER Playbooks and other observers may need
            // to render the full extracted spec / derived step plan etc.
            // Events.ndjson (below) uses summarizeForEvent for the telemetry
            // summary where 300-char truncation is appropriate.
            const stageData = stageResult && stageResult.data
              ? stageResult.data
              : null;
            await playbookStore.updateStage(ctx.playbookHandle, stageName, {
              status: 'done',
              data: stageData,
              logs: flowLogsSnapshot,  // null if not captured; structure defined in lib/flowLogs.js
            });
          } catch (err) {
            ctx.log(`  [playbook-kv] stage-done update failed (continuing): ${err.message}`);
          }
        }

        appendEvent(jobId, {
          type: 'stage-completed',
          stage: stageName,
          flowId: ctx.flowId,
          templateId: ctx.templateId,
          studioUrl: ctx.flowId ? `${STUDIO_BASE}/${ctx.flowId}` : null,
          durationMs: stageResult && stageResult.durationMs,
          outerAttempt,
          summary: stageResult && stageResult.data
            ? Object.fromEntries(
                Object.entries(stageResult.data).slice(0, 6).map(([k, v]) => [k, summarizeForEvent(v)])
              )
            : null,
        });

        if (onProgress) onProgress({ stage: stageName, result: stageResult, outerAttempt });

        if (stopAfter && stageName === stopAfter) {
          ctx.log(`\n  Stopped after: ${stageName}`);
          appendEvent(jobId, { type: 'pipeline-stopped', stage: stageName, outerAttempt });
          stoppedEarly = true;
          break;
        }
      }
    } catch (err) {
      pipelineError = err;
      // Outer retry is only about test-failure recovery; on THROWN errors
      // (stage failed to complete) we abort — in-stage retries (harness,
      // generateCode) already handled the recoverable cases, so a thrown
      // error here is a genuine dead-end.
      break;
    }

    // ── Post-run retry decision ──
    // Trigger outer retry on EITHER of two conditions (whichever fires first):
    //   (a) stageValidate detected a code-defect activation failure (the
    //       runtime tried to compile the step's .mjs and hit a SyntaxError /
    //       ReferenceError / missing-module). This is the activation-failure
    //       learning loop — the LLM's code broke at Lambda load, we feed the
    //       compile error back as priorDiagnosis so the next attempt patches
    //       around it.
    //   (b) stageTestStep reported scenario failures (the step activated but
    //       misbehaved against the test suite).
    // Both routes re-enter at generateCode with ctx.priorDiagnosis populated.
    const testResults = ctx.testResults;
    const reachedTestStep = Boolean(testResults);
    const hasTestFailures = reachedTestStep && testResults.failed > 0;
    const hasActivationCodeDefect = ctx.activationFailure && ctx.activationFailure.category === 'code-defect';
    const canRetry = outerAttempt < MAX_OUTER_ATTEMPTS;
    const retryReason = hasActivationCodeDefect ? 'activation-code-defect'
                      : hasTestFailures ? 'test-scenario-failures'
                      : null;

    if (!retryReason || !canRetry || stoppedEarly) {
      if (hasTestFailures && !canRetry) {
        ctx.log(`\n  OUTER RETRY BUDGET EXHAUSTED: ${testResults.failed}/${testResults.totalScenarios} scenario(s) still failing after ${MAX_OUTER_ATTEMPTS} attempts`);
        appendEvent(jobId, {
          type: 'outer-retry-exhausted',
          attempts: outerAttempt,
          failed: testResults.failed,
          total: testResults.totalScenarios,
        });
      }
      if (hasActivationCodeDefect && !canRetry) {
        ctx.log(`\n  OUTER RETRY BUDGET EXHAUSTED: activation still failing with code defect after ${MAX_OUTER_ATTEMPTS} attempts`);
        appendEvent(jobId, {
          type: 'outer-retry-exhausted',
          attempts: outerAttempt,
          reason: 'activation-code-defect',
          error: String(ctx.activationFailure?.error || '').slice(0, 300),
        });
      }
      break;
    }

    // Build priorDiagnosis. Two retry sources feed it:
    //   • activation-code-defect: compile error from Lambda load. This is the
    //     ONE place where generateCode can learn about errors it couldn't
    //     have seen at generate-time (Edison's compile-time template wrap,
    //     missing modules, etc.). Feed it in as the primary diagnostic.
    //   • test-scenario-failures: behavioral mismatch against expect rules.
    //
    // If BOTH are present (unusual — activation failed AND we still ran
    // tests somehow) we include both; the LLM reads them in order.
    const lastCode = ctx.generatedCode || ctx.codeGenResult?.code || '';
    const reasons = [];
    const diagnostics = [];
    const logSnippetMap = new Map();

    if (hasActivationCodeDefect) {
      const af = ctx.activationFailure;
      reasons.push(`[activation-code-defect] Lambda refused to load the compiled step: ${String(af.error || '').slice(0, 400)}`);
      diagnostics.push({
        code: 'ACTIVATION_CODE_DEFECT',
        severity: 'error',
        message: `Lambda activation failed with a compile/load error: ${String(af.error || '').slice(0, 600)}. This means the generated code, after Edison\'s template compile (which wraps stepInputData defaults in \`await (...)\` and does other transforms), does not parse or resolve. Common causes: (1) step.json defaults or formBuilder defaultValue were raw strings instead of backtick-wrapped template literals — e.g. "https://..." produces \`await (https://...)\` which is a SyntaxError; (2) import or require of a module that isn\'t in modules[]; (3) TypeError on this.log.* in the harness if the step code references globals that don\'t exist in Edison\'s runtime.`,
        fix: af.error && /Unexpected token ':'/.test(af.error)
          ? 'Check every stepInput default in step.json: any non-empty string MUST be wrapped in backticks (e.g. `"next_hour"` → "`next_hour`", `"https://..."` → "`https://...`"). Numbers and booleans are fine as-is. If this is already correct in step.json, inspect formBuilder.stepInputs[].data.defaultValue for the same issue.'
          : undefined,
      });
      if (af.logs?.errorSnippets) {
        for (const s of af.logs.errorSnippets) {
          if (!logSnippetMap.has(s.text)) logSnippetMap.set(s.text, s);
        }
      }
    }

    if (hasTestFailures) {
      // Distinguish pre-splice (local runtime) from post-splice (deployed
      // endpoint) so the LLM gets accurate context — "local runtime" means
      // a deterministic subprocess caught the bug before deploy; "deployed
      // endpoint" means the Lambda ran and responded wrong.
      const preSplice = testResults.preSplice === true;
      const runContext = preSplice ? 'local runtime (pre-splice)' : 'deployed endpoint';
      const codeTag = preSplice ? 'local-scenario-failed' : 'test-scenario-failed';
      const diagCode = preSplice ? 'LOCAL_SCENARIO_FAILED' : 'TEST_SCENARIO_FAILED';
      const failures = testResults.results.filter(r => !r.ok);
      for (const f of failures) {
        const actualCode = f.actual?.code || '(no code)';
        const shortDiff = JSON.stringify(f.diff || []).slice(0, 200);
        reasons.push(`[${codeTag}] "${f.name}" — actual.code="${actualCode}", diff=${shortDiff}`);
        let msg;
        if (f.phase === 'local-runtime-error') {
          // Subprocess threw a real error (TypeError, ReferenceError, etc.) —
          // this is code-bug-level and trumps spec mismatch.
          msg = `Scenario "${f.name}" threw a runtime error in ${runContext}: ${String(f.error || '').slice(0, 400)}. This is a hard code defect — the step throws before it can call this.exitStep(). Typical causes: (1) reading a nested property of undefined (e.g. this.data.foo.bar when this.data.foo is not set); (2) calling a method on null; (3) await on a non-promise; (4) ReferenceError from missing import or typo.`;
        } else {
          msg = `Scenario "${f.name}" failed in ${runContext}. Actual: ${JSON.stringify(f.actual).slice(0, 300)}. Diff: ${JSON.stringify(f.diff).slice(0, 200)}`;
        }
        diagnostics.push({
          code: diagCode,
          severity: 'error',
          message: msg,
          fix: f.diff && f.diff[0] && f.diff[0].expectedOneOfOrSuccess
            ? `The step returned code="${f.actual?.code}" but the test expected either success OR one of: ${f.diff[0].expectedOneOfOrSuccess.slice(0,5).join(', ')}. This likely means code has input validation stricter than the spec declared. Check that required fields in the generated code match the spec's required fields exactly.`
            : (f.diff && f.diff[0]) ? `Diff on field "${f.diff[0].field}": expected ${JSON.stringify(f.diff[0].expected || f.diff[0].expectedOneOf || f.diff[0].expectedIncludes)}, got ${JSON.stringify(f.diff[0].actual)}.`
            : undefined,
        });
        for (const s of (f.flowLogs?.errorSnippets || [])) {
          if (!logSnippetMap.has(s.text)) logSnippetMap.set(s.text, s);
        }
      }
    }

    const runtimeLogSnippets = Array.from(logSnippetMap.values()).slice(0, 8);

    ctx.priorDiagnosis = {
      reasons,
      diagnostics,
      runtimeLogSnippets,  // consumed by generateCode patchInstructions when present
      lastCode,
      phase: 'outer-retry',
      trigger: retryReason,  // 'activation-code-defect' | 'test-scenario-failures'
    };
    if (runtimeLogSnippets.length > 0) {
      ctx.log(`  [outer-retry] ${runtimeLogSnippets.length} runtime log snippet(s) piped into priorDiagnosis`);
    }
    ctx.log(`  [outer-retry] reason=${retryReason}, reasons=${reasons.length}, diagnostics=${diagnostics.length}`);

    // Clear testResults AND activationFailure so the retry gets fresh signals
    ctx.testResults = null;
    ctx.activationFailure = null;
    // Restart from generateCode — earlier stages (conceive/decompose/
    // templateFinder) produced a valid flow we want to keep.
    currentResumeFrom = 'generateCode';
    pipelineError = null;
  }

  // Playbook KV: write final deployment summary + append pipeline-completed
  // history entry. This is the last snapshot — after this, the playbook
  // entry is the canonical record of this run.
  if (ctx.playbookHandle) {
    try {
      const playbookStore = require('./playbookStore');
      if (ctx.flowId) {
        await playbookStore.setFlowSummary(ctx.playbookHandle, {
          flowId: ctx.flowId,
          templateId: ctx.templateId,
          httpPath: ctx.httpPath,
          studioUrl: `${STUDIO_BASE}/${ctx.flowId}`,
          flowVersion: ctx.validationResult?.flowVersion,
        });
      }
      // Update the job pointer's final status. WISER UI can now show
      // "Job 2026-04-22... — completed" or "... — failed (<error>)".
      await playbookStore.setJob(ctx.playbookHandle, {
        status: pipelineError ? 'failed' : 'completed',
        completedAt: new Date().toISOString(),
        outerAttempts: outerAttempt,
        stagesCompleted: ctx.completedStages.length,
        error: pipelineError
          ? (pipelineError.message || String(pipelineError)).slice(0, 500)
          : null,
      });
      await playbookStore.appendHistory(ctx.playbookHandle, {
        stage: null,
        event: pipelineError ? 'pipeline-failed' : 'pipeline-completed',
        note: pipelineError
          ? (pipelineError.message || String(pipelineError)).slice(0, 300)
          : `${ctx.completedStages.length} stages, ${outerAttempt} outer attempt(s)`,
      });
    } catch (err) {
      ctx.log(`  [playbook-kv] final-summary write failed: ${err.message}`);
    }
  }

  // Final pipeline event. The outer retry loop already caught thrown
  // stage errors into pipelineError; this is unconditional bookkeeping.
  appendEvent(jobId, {
    type: pipelineError ? 'pipeline-failed' : 'pipeline-completed',
    error: pipelineError ? (pipelineError.message || String(pipelineError)) : null,
    stagesCompleted: ctx.completedStages.length,
    outerAttempts: outerAttempt,
    playbookHandle: ctx.playbookHandle || null,
  });
  if (pipelineError) throw pipelineError;

  return {
    jobId,
    jobDir: dir,
    flowId: ctx.flowId,
    templateId: ctx.templateId,
    bestPlan: ctx.bestPlan,
    objective: ctx.objective,
    stages: ctx.completedStages,
    // Playbook handle (id, collection, key) so WISER's HTTP wrapper can
    // return it to callers AND so callers who only have the return value
    // can immediately re-pull state from KV without tracking jobId separately.
    playbookHandle: ctx.playbookHandle || null,
    playbookID: ctx.playbookID || null,
  };
}

/** Trim a value for safe inclusion in an event (no giant blobs in the feed). */
function summarizeForEvent(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 300 ? v.slice(0, 300) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    const s = JSON.stringify(v);
    return s.length > 300 ? s.slice(0, 300) + '…' : v;
  } catch {
    return '[unserializable]';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  STAGES,
  ENDPOINTS,
  JOBS_DIR,
  BOT_ID,
  STUDIO_BASE,
  callAsyncFlow,
  runPipeline,
  loadJobState,
  loadJobPlan,
  loadJobFromKV,
  saveJobToKV,
  jobDir,
  kvPut,
  kvGet,
  appendEvent,
  // Exposed for unit tests of the pre-splice local scenario stage (fix 2.2b).
  _stageLocalScenarioRun: stageLocalScenarioRun,
};
