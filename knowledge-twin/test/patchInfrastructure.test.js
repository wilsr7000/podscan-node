// test/patchInfrastructure.test.js — covers the 3 supporting modules:
//   lib/patchBudget.js  lib/editProvenance.js  lib/diagLocation.js
//   plus HARDCODED_URL + AUTH_NO_KV_RESOLUTION patchers + applyEditsToString

'use strict';

const { createBudget } = require('../lib/patchBudget');
const { createSessionLog, buildEntry } = require('../lib/editProvenance');
const { enrichDiagnostics, withLocation, extractLineFromMessage, getSnippet } = require('../lib/diagLocation');
const { findPatches, proposeLLMEdits } = require('../lib/patcher');
const { applyEditsToString, applyEdit } = require('../lib/editPrimitive');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

(async () => {
  console.log('\n== patchBudget ==');

  await test('allows edits within limits', () => {
    const b = createBudget({ maxEdits: 3 });
    for (let i = 0; i < 3; i++) {
      const c = b.check('edit', { file: 'a.js' });
      assert(c.ok, `edit ${i} should be ok`);
      b.record('edit', { file: 'a.js' });
    }
    // 4th blocked by maxEditsPerFile (default 5) or maxEdits (3)
    const c = b.check('edit', { file: 'a.js' });
    assertEq(c.ok, false);
    assertEq(c.reason, 'maxEdits');
  });

  await test('maxEditsPerFile fires before maxEdits', () => {
    const b = createBudget({ maxEdits: 20, maxEditsPerFile: 2 });
    b.record('edit', { file: 'x.js' });
    b.record('edit', { file: 'x.js' });
    const c = b.check('edit', { file: 'x.js' });
    assertEq(c.ok, false);
    assertEq(c.reason, 'maxEditsPerFile');
  });

  await test('maxFilesMutated caps different files', () => {
    const b = createBudget({ maxEdits: 100, maxFilesMutated: 2 });
    b.record('edit', { file: 'a.js' });
    b.record('edit', { file: 'b.js' });
    const c = b.check('edit', { file: 'c.js' });
    assertEq(c.ok, false);
    assertEq(c.reason, 'maxFilesMutated');
    // But edits on already-mutated files still allowed
    const c2 = b.check('edit', { file: 'a.js' });
    assert(c2.ok);
  });

  await test('maxLLMAttempts enforces separately', () => {
    const b = createBudget({ maxLLMAttempts: 2 });
    b.record('llm');
    b.record('llm');
    const c = b.check('llm');
    assertEq(c.ok, false);
    assertEq(c.reason, 'maxLLMAttempts');
  });

  await test('snapshot reports current state', () => {
    const b = createBudget({ maxEdits: 5 });
    b.record('edit', { file: 'a.js' });
    const s = b.snapshot();
    assertEq(s.editsApplied, 1);
    assertEq(s.filesMutated, 1);
  });

  console.log('\n== editProvenance ==');

  await test('createSessionLog collects entries with summary', () => {
    const log = createSessionLog();
    log.add({ stage: 'harnessCode', file: 'a.js', defectId: 'X', source: 'deterministic', rationale: 'r' });
    log.add({ stage: 'harnessCode', file: 'b.js', defectId: 'Y', source: 'llm', rationale: 'r2' });
    log.recordVerification(0, { passed: true });
    log.recordVerification(1, { passed: false, note: 'test failed' });
    const s = log.summary();
    assertEq(s.total, 2);
    assertEq(s.bySource.deterministic, 1);
    assertEq(s.bySource.llm, 1);
    assertEq(s.passed, 1);
    assertEq(s.failed, 1);
  });

  await test('buildEntry fills fields from editResult', () => {
    const editResult = {
      ok: true, file: 'x.js',
      oldTextHash: 'aaa', newTextHash: 'bbb',
      oldFileHash: '111', newFileHash: '222',
      linesChanged: 3,
      oldBytes: 100, newBytes: 120,
    };
    const entry = buildEntry({ editResult, stage: 'test', defectId: 'MY_DEFECT', source: 'deterministic', rationale: 'because' });
    assertEq(entry.stage, 'test');
    assertEq(entry.defectId, 'MY_DEFECT');
    assertEq(entry.bytesDelta, 20);
    assertEq(entry.oldFileHash, '111');
    assertEq(entry.verification, 'pending');
  });

  await test('buildEntry rejects unsuccessful edits', () => {
    try {
      buildEntry({ editResult: { ok: false }, stage: 't', defectId: 'd', source: 's' });
      throw new Error('should have thrown');
    } catch (e) {
      assert(/successful edit/.test(e.message));
    }
  });

  console.log('\n== diagLocation ==');

  await test('extractLineFromMessage parses "Line N:" prefix', () => {
    assertEq(extractLineFromMessage('Line 42: hardcoded URL "https://..."'), 42);
    assertEq(extractLineFromMessage('Something without a line'), null);
  });

  await test('getSnippet returns the right range', () => {
    const code = 'a\nb\nc\nd\ne';
    assertEq(getSnippet(code, 2, 3), 'b\nc');
    assertEq(getSnippet(code, 1, 1), 'a');
  });

  await test('enrichDiagnostics adds location from context.line', () => {
    const code = 'line1\nline2\nline3\n';
    const diags = [{ code: 'X', severity: 'error', message: 'something', context: { line: 2 } }];
    const out = enrichDiagnostics(diags, code);
    assertEq(out[0].location.startLine, 2);
    assertEq(out[0].location.endLine, 2);
    assertEq(out[0].location.snippet, 'line2');
  });

  await test('enrichDiagnostics adds location from message prefix', () => {
    const code = 'a\nb\nc\n';
    const diags = [{ code: 'X', severity: 'error', message: 'Line 3: there is a problem' }];
    const out = enrichDiagnostics(diags, code);
    assertEq(out[0].location.startLine, 3);
    assertEq(out[0].location.snippet, 'c');
  });

  await test('enrichDiagnostics preserves existing location (idempotent)', () => {
    const diags = [{
      code: 'X', message: 'msg', context: { line: 5 },
      location: { startLine: 10, endLine: 10, snippet: 'custom' },
    }];
    const out = enrichDiagnostics(diags, 'code\ncode\n');
    assertEq(out[0].location.startLine, 10, 'pre-existing location preserved');
  });

  await test('enrichDiagnostics leaves unlocatable diags alone', () => {
    const diags = [{ code: 'X', severity: 'error', message: 'no line here' }];
    const out = enrichDiagnostics(diags, 'any');
    assert(!out[0].location, 'no location added when none can be derived');
  });

  await test('withLocation helper returns new diag with location', () => {
    const d = { code: 'X', severity: 'error', message: 'm' };
    const out = withLocation(d, { startLine: 7, snippet: 'x' });
    assertEq(out.location.startLine, 7);
    assertEq(out.location.endLine, 7, 'endLine defaults to startLine');
  });

  console.log('\n== patcher: HARDCODED_URL (ported from autoRepairKnownBlockers) ==');

  await test('HARDCODED_URL: hoists URL into runStep with spec-input resolution', () => {
    const code = `class X {
  async runStep() {
    const data = await fetch("https://api.weatherapi.com/v1/current.json");
    return this.exitStep('next', { data });
  }
}
module.exports = X;
`;
    const spec = { inputs: [{ variable: 'apiBaseUrl', type: 'text', default: 'https://api.weatherapi.com/v1' }] };
    const { patchable } = findPatches(code, { spec });
    const entry = patchable.find((p) => p.id === 'HARDCODED_URL');
    assert(entry, 'should find HARDCODED_URL');
    assert(entry.edits.length >= 2, `expected 2+ edits, got ${entry.edits.length}`);
    // Apply in-memory via applyEditsToString
    const result = applyEditsToString(code, entry.edits);
    assert(result.ok, 'should apply: ' + JSON.stringify(result));
    assert(result.code.includes('_apiBaseUrl_resolved'), 'variable declared + used');
    assert(!result.code.includes('"https://api.weatherapi.com/v1/current.json"'), 'literal replaced');
  });

  await test('HARDCODED_URL: skipped if spec has no inputs', () => {
    const code = `async function f() { return fetch("https://api.x.com/v1"); }`;
    const { patchable } = findPatches(code, { spec: null });
    const entry = patchable.find((p) => p.id === 'HARDCODED_URL');
    assert(!entry, 'should not fire without a spec');
  });

  console.log('\n== patcher: AUTH_NO_KV_RESOLUTION ==');

  await test('AUTH_NO_KV_RESOLUTION: injects canonical storage.get block', () => {
    const code = `class X {
  async runStep() {
    const key = this.data.auth;
    const result = await fetch('/x', { headers: { authorization: key } });
    return this.exitStep('next', {});
  }
}
module.exports = X;
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find((p) => p.id === 'AUTH_NO_KV_RESOLUTION');
    assert(entry, 'should detect');
    const result = applyEditsToString(code, entry.edits);
    assert(result.ok, 'should apply: ' + JSON.stringify(result));
    assert(result.code.includes('or-sdk/storage'), 'storage require injected');
    assert(result.code.includes('storage.get'), 'storage.get call injected');
  });

  await test('AUTH_NO_KV_RESOLUTION: skipped when already resolving via storage.get', () => {
    const code = `class X {
  async runStep() {
    const Storage = require('or-sdk/storage');
    const s = new Storage(this);
    const creds = await s.get('col', this.data.auth);
    return this.exitStep('next', {});
  }
}`;
    const { patchable } = findPatches(code);
    const entry = patchable.find((p) => p.id === 'AUTH_NO_KV_RESOLUTION');
    assert(!entry, 'should not re-inject');
  });

  console.log('\n== applyEditsToString (in-memory) ==');

  await test('applies single edit in memory, returns new code + hashes', () => {
    const code = 'const x = 1;';
    const r = applyEditsToString(code, [{ oldText: 'x = 1', newText: 'x = 42' }]);
    assert(r.ok);
    assertEq(r.code, 'const x = 42;');
    assert(r.oldHash !== r.newHash);
  });

  await test('applies sequential edits (later references earlier result)', () => {
    const code = 'const OLD = 1;';
    const r = applyEditsToString(code, [
      { oldText: 'OLD', newText: 'NEW' },
      { oldText: 'NEW = 1', newText: 'NEW = 2' },
    ]);
    assert(r.ok);
    assertEq(r.code, 'const NEW = 2;');
  });

  await test('fails entire batch on any missing match (returns original)', () => {
    const code = 'const x = 1;';
    const r = applyEditsToString(code, [
      { oldText: 'x = 1', newText: 'x = 2' },
      { oldText: 'NONEXISTENT', newText: 'y' },
    ]);
    assertEq(r.ok, false);
    assertEq(r.code, code, 'original returned unchanged on failure');
  });

  console.log('\n== budget + proposeLLMEdits integration ==');

  await test('proposeLLMEdits respects budget, stops at max LLM attempts', async () => {
    const { createBudget } = require('../lib/patchBudget');
    const budget = createBudget({ maxLLMAttempts: 2 });
    let callCount = 0;
    const mockLLM = async () => { callCount++; return 'not JSON — forces retry'; };
    const r = await proposeLLMEdits({
      brokenCode: 'x',
      diagnostic: { message: 'm' },
      callLLM: mockLLM,
      maxAttempts: 5,  // would allow 5, budget caps at 2
      budget,
    });
    assertEq(r.ok, false);
    assertEq(callCount, 2, 'should have stopped at budget cap');
    assertEq(r.budgetExceeded || r.errors.some(e => /budget/.test(e)), true);
  });

  console.log('\n---');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
