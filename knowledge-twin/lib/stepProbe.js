// ---------------------------------------------------------------------------
// stepProbe.js — KV-backed step telemetry probe
//
// Injected into pipeline-generated step code by codeHarness when
// `injectProbe: 'runtime' | 'always'`. Records step execution traces to
// the `stepTraces` KV collection, keyed by (playbookID, jobId, stepId), so
// WISER UI and other observers can see what actually happened inside a
// step run without requiring Edison CloudWatch access.
//
// KV key convention:
//   stepTraces/<playbookID>__<jobId>__<stepId>
//
// Multiple calls during one step run MERGE into the same entry — they
// don't overwrite each other. This is important: mark() calls accumulate
// into the `marks` array across the step's lifetime, and the final
// exit()/exitError() bumps durationMs, completedAt, and the terminal
// {exit | error} field without wiping earlier marks.
//
// Three opt-out levels:
//   Level 1 (runtime flag):    set EDISON_STEP_PROBE=off (or pass
//                              opts.enabled=false to probe.start) → returns
//                              a noop trace object with the same API.
//   Level 2 (comment-out):     there's ONE require('./stepProbe') and ONE
//                              probe.start call. Comment both out → probe
//                              gone, step still works.
//   Level 3 (strip markers):   wrap probe-only code in // @probe-begin and
//                              // @probe-end fences, run scripts/strip-probe.js
//                              before shipping to remove the dependency.
//
// Security: inputsAtEntry is redacted — never sends auth tokens, api
// keys, credential values to KV. Default redaction list covers common
// credential-bearing variable names; additional names can be passed via
// opts.secrets.
// ---------------------------------------------------------------------------

'use strict';

const DEFAULT_KV_BASE = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue';
const DEFAULT_COLLECTION = 'stepTraces';
const MAX_MARKS = 200;           // hard cap to keep KV payload bounded
const MAX_FIELD_SIZE = 2000;     // individual field size cap

// Redact these variable names from inputsAtEntry by default. Additional
// names can be added via opts.secrets.
const DEFAULT_SECRETS = new Set([
  'auth', 'apiKey', 'api_key', 'token', 'accessToken', 'refreshToken',
  'password', 'secret', 'clientSecret', 'privateKey', 'bearer',
  'Authorization', 'authorization',
]);

function now() { return new Date().toISOString(); }

/** Limit a value's size so a single mark can't blow out the KV entry. */
function capSize(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > MAX_FIELD_SIZE ? v.slice(0, MAX_FIELD_SIZE) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  try {
    const s = JSON.stringify(v);
    if (s.length <= MAX_FIELD_SIZE) return v;
    return { _truncated: true, preview: s.slice(0, MAX_FIELD_SIZE) + '…' };
  } catch {
    return '[unserializable]';
  }
}

/** Redact secret-bearing fields from a this.data snapshot. */
function redactInputs(data, extraSecrets = []) {
  if (!data || typeof data !== 'object') return {};
  const secretSet = new Set([...DEFAULT_SECRETS, ...extraSecrets]);
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (secretSet.has(k) || /password|secret|token|key|credential/i.test(k)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = capSize(v);
  }
  return out;
}

/** Whether the probe should run. Env override takes precedence. */
function probeEnabled(opts) {
  const env = (typeof process !== 'undefined' && process?.env?.EDISON_STEP_PROBE) || '';
  if (env === 'off' || env === '0' || env === 'false') return false;
  if (opts && opts.enabled === false) return false;
  return true;
}

/** HTTP GET + PUT against /keyvalue, with merge-on-write semantics. */
async function _kvGet(kvBase, collection, key) {
  try {
    const url = `${kvBase}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
    const resp = await fetch(url);
    const data = await resp.json().catch(() => ({}));
    if (!data || data.Status === 'No data found.') return null;
    if (typeof data.value !== 'string' || !data.value) return null;
    try { return JSON.parse(data.value); } catch { return null; }
  } catch {
    return null;
  }
}

async function _kvPut(kvBase, collection, key, value) {
  try {
    const url = `${kvBase}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key, itemValue: JSON.stringify(value) }),
    });
    return !!(resp && resp.ok);
  } catch {
    return false;
  }
}

/**
 * Merge a patch object into the existing KV entry.
 *
 * Rules:
 *   - Scalar fields in `patch` overwrite existing scalars (e.g. updatedAt,
 *     completedAt, durationMs). If patch omits a key, existing value is kept.
 *   - `marks` from patch are APPENDED to existing marks (no overwrite).
 *     Duplicate marks (same label + same atMs) are deduped, so the same
 *     call made twice doesn't create a duplicate record.
 *   - `exit` and `error` from patch replace existing (terminal state — set
 *     once on step completion).
 *   - Unknown top-level keys in the existing entry are PRESERVED (future-
 *     proofing: external observers may add their own fields).
 */
function _mergeTrace(existing, patch) {
  const base = (existing && typeof existing === 'object') ? existing : {};
  const merged = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    if (k === 'marks' && Array.isArray(v)) {
      const prior = Array.isArray(base.marks) ? base.marks : [];
      const existingKeys = new Set(prior.map((m) => `${m.label}|${m.atMs || 0}`));
      const appended = v.filter((m) => !existingKeys.has(`${m.label}|${m.atMs || 0}`));
      merged.marks = [...prior, ...appended].slice(-MAX_MARKS);
    } else {
      merged[k] = v;
    }
  }
  merged.updatedAt = now();
  return merged;
}

/**
 * Start a probe trace for a step. Returns a `trace` object whose methods
 * (mark/exit/exitError) are wrapped in try/catch so probe failures can
 * never crash the step itself.
 *
 * Call with `this` as the step instance — that gives us step.exitStep for
 * wrapping, this.log for warnings, and this.data for inputsAtEntry.
 */
function start(stepInstance, opts = {}) {
  // Level 1 opt-out: env flag OR opts.enabled === false
  if (!probeEnabled(opts)) {
    return require('./stepProbeNoop').start(stepInstance, opts);
  }

  const step = stepInstance;
  const playbookID = (opts.playbookID || step?.data?.playbookID || '').toString().trim() || 'unknown-playbook';
  const jobId = (opts.jobId || step?.data?.jobId || '').toString().trim() || 'unknown-job';
  const stepId = (opts.stepId || step?.data?._stepId || step?._id || '').toString().trim()
                || `${opts.stepLabel || step?.constructor?.name || 'step'}-${Date.now()}`;

  const kvBase = opts.kvBase || DEFAULT_KV_BASE;
  const collection = opts.collection || DEFAULT_COLLECTION;
  const key = `${playbookID}__${jobId}__${stepId}`;

  const startedAt = now();
  const t0 = Date.now();
  const inputsAtEntry = redactInputs(step?.data || {}, opts.secrets || []);

  // Seed the entry immediately so external observers see "step X started"
  // even if it crashes before mark(). Best-effort; failures don't throw.
  const seedPatch = {
    playbookID, jobId, stepId,
    stepLabel: opts.stepLabel || step?.constructor?.name || null,
    flowId: opts.flowId || step?.flowId || null,
    startedAt,
    inputsAtEntry,
    marks: [],
    env: {
      nodeVersion: typeof process !== 'undefined' ? process.version : null,
    },
  };

  // Fire-and-forget seed — don't block step execution on network
  _kvGet(kvBase, collection, key)
    .then((prior) => _kvPut(kvBase, collection, key, _mergeTrace(prior, seedPatch)))
    .catch(() => {});

  const marks = [];
  let closed = false;

  async function mark(label, data) {
    if (closed) return;
    const entry = {
      label: String(label || 'mark').slice(0, 100),
      at: now(),
      atMs: Date.now() - t0,
      data: capSize(data),
    };
    marks.push(entry);
    // Best-effort KV write (merge with existing)
    try {
      const prior = await _kvGet(kvBase, collection, key);
      await _kvPut(kvBase, collection, key, _mergeTrace(prior, { marks: [entry] }));
    } catch (err) {
      if (step?.log?.warn) step.log.warn('probe.mark failed (non-blocking)', { error: err?.message });
    }
  }

  /** Finish the trace on success. Calls step.exitStep with the original args. */
  async function exit(stepArg, exitId, result) {
    const s = stepArg || step;
    if (closed) return s.exitStep(exitId, result);
    closed = true;
    const completedAt = now();
    const terminal = {
      completedAt,
      durationMs: Date.now() - t0,
      exit: { type: String(exitId || 'next'), payload: capSize(result) },
      marks,
    };
    try {
      const prior = await _kvGet(kvBase, collection, key);
      await _kvPut(kvBase, collection, key, _mergeTrace(prior, terminal));
    } catch (err) {
      if (s?.log?.warn) s.log.warn('probe.exit KV write failed', { error: err?.message });
    }
    return s.exitStep(exitId, result);
  }

  /** Finish the trace on error. Calls step.exitStep('__error__', ...). */
  async function exitError(stepArg, err, exitOverride) {
    const s = stepArg || step;
    if (closed) return s.exitStep(exitOverride || '__error__', { message: err?.message || String(err) });
    closed = true;
    const completedAt = now();
    const terminal = {
      completedAt,
      durationMs: Date.now() - t0,
      error: {
        message: err?.message || String(err),
        name: err?.name || 'Error',
        stack: capSize(err?.stack),
      },
      marks,
    };
    try {
      const prior = await _kvGet(kvBase, collection, key);
      await _kvPut(kvBase, collection, key, _mergeTrace(prior, terminal));
    } catch (werr) {
      if (s?.log?.warn) s.log.warn('probe.exitError KV write failed', { error: werr?.message });
    }
    return s.exitStep(exitOverride || '__error__', {
      code: err?.code || 'STEP_ERROR',
      message: err?.message || String(err),
    });
  }

  return { mark, exit, exitError, _key: key, _kvBase: kvBase, _collection: collection };
}

/** Convenience wrapper: wrap an entire step body so authors only write
 *  business logic, not try/catch + exit. */
async function wrap(stepInstance, fn, opts = {}) {
  const trace = start(stepInstance, opts);
  try {
    const result = await fn(trace);
    return await trace.exit(stepInstance, 'next', result);
  } catch (err) {
    return await trace.exitError(stepInstance, err);
  }
}

module.exports = {
  start,
  wrap,
  redactInputs,
  // internals exported for tests
  _mergeTrace,
  _kvGet,
  _kvPut,
  probeEnabled,
};
