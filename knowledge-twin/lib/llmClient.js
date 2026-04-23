// ---------------------------------------------------------------------------
// llmClient — Anthropic Messages API wrapper with:
//   - Direct single-turn calls (callAnthropicDirect — legacy shape)
//   - Conversational turns with tool use (callAnthropicConversation)
//   - Prompt caching via cache_control breakpoints on stable prefixes
//   - text_editor_20250728 trained tool support (+ custom tools)
//
// The conversational + tool-use + caching combo is what the agent loop
// (lib/agentLoop.js) uses. Single-turn callers keep working unchanged.
// ---------------------------------------------------------------------------

'use strict';

const DEFAULT_MODEL = 'claude-sonnet-4-20250514';
// Models that support `thinking: { type: 'adaptive' }` (older Opus/Sonnet 4.x).
// Newer 4.5/4.6 models take `thinking: { type: 'enabled', budget_tokens: N }` instead.
const ADAPTIVE_THINKING_MODELS = ['claude-opus-4-5', 'claude-opus-4-6', 'claude-sonnet-4-6'];
const ENABLED_THINKING_MODELS = ['claude-sonnet-4-5', 'claude-opus-4-7'];
function thinkingConfigFor(model) {
  if (ADAPTIVE_THINKING_MODELS.some((m) => model.startsWith(m))) return { type: 'adaptive' };
  if (ENABLED_THINKING_MODELS.some((m) => model.startsWith(m))) return { type: 'enabled', budget_tokens: 8000 };
  return null;
}
const API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_VERSION = '2023-06-01';

// ---------------------------------------------------------------------------
// Key + availability
// ---------------------------------------------------------------------------
function getApiKey() {
  const key = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
  return key.replace(/[\r\n].*/s, '').trim();
}

function hasApiKey() {
  return getApiKey().startsWith('sk-ant-');
}

// ---------------------------------------------------------------------------
// Normalize a system prompt into a list of content blocks so we can attach
// cache_control to stable blocks. Accepts a string OR an array of blocks.
//
// Per Anthropic caching guidance: put cache_control on the LAST block of the
// stable prefix. Minimum 1024 tokens per block for caching to apply.
// ---------------------------------------------------------------------------
function normalizeSystem(system, opts = {}) {
  if (!system) return undefined;
  if (Array.isArray(system)) return system;
  if (typeof system === 'string') {
    const block = { type: 'text', text: system };
    // Default: cache the entire system prompt with 1-hour TTL unless caller disables.
    if (opts.cacheSystem !== false) {
      block.cache_control = { type: 'ephemeral', ttl: opts.cacheTtl || '1h' };
    }
    return [block];
  }
  return [system];
}

// ---------------------------------------------------------------------------
// callAnthropicDirect — single-turn, back-compat with the old signature.
//
// Still used by non-agent code. Now adds cache_control on the system block
// by default to reap the 90% cache-read discount on stable prompts.
// ---------------------------------------------------------------------------
async function callAnthropicDirect(apiKey, systemPrompt, userContent, opts = {}) {
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || 4096;
  const startMs = Date.now();

  const thinkingCfg = thinkingConfigFor(model);
  const useThinking = !!thinkingCfg;
  const reqBody = {
    model,
    system: normalizeSystem(systemPrompt, opts),
    messages: [{ role: 'user', content: userContent }],
    max_tokens: useThinking ? 16000 : maxTokens,
  };

  if (useThinking) {
    reqBody.thinking = thinkingCfg;
    // Anthropic requires temperature=1 when thinking is enabled.
    reqBody.temperature = 1;
  } else {
    reqBody.temperature = opts.temperature ?? 0.2;
  }

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': DEFAULT_VERSION,
      ...(opts.betaHeaders ? { 'anthropic-beta': opts.betaHeaders } : {}),
    },
    body: JSON.stringify(reqBody),
    signal: typeof AbortSignal.timeout === 'function'
      ? AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT_MS)
      : undefined,
  });

  const durationMs = Date.now() - startMs;

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    return {
      error: `Anthropic API returned ${resp.status}`,
      raw: errBody.slice(0, 500),
      durationMs,
      model,
    };
  }

  const data = await resp.json();
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  const content = textBlock ? textBlock.text : '';

  let parsed = null;
  try {
    const m = content.match(/\{[\s\S]*\}/);
    if (m) parsed = JSON.parse(m[0]);
  } catch { /* not JSON */ }

  return {
    parsed,
    raw: content,
    model: data.model || model,
    stopReason: data.stop_reason,
    durationMs,
    usage: data.usage || null,
    // full response exposed for agent loop to append to messages
    assistantMessage: { role: 'assistant', content: data.content || [] },
  };
}

// ---------------------------------------------------------------------------
// callAnthropicConversation — multi-turn with tools + caching.
//
// Input:
//   apiKey         — string
//   system         — string | content-block[] (cache_control auto-added if string)
//   messages       — array of {role, content} turns to send
//   tools          — array of tool specs (e.g. text_editor_20250728)
//   opts           — { model, maxTokens, temperature, timeout, betaHeaders, cacheSystem, cacheTtl }
//
// Output:
//   { ok, stopReason, assistantMessage, usage, model, durationMs, error? }
//
// Critically: the caller is responsible for appending `assistantMessage`
// to the conversation BEFORE executing any tool calls in it. See
// lib/agentLoop.js for the canonical order.
// ---------------------------------------------------------------------------
async function callAnthropicConversation({ apiKey, system, messages, tools, opts = {} } = {}) {
  if (!apiKey) apiKey = getApiKey();
  if (!apiKey) return { ok: false, error: 'no Anthropic API key available' };
  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: 'messages must be a non-empty array' };

  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.maxTokens || 8192;
  const startMs = Date.now();

  const thinkingCfg = thinkingConfigFor(model);
  const useThinking = !!thinkingCfg;

  const reqBody = {
    model,
    messages,
    max_tokens: useThinking ? 16000 : maxTokens,
  };
  if (system) reqBody.system = normalizeSystem(system, opts);
  if (Array.isArray(tools) && tools.length > 0) reqBody.tools = tools;
  if (opts.toolChoice) reqBody.tool_choice = opts.toolChoice;

  if (useThinking) {
    reqBody.thinking = thinkingCfg;
    // Anthropic requires temperature=1 when thinking is enabled.
    reqBody.temperature = 1;
  } else {
    reqBody.temperature = opts.temperature ?? 0.2;
  }

  let resp;
  try {
    resp = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': DEFAULT_VERSION,
        ...(opts.betaHeaders ? { 'anthropic-beta': opts.betaHeaders } : {}),
      },
      body: JSON.stringify(reqBody),
      signal: typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(opts.timeout || DEFAULT_TIMEOUT_MS)
        : undefined,
    });
  } catch (err) {
    return { ok: false, error: `fetch threw: ${err.message}`, durationMs: Date.now() - startMs };
  }

  const durationMs = Date.now() - startMs;

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    return {
      ok: false,
      error: `Anthropic API ${resp.status}`,
      raw: errBody.slice(0, 1000),
      durationMs,
      model,
    };
  }

  const data = await resp.json();
  return {
    ok: true,
    stopReason: data.stop_reason,
    assistantMessage: { role: 'assistant', content: data.content || [] },
    model: data.model || model,
    usage: data.usage || null,
    durationMs,
  };
}

// ---------------------------------------------------------------------------
// createCallLLM — backward-compat factory. Same signature as before.
// ---------------------------------------------------------------------------
function createCallLLM(apiKey, opts = {}) {
  const resolvedKey = apiKey || getApiKey();
  const model = opts.model || DEFAULT_MODEL;

  return async function callLLM(prompt, callOpts = {}) {
    const isJsonMode = callOpts.json;
    const systemPrompt = callOpts.systemPrompt || 'You are an expert Edison flow architect.';

    const result = await callAnthropicDirect(resolvedKey, systemPrompt, prompt, {
      model: callOpts.model || model,
      maxTokens: callOpts.maxTokens || (isJsonMode ? 8192 : 4096),
      cacheSystem: callOpts.cacheSystem,
      cacheTtl: callOpts.cacheTtl,
    });

    if (result.error) {
      throw new Error(`LLM call failed: ${result.error}`);
    }

    if (isJsonMode && result.parsed) {
      return result.parsed;
    }

    return result.raw;
  };
}

// ---------------------------------------------------------------------------
// Trained-tool specs (exported for agent-loop callers to import directly).
//
// Claude knows the shapes of these tools natively — we only implement the
// dispatchers (lib/textEditorTool.js).
// ---------------------------------------------------------------------------
const TRAINED_TOOLS = {
  TEXT_EDITOR: {
    type: 'text_editor_20250728',
    name: 'str_replace_based_edit_tool',
    // max_characters cap (per Anthropic docs) — tool_result that exceeds this
    // is automatically truncated by Claude to keep context manageable.
    max_characters: 12000,
  },
};

module.exports = {
  callAnthropicDirect,
  callAnthropicConversation,
  createCallLLM,
  getApiKey,
  hasApiKey,
  normalizeSystem,
  DEFAULT_MODEL,
  TRAINED_TOOLS,
};
