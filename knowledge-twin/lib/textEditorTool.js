// ---------------------------------------------------------------------------
// textEditorTool.js — dispatcher for Anthropic's trained
// `text_editor_20250728` tool, executed against an in-memory file dict.
//
// Claude natively knows this tool's schema — we only implement the commands:
//
//   view        — return a file's contents or a directory listing. Supports
//                 optional view_range [start, end] (1-indexed, inclusive).
//   create      — write a new file. Errors if path already exists.
//   str_replace — replace old_str with new_str. old_str must match EXACTLY
//                 ONCE in the file (not zero, not multiple). Errors with
//                 is_error:true + a message Claude can learn from if not.
//   insert      — insert content after `insert_line` (1-indexed). Line 0
//                 inserts at the very top.
//
// Every dispatch is a PURE function of (input, files) — no I/O, no global
// state. Atomic: on error, files is returned unchanged. Callers can safely
// treat the returned `files` dict as the new state.
//
// The dispatcher also tracks an undo stack so Claude can call `undo_edit`
// on the same file to roll back its last change — matches the trained
// command surface.
// ---------------------------------------------------------------------------

'use strict';

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

function ok(output, files, undoStack) {
  return { files, undoStack, output: String(output), is_error: false };
}
function err(msg, files, undoStack) {
  return { files, undoStack, output: String(msg), is_error: true };
}

function viewFile(input, files) {
  const { path } = input;
  if (!(path in files)) {
    return { output: `Error: file does not exist: ${path}`, is_error: true };
  }
  const content = files[path];
  if (Array.isArray(input.view_range) && input.view_range.length === 2) {
    const [start, end] = input.view_range;
    const lines = content.split('\n');
    // 1-indexed, inclusive; -1 means "to end"
    const s = Math.max(1, Number(start) || 1) - 1;
    const e = end === -1 ? lines.length : Math.min(lines.length, Number(end) || lines.length);
    if (s >= lines.length) return { output: `Error: start line ${start} exceeds file length ${lines.length}`, is_error: true };
    const snippet = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
    return { output: snippet, is_error: false };
  }
  // Full content with line-number prefix (helps Claude reference lines).
  const numbered = content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
  return { output: numbered, is_error: false };
}

function createFile(input, files, undoStack) {
  const { path, file_text } = input;
  if (typeof path !== 'string' || !path) return err('create: path is required', files, undoStack);
  if (typeof file_text !== 'string') return err('create: file_text is required', files, undoStack);
  if (path in files) return err(`create: file already exists: ${path}`, files, undoStack);
  const nextFiles = { ...files, [path]: file_text };
  const nextUndo = { ...undoStack, [path]: [...(undoStack[path] || []), null /* create: previous was "does not exist" */] };
  return ok(`File created: ${path} (${file_text.length} bytes)`, nextFiles, nextUndo);
}

function strReplace(input, files, undoStack) {
  const { path, old_str, new_str } = input;
  if (typeof path !== 'string' || !path) return err('str_replace: path is required', files, undoStack);
  if (typeof old_str !== 'string') return err('str_replace: old_str is required', files, undoStack);
  if (typeof new_str !== 'string') return err('str_replace: new_str is required', files, undoStack);
  if (!(path in files)) return err(`str_replace: file does not exist: ${path}`, files, undoStack);

  const content = files[path];
  const occ = countOccurrences(content, old_str);
  if (occ === 0) {
    return err(
      `str_replace: old_str not found in ${path}. Use view to confirm the exact text (including whitespace) before retrying.`,
      files, undoStack
    );
  }
  if (occ > 1) {
    return err(
      `str_replace: old_str matches ${occ} times in ${path}. Include more surrounding context to make the match unique.`,
      files, undoStack
    );
  }

  const nextContent = content.replace(old_str, new_str);
  const nextFiles = { ...files, [path]: nextContent };
  const nextUndo = { ...undoStack, [path]: [...(undoStack[path] || []), content] };
  const delta = nextContent.length - content.length;
  const sign = delta >= 0 ? '+' : '';
  return ok(`Replaced in ${path} (${sign}${delta} bytes)`, nextFiles, nextUndo);
}

function insertAt(input, files, undoStack) {
  const { path, insert_line, new_str } = input;
  if (typeof path !== 'string' || !path) return err('insert: path is required', files, undoStack);
  if (typeof new_str !== 'string') return err('insert: new_str is required', files, undoStack);
  if (!(path in files)) return err(`insert: file does not exist: ${path}`, files, undoStack);
  const content = files[path];
  const lines = content.split('\n');
  const at = Number(insert_line);
  if (!Number.isFinite(at) || at < 0) return err(`insert: insert_line must be >= 0 (got ${insert_line})`, files, undoStack);
  if (at > lines.length) return err(`insert: insert_line ${at} exceeds file length ${lines.length}`, files, undoStack);
  // Insert AFTER the specified 1-indexed line (0 = top). new_str may contain \n.
  const insertIdx = at; // at=0 → before line 1; at=N → after line N
  const newLines = [...lines.slice(0, insertIdx), new_str, ...lines.slice(insertIdx)];
  const nextContent = newLines.join('\n');
  const nextFiles = { ...files, [path]: nextContent };
  const nextUndo = { ...undoStack, [path]: [...(undoStack[path] || []), content] };
  return ok(`Inserted at ${path} line ${at}`, nextFiles, nextUndo);
}

function undoEdit(input, files, undoStack) {
  const { path } = input;
  if (!(path in (undoStack || {})) || !undoStack[path] || undoStack[path].length === 0) {
    return err(`undo_edit: no prior edit to undo for ${path}`, files, undoStack);
  }
  const prev = undoStack[path][undoStack[path].length - 1];
  const rest = undoStack[path].slice(0, -1);
  const nextUndo = { ...undoStack, [path]: rest };
  if (prev === null) {
    // Prior state was "file does not exist" → undoing a create.
    const nextFiles = { ...files };
    delete nextFiles[path];
    return ok(`Undid create of ${path}`, nextFiles, nextUndo);
  }
  const nextFiles = { ...files, [path]: prev };
  return ok(`Undid last edit to ${path}`, nextFiles, nextUndo);
}

// ---------------------------------------------------------------------------
// dispatchTool — main entry point.
//
// input = Claude's tool_use.input block (the parsed arguments)
// state = { files, undoStack }
// returns { files, undoStack, output, is_error }
// ---------------------------------------------------------------------------
function dispatchTool(input, state = {}) {
  const files = state.files || {};
  const undoStack = state.undoStack || {};

  if (!input || typeof input.command !== 'string') {
    return { files, undoStack, output: 'Error: tool input missing "command"', is_error: true };
  }

  // Path safety: allow-list paths the caller passed; disallow "../" / absolute.
  if (input.path && (input.path.includes('..') || input.path.startsWith('/'))) {
    return { files, undoStack, output: `Error: path must be relative and cannot contain "..": ${input.path}`, is_error: true };
  }
  // If caller set pathAllowlist, enforce it.
  if (state.pathAllowlist && input.path && !state.pathAllowlist.includes(input.path)) {
    return { files, undoStack, output: `Error: path not in allowlist: ${input.path}. Allowed: ${state.pathAllowlist.join(', ')}`, is_error: true };
  }

  switch (input.command) {
    case 'view': return { files, undoStack, ...viewFile(input, files) };
    case 'create': return createFile(input, files, undoStack);
    case 'str_replace': return strReplace(input, files, undoStack);
    case 'insert': return insertAt(input, files, undoStack);
    case 'undo_edit': return undoEdit(input, files, undoStack);
    default:
      return err(`Error: unknown command "${input.command}". Allowed: view, create, str_replace, insert, undo_edit.`, files, undoStack);
  }
}

module.exports = {
  dispatchTool,
  // exposed for tests
  _internal: { viewFile, createFile, strReplace, insertAt, undoEdit, countOccurrences },
};
