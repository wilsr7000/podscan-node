// ---------------------------------------------------------------------------
// templateShapePatcher.js — deterministic patchers for TEMPLATE/FORM-SHAPE
// validator errors that require step.json edits, not logic.js edits.
//
// Companion to lib/patcher.js which handles code-level defects.
// These two modules cover the disjoint halves of the validator's error
// surface:
//
//   lib/patcher.js              ← edits logic.js (code-level defects)
//   lib/templateShapePatcher.js ← edits step.json (template/form shape)
//
// Each patcher returns Edit records in the SAME format as lib/patcher.js:
//   { oldText, newText, rationale }
// so callers can uniformly apply via the Edit primitive.
//
// Usage:
//   const { findTemplateShapePatches } = require('./templateShapePatcher');
//   const { patchable } = findTemplateShapePatches(stepJsonContents);
//   const edits = patchable.flatMap(p => p.edits);
//   await applyEditsOneFile('step.json', edits);
//
// ---------------------------------------------------------------------------

'use strict';

// ── Registry ────────────────────────────────────────────────────────────
const TEMPLATE_PATCHERS = [];

// Defect: TEMPLATE_NO_ICON — template missing iconUrl + iconType:'custom'.
// Fires on EVERY step in the audit corpus (136/136). Highest-value fix.
TEMPLATE_PATCHERS.push({
  id: 'TEMPLATE_NO_ICON',
  severity: 'warning',
  description: 'Template has no custom icon. Adds iconUrl pointing to a library icon + iconType:"custom".',
  match(jsonContents) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    const hasIconUrl = typeof spec.iconUrl === 'string' && spec.iconUrl.length > 0;
    const hasCustomType = spec.iconType === 'custom' || spec.iconType === '`custom`';
    if (hasIconUrl && hasCustomType) return null;

    // Default to a neutral library icon.
    const iconName = String(spec.icon || 'square').replace(/[^a-z0-9-]/g, '');
    const defaultIcon = `https://cdn.jsdelivr.net/gh/wilsr7000/podscan-node@main/knowledge-twin/icons/${iconName}.svg`;

    // Detect KEY PRESENCE (separate from value validity). A key can be present
    // with an empty value — in that case we REPLACE the value, not INSERT a
    // duplicate. JSON.parse on duplicate keys uses the LAST occurrence, so
    // INSERTING when an empty key exists later in the file silently loses
    // the new value.
    const iconUrlKeyMatch = jsonContents.match(/"iconUrl"\s*:\s*"[^"]*"/);
    const iconTypeKeyMatch = jsonContents.match(/"iconType"\s*:\s*"[^"]*"/);

    const edits = [];

    // iconUrl: replace or insert
    if (!hasIconUrl) {
      if (iconUrlKeyMatch) {
        // Replace existing (empty) value
        edits.push({
          oldText: iconUrlKeyMatch[0],
          newText: `"iconUrl": ${JSON.stringify(defaultIcon)}`,
          rationale: `Set iconUrl to default library icon for "${iconName}".`,
        });
      } else {
        // Insert after the `icon` key if present, else after object opener.
        const iconKeyM = jsonContents.match(/("icon"\s*:\s*"[^"]*")/);
        if (iconKeyM) {
          edits.push({
            oldText: iconKeyM[0],
            newText: `${iconKeyM[0]},\n  "iconUrl": ${JSON.stringify(defaultIcon)}`,
            rationale: `Added iconUrl for icon "${iconName}".`,
          });
        } else {
          const openM = jsonContents.match(/^(\{\s*)/);
          if (openM) {
            edits.push({
              oldText: openM[0],
              newText: `${openM[0]}  "iconUrl": ${JSON.stringify(defaultIcon)},\n`,
              rationale: 'Inserted iconUrl at object top.',
            });
          }
        }
      }
    }

    // iconType: replace or insert
    if (!hasCustomType) {
      if (iconTypeKeyMatch) {
        // Replace existing non-"custom" value
        edits.push({
          oldText: iconTypeKeyMatch[0],
          newText: '"iconType": "custom"',
          rationale: 'Set iconType to "custom".',
        });
      } else {
        // Insert after iconUrl if the key exists in the ORIGINAL file; else
        // after the `icon` key; else at the top. (The iconUrl edit above has
        // NOT been applied yet — edits are staged together — so we anchor on
        // the ORIGINAL jsonContents text.)
        if (iconUrlKeyMatch) {
          edits.push({
            oldText: iconUrlKeyMatch[0],
            newText: `${iconUrlKeyMatch[0]},\n  "iconType": "custom"`,
            rationale: 'Added iconType:"custom" alongside existing iconUrl.',
          });
          // Note: this creates a conflict with the iconUrl-replace edit above
          // if iconUrl was empty. We detect and collapse below.
        } else {
          const iconKeyM = jsonContents.match(/("icon"\s*:\s*"[^"]*")/);
          if (iconKeyM && !edits.some((e) => e.oldText === iconKeyM[0])) {
            edits.push({
              oldText: iconKeyM[0],
              newText: `${iconKeyM[0]},\n  "iconType": "custom"`,
              rationale: 'Added iconType:"custom" after the icon key.',
            });
          }
        }
      }
    }

    // Collapse any conflicting edits that target the same oldText.
    // (Happens when iconUrl key exists empty AND iconType needs inserting:
    // both edits point at iconUrlKeyMatch.) Merge them into one edit.
    const byOldText = new Map();
    for (const e of edits) {
      if (byOldText.has(e.oldText)) {
        // Merge: re-derive the final replacement
        const existing = byOldText.get(e.oldText);
        // Both aim to mutate iconUrl line; produce a single new line with both.
        byOldText.set(e.oldText, {
          oldText: e.oldText,
          newText: `"iconUrl": ${JSON.stringify(defaultIcon)},\n  "iconType": "custom"`,
          rationale: 'Set iconUrl + added iconType:"custom" in one edit.',
        });
      } else {
        byOldText.set(e.oldText, e);
      }
    }
    const finalEdits = [...byOldText.values()];
    if (finalEdits.length === 0) return null;
    return {
      edits: finalEdits,
      rationale: `Icon fields normalized (${finalEdits.length} edit(s)).`,
    };
  },
});

// Defect: ERROR_EXIT_UI_FLAG_MISMATCH — exits[] contains __error__ but
// data.processError is missing or false. UI-consistency only; runtime does
// not read processError (flow-sdk resolves __error__ purely by exits[]
// membership via getExitStepId — data.ts:94-104). Fix aligns step.json with
// step-builder-UI's convention so Studio doesn't strip the exit on save.
TEMPLATE_PATCHERS.push({
  id: 'ERROR_EXIT_UI_FLAG_MISMATCH',
  severity: 'warning',
  description: 'Template has __error__ exit in exits[] but processError is not true. Flip processError:true to match Studio convention (runtime already works via exits[] alone).',
  match(jsonContents) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    const exits = Array.isArray(spec.exits) ? spec.exits : [];
    const hasErrorExit = exits.some((e) => e && (e.id === '__error__' || e.id === 'error'));
    if (!hasErrorExit) return null;
    if (spec.processError === true) return null;  // already aligned
    // Two cases: property exists as false/absent → flip it; property absent → add it
    if (/"processError"\s*:\s*(false|null)/.test(jsonContents)) {
      return {
        edits: [{
          oldText: jsonContents.match(/"processError"\s*:\s*(false|null)/)[0],
          newText: '"processError": true',
          rationale: 'Enabled processError to match declared __error__ exit (Studio-alignment).',
        }],
        rationale: 'Flipped processError:false → true for Studio-UI consistency.',
      };
    }
    // Not present — insert near exits/dataOut
    if (/"exits"\s*:/.test(jsonContents)) {
      const m = jsonContents.match(/("exits"\s*:\s*\[[^\]]*\])/);
      if (m) {
        return {
          edits: [{
            oldText: m[0],
            newText: `${m[0]},\n  "processError": true`,
            rationale: 'Added processError:true to match Studio-UI convention (runtime already routes to __error__ via exits[] membership).',
          }],
          rationale: 'Inserted processError:true for Studio-alignment.',
        };
      }
    }
    return null;
  },
});

// Defect: TIMEOUT_EXIT_UI_FLAG_MISMATCH — same UI-consistency pattern for
// __timeout__ / processTimeout.
TEMPLATE_PATCHERS.push({
  id: 'TIMEOUT_EXIT_UI_FLAG_MISMATCH',
  severity: 'warning',
  description: 'Template has __timeout__ exit in exits[] but processTimeout is not true. Flip processTimeout:true to match Studio convention.',
  match(jsonContents) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    const exits = Array.isArray(spec.exits) ? spec.exits : [];
    const hasTimeoutExit = exits.some((e) => e && (e.id === '__timeout__' || e.id === 'timeout'));
    if (!hasTimeoutExit) return null;
    if (spec.processTimeout === true) return null;
    if (/"processTimeout"\s*:\s*(false|null)/.test(jsonContents)) {
      return {
        edits: [{
          oldText: jsonContents.match(/"processTimeout"\s*:\s*(false|null)/)[0],
          newText: '"processTimeout": true',
          rationale: 'Enabled processTimeout to match declared __timeout__ exit (Studio-alignment).',
        }],
        rationale: 'Flipped processTimeout:false → true for Studio-UI consistency.',
      };
    }
    if (/"exits"\s*:/.test(jsonContents)) {
      const m = jsonContents.match(/("exits"\s*:\s*\[[^\]]*\])/);
      if (m) {
        return {
          edits: [{
            oldText: m[0],
            newText: `${m[0]},\n  "processTimeout": true`,
            rationale: 'Added processTimeout:true for Studio-UI consistency.',
          }],
          rationale: 'Inserted processTimeout:true for Studio-alignment.',
        };
      }
    }
    return null;
  },
});

// Defect: ERROR_EXIT_NOT_DECLARED — the real runtime bug. Step code calls
// this.exitStep('__error__', …) but data.exits[] has no entry with that id.
// The SDK resolves exits purely by exits[] dict lookup (flow-sdk/src/step/
// data.ts:94-104); without the entry, getExitStepId returns undefined and
// error routing silently breaks.
//
// Fix: append { id: '__error__', label: 'error', condition: 'processError' }
// to exits[] AND set processError:true (the Studio-convention pair). Needs a
// {code, jsonContents} context — match() gets only jsonContents, so we rely
// on the step.json declaring other error-plumbing signals (label hinting
// "error" exit, dataOut naming, etc.) to infer the need. A cleaner version
// would accept code in context; see findTemplateShapePatches(ctx).
TEMPLATE_PATCHERS.push({
  id: 'ERROR_EXIT_NOT_DECLARED',
  severity: 'error',
  description: 'Step code references __error__ but exits[] has no matching entry. Append the canonical exit entry so the runtime can route errors.',
  match(jsonContents, ctx = {}) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    const exits = Array.isArray(spec.exits) ? spec.exits : [];
    const hasErrorExit = exits.some((e) => e && (e.id === '__error__' || e.id === 'error'));
    if (hasErrorExit) return null;
    // Need a code signal to confirm the patcher is warranted — either the
    // validator flagged ERROR_EXIT_NOT_DECLARED (via ctx), or the caller
    // passed ctx.code containing exitStep('__error__', …).
    const codeHint = ctx && typeof ctx.code === 'string' ? ctx.code : '';
    const validatorHint = ctx && Array.isArray(ctx.validatorFindings)
      ? ctx.validatorFindings.some((f) => f && f.code === 'ERROR_EXIT_NOT_DECLARED')
      : false;
    const callsErrorExit = /this\.exitStep\s*\(\s*['"`](?:error|__error__)['"`]/.test(codeHint);
    if (!callsErrorExit && !validatorHint) return null;

    // Append exit entry + processError:true pair. Match an empty or non-empty
    // exits[] array; preserve trailing comma/whitespace.
    const exitsRe = /"exits"\s*:\s*\[([\s\S]*?)\]/;
    const m = exitsRe.exec(jsonContents);
    if (!m) return null;
    const existing = m[1].trim();
    const entry = '{ "id": "__error__", "label": "error", "condition": "processError" }';
    const newExits = existing
      ? `"exits": [${m[1].replace(/\s*$/, '')}${existing.endsWith(',') ? '' : ','}\n    ${entry}\n  ]`
      : `"exits": [\n    ${entry}\n  ]`;
    const edits = [{
      oldText: m[0],
      newText: newExits,
      rationale: 'Appended { id: "__error__", label: "error", condition: "processError" } to exits[] — the runtime invariant per §4.2.',
    }];
    // Also set processError:true if not present or false.
    if (spec.processError !== true) {
      if (/"processError"\s*:\s*(false|null)/.test(jsonContents)) {
        edits.push({
          oldText: jsonContents.match(/"processError"\s*:\s*(false|null)/)[0],
          newText: '"processError": true',
          rationale: 'Set processError:true alongside the new __error__ exit (Studio-convention pair).',
        });
      } else if (!/"processError"\s*:/.test(jsonContents)) {
        edits.push({
          oldText: newExits,
          newText: `${newExits},\n  "processError": true`,
          rationale: 'Added processError:true alongside the new __error__ exit (Studio-convention pair).',
        });
      }
    }
    return { edits, rationale: 'Declared __error__ exit in exits[] (the real runtime gate) and aligned Studio flag.' };
  },
});

// Defect: TIMEOUT_EXIT_NOT_DECLARED — same runtime gap for __timeout__.
TEMPLATE_PATCHERS.push({
  id: 'TIMEOUT_EXIT_NOT_DECLARED',
  severity: 'error',
  description: 'Step code references __timeout__ but exits[] has no matching entry. Append the canonical exit entry so the runtime can route timeouts.',
  match(jsonContents, ctx = {}) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    const exits = Array.isArray(spec.exits) ? spec.exits : [];
    const hasTimeoutExit = exits.some((e) => e && (e.id === '__timeout__' || e.id === 'timeout'));
    if (hasTimeoutExit) return null;
    const codeHint = ctx && typeof ctx.code === 'string' ? ctx.code : '';
    const validatorHint = ctx && Array.isArray(ctx.validatorFindings)
      ? ctx.validatorFindings.some((f) => f && f.code === 'TIMEOUT_EXIT_NOT_DECLARED')
      : false;
    const callsTimeoutExit = /this\.exitStep\s*\(\s*['"`](?:timeout|__timeout__)['"`]/.test(codeHint);
    if (!callsTimeoutExit && !validatorHint) return null;

    const exitsRe = /"exits"\s*:\s*\[([\s\S]*?)\]/;
    const m = exitsRe.exec(jsonContents);
    if (!m) return null;
    const existing = m[1].trim();
    const entry = '{ "id": "__timeout__", "label": "timeout", "condition": "processTimeout" }';
    const newExits = existing
      ? `"exits": [${m[1].replace(/\s*$/, '')}${existing.endsWith(',') ? '' : ','}\n    ${entry}\n  ]`
      : `"exits": [\n    ${entry}\n  ]`;
    const edits = [{
      oldText: m[0],
      newText: newExits,
      rationale: 'Appended { id: "__timeout__", label: "timeout", condition: "processTimeout" } to exits[] — the runtime invariant per §4.3.',
    }];
    if (spec.processTimeout !== true) {
      if (/"processTimeout"\s*:\s*(false|null)/.test(jsonContents)) {
        edits.push({
          oldText: jsonContents.match(/"processTimeout"\s*:\s*(false|null)/)[0],
          newText: '"processTimeout": true',
          rationale: 'Set processTimeout:true alongside the new __timeout__ exit (Studio-convention pair).',
        });
      } else if (!/"processTimeout"\s*:/.test(jsonContents)) {
        edits.push({
          oldText: newExits,
          newText: `${newExits},\n  "processTimeout": true`,
          rationale: 'Added processTimeout:true alongside the new __timeout__ exit (Studio-convention pair).',
        });
      }
    }
    return { edits, rationale: 'Declared __timeout__ exit in exits[] (the real runtime gate) and aligned Studio flag.' };
  },
});

// Defect: TEMPLATE_DESCRIPTION_TOO_LONG — description exceeds the limit.
// Heuristic fix: truncate to first sentence or first 300 chars.
TEMPLATE_PATCHERS.push({
  id: 'TEMPLATE_DESCRIPTION_TOO_LONG',
  severity: 'warning',
  description: 'Template description is too long. Truncate to first sentence or 300 chars.',
  match(jsonContents) {
    let spec;
    try { spec = JSON.parse(jsonContents); } catch { return null; }
    if (typeof spec.description !== 'string' || spec.description.length <= 500) return null;
    // Truncate at first sentence boundary or 300 chars
    const desc = spec.description;
    let truncated = desc;
    const firstSentence = desc.match(/^[^.!?\n]{20,300}[.!?]/);
    if (firstSentence && firstSentence[0].length <= 400) truncated = firstSentence[0];
    else truncated = desc.slice(0, 300).replace(/\s+\S*$/, '') + '...';
    // Build an exact-match edit on the "description": "..." JSON entry.
    const re = /"description"\s*:\s*"((?:[^"\\]|\\.)*)"/;
    const m = jsonContents.match(re);
    if (!m) return null;
    return {
      edits: [{
        oldText: m[0],
        newText: `"description": ${JSON.stringify(truncated)}`,
        rationale: `Truncated description from ${desc.length} to ${truncated.length} chars.`,
      }],
      rationale: `Truncated description to ${truncated.length} chars.`,
    };
  },
});

// ---------------------------------------------------------------------------
// findTemplateShapePatches — run all template-shape patchers against step.json.
// ---------------------------------------------------------------------------
function findTemplateShapePatches(jsonContents) {
  const patchable = [];
  for (const p of TEMPLATE_PATCHERS) {
    try {
      const r = p.match(jsonContents);
      if (r && Array.isArray(r.edits) && r.edits.length > 0) {
        patchable.push({ id: p.id, severity: p.severity, rationale: r.rationale, edits: r.edits });
      }
    } catch (err) {
      patchable.push({ id: p.id, severity: 'warn', error: err.message, edits: [] });
    }
  }
  return { patchable };
}

module.exports = { findTemplateShapePatches, TEMPLATE_PATCHERS };
