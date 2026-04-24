// ---------------------------------------------------------------------------
// detailedPlanGenerator.js — produces a rich, LLM-readable step-build plan
// from a playbook.
//
// CONTRACT — every section the downstream pipeline needs to build a step,
// written at a detail level that makes subsequent LLM work straightforward
// (no additional inference of inputs, outputs, exit semantics, etc.). The
// plan is the single canonical source-of-truth that feeds:
//
//   - stageGenerateCode (reads inputs, outputs, exits, logic, integrations)
//   - stageHarnessCode (reads ui, platformRequirements)
//   - stageTestStep / stageLocalScenarioRun (reads testing.scenarios)
//   - stageDesignUI (reads ui)
//   - WISER UI (renders the plan for human review before code is generated)
//
// SCHEMA v1.0.0
//
//   {
//     schemaVersion: '1.0.0',
//     playbookId: string,
//     generatedAt: ISO,
//     generatedBy: 'detailed-plan-generator-v1',
//     sourcePlaybookVersion: string,          // playbook.updated_at snapshot
//     sections: {
//       identity: {
//         name, label, kind, version, description,
//         categories, icon, shape, size
//       },
//       inputs: [{
//         variable, label, type, component, required, default, helpText,
//         example, validation, allowMergeFields, allowCodeMode, options,
//         renderCondition
//       }],
//       outputs: {
//         dataOut: { name, type, ttl },
//         schema: { <field>: { type, required, description } },
//         example: { ... }
//       },
//       exits: [{ id, label, condition, when }],
//       ui: {
//         formLayout: 'vertical' | 'horizontal',
//         groups: [{ label, fields: [variable], collapsed }],
//         renderConditions: [{ target, when }]
//       },
//       events: {
//         emits: [{ name, payload, when }],
//         listens: [{ name, action }]
//       },
//       platformRequirements: {
//         reusability: [string],
//         logging: [string],
//         exits: [string],
//         auth: [string],
//         errors: [string]
//       },
//       logic: {
//         summary: string,
//         pseudocode: [string],
//         errorHandling: [{ case, action }]
//       },
//       integrations: [{
//         name, purpose, endpoint, method, auth, request, response,
//         timeoutMs, errorCodes
//       }],
//       testing: {
//         scenarios: [{ name, input, expect }]
//       },
//       useCases: [{ title, description, scenario }]
//     },
//     sectionErrors: { <sectionName>: string }   // per-section failures
//   }
//
// EXECUTION — 3 parallel waves:
//
//   Wave 1 (8 parallel LLM calls, independent):
//     identity, inputs, outputs, exits, ui, events, integrations, useCases
//
//   Wave 2 (1 LLM call + 1 deterministic, depends on wave 1):
//     logic (uses inputs/outputs/exits/integrations from wave 1)
//     platformRequirements (DETERMINISTIC — from lib/platformRules.js)
//
//   Wave 3 (reuses testPlaybookGenerator from Phase 3):
//     testing (uses everything above — scenarios with assertions)
//
//   Partial-plan tolerance: any section that errors returns `null` in the
//   plan + an entry in `sectionErrors`. The plan is still returned — the
//   caller decides whether the partial is usable.
//
// IDEMPOTENCY — the generator itself is stateless. Idempotency lives at
// the stageDecompose level: it checks the playbook for an existing
// `detailed-plan` asset with a matching `schemaVersion` before calling
// this module.
// ---------------------------------------------------------------------------

'use strict';

const PLAN_SCHEMA_VERSION = '1.0.0';
const GENERATOR_ID = 'detailed-plan-generator-v1';

// ---------------------------------------------------------------------------
// Shared JSON-response helper. Every section generator invokes Claude with:
//   - a section-specific system prompt
//   - a user prompt containing the playbook
//   - explicit "output ONLY this JSON shape" instruction
// and this helper handles the parse + shape-validation.
// ---------------------------------------------------------------------------
async function callSectionLlm({ systemPrompt, userPrompt, apiKey, model, log }) {
  let callAnthropicDirect, hasApiKey, getApiKey;
  try {
    ({ callAnthropicDirect, hasApiKey, getApiKey } = require('./llmClient'));
  } catch (err) {
    return { ok: false, error: `llmClient unavailable: ${err.message}` };
  }
  const key = apiKey || getApiKey();
  if (!key || !hasApiKey(key)) return { ok: false, error: 'no API key available' };

  let resp;
  try {
    resp = await callAnthropicDirect(key, systemPrompt, userPrompt, {
      model: model || undefined,
      maxTokens: 4096,
      cacheSystem: true,
      cacheTtl: '1h',
    });
  } catch (err) {
    return { ok: false, error: `LLM call threw: ${err.message}` };
  }
  if (resp.error || !resp.raw) {
    return { ok: false, error: `LLM returned error: ${String(resp.error || 'empty').slice(0, 120)}` };
  }

  // Parse JSON, tolerant of fences + leading prose
  const raw = String(resp.raw).trim();
  const fence = raw.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = (fence ? fence[1].trim() : raw);
  let parsed = null;
  try { parsed = JSON.parse(candidate); } catch {}
  if (!parsed) {
    // Try to extract a balanced object/array
    const firstBrace = Math.min(...['{', '['].map((c) => {
      const i = candidate.indexOf(c);
      return i === -1 ? Infinity : i;
    }));
    if (firstBrace < Infinity) {
      // Walk to the matching closer
      const open = candidate[firstBrace];
      const close = open === '{' ? '}' : ']';
      let depth = 0;
      for (let i = firstBrace; i < candidate.length; i++) {
        if (candidate[i] === open) depth++;
        else if (candidate[i] === close) {
          depth--;
          if (depth === 0) {
            try { parsed = JSON.parse(candidate.slice(firstBrace, i + 1)); break; } catch {}
          }
        }
      }
    }
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'response was not parseable JSON' };
  }
  return { ok: true, data: parsed };
}

// ---------------------------------------------------------------------------
// Section prompt builders — each returns { systemPrompt, userPrompt, shape }
// so the test stubs can verify structure without running the real LLM.
// ---------------------------------------------------------------------------

const IDENTITY_SYSTEM = 'You are a step-building architect. Extract the step\'s identity from the playbook. Output ONLY a JSON object matching the requested shape. No prose, no markdown.';
function identityPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 6000);
  return {
    systemPrompt: IDENTITY_SYSTEM,
    userPrompt: [
      'Extract the step identity from this playbook.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON only)',
      '{',
      '  "name": "snake_case step id (no spaces, no punctuation besides underscore)",',
      '  "label": "Human-Readable Step Label (no \\"GSX library step:\\" prefix)",',
      '  "kind": "logic" | "gateway" | "module",',
      '  "version": "1.0.0",',
      '  "description": "<=200 chars summarizing what the step does",',
      '  "categories": ["Category1", "Category2"],',
      '  "icon": "suggested icon name (e.g. edit, brain, search)",',
      '  "shape": "circle" | "square",',
      '  "size": "small" | "medium" | "large"',
      '}',
      '',
      'CRITICAL: If the playbook title starts with framing like "a GSX library step:" or "an agentic X" or "a step that Y", SKIP the framing and extract the real subject. For "a GSX library step: an agentic Find and Replace agent" the correct label is "Find & Replace Agent", NOT "GSX".',
    ].join('\n'),
  };
}

const INPUTS_SYSTEM = 'You are a step-building architect. Enumerate every input the step needs as a detailed, form-ready JSON array. Output ONLY the JSON array. No prose.';
function inputsPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 8000);
  return {
    systemPrompt: INPUTS_SYSTEM,
    userPrompt: [
      'List every input the step needs, with the shape ready for Edison formBuilder.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON array only)',
      '[',
      '  {',
      '    "variable": "camelCaseName",',
      '    "label": "Human Label",',
      '    "type": "text" | "textarea" | "number" | "boolean" | "select" | "date" | "code" | "json" | "auth",',
      '    "component": "formTextInput" | "formTextBox" | "formTextArea" | "formNumberInput" | "formSwitch" | "formSelect" | "formDate" | "formCode" | "formJson" | "auth-external-component",',
      '    "required": true | false,',
      '    "default": "default value or null",',
      '    "helpText": "What the user should enter here",',
      '    "example": "Example value for docs/tests",',
      '    "validation": { "minLength": 0, "maxLength": 0, "pattern": "regex or null" },',
      '    "allowMergeFields": true | false,',
      '    "allowCodeMode": true | false,',
      '    "options": [{ "value": "x", "label": "X" }] | null,',
      '    "renderCondition": "when to show (e.g. `mode === \\"concept\\"`) or null"',
      '  }',
      ']',
      '',
      'Include ALL inputs: required ones, optional ones with defaults, auth inputs (type="auth"), configuration knobs (timeouts, retries, max lengths). Minimum 3 inputs unless the step is genuinely trivial.',
    ].join('\n'),
  };
}

const OUTPUTS_SYSTEM = 'You are a step-building architect. Define the step\'s output schema precisely. Output ONLY JSON.';
function outputsPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 6000);
  return {
    systemPrompt: OUTPUTS_SYSTEM,
    userPrompt: [
      'Define the output shape this step emits.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON only)',
      '{',
      '  "dataOut": {',
      '    "name": "camelCaseMergeFieldName",',
      '    "type": "session" | "thread" | "shared",',
      '    "ttl": 86400000',
      '  },',
      '  "schema": {',
      '    "<fieldName>": { "type": "string" | "number" | "boolean" | "array" | "object", "required": true | false, "description": "What this field means" }',
      '  },',
      '  "example": { "<fieldName>": "realistic sample value" }',
      '}',
      '',
      'The example MUST be consistent with the schema: same field names, matching types, realistic content (not placeholders like "example string"). Downstream merge-field pickers render this example literally.',
    ].join('\n'),
  };
}

const EXITS_SYSTEM = 'You are a step-building architect. Define every exit the step can take. Output ONLY a JSON array.';
function exitsPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 6000);
  return {
    systemPrompt: EXITS_SYSTEM,
    userPrompt: [
      'List every exit the step can take, including success, branch alternatives, and error paths.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON array only)',
      '[',
      '  { "id": "next", "label": "Success", "condition": "", "when": "Plain-English description of what triggers this exit" },',
      '  { "id": "unavailable", "label": "Service Unavailable", "condition": "", "when": "External service returned 5xx or timed out" },',
      '  { "id": "__error__", "label": "Error", "condition": "processError", "when": "Any unhandled exception — sets {code, message} payload" },',
      '  { "id": "__timeout__", "label": "Timeout", "condition": "processTimeout", "when": "Step exceeded its declared timeoutDuration" }',
      ']',
      '',
      'ALWAYS include both __error__ (condition: "processError") and __timeout__ (condition: "processTimeout") plus any domain-specific alternative exits. For "next" use condition: "" (empty).',
    ].join('\n'),
  };
}

const UI_SYSTEM = 'You are a step-building UI designer. Define the formBuilder layout and conditional rules. Output ONLY JSON.';
function uiPrompt(playbook, inputs) {
  return {
    systemPrompt: UI_SYSTEM,
    userPrompt: [
      'Design the form layout for this step\'s configuration UI.',
      '',
      '## Playbook excerpt',
      truncateForPrompt(playbook, 3000),
      '',
      '## Inputs (already defined)',
      '```json',
      JSON.stringify(inputs || [], null, 2).slice(0, 2500),
      '```',
      '',
      '## Output shape (JSON only)',
      '{',
      '  "formLayout": "vertical" | "horizontal",',
      '  "groups": [',
      '    { "label": "Group Title", "fields": ["variable1", "variable2"], "collapsed": false }',
      '  ],',
      '  "renderConditions": [',
      '    { "target": "variable whose visibility depends on another", "when": "expression like `mode === \\"regex\\"`" }',
      '  ]',
      '}',
      '',
      'Group related inputs (required vs optional, input vs transformation, transformation vs output). Use collapsed:true for advanced/rarely-changed groups. Put renderConditions on inputs that only make sense when another input is set to a specific value.',
    ].join('\n'),
  };
}

const EVENTS_SYSTEM = 'You are a step-building architect. Identify event emissions and subscriptions. Output ONLY JSON.';
function eventsPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 4000);
  return {
    systemPrompt: EVENTS_SYSTEM,
    userPrompt: [
      'Identify any events this step emits or listens for. Most logic steps emit NOTHING — output empty arrays when applicable.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON only)',
      '{',
      '  "emits": [{ "name": "event.name", "payload": "shape description", "when": "trigger condition" }],',
      '  "listens": [{ "name": "event.name", "action": "what happens when received" }]',
      '}',
      '',
      'If the step is a pure transform with no event semantics, return { "emits": [], "listens": [] }.',
    ].join('\n'),
  };
}

const INTEGRATIONS_SYSTEM = 'You are a step-building architect. Enumerate external APIs and integrations. Output ONLY a JSON array.';
function integrationsPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 6000);
  return {
    systemPrompt: INTEGRATIONS_SYSTEM,
    userPrompt: [
      'List every external API/service this step calls.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON array only)',
      '[',
      '  {',
      '    "name": "Service Display Name",',
      '    "purpose": "What we use this service for in this step",',
      '    "endpoint": "https://api.example.com/v1/resource",',
      '    "method": "GET" | "POST" | "PUT" | "DELETE",',
      '    "auth": "api-key-header" | "bearer-token" | "oauth2" | "none",',
      '    "request": { "shape": "JSON body description", "example": { } },',
      '    "response": { "shape": "JSON response description", "example": { } },',
      '    "timeoutMs": 15000,',
      '    "errorCodes": ["RATE_LIMITED", "UNAUTHORIZED", "SERVICE_UNAVAILABLE"]',
      '  }',
      ']',
      '',
      'Include LLM APIs (Anthropic, OpenAI), data APIs, webhooks, auth services — any outbound HTTP. If the step is pure compute with no external calls, return [].',
    ].join('\n'),
  };
}

const USE_CASES_SYSTEM = 'You are a step-building architect. Describe concrete real-world invocations of this step. Output ONLY a JSON array.';
function useCasesPrompt(playbook) {
  const excerpt = truncateForPrompt(playbook, 6000);
  return {
    systemPrompt: USE_CASES_SYSTEM,
    userPrompt: [
      'Give 3-5 concrete, realistic use cases showing how a flow-builder would use this step. Each use case should feel like a real-world problem, not a synthetic test.',
      '',
      '## Playbook',
      excerpt,
      '',
      '## Output shape (JSON array only)',
      '[',
      '  {',
      '    "title": "Short title for this use case",',
      '    "description": "Paragraph explaining the real-world problem and why this step solves it",',
      '    "scenario": { ',
      '      "context": "Where in a flow this step fits",',
      '      "exampleInputs": { "variable1": "realistic value", "variable2": "realistic value" },',
      '      "expectedOutcome": "What the flow author gets back and what they do with it"',
      '    }',
      '  }',
      ']',
    ].join('\n'),
  };
}

const LOGIC_SYSTEM = 'You are a step-building architect. Write the step\'s logic as clean pseudocode and enumerate error handling paths. Output ONLY JSON.';
function logicPrompt(playbook, { inputs, outputs, exits, integrations }) {
  return {
    systemPrompt: LOGIC_SYSTEM,
    userPrompt: [
      'Write the step\'s logic: a summary, step-by-step pseudocode, and error-handling cases.',
      '',
      '## Playbook excerpt',
      truncateForPrompt(playbook, 3000),
      '',
      '## Inputs (already defined)',
      '```json',
      JSON.stringify(inputs || [], null, 2).slice(0, 1500),
      '```',
      '',
      '## Outputs (already defined)',
      '```json',
      JSON.stringify(outputs || {}, null, 2).slice(0, 1500),
      '```',
      '',
      '## Exits (already defined)',
      '```json',
      JSON.stringify(exits || [], null, 2).slice(0, 1000),
      '```',
      '',
      '## Integrations (already defined)',
      '```json',
      JSON.stringify(integrations || [], null, 2).slice(0, 1500),
      '```',
      '',
      '## Output shape (JSON only)',
      '{',
      '  "summary": "1-2 sentence what-the-step-does summary",',
      '  "pseudocode": [',
      '    "Step-by-step actions in plain English or light pseudocode",',
      '    "Each line should map to concrete code operations"',
      '  ],',
      '  "errorHandling": [',
      '    { "case": "When this happens", "action": "What the step does (which exit, which code, how it logs)" }',
      '  ]',
      '}',
      '',
      'The pseudocode MUST reference the declared inputs/outputs/exits by name. The errorHandling MUST enumerate every exit except `next` (one case per non-happy-path exit).',
    ].join('\n'),
  };
}

// ---------------------------------------------------------------------------
// truncateForPrompt — trim a playbook to a token budget for prompts.
// Keeps the first/last chars to preserve intent + cues.
// ---------------------------------------------------------------------------
function truncateForPrompt(playbook, budget) {
  const content = typeof playbook === 'string' ? playbook : (playbook?.content || JSON.stringify(playbook || {}));
  if (content.length <= budget) return content;
  const headBudget = Math.floor(budget * 0.65);
  const tailBudget = budget - headBudget - 50;
  return content.slice(0, headBudget) + '\n\n...[truncated]...\n\n' + content.slice(-tailBudget);
}

// ---------------------------------------------------------------------------
// generatePlatformRequirements — DETERMINISTIC from lib/platformRules.js.
// Returns the Edison platform conventions that apply to the step regardless
// of the playbook's specifics.
// ---------------------------------------------------------------------------
function generatePlatformRequirements() {
  let platformRules;
  try {
    platformRules = require('./platformRules');
  } catch {
    // Fall back to a minimal hardcoded set if platformRules.js isn't available
    return {
      reusability: [
        'Read every input from this.data — never this.mergeFields[\'<stepName>\']',
        'No hardcoded URLs, model names, collection names — take them as inputs',
        'No process.env references in step code',
        'Use this.log.* for all logging (never console.*)',
        'Generic error codes only (no flow-specific identifiers)',
      ],
      logging: [
        'One this.log.info at top of runStep() summarizing inputs received',
        'this.log.info at every decision branch',
        'this.log.error in every catch block with structured error data',
        'Log key decisions, not every variable assignment',
      ],
      exits: [
        '__error__ MUST appear in data.exits[] if code calls this.exitStep(\'__error__\', ...)',
        '__timeout__ MUST appear in data.exits[] if the step has processTimeout: true',
        'Every scenario path ends in exactly one exitStep call',
      ],
      auth: [
        'Auth credentials come via auth-external-component input (type: "auth")',
        'Resolve with const Storage = require(\'or-sdk/storage\'); await new Storage(this).get(collection, authId)',
        'Use the full service::token::<label> auth id — do not strip the prefix',
        'The collection name comes from the spec, not hardcoded',
      ],
      errors: [
        'Catch every await; exit via __error__ on failure',
        'Error payload shape: { code: \'STABLE_CODE\', message: \'human readable\' }',
        'Throw only when processError is false AND no exits handle the failure',
        'Never swallow an error silently (no empty catch blocks)',
      ],
    };
  }
  // Use platformRules.getRules() to pull the canonical rule set. Each rule
  // has { section: <number>, number, title, body, ... }. We map category
  // labels to the corresponding section number(s) from platform-rules.md.
  try {
    const rules = platformRules.getRules ? platformRules.getRules() : null;
    if (Array.isArray(rules) && rules.length > 0) {
      const sections = platformRules.getSections ? platformRules.getSections() : [];
      const findSection = (categoryKeyword) => {
        const s = sections.find((sec) => sec.title && sec.title.toLowerCase().includes(categoryKeyword.toLowerCase()));
        return s ? s.num : null;
      };
      const pickBySection = (categoryKeyword, limit = 8) => {
        const num = findSection(categoryKeyword);
        if (num === null) return [];
        return rules
          .filter((r) => r.section === num)
          .slice(0, limit)
          .map((r) => r.title)
          .filter(Boolean);
      };
      const pulled = {
        reusability: pickBySection('reusability'),
        logging: pickBySection('logging'),
        exits: pickBySection('exit'),
        auth: pickBySection('auth'),
        errors: pickBySection('error'),
      };
      // If any category came back empty, use the static fallback for it —
      // section titles in platform-rules.md may not match the category
      // keyword exactly (e.g. "Error Handling" vs "errors").
      const needsFallback = Object.values(pulled).some((arr) => arr.length === 0);
      if (needsFallback) {
        const fallback = _staticPlatformRequirements();
        for (const k of Object.keys(pulled)) {
          if (pulled[k].length === 0) pulled[k] = fallback[k];
        }
      }
      return pulled;
    }
  } catch { /* fall through */ }
  return _staticPlatformRequirements();
}

function _staticPlatformRequirements() {
  return {
    reusability: [
      'Read every input from this.data — never this.mergeFields[\'<stepName>\']',
      'No hardcoded URLs, model names, collection names — take them as inputs',
      'No process.env references in step code',
      'Use this.log.* for all logging (never console.*)',
      'Generic error codes only (no flow-specific identifiers)',
    ],
    logging: [
      'One this.log.info at top of runStep() summarizing inputs received',
      'this.log.info at every decision branch',
      'this.log.error in every catch block with structured error data',
      'Log key decisions, not every variable assignment',
    ],
    exits: [
      '__error__ MUST appear in data.exits[] if code calls this.exitStep(\'__error__\', ...)',
      '__timeout__ MUST appear in data.exits[] if the step has processTimeout: true',
      'Every scenario path ends in exactly one exitStep call',
    ],
    auth: [
      'Auth credentials come via auth-external-component input (type: "auth")',
      'Resolve with const Storage = require(\'or-sdk/storage\'); await new Storage(this).get(collection, authId)',
      'Use the full service::token::<label> auth id — do not strip the prefix',
      'The collection name comes from the spec, not hardcoded',
    ],
    errors: [
      'Catch every await; exit via __error__ on failure',
      'Error payload shape: { code: \'STABLE_CODE\', message: \'human readable\' }',
      'Throw only when processError is false AND no exits handle the failure',
      'Never swallow an error silently (no empty catch blocks)',
    ],
  };
}

// ---------------------------------------------------------------------------
// generateTesting — reuse the Phase 3 test playbook generator. Produces
// scenarios with behavioral assertions (diffNonEmpty, rewrittenDiffers)
// where applicable.
// ---------------------------------------------------------------------------
async function generateTesting({ playbook, inputs, outputs, exits, apiKey, log }) {
  try {
    const { buildOpenApi } = require('./flowOpenApiExtractor');
    const { generateTestPlaybook } = require('./testPlaybookGenerator');
    // Build a synthetic template + extract OpenAPI → feed to the generator
    const syntheticTemplate = {
      name: 'synthetic-for-plan',
      label: 'Plan Preview',
      description: (playbook && playbook.content ? String(playbook.content).slice(0, 300) : ''),
      formBuilder: {
        stepInputs: (inputs || []).map((i) => ({
          component: i.component || 'formTextInput',
          data: {
            variable: i.variable,
            label: i.label || i.variable,
            helpText: i.helpText || '',
            validateRequired: i.required === true,
            defaultValue: i.default,
            options: Array.isArray(i.options) ? i.options : undefined,
          },
        })),
      },
      data: { exits: exits || [] },
      outputExample: outputs?.example || {},
    };
    const openApi = buildOpenApi({
      template: syntheticTemplate,
      gatewayPath: '/plan-preview',
    });
    const result = await generateTestPlaybook({
      sourcePlaybook: typeof playbook === 'string' ? playbook : (playbook?.content || ''),
      openApi,
      target: { flowId: 'plan-preview', flowUrl: '(not-yet-deployed)', label: 'Plan Preview', name: 'plan_preview' },
      opts: { apiKey, llmMode: apiKey ? 'auto' : 'off', log },
    });
    return { scenarios: result.scenarios };
  } catch (err) {
    return { scenarios: [], error: err.message };
  }
}

// ---------------------------------------------------------------------------
// generateDetailedPlan — main entry.
// ---------------------------------------------------------------------------
async function generateDetailedPlan({
  playbookId,
  playbook,           // full playbook object (KV body) or markdown string
  apiKey = null,
  model = null,
  log = console.log,
  onProgress = null,
} = {}) {
  const t0 = Date.now();
  if (!playbookId || typeof playbookId !== 'string') {
    throw new Error('generateDetailedPlan: playbookId required');
  }
  if (!playbook) {
    throw new Error('generateDetailedPlan: playbook (object or markdown) required');
  }

  const emitProgress = (stage, status, extra) => {
    log(`[detailed-plan] ${stage}: ${status}${extra ? ' — ' + extra : ''}`);
    if (typeof onProgress === 'function') {
      try { onProgress({ stage, status, ...(extra && { extra }) }); } catch {}
    }
  };

  const sectionErrors = {};

  // ── Wave 1: 8 parallel LLM calls ─────────────────────────────────────
  emitProgress('wave-1', 'dispatching 8 parallel section generators');
  const w1 = async (name, buildPrompt) => {
    try {
      const { systemPrompt, userPrompt } = buildPrompt(playbook);
      const r = await callSectionLlm({ systemPrompt, userPrompt, apiKey, model, log: (m) => log('  [' + name + '] ' + m) });
      if (!r.ok) {
        sectionErrors[name] = r.error;
        return null;
      }
      return r.data;
    } catch (err) {
      sectionErrors[name] = err.message;
      return null;
    }
  };

  const [identity, inputs, outputs, exits, events, integrations, useCases] = await Promise.all([
    w1('identity', identityPrompt),
    w1('inputs', inputsPrompt),
    w1('outputs', outputsPrompt),
    w1('exits', exitsPrompt),
    w1('events', eventsPrompt),
    w1('integrations', integrationsPrompt),
    w1('useCases', useCasesPrompt),
  ]);
  emitProgress('wave-1', 'complete', `identity=${identity ? 'ok' : 'err'}, inputs=${Array.isArray(inputs) ? inputs.length : 'err'}, outputs=${outputs ? 'ok' : 'err'}, exits=${Array.isArray(exits) ? exits.length : 'err'}`);

  // ── UI depends on inputs — can run in wave 1's tail or as wave-1.5 ───
  let ui = null;
  if (Array.isArray(inputs) && inputs.length > 0) {
    try {
      const { systemPrompt, userPrompt } = uiPrompt(playbook, inputs);
      const r = await callSectionLlm({ systemPrompt, userPrompt, apiKey, model, log: (m) => log('  [ui] ' + m) });
      if (!r.ok) sectionErrors.ui = r.error;
      else ui = r.data;
    } catch (err) {
      sectionErrors.ui = err.message;
    }
  } else {
    sectionErrors.ui = 'no inputs from wave 1 — skipping';
  }
  emitProgress('ui', ui ? 'ok' : 'err');

  // ── Wave 2: logic (depends on wave 1) + platformRequirements (deterministic) ─
  emitProgress('wave-2', 'dispatching logic + platformRequirements');
  let logic = null;
  try {
    const { systemPrompt, userPrompt } = logicPrompt(playbook, { inputs, outputs, exits, integrations });
    const r = await callSectionLlm({ systemPrompt, userPrompt, apiKey, model, log: (m) => log('  [logic] ' + m) });
    if (!r.ok) sectionErrors.logic = r.error;
    else logic = r.data;
  } catch (err) {
    sectionErrors.logic = err.message;
  }
  const platformRequirements = generatePlatformRequirements();
  emitProgress('wave-2', 'complete', `logic=${logic ? 'ok' : 'err'}, platformRequirements=ok`);

  // ── Wave 3: testing (uses inputs/outputs/exits) ──────────────────────
  emitProgress('wave-3', 'generating testing scenarios');
  let testing = null;
  try {
    testing = await generateTesting({ playbook, inputs, outputs, exits, apiKey, log: (m) => log('  [testing] ' + m) });
  } catch (err) {
    sectionErrors.testing = err.message;
  }
  emitProgress('wave-3', 'complete', `scenarios=${testing?.scenarios?.length || 0}`);

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    playbookId,
    generatedAt: new Date().toISOString(),
    generatedBy: GENERATOR_ID,
    sourcePlaybookVersion: playbook?.updated_at || playbook?.updatedAt || null,
    sections: {
      identity: identity || null,
      inputs: inputs || null,
      outputs: outputs || null,
      exits: exits || null,
      ui: ui || null,
      events: events || null,
      platformRequirements,
      logic: logic || null,
      integrations: integrations || null,
      testing: testing || null,
      useCases: useCases || null,
    },
    sectionErrors: Object.keys(sectionErrors).length > 0 ? sectionErrors : null,
    elapsedMs: Date.now() - t0,
  };

  const sectionCount = Object.values(plan.sections).filter((v) => v !== null).length;
  log(`[detailed-plan] generated ${sectionCount}/11 sections in ${plan.elapsedMs}ms${plan.sectionErrors ? ' — ' + Object.keys(plan.sectionErrors).length + ' section error(s)' : ''}`);
  return plan;
}

// ---------------------------------------------------------------------------
// renderPlanAsMarkdown — for humans. Takes a plan JSON and produces a
// readable markdown rendering. Used for the playbook asset's `content`
// field (LLMs consume the JSON at `asset.data`, humans read the markdown).
// ---------------------------------------------------------------------------
function renderPlanAsMarkdown(plan) {
  if (!plan || typeof plan !== 'object') return '';
  const s = plan.sections || {};
  const lines = [];
  lines.push(`# Detailed Plan: ${s.identity?.label || '(unnamed step)'}`);
  lines.push('');
  lines.push(`_Generated ${plan.generatedAt} · schema v${plan.schemaVersion} · source playbook ${plan.playbookId}_`);
  lines.push('');

  if (s.identity) {
    lines.push('## Identity');
    lines.push(`- **Name**: \`${s.identity.name || ''}\``);
    lines.push(`- **Label**: ${s.identity.label || ''}`);
    lines.push(`- **Kind**: ${s.identity.kind || 'logic'}`);
    lines.push(`- **Description**: ${s.identity.description || ''}`);
    if (Array.isArray(s.identity.categories) && s.identity.categories.length) {
      lines.push(`- **Categories**: ${s.identity.categories.join(', ')}`);
    }
    lines.push('');
  }

  if (Array.isArray(s.inputs) && s.inputs.length) {
    lines.push('## Inputs');
    for (const inp of s.inputs) {
      lines.push(`### \`${inp.variable}\` — ${inp.label || inp.variable}`);
      lines.push(`Type: \`${inp.type}\` · Required: ${inp.required ? 'yes' : 'no'}${inp.default !== undefined && inp.default !== null ? ` · Default: \`${JSON.stringify(inp.default)}\`` : ''}`);
      if (inp.helpText) lines.push(inp.helpText);
      if (inp.example !== undefined) lines.push(`Example: \`${JSON.stringify(inp.example)}\``);
      lines.push('');
    }
  }

  if (s.outputs) {
    lines.push('## Outputs');
    lines.push('```json');
    lines.push(JSON.stringify(s.outputs, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (Array.isArray(s.exits) && s.exits.length) {
    lines.push('## Exits');
    for (const e of s.exits) {
      lines.push(`- \`${e.id}\` — ${e.label || ''}: ${e.when || ''}`);
    }
    lines.push('');
  }

  if (s.ui) {
    lines.push('## UI layout');
    lines.push('```json');
    lines.push(JSON.stringify(s.ui, null, 2));
    lines.push('```');
    lines.push('');
  }

  if (s.logic) {
    lines.push('## Logic');
    if (s.logic.summary) lines.push(s.logic.summary);
    if (Array.isArray(s.logic.pseudocode)) {
      lines.push('');
      for (const p of s.logic.pseudocode) lines.push(`1. ${p}`);
    }
    if (Array.isArray(s.logic.errorHandling)) {
      lines.push('');
      lines.push('### Error handling');
      for (const h of s.logic.errorHandling) {
        lines.push(`- **${h.case}** → ${h.action}`);
      }
    }
    lines.push('');
  }

  if (Array.isArray(s.integrations) && s.integrations.length) {
    lines.push('## External integrations');
    for (const int of s.integrations) {
      lines.push(`### ${int.name}`);
      lines.push(`${int.purpose || ''}`);
      lines.push(`- \`${int.method || 'POST'}\` \`${int.endpoint || ''}\``);
      lines.push(`- Auth: ${int.auth || 'none'}`);
      lines.push(`- Timeout: ${int.timeoutMs || 15000}ms`);
      lines.push('');
    }
  }

  if (s.testing?.scenarios?.length) {
    lines.push(`## Test scenarios (${s.testing.scenarios.length})`);
    for (const sc of s.testing.scenarios.slice(0, 20)) {
      lines.push(`- **${sc.name}** — expect: \`${JSON.stringify(sc.expect || {}).slice(0, 120)}\``);
    }
    lines.push('');
  }

  if (Array.isArray(s.useCases) && s.useCases.length) {
    lines.push('## Use cases');
    for (const uc of s.useCases) {
      lines.push(`### ${uc.title}`);
      if (uc.description) lines.push(uc.description);
      if (uc.scenario?.exampleInputs) {
        lines.push('');
        lines.push('```json');
        lines.push(JSON.stringify(uc.scenario.exampleInputs, null, 2));
        lines.push('```');
      }
      lines.push('');
    }
  }

  if (s.platformRequirements) {
    lines.push('## Platform requirements');
    for (const [cat, rules] of Object.entries(s.platformRequirements)) {
      lines.push(`### ${cat}`);
      for (const rule of rules || []) lines.push(`- ${rule}`);
      lines.push('');
    }
  }

  if (plan.sectionErrors) {
    lines.push('## Generation errors (partial plan)');
    for (const [sec, err] of Object.entries(plan.sectionErrors)) {
      lines.push(`- **${sec}**: ${err}`);
    }
  }

  return lines.join('\n');
}

module.exports = {
  generateDetailedPlan,
  renderPlanAsMarkdown,
  generatePlatformRequirements,
  PLAN_SCHEMA_VERSION,
  GENERATOR_ID,
  // Exposed for tests — prompt builders can be called without the LLM
  _identityPrompt: identityPrompt,
  _inputsPrompt: inputsPrompt,
  _outputsPrompt: outputsPrompt,
  _exitsPrompt: exitsPrompt,
  _uiPrompt: uiPrompt,
  _eventsPrompt: eventsPrompt,
  _integrationsPrompt: integrationsPrompt,
  _useCasesPrompt: useCasesPrompt,
  _logicPrompt: logicPrompt,
  _callSectionLlm: callSectionLlm,
  _truncateForPrompt: truncateForPrompt,
};
