// ---------------------------------------------------------------------------
// harnessPlaybookDetector.js — spots test-harness playbooks and extracts
// their metadata block for routing purposes.
//
// A test-harness playbook carries a machine-readable HTML-comment header
// that Phase 3's generator emits:
//
//   <!-- test-harness-meta
//   testHarnessFor: <flowId>
//   targetFlowUrl: <url>
//   targetLabel: <label>
//   targetName: <name>
//   harnessTemplateLabel: Test Harness (Flow Tester)
//   harnessTemplateName: Test Harness
//   scenariosCount: 6
//   generatedAt: <iso-ts>
//   -->
//
// When the pipeline sees this, it routes through a shorter stage sequence
// that SKIPS generateCode / harnessCode / localScenarioRun (no new step
// code to write — we just parameterize the hand-built Test Harness
// template) and SPLICES the trusted template with pre-configured
// scenarios + target URL.
// ---------------------------------------------------------------------------

'use strict';

const META_RE = /<!--\s*test-harness-meta\b([\s\S]*?)-->/;

function isTestHarnessPlaybook(markdown) {
  if (typeof markdown !== 'string' || !markdown) return false;
  return META_RE.test(markdown);
}

// Parse the meta block into a { key: value } object. Values are strings.
// Returns null if the block is missing or empty.
function parseTestHarnessMeta(markdown) {
  if (typeof markdown !== 'string' || !markdown) return null;
  const m = markdown.match(META_RE);
  if (!m) return null;
  const body = m[1] || '';
  const out = {};
  for (const line of body.split('\n')) {
    const kv = line.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/);
    if (!kv) continue;
    out[kv[1]] = kv[2];
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Validate the meta block has the fields we rely on. Returns
// { ok: boolean, missing: [...], meta: {...} }.
function validateHarnessMeta(meta) {
  const required = ['testHarnessFor', 'targetFlowUrl', 'harnessTemplateLabel', 'harnessTemplateName'];
  const missing = required.filter((k) => !meta || typeof meta[k] !== 'string' || !meta[k] || meta[k] === '(unknown)');
  return { ok: missing.length === 0, missing, meta: meta || {} };
}

module.exports = {
  isTestHarnessPlaybook,
  parseTestHarnessMeta,
  validateHarnessMeta,
};
