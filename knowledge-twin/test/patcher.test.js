// test/patcher.test.js — deterministic + LLM patcher behavior.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { findPatches, proposeLLMEdits, _internal } = require('../lib/patcher');
const { applyEditsOneFile } = require('../lib/editPrimitive');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

async function withTempFile(contents, ext, fn) {
  const file = path.join(os.tmpdir(), `patcher-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await fsp.writeFile(file, contents, 'utf8');
  try { return await fn(file); } finally { try { await fsp.unlink(file); } catch {} }
}

(async () => {
  console.log('\n== Deterministic patcher: AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX ==');

  await test('matches + removes the ::token:: strip block', async () => {
    const code = `class X {
  async _resolveApiKey() {
    let auth = this.data.auth;
    if (!auth) return null;
    // Strip Edison's "::token::<label>" suffix — storage.get needs the bare UUID
    if (typeof auth === 'string' && auth.includes('::')) {
      auth = auth.split('::')[0];
    }
    return auth;
  }
}
module.exports = X;
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX');
    assert(entry, 'should find AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX');
    assertEq(entry.edits.length, 1);
    // Apply via the Edit primitive and verify result
    await withTempFile(code, '.js', async (file) => {
      const r = await applyEditsOneFile(file, entry.edits);
      assert(r.ok, 'apply should succeed: ' + JSON.stringify(r));
      const after = await fsp.readFile(file, 'utf8');
      assert(!after.includes("auth.split('::')"), 'strip removed');
      assert(after.includes('let auth = this.data.auth;'), 'rest preserved');
    });
  });

  await test('does not match when code has no ::token:: strip', async () => {
    const code = `class X {
  async _resolveApiKey() {
    let auth = this.data.auth;
    return auth;
  }
}
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX');
    assert(!entry, 'should not match');
  });

  console.log('\n== Deterministic patcher: UNCONDITIONAL_ERROR_EXIT ==');

  await test('gates unconditional exitStep("__error__") with processError check', async () => {
    const code = `class X {
  async runStep() {
    if (!this.data.foo) {
      return this.exitStep('__error__', { code: 'MISSING_FOO', message: 'foo is required' });
    }
    return this.exitStep('next', { out: this.data.foo });
  }
}
module.exports = X;
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'UNCONDITIONAL_ERROR_EXIT');
    assert(entry, 'should find UNCONDITIONAL_ERROR_EXIT');
    assertEq(entry.edits.length, 1);
    await withTempFile(code, '.js', async (file) => {
      const r = await applyEditsOneFile(file, entry.edits);
      assert(r.ok, 'should apply: ' + JSON.stringify(r));
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('if (this.data.processError)'), 'processError guard added');
      assert(after.includes('throw Object.assign(new Error'), 'throw path added');
      assert(after.includes("code: 'MISSING_FOO'"), 'error code preserved');
    });
  });

  await test('skips exitStep already guarded by processError', async () => {
    const code = `class X {
  async runStep() {
    if (this.data.processError) return this.exitStep('__error__', { code: 'ERR', message: 'e' });
    throw new Error('e');
  }
}
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'UNCONDITIONAL_ERROR_EXIT');
    assert(!entry, 'should not match when already guarded');
  });

  console.log('\n== Deterministic patcher: EQEQ ==');

  await test('converts == to === outside string literals', async () => {
    const code = `function f(a, b) {
  if (a == b) return true;
  return false;
}
`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'EQEQ');
    assert(entry, 'should find EQEQ');
    await withTempFile(code, '.js', async (file) => {
      const r = await applyEditsOneFile(file, entry.edits);
      assert(r.ok, 'should apply: ' + JSON.stringify(r));
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('a === b'));
      assert(!after.includes('a == b'));
    });
  });

  await test('does not touch == inside string literals', async () => {
    const code = `const msg = "equals == not converted";\nconst x = 1 == 1;\n`;
    const { patchable } = findPatches(code);
    const entry = patchable.find(p => p.id === 'EQEQ');
    assert(entry, 'should find EQEQ on the real usage');
    // The string '==' should survive; the real operator should convert
    await withTempFile(code, '.js', async (file) => {
      const r = await applyEditsOneFile(file, entry.edits);
      assert(r.ok);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('"equals == not converted"'), 'string literal preserved');
      assert(after.includes('1 === 1'), 'real op converted');
    });
  });

  console.log('\n== Deterministic patcher: string/comment stripping ==');

  await test('strings are replaced with spaces, preserving indices', () => {
    const s = 'const a = "hello == world"; const b = 1 == 2;';
    const stripped = _internal.stripStringsAndComments(s);
    assertEq(stripped.length, s.length, 'length preserved');
    // Real operator (1 == 2, outside strings) SHOULD remain.
    assert(stripped.includes('1 == 2'), 'real operator preserved: ' + stripped);
    // String contents replaced with spaces — the string "hello == world" becomes 16 spaces.
    assert(!stripped.includes('hello == world'), 'string contents should be stripped');
  });

  console.log('\n== LLM patcher: narrow-output validation ==');

  await test('accepts valid JSON array with applyable edits', async () => {
    const brokenCode = 'function foo() { return 1; }\n';
    const mockLLM = async () => JSON.stringify([
      { oldText: 'return 1;', newText: 'return 2;', rationale: 'bump' },
    ]);
    const r = await proposeLLMEdits({
      brokenCode,
      diagnostic: { message: 'return value should be 2' },
      callLLM: mockLLM,
    });
    assert(r.ok, 'should succeed');
    assertEq(r.edits.length, 1);
    assertEq(r.edits[0].newText, 'return 2;');
  });

  await test('rejects edits whose oldText does not match', async () => {
    const brokenCode = 'function foo() { return 1; }\n';
    let attempts = 0;
    const mockLLM = async () => {
      attempts++;
      // First attempt gives a non-matching oldText; second gives valid
      if (attempts === 1) return JSON.stringify([{ oldText: 'NOT PRESENT', newText: 'x' }]);
      return JSON.stringify([{ oldText: 'return 1;', newText: 'return 2;' }]);
    };
    const r = await proposeLLMEdits({
      brokenCode,
      diagnostic: { message: 'fix it' },
      callLLM: mockLLM,
      maxAttempts: 3,
    });
    assert(r.ok, 'should succeed after retry');
    assertEq(r.attempts, 2, 'took 2 attempts');
  });

  await test('rejects edits with oldText over 15 lines', async () => {
    const brokenCode = 'x\n'.repeat(30);
    const longOld = 'x\n'.repeat(20);
    const mockLLM = async () => JSON.stringify([{ oldText: longOld, newText: 'replaced\n' }]);
    const r = await proposeLLMEdits({
      brokenCode,
      diagnostic: { message: 'fix it' },
      callLLM: mockLLM,
      maxAttempts: 1,
    });
    assertEq(r.ok, false);
    assert(r.errors.some(e => /max 15/.test(e)), 'should reject over-long edits');
  });

  await test('rejects non-JSON response', async () => {
    const mockLLM = async () => 'Here is some prose and no JSON';
    const r = await proposeLLMEdits({
      brokenCode: 'const x = 1;',
      diagnostic: { message: 'fix it' },
      callLLM: mockLLM,
      maxAttempts: 1,
    });
    assertEq(r.ok, false);
    assert(r.errors.some(e => /no JSON array/.test(e)));
  });

  await test('rejects edits with ambiguous oldText (multi-match)', async () => {
    const brokenCode = 'const x = 1;\nconst x = 1;\n';
    const mockLLM = async () => JSON.stringify([{ oldText: 'const x = 1;', newText: 'const x = 2;' }]);
    const r = await proposeLLMEdits({
      brokenCode,
      diagnostic: { message: 'fix' },
      callLLM: mockLLM,
      maxAttempts: 1,
    });
    assertEq(r.ok, false);
    assert(r.errors.some(e => /OLD_TEXT_MULTIPLE_MATCHES/.test(e)));
  });

  await test('passes library reference to LLM context', async () => {
    let capturedPrompt = '';
    const mockLLM = async (system, user) => {
      capturedPrompt = user;
      return JSON.stringify([{ oldText: 'return 1;', newText: 'return 42;' }]);
    };
    const r = await proposeLLMEdits({
      brokenCode: 'function f() { return 1; }',
      diagnostic: { message: 'wrong value' },
      libraryRef: 'function g() { return 42; }',
      callLLM: mockLLM,
    });
    assert(r.ok);
    assert(capturedPrompt.includes('Working reference'), 'library ref section should be in prompt');
    assert(capturedPrompt.includes('return 42'), 'library ref content included');
  });

  console.log('\n---');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
