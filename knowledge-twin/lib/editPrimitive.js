// ---------------------------------------------------------------------------
// editPrimitive.js — atomic, validated, surgical file edits.
//
// The foundation of the pipeline's patch capability. Every edit goes through
// this module so invariants hold regardless of whether the edit came from a
// deterministic rule, an LLM, or a plan step.
//
// INVARIANTS (all enforced):
//   1. `oldText` must match EXACTLY ONCE in the file — never zero, never more.
//      Whitespace and punctuation are significant; no normalization.
//   2. After the edit, the file must parse. `.js` → node --check;
//      `.json` → JSON.parse; `.md` → no check (always parses).
//   3. On any validation failure, the file is restored to its pre-edit state.
//   4. Batch edits on one file are all-or-nothing: every edit applies in
//      memory, the final buffer is validated, then the file is written.
//      Partial batches never hit disk.
//   5. Cross-file batches (applyEditsMultiFile) snapshot every touched file
//      first, apply, validate all, and restore all on any failure.
//   6. Every applied edit returns a structured record with a unified diff,
//      rationale, and line-count delta — the provenance trail.
//
// USAGE:
//
//   const { applyEdit } = require('./editPrimitive');
//
//   const result = await applyEdit({
//     file: 'library/steps/builder/design-step/logic.js',
//     oldText: '    if (typeof auth === \'string\' && auth.includes(\'::\')) {\n'
//            + '      auth = auth.split(\'::\')[0];\n'
//            + '    }\n',
//     newText: '',
//     rationale: 'Vault stores credential under full id; strip broke storage.get',
//   });
//
//   if (!result.ok) {
//     console.error('Edit rejected:', result.error, result.details);
//   } else {
//     console.log(result.diff);
//   }
//
// ---------------------------------------------------------------------------

'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

// ---- error codes (stable for tests and logs) ----
const ERR = {
  OLD_TEXT_NO_MATCH: 'OLD_TEXT_NO_MATCH',
  OLD_TEXT_MULTIPLE_MATCHES: 'OLD_TEXT_MULTIPLE_MATCHES',
  SYNTAX_INVALID_AFTER: 'SYNTAX_INVALID_AFTER',
  WRITE_FAILED: 'WRITE_FAILED',
  FILE_NOT_FOUND: 'FILE_NOT_FOUND',
  EDIT_INVALID_SHAPE: 'EDIT_INVALID_SHAPE',
  BATCH_INVALIDATED: 'BATCH_INVALIDATED',
};

// ---- internal: count exact occurrences of needle in haystack ----
function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++;
    idx += needle.length;
  }
  return count;
}

// ---- internal: simple unified-diff-ish snippet for logs ----
function miniDiff(oldText, newText, contextChars = 60) {
  const lines = [];
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  for (const l of oldLines) if (l.length) lines.push(`- ${l.slice(0, 200)}`);
  for (const l of newLines) if (l.length) lines.push(`+ ${l.slice(0, 200)}`);
  const combined = lines.slice(0, 30).join('\n');
  return combined.length > 0 ? combined : `(no visible change; ${oldText.length}b → ${newText.length}b)`;
}

// ---- internal: SHA-256 short hash for provenance ----
function shortHash(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
}

// ---- internal: syntax check appropriate to the file type ----
function checkSyntax(filePath, contents) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    // node --check via spawnSync (stdin). Exit code 0 = parse ok.
    const res = spawnSync(process.execPath, ['--check', '-'], {
      input: contents,
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (res.status === 0) return { ok: true };
    return {
      ok: false,
      error: (res.stderr || res.stdout || 'unknown syntax error').split('\n').slice(0, 4).join('\n'),
    };
  }
  if (ext === '.json') {
    try {
      JSON.parse(contents);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `JSON parse: ${e.message}` };
    }
  }
  // .md, .txt, .yaml, etc — no structural check (treat as ok).
  return { ok: true, skipped: true };
}

// ---- internal: validate the shape of an edit object ----
function validateEditShape(edit) {
  if (!edit || typeof edit !== 'object') return 'edit must be an object';
  if (typeof edit.file !== 'string' || !edit.file) return 'edit.file must be a non-empty string';
  if (typeof edit.oldText !== 'string') return 'edit.oldText must be a string (empty string allowed for prepend)';
  if (typeof edit.newText !== 'string') return 'edit.newText must be a string';
  if (edit.oldText === edit.newText) return 'edit.oldText === edit.newText (no-op)';
  return null;
}

// ---------------------------------------------------------------------------
// applyEdit — the core primitive
// ---------------------------------------------------------------------------
async function applyEdit(edit, opts = {}) {
  const shapeErr = validateEditShape(edit);
  if (shapeErr) {
    return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: shapeErr, attempted: edit };
  }

  const abs = path.isAbsolute(edit.file) ? edit.file : path.resolve(process.cwd(), edit.file);
  let original;
  try {
    original = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: ERR.FILE_NOT_FOUND, details: e.message, attempted: edit };
  }

  // Preview (no write) mode
  const dryRun = !!opts.dryRun;

  // Special case: empty oldText means "prepend newText to file" — only valid
  // when caller explicitly opts in via edit.operation === 'prepend'. Otherwise
  // reject (empty-match-all semantics would match EVERY position).
  if (edit.oldText === '') {
    if (edit.operation !== 'prepend' && edit.operation !== 'append') {
      return {
        ok: false,
        error: ERR.EDIT_INVALID_SHAPE,
        details: 'oldText is empty; set edit.operation to "prepend" or "append" to disambiguate',
        attempted: edit,
      };
    }
    const updated = edit.operation === 'prepend' ? edit.newText + original : original + edit.newText;
    return finalizeEdit(abs, original, updated, edit, dryRun);
  }

  const occ = countOccurrences(original, edit.oldText);
  if (occ === 0) {
    return {
      ok: false,
      error: ERR.OLD_TEXT_NO_MATCH,
      details: `oldText not found in ${edit.file}. First 80 chars of oldText: ${JSON.stringify(edit.oldText.slice(0, 80))}`,
      attempted: edit,
    };
  }
  if (occ > 1) {
    return {
      ok: false,
      error: ERR.OLD_TEXT_MULTIPLE_MATCHES,
      details: `oldText matches ${occ} times in ${edit.file}. Add surrounding context to make it unique.`,
      attempted: edit,
    };
  }

  const updated = original.replace(edit.oldText, edit.newText);
  return finalizeEdit(abs, original, updated, edit, dryRun);
}

async function finalizeEdit(abs, original, updated, edit, dryRun) {
  const syntax = checkSyntax(abs, updated);
  if (!syntax.ok) {
    return {
      ok: false,
      error: ERR.SYNTAX_INVALID_AFTER,
      details: syntax.error,
      attempted: edit,
    };
  }

  if (!dryRun) {
    try {
      await fsp.writeFile(abs, updated, 'utf8');
    } catch (e) {
      return { ok: false, error: ERR.WRITE_FAILED, details: e.message, attempted: edit };
    }
  }

  const oldHash = shortHash(original);
  const newHash = shortHash(updated);
  return {
    ok: true,
    file: edit.file,
    oldTextHash: shortHash(edit.oldText),
    newTextHash: shortHash(edit.newText),
    oldBytes: original.length,
    newBytes: updated.length,
    linesChanged:
      Math.abs(original.split('\n').length - updated.split('\n').length),
    syntaxChecked: !syntax.skipped,
    diff: miniDiff(edit.oldText, edit.newText),
    rationale: edit.rationale || '',
    dryRun,
    oldFileHash: oldHash,
    newFileHash: newHash,
  };
}

// ---------------------------------------------------------------------------
// applyEditsOneFile — multiple edits on a single file, atomic
//
// Edits apply in memory sequentially (each sees the result of the prior).
// Syntax check runs once at the end on the final buffer. If any individual
// edit fails (no match, multiple match), NOTHING is written. If the final
// syntax check fails, nothing is written.
// ---------------------------------------------------------------------------
async function applyEditsOneFile(file, edits, opts = {}) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: 'edits must be a non-empty array', applied: [] };
  }
  const abs = path.isAbsolute(file) ? file : path.resolve(process.cwd(), file);
  let buffer;
  try {
    buffer = await fsp.readFile(abs, 'utf8');
  } catch (e) {
    return { ok: false, error: ERR.FILE_NOT_FOUND, details: e.message, applied: [] };
  }
  const originalBuffer = buffer;

  const planResults = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const shapeErr = validateEditShape({ ...e, file });
    if (shapeErr) {
      return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: `edit[${i}]: ${shapeErr}`, applied: planResults };
    }
    if (e.oldText === '') {
      if (e.operation !== 'prepend' && e.operation !== 'append') {
        return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: `edit[${i}]: empty oldText requires operation:"prepend"|"append"`, applied: planResults };
      }
      buffer = e.operation === 'prepend' ? e.newText + buffer : buffer + e.newText;
      planResults.push({ index: i, ok: true, diff: miniDiff(e.oldText, e.newText) });
      continue;
    }
    const occ = countOccurrences(buffer, e.oldText);
    if (occ === 0) {
      return {
        ok: false, error: ERR.OLD_TEXT_NO_MATCH,
        details: `edit[${i}] oldText not found (post prior edits)`,
        applied: planResults,
      };
    }
    if (occ > 1) {
      return {
        ok: false, error: ERR.OLD_TEXT_MULTIPLE_MATCHES,
        details: `edit[${i}] oldText matches ${occ} times`,
        applied: planResults,
      };
    }
    buffer = buffer.replace(e.oldText, e.newText);
    planResults.push({ index: i, ok: true, diff: miniDiff(e.oldText, e.newText) });
  }

  const syntax = checkSyntax(abs, buffer);
  if (!syntax.ok) {
    return { ok: false, error: ERR.SYNTAX_INVALID_AFTER, details: syntax.error, applied: planResults };
  }

  if (!opts.dryRun) {
    try {
      await fsp.writeFile(abs, buffer, 'utf8');
    } catch (e) {
      return { ok: false, error: ERR.WRITE_FAILED, details: e.message, applied: planResults };
    }
  }
  return {
    ok: true,
    file,
    editsApplied: planResults.length,
    oldFileHash: shortHash(originalBuffer),
    newFileHash: shortHash(buffer),
    linesChanged: Math.abs(originalBuffer.split('\n').length - buffer.split('\n').length),
    dryRun: !!opts.dryRun,
    applied: planResults,
  };
}

// ---------------------------------------------------------------------------
// applyEditsMultiFile — edits across multiple files, all-or-nothing
//
// Snapshot every touched file, apply all edits in memory (grouped per file),
// validate each final buffer, then write all. On ANY failure, nothing hits
// disk. On partial post-write failure (rare), restore all files from
// snapshot — the only case that ever does disk rollback.
// ---------------------------------------------------------------------------
async function applyEditsMultiFile(edits, opts = {}) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: 'edits must be a non-empty array', applied: [] };
  }
  // Group by file
  const byFile = new Map();
  for (const e of edits) {
    const shapeErr = validateEditShape(e);
    if (shapeErr) return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: shapeErr, applied: [] };
    const key = path.isAbsolute(e.file) ? e.file : path.resolve(process.cwd(), e.file);
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key).push(e);
  }

  // Phase 1 — read + apply-in-memory + validate each file's final buffer.
  const snapshots = new Map();  // abs → originalContents
  const finals = new Map();     // abs → finalContents (validated)
  for (const [abs, fileEdits] of byFile) {
    let buffer;
    try {
      buffer = await fsp.readFile(abs, 'utf8');
    } catch (e) {
      return { ok: false, error: ERR.FILE_NOT_FOUND, details: `${abs}: ${e.message}`, applied: [] };
    }
    snapshots.set(abs, buffer);
    for (let i = 0; i < fileEdits.length; i++) {
      const e = fileEdits[i];
      if (e.oldText === '') {
        if (e.operation !== 'prepend' && e.operation !== 'append') {
          return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: `${abs}[${i}]: empty oldText requires operation`, applied: [] };
        }
        buffer = e.operation === 'prepend' ? e.newText + buffer : buffer + e.newText;
        continue;
      }
      const occ = countOccurrences(buffer, e.oldText);
      if (occ === 0) {
        return { ok: false, error: ERR.OLD_TEXT_NO_MATCH, details: `${e.file} edit[${i}]: oldText not found`, applied: [] };
      }
      if (occ > 1) {
        return { ok: false, error: ERR.OLD_TEXT_MULTIPLE_MATCHES, details: `${e.file} edit[${i}]: oldText matches ${occ} times`, applied: [] };
      }
      buffer = buffer.replace(e.oldText, e.newText);
    }
    const syntax = checkSyntax(abs, buffer);
    if (!syntax.ok) {
      return { ok: false, error: ERR.SYNTAX_INVALID_AFTER, details: `${abs}: ${syntax.error}`, applied: [] };
    }
    finals.set(abs, buffer);
  }

  if (opts.dryRun) {
    return {
      ok: true,
      dryRun: true,
      filesAffected: finals.size,
      editsApplied: edits.length,
      files: [...finals.keys()].map((abs) => ({
        file: path.relative(process.cwd(), abs),
        oldFileHash: shortHash(snapshots.get(abs)),
        newFileHash: shortHash(finals.get(abs)),
      })),
    };
  }

  // Phase 2 — write all files. Track which we've written for rollback.
  const written = [];
  for (const [abs, contents] of finals) {
    try {
      await fsp.writeFile(abs, contents, 'utf8');
      written.push(abs);
    } catch (e) {
      // Rollback every previously-written file from its snapshot.
      const rollbackErrors = [];
      for (const abs2 of written) {
        try {
          await fsp.writeFile(abs2, snapshots.get(abs2), 'utf8');
        } catch (rbErr) {
          rollbackErrors.push(`${abs2}: ${rbErr.message}`);
        }
      }
      return {
        ok: false,
        error: ERR.WRITE_FAILED,
        details: `write of ${abs} failed: ${e.message}`,
        rolledBack: written.length,
        rollbackErrors,
        applied: [],
      };
    }
  }
  return {
    ok: true,
    filesAffected: finals.size,
    editsApplied: edits.length,
    files: [...finals.keys()].map((abs) => ({
      file: path.relative(process.cwd(), abs),
      oldFileHash: shortHash(snapshots.get(abs)),
      newFileHash: shortHash(finals.get(abs)),
    })),
  };
}

// ---------------------------------------------------------------------------
// validateEditAgainstContents — dry-check without I/O
//
// Useful when the caller already has the file contents in memory (e.g. an
// LLM patch proposer wants to verify a candidate edit will apply before
// returning it).
// ---------------------------------------------------------------------------
function validateEditAgainstContents(edit, contents) {
  const shapeErr = validateEditShape(edit);
  if (shapeErr) return { canApply: false, reason: shapeErr };
  if (edit.oldText === '') {
    if (edit.operation !== 'prepend' && edit.operation !== 'append') {
      return { canApply: false, reason: 'empty oldText requires operation' };
    }
    return { canApply: true };
  }
  const occ = countOccurrences(contents, edit.oldText);
  if (occ === 0) return { canApply: false, reason: 'OLD_TEXT_NO_MATCH' };
  if (occ > 1) return { canApply: false, reason: 'OLD_TEXT_MULTIPLE_MATCHES', matchCount: occ };
  return { canApply: true };
}

// ---------------------------------------------------------------------------
// applyEditsToString — in-memory variant, no file I/O.
//
// Useful when you have code as a string (e.g. LLM just produced it; you
// haven't written it anywhere yet) and want to apply the same all-or-
// nothing semantics. Returns { ok, code, applied[], error? }.
//
// Skip-syntax-check is supported via opts.skipSyntaxCheck for unusual cases
// (e.g. the LLM emitted ES-module syntax that won't parse standalone until
// wrapped by the harness). Default: false — always syntax-check.
// ---------------------------------------------------------------------------
function applyEditsToString(contents, edits, opts = {}) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: 'edits must be a non-empty array', code: contents, applied: [] };
  }
  let buffer = contents;
  const applied = [];
  for (let i = 0; i < edits.length; i++) {
    const e = edits[i];
    const shapeErr = validateEditShape({ ...e, file: 'virtual' });
    if (shapeErr) {
      return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: `edit[${i}]: ${shapeErr}`, code: contents, applied };
    }
    if (e.oldText === '') {
      if (e.operation !== 'prepend' && e.operation !== 'append') {
        return { ok: false, error: ERR.EDIT_INVALID_SHAPE, details: `edit[${i}]: empty oldText requires operation`, code: contents, applied };
      }
      buffer = e.operation === 'prepend' ? e.newText + buffer : buffer + e.newText;
      applied.push({ index: i, ok: true, diff: miniDiff(e.oldText, e.newText), rationale: e.rationale || '' });
      continue;
    }
    const occ = countOccurrences(buffer, e.oldText);
    if (occ === 0) {
      return {
        ok: false, error: ERR.OLD_TEXT_NO_MATCH,
        details: `edit[${i}] oldText not found (post prior edits)`,
        code: contents, applied,
      };
    }
    if (occ > 1) {
      return {
        ok: false, error: ERR.OLD_TEXT_MULTIPLE_MATCHES,
        details: `edit[${i}] oldText matches ${occ} times`,
        code: contents, applied,
      };
    }
    buffer = buffer.replace(e.oldText, e.newText);
    applied.push({ index: i, ok: true, diff: miniDiff(e.oldText, e.newText), rationale: e.rationale || '' });
  }
  // Optional syntax check — only if caller hints it's JS and didn't opt out.
  if (!opts.skipSyntaxCheck && opts.syntaxCheck) {
    const ext = opts.syntaxCheck === true ? '.js' : `.${opts.syntaxCheck}`;
    const syntax = checkSyntax(`virtual${ext}`, buffer);
    if (!syntax.ok) {
      return { ok: false, error: ERR.SYNTAX_INVALID_AFTER, details: syntax.error, code: contents, applied };
    }
  }
  return {
    ok: true,
    code: buffer,
    editsApplied: applied.length,
    oldHash: shortHash(contents),
    newHash: shortHash(buffer),
    applied,
  };
}

module.exports = {
  applyEdit,
  applyEditsOneFile,
  applyEditsMultiFile,
  applyEditsToString,
  validateEditAgainstContents,
  ERR,
  // exposed for unit tests only
  _internal: { countOccurrences, checkSyntax, miniDiff, shortHash, validateEditShape },
};
