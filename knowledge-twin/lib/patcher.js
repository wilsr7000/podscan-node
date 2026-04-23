// ---------------------------------------------------------------------------
// patcher.js — deterministic and LLM-driven patch producers.
//
// Sits on top of lib/editPrimitive.js. Its job is to PRODUCE edits, never
// apply them (callers use applyEdit / applyEditsOneFile to commit).
//
// Two kinds of patchers:
//
//   1. Deterministic — pattern-matched, zero LLM calls. Each known defect
//      has a `match(contents, context) → Edit[] | null` function. When it
//      matches, it returns an exact edit list that resolves the defect.
//      Deterministic patchers are preferred because they're:
//        - fast (no LLM roundtrip)
//        - reproducible (same input → same edit, always)
//        - auditable (the source code IS the fix logic)
//
//   2. LLM (narrow-output) — for defects without a deterministic fix. Calls
//      an LLM with a CONSTRAINED prompt that forces the response into a
//      JSON array of {oldText, newText, rationale}. The response is
//      parsed + validated (each edit's oldText must apply cleanly via the
//      Edit primitive's validateEditAgainstContents). Invalid edits are
//      rejected without touching the file.
//
// The contrast with old autoRepairKnownBlockers:
//   - That function produced a mutated code string, no structured record
//     of what changed, and inlined the LLM-retry path via priorDiagnosis.
//   - This module produces Edit records that the caller decides to apply.
//     Applications are logged, rolled back on failure, composable, and
//     never "create new bugs" because the LLM output channel is too narrow
//     to regenerate the file.
//
// ---------------------------------------------------------------------------

'use strict';

const { applyEdit, validateEditAgainstContents } = require('./editPrimitive');

// ---------------------------------------------------------------------------
// Deterministic patchers: one per defect class.
//
// Each has:
//   id          — matches the known-issues.js registry + validator.code
//   match(fileContents, context) → { edits: Edit[], rationale } | null
// ---------------------------------------------------------------------------

const PATCHERS = [];

// Defect: ::token:: strip before storage.get. The exact bug from E2E #11.
// Fix: remove the 3-line block. Deterministic because the pattern is stable.
PATCHERS.push({
  id: 'AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX',
  severity: 'error',
  description: '_resolveApiKey strips Edison\'s "::token::<label>" suffix before storage.get. The vault stores credentials under the full id including the suffix, so strip causes lookup to miss.',
  match(contents) {
    // Pattern-match any variable name doing a ::token:: strip. The variable
    // is commonly `auth`, `_auth`, `authInput`, `_authInput`, etc. Works for:
    //   if (typeof VAR === 'string' && VAR.includes('::')) { VAR = VAR.split('::')[0]; }
    const patterns = [
      // Full: optional comment line + if-block with any identifier for VAR
      /((?:[ \t]*\/\/[^\n]*::token::[^\n]*\n)?[ \t]*if \(typeof (\w+) === ['"]string['"] && \2\.includes\(['"]::['"]\)\) \{\s*\2 = \2\.split\(['"]::['"]\)\[0\];\s*\}\n?)/,
    ];
    for (const re of patterns) {
      const m = contents.match(re);
      if (m) {
        return {
          edits: [{
            oldText: m[0],
            newText: '',
            rationale: `Vault stores credential under full id (including ::token::<label>). Strip of variable \`${m[2]}\` caused storage.get to miss.`,
          }],
          rationale: `Removed the ::token:: suffix strip (variable ${m[2]}).`,
        };
      }
    }
    return null;
  },
});

// Defect: UNCONDITIONAL_ERROR_EXIT — call exitStep('__error__') without
// checking this.data.processError.
//
// NOTE (§4.2 correction): this patcher predates the runtime-truth clarification.
// The SDK does NOT reject __error__ when processError:false — flow-sdk
// resolves exits purely by exits[] dict lookup (data.ts:94-104) and never
// reads processError. The real runtime bug is "__error__ not in exits[]",
// handled by ERROR_EXIT_NOT_DECLARED in templateShapePatcher.
//
// This patcher now serves a narrower purpose: Studio-alignment. Gating the
// error exit behind this.data.processError keeps logic.js consistent with
// step.json when the UI-toggle is off (so a flow author who disables "Process
// errors" in Studio doesn't see the code keep trying to use the hidden exit).
// It's defense-in-depth, not a runtime fix.
PATCHERS.push({
  id: 'UNCONDITIONAL_ERROR_EXIT',
  severity: 'warning',
  description: 'exitStep("__error__", ...) called unconditionally. Wrap in if (this.data.processError) for Studio-toggle alignment. Not a runtime gate — the SDK resolves __error__ by exits[] membership regardless of processError.',
  match(contents) {
    // Match lines like `return this.exitStep('__error__', {...})` not preceded by processError check.
    const edits = [];
    const re = /^(\s*)return this\.exitStep\(\s*(['"])__error__\2\s*,\s*(\{[^}]*\})\s*\);?/gm;
    let m;
    while ((m = re.exec(contents)) !== null) {
      // Check if the preceding lines (within 3) reference processError
      const startIdx = Math.max(0, m.index - 300);
      const context = contents.slice(startIdx, m.index);
      if (/processError/.test(context)) continue;  // already guarded
      const oldText = m[0];
      const indent = m[1];
      const errObj = m[3];
      // Extract the error obj's message / code if possible for the throw
      const codeMatch = errObj.match(/code\s*:\s*['"`]([^'"`]+)['"`]/);
      const msgMatch = errObj.match(/message\s*:\s*['"`]([^'"`]+)['"`]/);
      const errCode = codeMatch ? codeMatch[1] : 'STEP_FAILED';
      const errMsg = msgMatch ? msgMatch[1] : 'step failed';
      const newText = `${indent}if (this.data.processError) return this.exitStep('__error__', ${errObj});\n${indent}throw Object.assign(new Error(${JSON.stringify(errMsg)}), { code: ${JSON.stringify(errCode)} });`;
      edits.push({ oldText, newText, rationale: 'Gate __error__ exit behind processError for Studio-toggle alignment (not a runtime gate — see §4.2).' });
    }
    if (edits.length === 0) return null;
    return { edits, rationale: `Gated ${edits.length} unconditional exitStep("__error__") call(s) for Studio-alignment.` };
  },
});

// Defect: EQEQ — use of == / != instead of === / !==.
PATCHERS.push({
  id: 'EQEQ',
  severity: 'warning',
  description: 'Uses loose equality (== or !=). Replace with strict equality (=== or !==) to avoid type coercion bugs.',
  match(contents) {
    // Strip strings + comments first so we don't touch operators inside literals.
    const stripped = stripStringsAndComments(contents);
    // Find == and != that aren't === or !==
    const edits = [];
    const matches = [];
    // Build a matcher that records positions in the STRIPPED version
    const re = /(^|[^=!<>])(==|!=)(?!=)/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
      matches.push({ prefix: m[1], op: m[2], start: m.index + m[1].length });
    }
    if (matches.length === 0) return null;

    // For each match, find the corresponding position in the ORIGINAL and
    // produce an edit with a tight oldText window (few chars on each side).
    //
    // Overlap handling: when two operators are close together, their 15-char
    // windows can overlap — applying edit #1 mutates text that edit #2's
    // oldText depends on, causing OLD_TEXT_NO_MATCH. We drop any candidate
    // edit whose window overlaps an already-accepted one. Skipped operators
    // are picked up on the NEXT findPatches call after the first batch
    // applies (self-healing across invocations).
    const acceptedRanges = [];  // [[winStart, winEnd], ...]
    for (const mm of matches) {
      // Extract the actual 2-char op from the original at the same index.
      const op = contents.slice(mm.start, mm.start + 2);
      if (op !== '==' && op !== '!=') continue;  // mismatch (shouldn't happen)
      // Build a unique window: 15 chars before + op + 15 chars after
      const winStart = Math.max(0, mm.start - 15);
      const winEnd = Math.min(contents.length, mm.start + 17);
      // Skip if this window overlaps an accepted one.
      if (acceptedRanges.some(([s, e]) => !(winEnd <= s || winStart >= e))) continue;
      const oldText = contents.slice(winStart, winEnd);
      // Sanity: oldText must contain op at the expected relative position
      const relOpIdx = mm.start - winStart;
      if (oldText.slice(relOpIdx, relOpIdx + 2) !== op) continue;
      const newText =
        oldText.slice(0, relOpIdx) + (op === '==' ? '===' : '!==') + oldText.slice(relOpIdx + 2);
      // Skip if oldText isn't unique (we'd break unrelated matches).
      const occ = countOccurrences(contents, oldText);
      if (occ !== 1) continue;
      edits.push({
        oldText,
        newText,
        rationale: `Strict equality: ${op} → ${op === '==' ? '===' : '!=='}.`,
      });
      acceptedRanges.push([winStart, winEnd]);
    }
    if (edits.length === 0) return null;
    return { edits, rationale: `Converted ${edits.length} loose equality operator(s) to strict.` };
  },
});

// Defect: TEMPLATE_HELP_DUPLICATES_DESCRIPTION — help field echoes description.
// Fix: replace help with a canonical skeleton.
PATCHERS.push({
  id: 'TEMPLATE_HELP_DUPLICATES_DESCRIPTION',
  severity: 'warning',
  description: 'Template help field duplicates description. Replace with structured skeleton: ## Inputs, ## Output, ## Error handling.',
  match(contents, ctx) {
    // This patcher operates on step.json. The help field check lives outside
    // the code; if we detect a step.json-shaped input we patch the help key.
    if (!ctx || ctx.fileType !== 'step.json') return null;
    let parsed;
    try { parsed = JSON.parse(contents); } catch { return null; }
    if (!parsed.help || !parsed.description) return null;
    if (parsed.help.trim() !== parsed.description.trim()) return null;
    const helpSkeleton =
      '## Inputs\n\n- (describe each input)\n\n' +
      '## Output\n\n- (describe the shape of dataOut)\n\n' +
      '## Error handling\n\n- (describe error codes the step can emit)';
    // Produce a narrow edit that replaces just the help value.
    // Search for "help":"..." as a JSON key-value, handling common escapes.
    const helpRe = /"help"\s*:\s*"((?:[^"\\]|\\.)*)"/;
    const m = contents.match(helpRe);
    if (!m) return null;
    const oldText = m[0];
    const newText = `"help": ${JSON.stringify(helpSkeleton)}`;
    return {
      edits: [{ oldText, newText, rationale: 'Replaced help-echoes-description with structured skeleton.' }],
      rationale: 'Help field no longer duplicates description.',
    };
  },
});

// Defect: HARDCODED_URL — a URL literal appears in code instead of being
// read from this.data. Port of autoRepairKnownBlockers's URL logic, now
// producing Edit records rather than mutating a code string.
//
// Strategy:
//   1. Find all URL literals matched by the HARDCODED_URL regex.
//   2. For each URL, pick a spec input to resolve from (by domain match →
//      name heuristic → any url-defaulted input → synthetic fallback).
//   3. Produce TWO edits per unique variable:
//      a. Insert `const _VAR_resolved = ...` at the top of runStep().
//      b. Replace each URL literal with `_VAR_resolved`.
//
// Requires spec.inputs in context. If spec is missing, skip.
PATCHERS.push({
  id: 'HARDCODED_URL',
  severity: 'error',
  description: 'Hardcoded URL literal in step code. Extract to this.data input with defaultValue so step is reusable.',
  match(contents, ctx) {
    const spec = ctx && ctx.spec;
    if (!spec || !Array.isArray(spec.inputs)) return null;

    // Before scanning for URL literals, BLANK OUT comments so URLs inside
    // `// ...` and `/* ... */` don't get falsely matched. Keep string
    // contents intact — a URL that is its own string literal IS a
    // legitimate runtime target. The blank-fill preserves byte positions,
    // so downstream regex replacement on `contents` still lines up.
    const codeOnly = stripCommentsOnly(contents);

    // Find URL literals not already inside a this.data expression or template interpolation.
    const urlSet = new Set();
    const urlRe = /(['"`])(https?:\/\/[^'"`\s]+)\1/g;
    let m;
    while ((m = urlRe.exec(codeOnly)) !== null) {
      const url = m[2];
      // Skip if same line references this.data (already resolved)
      const lineStart = codeOnly.lastIndexOf('\n', m.index) + 1;
      const lineEnd = codeOnly.indexOf('\n', m.index);
      const line = codeOnly.slice(lineStart, lineEnd > 0 ? lineEnd : codeOnly.length);
      if (/this\.data/.test(line)) continue;
      // Skip common exempt patterns
      if (/api\.anthropic\.com|github\.com|localhost/.test(url)) continue;
      urlSet.add(url);
    }
    if (urlSet.size === 0) return null;

    // Pick a spec input for each URL (domain → name-heuristic → first-url → synthetic)
    const urlDefaultedInputs = spec.inputs.filter((i) => {
      return typeof i.default === 'string' && /^https?:\/\//.test(i.default);
    });

    const injectionsByVar = new Map();
    const replacements = [];

    for (const url of urlSet) {
      let input = null, reason = '';
      try {
        const hostname = new URL(url).hostname;
        input = urlDefaultedInputs.find((i) => {
          try { return new URL(i.default).hostname === hostname; } catch { return false; }
        });
        if (input) reason = 'domain-match';
      } catch {}
      if (!input) {
        input = urlDefaultedInputs.find((i) => /url|endpoint|api/i.test(i.variable || ''));
        if (input) reason = 'name-heuristic';
      }
      if (!input && urlDefaultedInputs.length > 0) {
        input = urlDefaultedInputs[0];
        reason = 'any-url-input';
      }
      if (!input) {
        input = { variable: 'apiUrl', default: '' };
        reason = 'synthetic';
      }
      const varName = `_${input.variable}_resolved`;
      const fallback = reason === 'synthetic' ? '' : (input.default || '');
      if (!injectionsByVar.has(varName)) {
        injectionsByVar.set(varName, {
          varName, specVar: input.variable, fallback,
          declLine: `const ${varName} = (this.data.${input.variable} && this.data.${input.variable} !== 'undefined') ? this.data.${input.variable} : ${JSON.stringify(fallback)};`,
        });
      }
      // Find exact quoted URL occurrences for replacement.
      const escUrl = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const literalRe = new RegExp(`(['"\`])${escUrl}\\1`, 'g');
      let lm;
      while ((lm = literalRe.exec(contents)) !== null) {
        replacements.push({ oldText: lm[0], newText: varName, url });
      }
    }

    if (replacements.length === 0 && injectionsByVar.size === 0) return null;

    // Build edits: declaration-insert (once per var) + replacements.
    const edits = [];
    // Insert declarations at runStep() opening brace. We use a SINGLE replace
    // that locates `async runStep(...) {` and appends our block.
    const runStepRe = /async\s+runStep\s*\([^)]*\)\s*\{/;
    const runStepMatch = contents.match(runStepRe);
    if (runStepMatch && injectionsByVar.size > 0) {
      const oldOpen = runStepMatch[0];
      const injectionLines = Array.from(injectionsByVar.values()).map((v) => `      ${v.declLine}`).join('\n');
      const newOpen = `${oldOpen}\n      // [patcher: resolve URLs from this.data inputs — fixes HARDCODED_URL]\n${injectionLines}\n`;
      edits.push({
        oldText: oldOpen,
        newText: newOpen,
        rationale: `Injected ${injectionsByVar.size} URL-resolution declaration(s) at top of runStep.`,
      });
    }
    // Replacements: collapse duplicates (same oldText must be unique per edit).
    const seen = new Set();
    for (const r of replacements) {
      if (seen.has(r.oldText)) continue;
      seen.add(r.oldText);
      edits.push({
        oldText: r.oldText,
        newText: r.newText,
        rationale: `Replaced literal URL "${r.url.slice(0, 40)}" with ${r.newText}.`,
      });
    }
    if (edits.length === 0) return null;
    return { edits, rationale: `Hoisted ${injectionsByVar.size} URL input(s); replaced ${replacements.length} literal occurrence(s).` };
  },
});

// Defect: AUTH_NO_KV_RESOLUTION — code reads this.data.auth directly but
// never uses `require('or-sdk/storage')` + storage.get(). Inject the
// canonical auth block at top of runStep.
PATCHERS.push({
  id: 'AUTH_NO_KV_RESOLUTION',
  severity: 'error',
  description: 'Code reads this.data.auth credential but doesn\'t resolve it via or-sdk/storage. Inject canonical storage.get block.',
  match(contents, ctx) {
    const hasAuthRead = /this\.data\.auth\b/.test(contents);
    // Resolution counts as present if:
    //   (a) full canonical pattern: require('or-sdk/storage') + .get(   OR
    //   (b) the canonical variables we inject (_authInput, _storage, etc.)
    //       are ALREADY declared — a prior auto-repair or LLM output already
    //       has our block shape, re-injecting would produce duplicate decls
    //   (c) any Storage-shaped class is instantiated + .get() is called
    //       (storage instance var name is flexible)
    const hasCanonicalRequire = /require\(\s*['"]or-sdk\/storage['"]\s*\)/.test(contents);
    const hasGetCall = /\.get\s*\(/.test(contents);
    const hasCanonicalPattern = hasCanonicalRequire && hasGetCall;
    // Variable-name-based detection: if my injection's vars are already
    // there, re-injecting would duplicate-declare them.
    const hasInjectedShape =
      /\blet\s+_authInput\b/.test(contents) ||
      /\bconst\s+_storage\b/.test(contents) ||
      /\bconst\s+_Storage\b/.test(contents) ||
      /\bconst\s+_authCollection\b/.test(contents);
    if (!hasAuthRead || hasCanonicalPattern || hasInjectedShape) return null;

    const runStepRe = /async\s+runStep\s*\([^)]*\)\s*\{/;
    const m = contents.match(runStepRe);
    if (!m) return null;

    // Parameterize the auth collection from the spec (2.3 fix): prefer the
    // spec's declared auth-external-component collection over the hardcoded
    // `__authorization_service_Default`. Without this, a step with an
    // Anthropic/Google/etc auth input gets the wrong collection injected →
    // storage.get misses at runtime → silent auth failure.
    const spec = ctx && ctx.spec;
    let specCollection = '__authorization_service_Default';
    let collectionReason = 'default (spec had no auth input with config.collection)';
    if (spec && Array.isArray(spec.inputs)) {
      const authInputs = spec.inputs.filter((i) => {
        if (i && (i.type === 'auth' || i.component === 'auth-external-component')) return true;
        const coll = i?.config?.collection || i?.data?.keyValueCollection || i?.keyValueCollection;
        return typeof coll === 'string' && /^__authorization_service_/.test(coll);
      });
      const collections = authInputs.map((i) => i?.config?.collection || i?.data?.keyValueCollection || i?.keyValueCollection).filter(Boolean);
      if (collections.length === 1) {
        specCollection = collections[0];
        collectionReason = `from spec auth input "${authInputs[0].variable || ''}"`;
      } else if (collections.length > 1) {
        // Multiple auth inputs — pick the first, but log the ambiguity.
        specCollection = collections[0];
        collectionReason = `from first of ${collections.length} spec auth inputs (ambiguous)`;
      }
    }

    const oldOpen = m[0];
    const canonical = `
      // [patcher: canonical auth resolution — fixes AUTH_NO_KV_RESOLUTION, collection ${collectionReason}]
      let _authInput = this.data.auth;
      if (typeof _authInput === 'object' && _authInput !== null) {
        _authInput = _authInput.auth || _authInput.authSelected || '';
      }
      if (!_authInput) {
        return this.exitStep('__error__', { code: 'MISSING_AUTH', message: 'auth credential is required' });
      }
      const _authCollection = (this.data.authCollection && this.data.authCollection !== 'undefined')
        ? this.data.authCollection
        : ${JSON.stringify(specCollection)};
      const _Storage = require('or-sdk/storage');
      const _storage = new _Storage(this);
      const _creds = await _storage.get(_authCollection, _authInput).catch(() => null);
      const _apiKey = _creds && (_creds.apiKey || _creds.token || _creds.auth);
      if (!_apiKey) {
        return this.exitStep('__error__', { code: 'AUTH_RETRIEVAL_FAILED', message: 'Could not resolve API credential' });
      }
      const auth = _apiKey;`;

    return {
      edits: [{
        oldText: oldOpen,
        newText: `${oldOpen}${canonical}\n`,
        rationale: `Injected canonical storage.get() auth block with collection="${specCollection}" (${collectionReason}).`,
      }],
      rationale: `Added canonical or-sdk/storage auth resolution for collection "${specCollection}".`,
    };
  },
});

// Defect: STEP_LOGIC_HARDCODED_MERGE_REF — this.mergeFields['name'] usage.
// Fix: REQUIRES an LLM because renaming a merge-field ref to this.data.X
// requires knowing the intended input name. Emit a marker edit that adds a
// TODO comment so the LLM patcher can pick it up with full context.
//
// Included here to document: NOT all known-issues get a deterministic fix.
// This one's a "route to LLM" entry.
PATCHERS.push({
  id: 'STEP_LOGIC_HARDCODED_MERGE_REF',
  severity: 'error',
  description: 'Step reads this.mergeFields["X"] directly, coupling to a specific upstream. Requires LLM to rewrite because the target input name depends on intent.',
  match() { return null; },  // deliberately no deterministic fix
  requiresLLM: true,
});

// ---------------------------------------------------------------------------
// string/comment stripping — so regex-based matchers don't touch literals
// ---------------------------------------------------------------------------
function stripStringsAndComments(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // line comment
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // block comment
    if (c === '/' && s[i + 1] === '*') {
      out += '  ';
      i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  ';
      i += 2;
      continue;
    }
    // strings + templates
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' ';
      i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) { out += '  '; i += 2; continue; }
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += ' ';
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// stripCommentsOnly — blank out `//` and `/* */` comment CONTENT but keep
// everything else (including string literals) intact. Used by HARDCODED_URL
// so URLs inside comments aren't falsely matched, while URLs that are
// genuine string literals (the ones we DO want to replace) remain visible.
// Byte positions are preserved — each comment char becomes a space (newlines
// preserved) so downstream replacements on the original string still align.
function stripCommentsOnly(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    // Line comment
    if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    // Block comment
    if (c === '/' && s[i + 1] === '*') {
      out += '  '; i += 2;
      while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) {
        out += s[i] === '\n' ? '\n' : ' ';
        i++;
      }
      out += '  '; i += 2;
      continue;
    }
    // String literal — preserve content (URLs in strings are valid targets)
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += c; i++;
      while (i < s.length && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < s.length) { out += s[i] + s[i + 1]; i += 2; continue; }
        out += s[i]; i++;
      }
      if (i < s.length) { out += s[i]; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let c = 0, idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) { c++; idx += needle.length; }
  return c;
}

// ---------------------------------------------------------------------------
// findPatches — run all registered deterministic patchers against a file.
//
// Returns: { patchable: [{id, edits, rationale}], requiresLLM: [{id, description}] }
// ---------------------------------------------------------------------------
function findPatches(fileContents, context = {}) {
  const patchable = [];
  const requiresLLM = [];
  for (const p of PATCHERS) {
    if (p.requiresLLM) {
      // These never match deterministically but DO classify the file as
      // needing LLM attention. We don't call the LLM here — caller decides.
      // TODO: have a detect() function separate from the deterministic match.
      continue;
    }
    try {
      const result = p.match(fileContents, context);
      if (result && Array.isArray(result.edits) && result.edits.length > 0) {
        patchable.push({ id: p.id, severity: p.severity, rationale: result.rationale, edits: result.edits });
      }
    } catch (err) {
      // A patcher error shouldn't kill the pipeline — log and skip.
      patchable.push({ id: p.id, severity: 'warn', error: err.message, edits: [] });
    }
  }
  return { patchable, requiresLLM };
}

// ---------------------------------------------------------------------------
// proposeLLMEdits — narrow LLM call for defects that need reasoning.
//
// The LLM is given:
//   - the broken code snippet (NOT the whole file — just the relevant function)
//   - the specific diagnostic message + optional suggested fix from the validator
//   - a library reference snippet (a known-working version of the same pattern)
//
// The LLM MUST respond with a JSON array of {oldText, newText, rationale}.
// Anything else is rejected.
//
// Each edit is then validated with validateEditAgainstContents BEFORE being
// returned. Invalid edits (no match or multi-match) are filtered out and the
// LLM is re-prompted with "your edit #N didn't apply — here's why; produce
// a different one."
// ---------------------------------------------------------------------------
async function proposeLLMEdits({ brokenCode, diagnostic, libraryRef, callLLM, maxAttempts = 2, budget = null, log = () => {} }) {
  if (typeof callLLM !== 'function') throw new Error('proposeLLMEdits requires a callLLM function');
  const system = [
    'You are a surgical code patcher. Your job is to produce the SMALLEST possible edit that resolves the stated defect.',
    '',
    'CRITICAL RULES:',
    '1. Output ONLY a JSON array. No prose. No code fences. Just `[{...}, {...}]`.',
    '2. Each edit must be {oldText, newText, rationale}.',
    '3. oldText must be an EXACT substring of the broken code, including whitespace.',
    '4. oldText must be SHORT — fewer than 15 lines. If you need to change more, produce multiple narrow edits.',
    '5. oldText must appear EXACTLY ONCE in the broken code. Include surrounding context if needed for uniqueness.',
    '6. newText is the replacement. May be empty string for deletions.',
    '7. rationale is a one-sentence explanation.',
    '8. DO NOT modify anything unrelated to the stated defect.',
    '9. DO NOT restructure, rename, reformat, or "improve" code unless the defect specifically requires it.',
    '',
    'If you cannot produce a safe edit, output an empty array `[]`.',
  ].join('\n');

  const userParts = [
    '## Broken code',
    '```js',
    brokenCode,
    '```',
    '',
    '## Defect',
    diagnostic.message || JSON.stringify(diagnostic),
    diagnostic.fix ? `\nSuggested fix: ${diagnostic.fix}` : '',
  ];
  if (libraryRef) {
    userParts.push('', '## Working reference (same pattern, known good)', '```js', libraryRef, '```');
  }
  userParts.push('', 'Produce the JSON array of edits now:');
  const userPrompt = userParts.join('\n');

  let attempt = 0;
  let lastErrors = [];
  while (attempt < maxAttempts) {
    // Budget gate: if caller provided a budget, check it before each call.
    if (budget) {
      const c = budget.check('llm');
      if (!c.ok) {
        log(`proposeLLMEdits budget exceeded: ${c.reason}`);
        return { ok: false, edits: [], errors: [`budget.${c.reason}`], attempts: attempt, budgetExceeded: true };
      }
      budget.record('llm');
    }
    attempt++;
    log(`proposeLLMEdits attempt ${attempt}/${maxAttempts}`);
    const retryPrompt = lastErrors.length > 0
      ? [userPrompt, '', '## Your previous attempt had these problems:', ...lastErrors.map((e, i) => `${i + 1}. ${e}`), '', 'Produce a corrected JSON array:'].join('\n')
      : userPrompt;

    let rawResponse;
    try {
      rawResponse = await callLLM(system, retryPrompt);
    } catch (err) {
      lastErrors = [`LLM call threw: ${err.message}`];
      continue;
    }
    // Parse — strip anything that isn't the JSON array.
    let parsed;
    try {
      const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { lastErrors = ['Response contained no JSON array.']; continue; }
      parsed = JSON.parse(jsonMatch[0]);
    } catch (err) {
      lastErrors = [`JSON parse failed: ${err.message}. Response started with: ${rawResponse.slice(0, 100)}`];
      continue;
    }
    if (!Array.isArray(parsed)) { lastErrors = ['Top-level value must be an array.']; continue; }
    // Validate each edit shape + uniqueness against brokenCode
    const validated = [];
    const errors = [];
    for (let i = 0; i < parsed.length; i++) {
      const e = parsed[i];
      if (!e || typeof e !== 'object') {
        errors.push(`edit[${i}] is not an object`);
        continue;
      }
      if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
        errors.push(`edit[${i}] missing oldText or newText`);
        continue;
      }
      if (e.oldText.split('\n').length > 15) {
        errors.push(`edit[${i}] oldText is ${e.oldText.split('\n').length} lines (max 15). Split into multiple narrower edits.`);
        continue;
      }
      const check = validateEditAgainstContents({ file: 'virtual', oldText: e.oldText, newText: e.newText }, brokenCode);
      if (!check.canApply) {
        errors.push(`edit[${i}] cannot apply: ${check.reason}${check.matchCount ? ` (${check.matchCount} matches)` : ''}`);
        continue;
      }
      validated.push({ oldText: e.oldText, newText: e.newText, rationale: e.rationale || '' });
    }
    if (errors.length === 0) {
      log(`proposeLLMEdits ok — ${validated.length} edit(s)`);
      return { ok: true, edits: validated, attempts: attempt };
    }
    lastErrors = errors;
    log(`proposeLLMEdits attempt ${attempt} had ${errors.length} problem(s); retrying`);
  }
  return { ok: false, edits: [], errors: lastErrors, attempts: attempt };
}

module.exports = {
  findPatches,
  proposeLLMEdits,
  PATCHERS,
  // exposed for testing
  _internal: { stripStringsAndComments, countOccurrences },
};
