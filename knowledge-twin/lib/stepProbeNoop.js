// ---------------------------------------------------------------------------
// stepProbeNoop.js — zero-cost drop-in for stepProbe.js
//
// Exposes the EXACT same API surface as stepProbe.js but does nothing —
// no KV writes, no network, no memory accumulation. Used when probe is
// disabled at runtime via EDISON_STEP_PROBE=off or opts.enabled=false.
//
// The import in generated step code can be either:
//
//   // Runtime-switchable (Level 1 opt-out):
//   const probe = process.env.EDISON_STEP_PROBE === 'off'
//     ? require('./stepProbeNoop')
//     : require('./stepProbe');
//
//   // Or, stepProbe.js itself delegates here when the env flag is set, so:
//   const probe = require('./stepProbe');  // auto-delegates to noop
//
// Either way, the step code below behaves identically; only the latency
// and KV writes differ.
// ---------------------------------------------------------------------------

'use strict';

function start(stepInstance, _opts = {}) {
  const step = stepInstance;
  return {
    mark(_label, _data) { /* noop */ },
    async exit(stepArg, exitId, result) {
      return (stepArg || step).exitStep(exitId, result);
    },
    async exitError(stepArg, err, exitOverride) {
      return (stepArg || step).exitStep(exitOverride || '__error__', {
        code: err?.code || 'STEP_ERROR',
        message: err?.message || String(err),
      });
    },
    _key: null, _kvBase: null, _collection: null,
  };
}

async function wrap(stepInstance, fn, _opts = {}) {
  const trace = start(stepInstance);
  try {
    const result = await fn(trace);
    return await trace.exit(stepInstance, 'next', result);
  } catch (err) {
    return await trace.exitError(stepInstance, err);
  }
}

function redactInputs() { return {}; }
function _mergeTrace(a, b) { return { ...(a || {}), ...(b || {}) }; }
function probeEnabled() { return false; }

module.exports = { start, wrap, redactInputs, _mergeTrace, probeEnabled };
