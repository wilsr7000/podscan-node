// ---------------------------------------------------------------------------
// testPlaybookGenerator.js — produces a Testing Playbook (markdown) for any
// deployed Edison flow. The generated playbook is consumed by the existing
// pipeline (in Phase 4's alt harness-splice mode) to spawn a Test Harness
// flow targeting the original flow.
//
// Inputs:
//   sourcePlaybook  — the original playbook markdown that built the target
//                      flow. Tells us what the thing was MEANT to do: intent,
//                      pre-mortem failure modes, coherent actions, etc.
//   openApi         — the OpenAPI 3.0 doc from flowOpenApiExtractor. Tells us
//                      what the thing actually accepts and returns: required
//                      fields, exits, behavior cues.
//   target          — { flowId, flowUrl, label, name } — identity block for
//                      the target. Embedded in the output playbook metadata
//                      so Phase 4 can detect and route.
//   opts            — {
//                      apiKey?,          // if present and llmMode != 'off', use LLM
//                      model?,           // defaults to Sonnet for scenario generation
//                      llmMode?,         // 'auto' (default, use if apiKey) | 'off'
//                      maxScenarios?,    // default 12
//                      log?,
//                     }
//
// Output: markdown string suitable to write to disk and feed to runPipeline.
//
// Shape of the generated playbook:
//   <!-- test-harness-meta ... -->
//     Detectable frontmatter the pipeline uses to route into harness-splice
//     mode (Phase 4) instead of generating fresh step code.
//
//   # <target-label> Test Harness
//
//   ## Document
//     Brief description explaining what this harness tests and why.
//
//   ## Plan
//     A minimal, identity-only plan (name, label, kind=logic, references
//     the hand-built Test Harness template).
//
//   ## Test Scenarios
//     ```json
//     [ { name, input, expect } ... ]
//     ```
//     The scenarios the harness will run against the target's endpoint.
//     Coverage:
//       - One scenario per required-field-missing case
//       - One happy-path scenario (all fields populated with safe defaults)
//       - One scenario per documented non-error exit
//       - Behavioral-assertion scenarios when the OpenAPI has behavior cues
//         (rewrite/transform/replace/diff/summar) — uses diffNonEmpty and
//         rewrittenDiffers assertions from the harness template
//       - Failure-mode scenarios derived from the source playbook's
//         Pre-Mortem section (LLM-extracted when key present; skipped
//         otherwise)
//
// Deterministic mode (no API key, or opts.llmMode === 'off'):
//   Generates a solid baseline using only the OpenAPI doc — structural
//   scenarios + default-path scenarios + behavior-cue-driven assertions.
//   Misses nuanced playbook-specific scenarios but always produces a
//   usable testing playbook. Safe to run in any environment.
//
// LLM mode (apiKey present):
//   Augments the deterministic baseline with scenarios the LLM proposes
//   after reading both the source playbook and the OpenAPI doc. Focus is
//   on BEHAVIORAL assertions — "the step was supposed to do X, this
//   scenario verifies X happened" — which structure alone can't catch.
// ---------------------------------------------------------------------------

'use strict';

// Canonical harness template identity. Phase 4 will look this up by label
// to find the deployed template's id when splicing.
const HARNESS_TEMPLATE_LABEL = 'Test Harness (Flow Tester)';
const HARNESS_TEMPLATE_NAME = 'Test Harness';

// ---------------------------------------------------------------------------
// generateTestPlaybook — main entry. Always async (LLM path may or may not
// fire). Never throws on LLM failure: falls back to deterministic output.
// ---------------------------------------------------------------------------
async function generateTestPlaybook({
  sourcePlaybook = '',
  openApi = {},
  target = {},
  opts = {},
} = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const llmMode = opts.llmMode || 'auto';
  const maxScenarios = Number(opts.maxScenarios) || 12;

  // Always start from the deterministic baseline — it's our floor.
  const deterministic = buildDeterministicScenarios(openApi, { maxScenarios });
  log(`[test-playbook-gen] deterministic baseline: ${deterministic.length} scenario(s)`);

  let llmScenarios = [];
  if (llmMode !== 'off') {
    try {
      llmScenarios = await generateLLMScenarios({
        sourcePlaybook, openApi, target, deterministic,
        apiKey: opts.apiKey,
        model: opts.model,
        maxScenarios,
        log,
      });
      log(`[test-playbook-gen] LLM augmentation: ${llmScenarios.length} scenario(s)`);
    } catch (err) {
      log(`[test-playbook-gen] LLM augmentation failed (continuing with deterministic): ${err.message}`);
    }
  }

  // Merge: deterministic first (high confidence), LLM appended (behavioral
  // richness). Dedup by name.
  const seen = new Set(deterministic.map((s) => s.name));
  const merged = [...deterministic];
  for (const s of llmScenarios) {
    if (!seen.has(s.name) && merged.length < maxScenarios) {
      merged.push(s);
      seen.add(s.name);
    }
  }

  const markdown = buildPlaybookMarkdown({
    sourcePlaybook, openApi, target, scenarios: merged,
  });

  return {
    markdown,
    scenarios: merged,
    deterministicCount: deterministic.length,
    llmCount: merged.length - deterministic.length,
  };
}

// ---------------------------------------------------------------------------
// buildDeterministicScenarios — no-LLM baseline. Uses the OpenAPI doc's
// x-edison.harnessScenarioHints to produce:
//   - one missing-required scenario per required field
//   - one happy-path scenario
//   - one per behavior cue (diffNonEmpty / rewrittenDiffers) when applicable
// ---------------------------------------------------------------------------
function buildDeterministicScenarios(openApi, { maxScenarios = 12 } = {}) {
  const scenarios = [];
  const hints = openApi['x-edison']?.harnessScenarioHints || {};
  const requiredFields = hints.requiredFields || [];
  const enumFields = hints.enumFields || [];
  const behaviorCues = new Set(hints.behaviorCues || []);
  const defaultedFields = hints.defaultedFields || [];

  // Build a happy-path input once; reuse as base for missing-required.
  const happyInput = buildHappyInput(openApi);

  // Missing-required scenarios (one per required field, capped)
  for (const f of requiredFields.slice(0, 5)) {
    const input = { ...happyInput };
    delete input[f];
    scenarios.push({
      name: `missing required "${f}" → missing-input code`,
      input,
      expect: {
        codeOneOf: ['MISSING_INPUT', 'MISSING_FIELD', 'MISSING_REQUIRED', 'INVALID_INPUT', 'BAD_REQUEST', 'VALIDATION_ERROR'],
      },
    });
    if (scenarios.length >= maxScenarios) return scenarios;
  }

  // Happy path (all required populated)
  if (Object.keys(happyInput).length > 0) {
    scenarios.push({
      name: 'happy path (all required populated) → success or env-level failure',
      input: happyInput,
      expect: {
        codeOneOfOrSuccess: [
          'AUTH_RETRIEVAL_FAILED', 'AUTH_ERROR', 'MISSING_AUTH', 'UNAUTHORIZED',
          'SERVICE_UNAVAILABLE', 'EXTERNAL_ERROR', 'UPSTREAM_ERROR', 'API_ERROR',
          'TIMEOUT', 'NETWORK_ERROR', 'RATE_LIMITED',
        ],
      },
    });
  }

  // Behavioral assertions for transform-style steps
  if (behaviorCues.has('rewrite') || behaviorCues.has('transform') || behaviorCues.has('replace')) {
    // If the happy input has a known "source text" field, assert the
    // rewrite actually changed something.
    const srcField = pickSourceTextField(openApi);
    if (srcField && scenarios.length < maxScenarios) {
      const input = { ...happyInput, [srcField]: 'The quick brown fox jumps over the lazy dog.' };
      scenarios.push({
        name: `transform must actually transform — rewrittenText differs from input`,
        input,
        expect: { rewrittenDiffers: true },
      });
    }
    if (behaviorCues.has('diff') && scenarios.length < maxScenarios) {
      scenarios.push({
        name: `transform must report non-empty diff[] when it transforms`,
        input: { ...happyInput, [srcField || 'text']: 'The quick brown fox jumps over the lazy dog.' },
        expect: { diffNonEmpty: true },
      });
    }
  }

  // Enum alt-value scenarios — pick a different enum value per enum field
  for (const ef of enumFields) {
    if (scenarios.length >= maxScenarios) break;
    if (!Array.isArray(ef.values) || ef.values.length < 2) continue;
    // Second value — something non-default
    const altValue = ef.values[1];
    const input = { ...happyInput, [ef.name]: altValue };
    scenarios.push({
      name: `enum "${ef.name}" alternate value "${altValue}" → accepted`,
      input,
      expect: {
        codeOneOfOrSuccess: [
          'AUTH_RETRIEVAL_FAILED', 'AUTH_ERROR', 'MISSING_AUTH',
          'EXTERNAL_ERROR', 'TIMEOUT', 'NETWORK_ERROR',
        ],
      },
    });
  }

  return scenarios;
}

// ---------------------------------------------------------------------------
// buildHappyInput — best-effort populated request body for happy-path and
// missing-required scenarios. Honors declared defaults + enum options +
// variable-name conventions from lib/stepScenarios::_exampleValueFor.
// ---------------------------------------------------------------------------
function buildHappyInput(openApi) {
  const input = {};
  const bodyProps = openApi.paths?.[firstPath(openApi)]?.post?.requestBody?.content?.['application/json']?.schema?.properties || {};
  for (const [name, prop] of Object.entries(bodyProps)) {
    input[name] = pickValue(prop, name);
  }
  return input;
}

function firstPath(openApi) {
  return Object.keys(openApi.paths || {})[0] || '';
}

function pickValue(prop, varName) {
  if (prop.example !== undefined) return prop.example;
  if (prop.default !== undefined) return prop.default;
  if (Array.isArray(prop.enum) && prop.enum.length > 0) return prop.enum[0];
  const t = prop.type;
  if (t === 'number' || t === 'integer') return 1;
  if (t === 'boolean') return false;
  if (t === 'array') return [];
  if (t === 'object') return {};
  // Variable-name conventions — keep in sync with lib/stepScenarios
  const v = String(varName || '').toLowerCase();
  if (v === 'email' || v.endsWith('email')) return 'test@example.com';
  if (v === 'url' || v.endsWith('url') || v.endsWith('endpoint')) return 'https://example.com';
  if (v === 'location' || v === 'city' || v === 'address') return 'San Francisco, CA';
  if (v === 'uuid' || v === 'id' || v.endsWith('id')) return '00000000-0000-0000-0000-000000000000';
  if (v === 'sourcetext' || v === 'inputtext' || v === 'text' || v === 'content') return 'The quick brown fox jumps over the lazy dog.';
  return 'test';
}

function pickSourceTextField(openApi) {
  const bodyProps = openApi.paths?.[firstPath(openApi)]?.post?.requestBody?.content?.['application/json']?.schema?.properties || {};
  const candidates = ['sourceText', 'inputText', 'text', 'content', 'body'];
  for (const c of candidates) if (c in bodyProps) return c;
  return null;
}

// ---------------------------------------------------------------------------
// generateLLMScenarios — asks Claude to propose BEHAVIORAL scenarios given
// the source playbook + OpenAPI. Focus is explicitly on "did the step do
// what the playbook said it would do?", not structural edge cases (which
// the deterministic path already covers).
// ---------------------------------------------------------------------------
async function generateLLMScenarios({
  sourcePlaybook, openApi, target, deterministic, apiKey, model, maxScenarios, log,
}) {
  let callAnthropicDirect, hasApiKey, getApiKey;
  try {
    ({ callAnthropicDirect, hasApiKey, getApiKey } = require('./llmClient'));
  } catch (err) {
    log(`[test-playbook-gen] llmClient unavailable: ${err.message}`);
    return [];
  }
  const key = apiKey || getApiKey();
  if (!key || !hasApiKey(key)) {
    log('[test-playbook-gen] no API key — skipping LLM augmentation');
    return [];
  }

  const budget = Math.max(0, maxScenarios - deterministic.length);
  if (budget === 0) return [];

  const hints = openApi['x-edison']?.harnessScenarioHints || {};
  const exitIds = hints.exitIds || [];
  const behaviorCues = hints.behaviorCues || [];

  const compactBody = openApi.paths?.[firstPath(openApi)]?.post?.requestBody?.content?.['application/json']?.schema || {};
  const playbookExcerpt = extractRelevantPlaybookSections(sourcePlaybook);

  const systemPrompt = [
    'You are a QA engineer designing BEHAVIORAL test scenarios for a deployed Edison flow.',
    'Your output must be a JSON array of scenarios. No prose. No markdown fences.',
    'Behavioral scenarios verify the step does what the PLAYBOOK says it should do, not just that it returns a response of the right shape.',
  ].join(' ');

  const userPrompt = [
    `# Target: ${target.label || target.name || 'unnamed'}`,
    `Flow ID: ${target.flowId || '(unknown)'}`,
    `URL: ${target.flowUrl || '(unknown)'}`,
    '',
    '## Source playbook excerpt (what the step was SUPPOSED to do)',
    playbookExcerpt || '(no source playbook provided)',
    '',
    '## OpenAPI — request body schema',
    '```json',
    JSON.stringify(compactBody, null, 2).slice(0, 3000),
    '```',
    '',
    `## Exits: ${exitIds.join(', ')}`,
    `## Behavior cues: ${behaviorCues.join(', ') || '(none detected)'}`,
    '',
    '## Deterministic scenarios already covered (do NOT duplicate)',
    deterministic.map((s) => `- ${s.name}`).join('\n'),
    '',
    `## Task`,
    `Generate up to ${budget} ADDITIONAL scenarios that test BEHAVIORAL correctness — "did the step actually do its job on realistic inputs?". Prefer:`,
    `  • Scenarios that use realistic input from the playbook's examples/use-cases`,
    `  • Scenarios targeting failure modes listed in the playbook's Pre-Mortem`,
    `  • Scenarios that verify the OUTPUT transformed in the way the playbook described`,
    '',
    `Each scenario MUST be JSON:`,
    `  { "name": "short imperative sentence",`,
    `    "input": { <keyed by request body field names> },`,
    `    "expect": <one of: { code: "X" }, { codeOneOf: [...] }, { codeOneOfOrSuccess: [...] }, { messageIncludes: "substring" }, { shape: { field: "type" } }, { includes: ["substring1","substring2"] }, { diffNonEmpty: true }, { rewrittenDiffers: true } — can also combine multiple> }`,
    '',
    `Output ONLY the JSON array. No prose, no fences, no explanations.`,
  ].join('\n');

  let resp;
  try {
    resp = await callAnthropicDirect(key, systemPrompt, userPrompt, {
      model: model || undefined,
      maxTokens: 4096,
      cacheSystem: true,
      cacheTtl: '1h',
    });
  } catch (err) {
    log(`[test-playbook-gen] LLM call threw: ${err.message}`);
    return [];
  }
  if (resp.error || !resp.raw) {
    log(`[test-playbook-gen] LLM returned error: ${String(resp.error || 'empty').slice(0, 120)}`);
    return [];
  }

  const parsed = parseScenarioJson(resp.raw);
  if (!Array.isArray(parsed)) {
    log('[test-playbook-gen] LLM response not a JSON array after parsing');
    return [];
  }

  // Validate + tag
  const out = [];
  for (const s of parsed.slice(0, budget)) {
    if (!s || typeof s !== 'object' || typeof s.name !== 'string' || !s.name) continue;
    if (s.input && typeof s.input !== 'object') continue;
    if (s.expect && typeof s.expect !== 'object') continue;
    out.push({
      name: s.name,
      input: s.input || {},
      expect: s.expect || {},
      _source: 'llm-behavioral',
    });
  }
  return out;
}

function parseScenarioJson(raw) {
  const s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*\n([\s\S]*?)```/);
  const candidate = fence ? fence[1].trim() : s;
  try { return JSON.parse(candidate); } catch {}
  const first = candidate.indexOf('[');
  const last = candidate.lastIndexOf(']');
  if (first !== -1 && last > first) {
    try { return JSON.parse(candidate.slice(first, last + 1)); } catch {}
  }
  return null;
}

// ---------------------------------------------------------------------------
// extractRelevantPlaybookSections — trim the source playbook to the parts
// most useful for scenario generation: "How to Win", "Coherent Actions",
// "Pre-Mortem". Keeps the LLM prompt tight and focuses on the intent signal.
// ---------------------------------------------------------------------------
function extractRelevantPlaybookSections(md) {
  if (!md || typeof md !== 'string') return '';
  const sections = ['How to Win', 'Coherent Actions', 'Capabilities', 'Pre-Mortem', 'Winning Aspiration'];
  const out = [];
  for (const h of sections) {
    const re = new RegExp('(?:^|\\n)(?:##?#?)\\s*\\*{0,2}' + h.replace(/\s+/g, '\\s+') + '\\*{0,2}\\s*\\n([\\s\\S]*?)(?=\\n(?:##?#?)\\s|$)', 'i');
    const m = md.match(re);
    if (m) {
      out.push(`### ${h}`);
      out.push(m[1].trim().slice(0, 1200));
      out.push('');
    }
  }
  const trimmed = out.join('\n').slice(0, 5000);
  return trimmed || md.slice(0, 3000);  // fallback: truncated raw
}

// ---------------------------------------------------------------------------
// buildPlaybookMarkdown — assemble the output playbook. Includes a machine-
// readable metadata block so Phase 4's pipeline-mode detector can route
// into harness-splice mode instead of generating fresh code.
// ---------------------------------------------------------------------------
function buildPlaybookMarkdown({ sourcePlaybook, openApi, target, scenarios }) {
  const label = `${target.label || target.name || 'Flow'} Test Harness`;
  const name = `test_harness_${(target.name || 'flow').toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

  const meta = [
    '<!-- test-harness-meta',
    `testHarnessFor: ${target.flowId || '(unknown)'}`,
    `targetFlowUrl: ${target.flowUrl || '(unknown)'}`,
    `targetLabel: ${target.label || '(unknown)'}`,
    `targetName: ${target.name || '(unknown)'}`,
    `harnessTemplateLabel: ${HARNESS_TEMPLATE_LABEL}`,
    `harnessTemplateName: ${HARNESS_TEMPLATE_NAME}`,
    `scenariosCount: ${scenarios.length}`,
    `generatedAt: ${new Date().toISOString()}`,
    '-->',
    '',
  ].join('\n');

  const description = [
    `Automated test harness for **${target.label || 'the target flow'}**`,
    `(\`${target.flowId || 'unknown'}\`).`,
    'This harness runs a curated scenario suite against the target flow\'s endpoint',
    'and reports per-scenario pass/fail with structured diagnostics.',
    '',
    'Spliced from the trusted **Test Harness (Flow Tester)** template —',
    'no step code is generated; only the scenario data is parameterized.',
  ].join(' ');

  return [
    meta,
    `# ${label}`,
    '',
    '## Document',
    '',
    description,
    '',
    '## Plan',
    '',
    `# Ship a test harness for the ${target.label || 'target'} flow. Spliced into the canonical Test Harness library step — scenarios only, no step code generation.`,
    '',
    '## Identity',
    '',
    `- **Name**: ${name}`,
    `- **Label**: ${label}`,
    `- **Kind**: logic`,
    `- **Harness template**: ${HARNESS_TEMPLATE_LABEL}`,
    `- **Target flow**: ${target.flowUrl || '(url unknown)'}`,
    `- **Target flow id**: ${target.flowId || '(unknown)'}`,
    '',
    '## Test Scenarios',
    '',
    '```json',
    JSON.stringify(scenarios, null, 2),
    '```',
    '',
  ].join('\n');
}

module.exports = {
  generateTestPlaybook,
  buildDeterministicScenarios,
  buildPlaybookMarkdown,
  extractRelevantPlaybookSections,
  parseScenarioJson,
  pickValue,
  HARNESS_TEMPLATE_LABEL,
  HARNESS_TEMPLATE_NAME,
};
