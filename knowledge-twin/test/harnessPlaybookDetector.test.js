// test/harnessPlaybookDetector.test.js — tests for the Phase 4 detector.
//
// The detector is a thin deterministic parser of the <!-- test-harness-meta -->
// HTML-comment block that Phase 3's generator emits. It drives harness-mode
// routing in runPipeline.

'use strict';

const {
  isTestHarnessPlaybook,
  parseTestHarnessMeta,
  validateHarnessMeta,
} = require('../lib/harnessPlaybookDetector');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

const WELL_FORMED = [
  '<!-- test-harness-meta',
  'testHarnessFor: flow-abc-123',
  'targetFlowUrl: https://em.edison.api.onereach.ai/http/acct/ep',
  'targetLabel: Find & Replace Agent',
  'targetName: gsx',
  'harnessTemplateLabel: Test Harness (Flow Tester)',
  'harnessTemplateName: Test Harness',
  'scenariosCount: 6',
  'generatedAt: 2026-04-23T00:00:00.000Z',
  '-->',
  '',
  '# Find & Replace Agent Test Harness',
  '',
  '## Test Scenarios',
  '```json',
  '[{"name":"x","input":{},"expect":{}}]',
  '```',
].join('\n');

console.log('\n== isTestHarnessPlaybook ==');

test('detects well-formed harness playbook', () => {
  assertEq(isTestHarnessPlaybook(WELL_FORMED), true);
});

test('does NOT detect a normal step playbook', () => {
  const md = '# Build a step\n\n## Diagnosis\nsome step\n';
  assertEq(isTestHarnessPlaybook(md), false);
});

test('non-string input → false', () => {
  assertEq(isTestHarnessPlaybook(null), false);
  assertEq(isTestHarnessPlaybook(undefined), false);
  assertEq(isTestHarnessPlaybook(42), false);
});

test('empty string → false', () => {
  assertEq(isTestHarnessPlaybook(''), false);
});

console.log('\n== parseTestHarnessMeta ==');

test('parses all expected fields', () => {
  const m = parseTestHarnessMeta(WELL_FORMED);
  assertEq(m.testHarnessFor, 'flow-abc-123');
  assertEq(m.targetFlowUrl, 'https://em.edison.api.onereach.ai/http/acct/ep');
  assertEq(m.targetLabel, 'Find & Replace Agent');
  assertEq(m.harnessTemplateLabel, 'Test Harness (Flow Tester)');
  assertEq(m.scenariosCount, '6');
});

test('returns null when meta block is missing', () => {
  assertEq(parseTestHarnessMeta('no meta here'), null);
});

test('empty meta block → null', () => {
  assertEq(parseTestHarnessMeta('<!-- test-harness-meta -->'), null);
});

test('tolerates extra whitespace / indentation', () => {
  const md = '<!-- test-harness-meta\n    testHarnessFor:   flow-xyz\n  targetFlowUrl:  http://x  \n-->\n';
  const m = parseTestHarnessMeta(md);
  assertEq(m.testHarnessFor, 'flow-xyz');
  assertEq(m.targetFlowUrl, 'http://x');
});

test('ignores malformed lines', () => {
  const md = '<!-- test-harness-meta\ntestHarnessFor: f\nmalformed line without colon\ntargetFlowUrl: u\n-->\n';
  const m = parseTestHarnessMeta(md);
  assertEq(m.testHarnessFor, 'f');
  assertEq(m.targetFlowUrl, 'u');
  assertEq(m['malformed line without colon'], undefined);
});

console.log('\n== validateHarnessMeta ==');

test('returns ok when all required fields present', () => {
  const meta = parseTestHarnessMeta(WELL_FORMED);
  const v = validateHarnessMeta(meta);
  assertEq(v.ok, true);
  assertEq(v.missing.length, 0);
});

test('flags missing required fields', () => {
  const v = validateHarnessMeta({ testHarnessFor: 'f', targetFlowUrl: 'u' });
  assertEq(v.ok, false);
  assert(v.missing.includes('harnessTemplateLabel'));
  assert(v.missing.includes('harnessTemplateName'));
});

test('flags "(unknown)" placeholder values as missing', () => {
  const v = validateHarnessMeta({
    testHarnessFor: '(unknown)',
    targetFlowUrl: '(unknown)',
    harnessTemplateLabel: 'Test Harness (Flow Tester)',
    harnessTemplateName: 'Test Harness',
  });
  assertEq(v.ok, false);
  assert(v.missing.includes('testHarnessFor'));
  assert(v.missing.includes('targetFlowUrl'));
});

test('null meta → ok=false, missing=everything', () => {
  const v = validateHarnessMeta(null);
  assertEq(v.ok, false);
  assertEq(v.missing.length, 4);
});

console.log(`\n---\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
