// test/agentLoop.test.js — exercise the agent loop with a mock LLM.
//
// We override the fetch() call by stubbing ./llmClient's callAnthropicConversation
// via require cache manipulation. Simpler than mocking HTTP.

'use strict';

const Module = require('module');
const originalResolve = Module._resolve_filename || Module._resolveFilename;

// Mock callAnthropicConversation before loading agentLoop.
const scriptedResponses = [];
let apiCallCount = 0;
function mockCallConvo(args) {
  apiCallCount++;
  if (scriptedResponses.length === 0) {
    return Promise.resolve({ ok: false, error: 'mock: no more scripted responses' });
  }
  return Promise.resolve(scriptedResponses.shift());
}

// Patch the module cache before requiring agentLoop.
const realClient = require('../lib/llmClient');
const patchedClient = Object.assign({}, realClient, { callAnthropicConversation: mockCallConvo });
require.cache[require.resolve('../lib/llmClient')].exports = patchedClient;

const { runAgentLoop } = require('../lib/agentLoop');

let passed = 0, failed = 0;
async function test(name, fn) {
  try {
    apiCallCount = 0;
    scriptedResponses.length = 0;
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Helper: script a tool-use response.
function scriptToolUse(toolName, input, id = 'tu_' + Math.random().toString(36).slice(2, 8)) {
  scriptedResponses.push({
    ok: true,
    stopReason: 'tool_use',
    assistantMessage: { role: 'assistant', content: [{ type: 'tool_use', id, name: toolName, input }] },
    usage: { input_tokens: 100, output_tokens: 50 },
  });
}
function scriptEndTurn(text = 'Done.') {
  scriptedResponses.push({
    ok: true,
    stopReason: 'end_turn',
    assistantMessage: { role: 'assistant', content: [{ type: 'text', text }] },
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}

(async () => {
  console.log('\n== runAgentLoop — happy paths ==');

  await test('single inner call, no tool use, terminator says done', async () => {
    scriptEndTurn('Nothing to do.');
    const r = await runAgentLoop({
      systemPrompt: 'You are a helper.',
      initialUser: 'Hello.',
      terminator: async () => ({ done: true }),
      opts: { apiKey: 'fake', maxOuter: 2, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, true);
    assertEq(r.outerIterations, 1);
    assertEq(r.innerIterationsByOuter[0], 1);
    assertEq(apiCallCount, 1);
  });

  await test('one tool_use → apply → end_turn → terminator done', async () => {
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'create', path: 'handler.js', file_text: 'exports.handler = async () => ({});',
    });
    scriptEndTurn();
    const r = await runAgentLoop({
      systemPrompt: 'Write a handler.',
      initialUser: 'Create handler.js',
      terminator: async (files) => ({ done: 'handler.js' in files }),
      opts: { apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, true);
    assertEq(r.files['handler.js'], 'exports.handler = async () => ({});');
    assertEq(apiCallCount, 2); // tool_use turn + end_turn turn
  });

  await test('two sequential tool_uses before end_turn', async () => {
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'create', path: 'a.js', file_text: 'const a = 1;',
    });
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'create', path: 'b.js', file_text: 'const b = 2;',
    });
    scriptEndTurn();
    const r = await runAgentLoop({
      systemPrompt: 'Write.',
      initialUser: 'Write.',
      terminator: async (files) => ({ done: 'a.js' in files && 'b.js' in files }),
      opts: { apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, true);
    assertEq(r.files['a.js'], 'const a = 1;');
    assertEq(r.files['b.js'], 'const b = 2;');
  });

  await test('outer loop: test fails → retry → passes', async () => {
    // Outer iter 1: create file, end_turn → tests fail
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'create', path: 'h.js', file_text: 'return 1;',
    });
    scriptEndTurn();
    // Outer iter 2: str_replace, end_turn → tests pass
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'str_replace', path: 'h.js', old_str: 'return 1;', new_str: 'return 42;',
    });
    scriptEndTurn();

    let terminatorCalls = 0;
    const terminator = async (files) => {
      terminatorCalls++;
      const pass = (files['h.js'] || '').includes('42');
      return pass ? { done: true } : { done: false, message: 'Tests failed: expected return 42, got return 1' };
    };
    const r = await runAgentLoop({
      systemPrompt: 'Code.',
      initialUser: 'Make h.js return 42.',
      terminator,
      opts: { apiKey: 'fake', maxOuter: 3, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, true);
    assertEq(r.outerIterations, 2);
    assertEq(terminatorCalls, 2);
  });

  console.log('\n== runAgentLoop — failure paths ==');

  await test('outer budget exhausted → ok:false', async () => {
    // Outer 1, 2, 3 — all end_turn with no edits.
    for (let i = 0; i < 3; i++) scriptEndTurn();
    const r = await runAgentLoop({
      systemPrompt: 'Code.',
      initialUser: 'Make tests pass.',
      terminator: async () => ({ done: false, message: 'fail' }),
      opts: { apiKey: 'fake', maxOuter: 3, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, false);
    assert(/budget/.test(r.error));
    assertEq(r.outerIterations, 3);
  });

  await test('inner budget exhausted in one outer iteration', async () => {
    // 5 tool_use calls in a row, then we hit maxInner=5.
    for (let i = 0; i < 5; i++) {
      scriptToolUse('str_replace_based_edit_tool', {
        command: 'view', path: 'nonexistent.js',
      });
    }
    const r = await runAgentLoop({
      systemPrompt: 'Code.',
      initialUser: 'Do thing.',
      terminator: async () => ({ done: true }),  // terminator will say done anyway
      opts: { apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {} },
    });
    // Terminator returns done=true at outer boundary → success despite inner cap.
    assertEq(r.ok, true);
    assertEq(r.innerIterationsByOuter[0], 5);
  });

  await test('tool error is passed back as tool_result with is_error', async () => {
    // str_replace that can't find old_str
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'str_replace', path: 'missing.js', old_str: 'x', new_str: 'y',
    });
    scriptEndTurn('OK, retrying.');
    const r = await runAgentLoop({
      systemPrompt: 'Code.',
      initialUser: 'Try.',
      terminator: async () => ({ done: true }),
      opts: { apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {} },
    });
    assertEq(r.ok, true);
    // Check the user turn after tool_use had is_error:true
    const userAfterTool = r.messages.find((m, i) => {
      if (m.role !== 'user' || i === 0) return false;
      return Array.isArray(m.content) && m.content.some((c) => c.type === 'tool_result' && c.is_error);
    });
    assert(userAfterTool, 'should have a user message with a tool_result is_error:true');
  });

  await test('aborted signal returns ok:false quickly', async () => {
    scriptEndTurn();
    const ac = new AbortController();
    ac.abort();
    const r = await runAgentLoop({
      systemPrompt: 'x',
      initialUser: 'x',
      terminator: async () => ({ done: true }),
      opts: { apiKey: 'fake', maxOuter: 5, maxInner: 5, abortSignal: ac.signal, log: () => {} },
    });
    assertEq(r.ok, false);
    assert(/abort/.test(r.error || ''));
  });

  console.log('\n== runAgentLoop — message ordering invariants ==');

  await test('assistant message appended BEFORE tool_result user message', async () => {
    scriptToolUse('str_replace_based_edit_tool', {
      command: 'create', path: 'a.js', file_text: 'x',
    });
    scriptEndTurn();
    const r = await runAgentLoop({
      systemPrompt: 'x',
      initialUser: 'x',
      terminator: async () => ({ done: true }),
      opts: { apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {} },
    });
    // messages: [user initial, assistant(tool_use), user(tool_result), assistant(end_turn)]
    assertEq(r.messages[0].role, 'user');
    assertEq(r.messages[1].role, 'assistant');
    assert(r.messages[1].content.some((c) => c.type === 'tool_use'), 'msg[1] has tool_use');
    assertEq(r.messages[2].role, 'user');
    assert(r.messages[2].content.some((c) => c.type === 'tool_result'), 'msg[2] has tool_result');
  });

  console.log('\n== runAgentLoop — custom tool support ==');

  await test('custom tool handler is invoked', async () => {
    scriptToolUse('run_tests', { reason: 'checking' });
    scriptEndTurn();
    let customCalled = false;
    const r = await runAgentLoop({
      systemPrompt: 'x',
      initialUser: 'run tests',
      terminator: async () => ({ done: true }),
      opts: {
        apiKey: 'fake', maxOuter: 1, maxInner: 5, log: () => {},
        tools: [{ name: 'run_tests', description: 'Run tests', input_schema: { type: 'object', properties: { reason: { type: 'string' } } } }],
        customTools: {
          run_tests: async (input) => {
            customCalled = true;
            return { output: `Tests ran with reason: ${input.reason}`, is_error: false };
          },
        },
      },
    });
    assertEq(r.ok, true);
    assert(customCalled, 'custom tool should have been invoked');
  });

  console.log('\n---');
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
