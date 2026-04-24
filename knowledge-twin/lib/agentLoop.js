// ---------------------------------------------------------------------------
// agentLoop.js — Claude-driven inner loop with tool execution + test
// feedback.
//
// This is the canonical "LLM writes code by calling tools" loop. Matches the
// pattern Anthropic describes for agent-style generation. See docs:
// https://docs.anthropic.com/en/docs/build-with-claude/agents
//
// Shape (from the reference sketch in our planning discussion):
//
//   for outer in maxOuter:              # test-fail → retry budget
//     for inner in maxInner:             # tool-use turns within one attempt
//       response = claude(messages, tools)
//       append assistant message
//       if stop_reason != "tool_use": break
//       execute every tool_use block against in-memory state
//       append user message with tool_results
//     if terminator(files): return success
//     append user message describing terminator failure, loop
//
// The critical invariant is the message ordering — caller MUST never append
// tool_results before the corresponding assistant tool_use message.
//
// The tool execution dispatches to `lib/textEditorTool.js` for the trained
// text_editor_20250728 tool. Additional custom tools can be registered via
// the `customTools` option (map of tool-name → handler(input, state)).
// ---------------------------------------------------------------------------

'use strict';

const { callAnthropicConversation, TRAINED_TOOLS } = require('./llmClient');
const { dispatchTool } = require('./textEditorTool');

// Default tool set: just the trained text editor.
const DEFAULT_TOOLS = [TRAINED_TOOLS.TEXT_EDITOR];

// ---------------------------------------------------------------------------
// runAgentLoop — the main entry point.
//
// Inputs:
//   systemPrompt   — string (will be auto-cached with 1h TTL)
//   initialUser    — string: the first user message describing the task
//   initialFiles   — {path: content, ...} starting state (often {})
//   terminator     — async (files) => { done, message?, observation? }
//                    Called after each inner-loop exit. If done=true, loop
//                    ends successfully with observation. If done=false,
//                    `message` is appended as a new user turn and the outer
//                    loop continues. Typical implementation: run tests or
//                    validator; on pass return done=true; on fail return
//                    done=false + the failure output.
//   opts           — { model, apiKey, maxOuter=4, maxInner=20, tools,
//                      pathAllowlist, customTools, log, abortSignal,
//                      cacheSystem, cacheTtl }
//
// Output:
//   {
//     ok: bool,
//     files: { ... },
//     messages: [ ... ] — full conversation for debugging
//     outerIterations, innerIterationsByOuter,
//     lastTerminatorResult,
//     error?: string,
//     totalUsage: { input_tokens, output_tokens, cache_*, ... },
//     totalMs,
//   }
// ---------------------------------------------------------------------------
async function runAgentLoop({
  systemPrompt,
  initialUser,
  initialFiles = {},
  terminator,
  opts = {},
} = {}) {
  const {
    apiKey,
    model,
    maxOuter = 4,
    maxInner = 20,
    tools = DEFAULT_TOOLS,
    pathAllowlist,
    customTools = {},
    log = () => {},
    abortSignal,
    cacheSystem = true,
    cacheTtl = '1h',
    temperature,
  } = opts;

  if (typeof terminator !== 'function') throw new Error('runAgentLoop: terminator is required');
  if (typeof systemPrompt !== 'string') throw new Error('runAgentLoop: systemPrompt must be a string');
  if (typeof initialUser !== 'string') throw new Error('runAgentLoop: initialUser must be a string');

  const startMs = Date.now();
  const messages = [{ role: 'user', content: initialUser }];
  let state = { files: { ...initialFiles }, undoStack: {}, pathAllowlist };

  const innerIterationsByOuter = [];
  const totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let lastTerminatorResult = null;
  let lastError = null;

  for (let outer = 0; outer < maxOuter; outer++) {
    log(`[agentLoop] outer iteration ${outer + 1}/${maxOuter}`);
    let innerCount = 0;
    let innerLimitHit = false;

    // INNER LOOP: Claude writes/edits until no more tool calls.
    for (let inner = 0; inner < maxInner; inner++) {
      if (abortSignal?.aborted) {
        return _finalize({ ok: false, error: 'aborted', state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs });
      }
      innerCount = inner + 1;

      const callRes = await callAnthropicConversation({
        apiKey,
        system: systemPrompt,
        messages,
        tools,
        opts: { model, temperature, cacheSystem, cacheTtl },
      });

      if (!callRes.ok) {
        lastError = callRes.error || 'unknown LLM call failure';
        log(`[agentLoop] LLM call failed: ${lastError}`);
        return _finalize({ ok: false, error: lastError, state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs });
      }

      // Merge usage
      if (callRes.usage) {
        for (const k of Object.keys(totalUsage)) {
          if (typeof callRes.usage[k] === 'number') totalUsage[k] += callRes.usage[k];
        }
      }

      // CRITICAL: append assistant message BEFORE executing tools.
      messages.push(callRes.assistantMessage);

      if (callRes.stopReason !== 'tool_use') {
        log(`[agentLoop] inner ${inner + 1}: stop_reason="${callRes.stopReason}" — Claude done with tools`);
        break;
      }

      // Execute every tool_use block, collect tool_results for the next user turn.
      const toolResults = [];
      for (const block of (callRes.assistantMessage.content || [])) {
        if (block.type !== 'tool_use') continue;
        let result;
        try {
          if (block.name === TRAINED_TOOLS.TEXT_EDITOR.name) {
            const dispatchRes = dispatchTool(block.input, state);
            state = { ...state, files: dispatchRes.files, undoStack: dispatchRes.undoStack };
            result = { content: dispatchRes.output, is_error: dispatchRes.is_error };
          } else if (customTools[block.name]) {
            const customRes = await customTools[block.name](block.input, state);
            // Custom tools may return a new state or just {output, is_error}.
            if (customRes && typeof customRes === 'object') {
              if (customRes.state) state = customRes.state;
              result = { content: String(customRes.output ?? ''), is_error: !!customRes.is_error };
            } else {
              result = { content: String(customRes ?? ''), is_error: false };
            }
          } else {
            result = { content: `Error: unknown tool "${block.name}"`, is_error: true };
          }
        } catch (err) {
          result = { content: `Tool execution threw: ${err.message}`, is_error: true };
        }
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: result.content,
          is_error: result.is_error,
        });
        log(`[agentLoop]   tool=${block.name} cmd=${block.input?.command || '?'} path=${block.input?.path || '?'} ${result.is_error ? 'ERROR' : 'ok'}`);
      }

      messages.push({ role: 'user', content: toolResults });

      if (inner + 1 === maxInner) {
        innerLimitHit = true;
        log(`[agentLoop] inner-loop limit ${maxInner} reached; bailing to terminator check`);
      }
    }

    innerIterationsByOuter.push(innerCount);

    // OUTER LOOP: let the caller decide if we're done (e.g. tests pass).
    let termRes;
    try {
      termRes = await terminator(state.files, { outerIteration: outer, messages });
    } catch (err) {
      lastTerminatorResult = { done: false, message: `terminator threw: ${err.message}` };
      lastError = `terminator threw: ${err.message}`;
      return _finalize({ ok: false, error: lastError, state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs });
    }
    lastTerminatorResult = termRes;

    if (termRes?.done) {
      log(`[agentLoop] terminator reports done on outer ${outer + 1}`);
      return _finalize({ ok: true, state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs });
    }

    // Not done — feed the terminator's message back as a user turn and loop.
    const feedback = termRes?.message || 'The tests failed. Please fix the code and I will re-run them.';
    log(`[agentLoop] terminator not done: ${String(feedback).slice(0, 100)}`);
    messages.push({ role: 'user', content: feedback });

    if (innerLimitHit && outer + 1 === maxOuter) {
      lastError = `inner + outer budget both exhausted without done=true`;
    }
  }

  return _finalize({
    ok: false,
    error: lastError || `outer-loop budget ${maxOuter} exhausted without terminator success`,
    state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs,
  });
}

function _finalize({ ok, error, state, messages, innerIterationsByOuter, lastTerminatorResult, totalUsage, startMs }) {
  return {
    ok,
    error,
    files: state.files,
    messages,
    outerIterations: innerIterationsByOuter.length,
    innerIterationsByOuter,
    lastTerminatorResult,
    totalUsage,
    totalMs: Date.now() - startMs,
  };
}

module.exports = {
  runAgentLoop,
  DEFAULT_TOOLS,
};
