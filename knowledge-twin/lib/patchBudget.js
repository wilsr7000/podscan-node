// ---------------------------------------------------------------------------
// patchBudget.js — budget enforcement for patch sessions.
//
// A patch session is a contiguous attempt to resolve one or more defects in
// one or more files. Budgets prevent runaway LLM calls and infinite-loop
// patch cycles.
//
// Limits (all optional, sensible defaults):
//   maxEdits          — total number of edits applied across the session
//   maxLLMAttempts    — total number of proposeLLMEdits calls
//   maxTotalMs        — wall-clock time ceiling
//   maxFilesMutated   — different files touched
//   maxEditsPerFile   — per-file cap
//
// Exit modes:
//   'within-budget'   — everything applied, no escalation needed
//   'budget-exceeded' — caller should escalate (human review, retry with
//                       wider context, or abort)
//
// Usage:
//   const { createBudget } = require('./patchBudget');
//   const budget = createBudget({ maxEdits: 5, maxLLMAttempts: 3 });
//
//   for (const edit of proposedEdits) {
//     const check = budget.check('edit', { file: edit.file });
//     if (!check.ok) { escalate(check.reason); break; }
//     await applyEdit(edit);
//     budget.record('edit', { file: edit.file });
//   }
// ---------------------------------------------------------------------------

'use strict';

const DEFAULTS = {
  maxEdits: 10,
  maxLLMAttempts: 5,
  maxTotalMs: 60_000,
  maxFilesMutated: 5,
  maxEditsPerFile: 5,
};

function createBudget(limits = {}) {
  const cap = { ...DEFAULTS, ...limits };
  const state = {
    editsApplied: 0,
    llmAttempts: 0,
    startMs: Date.now(),
    filesMutated: new Map(),  // file → edit count
  };

  function elapsedMs() { return Date.now() - state.startMs; }

  function check(kind, meta = {}) {
    if (elapsedMs() > cap.maxTotalMs) {
      return { ok: false, reason: 'maxTotalMs', elapsed: elapsedMs(), cap: cap.maxTotalMs };
    }
    if (kind === 'edit') {
      if (state.editsApplied >= cap.maxEdits) {
        return { ok: false, reason: 'maxEdits', applied: state.editsApplied, cap: cap.maxEdits };
      }
      if (meta.file) {
        const count = state.filesMutated.get(meta.file) || 0;
        if (count >= cap.maxEditsPerFile) {
          return { ok: false, reason: 'maxEditsPerFile', file: meta.file, count, cap: cap.maxEditsPerFile };
        }
        if (!state.filesMutated.has(meta.file) && state.filesMutated.size >= cap.maxFilesMutated) {
          return { ok: false, reason: 'maxFilesMutated', cap: cap.maxFilesMutated };
        }
      }
    }
    if (kind === 'llm') {
      if (state.llmAttempts >= cap.maxLLMAttempts) {
        return { ok: false, reason: 'maxLLMAttempts', attempts: state.llmAttempts, cap: cap.maxLLMAttempts };
      }
    }
    return { ok: true };
  }

  function record(kind, meta = {}) {
    if (kind === 'edit') {
      state.editsApplied++;
      if (meta.file) {
        state.filesMutated.set(meta.file, (state.filesMutated.get(meta.file) || 0) + 1);
      }
    } else if (kind === 'llm') {
      state.llmAttempts++;
    }
  }

  function snapshot() {
    return {
      editsApplied: state.editsApplied,
      llmAttempts: state.llmAttempts,
      elapsedMs: elapsedMs(),
      filesMutated: state.filesMutated.size,
      cap,
    };
  }

  function exhausted() {
    return state.editsApplied >= cap.maxEdits
      || state.llmAttempts >= cap.maxLLMAttempts
      || elapsedMs() >= cap.maxTotalMs;
  }

  return { check, record, snapshot, exhausted, elapsedMs };
}

module.exports = { createBudget, DEFAULTS };
