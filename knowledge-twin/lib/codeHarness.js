// ---------------------------------------------------------------------------
// codeHarness — takes raw LLM-generated code + spec, builds a complete
// Edison step template, validates it, applies deterministic fixes, and
// returns a deploy-ready template.
//
// Usage:
//   const { harnessCode } = require('./lib/codeHarness');
//   const result = await harnessCode(rawCode, spec, { log: console.log });
//   // result.template — deploy-ready Edison template
//   // result.diagnostics — remaining issues after fixes
//   // result.valid — true if 0 errors
//   // result.fixes — list of fixes applied
// ---------------------------------------------------------------------------

'use strict';

const crypto = require('crypto');
const { buildStepTemplateFromSpec, validateStepFromSpec } = require('./stepBuilder');
const { validateStep } = require('./stepValidator');

function uuid() { return crypto.randomUUID(); }

const SYSTEM_DATA_FIELDS = new Set([
  'processError', 'processTimeout', 'timeoutDuration', 'auth',
  'exits', 'dataOut', 'meta',
]);

function _buildFallbackInputs(spec) {
  const inputs = [];
  try {
    const { buildStepInput, buildDataOutInput } = require('./stepBuilder');
    if (spec.inputs && Array.isArray(spec.inputs)) {
      for (const inp of spec.inputs) {
        if (!inp.variable) continue;
        if (SYSTEM_DATA_FIELDS.has(inp.variable)) continue;
        inputs.push(buildStepInput(inp));
      }
    }
    if (spec.dataOut) {
      inputs.push(buildDataOutInput(spec));
    }
  } catch (e) {
    // stepBuilder not available — return empty
  }
  return inputs;
}

function _ensureInputsFromCode(template, spec) {
  const code = template.template || '';
  const fb = template.formBuilder;
  if (!fb || !fb.stepInputs) return;

  const existingVars = new Set();
  const walk = (items) => {
    for (const inp of (items || [])) {
      if (inp.data?.variable) existingVars.add(inp.data.variable);
      if (Array.isArray(inp.data?.inputs)) walk(inp.data.inputs);
    }
  };
  walk(fb.stepInputs);

  const dataRefRe = /this\.data\.(\w+)/g;
  const codeRefs = new Set();
  let m;
  while ((m = dataRefRe.exec(code)) !== null) {
    const v = m[1];
    if (!SYSTEM_DATA_FIELDS.has(v) && !existingVars.has(v)) codeRefs.add(v);
  }

  if (codeRefs.size === 0) return;

  const specInputMap = new Map();
  for (const inp of (spec.inputs || [])) {
    if (inp.variable) specInputMap.set(inp.variable, inp);
  }

  try {
    const { buildStepInput, buildDataOutInput } = require('./stepBuilder');
    for (const variable of codeRefs) {
      const specInput = specInputMap.get(variable) || { variable, type: 'text', label: variable.replace(/([A-Z])/g, ' $1').trim() };
      fb.stepInputs.push(buildStepInput(specInput));
    }

    // Ensure formDataOut exists when spec has dataOut and code calls exitStep with data
    if (spec.dataOut && fb.hasDataOut) {
      const hasFormDataOut = fb.stepInputs.some(i => {
        const c = Array.isArray(i.component) ? i.component[0] : i.component;
        return c === 'formDataOut';
      });
      if (!hasFormDataOut) {
        fb.stepInputs.push(buildDataOutInput(spec));
      }
    }
  } catch (e) {
    // stepBuilder not available
  }
}

function toClassName(label) {
  return label
    .replace(/[^a-zA-Z0-9\s-]/g, '')
    .trim()
    .split(/[\s-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') || 'GeneratedStep';
}

function indent(str, spaces) {
  const pad = ' '.repeat(spaces);
  return str.split('\n').map(line => line.trim() ? pad + line : line).join('\n');
}

function wrapInEsmClass(className, runStepBody) {
  return `const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class ${className} extends Step {
  async runStep() {
${indent(runStepBody, 4)}
  }
}

export { ${className} as step };`;
}

function isAlreadyWrapped(code) {
  return /class\s+\w+\s+extends\s+Step\b/.test(code) && /export\s*\{/.test(code);
}

// ---------------------------------------------------------------------------
// Icon fallback chain (follows SDK StepBuilder pattern — never throws)
// ---------------------------------------------------------------------------

// One /create-icon attempt. Returns a verified-reachable https URL or null.
// Strictly rejects inline SVG payloads — the flow must always yield a URL.
async function _tryCreateIconOnce(spec, log, attemptNum) {
  const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
  const BASE = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}`;
  const POLL_DEADLINE_MS = 30000;
  let jobId;
  try {
    const res = await fetch(`${BASE}/create-icon`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'pattern',
        pattern: spec.iconPattern,
        patternOptions: spec.iconPatternOptions || {},
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      log(`  /create-icon attempt ${attemptNum}: POST HTTP ${res.status}`);
      return null;
    }
    const post = await res.json();
    jobId = post.jobId || post.jobID;
    if (!jobId) {
      log(`  /create-icon attempt ${attemptNum}: no jobId in POST response`);
      return null;
    }
  } catch (e) {
    log(`  /create-icon attempt ${attemptNum}: POST failed (${e.message})`);
    return null;
  }

  const enc = encodeURIComponent(jobId);
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    let data;
    try {
      const poll = await fetch(`${BASE}/create-icon?jobId=${enc}&jobID=${enc}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!poll.ok) continue;
      data = await poll.json();
    } catch { continue; }

    // Strict rule: accept ONLY an https URL response. No data URIs, no inline SVG.
    const url = typeof data.iconUrl === 'string' ? data.iconUrl : '';
    if (url && url.startsWith('https://') && url.length <= 255) return url;
    if (url && (url.startsWith('data:') || url.includes('<svg'))) {
      log(`  /create-icon attempt ${attemptNum}: rejected inline SVG / data URI payload (policy: URLs only)`);
      return null;
    }

    const status = String(data.status || '').toLowerCase();
    if (status.includes('error') || status.includes('failed')) {
      log(`  /create-icon attempt ${attemptNum}: status "${data.status}"`);
      return null;
    }
    // Otherwise keep polling on 'started' / 'pending' / 'job started'.
  }
  log(`  /create-icon attempt ${attemptNum}: timed out after ${POLL_DEADLINE_MS / 1000}s`);
  return null;
}

// Verify a URL is reachable (HTTP 2xx). ≤5s budget, swallows errors as false.
async function _headOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
    return { ok: r.ok, status: r.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message };
  }
}

// Icon policy (see CLAUDE.md):
//   1. Auto-select a pattern from step metadata if none provided.
//   2. Try /create-icon up to 3 times. Each cycle = POST + poll(<=30s) + HEAD.
//      Only URLs are ever accepted — inline SVG / data URIs are rejected.
//   3. If all 3 attempts fail, fall back to the pre-deployed jsdelivr library
//      URL for the auto-selected pattern.
//   4. Last-resort backstop: `seed-of-life.svg` from the library (manually
//      verified to exist). This guarantees spec.iconUrl is always a valid
//      https URL under 255 chars that Studio can render.
async function resolveIcon(spec, log) {
  if (spec.iconType === 'default' && spec.icon) return;

  if (!spec.iconPattern && !(spec.iconType === 'custom' && spec.iconUrl)) {
    try {
      const { autoSelectIconPattern } = require('./stepBuilder');
      if (typeof autoSelectIconPattern === 'function') {
        spec.iconPattern = autoSelectIconPattern(spec);
        log(`  Icon pattern auto-selected: "${spec.iconPattern}"`);
      }
    } catch { /* fall through to backstop */ }
  }

  if (!spec.iconPattern) spec.iconPattern = 'seed-of-life';

  // STEP 1: try /create-icon up to 3 times.
  if (!spec.iconUrl) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const url = await _tryCreateIconOnce(spec, log, attempt);
      if (!url) continue;
      const head = await _headOk(url);
      if (head.ok) {
        spec.iconType = 'custom';
        spec.icon = '';
        spec.iconUrl = url;
        log(`  ✓ Icon from /create-icon attempt ${attempt}: ${url.slice(0, 80)} (HEAD ${head.status})`);
        return;
      }
      log(`  /create-icon attempt ${attempt}: URL returned ${head.status || 'fetch-error'} (${url.slice(0, 80)})`);
    }
    log(`  /create-icon failed 3x — falling back to jsdelivr library for "${spec.iconPattern}"`);
  }

  // STEP 2: direct jsdelivr library URL for the auto-selected pattern.
  const LIBRARY_BASE = 'https://cdn.jsdelivr.net/gh/wilsr7000/podscan-node@main/knowledge-twin/icons';
  const libUrl = `${LIBRARY_BASE}/${spec.iconPattern}.svg`;
  if (libUrl.length <= 255) {
    const head = await _headOk(libUrl);
    if (head.ok) {
      spec.iconType = 'custom';
      spec.icon = '';
      spec.iconUrl = libUrl;
      log(`  ✓ Icon from library: ${spec.iconPattern}.svg (HEAD ${head.status})`);
      return;
    }
    log(`  Library HEAD ${head.status} for "${spec.iconPattern}" — using seed-of-life backstop`);
  }

  // STEP 3: last-resort backstop — a library icon manually verified to exist.
  const BACKSTOP = `${LIBRARY_BASE}/seed-of-life.svg`;
  spec.iconType = 'custom';
  spec.icon = '';
  spec.iconUrl = BACKSTOP;
  log(`  ✓ Icon backstop: seed-of-life.svg`);
}

// ---------------------------------------------------------------------------
// Version bumping
// ---------------------------------------------------------------------------

function bumpPatch(version) {
  if (!version) return '1.0.0';
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return '1.0.0';
  return `${m[1]}.${m[2]}.${parseInt(m[3], 10) + 1}`;
}

// ---------------------------------------------------------------------------
// Phase 1: Deterministic console.* -> this.log.* replacement
// ---------------------------------------------------------------------------

const CONSOLE_REPLACEMENTS = [
  { from: /\bconsole\.log\b/g,     to: 'this.log.info' },
  { from: /\bconsole\.warn\b/g,    to: 'this.log.warn' },
  { from: /\bconsole\.error\b/g,   to: 'this.log.error' },
  { from: /\bconsole\.debug\b/g,   to: 'this.log.debug' },
  { from: /\bconsole\.info\b/g,    to: 'this.log.info' },
  { from: /\bconsole\.time\b/g,    to: 'this.log.time' },
  { from: /\bconsole\.timeEnd\b/g, to: 'this.log.timeEnd' },
];

function replaceConsoleCalls(code) {
  let result = code;
  let count = 0;
  for (const { from, to } of CONSOLE_REPLACEMENTS) {
    const matches = result.match(from);
    if (matches) count += matches.length;
    result = result.replace(from, to);
  }
  return { code: result, replacements: count };
}

// ---------------------------------------------------------------------------
// LLM call helper — uses local key or Edison proxy
// ---------------------------------------------------------------------------

const PROXY_POLL_MS = 2000;
const PROXY_TIMEOUT_MS = 30000;

async function callLLM(system, user, opts = {}) {
  const apiKey = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
  const model = opts.model || 'claude-haiku-4-5-20251001';
  const maxTokens = opts.maxTokens || 4096;

  if (apiKey) {
    const { callAnthropicDirect } = require('./llmClient');
    return callAnthropicDirect(apiKey, system, user, { model, maxTokens, temperature: opts.temperature ?? 0 });
  }

  // Use Edison LLM proxy (journey-map-api)
  const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
  const PROXY = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/journey-map-api`;

  const resp = await fetch(PROXY, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: `${system}\n\n---\n\n${user}` }] }),
  });
  if (!resp.ok) return { error: `Proxy HTTP ${resp.status}` };
  const data = await resp.json();
  const jobId = data.job_id;
  if (!jobId) return { error: 'No job_id from proxy' };

  const deadline = Date.now() + PROXY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const poll = await fetch(`${PROXY}?jobid=${jobId}`);
    const result = await poll.json();
    if (result.status === 'success') {
      const text = Array.isArray(result.value)
        ? result.value.filter(b => b.type === 'text').map(b => b.text).join('')
        : String(result.value || '');
      return { raw: text, model };
    }
    if (result.status === 'no job found' || result.error) return { error: result.error || 'Job not found' };
    await new Promise(r => setTimeout(r, PROXY_POLL_MS));
  }
  return { error: 'Proxy timeout' };
}

// ---------------------------------------------------------------------------
// Phase 2: LLM-powered strategic logging insertion
// ---------------------------------------------------------------------------

const LOGGING_SYSTEM_PROMPT = `You are a code instrumentation specialist. Your ONLY job is to add this.log calls to Edison step code for observability. You must NOT change any logic, variable names, control flow, imports, or exports.

Edison logging API:
- this.log.info(message, payload)   — milestones: step start, step complete, key decisions
- this.log.warn(message, payload)   — unexpected but recoverable situations
- this.log.error(message, payload)  — failures, always include { error: err.message }
- this.log.debug(message, payload)  — verbose data for troubleshooting, input/output shapes
- this.log.time(label)              — start a timer before external calls
- this.log.timeEnd(label)           — stop timer after external calls, logs elapsed ms

Where to add logging:
1. Top of runStep(): this.log.info('ClassName started', { ...key inputs })
2. After reading this.data inputs: this.log.debug('Inputs resolved', { key: value, ... })
3. Before fetch()/emitSync()/emitHttp()/emitAsync(): this.log.time('descriptiveLabel')
4. After fetch()/emitSync()/emitHttp()/emitAsync(): this.log.timeEnd('descriptiveLabel')
5. In every catch block: this.log.error('ClassName failed', { error: err.message })
6. Before each this.exitStep(): this.log.info('ClassName completed', { exit: 'exitName' })
7. At significant branch points: this.log.debug('Branch', { condition, value })

Special patterns — LLM-driven flows, iteration loops, and polling:
8. For/while loops that call LLMs, APIs, or do evaluation rounds: add this.log.info at the START of each iteration with the iteration number, current score/status, and a brief progress indicator. Example:
   this.log.info('Iteration 3/10', { score: 7.8, status: 'improving', delta: '+0.4' })
   This is critical for long-running steps so operators can see progress while the step is executing.
9. For LLM/API polling loops (retry, wait-for-result): add this.log.info with attempt number and elapsed time:
   this.log.info('Poll attempt 5', { elapsed: '12.3s', status: 'pending' })
10. For evaluation/judge panels (multiple evaluators scoring in sequence): log each evaluator's result:
    this.log.info('Judge: Completeness', { score: 9.2, findings: 1 })
11. For Reflexion patterns (generate → evaluate → reflect → retry): log each phase transition:
    this.log.info('Reflexion: evaluate', { attempt: 2, previousScore: 6.5 })
12. Wrap the entire loop body with this.log.time/timeEnd to measure per-iteration latency:
    this.log.time('iteration-3')
    // ... loop body ...
    this.log.timeEnd('iteration-3')

Constraints:
- Do NOT add logging inside tight mathematical loops (e.g. coordinate calculations, string processing)
- DO add logging inside business-logic loops (LLM calls, API retries, evaluation rounds, iteration cycles)
- Do NOT log sensitive data (API keys, tokens, passwords)
- Do NOT modify ANY existing code — only INSERT new this.log lines
- Keep message strings under 120 characters
- Use the actual class name from the code in log messages
- If the code already has good this.log coverage, add minimally
- Return the COMPLETE modified code, nothing else — no markdown fences, no explanation`;

async function addStrategicLogging(code, spec, log) {
  try {
    const userContent = `Step: "${spec.label || spec.name || 'Step'}"
Description: ${(spec.description || '').slice(0, 200)}
Inputs: ${(spec.inputs || []).map(i => i.variable).join(', ') || 'none'}
Exits: ${(spec.exits || []).map(e => e.id).join(', ') || 'next'}

Add strategic logging to this code. Return the complete modified code:

${code}`;

    log('  [logging] Calling LLM for strategic logging insertion...');
    const result = await callLLM(LOGGING_SYSTEM_PROMPT, userContent, {
      maxTokens: Math.min(code.length * 2, 64000),
    });

    if (result.error) {
      log(`  [logging] LLM error: ${result.error}`);
      return code;
    }

    let enhanced = result.raw || '';
    enhanced = enhanced.replace(/^```\w*\n?/, '').replace(/\n?```$/, '').trim();

    if (enhanced.length < code.length * 0.8) {
      log('  [logging] LLM response too short — likely truncated, skipping');
      return code;
    }
    if (!enhanced.includes('export') || !enhanced.includes('Step')) {
      log('  [logging] LLM response missing expected structure, skipping');
      return code;
    }

    const addedLines = enhanced.split('\n').length - code.split('\n').length;
    log(`  [logging] LLM added ~${addedLines} logging lines (${result.durationMs}ms)`);
    return enhanced;
  } catch (e) {
    log(`  [logging] LLM pass failed: ${e.message}`);
    return code;
  }
}

// ---------------------------------------------------------------------------
// Apply deterministic fixCode patches from validator diagnostics
// ---------------------------------------------------------------------------

function buildAuthComponent(provider, keyValueCollection) {
  const uuid = () => require('crypto').randomUUID();
  return {
    id: uuid(),
    data: {
      label: `${provider} Authorization`,
      scopes: [],
      appHelp: '',
      appTerm: 'app',
      envList: [],
      authType: 'token',
      getToken: '``',
      variable: 'auth',
      wireFrom: 'studio',
      fieldList: [{ masked: true, vforkey: uuid(), fieldName: 'apiKey', fieldLabel: 'API Key' }],
      grantType: 'authorization_code',
      revokeUri: '',
      scopeType: 'SPACE_DELIMITED',
      authMethod: 'STATIC',
      refreshUri: '',
      useRefresh: false,
      appSelected: '``',
      appSelector: { variableApp: 'app' },
      authKeyTerm: 'Authorization key',
      isNoAuthLeg: false,
      authSelected: '``',
      authorizeUri: '',
      environments: {},
      allowedScopes: [],
      clientIdLabel: 'Client ID',
      adapterBotName: '_Adapters',
      allowedStorage: ['CURRENT'],
      authLinkParams: [],
      componentError: false,
      isAppAvailable: false,
      isAuthRequired: true,
      adapterFlowName: 'authorizer/redirect',
      appOrAuthMethod: 'AUTH',
      fieldLabelBasic: { passwordLabel: 'Password', usernameLabel: 'Username' },
      noAuthErrorText: 'Authorization is required.',
      renderCondition: '',
      requestDataType: '',
      selectedService: {},
      collapsibleTitle: `${provider} Authorization`,
      disableCondition: '',
      disallowedScopes: [],
      exchangeTokenUri: '',
      providerFlowName: 'authorizer/redirect',
      redirectUriLabel: 'Redirect URL',
      revokeHttpMethod: 'GET',
      validateRequired: true,
      authorizationTerm: 'authorization',
      clientSecretLabel: 'Client secret',
      defaultAuthMethod: 'STATIC',
      serviceConfigName: '',
      wrapInCollapsible: true,
      customProviderPath: '',
      displayServiceName: provider,
      keyValueCollection,
      installerBotOptions: { createAppWithBot: false, createAuthWithBot: false },
      addNonceToAuthRequest: false,
      allowUseOfOneReachApp: false,
      expiresInDefaultValue: 0,
      expiresInPropertyName: 'expires_in',
      minimumAdapterVersion: '0.5.0',
      serviceDefinitionType: 'predefined',
      additionalFieldsForApp: [],
      defaultEnvironmentName: 'default',
      renderConditionBuilder: {
        label: '`Conditional visibility`', rules: [], trueValue: 'any',
        description: '``', defaultValue: true, isNotCollapsed: false, isEditableHeader: false,
      },
      scopesDocumentationLink: '',
      disableInheritanceOption: false,
      authorizationAndScopeHelp: `<h4>${provider} API Key</h4>\nProvide your ${provider} API key. Securely stored and inheritable by downstream steps.`,
      collectionNameInputTouched: true,
      authRequestAdditionalParams: '{\n  "queryParams": {}\n}',
      redirectServiceForCustomApps: 'PROVIDER',
      serviceDefinitionProviderName: 'authorizer/services/list',
      shareServiceDefinitionFlowName: 'service-configuration-reciever',
      codeExchangeRequestAdditionalParams: '{\n  "headers": {},\n  "body": {}\n}',
    },
    meta: { name: 'auth-external-component', type: 'onereach-studio-form-input', version: '1.0' },
    label: `${provider} Authorization`,
    compiled: {},
    component: ['auth-external-component', 'https://content-assets.onereach.ai/component/auth-external-component/1.3.6/index.js'],
    pluginRefs: [
      'onereach-studio-plugin["or-ui-components@env"]["or-ui-components"]',
      'onereach-studio-form-input["or-ui-components@env"]["auth-external-component"]',
    ],
  };
}

function applyFixes(template, diagnostics, log) {
  const fixes = [];

  for (const d of diagnostics) {
    if (!d.context?.fixCode) continue;
    const fc = d.context.fixCode;

    if (fc.addAuthComponent) {
      const { provider, keyValueCollection } = fc.addAuthComponent;
      if (!template.formBuilder) template.formBuilder = { stepInputs: [] };
      if (!template.formBuilder.stepInputs) template.formBuilder.stepInputs = [];
      const hasAuth = template.formBuilder.stepInputs.some(i => {
        const c = Array.isArray(i.component) ? i.component[0] : i.component;
        return c === 'auth-external-component';
      });
      if (!hasAuth) {
        const authInput = buildAuthComponent(provider, keyValueCollection);
        template.formBuilder.stepInputs.unshift(authInput);
        if (!template.formBuilder.pluginRefs) template.formBuilder.pluginRefs = [];
        for (const ref of authInput.pluginRefs) {
          if (!template.formBuilder.pluginRefs.includes(ref)) template.formBuilder.pluginRefs.push(ref);
        }
        fixes.push({ code: d.code, action: 'addAuthComponent', provider });
        log(`  Fix applied: ${d.code} — added ${provider} auth-external-component`);
      }
    }

    if (fc.appendToTemplate && template.template) {
      template.template += fc.appendToTemplate;
      fixes.push({ code: d.code, action: 'appendToTemplate' });
      log(`  Fix applied: ${d.code} — appended to template code`);
    }

    if (fc.data) {
      template.data = { ...template.data, ...fc.data };
      fixes.push({ code: d.code, action: 'mergeData' });
      log(`  Fix applied: ${d.code} — merged into template.data`);
    }

    if (fc.name) {
      template.name = fc.name;
      template.label = fc.label || fc.name;
      fixes.push({ code: d.code, action: 'setName' });
    }

    if (fc.version) {
      template.version = fc.version;
      fixes.push({ code: d.code, action: 'setVersion' });
    }
  }

  return fixes;
}

// ---------------------------------------------------------------------------
// Main harness function
// ---------------------------------------------------------------------------

async function harnessCode(rawCode, spec, opts = {}) {
  const log = opts.log || console.log;
  const maxFixIterations = opts.maxFixIterations || 3;

  // Resolve LLM access — either local ANTHROPIC_KEY or Edison LLM proxy
  const apiKey = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
  const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
  const LLM_PROXY = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/journey-map-api`;
  if (!apiKey) {
    log('  [harness] No local ANTHROPIC_KEY — using Edison LLM proxy');
  }

  log('  [harness] Building template from spec + code...');

  // 1. Wrap raw code in ESM class if needed
  const className = toClassName(spec.label || spec.name || 'Step');
  let fullCode;
  if (isAlreadyWrapped(rawCode)) {
    fullCode = rawCode;
    log(`  [harness] Code already wrapped (${fullCode.length} chars)`);
  } else {
    fullCode = wrapInEsmClass(className, rawCode);
    log(`  [harness] Wrapped runStep body in ${className} class (${fullCode.length} chars)`);
  }

  // 1b. (Removed 2026-04-21) The old _resolveInput helper used to be injected
  // as a fallback that tried gateway merge fields (mergeFields['httpCall'].get
  // ({path: `request.body.${name}`})) when this.data[name] was empty. Two
  // problems with that shape:
  //   1) Reading request.body.* directly from a gateway merge field is the
  //      exact pattern stepValidator blocks via STEP_LOGIC_READS_API_INPUT —
  //      it couples the step to HTTP-gateway callers only, breaking reusability
  //      in non-HTTP flows.
  //   2) The helper sat dead in every generated template: the LLM never
  //      calls this._resolveInput(), it reads this.data.X directly.
  // Splice v3.x now wires stepInputData via gateway outputExample correctly,
  // so this.data resolution is reliable — the fallback is obsolete. Steps
  // that genuinely need helper logic can declare a local helper themselves;
  // the harness shouldn't inject code that violates its own validator.

  // 2. Resolve icon (never throw)
  const specCopy = JSON.parse(JSON.stringify(spec));
  await resolveIcon(specCopy, log);

  // 3. Handle versioning
  if (opts.currentVersion) {
    specCopy.version = bumpPatch(opts.currentVersion);
    log(`  [harness] Version bumped: ${opts.currentVersion} -> ${specCopy.version}`);
  } else if (!specCopy.version) {
    specCopy.version = '1.0.0';
  }

  // 4. Ensure required spec fields
  if (!specCopy.categories || specCopy.categories.length === 0) {
    specCopy.categories = ['Pre-release'];
  }
  if (!specCopy.size) {
    specCopy.size = specCopy.kind === 'gateway' ? 'large' : specCopy.kind === 'http' ? 'medium' : 'small';
  }

  // 5. Build complete template via stepBuilder
  let template;
  try {
    template = buildStepTemplateFromSpec(specCopy, fullCode, {
      log: (...args) => log('  [stepBuilder]', ...args),
      generateIcon: (pattern, options) => {
        const { iconUrl } = require('./iconGenerator');
        const url = iconUrl(pattern);
        if (url && url.length <= 255) return { iconUrl: url };
        return null;
      },
    });
  } catch (buildErr) {
    log(`  [harness] buildStepTemplateFromSpec failed: ${buildErr.message}`);
    log('  [harness] Falling back to manual template construction');

    const { buildExits } = require('./stepBuilder');
    const { dataExits, formExits, hasProcessError, hasProcessTimeout } = buildExits(specCopy);

    template = {
      id: uuid(),
      label: specCopy.label || specCopy.name || 'Step',
      version: specCopy.version || '1.0.0',
      cacheVersion: uuid(),
      template: fullCode,
      icon: specCopy.icon || 'code',
      iconType: specCopy.iconType || 'default',
      iconUrl: specCopy.iconUrl || '',
      shape: specCopy.shape || 'circle',
      description: (specCopy.description || '').slice(0, 250),
      isGatewayStep: false,
      categories: specCopy.categories || ['Pre-release'],
      tags: specCopy.tags || [],
      form: { component: null },
      data: {
        exits: dataExits,
        processError: hasProcessError,
        processTimeout: hasProcessTimeout,
        ...(specCopy.dataOut ? { dataOut: specCopy.dataOut } : {}),
      },
      formBuilder: {
        stepExits: formExits,
        hasDataOut: !!specCopy.dataOut,
        stepInputs: _buildFallbackInputs(specCopy),
        formTemplate: "<!-- Form elements -->\n    <%= inputs ? inputs.join('\\n    ') : '' %>\n<!-- End form elements -->",
        hasProcessError,
        hasProcessTimeout,
      },
      outputExample: specCopy.outputExample || null,
      modules: specCopy.modules || null,
      help: '',
      dateCreated: Date.now(),
      dateModified: Date.now(),
    };
  }

  // 5b. Summarize description if too long (requires ANTHROPIC_KEY)
  if (template.description && template.description.length > 255) {
    const { summarizeDescription } = require('./stepBuilder');
    template.description = await summarizeDescription(template.description, template.label || specCopy.label, log);
  }

  // 5c. Clean bogus exits from playbook table parsing
  // The conceive step sometimes parses timeout/field table rows as exits.
  // Strip any exit whose ID contains special chars or doesn't match the exit ID pattern.
  {
    const EXIT_ID_RE = /^[a-z_][a-z0-9_]*$/;
    const cleanExits = (exits) => {
      if (!Array.isArray(exits)) return exits;
      const before = exits.length;
      const cleaned = exits.filter(e => EXIT_ID_RE.test(e.id));
      if (cleaned.length < before) {
        const removed = exits.filter(e => !EXIT_ID_RE.test(e.id)).map(e => e.id);
        log(`  [harness] Removed ${removed.length} bogus exit(s): ${removed.join(', ')}`);
      }
      return cleaned;
    };
    if (template.data?.exits) template.data.exits = cleanExits(template.data.exits);
    if (template.formBuilder?.stepExits) {
      template.formBuilder.stepExits = template.formBuilder.stepExits.filter(e => EXIT_ID_RE.test(e.data?.id));
    }
  }

  // 5c. Ensure all this.data.* references have formBuilder inputs
  _ensureInputsFromCode(template, specCopy);
  if (template.formBuilder?.stepInputs?.length > 0) {
    log(`  [harness] formBuilder has ${template.formBuilder.stepInputs.length} input(s)`);
  }

  // 5d. Strip renderConditions for API/async steps — they crash Edison Studio
  // when input values are merge field expressions (ReferenceError: <var> is not defined).
  // renderConditions only work when stepInputData has plain literal values.
  if (specCopy.kind === 'api' || specCopy.kind === 'http') {
    let stripped = 0;
    for (const inp of (template.formBuilder?.stepInputs || [])) {
      if (inp.data?.renderCondition && inp.data.renderCondition !== '') {
        inp.data.renderCondition = '';
        stripped++;
      }
    }
    if (stripped > 0) {
      log(`  [harness] Stripped ${stripped} renderCondition(s) — not compatible with API/async flow pattern`);
    }
  }

  // 5e. Logging pass — Phase 1 (deterministic) + Phase 2 (LLM)
  {
    const phase1 = replaceConsoleCalls(template.template);
    template.template = phase1.code;
    if (phase1.replacements > 0) {
      log(`  [logging] Phase 1: replaced ${phase1.replacements} console.* call(s) with this.log.*`);
    }

    // Early syntax check — before spending an LLM call on bad code. If the code
    // from generateCode is already broken, surface that cleanly and avoid
    // attributing the failure to strategic-logging Phase 2.
    // Discovered 2026-04-18: LLM occasionally emits `return 'key': value` (not
    // valid JS). The later syntax check would fire regardless, but the
    // `[logging] LLM error` line right before it was misleading.
    {
      const tmpEarly = require('path').join(require('os').tmpdir(), `harness-early-${Date.now()}.mjs`);
      try {
        require('fs').writeFileSync(tmpEarly, template.template);
        require('child_process').execSync(`node --check "${tmpEarly}"`, { stdio: 'pipe' });
      } catch (earlyErr) {
        const msg = (earlyErr.stderr || earlyErr.message || '').toString().trim();
        const firstLine = msg.split('\n').find(l => l.includes('Error') || l.includes('Syntax')) || msg.slice(0, 200);
        log(`  [harness] PRE-LOGGING SYNTAX ERROR (from generateCode, not harness): ${firstLine}`);
        throw new Error(`Generated code has syntax errors before harness logging pass: ${firstLine}. LLM produced malformed code — re-run generateCode stage.`);
      } finally {
        try { require('fs').unlinkSync(tmpEarly); } catch {}
      }
    }

    template.template = await addStrategicLogging(template.template, specCopy, log);

    // 5e-1. Re-run HARDCODED_URL / AUTH_NO_KV_RESOLUTION auto-repair.
    // Why: addStrategicLogging is an LLM pass that re-writes the code body
    // (adds log lines, restructures try/catch, etc). The LLM sometimes
    // UNDOES the auto-repair's URL substitution — e.g., adds a log line
    // `this.log.info('calling https://api.weatherapi.com')` with the URL as
    // a string literal, or rewrites a `const x = _resolved_var` back to
    // `const x = "https://..."`. That literal re-triggers the validator.
    // So we run auto-repair AGAIN on the post-logging code using the full
    // enriched spec if provided via opts.
    if (opts.autoRepairKnownBlockers && Array.isArray(specCopy?.inputs) && specCopy.inputs.length > 0) {
      try {
        const { validateStep } = require('./stepValidator');
        // Synthesize a quick probe template for the URL scan
        const synth = {
          id: 'harness-autorepair-probe',
          label: specCopy.label || 'probe',
          version: '1.0.0',
          template: template.template,
          form: {}, formBuilder: { stepInputs: [] },
          data: { exits: (specCopy.exits || [{ id: 'next', label: 'next' }]).map((e) => ({ id: e.id, label: e.label || e.id, condition: e.condition || '' })) },
        };
        const v = validateStep(synth);
        const blockers = (v.diagnostics || []).filter(d => d.severity === 'error' && ['HARDCODED_URL', 'AUTH_NO_KV_RESOLUTION'].includes(d.code));
        if (blockers.length > 0) {
          log(`  [harness.autoRepair] post-logging validator found ${blockers.length} blocker(s); repairing...`);
          const repair = opts.autoRepairKnownBlockers(template.template, specCopy, blockers, { log: (m) => log(`    [harness.autoRepair] ${m}`) });
          if (repair.applied.length > 0) {
            template.template = repair.code;
            log(`  [harness.autoRepair] applied ${repair.applied.length} fix(es) post-logging`);
          }
        }
      } catch (err) {
        log(`  [harness.autoRepair] skipped: ${err.message}`);
      }
    }
  }

  // 5e-2. Inject step-telemetry probe (opt-in).
  //   - 'off' (default): nothing injected
  //   - 'runtime':       probe module inlined + runStep wrapped; runtime
  //                      env var EDISON_STEP_PROBE=off disables at execution
  //   - 'always':        probe module inlined + runStep wrapped; runs
  //                      regardless of env flag
  // Injected code is fenced with `// @probe-begin` / `// @probe-end`
  // comments so scripts/strip-probe.js can remove it before release.
  const injectMode = opts.injectProbe || 'off';
  if (injectMode === 'runtime' || injectMode === 'always') {
    log(`  [harness] Injecting step probe (mode=${injectMode})...`);
    template.template = injectStepProbe(template.template, {
      mode: injectMode,
      log,
    });
  }

  // 5f. Syntax check — verify code parses before proceeding
  {
    const tmpPath = require('path').join(require('os').tmpdir(), `harness-check-${Date.now()}.mjs`);
    try {
      require('fs').writeFileSync(tmpPath, template.template);
      require('child_process').execSync(`node --check "${tmpPath}"`, { stdio: 'pipe' });
      log('  [harness] Syntax check passed');
    } catch (syntaxErr) {
      const msg = (syntaxErr.stderr || syntaxErr.message || '').toString().trim();
      const lines = template.template.split('\n');
      let depth = 0;
      for (const line of lines) {
        for (const ch of line) { if (ch === '{') depth++; if (ch === '}') depth--; }
      }
      log(`  [harness] SYNTAX ERROR: ${msg.split('\n').slice(-3).join(' | ')}`);
      if (depth !== 0) log(`  [harness] Brace mismatch: ${depth > 0 ? depth + ' unclosed {' : Math.abs(depth) + ' extra }'}`);
      throw new Error(`Generated code has syntax errors (brace depth: ${depth}). LLM produced incomplete code — re-run generateCode stage.`);
    } finally {
      try { require('fs').unlinkSync(tmpPath); } catch {}
    }
  }

  // 6. Validate + fix loop
  let allFixes = [];
  let lastDiagnostics = [];
  let valid = false;

  for (let iter = 1; iter <= maxFixIterations; iter++) {
    log(`  [harness] Validation pass ${iter}/${maxFixIterations}...`);

    const result = validateStep(template);
    lastDiagnostics = result.diagnostics || [];

    const errors = lastDiagnostics.filter(d => d.severity === 'error');
    const warnings = lastDiagnostics.filter(d => d.severity === 'warning');
    const infos = lastDiagnostics.filter(d => d.severity === 'info');

    log(`  [harness] Validation: ${errors.length} error(s), ${warnings.length} warning(s), ${infos.length} info`);

    if (errors.length === 0) {
      valid = true;
      log('  [harness] Template is valid');
      break;
    }

    for (const d of errors.slice(0, 5)) {
      log(`    [ERR] ${d.code}: ${d.message}`);
    }

    const fixable = lastDiagnostics.filter(d => d.context?.fixCode);
    if (fixable.length === 0) {
      log('  [harness] No auto-fixable issues — stopping');
      break;
    }

    const iterFixes = applyFixes(template, fixable, log);
    allFixes.push(...iterFixes);

    if (iterFixes.length === 0) {
      log('  [harness] No fixes applied — stopping');
      break;
    }
  }

  // 7. Also run spec-level validation
  try {
    const specResult = validateStepFromSpec(specCopy, template);
    if (specResult.diagnostics?.length > 0) {
      const specErrors = specResult.diagnostics.filter(d => d.severity === 'error');
      if (specErrors.length > 0) valid = false;
      for (const d of specResult.diagnostics) {
        if (!lastDiagnostics.some(existing => existing.code === d.code && existing.message === d.message)) {
          lastDiagnostics.push(d);
        }
      }
    }
  } catch { /* non-blocking */ }

  // 8. Ensure cacheVersion is fresh
  template.cacheVersion = uuid();
  template.dateModified = Date.now();

  const errors = lastDiagnostics.filter(d => d.severity === 'error');
  const warnings = lastDiagnostics.filter(d => d.severity === 'warning');

  log(`  [harness] Final: ${valid ? 'VALID' : errors.length + ' error(s)'}, ${warnings.length} warning(s), ${allFixes.length} fix(es) applied`);
  log(`  [harness] Template: "${template.label}" v${template.version} (${template.template.length} chars, ${(template.formBuilder?.stepInputs || []).length} inputs)`);

  return {
    template,
    diagnostics: lastDiagnostics,
    valid,
    fixes: allFixes,
    version: template.version,
    className,
  };
}

// ---------------------------------------------------------------------------
// Step telemetry probe injection
// ---------------------------------------------------------------------------
//
// Injects ~90 lines of inline probe code into a generated step template
// so every exit gets logged to stepTraces KV. Intentionally self-contained
// (no require() of a non-existent module) so the step can run in Edison's
// Lambda runtime with no dependency changes.
//
// Two insertion points:
//   1. TOP OF FILE (above class) — fenced IIFE that defines _probe_* helpers
//   2. TOP OF runStep() — monkey-patches this.exitStep so every exit is probed
//
// Both fenced with @probe-begin / @probe-end so scripts/strip-probe.js can
// remove the probe entirely before release (Level 3 opt-out). The runtime
// env flag EDISON_STEP_PROBE=off (Level 1) short-circuits inside the probe
// helpers — they become true no-ops without touching the LLM's step body.
//
// Why monkey-patching exitStep rather than wrapping runStep's body: the
// LLM structures runStep many different ways (try/catch variants, early
// returns, nested conditionals). Rewriting the body risks mismatched
// braces. Monkey-patching exitStep works regardless of body shape — every
// exitStep() call gets the probe, then the original exit happens.
function injectStepProbe(templateCode, { mode = 'runtime', log = () => {} } = {}) {
  // The probe IIFE — self-contained, no external dependencies.
  // Defined as a const string for maintainability.
  const envGate = mode === 'runtime'
    ? "const _probe_enabled = !['off','0','false'].includes(String(process.env.EDISON_STEP_PROBE||'').toLowerCase());"
    : "const _probe_enabled = true;  // injected with mode='always'";

  const probeIIFE = `
// @probe-begin [codeHarness: step telemetry probe]
// Injection mode: ${mode}. Strip via scripts/strip-probe.js.
const _probe_kv_base = 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue';
const _probe_collection = 'stepTraces';
${envGate}
const _probe_state = { marks: [], t0: Date.now(), key: null, seeded: false };
function _probe_cap(v) {
  if (v == null) return v;
  if (typeof v === 'string') return v.length > 2000 ? v.slice(0, 2000) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  try { const s = JSON.stringify(v); return s.length > 2000 ? { _truncated: true, preview: s.slice(0, 2000) + '…' } : v; }
  catch { return '[unserializable]'; }
}
function _probe_redact(data) {
  if (!data || typeof data !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (/password|secret|token|key|credential|auth/i.test(k)) { out[k] = '[REDACTED]'; continue; }
    out[k] = _probe_cap(v);
  }
  return out;
}
async function _probe_kv_merge(patch) {
  if (!_probe_enabled || !_probe_state.key) return;
  try {
    const getUrl = _probe_kv_base + '?id=' + encodeURIComponent(_probe_collection) + '&key=' + encodeURIComponent(_probe_state.key);
    const r = await fetch(getUrl);
    const d = await r.json().catch(() => ({}));
    const prior = (d && typeof d.value === 'string' && d.value) ? (() => { try { return JSON.parse(d.value); } catch { return {}; } })() : {};
    const merged = { ...prior };
    for (const [k, v] of Object.entries(patch || {})) {
      if (v === undefined) continue;
      if (k === 'marks' && Array.isArray(v)) {
        const ex = new Set((prior.marks || []).map((m) => m.label + '|' + (m.atMs || 0)));
        const appended = v.filter((m) => !ex.has(m.label + '|' + (m.atMs || 0)));
        merged.marks = [...(prior.marks || []), ...appended].slice(-200);
      } else {
        merged[k] = v;
      }
    }
    merged.updatedAt = new Date().toISOString();
    await fetch(getUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: _probe_collection, key: _probe_state.key, itemValue: JSON.stringify(merged) }) });
  } catch { /* probe failures never crash the step */ }
}
function _probe_start(step, stepLabel) {
  if (!_probe_enabled || _probe_state.seeded) return;
  const pbID = String((step.data && step.data.playbookID) || 'na');
  const jobId = String((step.data && step.data.jobId) || 'na');
  const stepId = String(stepLabel || (step.constructor && step.constructor.name) || 'step');
  _probe_state.key = pbID + '__' + jobId + '__' + stepId;
  _probe_state.seeded = true;
  _probe_state.t0 = Date.now();
  _probe_kv_merge({
    stepId, playbookID: pbID, jobId, stepLabel: stepId,
    startedAt: new Date().toISOString(),
    inputsAtEntry: _probe_redact(step.data || {}),
    marks: [],
    env: { nodeVersion: typeof process !== 'undefined' ? process.version : null },
  });
}
function _probe_mark(label, data) {
  if (!_probe_enabled || !_probe_state.seeded) return;
  const m = { label: String(label).slice(0, 100), at: new Date().toISOString(), atMs: Date.now() - _probe_state.t0, data: _probe_cap(data) };
  _probe_state.marks.push(m);
  _probe_kv_merge({ marks: [m] });
}
function _probe_done(exitId, payload, err) {
  if (!_probe_enabled || !_probe_state.seeded) return;
  const patch = {
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - _probe_state.t0,
  };
  if (err) {
    patch.error = { message: err.message || String(err), name: err.name || 'Error', stack: _probe_cap(err.stack) };
  } else {
    patch.exit = { type: String(exitId || 'next'), payload: _probe_cap(payload) };
  }
  _probe_kv_merge(patch);
}
// @probe-end
`;

  // Monkey-patch block injected at the top of runStep's body. Safe to call
  // multiple times (the .seeded guard ensures the seed write fires once).
  const runStepHeader = `
    // @probe-begin [codeHarness]
    try {
      _probe_start(this);
      const __probe_orig_exit = this.exitStep.bind(this);
      this.exitStep = (exitId, payload) => {
        try { _probe_done(exitId, payload, null); } catch {}
        return __probe_orig_exit(exitId, payload);
      };
    } catch { /* probe init failed — step continues unprobed */ }
    // @probe-end
`;

  // Insert the probe IIFE right after the Step-class import line and
  // before the class declaration. Falls back to prepending at the file
  // start if we can't find the expected markers.
  let out = templateCode;
  const classRe = /^(const Step = StepMod\.default \|\| StepMod;\s*)/m;
  if (classRe.test(out)) {
    out = out.replace(classRe, '$1\n' + probeIIFE);
    log('  [harness.probe] IIFE injected after Step import');
  } else {
    // Fallback: prepend
    out = probeIIFE + '\n' + out;
    log('  [harness.probe] IIFE prepended (Step import marker not found)');
  }

  // Insert the monkey-patch at the top of runStep's body. Match the first
  // `async runStep() {` or `async runStep ( ) {` and inject right after `{`.
  const runStepRe = /(async\s+runStep\s*\([^)]*\)\s*\{)/;
  if (runStepRe.test(out)) {
    out = out.replace(runStepRe, '$1' + runStepHeader);
    log('  [harness.probe] runStep() header injected');
  } else {
    log('  [harness.probe] WARNING: async runStep() not found — probe will NOT activate. IIFE still present but unused.');
  }

  return out;
}

module.exports = { harnessCode, wrapInEsmClass, toClassName, bumpPatch, injectStepProbe };
