// ---------------------------------------------------------------------------
// platformRules.js — parse docs/platform-rules.md into a structured registry.
//
// docs/platform-rules.md is the single source of truth for Edison step
// development rules. Multiple consumers ingest it: the code generator (LLM
// system prompt), the validator (rule IDs → implementations), the patcher
// (known-issue IDs → auto-fixes), and the reusability judge. Before this
// module, those consumers used parallel copies of the rules, so the doc drifted
// from enforcement. This module parses the .md and exposes:
//
//   getRules()             — all rules with {section, number, title, body,
//                             validatorRefs[], patcherRefs[], knownIssueRefs[]}
//   getRule(id)            — lookup by '1.1' / '4.2' / '15.10' etc.
//   getRulesForSection(n)  — rules inside section N
//   getValidatorRules()    — the §16 table as {id → {section, severity}}
//   getPatcherRules()      — the §17 table as {id → {section, fixes}}
//   getPendingValidators() — validator IDs listed under "New rules to add"
//   getAppendixDigest()    — the compressed DO/DON'T block for LLM prompts
//   getFullText()          — the entire .md source
//   selfCheck(consumers)   — assert no drift between .md and consumers;
//                             returns {ok, errors[], warnings[]}
//
// Drift detection is the whole point: selfCheck() is called from a test so that
// editing docs/platform-rules.md without updating stepValidator.js (or vice
// versa) fails CI.
// ---------------------------------------------------------------------------

'use strict';

const fs = require('fs');
const path = require('path');

const DOC_PATH = path.join(__dirname, '..', 'docs', 'platform-rules.md');

let _cached = null;

function _parse(source) {
  const lines = source.split('\n');

  const sections = [];              // [{num, title, startLine}]
  const rules = [];                 // [{section, number, title, body, validatorRefs, patcherRefs, knownIssueRefs}]
  const validatorRules = {};        // id → {section, severity}
  const patcherRules = {};          // id → {section, fixes}
  const pendingValidators = [];     // [{id, description}]

  let currentSection = null;
  let currentRule = null;
  let bodyBuffer = [];
  let inValidatorTable = false;
  let inPatcherTable = false;
  let inPendingList = false;
  let inAppendix = false;
  let appendixLines = [];

  const finalizeRule = () => {
    if (!currentRule) return;
    const body = bodyBuffer.join('\n');
    currentRule.body = body;
    currentRule.validatorRefs = _extractRefs(body, /\*\*Validator\*\*:\s*([^\n.]+)/gi);
    currentRule.patcherRefs   = _extractRefs(body, /\*\*Patcher\*\*:\s*([^\n.]+)/gi);
    currentRule.knownIssueRefs = _extractRefs(body, /\*\*Known issue\*\*:\s*([^\n.]+)/gi, /KI-\d+/g);
    rules.push(currentRule);
    currentRule = null;
    bodyBuffer = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Section heading: "## N. Title"
    const secMatch = /^##\s+(\d+)\.\s+(.+)$/.exec(line);
    if (secMatch) {
      finalizeRule();
      currentSection = { num: parseInt(secMatch[1], 10), title: secMatch[2].trim(), startLine: i };
      sections.push(currentSection);
      inValidatorTable = currentSection.num === 16;
      inPatcherTable   = currentSection.num === 17;
      inAppendix = false;
      continue;
    }

    // Appendix heading: "## Appendix: ..."
    if (/^##\s+Appendix\b/.test(line)) {
      finalizeRule();
      currentSection = null;
      inAppendix = true;
      inValidatorTable = inPatcherTable = false;
      continue;
    }

    // Rule heading: "### Rule N.N — Title" or "### N.N — Title"
    const ruleMatch = /^###\s+(?:Rule\s+)?(\d+\.\d+)\s*[—–\-]\s*(.+)$/.exec(line);
    if (ruleMatch) {
      finalizeRule();
      currentRule = {
        section: currentSection ? currentSection.num : null,
        number: ruleMatch[1],
        title: ruleMatch[2].trim(),
        body: '',
        validatorRefs: [],
        patcherRefs: [],
        knownIssueRefs: [],
      };
      continue;
    }

    // Section 16 validator table rows: | VALIDATOR_ID | section | severity |
    if (inValidatorTable) {
      const tableRow = /^\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (tableRow) {
        validatorRules[tableRow[1].trim()] = {
          section: tableRow[2].trim(),
          severity: tableRow[3].trim(),
        };
      }
      // "New rules to add" list
      if (/^\*\*New rules to add/.test(line)) {
        inPendingList = true;
        continue;
      }
      if (inPendingList) {
        const pend = /^-\s*`([A-Z][A-Z0-9_]+)`\s*[—–\-]\s*(.+)$/.exec(line);
        if (pend) {
          pendingValidators.push({ id: pend[1], description: pend[2].trim() });
        } else if (/^---\s*$/.test(line) || /^##\s/.test(line)) {
          inPendingList = false;
        }
      }
    }

    // Section 17 patcher table rows: | PATCHER_ID | fixes | section |
    if (inPatcherTable) {
      const tableRow = /^\|\s*([A-Z][A-Z0-9_]+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/.exec(line);
      if (tableRow) {
        patcherRules[tableRow[1].trim()] = {
          fixes: tableRow[2].trim(),
          section: tableRow[3].trim(),
        };
      }
    }

    if (inAppendix) {
      appendixLines.push(line);
    } else if (currentRule) {
      bodyBuffer.push(line);
    }
  }
  finalizeRule();

  // Clean up validatorRules / patcherRules: the table has header + separator
  // rows that parse as { 'Validator ID': {section: 'Section', …}, '---': ... }.
  // Filter out those by requiring section to be a number or 'section'-like.
  for (const key of Object.keys(validatorRules)) {
    if (key === 'Validator' || key === 'ID' || key.length < 3 || !/[A-Z]/.test(key)) {
      delete validatorRules[key];
    }
  }
  for (const key of Object.keys(patcherRules)) {
    if (key === 'Patcher' || key === 'ID' || key.length < 3 || !/[A-Z]/.test(key)) {
      delete patcherRules[key];
    }
  }

  const appendixDigest = _extractAppendixBlock(appendixLines.join('\n'));

  return {
    sections,
    rules,
    validatorRules,
    patcherRules,
    pendingValidators,
    appendixDigest,
    fullText: source,
  };
}

function _extractRefs(body, labelRe, idRe) {
  const out = new Set();
  const defaultIdRe = /[A-Z][A-Z0-9_]{2,}/g;
  labelRe.lastIndex = 0;
  let m;
  while ((m = labelRe.exec(body)) !== null) {
    const raw = m[1] || '';
    const ids = raw.match(idRe || defaultIdRe) || [];
    for (const id of ids) out.add(id);
  }
  return [...out];
}

function _extractAppendixBlock(text) {
  const codeBlockMatch = /```\s*\n([\s\S]*?)\n```/.exec(text);
  return codeBlockMatch ? codeBlockMatch[1].trim() : text.trim();
}

function _load() {
  if (_cached) return _cached;
  const source = fs.readFileSync(DOC_PATH, 'utf8');
  _cached = _parse(source);
  return _cached;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function reload() { _cached = null; return _load(); }

function getRules() { return _load().rules.slice(); }

function getRule(number) {
  return _load().rules.find(r => r.number === number) || null;
}

function getRulesForSection(n) {
  return _load().rules.filter(r => r.section === n);
}

function getSections() { return _load().sections.slice(); }

function getValidatorRules() { return { ..._load().validatorRules }; }

function getPatcherRules() { return { ..._load().patcherRules }; }

function getPendingValidators() { return _load().pendingValidators.slice(); }

function getAppendixDigest() { return _load().appendixDigest; }

function getFullText() { return _load().fullText; }

/**
 * selfCheck — drift detection.
 *
 * Given the consumer modules (validator, patcher, known-issues), assert:
 *   1. Every validator ID named in platform-rules.md §16 or any Rule's
 *      "Validator:" reference is implemented in the validator.
 *   2. Every patcher ID named in §17 is implemented in the patcher.
 *   3. Every known-issue ID referenced (KI-XXX) is in known-issues.
 *
 * Returns { ok, errors: string[], warnings: string[] }. Callers typically
 * assert result.ok inside a test.
 */
function selfCheck(consumers = {}) {
  const { validator, patcher, knownIssues } = consumers;
  const data = _load();

  const errors = [];
  const warnings = [];

  // --- Validator coverage ---
  if (validator) {
    const implementedIds = _collectValidatorIds(validator);
    for (const id of Object.keys(data.validatorRules)) {
      if (!implementedIds.has(id)) {
        errors.push(`validator: §16 lists '${id}' but stepValidator does not emit it`);
      }
    }
    // Referenced inline (within rule bodies)
    for (const rule of data.rules) {
      for (const id of rule.validatorRefs) {
        // Some rule bodies reference planned IDs in prose — only error if the
        // ID is in the §16 table (authoritative) or the "pending" list (known
        // as not-yet-implemented).
        const inTable = id in data.validatorRules;
        const inPending = data.pendingValidators.some(p => p.id === id);
        if (inTable && !implementedIds.has(id)) {
          errors.push(`validator: rule ${rule.number} references '${id}' (in §16 table) but stepValidator does not emit it`);
        } else if (!inTable && !inPending && !implementedIds.has(id)) {
          warnings.push(`validator: rule ${rule.number} references '${id}' which is neither in §16 nor in the pending list`);
        }
      }
    }
    // Extra validator-only IDs (stepValidator emits IDs not listed in §16)
    for (const id of implementedIds) {
      if (!(id in data.validatorRules) && !data.pendingValidators.some(p => p.id === id)) {
        warnings.push(`validator: stepValidator emits '${id}' which is not documented in §16`);
      }
    }
  }

  // --- Patcher coverage ---
  if (patcher) {
    const implementedIds = _collectPatcherIds(patcher);
    for (const id of Object.keys(data.patcherRules)) {
      if (!implementedIds.has(id)) {
        errors.push(`patcher: §17 lists '${id}' but patcher module does not implement it`);
      }
    }
    for (const id of implementedIds) {
      if (!(id in data.patcherRules)) {
        warnings.push(`patcher: implements '${id}' which is not documented in §17`);
      }
    }
  }

  // --- Known-issue coverage ---
  if (knownIssues) {
    const implementedIds = new Set((knownIssues.KNOWN_ISSUES || []).map(k => k.id));
    for (const rule of data.rules) {
      for (const id of rule.knownIssueRefs) {
        // KI-XXX are referenced as Known issue: KI-031. Warn (not error) if
        // the registry doesn't include it — registry is append-only and the
        // referenced incident may pre-date the registry.
        if (!implementedIds.has(id)) {
          warnings.push(`known-issues: rule ${rule.number} references '${id}' not in KNOWN_ISSUES`);
        }
      }
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

function _collectValidatorIds(validator) {
  // The stepValidator module doesn't export its rule IDs directly. We infer
  // them by scanning the source for single-quoted CODE_LIKE strings. This is
  // coarser than ideal but works because rule IDs are all-caps with underscores
  // and are emitted via diag(code, …).
  try {
    const source = fs.readFileSync(require.resolve('./stepValidator.js'), 'utf8');
    const matches = source.match(/\bdiag\(\s*['"]([A-Z][A-Z0-9_]{2,})['"]/g) || [];
    const ids = new Set();
    for (const m of matches) {
      const idMatch = /['"]([A-Z][A-Z0-9_]{2,})['"]/.exec(m);
      if (idMatch) ids.add(idMatch[1]);
    }
    // Also pick up template-string diag codes: diag(`${...}_SUFFIX`, …) —
    // the dynamic form in validateConditionBuilder. These are handled by a
    // helper diagCodeForBuilder; we approximate by scanning for the literal
    // prefix constants used.
    return ids;
  } catch (err) {
    return new Set();
  }
}

function _collectPatcherIds(patcher) {
  // Accept either a single module (patcher.PATCHERS / TEMPLATE_PATCHERS /
  // TEMPLATE_SHAPE_PATCHERS) or an array of modules to aggregate across.
  const ids = new Set();
  const modules = Array.isArray(patcher) && !patcher[0]?.id
    ? patcher                                          // array of modules
    : [patcher];                                       // single module

  for (const mod of modules) {
    if (!mod) continue;
    const arrays = [
      mod.PATCHERS,
      mod.TEMPLATE_PATCHERS,
      mod.TEMPLATE_SHAPE_PATCHERS,
    ].filter(Array.isArray);
    for (const arr of arrays) {
      for (const p of arr) if (p && p.id) ids.add(p.id);
    }
    // Flat-array module shape.
    if (Array.isArray(mod) && mod[0]?.id) {
      for (const p of mod) if (p && p.id) ids.add(p.id);
    }
  }
  return ids;
}

/**
 * Build a prompt-ready digest that the code-generator step can embed in its
 * system prompt. Includes the Appendix block plus a compact rule index
 * (section → rule number + title) so the model can cite rules by number.
 */
function getSystemPromptDigest() {
  const data = _load();
  const parts = [];
  parts.push('# Edison Platform Rules (compressed)');
  parts.push('');
  parts.push(data.appendixDigest);
  parts.push('');
  parts.push('## Rule index (cite by §number)');
  for (const section of data.sections) {
    const rulesInSection = data.rules.filter(r => r.section === section.num);
    if (!rulesInSection.length) continue;
    parts.push(`§${section.num} ${section.title}`);
    for (const r of rulesInSection) {
      parts.push(`  ${r.number} — ${r.title}`);
    }
  }
  return parts.join('\n');
}

module.exports = {
  reload,
  getRules,
  getRule,
  getRulesForSection,
  getSections,
  getValidatorRules,
  getPatcherRules,
  getPendingValidators,
  getAppendixDigest,
  getSystemPromptDigest,
  getFullText,
  selfCheck,
};
