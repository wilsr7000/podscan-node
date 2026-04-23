// test/textEditorTool.test.js — exercise every command + error path.

'use strict';

const { dispatchTool, _internal } = require('../lib/textEditorTool');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

console.log('\n== view ==');

test('view returns content with line numbers', () => {
  const r = dispatchTool({ command: 'view', path: 'a.js' }, { files: { 'a.js': 'line1\nline2\nline3' } });
  assertEq(r.is_error, false);
  assert(r.output.includes('1: line1'), 'line 1 prefix');
  assert(r.output.includes('2: line2'), 'line 2 prefix');
  assert(r.output.includes('3: line3'), 'line 3 prefix');
});

test('view with view_range returns slice only', () => {
  const r = dispatchTool({ command: 'view', path: 'a.js', view_range: [2, 3] }, { files: { 'a.js': 'line1\nline2\nline3\nline4' } });
  assert(r.output.includes('line2') && r.output.includes('line3'));
  assert(!r.output.includes('line1'));
  assert(!r.output.includes('line4'));
});

test('view on missing file returns is_error', () => {
  const r = dispatchTool({ command: 'view', path: 'missing.js' }, { files: {} });
  assertEq(r.is_error, true);
  assert(r.output.includes('does not exist'));
});

console.log('\n== create ==');

test('create adds new file', () => {
  const r = dispatchTool({ command: 'create', path: 'a.js', file_text: 'const x = 1;' }, { files: {} });
  assertEq(r.is_error, false);
  assertEq(r.files['a.js'], 'const x = 1;');
});

test('create on existing path returns is_error', () => {
  const r = dispatchTool({ command: 'create', path: 'a.js', file_text: 'x' }, { files: { 'a.js': 'existing' } });
  assertEq(r.is_error, true);
  assert(r.output.includes('already exists'));
});

console.log('\n== str_replace ==');

test('str_replace: unique match succeeds', () => {
  const r = dispatchTool({ command: 'str_replace', path: 'a.js', old_str: 'return 1', new_str: 'return 2' },
    { files: { 'a.js': 'function f() { return 1; }' } });
  assertEq(r.is_error, false);
  assertEq(r.files['a.js'], 'function f() { return 2; }');
});

test('str_replace: 0 matches returns is_error', () => {
  const r = dispatchTool({ command: 'str_replace', path: 'a.js', old_str: 'NOPE', new_str: 'x' },
    { files: { 'a.js': 'hello' } });
  assertEq(r.is_error, true);
  assert(r.output.includes('not found'));
});

test('str_replace: multiple matches returns is_error with count', () => {
  const r = dispatchTool({ command: 'str_replace', path: 'a.js', old_str: 'x', new_str: 'y' },
    { files: { 'a.js': 'x x x' } });
  assertEq(r.is_error, true);
  assert(r.output.includes('3 times') || r.output.includes('3 occurrences'), 'should mention count');
});

test('str_replace: preserves other files in dict', () => {
  const r = dispatchTool({ command: 'str_replace', path: 'a.js', old_str: 'foo', new_str: 'bar' },
    { files: { 'a.js': 'foo', 'b.js': 'unchanged' } });
  assertEq(r.files['b.js'], 'unchanged', 'b.js left alone');
  assertEq(r.files['a.js'], 'bar', 'a.js updated');
});

console.log('\n== insert ==');

test('insert at line 0 prepends', () => {
  const r = dispatchTool({ command: 'insert', path: 'a.js', insert_line: 0, new_str: 'PREPEND' },
    { files: { 'a.js': 'existing\ncontent' } });
  assertEq(r.is_error, false);
  assert(r.files['a.js'].startsWith('PREPEND\nexisting'));
});

test('insert after last line appends', () => {
  const files = { 'a.js': 'line1\nline2' };
  const r = dispatchTool({ command: 'insert', path: 'a.js', insert_line: 2, new_str: 'END' }, { files });
  assertEq(r.is_error, false);
  assert(r.files['a.js'].endsWith('END'), 'ends with END: ' + JSON.stringify(r.files['a.js']));
});

test('insert beyond file length returns is_error', () => {
  const r = dispatchTool({ command: 'insert', path: 'a.js', insert_line: 99, new_str: 'x' },
    { files: { 'a.js': 'short' } });
  assertEq(r.is_error, true);
  assert(r.output.includes('exceeds'));
});

console.log('\n== undo_edit ==');

test('undo_edit rolls back last str_replace', () => {
  let state = { files: { 'a.js': 'original text here' }, undoStack: {} };
  state = dispatchTool({ command: 'str_replace', path: 'a.js', old_str: 'original', new_str: 'modified' }, state);
  assertEq(state.files['a.js'], 'modified text here');
  const r = dispatchTool({ command: 'undo_edit', path: 'a.js' }, state);
  assertEq(r.is_error, false);
  assertEq(r.files['a.js'], 'original text here');
});

test('undo_edit removes a created file', () => {
  let state = { files: {}, undoStack: {} };
  state = dispatchTool({ command: 'create', path: 'new.js', file_text: 'content' }, state);
  assertEq(state.files['new.js'], 'content');
  const r = dispatchTool({ command: 'undo_edit', path: 'new.js' }, state);
  assert(!('new.js' in r.files), 'file should be gone after undoing create');
});

test('undo_edit with no prior edit returns is_error', () => {
  const r = dispatchTool({ command: 'undo_edit', path: 'untouched.js' }, { files: {}, undoStack: {} });
  assertEq(r.is_error, true);
});

console.log('\n== security / path validation ==');

test('rejects path with ".."', () => {
  const r = dispatchTool({ command: 'view', path: '../secret.txt' }, { files: {} });
  assertEq(r.is_error, true);
  assert(r.output.includes('..'));
});

test('rejects absolute path', () => {
  const r = dispatchTool({ command: 'view', path: '/etc/passwd' }, { files: {} });
  assertEq(r.is_error, true);
});

test('enforces pathAllowlist when provided', () => {
  const r = dispatchTool({ command: 'view', path: 'disallowed.js' },
    { files: { 'disallowed.js': 'x' }, pathAllowlist: ['allowed.js'] });
  assertEq(r.is_error, true);
  assert(r.output.includes('not in allowlist'));
});

test('unknown command returns is_error', () => {
  const r = dispatchTool({ command: 'rm_rf', path: 'a.js' }, { files: {} });
  assertEq(r.is_error, true);
  assert(r.output.includes('unknown command'));
});

console.log('\n== integration: multi-edit sequence ==');

test('sequence of create → view → str_replace → view works', () => {
  let state = { files: {}, undoStack: {} };
  state = dispatchTool({ command: 'create', path: 'handler.js', file_text: 'exports.handler = async () => { return { statusCode: 200 }; };' }, state);
  assertEq(state.is_error, false);
  const viewRes = dispatchTool({ command: 'view', path: 'handler.js' }, state);
  assert(viewRes.output.includes('statusCode: 200'));
  const repRes = dispatchTool({ command: 'str_replace', path: 'handler.js', old_str: '200', new_str: '201' }, state);
  assertEq(repRes.is_error, false);
  // Note: repRes.files === state.files was handled immutably; update state
  state = repRes;
  const viewRes2 = dispatchTool({ command: 'view', path: 'handler.js' }, state);
  assert(viewRes2.output.includes('statusCode: 201'));
});

console.log('\n---');
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
