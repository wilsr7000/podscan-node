// ---------------------------------------------------------------------------
// stageDiagnose.js — "diagnose and fix issues" stage for the pipeline.
//
// When a pipeline stage fails with a symptom, this stage:
//   1. Classifies the failure (auth-resolution, runtime-compile, stepInput
//      wiring, kv-key-undefined, output-shape, etc.)
//   2. Pulls 2-3 reference steps FROM THE EDISON LIBRARY (never local account
//      flows — user directive 2026-04-22) matching the failure class
//   3. Diffs the failing step against the library references on the salient
//      fields (data.auth, stepInputData.auth, formBuilder.stepInputs[...],
//      specific code patterns in template)
//   4. Auto-patches the difference when the fix is deterministic (e.g. "auth
//      stepInput is missing the canonical authData object — copy from
//      reference"), or emits a structured priorDiagnosis report so the
//      generator retry sees "here's what the reference has that you don't"
//      rather than a generic failure string.
//
// Usage — called from runPipeline when a stage throws and the outer retry
// loop is about to fire generateCode again:
//
//   const diagnosis = await diagnose({
//     stage: 'designUI',
//     error: err.message,
//     stepInstance: ctx.designStep,       // current broken step object
//     template: ctx.designTemplate,        // current broken template
//     libraryClient,                        // from libraryClient.init()
//     log: ctx.log,
//   });
//   if (diagnosis.autoFixApplied) {
//     // fix is already written to template — re-splice
//   }
//   if (diagnosis.priorDiagnosis) {
//     ctx.priorDiagnosis = diagnosis.priorDiagnosis;  // feeds generateCode retry
//   }
//
// Failure classifications (extend this as new patterns emerge):
//
//   auth-resolution        — "Anthropic API key required", "Auth resolution failed",
//                           "storage.get returned null", token/credential errors
//   runtime-compile        — SyntaxError, ReferenceError, "Cannot find module"
//   kv-key-undefined       — "Invalid key name: cannot be undefined"
//   stepInput-wiring       — default values not reading from body, merge fields
//                           returning "undefined" literal strings
//   activation-rejected    — REJECTED_TRIGGERS, ENOTEMPTY, infra-level rejection
//   output-shape           — expected field missing from response
//
// Library queries — we search for steps that are KNOWN to solve the pattern:
//   auth-resolution        → "auth anthropic", "credential storage",
//                           "oauth token resolution"
//   runtime-compile        → (none — LLM retry handles)
//   kv-key-undefined       → "set value storage", "get value storage",
//                           "keyvalue"
//   stepInput-wiring       → "http call body", "merge field expression",
//                           "step input default"
//   activation-rejected    → "flow activation", "deploy splice"
//   output-shape           → (none — schema-level; uses validator)
//
// Not every classification has library-based remedies. When there's no
// library match, diagnose returns an empty priorDiagnosis — the caller
// falls back to its normal retry path.
// ---------------------------------------------------------------------------

'use strict';

const CLASS_KEYWORDS = {
  'auth-resolution': ['auth', 'anthropic', 'credential', 'oauth', 'token', 'api key'],
  'kv-key-undefined': ['set value storage', 'keyvalue storage', 'kv key'],
  'stepInput-wiring': ['http call body', 'merge field', 'step input default'],
  'activation-rejected': ['flow activation', 'deploy', 'splice'],
};

/** Classify a failure message into one of the above classes. */
function classify(message) {
  const m = String(message || '').toLowerCase();
  if (/api key required|auth.*failed|authentication|storage\.get.*null|credential/i.test(m)) return 'auth-resolution';
  if (/syntaxerror|referenceerror|cannot find module|einvalidpackagename/i.test(m)) return 'runtime-compile';
  if (/invalid key name.*undefined|kv.*undefined|storage.*undefined/i.test(m)) return 'kv-key-undefined';
  if (/merge field.*undefined|stepinputdata.*undefined|default.*undefined/i.test(m)) return 'stepInput-wiring';
  if (/rejected_triggers|enotempty|activation.*failed|upsertlambda/i.test(m)) return 'activation-rejected';
  return 'unknown';
}

/**
 * Pull 2-3 reference library steps matching the failure class.
 *
 * libraryClient is the already-initialized client from
 *   const libraryClient = require('./libraryClient');
 *   const client = await libraryClient.init();
 *
 * Returns: [{ label, source: 'library', template, formBuilderStepInputs, ... }, ...]
 */
async function fetchReferences(libraryClient, client, failureClass, log) {
  const queries = CLASS_KEYWORDS[failureClass];
  if (!queries) {
    log(`  [diagnose] no library-reference keywords for class "${failureClass}"`);
    return [];
  }
  const results = [];
  for (const q of queries) {
    try {
      const items = await libraryClient.searchSteps(client, q, { take: 3, suppressErrors: true });
      for (const it of items) {
        results.push({ ...it, source: 'library', query: q });
        if (results.length >= 3) return results;
      }
    } catch (err) {
      log(`  [diagnose] library search for "${q}" errored: ${err.message}`);
    }
  }
  return results;
}

/**
 * Diff the broken step against a reference library step. Returns an array of
 * structured findings — each says WHAT differs and WHICH reference had it.
 *
 * Limited field set for now (auth is the common case). Extend as we encounter
 * more classes.
 */
function diffSteps(brokenStep, brokenTemplate, refSteps, failureClass, log) {
  const findings = [];

  if (failureClass === 'auth-resolution') {
    // Check data.auth object shape
    const brokenAuth = brokenStep?.data?.auth;
    for (const ref of refSteps) {
      const refAuth = ref.stepInstance?.data?.auth;
      if (refAuth && typeof refAuth === 'object' && refAuth.auth) {
        if (!brokenAuth || typeof brokenAuth !== 'object' || !brokenAuth.auth) {
          findings.push({
            field: 'step.data.auth',
            severity: 'high',
            summary: 'Broken step has empty/string data.auth; reference "' + (ref.label || ref.name) + '" has a full object with {auth, authData, authSelected, ...}',
            remediation: 'Copy the shape of reference data.auth, preserving credId from stepInputData.auth',
            reference: ref.label || ref.name,
          });
        }
      }
    }

    // Check _resolveApiKey code pattern — the classic "::token:: strip" bug
    if (brokenTemplate && /auth\.split\(['"]::['"]/.test(brokenTemplate)) {
      findings.push({
        field: 'template._resolveApiKey',
        severity: 'high',
        summary: 'Broken template strips ::token:: suffix before storage.get — that breaks the vault lookup because credentials are stored under the FULL id including suffix',
        remediation: 'Remove the auth.split("::")[0] line — pass full id to storage.get',
        reference: 'Conceive Step (known-working pattern)',
      });
    }
  }

  if (failureClass === 'stepInput-wiring') {
    // Look at stepInputData for hardcoded defaults that should merge from body
    const sid = brokenStep?.stepInputData || {};
    for (const [k, v] of Object.entries(sid)) {
      if (typeof v === 'string' && /^`[a-zA-Z0-9_-]+`$/.test(v) && !v.includes('mergeFields')) {
        // Hardcoded-looking default (backticked literal)
        findings.push({
          field: 'stepInputData.' + k,
          severity: 'medium',
          summary: 'Input "' + k + '" has a hardcoded default "' + v + '" — won\'t read from request body',
          remediation: 'Change default to: `${await this.mergeFields[\'httpCall\'].get({path: \'request.body.' + k + '\'})}`',
          reference: null,
        });
      }
    }
  }

  return findings;
}

/**
 * Main entry point. Given a stage failure, produces a diagnosis object.
 *
 * Inputs:
 *   stage           — stage name that failed ('designUI', 'generateCode', ...)
 *   error           — error message / exception string
 *   stepInstance    — the step object from the flow data
 *   template        — the step's template code (string) if available
 *   libraryClient   — the './libraryClient' module
 *   client          — an already-initialized library client (libraryClient.init())
 *   log             — log function
 *
 * Output:
 *   {
 *     failureClass: <one of the classes above>,
 *     references:   [<library steps used for comparison>],
 *     findings:     [{field, severity, summary, remediation, reference}, ...],
 *     autoFixApplied: false,   — we don't apply fixes here yet, but caller can
 *     priorDiagnosis: {        — ready to feed into generateCode retry
 *       reasons:     [...],
 *       diagnostics: [...],
 *       phase:       'diagnose',
 *     },
 *   }
 */
async function diagnose({ stage, error, stepInstance, template, libraryClient, client, log = () => {} }) {
  const failureClass = classify(error);
  log(`[diagnose] stage=${stage} class=${failureClass}`);

  let references = [];
  if (libraryClient && client && failureClass !== 'unknown' && failureClass !== 'runtime-compile') {
    log('[diagnose] fetching library references...');
    references = await fetchReferences(libraryClient, client, failureClass, log);
    log(`[diagnose] pulled ${references.length} library reference(s): ${references.map(r => r.label || r.name).join(', ')}`);
  }

  const findings = diffSteps(stepInstance, template, references, failureClass, log);
  log(`[diagnose] ${findings.length} finding(s): ${findings.map(f => f.field).join(', ')}`);

  const priorDiagnosis = findings.length > 0 ? {
    reasons: findings.map(f => `[${f.severity}] ${f.summary}`),
    diagnostics: findings.map(f => ({
      code: 'DIAGNOSE_' + String(f.field).toUpperCase().replace(/[^A-Z0-9]/g, '_'),
      severity: f.severity === 'high' ? 'error' : 'warning',
      message: f.summary,
      fix: f.remediation,
    })),
    phase: 'diagnose',
    failureClass,
    references: references.map(r => ({ label: r.label || r.name, source: r.source })),
  } : null;

  return { failureClass, references, findings, autoFixApplied: false, priorDiagnosis };
}

module.exports = { diagnose, classify, fetchReferences, diffSteps };
