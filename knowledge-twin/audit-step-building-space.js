#!/usr/bin/env node
// audit-step-building-space.js — pull every flow in the Step Building Space,
// extract every custom step template, and run the full audit loop for each:
//
//   1. Validate BEFORE patching → blocker set + error count
//   2. Run findPatches → detected defects + proposed edits
//   3. Apply edits → new code
//   4. Validate AFTER patching → blocker set + error count
//   5. Tabulate: flow | step | defect codes | edits applied | before errors
//      | after errors | delta | syntax-safe | new-bugs?
//
// No writes to the live flows. Read-only audit — the patched code is
// compared against the original in memory only. Output: a Markdown table
// + per-step detail appendix + summary stats.
//
// Usage:
//   node audit-step-building-space.js > audit-report.md
//   node audit-step-building-space.js --limit 10    # audit first 10 flows
//   node audit-step-building-space.js --apply       # DANGEROUS: splice fixes
//                                                    into each affected flow

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const SPACE_BOT_ID = '04d0d009-0468-4a63-be90-cde64bd797df';  // Step Building Space

// ---- CLI args ----
const args = process.argv.slice(2);
const LIMIT = (() => {
  const i = args.indexOf('--limit');
  return i >= 0 ? parseInt(args[i + 1], 10) : Infinity;
})();
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');

// ---- Helpers ----
function parses(code) {
  if (!code) return false;
  const tmp = path.join(os.tmpdir(), `parse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(tmp, code, 'utf8');
  try {
    return spawnSync(process.execPath, ['--check', tmp], { encoding: 'utf8' }).status === 0;
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function synthesize(tpl) {
  // Use the existing template structure when present. Validator expects:
  // {id, name, label, version, template, form, formBuilder, data}
  return {
    id: tpl.id || 'audit',
    name: tpl.name || tpl.label || 'audit',
    label: tpl.label || 'audit',
    version: tpl.version || '1.0.0',
    description: tpl.description || '',
    template: tpl.template || '',
    form: tpl.form || {},
    formBuilder: tpl.formBuilder || { stepInputs: [] },
    data: tpl.data || { exits: [], processError: false, dataOut: { name: 'out', type: 'session', ttl: 86400000 } },
  };
}

function specFromTemplate(tpl) {
  // Best-effort: extract inputs with their defaults from formBuilder.
  const inputs = ((tpl.formBuilder && tpl.formBuilder.stepInputs) || []).map((si) => {
    const data = si.data || {};
    return {
      variable: data.variable || '',
      label: data.label || '',
      type: (Array.isArray(si.component) ? si.component[0] : si.component) || 'text',
      default: data.defaultValue || '',
    };
  }).filter((i) => i.variable);
  return {
    label: tpl.label,
    name: tpl.name || tpl.label,
    inputs,
    exits: (tpl.data?.exits || []).map((e) => ({ id: e.id, label: e.label })),
  };
}

// ---- Main ----
(async () => {
  const dh = require('./lib/deployHelper');
  const token = await dh.getToken();
  const { Flows } = require('@or-sdk/flows');
  const flows = new Flows({ token: () => token, discoveryUrl: 'https://discovery.edison.api.onereach.ai' });

  const { validateStep } = require('./lib/stepValidator');
  const { findPatches } = require('./lib/patcher');
  const { findTemplateShapePatches } = require('./lib/templateShapePatcher');
  const { applyEditsToString } = require('./lib/editPrimitive');
  const { enrichDiagnostics } = require('./lib/diagLocation');

  process.stderr.write(`Listing flows in Step Building Space (${SPACE_BOT_ID})...\n`);
  const list = await flows.listFlows({ query: { botId: SPACE_BOT_ID }, limit: 500 });
  const flowStubs = (list.items || []).slice(0, LIMIT);
  process.stderr.write(`Found ${flowStubs.length} flow(s)\n\n`);

  // ---- Accumulate rows ----
  const rows = [];     // one per step template
  const byFlowSummary = [];
  const overall = {
    flows: flowStubs.length,
    stepsAudited: 0,
    stepsWithDefects: 0,
    totalEditsProposed: 0,
    totalEditsApplied: 0,
    stepsWithValidatorImprovement: 0,
    stepsWithNewBugs: 0,
    stepsSyntaxOkAfter: 0,
  };

  for (let fi = 0; fi < flowStubs.length; fi++) {
    const stub = flowStubs[fi];
    let flow;
    try {
      flow = stub.data?.stepTemplates ? stub : await flows.getFlow(stub.id);
    } catch (e) {
      process.stderr.write(`  [${fi + 1}/${flowStubs.length}] ${stub.id.slice(0, 8)} "${(stub.label || stub.data?.label || '').slice(0, 40)}": fetch failed — ${e.message}\n`);
      continue;
    }
    const label = flow.data?.label || stub.label || '(no label)';
    const tpls = flow.data?.stepTemplates || [];
    process.stderr.write(`  [${fi + 1}/${flowStubs.length}] ${flow.id.slice(0, 8)} "${label.slice(0, 50).padEnd(50)}" — ${tpls.length} template(s)\n`);

    const flowSummary = {
      flowId: flow.id, flowLabel: label, templates: tpls.length,
      defectsFound: 0, editsApplied: 0, improvements: 0, newBugs: 0,
    };

    for (const tpl of tpls) {
      // Skip library-like templates (no template code, or very tiny stubs).
      if (!tpl || !tpl.template || tpl.template.length < 200) continue;

      overall.stepsAudited++;

      const spec = specFromTemplate(tpl);
      const synth = synthesize(tpl);

      // Baseline validator
      const before = validateStep(synth);
      before.diagnostics = enrichDiagnostics(before.diagnostics || [], tpl.template);
      const beforeErrs = (before.diagnostics || []).filter((d) => d.severity === 'error');
      const beforeCodes = new Set(beforeErrs.map((d) => d.code));

      // CODE patcher (on tpl.template)
      const { patchable: codePatches } = findPatches(tpl.template, { spec });
      // TEMPLATE-SHAPE patcher (on synthetic step.json reconstruction)
      const synthStepJson = JSON.stringify({
        name: tpl.name, label: tpl.label, version: tpl.version,
        description: tpl.description, icon: tpl.icon, iconUrl: tpl.iconUrl, iconType: tpl.iconType,
        processError: tpl.data?.processError,
        processTimeout: tpl.data?.processTimeout,
        exits: tpl.data?.exits,
      }, null, 2);
      const { patchable: shapePatches } = findTemplateShapePatches(synthStepJson);

      const allPatchable = [...codePatches, ...shapePatches];
      const detectedIds = allPatchable.map((p) => p.id);
      if (detectedIds.length > 0) { overall.stepsWithDefects++; flowSummary.defectsFound++; }

      const codeEdits = codePatches.flatMap((p) => p.edits);
      const shapeEdits = shapePatches.flatMap((p) => p.edits);
      overall.totalEditsProposed += codeEdits.length + shapeEdits.length;

      let afterCode = tpl.template;
      let appliedCount = 0;
      let applyError = null;
      // Apply code edits to the code
      if (codeEdits.length > 0) {
        const r = applyEditsToString(tpl.template, codeEdits);
        if (r.ok) {
          afterCode = r.code;
          appliedCount += r.editsApplied || codeEdits.length;
          overall.totalEditsApplied += r.editsApplied || codeEdits.length;
          flowSummary.editsApplied += r.editsApplied || codeEdits.length;
        } else {
          applyError = r.error;
        }
      }
      // Apply step.json edits to the synth template object (which we then feed
      // to validateStep directly — no splice; audit is in-memory only).
      let afterStepJson = synthStepJson;
      if (shapeEdits.length > 0) {
        const r = applyEditsToString(synthStepJson, shapeEdits);
        if (r.ok) {
          afterStepJson = r.code;
          appliedCount += r.editsApplied || shapeEdits.length;
          overall.totalEditsApplied += r.editsApplied || shapeEdits.length;
          flowSummary.editsApplied += r.editsApplied || shapeEdits.length;
        }
      }

      const syntaxAfter = parses(afterCode);
      if (syntaxAfter) overall.stepsSyntaxOkAfter++;

      // After validator — apply both code changes AND step.json field flips.
      let stepJsonParsed;
      try { stepJsonParsed = JSON.parse(afterStepJson); } catch { stepJsonParsed = {}; }
      const afterTpl = {
        ...synth,
        template: afterCode,
        // Merge step.json field changes onto the synthesized template so the
        // validator sees both halves of the fix.
        iconUrl: stepJsonParsed.iconUrl || synth.iconUrl,
        iconType: stepJsonParsed.iconType || synth.iconType,
        description: stepJsonParsed.description || synth.description,
        data: {
          ...(synth.data || {}),
          processError: stepJsonParsed.processError !== undefined ? stepJsonParsed.processError : synth.data?.processError,
          processTimeout: stepJsonParsed.processTimeout !== undefined ? stepJsonParsed.processTimeout : synth.data?.processTimeout,
        },
      };
      const after = validateStep(afterTpl);
      const afterErrs = (after.diagnostics || []).filter((d) => d.severity === 'error');
      const afterCodes = new Set(afterErrs.map((d) => d.code));

      const newBugs = [...afterCodes].filter((c) => !beforeCodes.has(c));
      const fixed = [...beforeCodes].filter((c) => !afterCodes.has(c));

      if (newBugs.length > 0) { overall.stepsWithNewBugs++; flowSummary.newBugs++; }
      if (afterErrs.length < beforeErrs.length) { overall.stepsWithValidatorImprovement++; flowSummary.improvements++; }

      rows.push({
        flowId: flow.id,
        flowLabel: label,
        templateId: tpl.id,
        templateLabel: tpl.label || tpl.name || '(unnamed)',
        templateVersion: tpl.version || '',
        codeBytes: tpl.template.length,
        beforeErrs: beforeErrs.length,
        beforeCodes: [...beforeCodes].sort(),
        detectedIds,
        editsProposed: codeEdits.length + shapeEdits.length,
        editsApplied: appliedCount,
        applyError,
        afterErrs: afterErrs.length,
        afterCodes: [...afterCodes].sort(),
        fixed,
        newBugs,
        syntaxAfter,
      });
    }
    byFlowSummary.push(flowSummary);
  }

  // ---- Render Markdown report ----
  if (JSON_OUT) {
    console.log(JSON.stringify({ overall, byFlowSummary, rows }, null, 2));
    process.exit(0);
  }

  console.log('# Step Building Space — patcher audit\n');
  console.log(`Audited ${overall.flows} flow(s), ${overall.stepsAudited} custom step template(s).\n`);
  console.log('## Summary\n');
  console.log(`| Metric | Value |`);
  console.log(`|---|---|`);
  console.log(`| Flows audited | ${overall.flows} |`);
  console.log(`| Step templates audited | ${overall.stepsAudited} |`);
  console.log(`| Steps with defects detected | ${overall.stepsWithDefects} (${pct(overall.stepsWithDefects, overall.stepsAudited)}) |`);
  console.log(`| Total edits proposed | ${overall.totalEditsProposed} |`);
  console.log(`| Total edits applied | ${overall.totalEditsApplied} (${pct(overall.totalEditsApplied, overall.totalEditsProposed)}) |`);
  console.log(`| Steps with validator-error reduction | ${overall.stepsWithValidatorImprovement} (${pct(overall.stepsWithValidatorImprovement, overall.stepsAudited)}) |`);
  console.log(`| **Steps with NEW blockers introduced** | **${overall.stepsWithNewBugs}** (${pct(overall.stepsWithNewBugs, overall.stepsAudited)}) |`);
  console.log(`| Steps with post-patch syntax valid | ${overall.stepsSyntaxOkAfter} (${pct(overall.stepsSyntaxOkAfter, overall.stepsAudited)}) |`);
  console.log(``);

  console.log('## Before / after per step\n');
  console.log(`| Flow | Step | v | Code | Before | Detected | Applied | After | Δ | Fixed | New bugs |`);
  console.log(`|---|---|---|---:|---:|---|---:|---:|---:|---|---|`);
  for (const r of rows) {
    const delta = r.beforeErrs - r.afterErrs;
    const deltaStr = delta > 0 ? `−${delta}` : (delta < 0 ? `+${Math.abs(delta)}` : '0');
    const flowShort = (r.flowLabel || '').slice(0, 30);
    const stepShort = (r.templateLabel || '').slice(0, 28);
    const detected = r.detectedIds.map((i) => shortId(i)).join(',') || '—';
    const newBugs = r.newBugs.length > 0 ? `⚠ ${r.newBugs.join(',')}` : '';
    const fixed = r.fixed.length > 0 ? r.fixed.join(',') : '';
    console.log(`| ${flowShort} | ${stepShort} | ${r.templateVersion} | ${r.codeBytes} | ${r.beforeErrs} | ${detected} | ${r.editsApplied}/${r.editsProposed} | ${r.afterErrs} | ${deltaStr} | ${fixed} | ${newBugs} |`);
  }

  console.log('\n## Per-flow summary\n');
  console.log(`| Flow | Templates | Defects found | Edits applied | Validator-improved | New bugs |`);
  console.log(`|---|---:|---:|---:|---:|---:|`);
  for (const f of byFlowSummary) {
    console.log(`| ${f.flowLabel} (${f.flowId.slice(0, 8)}) | ${f.templates} | ${f.defectsFound} | ${f.editsApplied} | ${f.improvements} | ${f.newBugs} |`);
  }

  if (overall.stepsWithNewBugs > 0) {
    console.log('\n## ⚠ Steps where patching introduced NEW validator errors\n');
    for (const r of rows.filter((x) => x.newBugs.length > 0)) {
      console.log(`- **${r.flowLabel} → ${r.templateLabel}**: new codes = [${r.newBugs.join(', ')}]`);
    }
  }

  console.log('\n---');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log(`Detection: ${pct(overall.stepsWithDefects, overall.stepsAudited)} of steps have at least one deterministic defect the patcher recognizes.`);
  console.log(`Safety: ${pct(overall.stepsWithNewBugs === 0 ? overall.stepsAudited : overall.stepsAudited - overall.stepsWithNewBugs, overall.stepsAudited)} of audits introduced zero new validator errors.`);

  function pct(n, total) {
    if (!total) return 'n/a';
    return ((n / total) * 100).toFixed(1) + '%';
  }
  function shortId(id) {
    // Compact defect id names for the table
    const short = {
      UNCONDITIONAL_ERROR_EXIT: 'UNCOND_ERR',
      AUTH_NO_KV_RESOLUTION: 'AUTH_NO_KV',
      AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX: 'TOKEN_STRIP',
      HARDCODED_URL: 'URL',
      EQEQ: '==',
      TEMPLATE_HELP_DUPLICATES_DESCRIPTION: 'HELP_DUP',
    };
    return short[id] || id;
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
