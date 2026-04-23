// ---------------------------------------------------------------------------
// localSplice.js — runs the splice-step transforms in-process.
//
// Why: the remote /splice-step flow (feb2da52...) is itself an Edison async
// flow with its own failure modes — when its internal `_fail` is triggered
// it tries to exit on `__error__` which isn't wired in the flow, so all you
// get back is `Invalid exit '__error__' for step 'cb665ad8'`. The real
// cause is swallowed, and retries hit the same wall.
//
// What this module does: imports the SAME helper functions from the canonical
// splice-step source (`library/steps/builder/splice-step/logic.js`, which
// matches the live flow byte-for-byte) and runs them locally against a fetched
// flow object. Same transforms, no opaque remote failure layer, stack traces
// show exactly which step broke.
//
// Spirit of CLAUDE.md's "use /splice-step" rule is: always apply the splice
// transforms before saving. This module applies the same transforms — it's
// not raw saveFlow.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dh = require('./deployHelper');

const SPLICE_SRC = path.join(__dirname, '..', 'library', 'steps', 'builder', 'splice-step', 'logic.js');

// Lazy-load the helpers from splice-step/logic.js as an ES module.
// The source file is a full Edison step template with:
//   - top imports (`const StepMod = await import(...)` / `const Step = ...`)
//   - ~500 lines of pure helpers
//   - a class wrapper (SpliceStep extends Step)
//   - `export { SpliceStep as step }`
// We strip the imports + class + export footer and re-export the helpers.
let _helpers = null;
async function loadHelpers() {
  if (_helpers) return _helpers;
  const raw = fs.readFileSync(SPLICE_SRC, 'utf8');
  const classStart = raw.indexOf('class SpliceStep extends Step');
  if (classStart < 0) throw new Error('Could not locate SpliceStep class in splice-step logic.js');
  let stripped = raw.slice(0, classStart);
  // Drop the Edison runtime imports — we have globals (crypto, fetch) in Node.
  stripped = stripped
    .replace(/const\s+StepMod\s*=\s*await\s+import\([^)]+\);\s*/g, '')
    .replace(/const\s+Step\s*=\s*StepMod\.default\s*\|\|\s*StepMod;\s*/g, '');
  const exportList = [
    'uuid', 'sanitizeTemplate', '_upsertTemplate', '_buildCanonicalAuthInput',
    '_replaceStepInMemory', '_wireGatewayAndInputs', '_configureDownstream',
    '_removeOrphanedTemplates', 'resolveTargetStep',
  ];
  stripped += `\n\nexport { ${exportList.join(', ')} };\n`;
  const cacheDir = '/tmp/localsplice-cache';
  fs.mkdirSync(cacheDir, { recursive: true });
  const outPath = path.join(cacheDir, 'splice-helpers.mjs');
  fs.writeFileSync(outPath, stripped);
  _helpers = await import(`file://${outPath}?t=${Date.now()}`);
  return _helpers;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STUDIO_URL_RE = /studio\.edison\.onereach\.ai\/flows\/([0-9a-f-]+)\/([0-9a-f-]+)/i;

function parseFlowId(flowUrl) {
  let id = String(flowUrl || '').trim();
  const m = id.match(STUDIO_URL_RE);
  if (m) return m[2];
  if (id.includes('/')) id = id.split('/').filter(Boolean).pop();
  return id;
}

/**
 * Splice a step template into a flow, in-process.
 *
 * @param {object} args
 * @param {string} args.flowId     — target flow UUID or Studio URL
 * @param {string} [args.stepId]   — UUID of the step INSTANCE on the canvas to replace.
 *                                    If omitted, resolveTargetStep auto-picks the
 *                                    canonical placeholder (label matches
 *                                    /^(Your Step Here|Add Your .* Step Here)$/i).
 * @param {object} args.template   — full step template object (or JSON string)
 * @param {boolean} [args.activate]  — redeploy Lambda after save (default true)
 * @param {string} [args.securityReport] — optional: goes into template.help
 * @param {(msg:string)=>void} [args.log]
 * @returns {Promise<object>} — same shape as the remote splice-step `next` exit:
 *   {flowId, flowVersion, stepId, templateId, label, exitWiring, inputs,
 *    downstream, gatewayConfigured, activationFailed, activationError}
 */
async function localSplice(args) {
  const {
    flowId: rawFlowId,
    stepId: rawStepId,
    template: rawTemplate,
    activate = true,
    securityReport = '',
  } = args;
  const log = args.log || (() => {});

  // --- Input validation (same checks as _runSplice) ---
  if (!rawFlowId) throw new Error('localSplice: flowId is required');
  if (!rawTemplate) throw new Error('localSplice: template is required');
  // stepId is optional — if omitted we auto-resolve to the canonical placeholder
  const flowId = parseFlowId(rawFlowId);
  if (!UUID_RE.test(flowId)) throw new Error(`localSplice: invalid flowId "${flowId}"`);

  let tpl;
  try {
    tpl = typeof rawTemplate === 'string' ? JSON.parse(rawTemplate) : rawTemplate;
  } catch (e) {
    throw new Error(`localSplice: template is not valid JSON — ${e.message}`);
  }
  const missing = [];
  if (!tpl.label) missing.push('label');
  if (!tpl.template) missing.push('template (code)');
  if (!tpl.data) missing.push('data');
  if (missing.length > 0) {
    throw new Error(`localSplice: template missing required fields: ${missing.join(', ')}`);
  }

  // --- Load helpers + SDK ---
  const H = await loadHelpers();
  const token = await dh.getToken();
  const api = dh.initFlowsApi(token);

  // --- Fetch target flow ---
  let flow;
  try {
    flow = await api.getFlow(flowId);
  } catch (e) {
    throw new Error(`localSplice: could not fetch flow ${flowId}: ${e.message}`);
  }
  if (!flow?.data?.trees?.main?.steps) {
    throw new Error(`localSplice: flow ${flowId} has no main tree or steps — may be corrupt`);
  }
  log(`[localSplice] flow: "${flow.data.label}" (${flow.data.trees.main.steps.length} steps, ${(flow.data.stepTemplates || []).length} templates)`);

  // --- Locate target step on canvas ---
  // If an explicit stepId was passed, use it. Otherwise auto-resolve via
  // resolveTargetStep — which prefers steps whose label matches the canonical
  // placeholder regex `/^(Your Step Here|Add Your .* Step Here)$/i`.
  // Conceive creates both a label-matched ghost step AND the canonical
  // placeholder; the canonical placeholder is the one wired into the flow's
  // execution path. Splicing the wrong one leaves the canvas looking
  // unchanged (canonical still visible, ghost quietly carries our new code
  // off to the side).
  let targetStep;
  if (rawStepId) {
    targetStep = flow.data.trees.main.steps.find(s => s.id === rawStepId);
    if (!targetStep) {
      const available = flow.data.trees.main.steps.map(s => `${s.id.slice(0,8)} (${s.label || s.name || '?'})`).join(', ');
      throw new Error(`localSplice: stepId "${rawStepId}" not on canvas. Available: ${available}`);
    }
  } else {
    const resolved = H.resolveTargetStep(flow, tpl, null, null, { info: log, warn: log, error: log });
    if (resolved?._error) {
      // Fallback: the canonical harness step slot is `cb665ad8-…` — every
      // flow conceived from the step harness has this as its user-code slot.
      // If resolveTargetStep failed (e.g. we're renaming the step so neither
      // placeholder nor label match hits), fall back to this slot when it
      // exists AND its current template isn't infrastructure.
      const CANONICAL_SLOT = 'cb665ad8-c78f-4eea-b32e-017a32da92e8';
      const canonical = flow.data.trees.main.steps.find(s => s.id === CANONICAL_SLOT);
      const INFRA_RE = /^(Handle Flow Error|Http Gateway|Wait for HTTP|Send HTTP Response|Get Value from|Set Value to|Generate Random|Change Format)/;
      const canonicalTpl = canonical ? (flow.data.stepTemplates || []).find(t => t.id === canonical.type) : null;
      const canonicalIsInfra = canonicalTpl && INFRA_RE.test(canonicalTpl.label || '');
      if (canonical && !canonicalIsInfra) {
        targetStep = canonical;
        log(`[localSplice] resolveTargetStep failed — falling back to canonical slot ${CANONICAL_SLOT.slice(0,8)} "${canonical.label || '?'}"`);
      } else {
        throw new Error(`localSplice: could not resolve target step: ${resolved.message}`);
      }
    } else {
      targetStep = resolved;
      log(`[localSplice] auto-resolved target step: ${targetStep.id.slice(0,8)} "${targetStep.label || '?'}"`);
    }
  }
  log(`[localSplice] replacing step "${targetStep.label || targetStep.id.slice(0,8)}" with template "${tpl.label}"`);

  // --- Preserve auth state from prior step (rarely needed but mirrors _runSplice) ---
  const preservedAuthData = targetStep?.data?.auth && typeof targetStep.data.auth === 'object' && targetStep.data.auth.auth
    ? JSON.parse(JSON.stringify(targetStep.data.auth)) : null;
  const preservedAuthSid = targetStep?.stepInputData?.auth || null;
  const oldTpl = (flow.data.stepTemplates || []).find(t => t.id === targetStep.type);
  const oldAuthInputs = (oldTpl?.formBuilder?.stepInputs || []).filter(i => {
    const comp = Array.isArray(i.component) ? i.component[0] : (i.component || '');
    return comp === 'auth-external-component';
  });
  const detectedAuthCollection = oldAuthInputs[0]?.data?.keyValueCollection || null;

  // --- Core transforms (exactly as in _runSplice) ---
  const cleanTpl = H._upsertTemplate(flow, tpl);

  // --- Hardening: repair known-broken template fields BEFORE wiring ---
  // Two failure modes both observed on the live splice-step flow (2026-04-19):
  //
  //   1. cleanTpl.data.exits === [] — runtime rejects EVERY exitStep() call
  //      with "Invalid exit 'X' for step" because the template declares no
  //      exits. Without this guard, the spliced step appears to save cleanly
  //      but every run fails at the flow engine. Fix: if exits is empty and
  //      the old template had a non-empty exits array, copy it forward.
  //      Else install the canonical default set (next + __error__ + __timeout__).
  //
  //   2. cleanTpl.outputExample === {} — breaks _configureDownstream's
  //      attempt to propagate a body schema to any downstream Send HTTP Response.
  //      Fix: if new template's outputExample is empty but the old one had
  //      content, preserve the old one. (We won't invent one; that's the
  //      template author's job.)
  //
  // These fixes are idempotent — safe to run on every splice.
  if (!Array.isArray(cleanTpl.data?.exits) || cleanTpl.data.exits.length === 0) {
    cleanTpl.data = cleanTpl.data || {};
    const oldExits = oldTpl?.data?.exits;
    if (Array.isArray(oldExits) && oldExits.length > 0) {
      cleanTpl.data.exits = JSON.parse(JSON.stringify(oldExits));
      log(`[localSplice] restored ${oldExits.length} exit(s) from old template (new template had empty data.exits)`);
    } else {
      cleanTpl.data.exits = [
        { id: 'next',        label: 'next',       condition: '',              isNewThread: false },
        { id: '__error__',   label: 'on error',   condition: 'processError'   },
        { id: '__timeout__', label: 'on timeout', condition: 'processTimeout' },
      ];
      log(`[localSplice] installed canonical exits (new template + old template both had empty data.exits)`);
    }
  }
  if (!cleanTpl.outputExample || Object.keys(cleanTpl.outputExample).length === 0) {
    const oldExample = oldTpl?.outputExample;
    if (oldExample && typeof oldExample === 'object' && Object.keys(oldExample).length > 0) {
      cleanTpl.outputExample = JSON.parse(JSON.stringify(oldExample));
      log(`[localSplice] preserved outputExample from old template (new template had empty)`);
    }
  }

  // Auth canonicalization (mirrors _runSplice lines 770-802)
  if (oldAuthInputs.length > 0 || preservedAuthSid || (preservedAuthData && preservedAuthData.auth)) {
    const newInputs = cleanTpl.formBuilder?.stepInputs || [];
    const CANONICAL_AUTH_URL = 'https://content-assets.onereach.ai/component/auth-external-component/1.3.6/index.js';
    const existingCanonical = newInputs.some(i => {
      const comp = Array.isArray(i.component) ? i.component[0] : (i.component || '');
      const url  = Array.isArray(i.component) ? i.component[1] : '';
      return comp === 'auth-external-component' && url === CANONICAL_AUTH_URL && i.pluginRefs?.length > 0;
    });
    if (!existingCanonical) {
      const collection = detectedAuthCollection || '__authorization_service_Anthropic';
      const freshAuth = H._buildCanonicalAuthInput(collection);
      if (!cleanTpl.formBuilder) cleanTpl.formBuilder = {};
      if (!cleanTpl.formBuilder.stepInputs) cleanTpl.formBuilder.stepInputs = [];
      cleanTpl.formBuilder.stepInputs = cleanTpl.formBuilder.stepInputs.filter(i => {
        const comp = Array.isArray(i.component) ? i.component[0] : (i.component || '');
        return comp !== 'auth-external-component';
      });
      cleanTpl.formBuilder.stepInputs.unshift(freshAuth);
      if (!cleanTpl.formBuilder.pluginRefs) cleanTpl.formBuilder.pluginRefs = [];
      for (const ref of freshAuth.pluginRefs) if (!cleanTpl.formBuilder.pluginRefs.includes(ref)) cleanTpl.formBuilder.pluginRefs.push(ref);
      log(`[localSplice] canonicalized auth-external-component (collection: ${collection})`);
    }
  }
  if (securityReport && typeof securityReport === 'string' && securityReport.trim()) {
    cleanTpl.help = securityReport;
  }

  // PRE-SPLICE reachability snapshot. We'll use this later so we only ever
  // remove steps that were ALREADY unreachable before the splice — never
  // steps that were reachable before and only became unreachable because
  // the splice dropped some wiring. (This is what broke the splice-step
  // flow on 2026-04-18: _replaceStepInMemory dropped exits, BFS then
  // deleted a92d06c4 as "unreachable," compounding the damage.)
  const INFRA_RE = /^(Handle Flow Error|Http Gateway|Wait for HTTP|Send HTTP Response|Get Value from|Set Value to|Generate Random|Change Format)/;
  const computeReachable = (snapshot) => {
    const all = snapshot.data.trees?.main?.steps || [];
    const byId = new Map(all.map(s => [s.id, s]));
    const tplById = new Map((snapshot.data.stepTemplates || []).map(t => [t.id, t]));
    const entries = all.filter(s => {
      const t = tplById.get(s.type);
      if (!t) return false;
      if (t.isGatewayStep) return true;
      return /^(Wait for HTTP Request|Handle Flow Error)$/.test(t.label || '');
    });
    const reachable = new Set(entries.map(s => s.id));
    const queue = [...reachable];
    while (queue.length) {
      const s = byId.get(queue.shift());
      if (!s) continue;
      for (const ex of (s.exits || s.data?.exits || [])) {
        if (!ex.stepId || !byId.has(ex.stepId) || reachable.has(ex.stepId)) continue;
        reachable.add(ex.stepId);
        queue.push(ex.stepId);
      }
    }
    return reachable;
  };
  const preReachable = computeReachable(flow);

  const { step, exitWiring, newDataOutName } = H._replaceStepInMemory(flow, targetStep.id, cleanTpl);
  log(`[localSplice] step replaced: exits=${exitWiring.map(e => e.exitId + ':' + e.status).join(',')}, dataOut=${newDataOutName || 'none'}`);

  const { inputs, wired, reason } = H._wireGatewayAndInputs(flow, step, cleanTpl);
  if (wired) log(`[localSplice] gateway wired: ${inputs.length} input(s) mapped from body`);
  else log(`[localSplice] gateway NOT wired: ${reason || 'unknown'}`);

  const { configured } = H._configureDownstream(flow, step.id, newDataOutName);
  if (configured.length > 0) log(`[localSplice] downstream configured: ${configured.map(c => c.label + '.' + c.field).join(', ')}`);

  // Remove dangling step instances that use our new template (copies created
  // during conceive etc.) — must run BEFORE unreachable cleanup so these
  // don't accidentally count as entry points.
  const danglingSteps = flow.data.trees.main.steps.filter(s => s.type === cleanTpl.id && s.id !== step.id);
  for (const ds of danglingSteps) {
    const idx = flow.data.trees.main.steps.indexOf(ds);
    if (idx >= 0) {
      flow.data.trees.main.steps.splice(idx, 1);
      log(`[localSplice] removed dangling step (same template): ${ds.label || ds.id.slice(0,8)}`);
    }
  }

  // Remove steps that WERE ALREADY unreachable before the splice AND are
  // still unreachable after (i.e. genuine ghosts — e.g. conceive-step's
  // flow-name-labeled ghost). Never remove a step that was reachable before
  // the splice but became unreachable after — that means the splice dropped
  // wiring and we shouldn't compound the damage, we should leave it for the
  // post-splice reachability check to flag.
  {
    const allSteps = flow.data.trees.main.steps || [];
    const tplById = new Map((flow.data.stepTemplates || []).map(t => [t.id, t]));
    const isInfraStep = (s) => {
      const t = tplById.get(s.type);
      if (!t) return false;
      if (t.isGatewayStep) return true;
      return INFRA_RE.test(t.label || '') || INFRA_RE.test(s.label || '');
    };
    const postReachable = computeReachable(flow);
    const ghostCandidates = allSteps.filter(s =>
      !postReachable.has(s.id) &&      // unreachable now
      !preReachable.has(s.id) &&       // AND already unreachable before (true ghost)
      !isInfraStep(s) &&
      s.id !== step.id
    );
    for (const ds of ghostCandidates) {
      const idx = flow.data.trees.main.steps.indexOf(ds);
      if (idx >= 0) {
        flow.data.trees.main.steps.splice(idx, 1);
        log(`[localSplice] removed pre-existing ghost: ${ds.label || ds.id.slice(0,8)}`);
      }
    }
  }

  // NOW run the orphaned-template sweep (it couldn't catch templates whose
  // only referencer was the ghost step we just removed until now).
  const orphans = H._removeOrphanedTemplates(flow, cleanTpl.id, { info: log, warn: log, error: log });
  if (orphans.length > 0) log(`[localSplice] removed ${orphans.length} orphaned template(s): ${orphans.join(', ')}`);

  // Restore preserved auth onto the new step
  if (preservedAuthData) {
    step.data.auth = preservedAuthData;
  } else if (preservedAuthSid) {
    // Reconstruct data.auth from stepInputData.auth when the rich object was
    // lost (e.g. an earlier splice stripped data.auth to empty string, so
    // preservedAuthData is null on subsequent splices). Edison's runtime
    // populates `this.data.auth` from `stepInputData.auth`, but the canvas UI
    // and certain auth-resolution paths also read `data.auth` — and when
    // `data.auth = ""`, storage.get(collection, authId) returns null even
    // though stepInputData.auth has the credential selector. Parse the
    // object-literal string form of stepInputData.auth and use it to seed a
    // valid `data.auth` object.
    const isObjectExpr = typeof preservedAuthSid === 'string'
      && preservedAuthSid.startsWith('{') && preservedAuthSid.includes('authData');
    let credId = '';
    let collection = detectedAuthCollection || '__authorization_service_Anthropic';
    let authType = 'token';
    if (isObjectExpr) {
      // Extract `auth: "..."` and `authData: {...}` from the string form
      const mAuth = preservedAuthSid.match(/\bauth\s*:\s*["']([^"']+)["']/);
      if (mAuth) credId = mAuth[1];
      const mColl = preservedAuthSid.match(/keyValueCollection\s*:\s*["']([^"']+)["']/);
      if (mColl) collection = mColl[1];
      const mType = preservedAuthSid.match(/authType\s*:\s*["']([^"']+)["']/);
      if (mType) authType = mType[1];
    } else {
      credId = String(preservedAuthSid).replace(/^`|`$/g, '').trim();
    }
    if (credId) {
      step.data.auth = {
        app: '',
        auth: credId,
        authData: {
          authType,
          isNoAuthLeg: false,
          keyValueCollection: collection,
          isCollectionsEnabled: false,
        },
        authSelected: credId,
        dynamicAuthId: '',
        dynamicCollection: '',
        keyValueCollection: collection,
        isCollectionsEnabled: false,
      };
      log(`[localSplice] reconstructed data.auth from stepInputData (credId=${credId.slice(0,8)}..., collection=${collection})`);
    }
  }

  // Restore preserved auth STEP INPUT DATA — this is the expression Edison
  // evaluates at runtime to populate `this.data.auth`. Without it, the auth
  // component renders the credential in Studio but the runtime sees
  // `this.data.auth = undefined`. Port of splice-step logic.js lines 862-897.
  const authCollectionForInput = detectedAuthCollection || '__authorization_service_Anthropic';
  if (preservedAuthSid) {
    if (!step.stepInputData) step.stepInputData = {};
    const isObjectExpr = typeof preservedAuthSid === 'string'
      && preservedAuthSid.startsWith('{') && preservedAuthSid.includes('authData');
    if (isObjectExpr) {
      step.stepInputData.auth = preservedAuthSid;
    } else {
      let credId = String(preservedAuthSid || '').replace(/^`|`$/g, '').trim();
      if (credId) {
        step.stepInputData.auth = '{auth: ' + JSON.stringify(credId) +
          ',authData: {authType: "token"' +
          ',isCollectionsEnabled: false' +
          ',isNoAuthLeg: false' +
          ',keyValueCollection: ' + JSON.stringify(authCollectionForInput) +
          '},dynamicCollection: ""' +
          ',dynamicAuthId: ""}';
        log('[localSplice] normalized auth stepInputData from simple string to object expression');
      }
    }
  } else if (preservedAuthData && preservedAuthData.auth) {
    if (!step.stepInputData) step.stepInputData = {};
    const a = preservedAuthData;
    step.stepInputData.auth = '{auth: ' + JSON.stringify(a.auth) +
      ',authData: {authType: ' + JSON.stringify(a.authData?.authType || 'token') +
      ',isNoAuthLeg: ' + (a.authData?.isNoAuthLeg || false) +
      ',keyValueCollection: ' + JSON.stringify(a.authData?.keyValueCollection || authCollectionForInput) +
      ',isCollectionsEnabled: ' + (a.authData?.isCollectionsEnabled || false) +
      '},dynamicCollection: ' + JSON.stringify(a.dynamicCollection || '') +
      ',dynamicAuthId: ' + JSON.stringify(a.dynamicAuthId || '') + '}';
    log('[localSplice] rebuilt auth stepInputData from preserved data.auth object');
  }

  // --- SAFETY: reachability assertion before save ---
  // If any step that was reachable pre-splice is now unreachable post-splice,
  // _replaceStepInMemory dropped wiring somewhere. Don't ship broken state —
  // throw so the user sees the issue and nothing is saved. This catches the
  // 2026-04-18 class of bug where an empty template.data.exits silently
  // orphaned the downstream chain.
  {
    const finalReachable = computeReachable(flow);
    const tplByIdForCheck = new Map((flow.data.stepTemplates || []).map(t => [t.id, t]));
    const regressed = [...preReachable].filter(id => {
      if (finalReachable.has(id)) return false;
      // Step was deleted (ghost cleanup); that's fine.
      if (!flow.data.trees.main.steps.some(s => s.id === id)) return false;
      // The replaced step's old ghost-self is allowed to disappear.
      if (id === step.id) return false;
      return true;
    });
    if (regressed.length > 0) {
      const details = regressed.map(id => {
        const s = flow.data.trees.main.steps.find(x => x.id === id);
        const lbl = s ? (s.label || tplByIdForCheck.get(s.type)?.label || id.slice(0, 8)) : id.slice(0, 8);
        return `${id.slice(0, 8)} "${lbl}"`;
      }).join(', ');
      throw new Error(`localSplice: ABORTED before save — splice dropped wiring to ${regressed.length} step(s) that were reachable before: ${details}. No changes persisted.`);
    }
  }

  // --- Save with one retry on version conflict ---
  let saved;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt > 0) {
        const fresh = await api.getFlow(flowId);
        fresh.data = flow.data;
        flow = fresh;
      }
      saved = await api.saveFlow(flow, { previousVersion: flow.version });
      break;
    } catch (e) {
      if (attempt === 1) throw new Error(`localSplice: saveFlow failed: ${e.message}`);
      log(`[localSplice] save attempt ${attempt + 1} failed, retrying: ${e.message}`);
    }
  }
  const savedId = saved.id || flow.id;
  const savedVersion = saved.version || '';
  log(`[localSplice] saved flow version=${savedVersion || '?'}`);

  // --- Activate (redeploy Lambda) with retry on transient timeouts ---
  // Edison's activation occasionally times out at 29s waiting for the SNS
  // event ack even when the deploy itself succeeds. Retry up to 3 times.
  let activationFailed = false;
  let activationError = null;
  if (activate) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await api.deployer.activateFlow(flow, false, () => {});
        log(`[localSplice] runtime activation ok${attempt > 1 ? ' (attempt ' + attempt + ')' : ''}`);
        activationFailed = false;
        activationError = null;
        break;
      } catch (e) {
        activationFailed = true;
        activationError = e.message;
        const isTimeout = /timeout/i.test(e.message || '');
        log(`[localSplice] activation attempt ${attempt}/3 failed: ${e.message}`);
        if (attempt < 3 && isTimeout) {
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }
        break;
      }
    }
  }

  return {
    flowId: savedId,
    flowVersion: savedVersion,
    stepId: step.id,
    templateId: cleanTpl.id,
    label: step.label || cleanTpl.label,
    exitWiring,
    inputs: inputs.map(i => ({ variable: i.variable, type: i.type })),
    downstream: configured,
    gatewayConfigured: wired,
    activationFailed,
    activationError,
  };
}

module.exports = { localSplice, loadHelpers, parseFlowId };
