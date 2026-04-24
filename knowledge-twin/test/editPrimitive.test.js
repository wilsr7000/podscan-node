// test/editPrimitive.test.js — exercise every invariant.

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { applyEdit, applyEditsOneFile, applyEditsMultiFile, validateEditAgainstContents, ERR } = require('../lib/editPrimitive');

let passed = 0, failed = 0;
const runOnly = process.env.ONLY;
async function test(name, fn) {
  if (runOnly && !name.includes(runOnly)) return;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'assertEq'}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

async function withTempFile(contents, ext, fn) {
  const file = path.join(os.tmpdir(), `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  await fsp.writeFile(file, contents, 'utf8');
  try {
    return await fn(file);
  } finally {
    try { await fsp.unlink(file); } catch {}
  }
}

(async () => {
  console.log('\n== applyEdit — single edit, happy path ==');

  await test('js: replaces unique oldText and file still parses', async () => {
    await withTempFile(`function foo() { return 1; }\nmodule.exports = foo;\n`, '.js', async (file) => {
      const r = await applyEdit({
        file, oldText: 'return 1;', newText: 'return 2;', rationale: 'bump value',
      });
      assert(r.ok, 'edit should succeed: ' + JSON.stringify(r));
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('return 2;'), 'new text should be present');
      assert(!after.includes('return 1;'), 'old text should be gone');
      assert(r.oldFileHash !== r.newFileHash, 'hashes should differ');
      assert(r.syntaxChecked === true, 'js should have been syntax-checked');
    });
  });

  await test('json: valid replacement passes', async () => {
    await withTempFile(`{"version":"1.0.0","name":"x"}`, '.json', async (file) => {
      const r = await applyEdit({ file, oldText: '"1.0.0"', newText: '"1.0.1"' });
      assert(r.ok, 'edit should succeed');
    });
  });

  await test('md: no syntax check, always accepts', async () => {
    await withTempFile(`# hi\ncontent\n`, '.md', async (file) => {
      const r = await applyEdit({ file, oldText: 'hi', newText: 'hello' });
      assert(r.ok);
      assert(r.syntaxChecked === false, 'md is skipped from syntax check');
    });
  });

  console.log('\n== applyEdit — invariant violations ==');

  await test('rejects when oldText not found', async () => {
    await withTempFile(`const x = 1;\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: 'NOT PRESENT', newText: 'replacement' });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.OLD_TEXT_NO_MATCH);
    });
  });

  await test('rejects when oldText matches multiple times', async () => {
    await withTempFile(`const x = 1;\nconst x = 1;\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: 'const x = 1;', newText: 'const x = 2;' });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.OLD_TEXT_MULTIPLE_MATCHES);
    });
  });

  await test('rejects edit that would break JS syntax', async () => {
    await withTempFile(`function foo() { return 1; }\n`, '.js', async (file) => {
      const r = await applyEdit({
        file, oldText: 'return 1;', newText: 'return )1;  // broken',
      });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.SYNTAX_INVALID_AFTER);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('return 1;'), 'file should be unchanged after syntax failure');
    });
  });

  await test('rejects edit that would break JSON', async () => {
    await withTempFile(`{"a":1}`, '.json', async (file) => {
      const r = await applyEdit({ file, oldText: '1', newText: '1,,broken' });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.SYNTAX_INVALID_AFTER);
    });
  });

  await test('rejects missing file', async () => {
    const r = await applyEdit({
      file: '/tmp/does-not-exist-xyz-123.js', oldText: 'x', newText: 'y',
    });
    assertEq(r.ok, false);
    assertEq(r.error, ERR.FILE_NOT_FOUND);
  });

  await test('rejects bad edit shape (missing file)', async () => {
    const r = await applyEdit({ oldText: 'a', newText: 'b' });
    assertEq(r.ok, false);
    assertEq(r.error, ERR.EDIT_INVALID_SHAPE);
  });

  await test('rejects no-op edit (oldText === newText)', async () => {
    await withTempFile(`x\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: 'x', newText: 'x' });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.EDIT_INVALID_SHAPE);
    });
  });

  await test('empty oldText without operation is rejected', async () => {
    await withTempFile(`// a\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: '', newText: '// new\n' });
      assertEq(r.ok, false);
      assertEq(r.error, ERR.EDIT_INVALID_SHAPE);
    });
  });

  console.log('\n== applyEdit — prepend / append operations ==');

  await test('prepend inserts at start', async () => {
    await withTempFile(`const x = 1;\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: '', newText: '"use strict";\n', operation: 'prepend' });
      assert(r.ok);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.startsWith('"use strict";\n'), 'should prepend');
    });
  });

  await test('append inserts at end', async () => {
    await withTempFile(`const x = 1;\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: '', newText: '\nmodule.exports = x;', operation: 'append' });
      assert(r.ok);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.endsWith('module.exports = x;'), 'should append');
    });
  });

  console.log('\n== applyEdit — dryRun ==');

  await test('dryRun does not write to disk', async () => {
    await withTempFile(`const x = 1;\n`, '.js', async (file) => {
      const r = await applyEdit({ file, oldText: '1', newText: '2' }, { dryRun: true });
      assert(r.ok);
      assert(r.dryRun === true);
      const after = await fsp.readFile(file, 'utf8');
      assertEq(after, 'const x = 1;\n', 'file should be unchanged');
    });
  });

  console.log('\n== applyEditsOneFile — batched, all-or-nothing ==');

  await test('applies N edits sequentially in memory, writes once', async () => {
    await withTempFile(`const a = 1;\nconst b = 2;\nconst c = 3;\n`, '.js', async (file) => {
      const r = await applyEditsOneFile(file, [
        { oldText: 'const a = 1', newText: 'const a = 10' },
        { oldText: 'const b = 2', newText: 'const b = 20' },
        { oldText: 'const c = 3', newText: 'const c = 30' },
      ]);
      assert(r.ok);
      assertEq(r.editsApplied, 3);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('const a = 10;'));
      assert(after.includes('const b = 20;'));
      assert(after.includes('const c = 30;'));
    });
  });

  await test('batch: second edit fails → first edit NOT written', async () => {
    await withTempFile(`const a = 1;\nconst b = 2;\n`, '.js', async (file) => {
      const r = await applyEditsOneFile(file, [
        { oldText: 'const a = 1', newText: 'const a = 10' },
        { oldText: 'NONEXISTENT', newText: 'x' },
      ]);
      assertEq(r.ok, false);
      assertEq(r.error, ERR.OLD_TEXT_NO_MATCH);
      const after = await fsp.readFile(file, 'utf8');
      assertEq(after, 'const a = 1;\nconst b = 2;\n', 'file should be untouched');
    });
  });

  await test('batch: final syntax failure → no edits written', async () => {
    await withTempFile(`function f() { return 1; }\n`, '.js', async (file) => {
      const r = await applyEditsOneFile(file, [
        { oldText: 'return 1;', newText: 'return 2;' },        // ok alone
        { oldText: 'function f()', newText: 'function f(' },   // breaks syntax
      ]);
      assertEq(r.ok, false);
      assertEq(r.error, ERR.SYNTAX_INVALID_AFTER);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('return 1;'), 'should be untouched');
    });
  });

  await test('batch: later edit can reference text created by earlier edit', async () => {
    await withTempFile(`const x = OLD;\n`, '.js', async (file) => {
      const r = await applyEditsOneFile(file, [
        { oldText: 'OLD', newText: '42' },      // content now `const x = 42;`
        { oldText: 'const x = 42', newText: 'const x = 100' },  // references post-edit-1 state
      ]);
      assert(r.ok);
      const after = await fsp.readFile(file, 'utf8');
      assert(after.includes('const x = 100;'));
    });
  });

  console.log('\n== applyEditsMultiFile — cross-file transactions ==');

  await test('two files both succeed: both written', async () => {
    await withTempFile(`const a = 1;\n`, '.js', async (fileA) => {
      await withTempFile(`{"v":"1.0.0"}`, '.json', async (fileB) => {
        const r = await applyEditsMultiFile([
          { file: fileA, oldText: 'const a = 1', newText: 'const a = 99' },
          { file: fileB, oldText: '"1.0.0"', newText: '"2.0.0"' },
        ]);
        assert(r.ok);
        assertEq(r.filesAffected, 2);
        assertEq(r.editsApplied, 2);
        const aAfter = await fsp.readFile(fileA, 'utf8');
        const bAfter = await fsp.readFile(fileB, 'utf8');
        assert(aAfter.includes('99'));
        assert(bAfter.includes('2.0.0'));
      });
    });
  });

  await test('one file fails validation → neither is written', async () => {
    await withTempFile(`const a = 1;\n`, '.js', async (fileA) => {
      await withTempFile(`{"v":"1.0.0"}`, '.json', async (fileB) => {
        const r = await applyEditsMultiFile([
          { file: fileA, oldText: 'const a = 1', newText: 'const a = 99' },
          { file: fileB, oldText: '"1.0.0"', newText: '1,,broken' },  // breaks JSON
        ]);
        assertEq(r.ok, false);
        assertEq(r.error, ERR.SYNTAX_INVALID_AFTER);
        const aAfter = await fsp.readFile(fileA, 'utf8');
        const bAfter = await fsp.readFile(fileB, 'utf8');
        assertEq(aAfter, 'const a = 1;\n', 'A untouched');
        assertEq(bAfter, '{"v":"1.0.0"}', 'B untouched');
      });
    });
  });

  await test('no-match in one file → nothing is written', async () => {
    await withTempFile(`const a = 1;\n`, '.js', async (fileA) => {
      await withTempFile(`const b = 2;\n`, '.js', async (fileB) => {
        const r = await applyEditsMultiFile([
          { file: fileA, oldText: 'const a = 1', newText: 'const a = 99' },
          { file: fileB, oldText: 'NONEXISTENT', newText: 'x' },
        ]);
        assertEq(r.ok, false);
        const aAfter = await fsp.readFile(fileA, 'utf8');
        assertEq(aAfter, 'const a = 1;\n');
      });
    });
  });

  await test('dryRun multi-file: neither written, shape ok', async () => {
    await withTempFile(`const a = 1;\n`, '.js', async (fileA) => {
      await withTempFile(`{"v":"1.0.0"}`, '.json', async (fileB) => {
        const r = await applyEditsMultiFile([
          { file: fileA, oldText: 'const a = 1', newText: 'const a = 99' },
          { file: fileB, oldText: '"1.0.0"', newText: '"2.0.0"' },
        ], { dryRun: true });
        assert(r.ok);
        assert(r.dryRun);
        const aAfter = await fsp.readFile(fileA, 'utf8');
        const bAfter = await fsp.readFile(fileB, 'utf8');
        assertEq(aAfter, 'const a = 1;\n');
        assertEq(bAfter, '{"v":"1.0.0"}');
      });
    });
  });

  console.log('\n== validateEditAgainstContents (no I/O) ==');

  await test('returns canApply=true for unique match', () => {
    const r = validateEditAgainstContents(
      { file: 'x.js', oldText: 'foo', newText: 'bar' },
      'let foo = 1;\n'
    );
    assert(r.canApply, JSON.stringify(r));
  });

  await test('returns canApply=false with match count for duplicates', () => {
    const r = validateEditAgainstContents(
      { file: 'x.js', oldText: 'foo', newText: 'bar' },
      'foo foo foo\n'
    );
    assertEq(r.canApply, false);
    assertEq(r.matchCount, 3);
  });

  console.log('\n== Regression: the ::token:: bug as an atomic edit ==');

  await test('::token:: strip removal as a realistic surgical edit', async () => {
    // Simulates the EXACT fix we made manually yesterday: removing the 3-line
    // block from design-step's _resolveApiKey. Verifies the Edit primitive
    // handles the case cleanly.
    const original = `
class Foo {
  async _resolveApiKey() {
    let auth = this.data.auth;
    if (!auth) return null;

    // Strip Edison's "::token::<label>" suffix — storage.get needs the bare UUID
    if (typeof auth === 'string' && auth.includes('::')) {
      auth = auth.split('::')[0];
    }
    auth = String(auth).replace(/^\`|\`$/g, '').trim();
    if (!auth) return null;
    return auth;
  }
}
module.exports = Foo;
`;
    await withTempFile(original, '.js', async (file) => {
      const r = await applyEdit({
        file,
        oldText:
`    // Strip Edison's "::token::<label>" suffix — storage.get needs the bare UUID
    if (typeof auth === 'string' && auth.includes('::')) {
      auth = auth.split('::')[0];
    }
`,
        newText: '',
        rationale: 'Vault stores credential under full id; strip caused storage.get to miss.',
      });
      assert(r.ok, 'surgical edit should apply: ' + JSON.stringify(r));
      const after = await fsp.readFile(file, 'utf8');
      assert(!after.includes("split('::')"), 'strip line removed');
      assert(after.includes("String(auth).replace"), 'surrounding code preserved');
    });
  });

  console.log('\n---');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
