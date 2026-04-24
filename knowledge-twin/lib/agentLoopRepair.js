// ---------------------------------------------------------------------------
// agentLoopRepair.js — use the agent loop to SURGICALLY repair code that
// has validator blockers.
//
// The pipeline's stageGenerateCode.verify() today falls back to a full-file
// retry (remote /generate-step-code with priorDiagnosis) when deterministic
// patchers can't fix everything. That retry regenerates the WHOLE file —
// the "LLM creates new bugs" loop.
//
// This module is a drop-in alternative. Instead of regenerating, Claude
// is given the broken code + the specific validator diagnostics and asked
// to produce narrow str_replace edits via text_editor_20250728. The result
// is applied to the in-memory file dict; we re-run the validator; if
// blockers remain we feed them back as a new user turn; loop until clean
// or budget hits.
//
// Input contract (tries to match autoRepairKnownBlockers's shape so the
// caller can swap easily):
//   tryAgentLoopRepair({
//     code,                 // current broken logic.js
//     spec,                 // fullSpec (inputs, exits, label)
//     blockers,             // [{code, message, fix, severity}]
//     synthesizeTemplate,   // (code, spec) → tpl for validateStep
//     CODE_LEVEL_BLOCKERS,  // Set of validator ids the pipeline treats as blockers
//     opts: {
//       apiKey, model, maxOuter = 3, maxInner = 10, log = () => {},
//       budget?               // patchBudget instance (optional)
//     }
//   })
//
// Returns:
//   {
//     ok: boolean,
//     code: string,          // repaired code (or original on failure)
//     remainingBlockers: [],
//     applied: [{oldText, newText, rationale}],   // flat edit log
//     outerIterations, innerIterationsByOuter,
//     totalMs, totalUsage,
//     error?: string,
//   }
//
// The function is env-safe: if ANTHROPIC_API_KEY is missing it returns
// { ok: false, error: 'no-api-key' } without throwing.
// ---------------------------------------------------------------------------

'use strict';

const { runAgentLoop } = require('./agentLoop');
const platformRules = require('./platformRules');
const { validateStep } = require('./stepValidator');
const { enrichDiagnostics } = require('./diagLocation');

async function tryAgentLoopRepair({ code, spec, blockers, synthesizeTemplate, CODE_LEVEL_BLOCKERS, opts = {} } = {}) {
  const apiKey = opts.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { ok: false, code, error: 'no-api-key', remainingBlockers: blockers, applied: [], totalMs: 0 };
  }
  if (typeof code !== 'string' || !code) {
    return { ok: false, code: code || '', error: 'no-code', remainingBlockers: [], applied: [], totalMs: 0 };
  }
  if (typeof synthesizeTemplate !== 'function') {
    return { ok: false, code, error: 'synthesizeTemplate-not-provided', remainingBlockers: blockers, applied: [], totalMs: 0 };
  }
  if (!(CODE_LEVEL_BLOCKERS instanceof Set)) {
    return { ok: false, code, error: 'CODE_LEVEL_BLOCKERS-set-required', remainingBlockers: blockers, applied: [], totalMs: 0 };
  }

  const systemPrompt = platformRules.getSystemPromptDigest();
  const initialFiles = { 'logic.js': code };

  const diagnosticList = (blockers || []).map((b) => {
    const loc = b.location ? ` (line ${b.location.startLine}${b.location.snippet ? ': `' + b.location.snippet.slice(0, 80) + '`' : ''})` : '';
    const fix = b.fix ? `\n  Fix: ${b.fix}` : '';
    return `- [${b.code}] ${b.message}${loc}${fix}`;
  }).join('\n');

  const userPrompt = [
    'The logic.js file below has validator errors. Fix them with `str_replace` edits to the existing file — do NOT recreate it.',
    '',
    '## Current validator errors (all must be resolved)',
    diagnosticList || '(no specific diagnostics supplied)',
    '',
    '## Instructions',
    '1. Call `view` on `logic.js` if you need to see the current state.',
    '2. Call `str_replace` (one per edit) to fix each error. Include enough context in `old_str` to be unique.',
    '3. Each `str_replace` must match exactly once — if you get "not found" or "matches N times", retry with different context.',
    '4. When you believe all errors are fixed, stop. I will re-run the validator. If blockers remain, I will tell you which.',
    '5. Do NOT `create` a new logic.js — that fails (already exists).',
    '6. Preserve everything unrelated to the specific defects.',
    '',
    '## Step spec (for reference)',
    '```json',
    JSON.stringify({
      label: spec.label,
      name: spec.name,
      inputs: (spec.inputs || []).map((i) => ({
        variable: i.variable,
        type: i.type,
        required: i.required,
        default: i.default,
      })),
      exits: spec.exits,
    }, null, 2),
    '```',
  ].join('\n');

  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const terminator = async (files) => {
    if (!files || !files['logic.js']) {
      return { done: false, message: 'logic.js is missing — use view + str_replace against the original file. Do not create a new one.' };
    }
    try {
      const synth = synthesizeTemplate(files['logic.js'], spec);
      const v = validateStep(synth);
      v.diagnostics = enrichDiagnostics(v.diagnostics || [], files['logic.js']);
      const remaining = (v.diagnostics || []).filter((d) => d.severity === 'error' && CODE_LEVEL_BLOCKERS.has(d.code));
      if (remaining.length === 0) {
        return { done: true, observation: 'All code-level blockers cleared' };
      }
      const msg = [
        `${remaining.length} validator blocker(s) still present:`,
        ...remaining.slice(0, 10).map((d) => {
          const loc = d.location ? ` (line ${d.location.startLine})` : '';
          const fix = d.fix ? `\n  Fix: ${d.fix}` : '';
          return `- [${d.code}] ${d.message}${loc}${fix}`;
        }),
        '',
        'Issue another str_replace to fix. Stop after the final edit — I will re-check.',
      ].join('\n');
      return { done: false, message: msg };
    } catch (err) {
      return { done: false, message: `Validator threw: ${err.message}. Your last edit may have broken the file structure.` };
    }
  };

  const res = await runAgentLoop({
    systemPrompt,
    initialUser: userPrompt,
    initialFiles,
    terminator,
    opts: {
      apiKey,
      model: opts.model || 'claude-sonnet-4-20250514',
      maxOuter: opts.maxOuter || 3,
      maxInner: opts.maxInner || 10,
      cacheSystem: true,
      cacheTtl: '1h',
      log: (m) => log(`[agent-repair] ${m}`),
    },
  });

  // Compute applied edits list from the conversation (best-effort).
  const applied = extractAppliedEdits(res.messages);
  const finalCode = res.files?.['logic.js'] || code;

  // Final validator pass so callers see remainingBlockers without re-running.
  let remaining = [];
  try {
    const synth = synthesizeTemplate(finalCode, spec);
    const v = validateStep(synth);
    remaining = (v.diagnostics || [])
      .filter((d) => d.severity === 'error' && CODE_LEVEL_BLOCKERS.has(d.code))
      .map((d) => ({ code: d.code, severity: d.severity, message: d.message, fix: d.fix, location: d.location }));
  } catch { /* already reported by terminator */ }

  return {
    ok: res.ok && remaining.length === 0,
    code: finalCode,
    remainingBlockers: remaining,
    applied,
    outerIterations: res.outerIterations,
    innerIterationsByOuter: res.innerIterationsByOuter,
    totalMs: res.totalMs,
    totalUsage: res.totalUsage,
    error: res.error || null,
  };
}

// Walk the conversation messages, extracting every str_replace / create /
// insert tool_use as an applied-edit record for the pipeline's provenance log.
function extractAppliedEdits(messages) {
  const out = [];
  if (!Array.isArray(messages)) return out;
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const c of m.content) {
      if (c.type !== 'tool_use' || c.name !== 'str_replace_based_edit_tool') continue;
      const inp = c.input || {};
      if (inp.command === 'str_replace') {
        out.push({ command: 'str_replace', path: inp.path, oldText: inp.old_str, newText: inp.new_str });
      } else if (inp.command === 'create') {
        out.push({ command: 'create', path: inp.path, newText: inp.file_text });
      } else if (inp.command === 'insert') {
        out.push({ command: 'insert', path: inp.path, insertLine: inp.insert_line, newText: inp.new_str });
      }
    }
  }
  return out;
}

module.exports = { tryAgentLoopRepair };
