// ---------------------------------------------------------------------------
// diagLocation.js — helpers for producing and normalizing location-rich
// validator diagnostics.
//
// Today the validator emits a `context` field with ad-hoc shape (some rules
// put `{line: num, url: ...}`, others put `{line: num, model: ...}`, some
// put nothing). Downstream patchers want a STABLE `location` block so they
// don't have to guess.
//
// This module provides two things:
//
//   1. enrichDiagnostics(diagnostics, code) — post-process a diagnostics
//      array and add a `.location: {startLine, endLine, snippet}` field to
//      every diagnostic that either has a line in context OR a "Line N:"
//      prefix in the message. Idempotent. Doesn't touch diagnostics that
//      can't be located.
//
//   2. withLocation(diag, {startLine, endLine, snippet}) — helper for rule
//      authors writing new validator rules. Returns the diag unchanged
//      except for the .location block. Callers can swap their `diag(...)
//      { line: num })` pattern for `withLocation(diag(...), loc)` without
//      touching the core diag() signature.
//
// With this in place, a patcher can read `diag.location.snippet` directly
// as the oldText for an Edit, avoiding any re-scanning of the file.
// ---------------------------------------------------------------------------

'use strict';

// Extract the "Line N" prefix from a validator message if present.
function extractLineFromMessage(message) {
  if (typeof message !== 'string') return null;
  const m = message.match(/\bLine\s+(\d+)\b/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Get the full text of a line (1-indexed) from code.
function getLine(code, lineNum) {
  if (typeof code !== 'string' || !Number.isFinite(lineNum) || lineNum < 1) return '';
  const lines = code.split('\n');
  if (lineNum > lines.length) return '';
  return lines[lineNum - 1];
}

// Get a snippet covering startLine..endLine inclusive.
function getSnippet(code, startLine, endLine) {
  if (typeof code !== 'string') return '';
  const lines = code.split('\n');
  const s = Math.max(1, startLine) - 1;
  const e = Math.max(s + 1, Math.min(lines.length, endLine));
  return lines.slice(s, e).join('\n');
}

// ---------------------------------------------------------------------------
// enrichDiagnostics — add location to every diagnostic that can be located.
//
// Sources (in priority order):
//   1. diag.location already set → leave alone (idempotent)
//   2. diag.context.startLine + optional endLine → use directly
//   3. diag.context.line → startLine=endLine=line
//   4. "Line N:" prefix in message → startLine=endLine=N
//   5. otherwise → no location added
// ---------------------------------------------------------------------------
function enrichDiagnostics(diagnostics, code) {
  if (!Array.isArray(diagnostics)) return diagnostics;
  return diagnostics.map((d) => {
    if (!d || typeof d !== 'object') return d;
    if (d.location && typeof d.location === 'object') return d;  // idempotent
    let startLine = null;
    let endLine = null;
    if (d.context && typeof d.context === 'object') {
      if (Number.isFinite(d.context.startLine)) {
        startLine = d.context.startLine;
        endLine = Number.isFinite(d.context.endLine) ? d.context.endLine : startLine;
      } else if (Number.isFinite(d.context.line)) {
        startLine = d.context.line;
        endLine = d.context.line;
      }
    }
    if (startLine == null) {
      const fromMsg = extractLineFromMessage(d.message);
      if (fromMsg != null) { startLine = fromMsg; endLine = fromMsg; }
    }
    if (startLine == null) return d;
    const snippet = getSnippet(code, startLine, endLine);
    return { ...d, location: { startLine, endLine, snippet } };
  });
}

// withLocation(diag, {startLine, endLine, snippet?}) — helper for rule authors.
function withLocation(diag, loc) {
  if (!diag || typeof diag !== 'object') return diag;
  const { startLine, endLine, snippet } = loc || {};
  if (!Number.isFinite(startLine)) return diag;
  return {
    ...diag,
    location: {
      startLine,
      endLine: Number.isFinite(endLine) ? endLine : startLine,
      snippet: typeof snippet === 'string' ? snippet : '',
    },
  };
}

module.exports = {
  enrichDiagnostics,
  withLocation,
  extractLineFromMessage,
  getLine,
  getSnippet,
};
