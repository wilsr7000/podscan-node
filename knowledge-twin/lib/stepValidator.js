// ---------------------------------------------------------------------------
// Step Validator — code linting, formatting, and event-manager usage checks
// for OneReach Edison step template code
// ---------------------------------------------------------------------------

function diag(code, severity, message, fix, context, phase) {
  const d = { code, severity, message, fix };
  if (context !== undefined) d.context = context;
  if (phase !== undefined) d.phase = phase;
  return d;
}

const SECRET_VALUE_PATTERNS_INPUT = [
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
  { re: /\bsk-[a-zA-Z0-9]{20,}/, label: 'OpenAI / Stripe secret key' },
  { re: /\bsk-ant-[a-zA-Z0-9\-_]{20,}/, label: 'Anthropic API key' },
  { re: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub personal access token' },
  { re: /\bgho_[a-zA-Z0-9]{36}\b/, label: 'GitHub OAuth token' },
  { re: /\bglpat-[a-zA-Z0-9\-_]{20,}\b/, label: 'GitLab personal access token' },
  { re: /\bxox[baprs]-[a-zA-Z0-9\-]{10,}/, label: 'Slack token' },
  { re: /\bSG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}\b/, label: 'SendGrid API key' },
  { re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: 'PEM private key' },
  { re: /\beyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/, label: 'JWT token' },
];

// ---------------------------------------------------------------------------
// Condition Builder Validation — shared logic for renderConditionBuilder,
// disableConditionBuilder, and exit conditionBuilder objects
// ---------------------------------------------------------------------------

const VALID_RULE_VALUE_TYPES = new Set(['boolean', 'string', 'number', 'advanced', 'merge-field', 'date', 'array']);
const VALID_RULE_TYPES = new Set(['single', 'double']);

function validateConditionBuilder(cb, prefix, builderName, index, varName, stepInputs, currentInp, out) {
  if (cb.trueValue !== undefined && !['any', 'all'].includes(cb.trueValue)) {
    out.push(diag(`${diagCodeForBuilder(builderName, 'INVALID_TRUEVALUE')}`, 'warning',
      `${prefix}: ${builderName}.trueValue must be "any" or "all", got "${cb.trueValue}"`,
      `Set ${builderName}.trueValue to "any" (match any rule) or "all" (match all rules)`,
      { index, variable: varName, trueValue: cb.trueValue }));
  }
  if (cb.defaultValue !== undefined && typeof cb.defaultValue !== 'boolean') {
    out.push(diag(`${diagCodeForBuilder(builderName, 'INVALID_DEFAULT')}`, 'warning',
      `${prefix}: ${builderName}.defaultValue must be a boolean, got ${typeof cb.defaultValue}`,
      `Set ${builderName}.defaultValue to true or false`,
      { index, variable: varName }));
  }
  if (cb.rules !== undefined && !Array.isArray(cb.rules)) {
    out.push(diag(`${diagCodeForBuilder(builderName, 'INVALID_RULES')}`, 'warning',
      `${prefix}: ${builderName}.rules must be an array`,
      `Set ${builderName}.rules to an array of condition rule objects`,
      { index, variable: varName }));
  }
  if (Array.isArray(cb.rules) && cb.rules.length > 0) {
    for (let ri = 0; ri < cb.rules.length; ri++) {
      const rule = cb.rules[ri];
      if (!rule || typeof rule !== 'object') continue;

      // Field reference validation: firstValue often references "schema.variableName"
      const firstVal = rule.firstValue;
      if (firstVal && typeof firstVal === 'string' && stepInputs) {
        const schemaMatch = firstVal.match(/^schema\.(\w+)/);
        if (schemaMatch) {
          const refVar = schemaMatch[1];
          const refExists = stepInputs.some(other =>
            other?.data?.variable === refVar && other !== currentInp
          );
          if (!refExists) {
            out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_REF_MISSING')}`, 'warning',
              `${prefix}: ${builderName}.rules[${ri}].firstValue references "schema.${refVar}" but no formBuilder input defines "${refVar}"`,
              `Add an input with variable: "${refVar}" to formBuilder, or fix the rule's firstValue`,
              { index, variable: varName, ruleIndex: ri, referencedField: refVar }));
          }
        }
      }

      // Fallback: legacy field/variable/name reference
      const ruleField = rule.field || rule.variable || rule.name;
      if (ruleField && typeof ruleField === 'string' && !firstVal) {
        const stripped = ruleField.replace(/^`+|`+$/g, '').trim();
        if (stripped && stepInputs) {
          const refExists = stepInputs.some(other =>
            other?.data?.variable === stripped && other !== currentInp
          );
          if (!refExists) {
            out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_REF_MISSING')}`, 'warning',
              `${prefix}: ${builderName}.rules[${ri}] references field "${stripped}" but no formBuilder input defines that variable`,
              `Add an input with variable: "${stripped}" to formBuilder, or fix the rule's field reference`,
              { index, variable: varName, ruleIndex: ri, referencedField: stripped }));
          }
        }
      }

      // Rule type structure
      if (rule.ruleType && typeof rule.ruleType === 'object') {
        if (rule.ruleType.type && !VALID_RULE_TYPES.has(rule.ruleType.type)) {
          out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_INVALID_TYPE')}`, 'info',
            `${prefix}: ${builderName}.rules[${ri}].ruleType.type "${rule.ruleType.type}" is not a recognized type (expected "single" or "double")`,
            'Rule type should be "single" (one operand, e.g. "is true") or "double" (two operands, e.g. "equals")',
            { index, variable: varName, ruleIndex: ri, ruleType: rule.ruleType.type }));
        }
        if (rule.ruleType.func && typeof rule.ruleType.func === 'string') {
          try {
            new Function('firstValue', 'secondValue', rule.ruleType.func);
          } catch (parseErr) {
            out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_FUNC_INVALID')}`, 'error',
              `${prefix}: ${builderName}.rules[${ri}].ruleType.func is not valid JavaScript — ${parseErr.message}`,
              'Fix the function body syntax. The func is executed as function(firstValue, secondValue) { ... }',
              { index, variable: varName, ruleIndex: ri, parseError: parseErr.message }));
          }
        }
      } else if (rule.ruleType !== undefined && rule.ruleType !== '' && typeof rule.ruleType !== 'string') {
        out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_INVALID_TYPE')}`, 'warning',
          `${prefix}: ${builderName}.rules[${ri}].ruleType must be an object with {func, type, input, label} or an empty string`,
          'Set ruleType to an object or "" (for advanced/code mode rules)',
          { index, variable: varName, ruleIndex: ri }));
      }

      // valueType validation
      if (rule.valueType && typeof rule.valueType === 'string' && !VALID_RULE_VALUE_TYPES.has(rule.valueType)) {
        out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_INVALID_VALUE_TYPE')}`, 'info',
          `${prefix}: ${builderName}.rules[${ri}].valueType "${rule.valueType}" is not a recognized value type`,
          `Known value types: ${[...VALID_RULE_VALUE_TYPES].join(', ')}`,
          { index, variable: varName, ruleIndex: ri, valueType: rule.valueType }));
      }

      // codeValue (advanced mode) syntax check
      if (rule.valueType === 'advanced' && rule.codeValue && typeof rule.codeValue === 'string') {
        const cv = rule.codeValue.replace(/^`+|`+$/g, '').trim();
        if (cv) {
          try {
            new Function('schema', `return (${cv});`);
          } catch (parseErr) {
            out.push(diag(`${diagCodeForBuilder(builderName, 'RULE_CODEVALUE_INVALID')}`, 'error',
              `${prefix}: ${builderName}.rules[${ri}].codeValue "${cv}" is not a valid JavaScript expression — ${parseErr.message}`,
              'Fix the expression syntax. codeValue is evaluated as a JS expression with schema in scope.',
              { index, variable: varName, ruleIndex: ri, parseError: parseErr.message }));
          }
        }
      }
    }
  }
}

function diagCodeForBuilder(builderName, suffix) {
  if (builderName === 'renderConditionBuilder') return `RENDER_CONDITION_${suffix}`;
  if (builderName === 'disableConditionBuilder') return `DISABLE_CONDITION_${suffix}`;
  if (builderName === 'conditionBuilder') return `EXIT_CONDITION_${suffix}`;
  return `CONDITION_${suffix}`;
}

// ---------------------------------------------------------------------------
// Input Classification — detect what type of string was submitted
// ---------------------------------------------------------------------------

const JS_KEYWORDS = /\b(function|const|let|var|class|return|if|else|for|while|switch|case|try|catch|throw|new|await|async|import|export|require)\b/g;
const CODE_SYNTAX = /[{};=()=>]/g;

function classifyInput(text) {
  if (!text || typeof text !== 'string') return { type: 'unknown', confidence: 0 };
  const trimmed = text.trim();
  if (!trimmed) return { type: 'unknown', confidence: 0 };

  const hasStepClass = /extends\s+Step\b/.test(trimmed) || /class\s+\w+\s+extends/.test(trimmed);
  const hasExitStep = /this\.exitStep\s*\(/.test(trimmed);
  const hasStepExport = /export\s*\{[^}]*step[^}]*\}/.test(trimmed);
  if (hasStepClass || (hasExitStep && hasStepExport)) {
    return { type: 'step-template', confidence: 0.95 };
  }

  const lines = trimmed.split('\n');
  const kwMatches = trimmed.match(JS_KEYWORDS) || [];
  const syntaxMatches = trimmed.match(CODE_SYNTAX) || [];
  const kwDensity = kwMatches.length / Math.max(lines.length, 1);
  const synDensity = syntaxMatches.length / Math.max(trimmed.length, 1);

  const funcMatch = trimmed.match(/(?:(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)|const\s+(\w+)\s*=\s*(?:async\s*)?\(([^)]*)\)\s*=>|(?:async\s+)?function\s*\(([^)]*)\))/);
  let detectedName = null;
  let detectedParams = null;
  if (funcMatch) {
    detectedName = funcMatch[1] || funcMatch[3] || null;
    const paramStr = funcMatch[2] || funcMatch[4] || funcMatch[5] || '';
    detectedParams = paramStr.split(',').map(p => p.trim().replace(/[=:].*$/, '').replace(/[{}[\]]/g, '').trim()).filter(Boolean);
  }

  const returnMatch = trimmed.match(/return\s+(\{[^}]+\})/);
  const detectedReturns = returnMatch ? returnMatch[1] : null;

  if ((kwMatches.length >= 2 && kwDensity >= 0.3) || synDensity >= 0.04 || funcMatch) {
    return { type: 'javascript', confidence: Math.min(kwDensity / 0.5 + synDensity / 0.06, 1), detectedName, detectedParams, detectedReturns };
  }

  const pseudoIndicators = /\b(get|set|call|check|fetch|send|store|read|write|parse|validate|process|loop|iterate)\b/i;
  const hasArrow = /->|→|=>/.test(trimmed);
  const hasAssign = /\b\w+\s*=\s*\w/.test(trimmed);
  if ((pseudoIndicators.test(trimmed) && (hasArrow || hasAssign || kwMatches.length >= 2)) || (kwMatches.length >= 2 && kwMatches.length < lines.length * 0.3)) {
    return { type: 'pseudocode', confidence: 0.6, detectedName, detectedParams };
  }

  return { type: 'natural-language', confidence: 0.8, detectedName: null, detectedParams: null };
}

// ---------------------------------------------------------------------------
// 1. Code Linting — lightweight ESLint-equivalent checks
// ---------------------------------------------------------------------------

function stripStrings(line) {
  let out = '';
  let inSingle = false, inDouble = false, inTemplate = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inSingle) { if (ch === '\\') { out += '  '; i++; continue; } if (ch === "'") inSingle = false; else { out += ' '; continue; } }
    if (inDouble) { if (ch === '\\') { out += '  '; i++; continue; } if (ch === '"') inDouble = false; else { out += ' '; continue; } }
    if (inTemplate) { if (ch === '\\') { out += '  '; i++; continue; } if (ch === '`') inTemplate = false; else { out += ' '; continue; } }
    if (ch === "'") { inSingle = true; out += ch; continue; }
    if (ch === '"') { inDouble = true; out += ch; continue; }
    if (ch === '`') { inTemplate = true; out += ch; continue; }
    out += ch;
  }
  return out;
}

function isClassBased(code) {
  return /(?:module\s*\.\s*exports)|(?:exports\s*\.\s*step)\s*=|(?:^export\s)/m.test(code);
}

function lintCode(code, out) {
  const lines = code.split('\n');

  lines.forEach((line, i) => {
    const num = i + 1;
    const trimmed = line.trimStart();

    const stripped = stripStrings(trimmed);
    const isComment = trimmed.startsWith('//') || trimmed.startsWith('*');

    // var declarations
    if (!isComment && /\bvar\s+\w/.test(stripped)) {
      out.push(diag('NO_VAR', 'warning',
        `Line ${num}: Use "const" or "let" instead of "var"`,
        'Replace "var" with "const" (preferred) or "let" if reassigned',
        { line: num, text: trimmed.trim() }));
    }

    // == and != (loose equality), avoiding === and !==
    if (!isComment && /[^!=<>]==[^=]/.test(stripped)) {
      out.push(diag('EQEQ', 'warning',
        `Line ${num}: Use "===" instead of "=="`,
        'Replace "==" with "===" for strict equality',
        { line: num }));
    }
    if (!isComment && /!=[^=]/.test(stripped)) {
      out.push(diag('EQEQ', 'warning',
        `Line ${num}: Use "!==" instead of "!="`,
        'Replace "!=" with "!==" for strict inequality',
        { line: num }));
    }

    // console.log left in code
    if (!isComment && /\bconsole\.(log|warn|error|info|debug|trace)\b/.test(stripped)) {
      out.push(diag('NO_CONSOLE', 'warning',
        `Line ${num}: console.${trimmed.match(/console\.(\w+)/)[1]}() found — use this.log() or remove`,
        'Edison step code should use this.log() instead of console methods. console calls are swallowed at runtime.',
        { line: num }));
    }

    // empty catch blocks (allow if body has only a comment)
    if (/catch\s*\([^)]*\)\s*\{\s*\}/.test(trimmed) && !/catch\s*\([^)]*\)\s*\{\s*\/[/*]/.test(trimmed)) {
      out.push(diag('NO_EMPTY_CATCH', 'warning',
        `Line ${num}: Empty catch block — errors are silently swallowed`,
        'Log or rethrow the error, or add a comment explaining why it is safe to ignore',
        { line: num }));
    }

    // debugger statement
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      out.push(diag('NO_DEBUGGER', 'error',
        `Line ${num}: "debugger" statement will break execution at runtime`,
        'Remove the debugger statement',
        { line: num }));
    }

    // eval usage
    if (!isComment && /\beval\s*\(/.test(stripped)) {
      out.push(diag('NO_EVAL', 'error',
        `Line ${num}: eval() is a security risk and may be blocked at runtime`,
        'Replace eval() with a safer alternative (JSON.parse, Function constructor, etc.)',
        { line: num }));
    }

    // new Function() (security risk similar to eval)
    if (!isComment && /new\s+Function\s*\(/.test(stripped)) {
      out.push(diag('NO_NEW_FUNCTION', 'warning',
        `Line ${num}: new Function() is similar to eval and may be blocked`,
        'Refactor to avoid dynamic code generation',
        { line: num }));
    }

    // unreachable code after return (heuristic — only flags when return is
    // at the same or lower indent as the following line, reducing false positives
    // from returns inside if/else blocks)
    if (/^\s*return\b/.test(line) && i + 1 < lines.length) {
      const returnIndent = line.search(/\S/);
      const nextLine = lines[i + 1];
      const nextTrimmed = nextLine.trim();
      const nextIndent = nextLine.search(/\S/);
      if (nextTrimmed && !nextTrimmed.startsWith('}') && !nextTrimmed.startsWith('//') &&
          !nextTrimmed.startsWith('*') && !nextTrimmed.startsWith('case ') &&
          !nextTrimmed.startsWith('default:') && nextTrimmed !== '' &&
          nextIndent <= returnIndent) {
        out.push(diag('UNREACHABLE_CODE', 'info',
          `Line ${num + 1}: Possible unreachable code after return statement`,
          'Verify this code is reachable, or remove it',
          { line: num + 1 }));
      }
    }

    // throw string literal instead of Error
    if (/\bthrow\s+['"`]/.test(stripped)) {
      out.push(diag('THROW_ERROR_OBJECT', 'warning',
        `Line ${num}: Throwing a string literal instead of an Error object`,
        'Use "throw new Error(message)" for proper stack traces',
        { line: num }));
    }

    // excessive line length
    if (line.length > 200) {
      out.push(diag('LINE_TOO_LONG', 'info',
        `Line ${num}: Line is ${line.length} characters long (recommended max: 200)`,
        'Break long lines for readability',
        { line: num, length: line.length }));
    }
  });

  // detect hardcoded secrets / credentials
  const SECRET_VALUE_PATTERNS = [
    { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS Access Key ID' },
    { re: /\bsk-[a-zA-Z0-9]{20,}/, label: 'OpenAI / Stripe secret key' },
    { re: /\bghp_[a-zA-Z0-9]{36}\b/, label: 'GitHub personal access token' },
    { re: /\bgho_[a-zA-Z0-9]{36}\b/, label: 'GitHub OAuth token' },
    { re: /\bglpat-[a-zA-Z0-9\-_]{20,}\b/, label: 'GitLab personal access token' },
    { re: /\bxox[baprs]-[a-zA-Z0-9\-]{10,}/, label: 'Slack token' },
    { re: /\bSG\.[a-zA-Z0-9\-_]{22}\.[a-zA-Z0-9\-_]{43}\b/, label: 'SendGrid API key' },
    { re: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/, label: 'PEM private key' },
    { re: /\beyJ[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}\.[a-zA-Z0-9\-_]{20,}/, label: 'JWT token' },
  ];
  const secretLines = new Set();
  for (const { re, label } of SECRET_VALUE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    while ((m = globalRe.exec(code)) !== null) {
      const lineNum = code.substring(0, m.index).split('\n').length;
      if (!secretLines.has(`${lineNum}:${label}`)) {
        secretLines.add(`${lineNum}:${label}`);
        out.push(diag('SECRET_IN_CODE', 'error',
          `Line ${lineNum}: Code contains what looks like a ${label} — secrets must not be hardcoded in step template code`,
          'Use environment variables (process.env.VAR), merge fields, or a secrets manager instead of hardcoding credentials',
          { line: lineNum, secretType: label }));
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rule 12.4 — UNSANITIZED_LLM_INPUT
  //
  // If the step builds an LLM prompt (messages: [...] or a variable ending in
  // `prompt`/`messages`) and interpolates user-supplied text via `${...}` or
  // string concatenation without a length-cap / role-strip / xml-wrap pass,
  // flag it. Prompt-injection protection should happen before the untrusted
  // text enters the prompt — we can't prove sanitization post-hoc, but we can
  // flag the textbook unsafe pattern.
  // -----------------------------------------------------------------------
  {
    const llmContextRe = /(messages\s*:|content\s*:\s*`|prompt\s*[:=]|\bprompt\b.*=.*`)/;
    const hasLlmContext = llmContextRe.test(code);
    if (hasLlmContext) {
      // Find merge-field / this.data interpolations inside a backtick string.
      const linesArr = code.split('\n');
      for (let li = 0; li < linesArr.length; li++) {
        const ln = linesArr[li];
        const interp = /`[^`]*\$\{\s*(?:this\.data\.\w+|this\.mergeFields[^}]+)[^`]*`/.test(ln)
          || /`[^`]*\$\{\s*\w+\s*\}[^`]*`/.test(ln);
        const isInPromptContext = /prompt|messages|content/i.test(ln);
        const hasSanitize = /\.slice\s*\(\s*0\s*,|\.substring\s*\(|role\s*:|\[role\]:|<user_content>|xml|escape|sanitize|strip|replace\s*\(\s*\/\^\s*\(system\|user/i.test(
          // scan a ~5-line window to find the sanitization pass
          linesArr.slice(Math.max(0, li - 5), li + 1).join('\n')
        );
        if (interp && isInPromptContext && !hasSanitize) {
          out.push(diag('UNSANITIZED_LLM_INPUT', 'warning',
            `Line ${li + 1}: User-supplied text is interpolated directly into an LLM prompt with no visible sanitization pass (length cap, role-override strip, xml-tag wrap)`,
            'Before concatenating, run: String(userText).slice(0, 4000).replace(/^(system|user|assistant)\\s*:/gmi, "[role]:") and wrap in <user_content>…</user_content>. See §12.4.',
            { line: li + 1 }));
          break;  // one flag per step is enough
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Rule 15.10 — UNGUARDED_RUNTIME_API
  //
  // `this.reporter.*` and `this.session.*` are provided by the thread service
  // proxy; they exist at runtime in Edison but are not guaranteed in local
  // harnesses or alt-runtime contexts (subflows, gateway early-init). Code
  // that calls them without a nullish guard crashes if the accessor is absent.
  // -----------------------------------------------------------------------
  {
    const lines2 = code.split('\n');
    const unguardedRe = /\bthis\.(reporter|session)\.(\w+)\s*\(/;
    for (let li = 0; li < lines2.length; li++) {
      const ln = lines2[li];
      if (!unguardedRe.test(ln)) continue;
      // Allow optional-chaining (this.reporter?.fire(...)) or a preceding
      // typeof / && guard on the same or previous line.
      if (/this\.(reporter|session)\?\./.test(ln)) continue;
      const prev = li > 0 ? lines2[li - 1] : '';
      const window = (prev + '\n' + ln);
      if (/typeof\s+this\.(reporter|session)\b/.test(window)) continue;
      if (/this\.(reporter|session)\s*&&\s*this\.(reporter|session)\./.test(window)) continue;
      const match = unguardedRe.exec(ln);
      out.push(diag('UNGUARDED_RUNTIME_API', 'warning',
        `Line ${li + 1}: this.${match[1]}.${match[2]}() called without a nullish guard — the accessor can be absent in alternate runtimes (local harness, subflows, early gateway init)`,
        `Use optional chaining: this.${match[1]}?.${match[2]}(...) — or guard with typeof/&&.`,
        { line: li + 1, api: `${match[1]}.${match[2]}` }));
    }
  }

  // -----------------------------------------------------------------------
  // Detect hardcoded configurable values in step code.
  // Steps are reusable components — any value a flow builder might need to
  // change (URLs, model names, thresholds, collection names) must come from
  // this.data (i.e. a formBuilder input), not be baked into the source.
  // -----------------------------------------------------------------------
  {
    const codeLines = code.split('\n');
    const reported = new Set();

    // Helper: skip if this line is a comment or inside a JSDoc/block comment
    let inBlock = false;
    const effectiveLines = codeLines.map((ln, idx) => {
      const trimmed = ln.trim();
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false;
        return { line: ln, num: idx + 1, skip: true };
      }
      if (trimmed.startsWith('/*')) {
        inBlock = !trimmed.includes('*/');
        return { line: ln, num: idx + 1, skip: true };
      }
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) {
        return { line: ln, num: idx + 1, skip: true };
      }
      return { line: ln, num: idx + 1, skip: false };
    });

    // Collect all this.data reads so we can check if a value is already an input
    const dataVarReads = new Set();
    const dvRe = /this\.data(?:\?)?\.(\w+)/g;
    let dvM;
    while ((dvM = dvRe.exec(code)) !== null) dataVarReads.add(dvM[1]);

    // 1. Hardcoded API/HTTP URLs in fetch(), http.get(), axios, etc.
    //    Exceptions: well-known SDK/runtime URLs, localhost for tests, and
    //    URLs constructed from this.data or variables.
    //    Also skip constants used as fallback defaults: const X = 'url' + this.data.y || X
    // Exempt: platform plumbing and SDK/CDN endpoints. These are CONSTANTS
    // across the platform (or per-account but stable) — not user/flow data.
    // Per user direction (2026-04-19): "URLs for components or SDKs don't
    // make sense" as form inputs. Only flag URLs that carry flow-specific
    // data (e.g., an API endpoint the user chose, a model provider, etc.).
    const URL_EXEMPT = /localhost|127\.0\.0\.1|example\.com|schema\.org|json-schema\.org|w3\.org|github\.com\/|gist\.|jsdelivr|unpkg|cdnjs|content-assets\.onereach\.ai|\.edison\.api\.onereach\.ai|sdkapi[.-].*\.onereach\.ai/i;
    const urlConstantNames = new Set();
    for (const { line, skip } of effectiveLines) {
      if (skip) continue;
      const constMatch = line.match(/(?:const|let|var)\s+(\w+)\s*=\s*['"`](https?:\/\/[^'"`]+)['"`]/);
      if (constMatch) urlConstantNames.add(constMatch[1]);
    }
    const urlConstantUsedAsFallback = new Set();
    for (const cName of urlConstantNames) {
      const fallbackRe = new RegExp(`this\\.data\\.\\w+\\s*\\|\\|\\s*${cName}\\b`);
      if (fallbackRe.test(code)) urlConstantUsedAsFallback.add(cName);
    }
    for (const { line, num, skip } of effectiveLines) {
      if (skip) continue;
      let isFallbackDef = false;
      for (const cName of urlConstantUsedAsFallback) {
        const defRe = new RegExp(`(?:const|let|var)\\s+${cName}\\s*=`);
        if (defRe.test(line)) { isFallbackDef = true; break; }
      }
      if (isFallbackDef) continue;
      const urlMatches = line.matchAll(/['"`](https?:\/\/[^'"`\s]{10,})['"`]/g);
      for (const um of urlMatches) {
        const url = um[1];
        if (URL_EXEMPT.test(url)) continue;
        // Skip if URL is being assigned to/from this.data
        if (/this\.data/.test(line)) continue;
        // Skip if URL is a variable interpolation building from an input
        if (/\$\{/.test(url) && /this\.data|baseUrl|endpoint|apiUrl|host/i.test(url)) continue;
        const key = `URL:${num}`;
        if (reported.has(key)) continue;
        reported.add(key);
        out.push(diag('HARDCODED_URL', 'error',
          `Line ${num}: Hardcoded URL "${url.length > 80 ? url.slice(0, 77) + '...' : url}" — ` +
          `API endpoints must be configurable inputs so the step can be reused across environments and flows`,
          `Extract the URL into a this.data input (e.g. this.data.apiUrl) with a formBuilder field that has allowMergeFields: true. ` +
          `Set the current URL as the defaultValue so it works out of the box.`,
          { line: num, url: url.slice(0, 120) }));
      }
    }

    // 2. Hardcoded LLM model identifiers
    const MODEL_RE = /['"`](claude-[a-z0-9._-]+|gpt-[a-z0-9._-]+|gemini-[a-z0-9._-]+|llama-[a-z0-9._-]+|mistral-[a-z0-9._-]+|command-[a-z0-9._-]+)['"`]/gi;
    const modelMatches = new Set();
    for (const { line, num, skip } of effectiveLines) {
      if (skip) continue;
      if (/this\.data/.test(line)) continue;
      // Skip lines that are default/fallback: || 'model' or ?? 'model'
      if (/\|\||[?]{2}/.test(line) && /this\.data|model/i.test(line)) continue;
      let mm;
      const lineModelRe = new RegExp(MODEL_RE.source, 'gi');
      while ((mm = lineModelRe.exec(line)) !== null) {
        const model = mm[1];
        const key = `MODEL:${model.toLowerCase()}`;
        if (modelMatches.has(key)) continue;
        modelMatches.add(key);
        // Don't flag if there's already a 'model' input
        if (dataVarReads.has('model') || dataVarReads.has('llmModel')) continue;
        out.push(diag('HARDCODED_MODEL', 'error',
          `Line ${num}: Hardcoded LLM model "${model}" — ` +
          `model identifiers change frequently and must be configurable so the step can be updated without editing code`,
          `Add a this.data.model input with a formBuilder field (allowMergeFields: true). ` +
          `Use the hardcoded value as the defaultValue: \`${model}\``,
          { line: num, model }));
      }
    }

    // 3. Hardcoded KV collection names (Edison storage)
    const COLLECTION_RE = /(?:collection|collectionName)\s*(?:=|:)\s*['"`]([^'"`\s$]{3,})['"`]/g;
    for (const { line, num, skip } of effectiveLines) {
      if (skip) continue;
      if (/this\.data/.test(line)) continue;
      let cm;
      const lineCollRe = new RegExp(COLLECTION_RE.source, 'g');
      while ((cm = lineCollRe.exec(line)) !== null) {
        const coll = cm[1];
        if (/^__authorization_service_/.test(coll)) continue;
        const key = `COLL:${num}`;
        if (reported.has(key)) continue;
        reported.add(key);
        if (dataVarReads.has('collection') || dataVarReads.has('collectionName')) continue;
        out.push(diag('HARDCODED_COLLECTION', 'warning',
          `Line ${num}: Hardcoded KV collection name "${coll}" — ` +
          `collection names should be configurable so the step can be used with different storage contexts`,
          `Add a this.data.collection input with a formBuilder field and set "${coll}" as the defaultValue`,
          { line: num, collection: coll }));
      }
    }

    // 4. Hardcoded numeric thresholds used as configuration
    //    Only flag constants assigned at the top scope that look like
    //    configuration (e.g. MAX_RETRIES = 3, TIMEOUT = 30000).
    const THRESHOLD_RE = /(?:const|let|var)\s+(MAX_\w+|MIN_\w+|LIMIT_\w+|TIMEOUT\w*|THRESHOLD\w*|RETRIES\w*|ATTEMPTS\w*|BATCH_SIZE\w*|PAGE_SIZE\w*|CONCURRENCY\w*)\s*=\s*(\d+)/gi;
    let tm;
    while ((tm = THRESHOLD_RE.exec(code)) !== null) {
      const varName = tm[1];
      const value = tm[2];
      const lineNum = code.substring(0, tm.index).split('\n').length;
      const camelName = varName.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase());
      if (dataVarReads.has(camelName) || dataVarReads.has(varName)) continue;
      out.push(diag('HARDCODED_THRESHOLD', 'warning',
        `Line ${lineNum}: Hardcoded configuration constant "${varName} = ${value}" — ` +
        `thresholds and limits should be configurable inputs so flow builders can tune them without editing code`,
        `Add a this.data.${camelName} input with a formBuilder field, and use ${value} as the defaultValue. ` +
        `Read it as: const ${varName} = Number(this.data.${camelName}) || ${value};`,
        { line: lineNum, variable: varName, value }));
    }
  }

  // detect async function without any await
  const asyncFnPattern = /async\s+(?:function\s+\w+|\(\w*\)\s*=>|\w+\s*=>)/g;
  let match;
  while ((match = asyncFnPattern.exec(code)) !== null) {
    const fnStart = match.index;
    const fnCode = extractBlock(code, fnStart);
    if (fnCode && !/\bawait\b/.test(fnCode)) {
      const lineNum = code.substring(0, fnStart).split('\n').length;
      out.push(diag('ASYNC_NO_AWAIT', 'warning',
        `Line ${lineNum}: async function never uses await`,
        'Either add an await expression or remove the async keyword',
        { line: lineNum }));
    }
  }

  // missing 'use strict' is fine in Edison (modules are strict), skip that check

  // duplicate function declarations in the same scope (top-level only)
  const fnDecls = new Map();
  const fnDeclPattern = /^(?:async\s+)?function\s+(\w+)/gm;
  while ((match = fnDeclPattern.exec(code)) !== null) {
    const name = match[1];
    const lineNum = code.substring(0, match.index).split('\n').length;
    if (fnDecls.has(name)) {
      out.push(diag('DUPLICATE_FUNCTION', 'warning',
        `Line ${lineNum}: Function "${name}" is declared again (first at line ${fnDecls.get(name)})`,
        'Rename one of the functions or merge them',
        { line: lineNum, firstLine: fnDecls.get(name), name }));
    } else {
      fnDecls.set(name, lineNum);
    }
  }

  // ---------------------------------------------------------------------------
  // Edison compiler compatibility — detect JS syntax the Edison UI compiler
  // (acorn-based, ~ES2020) cannot parse. These cause "SyntaxError" in the
  // Test tab and make the step appear red on the canvas.
  // ---------------------------------------------------------------------------

  // Numeric separators (ES2021) — the Edison compiler cannot parse them
  const numSepPattern = /\b\d+(?:_\d+)+\b/g;
  let numSepMatch;
  while ((numSepMatch = numSepPattern.exec(code)) !== null) {
    const lineNum = code.substring(0, numSepMatch.index).split('\n').length;
    const literal = numSepMatch[0];
    const fixed = literal.replace(/_/g, '');
    out.push(diag('NUMERIC_SEPARATOR', 'error',
      `Line ${lineNum}: Numeric separator "${literal}" is not supported by the Edison compiler (ES2021)`,
      `Replace with plain number: ${fixed}`,
      { line: lineNum, text: literal, fix: fixed }));
  }

  // EJS delimiters in code — literal open/close tags will cause the Edison
  // template compiler to attempt EJS evaluation, which breaks inside JS code.
  // The patterns are built via concatenation so this code itself is safe to embed.
  const ejsOpen = '<' + '%';
  const ejsClose = '%' + '>';
  const ejsOpenPattern = new RegExp(ejsOpen.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  const ejsClosePattern = new RegExp(ejsClose.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  let ejsMatch;
  while ((ejsMatch = ejsOpenPattern.exec(code)) !== null) {
    const lineNum = code.substring(0, ejsMatch.index).split('\n').length;
    const line = lines[lineNum - 1] || '';
    out.push(diag('EJS_DELIMITER_IN_CODE', 'error',
      `Line ${lineNum}: Literal "${ejsOpen}" in code triggers the Edison EJS compiler and causes SyntaxError`,
      'Split the string so the literal never appears: use string concatenation',
      { line: lineNum, text: line.trim().slice(0, 100) }));
  }
  while ((ejsMatch = ejsClosePattern.exec(code)) !== null) {
    const lineNum = code.substring(0, ejsMatch.index).split('\n').length;
    const line = lines[lineNum - 1] || '';
    out.push(diag('EJS_DELIMITER_IN_CODE', 'error',
      `Line ${lineNum}: Literal "${ejsClose}" in code triggers the Edison EJS compiler and causes SyntaxError`,
      'Split the string so the literal never appears: use string concatenation',
      { line: lineNum, text: line.trim().slice(0, 100) }));
  }

  // Private class fields (ES2022) — skip hex colors and other non-field # usages in strings
  const privateFieldPattern = /(?<!['"#&])#[a-zA-Z_][a-zA-Z0-9_]*/g;
  let pfMatch;
  while ((pfMatch = privateFieldPattern.exec(code)) !== null) {
    const lineNum = code.substring(0, pfMatch.index).split('\n').length;
    const line = lines[lineNum - 1] || '';
    const strippedLine = stripStrings(line);
    const colInStripped = pfMatch.index - code.lastIndexOf('\n', pfMatch.index - 1) - 1;
    if (strippedLine[colInStripped] === '#') {
      out.push(diag('PRIVATE_CLASS_FIELD', 'warning',
        `Line ${lineNum}: Private class field "${pfMatch[0]}" may not be supported by the Edison compiler`,
        'Use an underscore prefix (e.g., _' + pfMatch[0].slice(1) + ') or a WeakMap for truly private state',
        { line: lineNum, text: pfMatch[0] }));
    }
  }

  // -----------------------------------------------------------------------
  // Rule 2.3 — LIFECYCLE_LOG_FORMAT
  //
  // Every runStep() should emit:
  //   - one this.log.info at the top summarizing inputs received
  //   - this.log.error in every catch block (unguarded errors → CloudWatch silence)
  //
  // The reusability-judge LLM pass flags "missing lifecycle logs" at the prose
  // level; this deterministic rule catches the most common structural shapes
  // the judge doesn't reliably notice (empty catch with just a return, or
  // runStep opens straight into computation without a milestone log).
  // -----------------------------------------------------------------------
  {
    // Find runStep(...) { ... } block. Skip if absent — steps defined via
    // top-level functions (rare) don't exercise this rule.
    const runStepMatch = /\b(?:async\s+)?runStep\s*\([^)]*\)\s*\{/.exec(code);
    if (runStepMatch) {
      const bodyStart = runStepMatch.index + runStepMatch[0].length - 1;
      const block = extractBlock(code, bodyStart);
      if (block) {
        const runStepStartLine = code.slice(0, runStepMatch.index).split('\n').length;
        // Lifecycle A: top-of-body info log. Look at the first ~10 non-blank,
        // non-comment lines INSIDE the block for a this.log.{info,vital}
        // call. If all early lines are destructuring/validation with no log,
        // we warn. Allow early this.log.* at any level — a top trace/debug
        // beats nothing.
        const innerLines = block.split('\n').slice(1, 12);  // skip opening {
        let topInfoFound = false;
        for (const ln of innerLines) {
          const t = ln.trim();
          if (!t || t.startsWith('//') || t.startsWith('*')) continue;
          if (/\bthis\.log\.(info|vital|warn|debug|trace|INFO|VITAL|WARN|DEBUG|TRACE)\s*[?\(]/.test(ln)) {
            topInfoFound = true;
            break;
          }
        }
        if (!topInfoFound) {
          out.push(diag('LIFECYCLE_LOG_FORMAT', 'warning',
            `Line ${runStepStartLine}: runStep() has no this.log.info (or equivalent) near the top — CloudWatch will have no entry log when this step fires`,
            'Add a this.log.info at the start of runStep() summarizing the inputs received. Per §2.3 of platform-rules.md, every step should log an entry line so forensic searches against CloudWatch can find the invocation.',
            { line: runStepStartLine }));
        }

        // Lifecycle B: every catch block should log. Find `catch (name) { ... }`
        // inside runStep's body and check its body has a this.log.* call.
        // Allow `rethrow` (throw) or explicit `return this.exitStep('__error__'...)`
        // as acceptable substitutes for a log — both surface the error.
        const catchRe = /\bcatch\s*\(([^)]*)\)\s*\{/g;
        let cm;
        while ((cm = catchRe.exec(block)) !== null) {
          const cBodyStart = cm.index + cm[0].length - 1;
          const catchBlock = extractBlock(block, cBodyStart);
          if (!catchBlock) continue;
          const body = catchBlock.slice(1, -1);  // strip { }
          const hasLog = /\bthis\.log\.(error|fatal|vital|warn|ERROR|FATAL|VITAL|WARN)\s*[?\(]/.test(body);
          const hasRethrow = /\bthrow\b/.test(body);
          const hasErrorExit = /exitStep\s*\(\s*['"]__error__['"]|exitStep\s*\(\s*['"]__timeout__['"]/.test(body);
          if (!hasLog && !hasRethrow && !hasErrorExit) {
            // Line number of the catch keyword in the original code
            const bodyPrefixOffset = runStepMatch.index + runStepMatch[0].length - 1;
            const absIdx = bodyPrefixOffset + cm.index;
            const catchLine = code.slice(0, absIdx).split('\n').length;
            out.push(diag('LIFECYCLE_LOG_FORMAT', 'warning',
              `Line ${catchLine}: catch block has no this.log.error, no throw, and no exitStep('__error__', ...) — the error is silently swallowed`,
              'Add this.log.error(\'<class> caught error\', { error: err.message }) OR return this.exitStep(\'__error__\', { code: \'INTERNAL_ERROR\', message: err.message }) — otherwise CloudWatch has no record of the failure.',
              { line: catchLine }));
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// DEFAULT_VALUE_MISMATCH (spec-aware) — checks that `this.data.X || '<fallback>'`
// pattern in code matches the declared default on stepInputs[i].data.defaultValue.
// Runs in checkFormAndData (where spec context is available).
//
// Why: when the spec says defaultValue is 'current' and the code silently
// falls back to 'forecast' (or vice-versa), the step behaves differently from
// its documented contract. Reusability-judge sometimes catches this as a prose
// issue, but a deterministic check is faster and more reliable.
// ---------------------------------------------------------------------------
function checkDefaultValueMismatch(code, stepInputs, out) {
  if (!Array.isArray(stepInputs) || stepInputs.length === 0) return;
  const lines = code.split('\n');
  for (const inp of stepInputs) {
    const varName = inp?.data?.variable;
    let declared = inp?.data?.defaultValue;
    if (typeof varName !== 'string' || !varName) continue;
    if (declared === undefined || declared === null) continue;
    // Strip surrounding backticks if the default is a template-literal expression
    if (typeof declared === 'string') {
      declared = declared.replace(/^`|`$/g, '').trim();
    }
    if (declared === '') continue;

    // Look for `this.data.<varName>` reads with a literal fallback:
    //   const x = this.data.foo || 'literal';
    //   const x = this.data.foo ?? 'literal';
    //   this.data.foo !== 'undefined' ? this.data.foo : 'literal'
    // Only flag when the literal is a STRING literal and it materially differs
    // from the declared default.
    const escapedVar = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const patterns = [
      new RegExp(`this\\.data\\.${escapedVar}\\s*\\|\\|\\s*['"]([^'"]+)['"]`, 'g'),
      new RegExp(`this\\.data\\.${escapedVar}\\s*\\?\\?\\s*['"]([^'"]+)['"]`, 'g'),
      new RegExp(`this\\.data\\.${escapedVar}[^?]*\\?\\s*this\\.data\\.${escapedVar}\\s*:\\s*['"]([^'"]+)['"]`, 'g'),
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(code)) !== null) {
        const codeFallback = m[1];
        if (String(codeFallback) === String(declared)) continue;
        const lineNum = code.slice(0, m.index).split('\n').length;
        out.push(diag('DEFAULT_VALUE_MISMATCH', 'warning',
          `Line ${lineNum}: this.data.${varName} fallback is "${codeFallback}" but the spec declares defaultValue="${declared}" — step behavior diverges from its documented contract`,
          `Either change the code fallback to "${declared}" OR update the spec's stepInputs default to "${codeFallback}". Both should agree so flow authors get the documented behavior.`,
          { line: lineNum, variable: varName, codeFallback, specDefault: declared }));
        // Only flag the first occurrence per pattern per input
        break;
      }
    }
  }
}

function extractBlock(code, startIndex) {
  let depth = 0;
  let started = false;
  let inSingle = false, inDouble = false, inTemplate = false, inLineComment = false, inBlockComment = false;
  for (let i = startIndex; i < code.length; i++) {
    const ch = code[i];
    const next = code[i + 1];

    if (inLineComment) { if (ch === '\n') inLineComment = false; continue; }
    if (inBlockComment) { if (ch === '*' && next === '/') { inBlockComment = false; i++; } continue; }
    if (inSingle) { if (ch === '\\') { i++; continue; } if (ch === "'") inSingle = false; continue; }
    if (inDouble) { if (ch === '\\') { i++; continue; } if (ch === '"') inDouble = false; continue; }
    if (inTemplate) { if (ch === '\\') { i++; continue; } if (ch === '`') inTemplate = false; continue; }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === "'") { inSingle = true; continue; }
    if (ch === '"') { inDouble = true; continue; }
    if (ch === '`') { inTemplate = true; continue; }

    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; }
    if (started && depth === 0) {
      return code.substring(startIndex, i + 1);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 2. Code Formatting — beautification checks + auto-fix
// ---------------------------------------------------------------------------
function checkFormatting(code, out) {
  const lines = code.split('\n');

  // mixed tabs and spaces
  let tabCount = 0, spaceCount = 0;
  lines.forEach(line => {
    if (line.startsWith('\t')) tabCount++;
    else if (line.startsWith('  ')) spaceCount++;
  });
  if (tabCount > 0 && spaceCount > 0) {
    out.push(diag('MIXED_INDENT', 'warning',
      `Mixed indentation: ${tabCount} lines use tabs, ${spaceCount} use spaces`,
      'Use consistent indentation — 2-space indent is the Edison convention',
      { tabLines: tabCount, spaceLines: spaceCount }));
  }

  // trailing whitespace
  const trailingLines = [];
  lines.forEach((line, i) => {
    if (/\s+$/.test(line) && line.trim().length > 0) {
      trailingLines.push(i + 1);
    }
  });
  if (trailingLines.length > 0) {
    out.push(diag('TRAILING_WHITESPACE', 'info',
      `${trailingLines.length} line(s) have trailing whitespace`,
      'Remove trailing whitespace',
      { lines: trailingLines.slice(0, 10), total: trailingLines.length }));
  }

  // inconsistent quotes (rough heuristic)
  const singleQuotes = (code.match(/(?<![\\])'[^']*'/g) || []).length;
  const doubleQuotes = (code.match(/(?<![\\])"[^"]*"/g) || []).length;
  if (singleQuotes > 5 && doubleQuotes > 5) {
    const ratio = Math.min(singleQuotes, doubleQuotes) / Math.max(singleQuotes, doubleQuotes);
    if (ratio > 0.3) {
      const preferred = singleQuotes >= doubleQuotes ? 'single' : 'double';
      out.push(diag('INCONSISTENT_QUOTES', 'info',
        `Mixed quote usage: ${singleQuotes} single-quoted, ${doubleQuotes} double-quoted strings`,
        `Prefer ${preferred} quotes for consistency`,
        { single: singleQuotes, double: doubleQuotes }));
    }
  }

  // multiple consecutive blank lines
  let consecutiveBlanks = 0;
  lines.forEach((line, i) => {
    if (line.trim() === '') {
      consecutiveBlanks++;
      if (consecutiveBlanks > 2) {
        out.push(diag('MULTIPLE_BLANK_LINES', 'info',
          `Line ${i + 1}: ${consecutiveBlanks} consecutive blank lines`,
          'Use at most 2 consecutive blank lines',
          { line: i + 1, count: consecutiveBlanks }));
        consecutiveBlanks = 0;
      }
    } else {
      consecutiveBlanks = 0;
    }
  });

  // missing newline at end of file
  if (code.length > 0 && !code.endsWith('\n')) {
    out.push(diag('MISSING_FINAL_NEWLINE', 'info',
      'File does not end with a newline',
      'Add a newline at the end of the file'));
  }
}

function beautifyCode(code) {
  let result = code;

  // normalize line endings
  result = result.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // convert tabs to 2 spaces
  result = result.replace(/\t/g, '  ');

  // remove trailing whitespace
  result = result.split('\n').map(line => line.replace(/\s+$/, '')).join('\n');

  // collapse 3+ consecutive blank lines to 2
  result = result.replace(/\n{4,}/g, '\n\n\n');

  // ensure trailing newline
  if (!result.endsWith('\n')) result += '\n';

  return result;
}

// ---------------------------------------------------------------------------
// 3. Event Manager Usage Validation
// ---------------------------------------------------------------------------
function checkEventManager(code, out) {
  const lines = code.split('\n');

  // emit methods that return promises and must be awaited
  const asyncEmitMethods = [
    'emitAsync', 'emitSync', 'emitQueue',
    'emitHttp',
    'emitMultipleAsync', 'emitMultipleSync', 'emitMultipleQueue'
  ];

  // emit methods that are deferred (synchronous, no await needed)
  const deferredEmitMethods = ['emit', 'emitMultiple'];

  lines.forEach((line, i) => {
    const num = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;

    // Missing await on async emit methods
    for (const method of asyncEmitMethods) {
      const pattern = new RegExp(`this\\.${method}\\s*\\(`);
      if (pattern.test(trimmed)) {
        const awaitPattern = new RegExp(`await\\s+this\\.${method}\\s*\\(`);
        if (!awaitPattern.test(trimmed)) {
          // also check if it's assigned: const result = this.emitSync(...)
          const assignPattern = new RegExp(`=\\s*this\\.${method}\\s*\\(`);
          if (!assignPattern.test(trimmed)) {
            out.push(diag('EMIT_MISSING_AWAIT', 'warning',
              `Line ${num}: this.${method}() should be awaited — without await the result is a dangling Promise`,
              `Add "await" before this.${method}()`,
              { line: num, method }));
          }
        }
      }
    }

    // Awaiting deferred emit (it's synchronous, await does nothing)
    for (const method of deferredEmitMethods) {
      const awaitPattern = new RegExp(`await\\s+this\\.${method}\\s*\\(`);
      if (awaitPattern.test(trimmed)) {
        // make sure it's not emitAsync/emitSync etc
        const fullMatch = trimmed.match(new RegExp(`await\\s+this\\.(${method})\\s*\\(`));
        if (fullMatch && fullMatch[1] === method) {
          out.push(diag('EMIT_UNNECESSARY_AWAIT', 'info',
            `Line ${num}: this.${method}() is deferred (synchronous) — await has no effect`,
            `Remove "await" from this.${method}() — events are queued and post-processed after step completion`,
            { line: num, method }));
        }
      }
    }

    // emitSync with delay option (incompatible per event-manager spec)
    if (/this\.emitSync\s*\(/.test(trimmed)) {
      if (/delay\s*:/.test(trimmed) || /delay\s*:/.test(lines.slice(Math.max(0, i - 2), i + 5).join(' '))) {
        out.push(diag('EMIT_SYNC_WITH_DELAY', 'error',
          `Line ${num}: emitSync with delay option — delay and sync are incompatible`,
          'Use emitAsync or emitQueue with delay, or remove the delay option',
          { line: num }));
      }
    }

    // emitHttp method validation
    const emitHttpMatch = trimmed.match(/this\.emitHttp\s*\(\s*['"`](\w+)['"`]/);
    if (emitHttpMatch) {
      const method = emitHttpMatch[1].toUpperCase();
      const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
      if (!validMethods.includes(method)) {
        out.push(diag('EMIT_HTTP_INVALID_METHOD', 'error',
          `Line ${num}: emitHttp method "${emitHttpMatch[1]}" is not a valid HTTP method`,
          `Use one of: ${validMethods.join(', ')}`,
          { line: num, method: emitHttpMatch[1] }));
      }
    }

    // emitQueue result usage (fire-and-forget, result is always void)
    if (/(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?this\.emitQueue\s*\(/.test(trimmed)) {
      out.push(diag('EMIT_QUEUE_RESULT', 'warning',
        `Line ${num}: Assigning result of emitQueue() — emitQueue is fire-and-forget and returns void`,
        'Use emitAsync or emitSync if you need the result, or remove the variable assignment',
        { line: num }));
    }

    // emit with delay > 900
    const delayMatch = trimmed.match(/delay\s*:\s*(\d+)/);
    if (delayMatch) {
      const delay = parseInt(delayMatch[1], 10);
      if (delay > 900) {
        out.push(diag('EMIT_DELAY_EXCEEDS_MAX', 'error',
          `Line ${num}: Delay ${delay} exceeds maximum of 900 seconds`,
          'Set delay to a value between 0 and 900',
          { line: num, delay }));
      }
    }

    // Direct EventManager access instead of this.emit*
    if (/this\.eventManager\.emit\s*\(/.test(trimmed)) {
      out.push(diag('EMIT_DIRECT_EVENTMANAGER', 'info',
        `Line ${num}: Direct EventManager access — prefer using this.emit*() wrapper methods`,
        'Use this.emitSync(), this.emitAsync(), etc. instead of this.eventManager.emit()',
        { line: num }));
    }

    // Emitting 'trigger' event directly instead of via the deferred path
    const triggerEmitMatch = trimmed.match(/this\.(emitSync|emitAsync|emitQueue)\s*\(\s*['"`]trigger['"`]/);
    if (triggerEmitMatch) {
      out.push(diag('TRIGGER_USE_DEFERRED', 'warning',
        `Line ${num}: Emitting "trigger" event via ${triggerEmitMatch[1]}() — trigger events should use the deferred this.emit() for proper session handling`,
        'Use this.emit("trigger", params) — the deferred path handles session trigger registration and lock acquisition',
        { line: num, method: triggerEmitMatch[1] }));
    }

    // emitHttp without accountId/target (will target own account, potentially unintentional)
    if (/this\.emitHttp\s*\(/.test(trimmed)) {
      const nearbyCode = lines.slice(i, Math.min(i + 8, lines.length)).join(' ');
      if (!/(?:accountId|target)\s*:/.test(nearbyCode)) {
        out.push(diag('EMIT_HTTP_NO_TARGET', 'info',
          `Line ${num}: emitHttp() without explicit accountId or target — event will target the current account`,
          'Add accountId in the options object if you intend to call a different account\'s flow',
          { line: num }));
      }
    }
  });

  // Check for emitMultipleAsync/Sync/Queue with very large batch
  const batchMatch = code.match(/batchSize\s*:\s*(\d+)/);
  if (batchMatch) {
    const size = parseInt(batchMatch[1], 10);
    if (size > 50) {
      out.push(diag('EMIT_BATCH_TOO_LARGE', 'warning',
        `Batch size ${size} is very large — this may cause timeout or throttling`,
        'Keep batchSize under 50, or use series: true for sequential processing',
        { batchSize: size }));
    }
  }

  // Check for proper HTTP response patterns in gateway steps
  if (/this\.exitStep\s*\(/.test(code) && /httpGateway/.test(code)) {
    if (!/\b(code|statusCode)\s*:/.test(code) && !/status\s*:/.test(code)) {
      out.push(diag('HTTP_RESPONSE_NO_STATUS', 'info',
        'Step appears to handle HTTP requests but response has no explicit status code',
        'Include a status code in the response (e.g., { code: 200, body: result })'));
    }
  }

  // Warn about using this.emit() inside try/catch (deferred events fire AFTER step)
  const tryBlocks = [...code.matchAll(/\btry\s*\{/g)];
  const hasEmitInTry = tryBlocks.some(m => {
    const block = extractBlock(code, m.index + m[0].indexOf('{'));
    return block && /\bthis\.emit\s*\(/.test(block);
  });
  if (hasEmitInTry) {
    out.push(diag('DEFERRED_EMIT_IN_TRY', 'info',
      'this.emit() inside a try block — deferred events are post-processed after the step exits, so errors from the event will not be caught here',
      'If you need error handling on the emit, use emitSync/emitAsync with await in the try block'));
  }

  // callbackResolve / callbackReject usage
  if (/callbackResolve|callbackReject/.test(code)) {
    if (!/this\.eventManager/.test(code)) {
      out.push(diag('CALLBACK_WRONG_CONTEXT', 'warning',
        'callbackResolve/callbackReject found but not accessed via this.eventManager',
        'Use this.eventManager.callbackResolve(callback, result) and this.eventManager.callbackReject(callback, error)'));
    }
  }

  // --- Event naming convention validation (event-manager-reference) ---

  // Check for hardcoded event names that follow known platform patterns
  const emitNamePattern = /this\.(?:emitSync|emitAsync|emitQueue|emit)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  let emitMatch;
  while ((emitMatch = emitNamePattern.exec(code)) !== null) {
    const evtName = emitMatch[1];
    const lineNum = code.substring(0, emitMatch.index).split('\n').length;

    // HTTP events should follow http/{method}/{path} convention
    if (evtName.startsWith('http/')) {
      const parts = evtName.split('/');
      if (parts.length < 3) {
        out.push(diag('EVENT_NAME_HTTP_INVALID', 'warning',
          `Line ${lineNum}: HTTP event name "${evtName}" should follow "http/{method}/{path}" format`,
          'Use format: http/get/my-path or http/post/orders/create',
          { line: lineNum, eventName: evtName }));
      }
      const method = parts[1];
      if (method && method !== method.toLowerCase()) {
        out.push(diag('EVENT_NAME_HTTP_METHOD_CASE', 'warning',
          `Line ${lineNum}: HTTP event method should be lowercase ("${method}" → "${method.toLowerCase()}")`,
          'emitHttp lowercases methods automatically; use lowercase when building event names manually',
          { line: lineNum, method }));
      }
    }

    // REST events should follow rest/{path} convention
    if (evtName.startsWith('rest/') && evtName === 'rest/') {
      out.push(diag('EVENT_NAME_REST_EMPTY_PATH', 'info',
        `Line ${lineNum}: "rest/" targets the root path — verify this is intentional`,
        'Add a path segment after rest/ for specific endpoint targeting',
        { line: lineNum }));
    }

    // WebSocket events must start with ws/ when unauthorized
    if (evtName.startsWith('ws/')) {
      if (!evtName.startsWith('ws/connect/') && !evtName.startsWith('ws/message/')) {
        out.push(diag('EVENT_NAME_WS_PATTERN', 'info',
          `Line ${lineNum}: WebSocket event "${evtName}" — standard patterns are ws/connect/{route} and ws/message/{connectionId}`,
          'Verify the event name matches the gateway pattern you intend to target',
          { line: lineNum, eventName: evtName }));
      }
    }

    // HITL action events should match known patterns
    if (evtName.startsWith('hitl/')) {
      const validHitlActions = [
        'hitl/actions/add-events',
        'hitl/actions/upsert-session',
        'hitl/actions/close-session',
        'hitl/actions/notify-agents',
        'hitl/actions/start-call',
        'hitl/actions/upsert-conference-member',
        'hitl/actions/delete-conference-member',
        'hitl/actions/show-acw',
        'hitl/tasks/broadcast-events',
        'hitl/tasks/send-events',
        'hitl/tasks/share-cards-to-agent',
        'hitl/tasks/remove-rule-group-for-agents',
        'hitl/tasks/clean-up-contact-book-cache',
        'hitl/tasks/create-users-list-cache',
        'hitl/session/create',
        'hitl/session/delete',
        'hitl/session/update',
        'hitl/agent/change-status',
        'hitl/agent/check-status',
      ];
      const hitlCommandPattern = /^hitl\/command\/[\w-]+/;
      if (!validHitlActions.includes(evtName) && !hitlCommandPattern.test(evtName)) {
        out.push(diag('HITL_EVENT_NAME_UNKNOWN', 'info',
          `Line ${lineNum}: HITL event name "${evtName}" does not match a known HITL action or command pattern`,
          'Known patterns: hitl/actions/*, hitl/tasks/*, hitl/session/*, hitl/command/{command}-{sessionId}, hitl/agent/*',
          { line: lineNum, eventName: evtName }));
      }
    }

    // Session trigger naming — ssn/ and ssn-tmt/ are internal
    if (evtName.startsWith('ssn/') || evtName.startsWith('ssn-tmt/')) {
      out.push(diag('EVENT_NAME_INTERNAL_TRIGGER', 'warning',
        `Line ${lineNum}: "${evtName}" is an internal session trigger name — use this.emit("trigger", {...}) instead`,
        'Session trigger events (ssn/* and ssn-tmt/*) are managed internally by the event-manager; emit trigger events via this.emit("trigger", params)',
        { line: lineNum, eventName: evtName }));
    }
  }

  // --- emitHttp response handling (event-manager-reference §5, §11) ---

  // emitHttp without error handling
  if (/this\.emitHttp\s*\(/.test(code)) {
    if (!/try/.test(code) && !/catch/.test(code) && !/\.catch\s*\(/.test(code)) {
      out.push(diag('EMIT_HTTP_NO_ERROR_HANDLING', 'warning',
        'emitHttp() can throw StatusCodeError (404 no handler, 4xx/5xx responses) but no try/catch or .catch() found',
        'Wrap emitHttp calls in try/catch to handle HTTP errors (404 = no handler, 4xx/5xx = target flow error)'));
    }
  }

  // --- Data Hub KV storage patterns ---

  // Direct KV operations without error handling
  const kvPattern = /this\.(?:kv|keyValue|storage)\.\w+\s*\(/;
  if (kvPattern.test(code) && !/try/.test(code)) {
    out.push(diag('KV_NO_ERROR_HANDLING', 'info',
      'KV/storage operations found without try/catch — storage operations can fail on network or auth errors',
      'Wrap storage operations in try/catch for resilience'));
  }

  // --- Timeout and concurrency awareness ---

  // Long-running sequential emit patterns
  const seqEmitCount = (code.match(/await\s+this\.emitSync\s*\(/g) || []).length;
  if (seqEmitCount > 3) {
    out.push(diag('MANY_SEQUENTIAL_SYNCS', 'info',
      `${seqEmitCount} sequential emitSync calls found — each waits for the target flow to complete, which can cause step timeout`,
      'Consider using emitMultipleSync with batchSize, or emitAsync for calls that do not need results',
      { count: seqEmitCount }));
  }
}

// ---------------------------------------------------------------------------
// 4. Step Template Structure Validation
// ---------------------------------------------------------------------------
function buildScaffold(userCode, name) {
  const className = (name || 'MyStep').replace(/[^a-zA-Z0-9]/g, '');
  return `const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class ${className} extends Step {
  async runStep() {
    try {
${userCode.split('\n').map(l => '      ' + l).join('\n')}

      return this.exitStep('next', {});
    } catch (err) {
      this.log.error('${className} error', { error: err.message });
      if (this.data.processError) {
        return this.exitStep('error', { message: err.message });
      }
      throw err;
    }
  }
}

export { ${className} as step };`;
}

function buildDescriptionScaffold(description, name) {
  const className = (name || 'MyStep').replace(/[^a-zA-Z0-9]/g, '');
  return `const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

class ${className} extends Step {
  async runStep() {
    // TODO: Implement — ${description.slice(0, 200)}
    try {
      const result = {};

      return this.exitStep('next', result);
    } catch (err) {
      this.log.error('${className} error', { error: err.message });
      if (this.data.processError) {
        return this.exitStep('error', { message: err.message });
      }
      throw err;
    }
  }
}

export { ${className} as step };`;
}

function inferLabelFromCode(text) {
  const funcMatch = text.match(/(?:function\s+(\w+)|class\s+(\w+)|const\s+(\w+)\s*=)/);
  if (funcMatch) {
    const raw = funcMatch[1] || funcMatch[2] || funcMatch[3];
    return raw.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim().replace(/^\w/, c => c.toUpperCase());
  }
  return null;
}

function isFlowSource(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const d = obj.data;
  if (d && typeof d === 'object' && (d.trees || d.stepTemplates || d.deploy)) return true;
  if (obj.schemaVersion && obj.data) return true;
  if (Array.isArray(obj.stepTemplates) || (obj.trees && obj.deploy)) return true;
  return false;
}

function checkStepStructure(step, out, response) {
  if (!step || typeof step !== 'object') {
    out.push(diag('INVALID_STEP_INPUT', 'error',
      'Input must be a step template object, { code: "..." }, or a raw string',
      'Pass a valid step template object, { code: "source code" }, or send raw text as stepJSON'));
    return null;
  }

  if (isFlowSource(step)) {
    const templateCount = step.data?.stepTemplates?.length || step.stepTemplates?.length || 0;
    const flowLabel = step.data?.label || step.label || 'unknown';
    out.push(diag('INPUT_IS_FLOW', 'error',
      `This looks like a complete flow ("${flowLabel}"${templateCount ? `, ${templateCount} template${templateCount > 1 ? 's' : ''}` : ''}) — the step validator expects a single step template, not an entire flow.`,
      templateCount > 0
        ? `Send one step template at a time. Extract a template from data.stepTemplates[i] and send it as the request body. Example: POST with { "stepJSON": flow.data.stepTemplates[0] }`
        : 'Send a single step template object with at least a "template" (code) field, or raw text/code as "stepJSON" or "rawText".',
      { flowLabel, templateCount }, 0));
    return null;
  }

  const code = step.template || step.code;
  if (!code || typeof code !== 'string') {
    out.push(diag('NO_CODE', 'error',
      'No code found — provide step.template or step.code',
      'Pass { template: "code..." } or { code: "code..." }'));
    return null;
  }

  // Classify input only for truly raw inputs (string → { code, _rawInput: true })
  if (step.template === undefined && step._rawInput) {
    const classified = classifyInput(code);
    if (response) response.inputType = classified.type;

    if (classified.type === 'natural-language') {
      const label = 'My Step';
      const scaffold = buildDescriptionScaffold(code, label);
      out.push(diag('INPUT_IS_DESCRIPTION', 'warning',
        'Input appears to be a natural language description, not code. The validator can guide you from here to a complete Edison step template.',
        'Start by wrapping your description in a Step class. Use the fixCode scaffold below as your starting point, then fill in the implementation inside runStep().',
        {
          fixCode: {
            template: scaffold,
            label: label,
            data: { exits: [{ id: 'next', label: 'next' }, { id: 'error', label: 'error', condition: 'processError' }] },
            version: '0.1.0',
            description: code.slice(0, 200),
          },
          inputType: 'natural-language',
        }, 0));
      return code;
    }

    if (classified.type === 'pseudocode') {
      const label = classified.detectedName ? inferLabelFromCode(code) || 'My Step' : 'My Step';
      const scaffold = buildDescriptionScaffold(code, label.replace(/\s/g, ''));
      out.push(diag('INPUT_IS_PSEUDOCODE', 'warning',
        'Input appears to be pseudocode. The validator can guide you from here to a complete Edison step template.',
        'Convert your pseudocode to JavaScript inside a Step class. Use the fixCode scaffold below as your starting point.',
        {
          fixCode: {
            template: scaffold,
            label: label,
            data: { exits: [{ id: 'next', label: 'next' }, { id: 'error', label: 'error', condition: 'processError' }] },
            version: '0.1.0',
          },
          inputType: 'pseudocode',
        }, 0));
      return code;
    }

    // classified.type === 'javascript' — raw JS code, not a step template
    const hasStepClass = /class\s+\w+\s+extends\s+Step\b/.test(code);
    const hasExitStep = /this\.exitStep\s*\(/.test(code);
    const hasExport = /export\s*\{[^}]*step[^}]*\}/.test(code);
    const label = inferLabelFromCode(code) || 'My Step';
    const className = label.replace(/\s/g, '');

    if (!hasStepClass) {
      const scaffold = buildScaffold(code, className);
      out.push(diag('RAW_CODE_NO_STEP_CLASS', 'warning',
        'Code is raw JavaScript — it needs to be wrapped in an Edison Step class that extends Step with a runStep() method.',
        `Wrap your code in a Step class. Import Step from @onereach/flow-sdk/step.js, create class ${className} extends Step, put your logic in async runStep(), and export the class. Use the fixCode scaffold as a starting point.`,
        {
          fixCode: {
            template: scaffold,
            label: label,
            data: { exits: [{ id: 'next', label: 'next' }, { id: 'error', label: 'error', condition: 'processError' }] },
            version: '0.1.0',
          },
          inputType: 'javascript',
        }, 0));
    }

    if (!hasExitStep) {
      out.push(diag('RAW_CODE_NO_EXITSTEP', 'warning',
        'Code has no this.exitStep() call — Edison steps must exit via return this.exitStep(exitId, data) to pass data to the next step in the flow.',
        'Add "return this.exitStep(\'next\', result);" at the end of your logic. For error paths, add "return this.exitStep(\'error\', { message: err.message });".',
        null, 1));
    }

    if (hasStepClass && !hasExport) {
      out.push(diag('RAW_CODE_NO_EXPORT', 'info',
        'Code has a Step class but no export statement — Edison needs "export { ClassName as step };" at the end of the file.',
        `Add "export { ${className} as step };" at the end of your code.`,
        null, 1));
    }

    if (classified.detectedParams && classified.detectedParams.length > 0) {
      const params = classified.detectedParams;
      const inputSuggestions = params.map(p => ({
        variable: p,
        label: p.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim().replace(/^\w/, c => c.toUpperCase()),
        component: 'formTextInput',
        allowMergeFields: true,
      }));
      out.push(diag('RAW_CODE_USES_PARAMS', 'info',
        `Function has parameters (${params.join(', ')}) that should become this.data inputs — in Edison steps, input data comes from this.data.* which is populated from the step UI.`,
        `Replace function parameters with this.data reads: ${params.map(p => `this.data.${p}`).join(', ')}. Add corresponding formBuilder inputs so flow builders can wire merge fields.`,
        { params, suggestedInputs: inputSuggestions }, 1));
    }
  }

  // If full step template, validate structure
  if (step.template !== undefined) {
    // Empty-array exits are just as broken at runtime as missing-key exits —
    // every exitStep() call fails with "Invalid exit". Treat both the same.
    // (Discovered 2026-04-19 when splice-step's pre-flight gate needed to
    // catch a deliberately-broken template with data.exits: [].)
    const exitsArr = step.data?.exits;
    if (!exitsArr || !Array.isArray(exitsArr) || exitsArr.length === 0) {
      out.push(diag('STEP_NO_EXITS', 'warning',
        Array.isArray(exitsArr) && exitsArr.length === 0
          ? 'Step template has an EMPTY data.exits array — at runtime every exitStep() call fails with "Invalid exit" because no exits are declared'
          : 'Step template has no data.exits array defined',
        'Add data.exits with at least one exit definition'));
    }

    // Pre-scan: detect if any formWildcard manages exits dynamically
    const wildcardInputs = (step.formBuilder?.stepInputs || []).filter(inp => inp?.component === 'formWildcard');
    let hasDynamicExits = false;
    for (const wc of wildcardInputs) {
      const wcLogic = wc.data?.componentLogic || '';
      const wcTmpl = wc.data?.formTemplate || '';
      if (/\$emit\s*\(\s*['"`]update:exits['"`]/.test(wcLogic) ||
          /:exits\.sync=/.test(wcTmpl) || /v-model:exits=/.test(wcTmpl)) {
        hasDynamicExits = true;
        break;
      }
    }

    if (step.data?.exits?.length > 0) {
      const exitIds = step.data.exits.map(e => e.id).filter(Boolean);
      const codeExitCalls = code.match(/this\.exitStep\s*\(\s*['"`](\w+)['"`]/g) || [];
      const usedExits = new Set(codeExitCalls.map(c => c.match(/['"`](\w+)['"`]/)[1]));

      for (const exitId of exitIds) {
        if (!usedExits.has(exitId) && exitId !== '__error__' && exitId !== '__timeout__') {
          if (hasDynamicExits) {
            out.push(diag('EXIT_NEVER_TAKEN', 'info',
              `Exit "${exitId}" is defined but never called via this.exitStep() in the code — however, a formWildcard manages exits dynamically so this exit may be added/removed at runtime`,
              'Verify this exit is intentionally managed by the wildcard component',
              { exitId, dynamicExits: true }));
          } else {
            out.push(diag('EXIT_NEVER_TAKEN', 'info',
              `Exit "${exitId}" is defined but never called via this.exitStep("${exitId}", ...) in the code`,
              `Either use this.exitStep("${exitId}", data) in the template code or remove the exit`,
              { exitId }));
          }
        }
      }

      for (const usedExit of usedExits) {
        if (!exitIds.includes(usedExit)) {
          out.push(diag('EXIT_NOT_DEFINED', 'warning',
            `Code calls this.exitStep("${usedExit}", ...) but no exit with id "${usedExit}" is defined in data.exits — the exit may be configured at the step-instance level`,
            `Add { id: "${usedExit}", label: "${usedExit}" } to data.exits, or verify the exit is configured on the step instance`,
            { exitId: usedExit }));
        }
      }

      for (const exit of step.data.exits) {
        if (exit.condition !== undefined && exit.condition !== null && typeof exit.condition !== 'string') {
          if (typeof exit.condition === 'object' && exit.condition !== null) {
            validateConditionBuilder(exit.condition, `Exit "${exit.id}"`, 'conditionBuilder', null, null, stepInputs, null, out);
          } else {
            out.push(diag('EXIT_INVALID_CONDITION', 'error',
              `Exit "${exit.id}" has condition of type ${typeof exit.condition} — must be a string or condition builder object`,
              'exit.condition must be a string (empty, "processError", "processTimeout", or expression) or an object with { trueValue, rules, defaultValue, isNotCollapsed }',
              { exitId: exit.id, condition: exit.condition }));
          }
        }

        // Exit condition string expression syntax check (non-builtin conditions)
        if (typeof exit.condition === 'string' && exit.condition.trim() !== '') {
          const ec = exit.condition.trim();
          const builtinConditions = new Set(['processError', 'processTimeout']);
          if (!builtinConditions.has(ec)) {
            try {
              new Function('schema', `return (${ec});`);
            } catch (parseErr) {
              out.push(diag('EXIT_CONDITION_SYNTAX_ERROR', 'error',
                `Exit "${exit.id}" condition "${ec}" is not a valid JavaScript expression — ${parseErr.message}`,
                'Fix the expression syntax. Exit conditions are evaluated as JS expressions with schema in scope.',
                { exitId: exit.id, condition: ec, parseError: parseErr.message }));
            }
          }
        }

        // Exit conditionBuilder (separate from condition — some exits have both)
        if (exit.conditionBuilder && typeof exit.conditionBuilder === 'object') {
          validateConditionBuilder(exit.conditionBuilder, `Exit "${exit.id}"`, 'conditionBuilder', null, null, stepInputs, null, out);
        }
      }
    }

    // Check processError/processTimeout consistency with exits
    if (step.data?.processError === true) {
      const hasErrorExit = step.data.exits?.some(e => e.id === '__error__' || e.condition === 'processError');
      if (!hasErrorExit) {
        out.push(diag('PROCESS_ERROR_NO_EXIT', 'warning',
          'processError is true but no __error__ exit is defined',
          'Add { id: "__error__", label: "error", condition: "processError" } to data.exits'));
      }
    }
    if (step.data?.processTimeout === true) {
      const hasTimeoutExit = step.data.exits?.some(e => e.id === '__timeout__' || e.condition === 'processTimeout');
      if (!hasTimeoutExit) {
        out.push(diag('PROCESS_TIMEOUT_NO_EXIT', 'warning',
          'processTimeout is true but no __timeout__ exit is defined',
          'Add { id: "__timeout__", label: "timeout", condition: "processTimeout" } to data.exits'));
      }
    }

    // §4.2 / §4.3 — Studio-UI flag alignment check (NOT a runtime gate).
    //
    // The runtime (flow-sdk) does not read data.processError / data.processTimeout.
    // It resolves __error__ / __timeout__ purely by exits[] membership via
    // getExitStepId() — a dict lookup keyed by id/label/stepId (flow-sdk/src/
    // step/data.ts:40-104, thread.ts:2120-2126). grep flow-sdk source for
    // `processError`: zero matches in runtime code.
    //
    // Step-builder-UI, however, sets processError:true + adds the __error__ exit
    // as a PAIR (step-builder-ui buildStepInitialSettings.js:26-32). A mismatch
    // means the step.json wasn't produced by Studio; Studio's save-time sanity
    // may strip or reject it. Flag as a warning, not an error — runtime still
    // works if exits[] has the entry.
    const hasErrorConditionExit = step.data?.exits?.some(
      e => e.condition === 'processError' || e.id === '__error__' || e.id === 'error');
    if (hasErrorConditionExit && step.data?.processError !== true) {
      out.push(diag('ERROR_EXIT_UI_FLAG_MISMATCH', 'warning',
        'data.exits[] contains an __error__ entry but data.processError is not true — the runtime will still route errors to __error__ (it only reads exits[]), but step-builder-UI always sets these together. Studio may strip the exit on save.',
        'Set data.processError to true to match Studio\'s convention, or remove the __error__ exit from data.exits[] if error handling is not needed.'));
    }
    const hasTimeoutConditionExit = step.data?.exits?.some(
      e => e.condition === 'processTimeout' || e.id === '__timeout__' || e.id === 'timeout');
    if (hasTimeoutConditionExit && step.data?.processTimeout !== true) {
      out.push(diag('TIMEOUT_EXIT_UI_FLAG_MISMATCH', 'warning',
        'data.exits[] contains a __timeout__ entry but data.processTimeout is not true — the runtime will still route timeouts to __timeout__ (it only reads exits[]), but step-builder-UI always sets these together. Studio may strip the exit on save.',
        'Set data.processTimeout to true (and data.timeoutDuration to a duration string like "`120 sec`") to match Studio\'s convention, or remove the __timeout__ exit from data.exits[] if timeout handling is not needed.'));
    }

    // Rule 4.3 — processTimeout on with a timeout exit defined, but no timeout
    // source. Edison's Step.runHandle auto-installs a timeout from
    // data.timeoutDuration; if that's missing AND the code doesn't call
    // this.triggers.timeout(...), the exit is dead: the timeout will never fire.
    if (hasTimeoutConditionExit && step.data?.processTimeout === true) {
      const hasDuration = !!step.data?.timeoutDuration;
      const hasImperativeTimeout = code && /this\.triggers\.timeout\s*\(/.test(code);
      if (!hasDuration && !hasImperativeTimeout) {
        out.push(diag('TIMEOUT_EXIT_NO_DURATION', 'error',
          'Timeout exit is enabled (processTimeout: true) but no timeout source exists — data.timeoutDuration is unset AND code never calls this.triggers.timeout(). The __timeout__ exit can never fire.',
          'Either set data.timeoutDuration (e.g., "`180 sec`") so Step.runHandle auto-installs the timer, or call this.triggers.timeout(ms, cb) inside runStep',
          { timeoutDuration: step.data?.timeoutDuration }));
      }
    }

    // §4.2 — Runtime-truth check: code calls exitStep('__error__') but no
    // __error__ entry exists in data.exits[]. The SDK resolves __error__ purely
    // by exits[] membership (flow-sdk/src/step/data.ts:94-104); without the
    // entry, getExitStepId returns undefined and error routing silently breaks.
    // THIS is the real runtime bug — distinct from the UI-flag mismatch above.
    if (code) {
      const callsErrorExit = /this\.exitStep\s*\(\s*['"`](?:error|__error__)['"`]/.test(code);
      const declaredErrorExit = step.data?.exits?.some(e => e.id === '__error__' || e.id === 'error');
      if (callsErrorExit && !declaredErrorExit) {
        out.push(diag('ERROR_EXIT_NOT_DECLARED', 'error',
          'Code calls this.exitStep("__error__", …) but data.exits[] has no entry with id "__error__" — at runtime getExitStepId returns undefined and the exit routes nowhere. This is the runtime invariant per §4.2; data.processError is UI bookkeeping and not consulted by the SDK.',
          'Append { id: "__error__", label: "error", condition: "processError" } to data.exits[] (Studio convention also sets data.processError: true alongside).'));
      }
    }

    // §4.3 — Same runtime-truth check for __timeout__.
    if (code) {
      const callsTimeoutExit = /this\.exitStep\s*\(\s*['"`](?:timeout|__timeout__)['"`]/.test(code);
      const declaredTimeoutExit = step.data?.exits?.some(e => e.id === '__timeout__' || e.id === 'timeout');
      if (callsTimeoutExit && !declaredTimeoutExit) {
        out.push(diag('TIMEOUT_EXIT_NOT_DECLARED', 'error',
          'Code calls this.exitStep("__timeout__", …) but data.exits[] has no entry with id "__timeout__" — at runtime getExitStepId returns undefined and the exit routes nowhere. data.processTimeout is UI bookkeeping and not consulted by the SDK.',
          'Append { id: "__timeout__", label: "timeout", condition: "processTimeout" } to data.exits[] (Studio convention also sets data.processTimeout: true and data.timeoutDuration alongside).'));
      }
    }

    // Code checks this.data.processError but the flag is not set
    if (code && step.data?.processError !== true) {
      const checksProcessError = /this\.data\.processError/.test(code);
      if (checksProcessError) {
        out.push(diag('PROCESS_ERROR_CHECK_ALWAYS_FALSE', 'warning',
          'Code checks this.data.processError but data.processError is not true — the check will always be false and error handling logic will be skipped',
          'Set data.processError to true to enable the error handling code path'));
      }
    }

    // External calls without processError enabled — missing error recovery
    if (code && step.data?.processError !== true) {
      const hasFetch = /\bfetch\s*\(/.test(code);
      const hasEmitHttp = /this\.emitHttp\s*\(/.test(code);
      const hasLlm = /(?:anthropic|openai|claude|gpt|api\.anthropic|completions)/i.test(code);
      const hasEmitSync = /this\.emitSync\s*\(/.test(code);
      if (hasFetch || hasEmitHttp || hasLlm || hasEmitSync) {
        const reason = hasLlm ? 'LLM/AI API calls' : hasFetch ? 'external fetch() calls'
          : hasEmitHttp ? 'emitHttp() calls' : 'synchronous step-to-step emits';
        // Only flag if the code doesn't wrap in try/catch with a throw
        const hasTryCatch = /try\s*\{[\s\S]*?\}\s*catch/.test(code);
        if (!hasTryCatch) {
          out.push(diag('EXTERNAL_CALL_NO_ERROR_HANDLING', 'warning',
            `Step code contains ${reason} but processError is not enabled and there is no try/catch — if the external call fails, the error will be unhandled and propagate to the global error handler`,
            'Enable processError and add an error exit to handle failures gracefully, or wrap external calls in try/catch'));
        }
      }
    }

    // Detect LLM API usage without auth component
    {
      const codeLower = code.toLowerCase();
      const usesLlmApi = /anthropic|openai|x-api-key|api\.anthropic\.com|api\.openai\.com/i.test(code);
      const usesLlmModel = /claude-|gpt-|gemini-|llama-|mistral-/i.test(code);
      const usesFetch = /\bfetch\s*\(/.test(code);
      const usesEmitHttp = /\bemitHttp\s*\(|\bemitSync\s*\(/.test(code);

      if ((usesLlmApi || usesLlmModel) && (usesFetch || usesEmitHttp)) {
        const hasAuthInput = step.formBuilder?.stepInputs?.some(i => {
          const c = Array.isArray(i.component) ? i.component[0] : i.component;
          return c === 'auth-external-component';
        });
        if (!hasAuthInput) {
          const _provider = /anthropic|claude-/i.test(code) ? 'Anthropic'
            : /openai|gpt-/i.test(code) ? 'OpenAI' : 'Anthropic';
          const _collection = `__authorization_service_${_provider}`;
          out.push(diag('STEP_LLM_NO_AUTH', 'error',
            'Step code references LLM APIs (Anthropic, OpenAI, Claude, GPT) and makes external calls but has no auth-external-component — the step will fail at runtime when it tries to authenticate with the LLM provider',
            'Add an auth-external-component to formBuilder.stepInputs with the appropriate keyValueCollection (e.g. __authorization_service_Anthropic)',
            { fixCode: { addAuthComponent: { provider: _provider, keyValueCollection: _collection } } }));
        }
      }

      if (usesFetch && !usesLlmApi && !usesLlmModel) {
        const usesConfigAuth = /this\.config\.authorization/.test(code);
        const usesDataAuth = /this\.data\.auth/.test(code);
        if (!usesConfigAuth && !usesDataAuth) {
          const hasAuthInput = step.formBuilder?.stepInputs?.some(i => {
            const c = Array.isArray(i.component) ? i.component[0] : i.component;
            return c === 'auth-external-component';
          });
          if (!hasAuthInput) {
            out.push(diag('STEP_EXTERNAL_CALL_NO_AUTH', 'warning',
              'Step code makes external fetch() calls but has no auth mechanism — no auth-external-component, no this.config.authorization, no this.data.auth. The step may fail if the external API requires authentication.',
              'Add authentication: either an auth-external-component for credential management, or use this.config.authorization for flow-level auth'));
          }
        }
      }
    }

    // Duplicate exit conditions — two exits with the same non-empty condition
    // confuse Edison's exit router and the form builder exit panel
    if (step.data?.exits?.length > 1) {
      const condCounts = {};
      for (const exit of step.data.exits) {
        const cond = typeof exit.condition === 'string' ? exit.condition.trim() : '';
        if (!cond) continue;
        if (!condCounts[cond]) condCounts[cond] = [];
        condCounts[cond].push(exit.id);
      }
      for (const [cond, ids] of Object.entries(condCounts)) {
        if (ids.length > 1) {
          out.push(diag('EXIT_DUPLICATE_CONDITION', 'warning',
            `Exits [${ids.join(', ')}] share condition "${cond}" — Edison will route to only one of them; the other(s) are unreachable`,
            `Remove the duplicate or give each exit a unique condition. For processError, use a single __error__ exit or a single custom error exit, not both.`,
            { condition: cond, exitIds: ids }));
        }
      }
    }

    // Check module declarations
    if (Array.isArray(step.modules)) {
      const NPM_NAME_PATTERN = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
      for (let mi = 0; mi < step.modules.length; mi++) {
        const mod = step.modules[mi];
        if (!mod || !mod.name || typeof mod.name !== 'string' || mod.name.trim() === '') {
          out.push(diag('MODULE_INVALID_NAME', 'warning',
            `modules[${mi}] has no name or an empty name`,
            'Set modules[].name to a valid npm package name',
            { index: mi }));
        } else if (!NPM_NAME_PATTERN.test(mod.name)) {
          out.push(diag('MODULE_INVALID_NAME', 'warning',
            `modules[${mi}].name "${mod.name}" does not look like a valid npm package name`,
            'npm names must be lowercase with hyphens/dots/underscores and optionally scoped (@scope/name)',
            { index: mi, name: mod.name }));
        }
        if (mod && mod.name && (!mod.version || typeof mod.version !== 'string' || mod.version.trim() === '')) {
          out.push(diag('MODULE_MISSING_VERSION', 'warning',
            `modules[${mi}] "${mod.name}" has no version — the runtime will install the latest version, which may break unexpectedly`,
            'Set modules[].version to a semver range (e.g., "^3.0.0")',
            { index: mi, name: mod.name }));
        }
      }
      const declaredModules = new Set(step.modules.map(m => m.name).filter(Boolean));
      const requirePattern = /require\s*\(\s*['"`]([^'"`.][^'"`]*)['"`]\s*\)/g;
      const importPattern = /(?:import|from)\s+['"`]([^'"`.][^'"`]*)['"`]/g;
      let m;
      const usedModules = new Set();
      while ((m = requirePattern.exec(code)) !== null) usedModules.add(m[1].split('/')[0]);
      while ((m = importPattern.exec(code)) !== null) usedModules.add(m[1].split('/')[0]);

      // Aligned with Step Builder UI: filter out @onereach/* (except or-sdk)
      const isOneReachInternal = (name) =>
        name.startsWith('@onereach/') && name !== '@onereach/or-sdk';

      for (const mod of usedModules) {
        if (mod.startsWith('@')) continue; // scoped packages need more complex parsing
        if (!declaredModules.has(mod) && !isBuiltinModule(mod)) {
          out.push(diag('UNDECLARED_MODULE', 'warning',
            `Code requires "${mod}" but it is not declared in step.modules`,
            `Add { name: "${mod}", version: "^x.y.z" } to modules array`,
            { module: mod }));
        }
      }

      for (const mod of declaredModules) {
        if (isOneReachInternal(mod)) continue;
        if (!usedModules.has(mod)) {
          out.push(diag('UNUSED_MODULE', 'info',
            `Module "${mod}" is declared but not imported in the code`,
            'Remove unused module declaration to reduce bundle size',
            { module: mod }));
        }
      }
    }

    // --- Data Hub step template required fields (Section 9) ---

    // id must be a lowercase UUID (pattern: ^[a-z\d]{8}-...)
    const UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (step.id && typeof step.id === 'string' && !UUID_PATTERN.test(step.id)) {
      out.push(diag('TEMPLATE_INVALID_ID', 'info',
        `Step template id "${step.id}" does not match UUID format — the Data Hub requires a valid UUID`,
        'Set id to a valid UUID (e.g., "d45325b3-8133-4916-91cb-ef7265ec2e84")',
        { id: step.id }));
    }
    if (step.id && typeof step.id === 'string' && step.id !== step.id.toLowerCase()) {
      out.push(diag('TEMPLATE_ID_NOT_LOWERCASE', 'error',
        `Step template id "${step.id}" contains uppercase characters — DataHub requires lowercase hex UUIDs`,
        'Use a lowercase UUID (crypto.randomUUID() produces lowercase by default)',
        { id: step.id }));
    }

    // Name / label
    if (!step.name && !step.label) {
      out.push(diag('TEMPLATE_NO_NAME', 'warning',
        'Step template has no name or label — it will display as unnamed in the flow builder',
        'Set name and label to a descriptive step title (e.g., "Create Task")'));
    }

    // Label length — Edison Studio canvas nodes truncate past ~25-30 chars,
    // and anything over ~60 makes the derived class name / dataOut identifier
    // absurd. The Conceive LLM extractor has a "1-3 words MAX" directive but
    // ignores it when the playbook H1 is long (e.g. "weather anomaly library
    // step for GSX flow builders" → 50-char label). Catch it here so the
    // pipeline can retry with a shorter label instead of shipping a bloated
    // canvas label.
    {
      const lblForLen = ((step.label || step.name) || '').trim();
      const LABEL_WARN_LEN = 40;
      const LABEL_ERR_LEN = 60;
      if (lblForLen.length > LABEL_ERR_LEN) {
        out.push(diag('TEMPLATE_LABEL_TOO_LONG', 'error',
          `Step label is ${lblForLen.length} chars ("${lblForLen.slice(0, 60)}...") — canvas nodes truncate past ~30 chars and the derived class name + dataOut identifier become unusable. Max ${LABEL_ERR_LEN} chars.`,
          `Rewrite to 1-3 words describing the core concept. Example: "${lblForLen}" → "${lblForLen.split(/\s+/).slice(0, 3).join(' ')}".`,
          { currentLength: lblForLen.length, maxLength: LABEL_ERR_LEN }));
      } else if (lblForLen.length > LABEL_WARN_LEN) {
        out.push(diag('TEMPLATE_LABEL_LONG', 'warning',
          `Step label is ${lblForLen.length} chars ("${lblForLen}") — Edison Studio canvas truncates past ~30. Recommended max ${LABEL_WARN_LEN}.`,
          `Shorten to 1-3 words. Example: "${lblForLen}" → "${lblForLen.split(/\s+/).slice(0, 3).join(' ')}".`,
          { currentLength: lblForLen.length, recommendedMax: LABEL_WARN_LEN }));
      }
    }

    // Description
    if (!step.description || (typeof step.description === 'string' && step.description.trim() === '')) {
      out.push(diag('TEMPLATE_NO_DESCRIPTION', 'warning',
        'Step template has no description — the step picker tooltip and help panel will be empty',
        'Add a 1-2 sentence description of what the step does'));
    } else if (typeof step.description === 'string') {
      const desc = step.description.trim();
      if (desc.length > 255) {
        out.push(diag('TEMPLATE_DESCRIPTION_TOO_LONG', 'error',
          `Step description is ${desc.length} characters — Edison truncates at 255. The step picker tooltip will be cut off and the description may contain raw playbook content that leaked in.`,
          `Shorten the description to 1-2 sentences (under 255 chars). Current: "${desc.slice(0, 80)}..."`,
          { length: desc.length, limit: 255, preview: desc.slice(0, 100) }));
      }
      if (desc.length < 20) {
        out.push(diag('TEMPLATE_DESCRIPTION_TOO_SHORT', 'warning',
          `Step description is only ${desc.length} characters — too short to be useful in the step picker`,
          'Write at least 1 full sentence describing what the step does and when to use it'));
      }
      if (/^(a step that|this step|step that)/i.test(desc)) {
        out.push(diag('TEMPLATE_DESCRIPTION_WEAK_START', 'info',
          'Step description starts with a generic phrase — the step picker shows many steps side by side, make the first words distinctive',
          'Start with the action verb: "Validates...", "Generates...", "Fetches..." instead of "A step that..."'));
      }
      if (desc.includes('## ') || desc.includes('| **') || desc.includes('```')) {
        out.push(diag('TEMPLATE_DESCRIPTION_HAS_MARKDOWN', 'error',
          'Step description contains markdown formatting (headings, tables, or code blocks) — this is likely raw playbook content that leaked into the description field',
          'The description should be plain text, 1-2 sentences. Move detailed content to the help field instead.',
          { preview: desc.slice(0, 150) }));
      }
      const sentenceCount = (desc.match(/[.!?]\s/g) || []).length + (desc.endsWith('.') || desc.endsWith('!') || desc.endsWith('?') ? 1 : 0);
      if (sentenceCount > 4) {
        out.push(diag('TEMPLATE_DESCRIPTION_TOO_VERBOSE', 'warning',
          `Step description has ~${sentenceCount} sentences — the step picker tooltip works best with 1-2 concise sentences`,
          'Shorten to the most essential 1-2 sentences. Move details to the help field.'));
      }
    }

    // Help text
    if (!step.help || (typeof step.help === 'string' && step.help.trim() === '')) {
      out.push(diag('TEMPLATE_NO_HELP', 'info',
        'Step template has no help text — the info panel will be empty when builders click the help button',
        'Add help text with Inputs, Output, and Error handling sections'));
    } else if (typeof step.help === 'string') {
      const help = step.help.trim();
      const desc = (step.description || '').trim().toLowerCase();
      const helpNorm = help.toLowerCase().replace(/^use this step to\s+/i, '').replace(/^this step\s+/i, '');
      const descNorm = desc.replace(/^use this step to\s+/i, '').replace(/^this step\s+/i, '');
      if (help.length > 0 && desc.length > 20 && (helpNorm.startsWith(descNorm.slice(0, 40)) || descNorm.startsWith(helpNorm.slice(0, 40)))) {
        out.push(diag('TEMPLATE_HELP_DUPLICATES_DESCRIPTION', 'warning',
          'Help text just repeats the description — the help panel should provide additional detail about inputs, outputs, error handling, and usage examples',
          'Write proper help text with sections: ## Inputs, ## Output, ## Error handling, ## Examples. The description is for the tooltip; help is for the detailed panel.',
          { helpPreview: help.slice(0, 80), descPreview: desc.slice(0, 80) }));
      }
      if (help.length < 50 && help.length > 0) {
        out.push(diag('TEMPLATE_HELP_TOO_SHORT', 'warning',
          `Help text is only ${help.length} chars — too short to be useful. The help panel should document inputs, outputs, and error handling.`,
          'Add sections: ## Inputs (what each field does), ## Output (what the step returns), ## Error handling (what can go wrong)'));
      }
      if (!/#{1,3}\s/.test(help) && help.length > 100) {
        out.push(diag('TEMPLATE_HELP_NO_STRUCTURE', 'info',
          'Help text has no markdown headings — structured help with ## sections is easier to scan in the info panel',
          'Add headings: ## Inputs, ## Output, ## Error handling, ## Examples'));
      }
    }

    // --- Icon validation ---
    const DH_ICON_TYPES = ['default', 'custom'];
    const ICON_SUGGESTIONS = {
      api: ['http', 'cloud', 'send'],
      logic: ['code', 'settings', 'build'],
      transform: ['transform', 'autorenew', 'sync_alt'],
      gateway: ['input', 'login', 'sensors'],
      http: ['http', 'public', 'language'],
    };
    const CATEGORY_ICON_HINTS = [
      [/ai|llm|ml|intelligen/i, ['psychology', 'smart_toy', 'auto_awesome']],
      [/storage|database|data/i, ['storage', 'database', 'inventory_2']],
      [/email|mail|message/i, ['email', 'mail', 'chat']],
      [/file|document/i, ['description', 'folder', 'file_copy']],
      [/auth|security|login/i, ['lock', 'security', 'vpn_key']],
      [/search|find|lookup/i, ['search', 'find_in_page', 'manage_search']],
      [/notification|alert/i, ['notifications', 'campaign', 'announcement']],
      [/user|person|account/i, ['person', 'account_circle', 'group']],
      [/schedule|time|cron/i, ['schedule', 'timer', 'access_time']],
    ];

    function suggestIcons(kind, categories) {
      if (kind && ICON_SUGGESTIONS[kind]) return ICON_SUGGESTIONS[kind];
      const cats = (categories || []).join(' ');
      for (const [pattern, icons] of CATEGORY_ICON_HINTS) {
        if (pattern.test(cats)) return icons;
      }
      return ['extension', 'widgets', 'settings'];
    }

    const stepDesc = step.description || step.label || step.stepDetails?.name || 'this step';
    const iconCreatorContext = {
      iconCreator: {
        endpoint: 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/create-icon',
        exampleBody: { prompt: stepDesc },
        cli: 'node lib/iconGenerator.js --prompt="' + (stepDesc || 'icon for my step').replace(/"/g, '\\"') + '" --out=icons/my-icon.svg',
      },
    };
    const iconCreatorFix =
        'Use the Icon Creator flow to generate a custom icon:\n' +
        '  POST https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/create-icon\n' +
        '  Body: { "pattern": "flower-of-life", "options": { "rings": 3 } }\n' +
        '  Or:   { "prompt": "' + stepDesc.replace(/"/g, '\\"') + '" }\n' +
        '  CLI:  node lib/iconGenerator.js <pattern> --out=icons/my-icon.svg\n' +
        '  CLI:  node lib/iconGenerator.js --prompt="' + stepDesc.replace(/"/g, '\\"') + '" --out=icons/my-icon.svg\n' +
        '  Then set iconType: "custom", icon: "", iconUrl: <returned URL or data URI>\n\n' +
        'Custom SVGs should use viewBox="0 0 48 48", stroke="#fff", fill="none" for Edison\'s dark canvas.';

    if ((!step.iconType || step.iconType === 'default') && (!step.icon || step.icon.trim() === '')) {
      out.push(diag('TEMPLATE_NO_ICON', 'error',
        'Step has no icon — it renders as a blank shape on the canvas. ' +
        'Add iconPattern to step.json (auto-selected at build) or use the Icon Creator flow.',
        iconCreatorFix, iconCreatorContext));
    }

    if ((!step.iconType || step.iconType === 'default') && step.icon && step.icon.trim() !== '') {
      out.push(diag('TEMPLATE_ICON_NOT_CUSTOM', 'error',
        `Step uses a generic Material icon ("${step.icon}") instead of a custom icon. ` +
        'Add iconPattern to step.json (auto-selected at build) or use the Icon Creator flow.',
        iconCreatorFix, iconCreatorContext));
    }

    if (step.iconType !== null && step.iconType !== undefined && step.iconType !== '' && !DH_ICON_TYPES.includes(step.iconType)) {
      out.push(diag('TEMPLATE_INVALID_ICONTYPE', 'error',
        `iconType "${step.iconType}" is not valid — must be "default" or "custom". ` +
        'The icon will not render on the canvas.',
        'Set iconType to "default" (for named Material icons) or "custom" (for a custom SVG/PNG via iconUrl)',
        { value: step.iconType }));
      if (!step.icon || (typeof step.icon === 'string' && step.icon.trim() === '')) {
        out.push(diag('TEMPLATE_NO_ICON', 'error',
          `Step has no usable icon — iconType "${step.iconType}" is invalid and icon is empty. ` +
          'It renders as a blank shape on the canvas.',
          iconCreatorFix, iconCreatorContext));
      }
    }

    if (step.iconType === 'custom' && !step.iconUrl) {
      out.push(diag('TEMPLATE_CUSTOM_ICON_NO_URL', 'error',
        'iconType is "custom" but no iconUrl is set — the step will show a blank shape. ' +
        'Add iconPattern to step.json or use the Icon Creator flow.',
        iconCreatorFix, iconCreatorContext));
    }

    if (step.iconUrl && typeof step.iconUrl === 'string' && step.iconUrl.trim() !== '') {
      const isHttpUrl = /^https?:\/\/.+/.test(step.iconUrl);
      const isDataUri = /^data:image\/(png|svg\+xml)[;,]/.test(step.iconUrl);
      if (!isHttpUrl && !isDataUri) {
        out.push(diag('TEMPLATE_INVALID_ICON_URL', 'error',
          `iconUrl "${step.iconUrl.substring(0, 60)}${step.iconUrl.length > 60 ? '...' : ''}" is not a valid URL or data URI`,
          'Set iconUrl to an https:// URL or a data:image/png;base64,... or data:image/svg+xml;base64,... URI'));
      }
      if (step.iconType !== 'custom') {
        out.push(diag('TEMPLATE_ICONURL_IGNORED', 'warning',
          `iconUrl is set but iconType is "${step.iconType || 'default'}" — the URL will be ignored at runtime`,
          'Set iconType to "custom" to use the custom icon URL'));
      }

      if (/^http:\/\//.test(step.iconUrl)) {
        out.push(diag('TEMPLATE_ICON_HTTP_URL', 'warning',
          'iconUrl uses HTTP instead of HTTPS — browsers block mixed content on secure pages',
          'Change the URL to use https://'));
      }

      if (isDataUri) {
        const MAX_DATA_URI_LEN = 170000;
        if (step.iconUrl.length > MAX_DATA_URI_LEN) {
          const sizeKB = Math.round(step.iconUrl.length * 3 / 4 / 1024);
          out.push(diag('TEMPLATE_ICON_DATA_URI_TOO_LARGE', 'warning',
            `Icon data URI is ~${sizeKB}KB — large data URIs bloat the flow JSON and slow the canvas (max recommended: 128KB)`,
            'Reduce the image size/complexity, or host the icon at an https:// URL instead of embedding it inline'));
        }

        if (/^data:image\/svg\+xml[;,]/.test(step.iconUrl)) {
          let svgContent = '';
          try {
            const b64Match = step.iconUrl.match(/^data:image\/svg\+xml;base64,(.+)/);
            if (b64Match) {
              svgContent = Buffer.from(b64Match[1], 'base64').toString('utf8');
            } else {
              const rawMatch = step.iconUrl.match(/^data:image\/svg\+xml,(.+)/);
              if (rawMatch) svgContent = decodeURIComponent(rawMatch[1]);
            }
          } catch (_e) { /* decode failure handled by TEMPLATE_INVALID_ICON_URL */ }

          if (svgContent) {
            if (!/viewBox/i.test(svgContent)) {
              out.push(diag('TEMPLATE_ICON_SVG_NO_VIEWBOX', 'warning',
                'Custom SVG icon has no viewBox attribute — it will scale unpredictably inside the step shape',
                'Add viewBox="0 0 48 48" to the root <svg> element. Edison icons use a 48x48 coordinate space.'));
            }

            const hasLightStroke = /stroke\s*[:=]\s*["']?(#fff|#ffffff|white|#[a-f]{3,6})/i.test(svgContent)
              && !/stroke\s*[:=]\s*["']?(#000|#333|#555|black|#0{3,6})/i.test(svgContent);
            const hasLightFill = /fill\s*[:=]\s*["']?(#fff|#ffffff|white)/i.test(svgContent);
            const hasFillNone = /fill\s*[:=]\s*["']?none/i.test(svgContent);
            const hasDarkStroke = /stroke\s*[:=]\s*["']?(#000|#333|#555|#666|black)/i.test(svgContent);
            const hasDarkFill = /fill\s*[:=]\s*["']?(#000|#333|#555|#666|black)/i.test(svgContent) && !hasFillNone;

            if ((hasDarkStroke || hasDarkFill) && !hasLightStroke && !hasLightFill) {
              out.push(diag('TEMPLATE_ICON_SVG_DARK_BG', 'warning',
                'Custom SVG icon uses dark colors (black/dark gray) — it will be invisible on Edison\'s dark canvas background',
                'Use white strokes and fills: stroke="#fff" fill="none" on a transparent background. ' +
                'See the project icons/ directory for working examples.'));
            } else if (!hasLightStroke && !hasLightFill && !hasDarkStroke && !hasDarkFill) {
              out.push(diag('TEMPLATE_ICON_SVG_DARK_BG', 'info',
                'Custom SVG icon may not be visible on Edison\'s dark canvas — could not detect white/light strokes or fills',
                'Verify the icon is visible on a dark background. Edison icons typically use stroke="#fff" fill="none".'));
            }
          }
        }
      }
    }

    // Categories
    if (!step.categories || (Array.isArray(step.categories) && step.categories.length === 0)) {
      out.push(diag('TEMPLATE_NO_CATEGORIES', 'warning',
        'Step has no categories — the Step Builder requires at least one category for publishing',
        'Add at least one category (e.g., ["API", "Utilities"])'));
    }

    // schemaType — only 'default' is valid in the Step Builder
    if (step.schemaType !== undefined && step.schemaType !== null && step.schemaType !== '' && step.schemaType !== 'default') {
      out.push(diag('TEMPLATE_INVALID_SCHEMA_TYPE', 'warning',
        `schemaType "${step.schemaType}" is not valid — only "default" is supported`,
        'Set schemaType to "default"',
        { value: step.schemaType }));
    }

    // tags should be an array
    if (step.tags !== undefined && step.tags !== null && !Array.isArray(step.tags)) {
      out.push(diag('TEMPLATE_INVALID_TAGS', 'warning',
        `tags must be an array, got ${typeof step.tags}`,
        'Set tags to an array of strings (e.g., ["api", "integration"])'));
    }

    // recommendedSteps should be an array
    if (step.recommendedSteps !== undefined && step.recommendedSteps !== null && !Array.isArray(step.recommendedSteps)) {
      out.push(diag('TEMPLATE_INVALID_RECOMMENDED_STEPS', 'warning',
        `recommendedSteps must be an array, got ${typeof step.recommendedSteps}`,
        'Set recommendedSteps to an array of step template IDs'));
    }

    // DataHub requires form object on step templates
    if (!step.form) {
      out.push(diag('TEMPLATE_MISSING_FORM', 'warning',
        'Step template has no form object — DataHub schema validation requires this field',
        'Add a form object: { template: "", code: "", component: "", style: "" }'));
    }

    if (!step.formBuilder || typeof step.formBuilder !== 'object') {
      out.push(diag('TEMPLATE_MISSING_FORMBUILDER', 'info',
        'Step template has no formBuilder — Edison UI may not render the step configuration panel',
        'Add formBuilder with stepInputs array for UI rendering'));
    } else if (!Array.isArray(step.formBuilder.stepInputs) || step.formBuilder.stepInputs.length === 0) {
      out.push(diag('TEMPLATE_EMPTY_FORMBUILDER', 'warning',
        'Step template has a formBuilder but no input components — the step configuration panel will be blank',
        'Add at least one input to formBuilder.stepInputs, or verify this step intentionally has no user-configurable fields'));
    }

    // formBuilder.stepExits component type and structural validation
    if (Array.isArray(step.formBuilder?.stepExits)) {
      const KNOWN_EXIT_COMPONENTS = new Set(['exitStatic', 'exitDynamic']);
      for (let ei = 0; ei < step.formBuilder.stepExits.length; ei++) {
        const exitComp = step.formBuilder.stepExits[ei];
        if (exitComp && !exitComp.component) {
          out.push(diag('FORM_EXIT_MISSING_COMPONENT', 'error',
            `formBuilder.stepExits[${ei}] (exit "${exitComp.data?.id || ei}") is missing the component field — Edison UI will crash with "J.split is not a function"`,
            'Set component to "exitStatic" (fixed exit) or "exitDynamic" (user-configurable)',
            { index: ei, exitDataId: exitComp.data?.id }));
        } else if (exitComp && exitComp.component && !KNOWN_EXIT_COMPONENTS.has(exitComp.component)) {
          out.push(diag('FORM_EXIT_UNKNOWN_COMPONENT', 'info',
            `formBuilder.stepExits[${ei}].component "${exitComp.component}" is not a known exit type`,
            'Exit components should be "exitStatic" (fixed exit) or "exitDynamic" (user-configurable)',
            { index: ei, component: exitComp.component }));
        }
        if (exitComp && !exitComp.id) {
          out.push(diag('FORM_EXIT_MISSING_ID', 'error',
            `formBuilder.stepExits[${ei}] (exit "${exitComp.data?.id || ei}") is missing a UUID id — when deployed in a flow, this causes the canvas to render blank`,
            'Add a UUID id field to the stepExit entry (e.g., crypto.randomUUID())',
            { index: ei, exitDataId: exitComp.data?.id }));
        }
        if (exitComp && !exitComp.data?.id) {
          out.push(diag('FORM_EXIT_MISSING_DATA_ID', 'error',
            `formBuilder.stepExits[${ei}] is missing data.id — Edison cannot match this exit to step wiring`,
            'Set data.id to the exit identifier (e.g., "next", "__error__")',
            { index: ei }));
        }
        if (exitComp?.data && exitComp.data.condition === undefined) {
          out.push(diag('FORM_EXIT_MISSING_CONDITION', 'warning',
            `formBuilder.stepExits[${ei}] (exit "${exitComp.data?.id || ei}") has no condition field — may cause rendering issues in flows`,
            'Set data.condition to "" for normal exits or "processError" for error exits',
            { index: ei, exitDataId: exitComp.data?.id }));
        }
      }

      // hasProcessError should have a matching __error__ stepExit
      if (step.formBuilder.hasProcessError === true) {
        const hasErrorExit = step.formBuilder.stepExits.some(e => e.data?.id === '__error__' || e.data?.condition === 'processError');
        if (!hasErrorExit) {
          out.push(diag('FORM_MISSING_ERROR_EXIT', 'warning',
            'formBuilder.hasProcessError is true but no __error__ stepExit exists — the error exit port won\'t render on the flow canvas',
            'Add a stepExit with data: { id: "__error__", label: "on error", condition: "processError" }'));
        }
      }

      // formBuilder.allowSkipStepLogic type check
      if (step.formBuilder.allowSkipStepLogic !== undefined && step.formBuilder.allowSkipStepLogic !== null
          && typeof step.formBuilder.allowSkipStepLogic !== 'boolean') {
        out.push(diag('FORM_INVALID_SKIP_LOGIC', 'warning',
          `formBuilder.allowSkipStepLogic must be a boolean, got ${typeof step.formBuilder.allowSkipStepLogic}`,
          'Set allowSkipStepLogic to true or false'));
      }
    }

    // formBuilder.formTemplate is needed for proper canvas rendering
    if (step.formBuilder && !step.formBuilder.formTemplate) {
      out.push(diag('FORM_MISSING_FORMTEMPLATE', 'warning',
        'formBuilder has no formTemplate — the step configuration panel may not render inputs correctly in flows',
        'Add the standard formTemplate: "<' + '%=' + ' inputs ? inputs.join(\'\\n\') : \'\' %' + '>"'));
    }

    const KNOWN_STEP_INPUT_COMPONENTS = new Set([
      'formTextInput', 'formTextBox', 'formCode', 'formSwitch', 'formCheckBox',
      'formSelectExpression', 'formMergeTagInput', 'formCollapsible', 'formList',
      'formDataOut', 'formWildcard', 'formAlert', 'formDivider', 'formHeader',
      'formGroupInputs', 'radioGroup', 'stepChooser', 'formTextMessage',
      'formTextReprompt', 'formVoicePrompt', 'formVoiceReprompt', 'formAsyncModule',
      'datepicker', 'validated_timestring', 'auth-external-component',
    ]);

    const stepInputs = step.formBuilder?.stepInputs;
    const hasAuthComponent = Array.isArray(stepInputs) && stepInputs.some(inp => {
      const comp = Array.isArray(inp?.component) ? inp.component[0] : inp?.component;
      return comp === 'auth-external-component';
    });

    if (Array.isArray(stepInputs)) {
      for (let si = 0; si < stepInputs.length; si++) {
        const inp = stepInputs[si];
        if (!inp || !inp.component) continue;
        const prefix = `formBuilder.stepInputs[${si}]`;
        const varName = inp.data?.variable || '';

        const compName = Array.isArray(inp.component) ? inp.component[0] : inp.component;
        if (compName && !KNOWN_STEP_INPUT_COMPONENTS.has(compName) && !compName.startsWith('or-')) {
          out.push(diag('FORM_UNKNOWN_COMPONENT', 'info',
            `${prefix}: component "${compName}" is not a recognized step input type`,
            `Known types: formTextInput, formSwitch, formSelectExpression, formCollapsible, formWildcard, etc. Verify "${compName}" is a valid registered component`,
            { index: si, component: compName }));
        }

        const MERGE_FIELD_COMPONENTS = new Set(['formTextInput', 'formCode', 'formTextBox']);
        if (MERGE_FIELD_COMPONENTS.has(inp.component) && !inp.data?.allowMergeFields) {
          out.push(diag('FORM_INPUT_NO_MERGE_FIELDS', 'error',
            `${prefix}: ${inp.component} "${varName || inp.data?.label || ''}" does not have allowMergeFields: true — users cannot pick merge fields from the UI, making the step unusable in other flows`,
            'Set allowMergeFields: true so users can select merge field data from preceding steps',
            { index: si, variable: varName }));
        }

        if (inp.component === 'formTextExpression' && varName) {
          out.push(diag('FORM_PREFER_TEXT_INPUT', 'info',
            `${prefix}: "${varName}" uses formTextExpression — prefer formTextInput with allowMergeFields: true for a better UI experience`,
            'formTextInput with allowMergeFields: true provides a visual merge field picker; formTextExpression requires users to write raw JS expressions. Use allowCodeMode: true if advanced users still need expression mode.',
            { index: si, variable: varName }));
        }

        // Detect plain text inputs used for credentials — should use auth-external-component
        if ((inp.component === 'formTextInput' || inp.component === 'formTextBox') && varName) {
          const credentialPatterns = /(?:api[_-]?key|apikey|secret|token|password|auth(?:orization)?[_-]?(?:key|token|secret)?|(?:anthropic|openai|stripe|airtable|twilio)[_-]?(?:key|api[_-]?key|secret|token)?|access[_-]?token|bearer[_-]?token|private[_-]?key|client[_-]?secret)$/i;
          const labelText = (inp.data?.label || '').toLowerCase();
          const isCredentialVar = credentialPatterns.test(varName);
          const isCredentialLabel = credentialPatterns.test(labelText.replace(/\s+/g, '_'));
          if ((isCredentialVar || isCredentialLabel) && !hasAuthComponent) {
            out.push(diag('AUTH_PLAIN_TEXT_INPUT', 'error',
              `${prefix}: "${varName}" appears to be an API key or credential but uses ${inp.component} instead of auth-external-component — credentials will be stored in plain text in the flow JSON and will fail when the authorizer UI is used`,
              'Replace with auth-external-component for secure KV-backed credential storage. Use buildAuthInput() from stepBuilder or the standard auth-external-component pattern with keyValueCollection, fieldList, and the "inherited" sharing pattern.',
              { index: si, variable: varName, component: inp.component }));
          }
        }

        if (inp.data?.renderCondition && typeof inp.data.renderCondition === 'string' && inp.data.renderCondition.trim() !== '') {
          const rc = inp.data.renderCondition;
          const rcStripped = rc.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
          const referencedVars = rcStripped.match(/\b[a-zA-Z_]\w*\b/g) || [];
          const knownKeywords = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
          const jsOperators = new Set(['typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'this', 'return', 'if', 'else']);
          for (const ref of referencedVars) {
            if (knownKeywords.has(ref) || jsOperators.has(ref)) continue;
            if (ref === varName) continue;
            const refExists = stepInputs.some(other =>
              other?.data?.variable === ref && other !== inp
            );
            if (!refExists) {
              out.push(diag('FORM_RENDER_CONDITION_REF_MISSING', 'warning',
                `${prefix}: renderCondition "${rc}" references "${ref}" but no formBuilder input defines that variable — the Edison UI will throw ReferenceError when evaluating this condition`,
                `Add an input with variable: "${ref}" to formBuilder, or fix the renderCondition`,
                { index: si, variable: varName, referencedVariable: ref, renderCondition: rc }));
              break;
            }
          }
        }

        // Render condition: syntax validation (parse as JS expression)
        if (inp.data?.renderCondition && typeof inp.data.renderCondition === 'string' && inp.data.renderCondition.trim() !== '') {
          const rc = inp.data.renderCondition;
          try {
            new Function(`return (${rc});`);
          } catch (parseErr) {
            out.push(diag('RENDER_CONDITION_SYNTAX_ERROR', 'error',
              `${prefix}: renderCondition "${rc}" is not a valid JavaScript expression — ${parseErr.message}`,
              'Fix the expression syntax. Render conditions are evaluated via eval() in Edison and must be valid JS expressions.',
              { index: si, variable: varName, renderCondition: rc, parseError: parseErr.message }));
          }

          // Render condition: runtime simulation against template defaults
          const scope = {};
          for (const other of stepInputs) {
            const otherVar = other?.data?.variable;
            if (!otherVar) continue;
            const dv = other.data.defaultValue;
            if (typeof dv === 'string' && dv.startsWith('`') && dv.endsWith('`')) {
              try { scope[otherVar] = new Function(`return ${dv};`)(); } catch (_) { scope[otherVar] = dv; }
            } else if (typeof dv === 'boolean' || typeof dv === 'number') {
              scope[otherVar] = dv;
            } else if (dv !== undefined && dv !== '') {
              scope[otherVar] = dv;
            }
          }
          try {
            const keys = Object.keys(scope);
            const vals = keys.map(k => scope[k]);
            new Function(...keys, `return (${rc});`)(...vals);
          } catch (runtimeErr) {
            if (runtimeErr instanceof ReferenceError) {
              out.push(diag('RENDER_CONDITION_RUNTIME_ERROR', 'warning',
                `${prefix}: renderCondition "${rc}" throws ${runtimeErr.message} when evaluated with default input values — Edison's form UI will crash with this error at render time`,
                'Ensure all variables in the condition are defined as formBuilder inputs with default values. Edison evaluates render conditions with the step data as scope.',
                { index: si, variable: varName, renderCondition: rc, runtimeError: runtimeErr.message, scope }));
            }
          }
        }

        // renderConditionBuilder presence check
        if (!inp.data?.renderConditionBuilder || typeof inp.data.renderConditionBuilder !== 'object') {
          out.push(diag('RENDER_CONDITION_BUILDER_MISSING', 'error',
            `${prefix}: input "${varName || '(unnamed)'}" is missing renderConditionBuilder — Edison requires this object on every input for conditional visibility to work`,
            'Add renderConditionBuilder: { label: "`Conditional visibility`", rules: [], trueValue: "any", description: "``", defaultValue: true, isNotCollapsed: false, isEditableHeader: false }',
            { index: si, variable: varName }));
        }

        // renderConditionBuilder validation (object-based conditional visibility)
        const rcb = inp.data?.renderConditionBuilder;
        if (rcb && typeof rcb === 'object') {
          validateConditionBuilder(rcb, `${prefix}`, 'renderConditionBuilder', si, varName, stepInputs, inp, out);

          // Coherence: if renderCondition string is non-empty AND renderConditionBuilder has rules,
          // Edison uses renderCondition (string) when present, ignoring the builder rules
          const rcStr = inp.data?.renderCondition;
          if (typeof rcStr === 'string' && rcStr.trim() !== '' && Array.isArray(rcb.rules) && rcb.rules.length > 0) {
            out.push(diag('RENDER_CONDITION_DUAL_CONFIG', 'warning',
              `${prefix}: input "${varName}" has both a renderCondition expression ("${rcStr}") AND renderConditionBuilder rules (${rcb.rules.length} rule(s)) — Edison evaluates the string expression and ignores the builder rules`,
              'Use one approach: either a renderCondition string expression OR renderConditionBuilder rules, not both',
              { index: si, variable: varName, renderCondition: rcStr, ruleCount: rcb.rules.length }));
          }
        }

        // disabledCondition string expression validation
        if (inp.data?.disabledCondition && typeof inp.data.disabledCondition === 'string' && inp.data.disabledCondition.trim() !== '') {
          const dc = inp.data.disabledCondition;
          try {
            new Function(`return (${dc});`);
          } catch (parseErr) {
            out.push(diag('DISABLE_CONDITION_SYNTAX_ERROR', 'error',
              `${prefix}: disabledCondition "${dc}" is not a valid JavaScript expression — ${parseErr.message}`,
              'Fix the expression syntax. Disabled conditions are evaluated in the same scope as renderConditions.',
              { index: si, variable: varName, disabledCondition: dc, parseError: parseErr.message }));
          }

          const dcStripped = dc.replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '');
          const dcVars = dcStripped.match(/\b[a-zA-Z_]\w*\b/g) || [];
          const knownKeywords2 = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
          const jsOps2 = new Set(['typeof', 'instanceof', 'in', 'new', 'delete', 'void', 'this', 'return', 'if', 'else', 'schema']);
          for (const ref of dcVars) {
            if (knownKeywords2.has(ref) || jsOps2.has(ref)) continue;
            if (ref === varName) continue;
            const refExists = stepInputs.some(other =>
              other?.data?.variable === ref && other !== inp
            );
            if (!refExists) {
              out.push(diag('DISABLE_CONDITION_REF_MISSING', 'warning',
                `${prefix}: disabledCondition "${dc}" references "${ref}" but no formBuilder input defines that variable`,
                `Add an input with variable: "${ref}" to formBuilder, or fix the disabledCondition`,
                { index: si, variable: varName, referencedVariable: ref, disabledCondition: dc }));
              break;
            }
          }
        }

        // disableConditionBuilder validation
        const dcb = inp.data?.disableConditionBuilder;
        if (dcb && typeof dcb === 'object') {
          validateConditionBuilder(dcb, `${prefix}`, 'disableConditionBuilder', si, varName, stepInputs, inp, out);
        }

        // --- Sensitive field detection ---
        const SENSITIVE_VAR_PATTERNS = /^(api[_-]?key|apikey|secret|password|passwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token|private[_-]?key|client[_-]?secret|bearer|credential|ssh[_-]?key|signing[_-]?key)$/i;
        const SENSITIVE_LABEL_PATTERNS = /\b(api\s*key|secret|password|token|private\s*key|client\s*secret|credential|bearer|signing\s*key)\b/i;
        const isSensitiveVar = varName && SENSITIVE_VAR_PATTERNS.test(varName);
        const isSensitiveLabel = inp.data?.label && SENSITIVE_LABEL_PATTERNS.test(inp.data.label);

        if ((isSensitiveVar || isSensitiveLabel) && ['formTextInput', 'formTextBox', 'formCode'].includes(inp.component)) {
          if (!hasAuthComponent) {
            out.push(diag('AUTH_SHOULD_USE_COMPONENT', 'warning',
              `${prefix}: "${varName || inp.data?.label}" holds credentials in a plain text input instead of the auth-external-component — ` +
              `credentials stored in text fields are visible in flow JSON and cannot be shared across steps`,
              'Replace this text input with an auth-external-component: use component: ["auth-external-component", ' +
              '"https://content-assets.onereach.ai/component/authorizer2/v1.0.8/index.js"], set keyValueCollection: ' +
              '"__authorization_service_{ServiceName}", and add a fieldList entry for each credential field (e.g., ' +
              '{masked: true, fieldName: "apiKey", fieldLabel: "API Key"}). In the step logic, use the inheritance ' +
              'pattern: if (auth === \'inherited\') auth = await this.getShared(`shared_${collection}`); else await ' +
              'this.setShared(`shared_${collection}`, auth); then read credentials via storage.get(collection, auth).',
              { index: si, variable: varName, label: inp.data?.label }));
          }

          if (!inp.data?.allowMergeFields) {
            out.push(diag('INPUT_SENSITIVE_NO_MERGE_FIELDS', 'error',
              `${prefix}: "${varName || inp.data?.label}" appears to hold sensitive data but allowMergeFields is false — the value must be hardcoded in the step UI instead of wired from a secure source`,
              'Set allowMergeFields: true so flow builders can wire the value from a "Get Value from Storage" step or an environment variable merge field instead of pasting secrets into the UI',
              { index: si, variable: varName, label: inp.data?.label }));
          } else {
            out.push(diag('INPUT_SENSITIVE_FIELD', 'info',
              `${prefix}: "${varName || inp.data?.label}" appears to hold sensitive data — ensure helpText instructs flow builders to wire this from a secure source, not paste plaintext credentials`,
              'Add helpText like: "Wire from a \'Get Value from Storage\' step or environment variable. Never paste raw credentials." Also consider adding a placeholder like "Wire from storage step →"',
              { index: si, variable: varName, label: inp.data?.label }));
          }

          if (inp.data?.defaultValue && typeof inp.data.defaultValue === 'string' && inp.data.defaultValue.trim() !== '' && inp.data.defaultValue !== '``') {
            out.push(diag('SECRET_IN_DEFAULT_VALUE', 'error',
              `${prefix}: "${varName || inp.data?.label}" looks like a sensitive field but has a non-empty defaultValue — this value is stored in plain text in the flow JSON and visible to anyone with flow access`,
              'Remove the defaultValue. Sensitive values should be wired at runtime from a secure storage step or environment variable, never baked into the step template',
              { index: si, variable: varName, defaultValue: inp.data.defaultValue.slice(0, 20) + (inp.data.defaultValue.length > 20 ? '...' : '') }));
          }
        }

        // Check all inputs for literal secrets in defaultValue (regardless of name)
        if (inp.data?.defaultValue && typeof inp.data.defaultValue === 'string') {
          for (const { re, label } of SECRET_VALUE_PATTERNS_INPUT) {
            if (re.test(inp.data.defaultValue)) {
              out.push(diag('SECRET_IN_DEFAULT_VALUE', 'error',
                `${prefix}: defaultValue contains what looks like a ${label} — secrets must not be hardcoded in step template inputs`,
                'Remove the defaultValue and instruct users to wire secrets from a secure source (storage step, environment variable)',
                { index: si, variable: varName, secretType: label }));
              break;
            }
          }
        }

        // --- Reusable component quality checks ---

        if (inp.data && !inp.data.label && !inp.data.collapsibleTitle && inp.component !== 'formWildcard' && inp.component !== 'formDataOut' && compName !== 'auth-external-component') {
          out.push(diag('INPUT_MISSING_LABEL', 'warning',
            `${prefix}: input "${varName || '(unnamed)'}" has no label — the step UI will show a blank field header`,
            'Set data.label to a descriptive name for this input',
            { index: si, variable: varName }));
        }

        if (inp.data && !inp.data.helpText && ['formTextInput', 'formSelectExpression', 'formTextBox', 'formCode'].includes(inp.component)) {
          out.push(diag('INPUT_MISSING_HELPTEXT', 'info',
            `${prefix}: "${varName || inp.data?.label || ''}" has no helpText — flow builders won't know what this field is for`,
            'Set data.helpText to a short description (e.g., "The user email for preference lookup")',
            { index: si, variable: varName }));
        }

        if (varName && !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(varName)) {
          out.push(diag('INPUT_INVALID_VARIABLE_NAME', 'warning',
            `${prefix}: variable "${varName}" is not a valid JavaScript identifier — the compiler cannot destructure it as a templateLogic() parameter, so the step will not receive this input`,
            'Use a valid JS identifier (letters, digits, _, $; not starting with a digit)',
            { index: si, variable: varName }));
        }

        if (inp.component === 'formSelectExpression' && Array.isArray(inp.data?.options)) {
          for (const opt of inp.data.options) {
            if (opt && typeof opt.value === 'string' && opt.value && !opt.value.startsWith('`') && !opt.value.startsWith('"') && !opt.value.startsWith("'")) {
              out.push(diag('SELECT_OPTION_NOT_EXPRESSION', 'warning',
                `${prefix}: option value "${opt.value}" for "${varName}" is not wrapped in backticks — Edison expects expression strings (e.g., \`\`init\`\`)`,
                'Wrap option values in backticks: { label: "Init", value: "`init`" }',
                { index: si, variable: varName, optionValue: opt.value }));
              break;
            }
          }
        }

        if (inp.component === 'formDataOut') {
          if (!inp.data?.defaultName) {
            out.push(diag('DATAOUT_INPUT_NO_DEFAULT_NAME', 'warning',
              `${prefix}: formDataOut has no defaultName — the merge field name will be empty until the user types one`,
              'Set data.defaultName to a sensible merge field name (e.g., "apiResult")',
              { index: si }));
          }

          if (inp.data?.defaultName && step.data?.dataOut && typeof step.data.dataOut === 'object') {
            if (!step.data.dataOut.name) {
              out.push(diag('DATAOUT_NAME_NOT_SET', 'warning',
                `${prefix}: formDataOut sets defaultName "${inp.data.defaultName}" but data.dataOut has no name — the Design tab will show the default but the runtime dataOut will be unnamed`,
                `Set data.dataOut.name to "${inp.data.defaultName}"`,
                { defaultName: inp.data.defaultName, index: si }));
            } else if (step.data.dataOut.name !== inp.data.defaultName) {
              out.push(diag('DATAOUT_NAME_DEFAULTNAME_MISMATCH', 'warning',
                `${prefix}: formDataOut defaultName is "${inp.data.defaultName}" but data.dataOut.name is "${step.data.dataOut.name}" — users see one name in the Design tab but a different one is actually used at runtime`,
                `Align them: set data.dataOut.name to "${inp.data.defaultName}" or update formDataOut defaultName to "${step.data.dataOut.name}"`,
                { defaultName: inp.data.defaultName, dataOutName: step.data.dataOut.name, index: si }));
            }
          }

          if (inp.data?.defaultName && (!step.data?.dataOut || typeof step.data.dataOut !== 'object')) {
            out.push(diag('DATAOUT_FORM_WITHOUT_DATA', 'warning',
              `${prefix}: formDataOut has defaultName "${inp.data.defaultName}" but data.dataOut is not configured — the Design tab shows a merge field name but no data will be written at runtime`,
              `Add data.dataOut = { name: "${inp.data.defaultName}", type: "session", ttl: 86400000 }`,
              { defaultName: inp.data.defaultName, index: si }));
          }
        }

        if (inp.component !== 'formWildcard' && compName !== 'formAsyncModule') continue;

        // ---------------------------------------------------------------
        // formAsyncModule-specific checks
        // ---------------------------------------------------------------
        if (compName === 'formAsyncModule') {
          const amData = inp.data || {};

          if (!amData.componentUrl || typeof amData.componentUrl !== 'string' || amData.componentUrl.trim() === '') {
            out.push(diag('ASYNC_MODULE_NO_URL', 'error',
              `${prefix}: formAsyncModule has no componentUrl — the async module cannot load without a URL pointing to the built JS bundle`,
              'Set data.componentUrl to a CDN or dev-server URL (e.g., "https://files.edison.api.onereach.ai/.../index.mjs")',
              { index: si }));
          } else {
            const url = amData.componentUrl;
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
              out.push(diag('ASYNC_MODULE_URL_NOT_HTTP', 'warning',
                `${prefix}: componentUrl "${url}" does not start with http(s):// — Edison loads async modules via dynamic import, non-HTTP URLs will fail`,
                'Use a full HTTP(S) URL to the built module bundle',
                { index: si, componentUrl: url }));
            }
            if (url.includes('localhost') || url.includes('127.0.0.1')) {
              out.push(diag('ASYNC_MODULE_LOCALHOST_URL', 'warning',
                `${prefix}: componentUrl points to localhost — this will only work during local development and will fail when deployed`,
                'Replace with the CDN URL after building and uploading the module',
                { index: si, componentUrl: url }));
            }
          }

          if (!amData.toJson || typeof amData.toJson !== 'string' || amData.toJson.trim() === '') {
            out.push(diag('ASYNC_MODULE_NO_TOJSON', 'error',
              `${prefix}: formAsyncModule has no toJson serializer — field values will not be backtick-wrapped, causing runtime eval failures in Edison`,
              'Add the standard toJson function that wraps values with backticks for Edison expression evaluation',
              { index: si }));
          }

          if (!amData.data || (typeof amData.data === 'string' && amData.data.trim() === '{}') || (typeof amData.data === 'string' && amData.data.trim() === '')) {
            out.push(diag('ASYNC_MODULE_EMPTY_DATA', 'warning',
              `${prefix}: formAsyncModule data schema is empty — no fields are defined for the module to bind to`,
              'Populate data with field defaults (e.g., {"fieldName": "`default`"})',
              { index: si }));
          }

          if (amData.applyToJson !== true) {
            out.push(diag('ASYNC_MODULE_TOJSON_DISABLED', 'error',
              `${prefix}: formAsyncModule has applyToJson=${amData.applyToJson} — the toJson serializer will not run, and field data will not be wrapped for Edison expression evaluation`,
              'Set data.applyToJson = true to enable the serializer',
              { index: si, applyToJson: amData.applyToJson }));
          }

          // Rule 6.1 — both pluginRefs must be present, or Studio refuses to mount.
          const pluginRefs = Array.isArray(inp.pluginRefs) ? inp.pluginRefs : [];
          const hasOrUiPlugin = pluginRefs.some(r => typeof r === 'string' && r.includes('or-ui-components'));
          const hasFormAsyncModule = pluginRefs.some(r => typeof r === 'string' && r.includes('formAsyncModule'));
          if (!hasOrUiPlugin || !hasFormAsyncModule) {
            out.push(diag('ASYNC_MODULE_NO_PLUGIN_REFS', 'error',
              `${prefix}: formAsyncModule is missing required pluginRefs — Studio refuses to mount the module without both "or-ui-components" and "formAsyncModule" plugin entries`,
              'Add both entries to pluginRefs: `onereach-studio-plugin["<components-url>"]["or-ui-components"]` and `onereach-studio-form-input["<components-url>"]["formAsyncModule"]`',
              { index: si, pluginRefs, hasOrUiPlugin, hasFormAsyncModule }));
          }

          // Rule 6.4 — validators field required for Vuelidate-based save gating.
          if (!amData.validators || (typeof amData.validators === 'string' && amData.validators.trim() === '')) {
            out.push(diag('ASYNC_MODULE_VALIDATORS_MISSING', 'error',
              `${prefix}: formAsyncModule has no validators — Save can't gate on required fields and merge-field refs aren't passed through correctly`,
              'Add a validators block (Vuelidate-style) that returns {} or an object keyed by field name; see lib/asyncModuleBuilder.js buildAsyncModuleValidators() for the canonical shape',
              { index: si }));
          }

          // Rule 6.3 — Vue must be externalized. Heuristic: module bundle URL
          // pointing at a .mjs file that was built without the Vue external is
          // undetectable from step.json alone; this rule fires on an explicit
          // amData.componentBundledVue: true marker that asyncModuleBuilder.js
          // can emit when it detects a bundled-Vue build during scaffold. It
          // also fires when componentLogic contains a literal `Vue.createApp`
          // or `import Vue from 'vue'` string (rare but definitive).
          const logic = (amData.componentLogic || '') + '\n' + (amData.componentTemplate || '');
          if (amData.componentBundledVue === true
              || /import\s+Vue\s+from\s+['"]vue['"]/.test(logic)
              || /Vue\.createApp\s*\(/.test(logic)) {
            out.push(diag('ASYNC_MODULE_VUE_BUNDLED', 'warning',
              `${prefix}: formAsyncModule appears to bundle Vue — double-registration will break reactivity at runtime`,
              'Configure Vite to externalize vue: resolve.alias maps "vue" to shims/vue.js re-exporting window.Vue, and rollupOptions.output.globals: { vue: "Vue" }',
              { index: si }));
          }

          if (amData.componentUrl && typeof amData.componentUrl === 'string' && !amData.componentUrl.endsWith('.mjs') && !amData.componentUrl.endsWith('.js') && !amData.componentUrl.includes('.vue')) {
            out.push(diag('ASYNC_MODULE_URL_EXTENSION', 'info',
              `${prefix}: componentUrl does not end with .mjs or .js — ensure the URL points to the built ESM bundle`,
              'Vite builds output index.mjs by default; ensure the URL ends with the correct file extension',
              { index: si, componentUrl: amData.componentUrl }));
          }

          // Width / field-count heuristic
          let fieldCount = 0;
          try {
            const parsed = typeof amData.data === 'string' ? JSON.parse(amData.data) : amData.data;
            if (parsed && typeof parsed === 'object') fieldCount = Object.keys(parsed).length;
          } catch (_) { /* unparseable data */ }

          if (fieldCount > 12) {
            out.push(diag('ASYNC_MODULE_WIDE_LAYOUT', 'warning',
              `${prefix}: formAsyncModule defines ${fieldCount} fields — the Edison step panel is ~360px wide; this many inline fields will be cramped and hard to configure`,
              'Use a modal/dialog pattern: render a compact summary with an "Open Settings" button in the panel, then show a position:fixed overlay with the full form when clicked',
              { index: si, fieldCount }));
          } else if (fieldCount > 8) {
            out.push(diag('ASYNC_MODULE_WIDE_LAYOUT', 'info',
              `${prefix}: formAsyncModule defines ${fieldCount} fields — consider grouping with collapsible sections or a modal dialog to keep the step panel usable`,
              'Use collapsible sections for secondary fields, or switch to a modal pattern for complex configurations',
              { index: si, fieldCount }));
          }

          continue;
        }

        const wcData = inp.data || {};

        if (!wcData.formTemplate && !wcData.componentTemplate) {
          out.push(diag('WILDCARD_MISSING_TEMPLATE', 'warning',
            `${prefix}: formWildcard has neither formTemplate nor componentTemplate`,
            'Add formTemplate with the Vue template HTML for this wildcard'));
        }

        if (!wcData.componentLogic) {
          out.push(diag('WILDCARD_MISSING_LOGIC', 'info',
            `${prefix}: formWildcard has no componentLogic`,
            'Add componentLogic with at minimum a props definition to handle data binding'));
        }

        const logic = wcData.componentLogic || '';

        // Detect wildcardTemplates ERB references with no wildcardTemplates entries at all
        const erbPat = new RegExp('<' + '%=\\s*(\\w+)\\s*%' + '>', 'g');
        const erbRefs = logic.match(erbPat);
        if (erbRefs) {
          const wcTemplates = Array.isArray(wcData.wildcardTemplates) ? wcData.wildcardTemplates : [];
          if (wcTemplates.length === 0) {
            out.push(diag('WILDCARD_TEMPLATE_REF_MISSING', 'warning',
              prefix + ': componentLogic uses ERB template references but wildcardTemplates is empty',
              'Add wildcardTemplates entries with matching sub-component templates'));
          } else {
            const titlePat = new RegExp('<' + '%=\\s*(\\w+)\\s*%' + '>', 'g');
            let titleMatch;
            const templateTitles = new Set(wcTemplates.map(t => t.title));
            while ((titleMatch = titlePat.exec(logic)) !== null) {
              const refName = titleMatch[1];
              if (!templateTitles.has(refName)) {
                out.push(diag('WILDCARD_TEMPLATE_REF_UNRESOLVED', 'warning',
                  `${prefix}: ERB reference "<` + `%= ${refName} %` + `>" does not match any wildcardTemplates title`,
                  `Add a wildcardTemplates entry with title: "${refName}" or fix the reference`,
                  { reference: refName, availableTitles: [...templateTitles] }));
              }
            }
          }
        }

        if (logic) {
          if (/\bbeforeDestroy\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_LIFECYCLE', 'warning',
              `${prefix}: componentLogic uses beforeDestroy (renamed in Vue 3)`,
              'Use beforeUnmount instead of beforeDestroy'));
          }
          if (/\bdestroyed\b/.test(logic) && !/\bbeforeDestroy\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_LIFECYCLE', 'warning',
              `${prefix}: componentLogic uses destroyed (renamed in Vue 3)`,
              'Use unmounted instead of destroyed'));
          }
          if (/this\.\$set\b/.test(logic) || /Vue\.set\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_REACTIVITY', 'warning',
              `${prefix}: componentLogic uses Vue.set/$set (not needed in Vue 3)`,
              'Remove Vue.set/$set — Vue 3 reactivity tracks property additions automatically'));
          }
          if (/this\.\$delete\b/.test(logic) || /Vue\.delete\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_REACTIVITY', 'warning',
              `${prefix}: componentLogic uses Vue.delete/$delete (not needed in Vue 3)`,
              'Use the delete operator directly'));
          }
          if (/this\.\$on\b/.test(logic) || /this\.\$off\b/.test(logic) || /this\.\$once\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_EVENT_BUS', 'warning',
              `${prefix}: componentLogic uses this.$on/$off/$once (removed in Vue 3)`,
              'Use mitt or another event emitter library'));
          }
          if (/this\.\$listeners\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_LISTENERS', 'warning',
              `${prefix}: componentLogic references this.$listeners (removed in Vue 3)`,
              'Access listeners via this.$attrs instead'));
          }
          if (/this\.\$scopedSlots\b/.test(logic)) {
            out.push(diag('WILDCARD_VUE2_SCOPED_SLOTS', 'warning',
              `${prefix}: componentLogic references this.$scopedSlots (removed in Vue 3)`,
              'Use this.$slots instead — all slots are scoped in Vue 3'));
          }
        }

        const wcTemplate = wcData.formTemplate || wcData.componentTemplate || '';
        if (wcTemplate) {
          if (/v-on=["']?\$listeners["']?/.test(wcTemplate)) {
            out.push(diag('WILDCARD_VUE2_LISTENERS', 'warning',
              `${prefix}: template uses $listeners (removed in Vue 3)`,
              'Remove v-on="$listeners" — in Vue 3, listeners are part of $attrs'));
          }
          if (/\$scopedSlots/.test(wcTemplate)) {
            out.push(diag('WILDCARD_VUE2_SCOPED_SLOTS', 'warning',
              `${prefix}: template references $scopedSlots (removed in Vue 3)`,
              'Use $slots instead'));
          }
        }

        const wcTmpl = wcData.formTemplate || '';
        if (wcTmpl) {
          const contextProps = [
            { attr: ':schema', name: 'schema', required: true },
            { attr: ':steps', name: 'steps', required: false },
            { attr: ':step-id', name: 'stepId', required: false },
            { attr: ':merge-fields', name: 'mergeFields', required: false },
            { attr: ':readonly', name: 'readonly', required: false },
          ];
          for (const { attr, name, required } of contextProps) {
            if (!wcTmpl.includes(attr) && !wcTmpl.includes(`v-bind:${name.replace(/([A-Z])/g, '-$1').toLowerCase()}`)) {
              if (required) {
                out.push(diag('WILDCARD_MISSING_SCHEMA_BINDING', 'warning',
                  `${prefix}: formTemplate does not pass ${attr}="${name}" to the wildcard — the component cannot bind to step data`,
                  `Add ${attr}="${name}" to the wildcard tag in formTemplate`,
                  { index: si, prop: name }));
              } else if (logic && new RegExp(`this\\.${name}\\b|props.*${name}`).test(logic)) {
                out.push(diag('WILDCARD_CONTEXT_PROP_NOT_PASSED', 'info',
                  `${prefix}: componentLogic references "${name}" but formTemplate does not pass ${attr} — the prop will be undefined`,
                  `Add ${attr}="${name}" to the wildcard tag in formTemplate`,
                  { index: si, prop: name }));
              }
            }
          }
        }

        if (wcData.componentOriginalStyles && !wcData.componentCompiledStyles) {
          out.push(diag('WILDCARD_STYLES_NOT_COMPILED', 'info',
            `${prefix}: wildcard has componentOriginalStyles but no componentCompiledStyles — styles may not render`,
            'Compile the SCSS to CSS and set componentCompiledStyles, or use plain CSS in componentOriginalStyles',
            { index: si }));
        }

        if (wcData.toJson && !wcData.applyToJson) {
          out.push(diag('WILDCARD_TOJSON_NOT_APPLIED', 'info',
            `${prefix}: toJson function is defined but applyToJson is false — serialization function will not run`,
            'Set applyToJson to true if the toJson function should execute during serialization'));
        }

        if (wcData.validators !== undefined && wcData.validators !== null && wcData.validators !== '') {
          if (typeof wcData.validators !== 'string') {
            out.push(diag('WILDCARD_INVALID_VALIDATORS', 'warning',
              `${prefix}: validators must be a JavaScript object literal string, got ${typeof wcData.validators}`,
              'Set validators to a string containing a Vuelidate-compatible validation rules object'));
          }
        }

        if (wcData.renderConditionBuilder && typeof wcData.renderConditionBuilder === 'object') {
          validateConditionBuilder(wcData.renderConditionBuilder, `${prefix}`, 'renderConditionBuilder', si, null, stepInputs, null, out);
        }

        const hasDynamicExitsInLogic = logic && /\$emit\s*\(\s*['"`]update:exits['"`]/.test(logic);
        const wcTmplStr = wcData.formTemplate || '';
        const hasDynamicExitsInTemplate = /:exits\.sync=/.test(wcTmplStr) || /v-model:exits=/.test(wcTmplStr);

        if (hasDynamicExitsInLogic) {
          out.push(diag('WILDCARD_DYNAMIC_EXITS', 'info',
            `${prefix}: wildcard dynamically manipulates step exits via $emit("update:exits") — exits are managed at runtime`,
            'EXIT_NEVER_TAKEN diagnostics may be expected for exits that are added or removed dynamically by this wildcard',
            { pattern: 'emit' }));
        } else if (hasDynamicExitsInTemplate) {
          out.push(diag('WILDCARD_DYNAMIC_EXITS', 'info',
            `${prefix}: wildcard template binds exits via .sync — exits are managed at runtime`,
            'EXIT_NEVER_TAKEN diagnostics may be expected for exits that are added or removed dynamically by this wildcard',
            { pattern: 'sync' }));
        }

        // Check if wildcard exit manipulation could drop built-in exits
        if ((hasDynamicExitsInLogic || hasDynamicExitsInTemplate) && logic) {
          const filterPattern = /\.filter\s*\(/;
          const reassignPattern = /=\s*\[/;
          const splicePattern = /\.splice\s*\(/;
          const couldDropExits = filterPattern.test(logic) || reassignPattern.test(logic) || splicePattern.test(logic);

          if (couldDropExits) {
            const preservesError = /__error__|processError/i.test(logic);
            const preservesTimeout = /__timeout__|processTimeout/i.test(logic);
            const hasProcessError = step.data?.processError === true;
            const hasProcessTimeout = step.data?.processTimeout === true;

            if (hasProcessError && !preservesError) {
              out.push(diag('DYNAMIC_EXIT_MAY_DROP_BUILTIN', 'warning',
                `${prefix}: wildcard filters/reassigns exits but does not reference __error__ or processError — processError is enabled and the __error__ exit may be accidentally removed at runtime`,
                'Ensure the wildcard preserves __error__ and __timeout__ exits when manipulating the exits array: newExits = [...dynamicExits, ...exits.filter(e => e.id === "__error__" || e.id === "__timeout__")]',
                { pattern: 'error', processError: hasProcessError }));
            }
            if (hasProcessTimeout && !preservesTimeout) {
              out.push(diag('DYNAMIC_EXIT_MAY_DROP_BUILTIN', 'warning',
                `${prefix}: wildcard filters/reassigns exits but does not reference __timeout__ or processTimeout — processTimeout is enabled and the __timeout__ exit may be accidentally removed at runtime`,
                'Ensure the wildcard preserves __timeout__ exits when manipulating the exits array',
                { pattern: 'timeout', processTimeout: hasProcessTimeout }));
            }
          }
        }
      }
    }

    // --- Auth component quality checks ---
    if (hasAuthComponent) {
      const authInput = stepInputs.find(inp => {
        const comp = Array.isArray(inp?.component) ? inp.component[0] : inp?.component;
        return comp === 'auth-external-component';
      });
      const authCollection = authInput?.data?.keyValueCollection || '';
      const code = step.template || step.data?.template || '';

      if (authCollection && code) {
        const hasCollectionRef = code.includes(authCollection);
        const hasInheritedPattern = /auth\s*===?\s*['"`]inherited['"`]/.test(code);
        const hasGetShared = /this\.getShared\s*\(/.test(code);
        const hasSetShared = /this\.setShared\s*\(/.test(code);

        if (!hasCollectionRef) {
          out.push(diag('AUTH_MISSING_INHERITANCE', 'info',
            `Step has an auth-external-component with keyValueCollection "${authCollection}" but the template code does not reference this collection — credentials may not be read correctly`,
            `Add storage lookup code: const storage = new Storage(this); const { apiKey } = await storage.get('${authCollection}', auth);`,
            { collection: authCollection }));
        }

        if (!hasInheritedPattern || !hasGetShared || !hasSetShared) {
          out.push(diag('AUTH_MISSING_INHERITANCE', 'info',
            'Step has an auth-external-component but the template code is missing the standard credential inheritance pattern — ' +
            'other steps in the flow cannot share this authorization',
            'Add the inheritance pattern: if (auth === \'inherited\') auth = await this.getShared(`shared_${collection}`); ' +
            'else await this.setShared(`shared_${collection}`, auth);',
            { hasInheritedCheck: hasInheritedPattern, hasGetShared, hasSetShared }));
        }
      }
    }

    // Validate the template version — aligned with Step Builder UI
    // (step-builder-ui/packages/ui/src/vuex/builder/validations/getters.js)
    if (!step.version) {
      out.push(diag('TEMPLATE_MISSING_VERSION', 'warning',
        'Step template has no version — DataHub requires a version string',
        'Set version to a semver string (e.g., "1.0.0")'));
    }
    if (step.version) {
      const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z0-9.]+))?(?:\+([a-zA-Z0-9.]+))?$/;
      const CLEAN_RE = /^\d+\.\d+\.\d+$/;
      const parsed = SEMVER_RE.exec(step.version);
      if (!parsed) {
        out.push(diag('TEMPLATE_INVALID_VERSION', 'warning',
          `Step template version "${step.version}" is not valid semver — the Step Builder will reject it`,
          'Use semver format: major.minor.patch (e.g., "1.0.0")',
          { version: step.version }));
      } else if (step.version === '0.0.0') {
        out.push(diag('TEMPLATE_VERSION_ZERO', 'warning',
          'Version "0.0.0" is not publishable — the Step Builder rejects it',
          'Set version to at least "0.0.1"',
          { version: step.version }));
      } else if (!CLEAN_RE.test(step.version)) {
        const clean = `${parsed[1]}.${parsed[2]}.${parsed[3]}`;
        if (parsed[4]) {
          out.push(diag('TEMPLATE_VERSION_PRERELEASE', 'warning',
            `Version "${step.version}" contains a prerelease tag — the Step Builder does not allow prerelease versions for publishing`,
            'Remove the prerelease suffix for a publishable version',
            { version: step.version }));
        } else {
          out.push(diag('TEMPLATE_VERSION_NOT_CLEAN', 'warning',
            `Version "${step.version}" is valid semver but not in clean x.x.x format (cleaned: "${clean}") — the Step Builder requires clean format`,
            `Set version to "${clean}"`,
            { version: step.version, clean }));
        }
      }
    }

    // Data Hub: isGatewayStep must be boolean if present
    if (step.isGatewayStep !== null && step.isGatewayStep !== undefined && typeof step.isGatewayStep !== 'boolean') {
      out.push(diag('TEMPLATE_INVALID_GATEWAY_FLAG', 'warning',
        `isGatewayStep must be a boolean, got ${typeof step.isGatewayStep}`,
        'Set isGatewayStep to true or false'));
    }

    // Step Builder: gateway step forces shape arrow-down
    if (step.isGatewayStep === true && step.shape && step.shape !== 'arrow-down') {
      out.push(diag('TEMPLATE_GATEWAY_WRONG_SHAPE', 'warning',
        `Gateway step has shape "${step.shape}" — gateway steps should use "arrow-down"`,
        'Set shape to "arrow-down" (the Step Builder enforces this for gateway steps)',
        { shape: step.shape }));
    }

    // Step Builder: validate shape against known shapes
    const SB_VALID_SHAPES = [
      'arrow-down', 'arrow-left', 'arrow-right', 'arrow-up',
      'bubble-left', 'bubble-right',
      'circle', 'diamond', 'hexagon', 'octagon', 'pentagon',
      'plus', 'square', 'star', 'sun', 'triangle',
    ];
    if (step.shape && !SB_VALID_SHAPES.includes(step.shape)) {
      out.push(diag('TEMPLATE_INVALID_SHAPE', 'info',
        `Shape "${step.shape}" is not one of the 16 standard shapes`,
        'Valid shapes: ' + SB_VALID_SHAPES.join(', '),
        { shape: step.shape }));
    }

    // Step size convention:
    //   small  (circle)  — no end-user interaction (API calls, data processing)
    //   medium (hexagon) — end-user interaction OR HTTP-responding steps
    //   large  (octagon) — gateways, agents, orchestration
    const SIZE_SHAPES = { small: 'circle', medium: 'hexagon', large: 'octagon' };
    const VALID_SIZES = Object.keys(SIZE_SHAPES);

    if (step.size !== undefined && step.size !== null && step.size !== '') {
      if (!VALID_SIZES.includes(step.size)) {
        out.push(diag('TEMPLATE_INVALID_SIZE', 'warning',
          `size "${step.size}" is not valid — must be "small", "medium", or "large"`,
          'Set size to "small" (no user interaction), "medium" (user-facing / HTTP response), or "large" (gateway / agent)',
          { size: step.size, validSizes: VALID_SIZES }));
      } else if (step.shape && !step.isGatewayStep) {
        const expectedShape = SIZE_SHAPES[step.size];
        if (step.shape !== expectedShape) {
          out.push(diag('TEMPLATE_SIZE_SHAPE_MISMATCH', 'info',
            `size is "${step.size}" (expects shape "${expectedShape}") but shape is "${step.shape}"`,
            `Set shape to "${expectedShape}" or update size to match the current shape`,
            { size: step.size, expectedShape, actualShape: step.shape }));
        }
      }
    }

    if (step.isGatewayStep === true && step.size && step.size !== 'large') {
      out.push(diag('TEMPLATE_GATEWAY_SIZE_MISMATCH', 'info',
        `Gateway step has size "${step.size}" — gateways should be "large"`,
        'Set size to "large" for gateway steps',
        { size: step.size }));
    }

    // rootInputUrn format — namespace:packageName@version
    if (step.rootInputUrn !== undefined && step.rootInputUrn !== null && step.rootInputUrn !== '') {
      const urnPattern = /^[\w-]+:[\w-]+@\d+\.\d+\.\d+/;
      if (typeof step.rootInputUrn !== 'string') {
        out.push(diag('TEMPLATE_INVALID_ROOT_INPUT_URN', 'warning',
          `rootInputUrn must be a string, got ${typeof step.rootInputUrn}`,
          'Set rootInputUrn to format: namespace:packageName@version (e.g., "basic:si-root@1.2.3")'));
      } else if (!urnPattern.test(step.rootInputUrn) && !/^https?:\/\//.test(step.rootInputUrn)) {
        out.push(diag('TEMPLATE_INVALID_ROOT_INPUT_URN', 'warning',
          `rootInputUrn "${step.rootInputUrn}" does not match expected format`,
          'Use format: namespace:packageName@version (e.g., "basic:si-root@1.2.3") or an HTTP URL for development inputs'));
      }
    }

    // stepPackages should be an array
    if (step.stepPackages !== undefined && step.stepPackages !== null && !Array.isArray(step.stepPackages)) {
      out.push(diag('TEMPLATE_INVALID_STEP_PACKAGES', 'warning',
        `stepPackages must be an array, got ${typeof step.stepPackages}`,
        'Set stepPackages to an array of step package dependency objects'));
    }

    // Check form object structure (data-hub-reference Section 9)
    if (step.form && typeof step.form === 'object') {
      const KNOWN_FORM_KEYS = new Set(['template', 'code', 'component', 'style']);
      const unknownFormKeys = Object.keys(step.form).filter(k => !KNOWN_FORM_KEYS.has(k));
      if (unknownFormKeys.length > 0) {
        out.push(diag('TEMPLATE_FORM_INVALID', 'info',
          `form object has unexpected keys: ${unknownFormKeys.join(', ')} — expected only template, code, component, style`,
          'Remove unknown properties or verify they are intentional custom extensions',
          { unknownKeys: unknownFormKeys }));
      }
      for (const field of ['code', 'template', 'style']) {
        if (field in step.form && step.form[field] === null) {
          out.push(diag('TEMPLATE_FORM_NULL_FIELD', 'error',
            `form.${field} is null — Edison's SDK compiler will crash when attempting to render the step UI. Delete the property entirely instead of setting it to null`,
            `Remove form.${field} from the form object (use \`delete tpl.form.${field}\`) or omit it when constructing the template`));
        }
      }

      if (step.form.template && typeof step.form.template !== 'string') {
        out.push(diag('TEMPLATE_FORM_INVALID', 'warning',
          'form.template should be a string containing Vue.js template HTML',
          'Set form.template to a valid HTML string'));
      }

      const formHtml = typeof step.form.template === 'string' ? step.form.template : '';
      const formCode = typeof step.form.code === 'string' ? step.form.code : '';

      if (formHtml) {
        // Detect legacy (non-V3) component usage — V3 variants are the current standard
        const legacyComponents = [
          ['<or-button ', 'OrButtonV3'],
          ['<or-button>', 'OrButtonV3'],
          ['<or-input ', 'OrInputV3'],
          ['<or-input>', 'OrInputV3'],
          ['<or-select ', 'OrSelectV3'],
          ['<or-select>', 'OrSelectV3'],
          ['<or-checkbox ', 'OrCheckboxV3'],
          ['<or-checkbox>', 'OrCheckboxV3'],
          ['<or-radio ', 'OrRadioV3'],
          ['<or-radio>', 'OrRadioV3'],
          ['<or-switch ', 'OrSwitchV3'],
          ['<or-switch>', 'OrSwitchV3'],
          ['<or-modal ', 'OrModalV3'],
          ['<or-modal>', 'OrModalV3'],
          ['<or-tooltip ', 'OrTooltipV3'],
          ['<or-tooltip>', 'OrTooltipV3'],
          ['<or-icon ', 'OrIconV3'],
          ['<or-icon>', 'OrIconV3'],
          ['<or-label ', 'OrLabelV3'],
          ['<or-label>', 'OrLabelV3'],
          ['<or-textarea ', 'OrTextareaV3'],
          ['<or-textarea>', 'OrTextareaV3'],
          ['<or-slider ', 'OrSliderV3'],
          ['<or-slider>', 'OrSliderV3'],
          ['<or-tabs ', 'OrTabsV3'],
          ['<or-tabs>', 'OrTabsV3'],
          ['<or-toast ', 'OrToastV3'],
          ['<or-toast>', 'OrToastV3'],
          ['<or-loader ', 'OrLoaderV3'],
          ['<or-loader>', 'OrLoaderV3'],
          ['<or-card ', 'OrCardV3'],
          ['<or-card>', 'OrCardV3'],
        ];
        const foundLegacy = new Set();
        for (const [tag, v3Name] of legacyComponents) {
          if (formHtml.includes(tag) && !formHtml.includes(tag.replace('<or-', '<or-').replace(' ', '-v3 ').replace('>', '-v3>'))) {
            foundLegacy.add(v3Name);
          }
        }
        if (foundLegacy.size > 0) {
          out.push(diag('FORM_LEGACY_COMPONENTS', 'info',
            'Form template uses legacy (non-V3) UI components — V3 variants are the current standard',
            'Migrate to V3 components: ' + [...foundLegacy].join(', '),
            { components: [...foundLegacy] }));
        }

        // Detect Vue 2 patterns in form template
        if (/v-on="\$listeners"/.test(formHtml) || /v-on='\$listeners'/.test(formHtml)) {
          out.push(diag('FORM_VUE2_LISTENERS', 'warning',
            'Form template uses $listeners which is removed in Vue 3',
            'Remove v-on="$listeners" — in Vue 3, listeners are part of $attrs and forwarded automatically'));
        }

        if (/\$scopedSlots/.test(formHtml)) {
          out.push(diag('FORM_VUE2_SCOPED_SLOTS', 'warning',
            'Form template references $scopedSlots which is removed in Vue 3',
            'Use $slots instead — in Vue 3, all slots are scoped by default'));
        }
      }

      if (formCode) {
        // Vue 2 lifecycle hooks
        if (/\bbeforeDestroy\b/.test(formCode)) {
          out.push(diag('FORM_VUE2_LIFECYCLE', 'warning',
            'Form code uses beforeDestroy which is renamed in Vue 3',
            'Use beforeUnmount instead of beforeDestroy'));
        }
        if (/\bdestroyed\b/.test(formCode) && !/\bbeforeDestroy/.test(formCode)) {
          out.push(diag('FORM_VUE2_LIFECYCLE', 'warning',
            'Form code uses destroyed which is renamed in Vue 3',
            'Use unmounted instead of destroyed'));
        }

        // $listeners reference in code
        if (/this\.\$listeners/.test(formCode)) {
          out.push(diag('FORM_VUE2_LISTENERS', 'warning',
            'Form code references this.$listeners which is removed in Vue 3',
            'Access listeners via this.$attrs instead — in Vue 3, listeners are merged into $attrs'));
        }

        // $scopedSlots in code
        if (/this\.\$scopedSlots/.test(formCode)) {
          out.push(diag('FORM_VUE2_SCOPED_SLOTS', 'warning',
            'Form code references this.$scopedSlots which is removed in Vue 3',
            'Use this.$slots instead — all slots are scoped in Vue 3'));
        }

        // Vue.set / Vue.delete patterns
        if (/Vue\.set\b/.test(formCode) || /this\.\$set\b/.test(formCode)) {
          out.push(diag('FORM_VUE2_REACTIVITY', 'warning',
            'Form code uses Vue.set/$set which is not needed in Vue 3',
            'Remove Vue.set/$set — Vue 3 reactivity tracks property additions automatically'));
        }
        if (/Vue\.delete\b/.test(formCode) || /this\.\$delete\b/.test(formCode)) {
          out.push(diag('FORM_VUE2_REACTIVITY', 'warning',
            'Form code uses Vue.delete/$delete which is not needed in Vue 3',
            'Use the delete operator directly — Vue 3 reactivity tracks deletions automatically'));
        }

        // $on / $off / $once for event bus (removed in Vue 3)
        if (/this\.\$on\b/.test(formCode) || /this\.\$off\b/.test(formCode) || /this\.\$once\b/.test(formCode)) {
          out.push(diag('FORM_VUE2_EVENT_BUS', 'warning',
            'Form code uses this.$on/$off/$once which is removed in Vue 3',
            'Use mitt or another event emitter library for event bus patterns'));
        }
      }
    }

    // Step Builder: hooks validation (string hooksSource OR object { hookName: codeString })
    const KNOWN_HOOKS_SOURCE = ['beforeSaveFlow', 'flowDeactivated'];
    const KNOWN_HOOKS_CANVAS = ['step-added-to-canvas', 'step-removed-from-canvas'];
    const ALL_KNOWN_HOOKS = [...KNOWN_HOOKS_SOURCE, ...KNOWN_HOOKS_CANVAS];

    if (step.hooks && typeof step.hooks === 'string') {
      const hasExport = /module\.exports|export\s+default/.test(step.hooks);
      if (!hasExport) {
        out.push(diag('HOOKS_NO_EXPORT', 'info',
          'Hooks source does not export a module — lifecycle callbacks may not be invoked',
          'Export an object with hook functions via exports or export default'));
      }

      const hookFnPattern = /(\w+)\s*\(|(\w+)\s*:\s*(?:async\s+)?function/g;
      let hookMatch;
      const declaredHooks = new Set();
      while ((hookMatch = hookFnPattern.exec(step.hooks)) !== null) {
        const name = hookMatch[1] || hookMatch[2];
        if (name && !['function', 'async', 'if', 'for', 'while', 'switch', 'catch', 'return', 'module', 'exports', 'require'].includes(name)) {
          declaredHooks.add(name);
        }
      }
      for (const name of declaredHooks) {
        if (!KNOWN_HOOKS_SOURCE.includes(name) && !name.startsWith('_')) {
          out.push(diag('HOOKS_UNKNOWN_FUNCTION', 'info',
            `Hooks source declares "${name}" which is not a known lifecycle hook`,
            `Known hooks (source format): ${KNOWN_HOOKS_SOURCE.join(', ')}. Verify "${name}" is intentional or rename to a known hook`,
            { hookName: name, knownHooks: KNOWN_HOOKS_SOURCE }));
        }
      }
    } else if (step.hooks && typeof step.hooks === 'object' && !Array.isArray(step.hooks)) {
      for (const hookName of Object.keys(step.hooks)) {
        if (!ALL_KNOWN_HOOKS.includes(hookName) && !hookName.startsWith('_')) {
          out.push(diag('HOOKS_UNKNOWN_FUNCTION', 'info',
            `Hooks object contains "${hookName}" which is not a known hook`,
            `Known hooks: ${ALL_KNOWN_HOOKS.join(', ')}. Verify "${hookName}" is intentional`,
            { hookName, knownHooks: ALL_KNOWN_HOOKS }));
        }
        if (typeof step.hooks[hookName] !== 'string') {
          out.push(diag('HOOKS_INVALID_VALUE', 'warning',
            `Hook "${hookName}" value must be a code string, got ${typeof step.hooks[hookName]}`,
            'Each hook should be a JavaScript code string that executes when the hook fires',
            { hookName }));
        }
      }
    }

    // Step Builder: migration source structure
    if (step.migrations && Array.isArray(step.migrations)) {
      for (let mi = 0; mi < step.migrations.length; mi++) {
        const mig = step.migrations[mi];
        if (mig && !mig.version) {
          out.push(diag('MIGRATION_NO_VERSION', 'warning',
            `Migration at index ${mi} has no version — migrations must target a specific version`,
            'Add a version field to the migration entry',
            { index: mi }));
        }
        if (mig && mig.script && typeof mig.script === 'string' && mig.script.length > 0) {
          if (!/module\.exports|export\s+default/.test(mig.script)) {
            out.push(diag('MIGRATION_NO_EXPORT', 'info',
              `Migration at index ${mi} does not export a function`,
              'Export a migration function via exports or export default',
              { index: mi }));
          }
        }
      }

      const versionedMigrations = step.migrations
        .filter(m => m && m.version && /^\d+\.\d+\.\d+/.test(m.version))
        .map(m => m.version);
      for (let vi = 1; vi < versionedMigrations.length; vi++) {
        const prev = versionedMigrations[vi - 1].split('.').map(Number);
        const curr = versionedMigrations[vi].split('.').map(Number);
        const prevNum = prev[0] * 1e6 + prev[1] * 1e3 + prev[2];
        const currNum = curr[0] * 1e6 + curr[1] * 1e3 + curr[2];
        if (currNum < prevNum) {
          out.push(diag('MIGRATION_ORDER', 'warning',
            `Migration versions are not in ascending order: "${versionedMigrations[vi - 1]}" appears before "${versionedMigrations[vi]}"`,
            'Reorder migrations so versions are ascending (oldest first)',
            { versions: versionedMigrations }));
          break;
        }
      }
    }
  }

  return code;
}

const BUILTIN_MODULES = new Set([
  'fs', 'path', 'os', 'url', 'http', 'https', 'crypto', 'stream',
  'buffer', 'events', 'util', 'querystring', 'child_process', 'assert',
  'zlib', 'net', 'dns', 'tls', 'readline', 'string_decoder',
  'timers', 'vm', 'worker_threads', 'cluster', 'perf_hooks',
  'async_hooks', 'inspector', 'v8', 'process', 'console',
  'dgram', 'http2', 'punycode', 'domain', 'constants',
  'module', 'repl', 'tty', 'fs/promises', 'stream/promises',
  'path/posix', 'path/win32', 'diagnostics_channel', 'trace_events',
  'wasi', 'test'
]);

function isBuiltinModule(name) {
  return BUILTIN_MODULES.has(name) || name.startsWith('node:');
}

// ---------------------------------------------------------------------------
// 5. this.* API usage validation
// ---------------------------------------------------------------------------
function checkThisApi(code, out, opts = {}) {
  const lines = code.split('\n');
  // api-kind steps are inherently bound to an HTTP gateway flow — reading
  // request.body/query/headers via merge fields is part of their contract.
  // Downgrade the reusability rules to warnings for these steps; don't
  // suppress entirely because the code is still not portable across flows.
  const apiKind = opts.kind === 'api';

  lines.forEach((line, i) => {
    const num = i + 1;
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
    const stripped = stripStrings(trimmed);

    // this.mergeFields access without .get() — bracket notation
    const mfAccess = trimmed.match(/this\.mergeFields\s*\[\s*['"`](\w+)['"`]\s*\](?!\.)/);
    if (mfAccess) {
      out.push(diag('MERGEFIELD_NO_GET', 'warning',
        `Line ${num}: this.mergeFields['${mfAccess[1]}'] accessed without .get() or .set()`,
        `Use this.mergeFields['${mfAccess[1]}'].get() to read or .set(value) to write`,
        { line: num, field: mfAccess[1] }));
    }

    // this.mergeFields access without .get() — dot notation
    const MF_API_PROPS = new Set(['get', 'set', 'delete', 'has', 'keys', 'values', 'entries', 'forEach', 'size', 'clear']);
    const mfDotAccess = trimmed.match(/this\.mergeFields\.(\w+)/);
    if (mfDotAccess && !mfAccess) {
      const field = mfDotAccess[1];
      if (!MF_API_PROPS.has(field)) {
        const dotGetSetPattern = new RegExp(`this\\.mergeFields\\.${field}\\.(?:get|set)\\s*\\(`);
        if (!dotGetSetPattern.test(trimmed)) {
          out.push(diag('MERGEFIELD_NO_GET', 'warning',
            `Line ${num}: this.mergeFields.${field} accessed without .get() or .set()`,
            `Use this.mergeFields['${field}'].get() to read or .set(value) to write`,
            { line: num, field }));
        }
      }
    }

    // this.mergeFields.get() missing await
    if (/this\.mergeFields\s*\[\s*['"`]\w+['"`]\s*\]\.get\s*\(/.test(trimmed)) {
      if (!/await\s+this\.mergeFields/.test(trimmed) &&
          !/=\s*this\.mergeFields/.test(trimmed)) {
        out.push(diag('MERGEFIELD_GET_NO_AWAIT', 'warning',
          `Line ${num}: this.mergeFields[...].get() returns a Promise — should be awaited`,
          'Add "await" before this.mergeFields[...].get()',
          { line: num }));
      }
    }

    // this.mergeFields.set() missing await
    if (/this\.mergeFields\s*\[\s*['"`]\w+['"`]\s*\]\.set\s*\(/.test(trimmed)) {
      if (!/await\s+this\.mergeFields/.test(trimmed)) {
        out.push(diag('MERGEFIELD_SET_NO_AWAIT', 'warning',
          `Line ${num}: this.mergeFields[...].set() returns a Promise — should be awaited`,
          'Add "await" before this.mergeFields[...].set()',
          { line: num }));
      }
    }

    // -----------------------------------------------------------------------
    // STEP_LOGIC_HARDCODED_MERGE_REF — reusability gate.
    //
    // CLAUDE.md first principle: "NEVER reference this.mergeFields['name']
    // directly in step logic — that couples the step to a specific upstream".
    //
    // The only safe names are runtime merge fields (helpers, config, error,
    // session) — they exist in every flow. Anything else is either:
    //   1. An upstream step's dataOut name (e.g., httpCall, httpGatewayStep)
    //      → breaks when the step is placed in a flow with a different
    //        upstream or different gateway name.
    //   2. Reading API input (request.body/query/headers/params) via the
    //      gateway's merge field. API inputs MUST come through stepInputData
    //      (declared as formBuilder inputs) so the flow author — not the
    //      step code — decides where the value comes from.
    //
    // Covers both bracket (this.mergeFields['X']) and dot (this.mergeFields.X)
    // notation. Dynamic access (this.mergeFields[variable]) is NOT flagged
    // because the runtime name is decided by config, not hardcoded.
    // -----------------------------------------------------------------------
    {
      const MF_API_PROPS_LOCAL = new Set(['get', 'set', 'delete', 'has', 'keys', 'values', 'entries', 'forEach', 'size', 'clear']);
      const hitNames = [];

      // Only proceed if the pattern appears in the string-stripped version —
      // otherwise the `this.mergeFields[...]` text is living inside a string
      // literal (prompt text, log message, docstring example) and isn't
      // actually executed. stripStrings blanks string CONTENT but keeps
      // surrounding code, so real references survive; stringified examples
      // don't.
      const bracketIsCode = /this\.mergeFields\s*\[/.test(stripped);
      const dotIsCode = /this\.mergeFields\.\w+/.test(stripped);

      if (bracketIsCode) {
        const bracketRe = /this\.mergeFields\s*\[\s*['"`](\w+)['"`]\s*\]/g;
        let bm;
        while ((bm = bracketRe.exec(trimmed)) !== null) {
          if (!RUNTIME_MERGE_FIELD_NAMES.has(bm[1])) hitNames.push({ name: bm[1], access: 'bracket' });
        }
      }

      if (dotIsCode) {
        const dotRe = /this\.mergeFields\.(\w+)\b/g;
        let dm;
        while ((dm = dotRe.exec(trimmed)) !== null) {
          const n = dm[1];
          if (RUNTIME_MERGE_FIELD_NAMES.has(n)) continue;
          if (MF_API_PROPS_LOCAL.has(n)) continue; // .get / .set / .has — API methods, not a field name
          hitNames.push({ name: n, access: 'dot' });
        }
      }

      for (const hit of hitNames) {
        // Check if the same line reads an API input via a path arg —
        // that's the worst form of the violation and deserves a louder message.
        const pathMatch = trimmed.match(/\.get\s*\(\s*\{\s*path\s*:\s*['"`]([^'"`]+)['"`]/);
        const requestPath = pathMatch ? pathMatch[1] : null;
        const apiInput = requestPath && /^request\.(body|query|headers|params)\b/.test(requestPath);

        const ref = hit.access === 'bracket' ? `this.mergeFields['${hit.name}']` : `this.mergeFields.${hit.name}`;
        const why = apiInput
          ? `${ref} reads API input "${requestPath}" from an upstream merge field. ` +
            `Values passed to the flow via POST/GET (request.body, request.query, request.headers, request.params) ` +
            `MUST be wired through stepInputData — declared as formBuilder inputs — never read directly from an upstream's merge field. ` +
            `Otherwise the step only works in flows whose gateway step is named "${hit.name}".`
          : `${ref} hardcodes the upstream step name "${hit.name}". ` +
            `The step will silently misbehave in any flow where "${hit.name}" isn't the exact dataOut name of the intended upstream. ` +
            `Only runtime merge fields (${[...RUNTIME_MERGE_FIELD_NAMES].sort().join(', ')}) are safe to reference by literal name.`;

        out.push(diag('STEP_LOGIC_HARDCODED_MERGE_REF', apiKind ? 'warning' : 'error',
          `Line ${num}: ${why}` + (apiKind ? ' (downgraded to warning: step.json declares kind:"api", which is inherently gateway-bound)' : ''),
          `Declare an input in formBuilder.stepInputs (e.g. formTextInput with variable:"<name>") and read it via this.data['<name>']. ` +
          `The flow author binds the actual merge-field expression at the form level, keeping the step code portable. ` +
          `For request-body inputs specifically, the gateway/splice tooling auto-wires body fields into stepInputData when the input is declared.`,
          { line: num, field: hit.name, access: hit.access, requestPath, apiKind }));
      }

      // STEP_LOGIC_READS_API_INPUT — catches the dynamic-index loophole.
      //
      // Even when the merge-field name is pulled from a variable (e.g.
      //   const names = ['httpCall','httpGatewayStep'];
      //   for (const gw of names) { await this.mergeFields[gw].get({path: 'request.body.x'}); }
      // ) the fact that ANY merge field is being asked for a
      // request.body/query/headers/params path means the step is reading API
      // input directly from an upstream gateway. That's always a reusability
      // violation — no matter what the field name is — because request.* only
      // exists on HTTP gateway merge fields, which are flow-specific.
      //
      // Runtime merge fields (helpers, config, error, session) don't have a
      // `request` sub-path, so this regex is safe — it can only match
      // gateway/user-defined merge fields. Catches string paths and template
      // literals with ${...} interpolation (e.g. `request.body.${name}`).
      // Guard the same way — skip if .get( only appears inside a string literal.
      const getIsCode = /\.get\s*\(/.test(stripped);
      const API_INPUT_PATH_RE = /\.get\s*\(\s*\{\s*path\s*:\s*[`'"]request\.(body|query|headers|params)\.([^`'"]+)[`'"]/g;
      let apim;
      while (getIsCode && (apim = API_INPUT_PATH_RE.exec(trimmed)) !== null) {
        // Avoid double-reporting if we already flagged this line via the
        // hardcoded-name branch above (same line, same fix).
        const alreadyReported = hitNames.some(h => {
          const pm = trimmed.match(/\.get\s*\(\s*\{\s*path\s*:\s*[`'"]([^`'"]+)/);
          return pm && pm[1].startsWith(`request.${apim[1]}`);
        });
        if (alreadyReported) continue;

        const kind = apim[1];
        const fieldExpr = apim[2];
        out.push(diag('STEP_LOGIC_READS_API_INPUT', apiKind ? 'warning' : 'error',
          `Line ${num}: reads API input via .get({path: 'request.${kind}.${fieldExpr}'}) — ` +
          `request.${kind} only exists on HTTP gateway merge fields, so this hardcodes a dependency on a specific upstream gateway step. ` +
          `Values arriving in POST/GET calls MUST flow through stepInputData (declared as formBuilder inputs), never be read from an upstream's merge field.` +
          (apiKind ? ' (downgraded to warning: step.json declares kind:"api", which is inherently gateway-bound)' : ''),
          `Replace this read with this.data['<inputName>'] and declare <inputName> as a formBuilder input. ` +
          `The splice/gateway tooling auto-wires request.${kind}.<inputName> into stepInputData when the input is declared — that wiring is the flow author's responsibility, not the step code's.`,
          { line: num, requestKind: kind, field: fieldExpr, apiKind }));
      }
    }

    // this.exitStep without return
    if (/this\.exitStep\s*\(/.test(stripped) && !/return\s+(?:await\s+)?this\.exitStep/.test(stripped)) {
      if (!/^\s*(?:return|const|let|var)\b/.test(line)) {
        out.push(diag('EXITSTEP_NO_RETURN', 'warning',
          `Line ${num}: this.exitStep() should be returned — without return the step may continue executing`,
          'Add "return" before this.exitStep()',
          { line: num }));
      }
    }

    // this.getDataOut without await
    if (/this\.getDataOut\s*\(/.test(stripped) && !/await\s+this\.getDataOut/.test(stripped)) {
      out.push(diag('GETDATAOUT_NO_AWAIT', 'warning',
        `Line ${num}: this.getDataOut() returns a Promise — should be awaited`,
        'Add "await" before this.getDataOut()',
        { line: num }));
    }

    // this.end() without return
    if (/this\.end\s*\(/.test(stripped) && !/return\s+(?:await\s+)?this\.end/.test(stripped)) {
      if (!/^\s*return\b/.test(line)) {
        out.push(diag('END_NO_RETURN', 'warning',
          `Line ${num}: this.end() should be returned — without return the step may continue executing`,
          'Add "return" before this.end()',
          { line: num }));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Runtime merge fields — present in every flow, safe to hard-code
// ---------------------------------------------------------------------------
const RUNTIME_MERGE_FIELDS = {
  helpers: ['providersAccountId', 'sdkApiUrl', 'environmentSubdomain', 'httpGatewayUrl'],
  config:  ['accountId', 'flowId', 'botId', 'executionStartTime'],
  error:   ['message', 'name', 'stack'],
  session: ['reporting', 'reporting.sessionId', 'reporting.beginningSessionId',
            'reporting.previousSessionId', 'reporting.startTime'],
};
const RUNTIME_MERGE_FIELD_NAMES = new Set(Object.keys(RUNTIME_MERGE_FIELDS));

// ---------------------------------------------------------------------------
// 6. Form, DataOut, OutputExample & Input consistency validation
// ---------------------------------------------------------------------------
const DATA_BUILTIN_KEYS = new Set([
  'exits', 'processError', 'processTimeout', 'dataOut', 'timeoutDuration',
]);

function checkFormAndData(step, code, out) {
  const stepInputs = step.formBuilder?.stepInputs;
  const formVars = [];

  // DEFAULT_VALUE_MISMATCH — code fallback value differs from spec's declared
  // defaultValue. Runs once per stepInputs; no-op if no spec defaults declared.
  if (typeof code === 'string' && code.length > 0) {
    checkDefaultValueMismatch(code, stepInputs, out);
  }

  if (Array.isArray(stepInputs)) {
    // Collect variables from formBuilder inputs (skip components without a variable)
    const SKIP_COMPONENTS = new Set(['formDataOut', 'formWildcard', 'auth-external-component']);
    for (const inp of stepInputs) {
      const varName = inp.data?.variable;
      if (!varName) continue;
      if (SKIP_COMPONENTS.has(inp.component)) continue;
      if (Array.isArray(inp.component) && inp.component[0] === 'auth-external-component') continue;
      formVars.push(varName);
    }

    // 6a. Duplicate input variable names
    const seen = new Map();
    for (const v of formVars) {
      if (seen.has(v)) {
        out.push(diag('INPUT_DUPLICATE_VARIABLE', 'warning',
          `formBuilder input variable "${v}" is defined more than once — the later value will silently overwrite the earlier one`,
          `Remove the duplicate or rename one of the "${v}" inputs`,
          { variable: v }));
      } else {
        seen.set(v, true);
      }
    }

    // 6a-ii. Template data defaults should not contain hard-coded merge field
    //        expressions. Defaults should be form-friendly values (backtick
    //        strings, booleans, etc.) so the step is portable across flows.
    //        Exception: runtime merge fields (helpers, config, error, session)
    //        are present in every flow and are always safe to reference.
    const MERGE_REF_RE = /this\.mergeFields\[/;
    const MERGE_NAME_RE = /this\.mergeFields\[\s*['"`](\w+)['"`]\s*\]/g;
    const AWAIT_EXPR_RE = /^await\s/;
    for (const v of formVars) {
      const defaultVal = step.data?.[v];
      if (typeof defaultVal !== 'string') continue;

      if (MERGE_REF_RE.test(defaultVal)) {
        const names = [];
        let mm;
        const re = new RegExp(MERGE_NAME_RE.source, 'g');
        while ((mm = re.exec(defaultVal)) !== null) names.push(mm[1]);
        const allRuntime = names.length > 0 && names.every(n => RUNTIME_MERGE_FIELD_NAMES.has(n));
        if (!allRuntime) {
          out.push(diag('TEMPLATE_DATA_HARDCODED_MERGE_REF', 'error',
            `Template data default for "${v}" contains a hard-coded expression: "${defaultVal.substring(0, 80)}${defaultVal.length > 80 ? '...' : ''}" — ` +
            `defaults should be portable, form-friendly values (backtick-wrapped strings, booleans, selections). ` +
            `Hard-coded merge field references assume specific upstream steps exist and break portability when the step is placed in a different flow.`,
            `Replace data["${v}"] with a form-friendly default (e.g. \`\` for empty string, \`default_value\` for a string, true/false for a boolean)`,
            { variable: v, value: defaultVal.substring(0, 120) }));
        }
      } else if (AWAIT_EXPR_RE.test(defaultVal)) {
        out.push(diag('TEMPLATE_DATA_HARDCODED_MERGE_REF', 'error',
          `Template data default for "${v}" contains a hard-coded expression: "${defaultVal.substring(0, 80)}${defaultVal.length > 80 ? '...' : ''}" — ` +
          `defaults should be portable, form-friendly values (backtick-wrapped strings, booleans, selections). ` +
          `Hard-coded merge field references assume specific upstream steps exist and break portability when the step is placed in a different flow.`,
          `Replace data["${v}"] with a form-friendly default (e.g. \`\` for empty string, \`default_value\` for a string, true/false for a boolean)`,
          { variable: v, value: defaultVal.substring(0, 120) }));
      }
    }

    // 6b. Detect this.data usage — in template-based steps, templateLogic() is
    // called with this = Thread (not Step), so this.data is always undefined.
    // The compiler destructures stepInputData values as templateLogic() function
    // parameters, making them available as local variables instead.
    const dataAccessPattern = /this\.data\.(\w+)/g;
    const usedDataVars = new Set();
    let dm;
    while ((dm = dataAccessPattern.exec(code)) !== null) usedDataVars.add(dm[1]);
    const bracketPattern = /this\.data\[\s*['"`](\w+)['"`]\s*\]/g;
    while ((dm = bracketPattern.exec(code)) !== null) usedDataVars.add(dm[1]);
    const aliasPattern = /(?:const|let|var)\s+(\w+)\s*=\s*this\.data\s*[;\n,)]/g;
    const thisDataAliases = [];
    while ((dm = aliasPattern.exec(code)) !== null) {
      const alias = dm[1];
      thisDataAliases.push(alias);
      const aliasDot = new RegExp(`${alias}\\.(\\w+)`, 'g');
      let am;
      while ((am = aliasDot.exec(code)) !== null) usedDataVars.add(am[1]);
      const aliasBracket = new RegExp(`${alias}\\[\\s*['"\`](\\w+)['"\`]\\s*\\]`, 'g');
      while ((am = aliasBracket.exec(code)) !== null) usedDataVars.add(am[1]);
    }

    const nonBuiltinDataRefs = [...usedDataVars].filter(v => !DATA_BUILTIN_KEYS.has(v));
    const usesThisDataForInputs = nonBuiltinDataRefs.length > 0 || thisDataAliases.length > 0;

    if (usesThisDataForInputs && !isClassBased(code)) {
      out.push(diag('THIS_DATA_RUNTIME_UNDEFINED', 'warning',
        `Template code reads inputs via ${thisDataAliases.length ? `this.data (aliased as "${thisDataAliases.join('", "')}") ` : 'this.data '}` +
        `— in the compiled step, templateLogic() runs with \`this\` bound to the Thread, not the Step, so this.data is undefined. ` +
        `The compiler destructures stepInputData values as function parameters to templateLogic({${formVars.slice(0, 4).join(', ')}${formVars.length > 4 ? ', ...' : ''}}, thisStep), ` +
        `so inputs are available as local variables. ` +
        `Use the compiler-injected local variables directly, or create a getter-based stepData object: ` +
        `const stepData = { get ${formVars[0] || 'myVar'}() { return ${formVars[0] || 'myVar'}; }, ... };`,
        'Replace this.data access with direct use of compiler-injected local variables. ' +
        'The second parameter "thisStep" provides access to the Step object if needed (e.g., thisStep.data for step config).',
        { aliases: thisDataAliases, referencedVars: nonBuiltinDataRefs }));
    }

    // 6b-ii. Detect TDZ conflicts: if the template declares const/let/var at the
    // outer scope for a variable that is also a formBuilder input, the compiler
    // will skip it from the destructured parameters, and the template's own
    // declaration (reading from this.data) will hit a TDZ or get undefined.
    const formVarSet = new Set(formVars);
    if (formVarSet.size > 0) {
      const outerDeclPattern = /(?:^|\n)\s*(?:const|let|var)\s+(\w+)\s*=/g;
      let braceDepth = 0;
      const lines = code.split('\n');
      const outerDeclaredVars = new Set();
      for (const line of lines) {
        const trimmed = line.trim();
        if (/^(?:async\s+)?function\s/.test(trimmed) || /=>\s*\{/.test(trimmed)) {
          braceDepth++;
          continue;
        }
        const opens = (trimmed.match(/\{/g) || []).length;
        const closes = (trimmed.match(/\}/g) || []).length;
        if (braceDepth === 0) {
          const declMatch = trimmed.match(/^(?:const|let|var)\s+(\w+)\s*=/);
          if (declMatch) outerDeclaredVars.add(declMatch[1]);
        }
        braceDepth = Math.max(0, braceDepth + opens - closes);
      }

      if (!isClassBased(code)) {
        for (const v of formVarSet) {
          if (outerDeclaredVars.has(v)) {
            out.push(diag('STEPINPUT_VAR_REDECLARED', 'error',
              `Template code declares "${v}" at the outer scope (const/let/var ${v} = ...) but "${v}" is also a formBuilder input variable. ` +
              `The compiler will skip "${v}" from the templateLogic() destructured parameters to avoid a duplicate declaration. ` +
              `Since the template's own declaration typically reads from this.data (which is undefined), this causes a TypeError or TDZ error at runtime.`,
              `Remove the outer-scope declaration of "${v}" and use the compiler-injected local variable directly. ` +
              `If you need a stepData-style object, use getters that defer access: const stepData = { get ${v}() { return ${v}; } };`,
              { variable: v }));
          }
        }
      }
    }

    // 6b-iii. Detect TDZ through getter-based stepData objects.
    // Pattern: const stepData = { get X() { return X; } }; ... const X = stepData.X;
    // The getter returns X, but X is the const being initialized → TDZ crash.
    if (/const\s+stepData\s*=\s*\{/.test(code)) {
      const getterNames = [];
      const getterRe = /get\s+(\w+)\(\)\s*\{\s*return\s+(\w+)\s*;?\s*\}/g;
      let gm;
      while ((gm = getterRe.exec(code)) !== null) {
        if (gm[1] === gm[2]) getterNames.push(gm[1]);
      }
      if (getterNames.length > 0) {
        const codeLines = code.split('\n');
        let stepDataEnd = -1;
        let sdDepth = 0;
        let inStepData = false;
        for (let li = 0; li < codeLines.length; li++) {
          if (/const\s+stepData\s*=\s*\{/.test(codeLines[li])) inStepData = true;
          if (inStepData) {
            sdDepth += (codeLines[li].match(/\{/g) || []).length;
            sdDepth -= (codeLines[li].match(/\}/g) || []).length;
            if (sdDepth <= 0) { stepDataEnd = li; break; }
          }
        }

        let outerDepth = 0;
        for (let li = stepDataEnd + 1; li < codeLines.length; li++) {
          const ln = codeLines[li].trim();
          if (/^(?:async\s+)?function\s/.test(ln)) outerDepth++;
          const o = (ln.match(/\{/g) || []).length;
          const c = (ln.match(/\}/g) || []).length;
          if (outerDepth > 0) { outerDepth = Math.max(0, outerDepth + o - c); continue; }
          outerDepth = Math.max(0, outerDepth + o - c);

          const dm = ln.match(/^(?:const|let|var)\s+(\w+)\s*=\s*stepData\.(\w+)/);
          if (dm && getterNames.includes(dm[2])) {
            out.push(diag('GETTER_STEPDATA_TDZ', 'error',
              `Template code has "const ${dm[1]} = stepData.${dm[2]}" at the top level, but stepData has a getter ` +
              `"get ${dm[2]}() { return ${dm[2]}; }" — this creates a circular Temporal Dead Zone: the getter tries ` +
              `to return "${dm[2]}" which is the very const being initialized. This crashes at runtime with a ReferenceError.`,
              `Remove the "const ${dm[1]} = stepData.${dm[2]}" declaration and use the compiler-injected "${dm[2]}" variable directly, ` +
              `or use "stepData.${dm[2]}" inline where needed.`,
              { variable: dm[1], getterName: dm[2], line: li + 1 }));
          }
        }
      }
    }

    // 6b-iv. Unused formBuilder inputs (defined in UI but not used in code)
    for (const v of formVarSet) {
      if (!usedDataVars.has(v)) {
        const usesAsLocalVar = new RegExp(`\\b${v}\\b`).test(code) && !new RegExp(`this\\.data\\.${v}|this\\.data\\[`).test(code);
        if (!usesAsLocalVar) {
          out.push(diag('INPUT_UNUSED', 'info',
            `formBuilder input "${v}" is defined in the UI but the template code does not reference it — ` +
            `the compiler injects stepInputData values as local variables in templateLogic(), so the input is available as "${v}" directly (no this.data needed)`,
            `Reference "${v}" as a local variable in the template code, or remove the input from formBuilder if unused`,
            { variable: v }));
        }
      }
    }

    // 6c. Code-referenced this.data variables with no UI input
    const classBased = isClassBased(code);
    for (const v of usedDataVars) {
      if (DATA_BUILTIN_KEYS.has(v)) continue;
      if (formVarSet.has(v)) continue;
      if (step.data && v in step.data) continue;
      if (classBased) {
        out.push(diag('INPUT_NOT_IN_FORM', 'warning',
          `Code references this.data.${v} but no formBuilder input with variable "${v}" exists — ` +
          `in class-based steps, this.data is populated by initData() from stepInputData, so the value will be undefined unless ` +
          `a formBuilder input wires a value into stepInputData["${v}"] or step.data has a default. ` +
          `Without a formBuilder input, flow builders cannot configure this value from the UI, breaking reusability.`,
          `Add an input with variable: "${v}" to formBuilder (type: "text" with allowMergeFields for flow wiring), or set a default in step.data`,
          { variable: v }));
      } else {
        out.push(diag('INPUT_NOT_IN_FORM', 'warning',
          `Code references this.data.${v} but no formBuilder input with variable "${v}" exists — ` +
          `this.data is undefined in templateLogic() (this = Thread, not Step). ` +
          `Add a formBuilder input with variable: "${v}" so the compiler injects it as a local variable, ` +
          `or read it from a merge field: await this.mergeFields['fieldName'].get({path: '${v}'})`,
          `Add an input with variable: "${v}" to formBuilder, or set a default in step.data`,
          { variable: v }));
      }
    }

    // 6c-ii. Code reads credential-looking variable from this.data without KV storage resolution
    const hasAuthComp = Array.isArray(stepInputs) && stepInputs.some(inp => {
      const comp = Array.isArray(inp?.component) ? inp.component[0] : inp?.component;
      return comp === 'auth-external-component';
    });
    if (classBased && code) {
      const credVarPattern = /(?:api[_-]?key|apikey|secret|token|password|auth(?:orization)?[_-]?(?:key|token|secret)?|(?:anthropic|openai|stripe|airtable|twilio)[_-]?(?:key|api[_-]?key|secret|token)?|access[_-]?token|private[_-]?key|client[_-]?secret)$/i;
      const usesKvStorage = /require\s*\(\s*['"]or-sdk\/storage['"]\s*\)/.test(code) || /storage\.get\s*\(/.test(code);
      for (const v of usedDataVars) {
        if (DATA_BUILTIN_KEYS.has(v)) continue;
        if (!credVarPattern.test(v)) continue;
        if (usesKvStorage && hasAuthComp) continue;
        if (!usesKvStorage) {
          out.push(diag('AUTH_NO_KV_RESOLUTION', 'error',
            `Code reads credential "${v}" from this.data but does not use or-sdk/storage to resolve it from KV storage — ` +
            `when the authorizer UI stores credentials, this.data.${v} contains a token vault reference ID, not the actual secret. ` +
            `The code must use storage.get(collection, authId) to retrieve the real credential.`,
            `Add the standard KV credential resolution pattern: require("or-sdk/storage"), create a Storage instance, ` +
            `handle the "inherited" sharing pattern, and call storage.get(collection, authId) to retrieve the actual key.`,
            { variable: v }));
        }
      }
    }
  }

  // 6d. OutputExample validation
  if (step.outputExample === null || step.outputExample === undefined) {
    out.push(diag('OUTPUT_EXAMPLE_MISSING', 'warning',
      'Step template has no outputExample — the merge field menu in the flow builder will be empty',
      'Add outputExample with representative output data so builders can reference fields via merge fields'));
  } else if (typeof step.outputExample === 'object' && Object.keys(step.outputExample).length === 0) {
    out.push(diag('OUTPUT_EXAMPLE_EMPTY', 'warning',
      'outputExample is an empty object — the merge field menu will show no fields',
      'Populate outputExample with all possible output fields and sample values'));
  }

  // 6d2. OutputExample quality — nested objects should have sample values
  if (step.outputExample && typeof step.outputExample === 'object' && Object.keys(step.outputExample).length > 0) {
    const emptyNestedKeys = [];
    let totalLeafCount = 0;
    let emptyStringCount = 0;
    let depthMax = 0;
    function checkOutputValues(obj, path, depth) {
      if (depth > depthMax) depthMax = depth;
      for (const [k, v] of Object.entries(obj)) {
        const fullPath = path ? `${path}.${k}` : k;
        if (v === null || v === undefined) {
          emptyNestedKeys.push(fullPath);
          totalLeafCount++;
        } else if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) {
          emptyNestedKeys.push(fullPath);
          totalLeafCount++;
        } else if (typeof v === 'object' && !Array.isArray(v)) {
          checkOutputValues(v, fullPath, depth + 1);
        } else {
          totalLeafCount++;
          if (v === '') emptyStringCount++;
        }
      }
    }
    checkOutputValues(step.outputExample, '', 0);
    if (emptyNestedKeys.length > 0) {
      out.push(diag('OUTPUT_EXAMPLE_INCOMPLETE', 'info',
        `outputExample has ${emptyNestedKeys.length} empty/null field(s): ${emptyNestedKeys.slice(0, 5).join(', ')}${emptyNestedKeys.length > 5 ? '...' : ''} — downstream merge field autocomplete won't show these fields' children`,
        'Populate empty fields with representative sample values',
        { emptyFields: emptyNestedKeys }));
    }

    if (totalLeafCount > 0 && emptyStringCount / totalLeafCount > 0.6 && emptyStringCount >= 3) {
      out.push(diag('OUTPUT_EXAMPLE_PLACEHOLDER_VALUES', 'warning',
        `outputExample has ${emptyStringCount}/${totalLeafCount} leaf values that are empty strings — the merge field picker will show field names but builders won't know what data to expect`,
        'Replace empty strings with realistic sample values (e.g., "John Doe" for a name, 42 for a count, "2026-01-15T10:30:00Z" for a timestamp)',
        { emptyStringCount, totalLeafCount }));
    }

    if (totalLeafCount > 30) {
      out.push(diag('OUTPUT_EXAMPLE_TOO_LARGE', 'info',
        `outputExample has ${totalLeafCount} leaf values — a large output example makes the merge field picker cluttered and hard to navigate for downstream steps`,
        'Consider returning only the fields that downstream steps actually need. Internal/debug fields can be omitted from outputExample.',
        { totalLeafCount }));
    }

    if (depthMax > 4) {
      out.push(diag('OUTPUT_EXAMPLE_DEEPLY_NESTED', 'info',
        `outputExample has nesting ${depthMax} levels deep — deeply nested merge field paths (e.g., result.data.items[0].meta.id) are hard to find and type in the UI`,
        'Consider flattening the output structure or extracting commonly-used nested values to the top level',
        { depthMax }));
    }
  }

  // 6d2b. Code produces output via exitStep but no dataOut configured
  if (code) {
    const hasExitWithData = /this\.exitStep\s*\(\s*['"`]\w+['"`]\s*,\s*[^)]/.test(code);
    const hasDataOutConfig = step.data?.dataOut && step.data.dataOut.name;
    const hasFormDataOut = step.formBuilder?.hasDataOut === true;
    if (hasExitWithData && !hasDataOutConfig && !hasFormDataOut) {
      out.push(diag('OUTPUT_NO_DATAOUT', 'warning',
        'Step code passes data to exitStep() but no dataOut is configured — the output data will not be available as a merge field for downstream steps',
        'Add dataOut configuration with a descriptive merge field name and set formBuilder.hasDataOut to true with a formDataOut component'));
    }
  }

  // 6d3. OutputExample vs exitStep data cross-check
  if (step.outputExample && typeof step.outputExample === 'object' && Object.keys(step.outputExample).length > 0 && code) {
    const codeOutputKeys = new Set();

    // Extract only top-level keys from an object literal body, respecting brace depth.
    // e.g. "{ result: { status: 'ok' }, count: 5 }" -> ['result', 'count']
    function extractTopLevelKeys(body) {
      const keys = [];
      let depth = 0;
      const keyPattern = /(\w+)\s*:/g;
      let km;
      for (let i = 0; i < body.length; i++) {
        if (body[i] === '{' || body[i] === '[' || body[i] === '(') { depth++; continue; }
        if (body[i] === '}' || body[i] === ']' || body[i] === ')') { depth--; continue; }
      }
      // Reset and scan for keys only at depth 0
      depth = 0;
      let pos = 0;
      while (pos < body.length) {
        const ch = body[pos];
        if (ch === '{' || ch === '[' || ch === '(') { depth++; pos++; continue; }
        if (ch === '}' || ch === ']' || ch === ')') { depth--; pos++; continue; }
        if (depth === 0) {
          const slice = body.slice(pos);
          const m = slice.match(/^(\w+)\s*:/);
          if (m) { keys.push(m[1]); pos += m[0].length; continue; }
        }
        pos++;
      }
      return keys;
    }

    // Match inline object literals: this.exitStep('next', { key: val })
    // Use a balanced-brace scan instead of [^}]+ to handle nested objects
    const exitCallPattern = /this\.exitStep\s*\(\s*['"`]\w+['"`]\s*,\s*\{/g;
    let ecm;
    while ((ecm = exitCallPattern.exec(code)) !== null) {
      const startIdx = ecm.index + ecm[0].length;
      let depth = 1;
      let endIdx = startIdx;
      while (endIdx < code.length && depth > 0) {
        if (code[endIdx] === '{') depth++;
        else if (code[endIdx] === '}') depth--;
        endIdx++;
      }
      const body = code.slice(startIdx, endIdx - 1);
      for (const key of extractTopLevelKeys(body)) codeOutputKeys.add(key);
    }

    // Match variable references: this.exitStep('next', varName)
    // Then trace varName back to its declaration: const varName = { ... }
    const varRefPattern = /this\.exitStep\s*\(\s*['"`]\w+['"`]\s*,\s*([a-zA-Z_$]\w*)\s*\)/g;
    for (const match of code.matchAll(varRefPattern)) {
      const varName = match[1];
      if (varName === 'this' || varName === 'undefined' || varName === 'null') continue;
      // Find the variable declaration and scan with balanced braces
      const declStart = new RegExp(`(?:const|let|var)\\s+${varName}\\s*=\\s*\\{`, 'g');
      let dm;
      while ((dm = declStart.exec(code)) !== null) {
        const sIdx = dm.index + dm[0].length;
        let depth = 1;
        let eIdx = sIdx;
        while (eIdx < code.length && depth > 0) {
          if (code[eIdx] === '{') depth++;
          else if (code[eIdx] === '}') depth--;
          eIdx++;
        }
        const body = code.slice(sIdx, eIdx - 1);
        for (const key of extractTopLevelKeys(body)) codeOutputKeys.add(key);
      }
    }

    if (codeOutputKeys.size > 0) {
      const exampleKeys = new Set(Object.keys(step.outputExample));
      const missingInExample = [...codeOutputKeys].filter(k => !exampleKeys.has(k));
      const extraInExample = [...exampleKeys].filter(k => !codeOutputKeys.has(k));
      if (missingInExample.length > 0) {
        out.push(diag('OUTPUT_EXAMPLE_MISSING_KEYS', 'warning',
          `Code passes [${missingInExample.join(', ')}] to exitStep() but outputExample does not include ${missingInExample.length === 1 ? 'this key' : 'these keys'} — downstream merge field picker will not show ${missingInExample.length === 1 ? 'it' : 'them'}`,
          `Add ${missingInExample.map(k => `"${k}"`).join(', ')} to outputExample with representative sample values`,
          { missingKeys: missingInExample, codeKeys: [...codeOutputKeys], exampleKeys: [...exampleKeys] }));
      }
      if (extraInExample.length > 0 && extraInExample.length <= 5) {
        out.push(diag('OUTPUT_EXAMPLE_EXTRA_KEYS', 'info',
          `outputExample includes [${extraInExample.join(', ')}] but these keys are not passed to exitStep() in the code — the merge field picker will show fields that are never populated`,
          'Remove unused keys from outputExample, or verify they are set via a path not detectable by static analysis',
          { extraKeys: extraInExample, codeKeys: [...codeOutputKeys], exampleKeys: [...exampleKeys] }));
      }
    }
  }

  // 6d4. DataOut configured but no outputExample
  if (step.data?.dataOut && step.data.dataOut.name && (!step.outputExample || (typeof step.outputExample === 'object' && Object.keys(step.outputExample).length === 0))) {
    out.push(diag('DATAOUT_NO_OUTPUT_EXAMPLE', 'warning',
      `Step writes to merge field "${step.data.dataOut.name}" (via dataOut) but has no outputExample — the flow builder merge field picker will show "${step.data.dataOut.name}" but no selectable child fields`,
      'Add outputExample with the shape of data passed to this.exitStep() so downstream steps can reference individual fields'));
  }

  // 6d5. OutputExample keys not referenced in step code — may be stale from another template
  if (step.outputExample && typeof step.outputExample === 'object' && Object.keys(step.outputExample).length > 0 && code) {
    const oeKeys = Object.keys(step.outputExample);
    const codeStr = code.toLowerCase();
    const unreferencedKeys = oeKeys.filter(k => {
      const lower = k.toLowerCase();
      return !codeStr.includes(lower) && !codeStr.includes(`'${lower}'`) && !codeStr.includes(`"${lower}"`);
    });
    if (unreferencedKeys.length > 0 && unreferencedKeys.length === oeKeys.length) {
      out.push(diag('OUTPUT_EXAMPLE_UNREFERENCED', 'warning',
        `None of the outputExample keys [${oeKeys.join(', ')}] appear anywhere in the step code — the outputExample may be stale or copied from a different template`,
        'Replace outputExample with data that matches what this step actually passes to this.exitStep()',
        { unreferencedKeys, totalKeys: oeKeys.length }));
    }
  }

  // 6e. DataOut consistency
  const hasDataOutConfig = step.data?.dataOut && typeof step.data.dataOut === 'object';
  const formHasDataOut = step.formBuilder?.hasDataOut === true;

  if (hasDataOutConfig && !step.data.dataOut.name) {
    out.push(diag('DATAOUT_NO_NAME', 'warning',
      'data.dataOut is configured but has no name — the merge field will not be accessible',
      'Set data.dataOut.name to a meaningful merge field name (e.g., "apiResult")'));
  }

  const VALID_DATAOUT_TYPES = ['session', 'thread', 'shared', 'global'];
  if (hasDataOutConfig && step.data.dataOut.type) {
    if (!VALID_DATAOUT_TYPES.includes(step.data.dataOut.type)) {
      out.push(diag('DATAOUT_INVALID_TYPE', 'error',
        `data.dataOut.type "${step.data.dataOut.type}" is not valid`,
        `Set data.dataOut.type to one of: ${VALID_DATAOUT_TYPES.join(', ')}`,
        { type: step.data.dataOut.type, validTypes: VALID_DATAOUT_TYPES }));
    }
  }

  if (hasDataOutConfig && step.data.dataOut.ttl !== undefined && step.data.dataOut.ttl !== null) {
    if (typeof step.data.dataOut.ttl !== 'number' || step.data.dataOut.ttl <= 0) {
      out.push(diag('DATAOUT_INVALID_TTL', 'warning',
        `data.dataOut.ttl must be a positive number (milliseconds), got ${JSON.stringify(step.data.dataOut.ttl)}`,
        'Set data.dataOut.ttl to a positive number (e.g., 86400000 for 24 hours)',
        { ttl: step.data.dataOut.ttl }));
    }
  }

  if (formHasDataOut && !hasDataOutConfig) {
    out.push(diag('DATAOUT_MISMATCH', 'warning',
      'formBuilder.hasDataOut is true but data.dataOut is not configured',
      'Add data.dataOut with name, type, and ttl, or set formBuilder.hasDataOut to false'));
  }
  if (hasDataOutConfig && !formHasDataOut && step.formBuilder) {
    out.push(diag('DATAOUT_MISMATCH', 'warning',
      'data.dataOut is configured but formBuilder.hasDataOut is false — the DataOut UI component will not render',
      'Set formBuilder.hasDataOut to true, or remove data.dataOut if unused'));
  }

  if (formHasDataOut && step.formBuilder?.stepInputs) {
    const hasFormDataOutComponent = step.formBuilder.stepInputs.some(inp => inp?.component === 'formDataOut');
    if (!hasFormDataOutComponent) {
      out.push(diag('DATAOUT_FLAG_NO_COMPONENT', 'warning',
        'formBuilder.hasDataOut is true but no formDataOut component exists in stepInputs — the Design tab will not show a merge field name input',
        'Add a formDataOut component to formBuilder.stepInputs with a defaultName'));
    }
  }
  if (!hasDataOutConfig && !formHasDataOut) {
    out.push(diag('DATAOUT_MISSING', 'info',
      'No dataOut configured — step output will not be stored to a merge field for downstream steps',
      'Add dataOut configuration if the step produces output that other steps need to reference'));
  }

  // 6e-ii. formBuilder.hasProcessError ↔ data.processError sync
  if (step.formBuilder) {
    const fbHasProcErr = step.formBuilder.hasProcessError === true;
    const dataProcErr = step.data?.processError === true;
    if (fbHasProcErr && !dataProcErr) {
      out.push(diag('FORM_PROCESS_ERROR_MISMATCH', 'warning',
        'formBuilder.hasProcessError is true but data.processError is not — the error exit UI will render but the runtime will not create an __error__ exit',
        'Set data.processError to true, or set formBuilder.hasProcessError to false'));
    }
    if (dataProcErr && !fbHasProcErr) {
      out.push(diag('FORM_PROCESS_ERROR_MISMATCH', 'warning',
        'data.processError is true but formBuilder.hasProcessError is false — the error exit will exist at runtime but the UI won\'t show error handling options',
        'Set formBuilder.hasProcessError to true to match data.processError'));
    }

    const fbHasProcTimeout = step.formBuilder.hasProcessTimeout === true;
    const dataProcTimeout = step.data?.processTimeout === true;
    if (fbHasProcTimeout && !dataProcTimeout) {
      out.push(diag('FORM_PROCESS_TIMEOUT_MISMATCH', 'warning',
        'formBuilder.hasProcessTimeout is true but data.processTimeout is not — the timeout UI will render but the runtime will not create a __timeout__ exit',
        'Set data.processTimeout to true, or set formBuilder.hasProcessTimeout to false'));
    }
    if (dataProcTimeout && !fbHasProcTimeout) {
      out.push(diag('FORM_PROCESS_TIMEOUT_MISMATCH', 'warning',
        'data.processTimeout is true but formBuilder.hasProcessTimeout is false — the timeout exit will exist at runtime but the UI won\'t show timeout configuration',
        'Set formBuilder.hasProcessTimeout to true to match data.processTimeout'));
    }

    // 6e-iii. timeoutDuration when processTimeout is enabled
    if (dataProcTimeout && !step.data?.timeoutDuration) {
      out.push(diag('TIMEOUT_DURATION_MISSING', 'warning',
        'data.processTimeout is true but data.timeoutDuration is not set — the step will use the default flow timeout',
        'Set data.timeoutDuration to a backtick-wrapped duration string (e.g., "`30 sec`")'));
    }

    // 6e-iii-a2. formBuilder.defaultTimeout when hasProcessTimeout is true
    if (fbHasProcTimeout && !step.formBuilder.defaultTimeout) {
      out.push(diag('TIMEOUT_DEFAULT_MISSING', 'warning',
        'formBuilder.hasProcessTimeout is true but formBuilder.defaultTimeout is not set — the "Default timeout" text box in the Design tab will be empty',
        'Set formBuilder.defaultTimeout to a backtick-wrapped duration string (e.g., "`120 sec`") so the Design tab shows a pre-filled timeout value'));
    }

    // 6e-iii-a3. hasProcessTimeout but code does nothing that would need a timeout
    if (fbHasProcTimeout && code) {
      const hasFetch = /\bfetch\s*\(/.test(code);
      const hasEmit = /this\.emit(?:Sync|Async|Http|Queue|Multiple)/.test(code);
      const hasExternalCall = /(?:api|http|request|axios|got)\s*[.(]/i.test(code);
      const hasLlm = /(?:anthropic|openai|claude|gpt|completions)/i.test(code);
      if (!hasFetch && !hasEmit && !hasExternalCall && !hasLlm) {
        out.push(diag('TIMEOUT_POSSIBLY_UNNECESSARY', 'info',
          'processTimeout is enabled but the code does not appear to make external API calls, LLM requests, or step-to-step emits — timeout may be unnecessary for purely computational steps',
          'Consider disabling processTimeout if this step only does data transforms or local computation',
          { hasProcessTimeout: true }));
      }
    }

    // 6e-iii-b. timeoutDuration format validation
    if (step.data?.timeoutDuration) {
      const td = step.data.timeoutDuration;
      if (typeof td === 'string') {
        const stripped = td.replace(/^["'`]+|["'`]+$/g, '').trim();
        const validDurationPattern = /^\d+\s*(?:sec|s|seconds?|min|m|minutes?|ms|milliseconds?)$/i;
        if (!validDurationPattern.test(stripped) && !/^\d+$/.test(stripped)) {
          out.push(diag('TIMEOUT_DURATION_FORMAT', 'warning',
            `data.timeoutDuration "${td}" does not look like a valid duration — expected a backtick-wrapped expression like \`30 sec\`, \`2 min\`, or a number of seconds`,
            'Set data.timeoutDuration to a backtick-wrapped duration string (e.g., "`120 sec`", "`2 min`")',
            { timeoutDuration: td }));
        }
        if (typeof td === 'string' && !td.startsWith('`') && !td.startsWith('"')) {
          out.push(diag('TIMEOUT_DURATION_NOT_EXPRESSION', 'info',
            `data.timeoutDuration "${td}" is not wrapped in backticks or quotes — Edison expects expression strings for dynamic evaluation`,
            'Wrap in backticks: e.g., "`120 sec`"',
            { timeoutDuration: td }));
        }
        const secMatch = stripped.match(/^(\d+)\s*(?:sec|s|seconds?)$/i);
        const minMatch = stripped.match(/^(\d+)\s*(?:min|m|minutes?)$/i);
        let durationSec = null;
        if (secMatch) durationSec = parseInt(secMatch[1], 10);
        else if (minMatch) durationSec = parseInt(minMatch[1], 10) * 60;
        else if (/^\d+$/.test(stripped)) durationSec = parseInt(stripped, 10);
        if (durationSec !== null && durationSec > 900) {
          out.push(diag('TIMEOUT_DURATION_EXCEEDS_MAX', 'error',
            `data.timeoutDuration ~${durationSec}s exceeds the Lambda maximum of 900 seconds — the Lambda will be killed before the step timeout fires`,
            'Reduce timeoutDuration to 900 seconds or less',
            { durationSec, max: 900 }));
        }
        if (durationSec !== null && durationSec < 1) {
          out.push(diag('TIMEOUT_DURATION_TOO_SHORT', 'warning',
            `data.timeoutDuration ~${durationSec}s is extremely short — the step will almost certainly time out immediately`,
            'Set a reasonable timeout (e.g., "`30 sec`")',
            { durationSec }));
        }
      }
    }

    // 6e-iii-c. Code makes external calls but processTimeout not enabled
    if (!dataProcTimeout && !fbHasProcTimeout && code) {
      const hasFetch = /\bfetch\s*\(/.test(code);
      const hasLlm = /(?:anthropic|openai|claude|gpt|api\.anthropic|completions)/i.test(code);
      const hasEmitSync = /this\.emitSync\s*\(/.test(code);
      if (hasFetch || hasLlm || hasEmitSync) {
        const reason = hasLlm ? 'LLM/AI API calls' : hasFetch ? 'external fetch() calls' : 'synchronous step-to-step emits';
        out.push(diag('TIMEOUT_RECOMMENDED', 'warning',
          `Step code contains ${reason} but processTimeout is not enabled — if the external service hangs, this step will block until the flow-level timeout kills the Lambda, with no graceful handling`,
          'Enable processTimeout with an appropriate duration and add a __timeout__ exit for graceful timeout handling'));
      }
    }

    // 6e-iv. formBuilder.stepExits ↔ data.exits correspondence
    const fbExits = step.formBuilder.stepExits;
    const dataExits = step.data?.exits;
    if (Array.isArray(fbExits) && Array.isArray(dataExits)) {
      const fbExitIds = new Set(fbExits.map(e => e.data?.id).filter(Boolean));
      const dataExitIds = new Set(dataExits.map(e => e.id).filter(Boolean));
      const builtinExitIds = new Set(['__error__', '__timeout__']);
      for (const id of dataExitIds) {
        if (!builtinExitIds.has(id) && !fbExitIds.has(id)) {
          out.push(diag('FORM_EXITS_MISMATCH', 'warning',
            `data.exits defines exit "${id}" but formBuilder.stepExits does not — the exit will exist at runtime but won't appear in the step configuration UI`,
            `Add a corresponding entry to formBuilder.stepExits with data.id: "${id}"`,
            { exitId: id }));
        }
      }
      for (const id of fbExitIds) {
        if (!dataExitIds.has(id)) {
          out.push(diag('FORM_EXITS_MISMATCH', 'warning',
            `formBuilder.stepExits defines exit "${id}" but data.exits does not — the UI will show an exit that doesn't exist at runtime`,
            `Add { id: "${id}", label: "${id}", condition: "" } to data.exits, or remove the formBuilder entry`,
            { exitId: id }));
        }
      }
    }
  }

  // 6e2. exitStep data argument check when dataOut is configured
  if (hasDataOutConfig && step.data.dataOut.name && code) {
    const exitCallsNoData = (code.match(/this\.exitStep\s*\(\s*['"`]\w+['"`]\s*\)/g) || []);
    const exitCallsTotal = (code.match(/this\.exitStep\s*\(/g) || []);
    if (exitCallsTotal.length > 0 && exitCallsNoData.length === exitCallsTotal.length) {
      out.push(diag('EXITSTEP_NO_DATA_WITH_DATAOUT', 'warning',
        `Step has dataOut configured (merge field "${step.data.dataOut.name}") but this.exitStep() is never called with a data argument — the merge field will always be empty`,
        'Pass output data as the second argument: this.exitStep("next", result)',
        { mergeFieldName: step.data.dataOut.name }));
    }
  }

  // 6f. Exit label validation
  const exits = step.data?.exits;
  if (Array.isArray(exits)) {
    const labelMap = new Map();
    for (const exit of exits) {
      if (!exit.label || exit.label.trim() === '') {
        out.push(diag('EXIT_LABEL_MISSING', 'warning',
          `Exit "${exit.id}" has no label — it will display without a name in the flow builder`,
          `Add a descriptive label to the exit (e.g., label: "${exit.id}")`,
          { exitId: exit.id }));
      } else {
        const normalized = exit.label.trim().toLowerCase();
        if (labelMap.has(normalized)) {
          out.push(diag('EXIT_LABEL_DUPLICATE', 'info',
            `Exits "${exit.id}" and "${labelMap.get(normalized)}" share the same label "${exit.label}" — this may confuse flow builders`,
            'Use distinct labels for each exit so they are easy to tell apart in the UI',
            { exitId: exit.id, duplicateOf: labelMap.get(normalized), label: exit.label }));
        } else {
          labelMap.set(normalized, exit.id);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Code-only structure checks — guidance for raw code inputs
// ---------------------------------------------------------------------------
function checkMissingStructure(input, code, out) {
  const hasStepClass = /class\s+\w+\s+extends\s+Step\b/.test(code);
  const hasExitStep = /this\.exitStep\s*\(/.test(code);
  const hasExport = /export\s*\{[^}]*step[^}]*\}/.test(code);
  const label = inferLabelFromCode(code) || 'My Step';
  const className = label.replace(/\s/g, '');

  // Phase 1: basic step structure still missing
  if (!hasStepClass) return;
  if (!hasExport) {
    out.push(diag('RAW_CODE_NO_EXPORT', 'warning',
      'Step class found but missing the export — Edison requires "export { ClassName as step };".',
      `Add "export { ${className} as step };" at the end of the file.`,
      { fixCode: { appendToTemplate: `\nexport { ${className} as step };` } }, 1));
  }

  // Phase 3: exits
  if (!hasExitStep) {
    out.push(diag('RAW_CODE_NO_EXITSTEP', 'warning',
      'Step class found but no this.exitStep() calls — every Edison step must exit via return this.exitStep(exitId, data).',
      'Add "return this.exitStep(\'next\', result);" at the end of your runStep method.',
      null, 1));
  }

  if (!input.data?.exits || !Array.isArray(input.data?.exits) || input.data.exits.length === 0) {
    const exitCalls = code.match(/this\.exitStep\s*\(\s*['"`](\w+)['"`]/g) || [];
    const usedExits = [...new Set(exitCalls.map(c => c.match(/['"`](\w+)['"`]/)[1]))];
    const exits = usedExits.length > 0
      ? usedExits.map(id => ({ id, label: id }))
      : [{ id: 'next', label: 'next' }];
    exits.push({ id: '__error__', label: 'error', condition: 'processError' });
    out.push(diag('STEP_NO_EXITS', 'warning',
      'No exit definitions found — wrap your code input as a step template with data.exits so the flow builder knows which paths the step can take.',
      `Add a data.exits array to your step template. Based on your code, suggested exits: ${JSON.stringify(exits)}`,
      { fixCode: { data: { exits, processError: true } }, suggestedExits: exits }, 3));
  }

  // Phase 4: formBuilder
  const thisDataReads = code.match(/this\.data\.(\w+)/g) || [];
  const dataFields = [...new Set(thisDataReads.map(m => m.replace('this.data.', '')))];
  const builtinDataFields = new Set(['exits', 'processError', 'processTimeout', 'dataOut', 'timeout', 'stepInputData', 'formBuilder']);
  const inputFields = dataFields.filter(f => !builtinDataFields.has(f));

  if (inputFields.length > 0 && !input.formBuilder) {
    const stepInputs = inputFields.map(f => ({
      name: f,
      label: f.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').trim().replace(/^\w/, c => c.toUpperCase()),
      component: 'formTextInput',
      allowMergeFields: true,
      value: '',
    }));
    out.push(diag('TEMPLATE_MISSING_FORMBUILDER', 'warning',
      `Code reads ${inputFields.length} input field(s) (${inputFields.join(', ')}) from this.data but no formBuilder is defined — flow builders won't have a UI to configure these.`,
      'Add a formBuilder with stepInputs for each this.data field so users can configure the step in the flow builder UI.',
      { fixCode: { formBuilder: { stepInputs } }, suggestedInputs: stepInputs }, 4));
  }

  // Phase 5: metadata
  if (!input.name && !input.label) {
    out.push(diag('TEMPLATE_NO_NAME', 'warning',
      'No name/label — the step will appear unnamed in the flow builder.',
      `Set name and label to "${label}".`,
      { fixCode: { name: label, label } }, 5));
  }

  // (Label length is checked in checkStepStructure — the template-metadata
  // pass that actually fires on step.json inputs. This Phase 5 block only
  // handles metadata that depends on parsed code context.)

  if (!input.description) {
    out.push(diag('TEMPLATE_NO_DESCRIPTION', 'warning',
      'No description — the step picker tooltip will be empty.',
      'Add a 1-2 sentence description of what the step does.',
      null, 5));
  }

  if (!input.version) {
    out.push(diag('TEMPLATE_VERSION_ZERO', 'warning',
      'No version set.',
      'Set version to "0.1.0" (semver).',
      { fixCode: { version: '0.1.0' } }, 5));
  }

  // Phase 6: outputExample
  const exitDataPattern = /this\.exitStep\s*\(\s*['"`]\w+['"`]\s*,\s*(\{[^}]+\})/g;
  const exitDataMatches = [...code.matchAll(exitDataPattern)];
  if (!input.outputExample && exitDataMatches.length > 0) {
    out.push(diag('OUTPUT_EXAMPLE_MISSING', 'info',
      'No outputExample defined — downstream steps won\'t know the shape of data this step produces. Set outputExample to a representative example object matching the data passed to this.exitStep().',
      'Add an outputExample object showing what fields this step outputs. Look at what you pass to this.exitStep() and create a matching example.',
      { exitDataSamples: exitDataMatches.map(m => m[1]) }, 6));
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
const CODE_ONLY_SUPPRESS = new Set([
  'TEMPLATE_MISSING_FORMBUILDER', 'TEMPLATE_EMPTY_FORMBUILDER',
  'FORM_INPUT_NO_MERGE_FIELDS', 'INPUT_NOT_IN_FORM', 'INPUT_UNUSED',
  'TEMPLATE_DATA_HARDCODED_MERGE_REF',
]);

function validateStep(input, opts = {}) {
  // Allow raw string input — wrap it and mark for classification
  if (typeof input === 'string') {
    input = { code: input, _rawInput: true };
  }

  const codeOnly = opts.codeOnly || input._codeOnly || false;
  const diagnostics = [];
  const response = { beautified: null, inputType: null };

  const code = checkStepStructure(input, diagnostics, response);
  if (!code) {
    return formatResult(diagnostics, response);
  }

  const isCodeLike = response.inputType === 'javascript' || response.inputType === 'step-template' || response.inputType === null;
  if (isCodeLike) {
    lintCode(code, diagnostics);
    checkFormatting(code, diagnostics);
    checkEventManager(code, diagnostics);
    // Pass step.json kind through so checkThisApi can downgrade reusability
    // rules for api-kind steps (inherently gateway-bound by design).
    checkThisApi(code, diagnostics, { kind: input.kind || input.data?.kind });
  }

  if (input.template !== undefined) {
    checkFormAndData(input, code, diagnostics);
  } else if (isCodeLike) {
    checkMissingStructure(input, code, diagnostics);
  }

  if (isCodeLike) {
    response.beautified = beautifyCode(code);
  }

  if (codeOnly) {
    const filtered = diagnostics.filter(d => !CODE_ONLY_SUPPRESS.has(d.code));
    diagnostics.length = 0;
    diagnostics.push(...filtered);
  }

  return formatResult(diagnostics, response);
}

const PHASE_MAP = {
  // Phase 0 — classification / scaffold
  INPUT_IS_DESCRIPTION: 0, INPUT_IS_PSEUDOCODE: 0, RAW_CODE_NO_STEP_CLASS: 0,
  INVALID_STEP_INPUT: 0, NO_CODE: 0, INPUT_IS_FLOW: 0,

  // Phase 1 — basic step structure
  RAW_CODE_NO_EXITSTEP: 1, RAW_CODE_NO_EXPORT: 1, RAW_CODE_USES_PARAMS: 1,
  STEP_NO_EXITS: 1, TEMPLATE_NO_NAME: 1, TEMPLATE_VERSION_ZERO: 1,
  TEMPLATE_INVALID_VERSION: 1, TEMPLATE_VERSION_PRERELEASE: 1,
  EXIT_INVALID_CONDITION: 1, UNDECLARED_MODULE: 1, UNUSED_MODULE: 1,
  MODULE_INVALID_NAME: 1, MODULE_MISSING_VERSION: 1,
  TEMPLATE_INVALID_ID: 1, TEMPLATE_ID_NOT_LOWERCASE: 1,
  TEMPLATE_MISSING_VERSION: 1, TEMPLATE_MISSING_FORM: 1,

  // Phase 2 — code quality
  NO_DEBUGGER: 2, NO_EVAL: 2, NO_VAR: 2, EQEQ: 2, NO_CONSOLE: 2,
  NO_EMPTY_CATCH: 2, NO_NEW_FUNCTION: 2, THROW_ERROR_OBJECT: 2,
  ASYNC_NO_AWAIT: 2, DUPLICATE_FUNCTION: 2, UNREACHABLE_CODE: 2,
  EXITSTEP_NO_RETURN: 2, END_NO_RETURN: 2, MERGEFIELD_NO_GET: 2,
  MERGEFIELD_GET_NO_AWAIT: 2, MERGEFIELD_SET_NO_AWAIT: 2, GETDATAOUT_NO_AWAIT: 2,
  STEP_LOGIC_HARDCODED_MERGE_REF: 2, STEP_LOGIC_READS_API_INPUT: 2,
  SECRET_IN_CODE: 2,
  HARDCODED_URL: 2, HARDCODED_MODEL: 2,
  HARDCODED_COLLECTION: 2, HARDCODED_THRESHOLD: 2,
  NUMERIC_SEPARATOR: 2, EJS_DELIMITER_IN_CODE: 2, PRIVATE_CLASS_FIELD: 2,

  // Phase 3 — exits
  EXIT_NOT_DEFINED: 3, EXIT_NEVER_TAKEN: 3, PROCESS_ERROR_NO_EXIT: 3,
  PROCESS_TIMEOUT_NO_EXIT: 3, EXIT_LABEL_MISSING: 3, EXIT_LABEL_DUPLICATE: 3,
  TIMEOUT_DURATION_MISSING: 3, TIMEOUT_DEFAULT_MISSING: 3,
  TIMEOUT_POSSIBLY_UNNECESSARY: 3, TIMEOUT_RECOMMENDED: 3,
  FORM_EXITS_MISMATCH: 3, EXIT_DUPLICATE_CONDITION: 3,
  FORM_PROCESS_ERROR_MISMATCH: 3, FORM_PROCESS_TIMEOUT_MISMATCH: 3,
  ERROR_EXIT_UI_FLAG_MISMATCH: 3, TIMEOUT_EXIT_UI_FLAG_MISMATCH: 3,
  ERROR_EXIT_NOT_DECLARED: 3, TIMEOUT_EXIT_NOT_DECLARED: 3,
  TIMEOUT_EXIT_NO_DURATION: 3,
  PROCESS_ERROR_CHECK_ALWAYS_FALSE: 3,
  EXTERNAL_CALL_NO_ERROR_HANDLING: 3,

  // Phase 4 — formBuilder / inputs
  TEMPLATE_MISSING_FORMBUILDER: 4, TEMPLATE_EMPTY_FORMBUILDER: 4,
  FORM_INPUT_NO_MERGE_FIELDS: 4, INPUT_NOT_IN_FORM: 4, INPUT_UNUSED: 4,
  INPUT_DUPLICATE_VARIABLE: 4, INPUT_MISSING_LABEL: 4, INPUT_INVALID_VARIABLE_NAME: 4,
  FORM_RENDER_CONDITION_REF_MISSING: 4, RENDER_CONDITION_SYNTAX_ERROR: 4,
  RENDER_CONDITION_RUNTIME_ERROR: 4, RENDER_CONDITION_BUILDER_MISSING: 4,
  RENDER_CONDITION_DUAL_CONFIG: 4,
  RENDER_CONDITION_INVALID_TRUEVALUE: 4, RENDER_CONDITION_INVALID_DEFAULT: 4,
  RENDER_CONDITION_INVALID_RULES: 4, RENDER_CONDITION_RULE_REF_MISSING: 4,
  RENDER_CONDITION_RULE_INVALID_TYPE: 4, RENDER_CONDITION_RULE_FUNC_INVALID: 4,
  RENDER_CONDITION_RULE_INVALID_VALUE_TYPE: 4, RENDER_CONDITION_RULE_CODEVALUE_INVALID: 4,
  DISABLE_CONDITION_SYNTAX_ERROR: 4, DISABLE_CONDITION_REF_MISSING: 4,
  DISABLE_CONDITION_INVALID_TRUEVALUE: 4, DISABLE_CONDITION_INVALID_DEFAULT: 4,
  DISABLE_CONDITION_INVALID_RULES: 4, DISABLE_CONDITION_RULE_REF_MISSING: 4,
  DISABLE_CONDITION_RULE_INVALID_TYPE: 4, DISABLE_CONDITION_RULE_FUNC_INVALID: 4,
  DISABLE_CONDITION_RULE_INVALID_VALUE_TYPE: 4, DISABLE_CONDITION_RULE_CODEVALUE_INVALID: 4,
  EXIT_CONDITION_SYNTAX_ERROR: 4, EXIT_CONDITION_INVALID_TRUEVALUE: 4,
  EXIT_CONDITION_INVALID_DEFAULT: 4, EXIT_CONDITION_INVALID_RULES: 4,
  EXIT_CONDITION_RULE_REF_MISSING: 4, EXIT_CONDITION_RULE_INVALID_TYPE: 4,
  EXIT_CONDITION_RULE_FUNC_INVALID: 4, EXIT_CONDITION_RULE_INVALID_VALUE_TYPE: 4,
  EXIT_CONDITION_RULE_CODEVALUE_INVALID: 4,
  FORM_VUE2_LISTENERS: 4,
  FORM_VUE2_SCOPED_SLOTS: 4, FORM_VUE2_LIFECYCLE: 4, FORM_VUE2_REACTIVITY: 4,
  FORM_VUE2_EVENT_BUS: 4, FORM_LEGACY_COMPONENTS: 4,
  WILDCARD_MISSING_TEMPLATE: 4, WILDCARD_TEMPLATE_REF_MISSING: 4,
  WILDCARD_TEMPLATE_REF_UNRESOLVED: 4, WILDCARD_MISSING_LOGIC: 4,
  WILDCARD_VUE2_LIFECYCLE: 4, WILDCARD_VUE2_REACTIVITY: 4,
  WILDCARD_VUE2_EVENT_BUS: 4, WILDCARD_VUE2_LISTENERS: 4,
  WILDCARD_VUE2_SCOPED_SLOTS: 4, WILDCARD_TOJSON_NOT_APPLIED: 4,
  WILDCARD_INVALID_RENDER_CONDITION: 4, WILDCARD_DYNAMIC_EXITS: 4,
  WILDCARD_INVALID_VALIDATORS: 4,
  TEMPLATE_FORM_INVALID: 4, TEMPLATE_INVALID_GATEWAY_FLAG: 4,
  TEMPLATE_GATEWAY_WRONG_SHAPE: 4,
  FORM_UNKNOWN_COMPONENT: 4, FORM_EXIT_UNKNOWN_COMPONENT: 4,
  FORM_EXIT_MISSING_COMPONENT: 4, FORM_EXIT_MISSING_ID: 4, FORM_EXIT_MISSING_DATA_ID: 4,
  FORM_EXIT_MISSING_CONDITION: 4, FORM_MISSING_ERROR_EXIT: 4,
  FORM_MISSING_FORMTEMPLATE: 4,
  FORM_INVALID_SKIP_LOGIC: 4, WILDCARD_CONTEXT_PROP_NOT_PASSED: 4,
  WILDCARD_MISSING_SCHEMA_BINDING: 4, WILDCARD_STYLES_NOT_COMPILED: 4,
  AUTH_SHOULD_USE_COMPONENT: 4, AUTH_MISSING_INHERITANCE: 4,
  AUTH_PLAIN_TEXT_INPUT: 4, AUTH_NO_KV_RESOLUTION: 4,
  TEMPLATE_DATA_HARDCODED_MERGE_REF: 4,

  // Phase 5 — metadata
  TEMPLATE_NO_DESCRIPTION: 5, TEMPLATE_NO_HELP: 5, TEMPLATE_NO_ICON: 5,
  TEMPLATE_LABEL_LONG: 5, TEMPLATE_LABEL_TOO_LONG: 5,
  TEMPLATE_INVALID_ICONTYPE: 5, TEMPLATE_CUSTOM_ICON_NO_URL: 5,
  TEMPLATE_INVALID_ICON_URL: 5, TEMPLATE_ICONURL_IGNORED: 5,
  TEMPLATE_ICON_HTTP_URL: 5, TEMPLATE_ICON_DATA_URI_TOO_LARGE: 5,
  TEMPLATE_ICON_SVG_NO_VIEWBOX: 5, TEMPLATE_ICON_SVG_DARK_BG: 5,
  TEMPLATE_NO_CATEGORIES: 5, TEMPLATE_INVALID_SCHEMA_TYPE: 5,
  TEMPLATE_INVALID_SHAPE: 5, TEMPLATE_INVALID_SIZE: 5,
  TEMPLATE_SIZE_SHAPE_MISMATCH: 5, TEMPLATE_GATEWAY_SIZE_MISMATCH: 5,
  TEMPLATE_INVALID_TAGS: 5, TEMPLATE_INVALID_RECOMMENDED_STEPS: 5,
  TEMPLATE_INVALID_ROOT_INPUT_URN: 5, TEMPLATE_INVALID_STEP_PACKAGES: 5,
  SPEC_INVALID_SIZE: 5, SPEC_INVALID_KIND: 5, SPEC_GATEWAY_SIZE: 5,
  SPEC_HTTP_SIZE: 5, SPEC_SIZE_SHAPE_MISMATCH: 5, SPEC_MISSING_SIZE: 5,
  MIGRATION_NO_VERSION: 5, MIGRATION_NO_EXPORT: 5, MIGRATION_ORDER: 5,
  HOOKS_NO_EXPORT: 5, HOOKS_UNKNOWN_FUNCTION: 5, HOOKS_INVALID_VALUE: 5,
  DATAOUT_INPUT_NO_DEFAULT_NAME: 5,
  DATAOUT_NAME_NOT_SET: 5, DATAOUT_NAME_DEFAULTNAME_MISMATCH: 5,
  DATAOUT_FORM_WITHOUT_DATA: 5, DATAOUT_FLAG_NO_COMPONENT: 5,

  // Phase 6 — output / dataOut
  OUTPUT_EXAMPLE_MISSING: 6, OUTPUT_EXAMPLE_EMPTY: 6,
  OUTPUT_EXAMPLE_UNREFERENCED: 6,
  OUTPUT_EXAMPLE_PLACEHOLDER_VALUES: 6, OUTPUT_EXAMPLE_TOO_LARGE: 6,
  OUTPUT_EXAMPLE_DEEPLY_NESTED: 6, OUTPUT_NO_DATAOUT: 6,
  DATAOUT_MISSING: 6, DATAOUT_NO_NAME: 6, DATAOUT_INVALID_TYPE: 6,
  DATAOUT_INVALID_TTL: 6, DATAOUT_MISMATCH: 6,
  EXITSTEP_NO_DATA_WITH_DATAOUT: 6, SECRET_IN_DEFAULT_VALUE: 6,
  INPUT_SENSITIVE_NO_MERGE_FIELDS: 4, INPUT_SENSITIVE_FIELD: 4,

  // Phase 7 — polish
  INPUT_MISSING_HELPTEXT: 7, MIXED_INDENT: 7, LINE_TOO_LONG: 7,
  TRAILING_WHITESPACE: 7, INCONSISTENT_QUOTES: 7, MULTIPLE_BLANK_LINES: 7,
  MISSING_FINAL_NEWLINE: 7,
};

const PHASE_LABELS = [
  'Classification & scaffolding',
  'Basic step structure',
  'Code quality',
  'Exit definitions',
  'Form inputs (formBuilder)',
  'Metadata (name, icon, help, categories)',
  'Output (outputExample, dataOut)',
  'Polish (helpText, formatting)',
];

function formatResult(diagnostics, response) {
  for (const d of diagnostics) {
    if (d.phase === undefined && PHASE_MAP[d.code] !== undefined) {
      d.phase = PHASE_MAP[d.code];
    }
    d.source = 'static';
    d.trust = 'verified';
  }

  const severityOrder = { error: 0, warning: 1, info: 2 };
  diagnostics.sort((a, b) => {
    const phaseDiff = (a.phase ?? 99) - (b.phase ?? 99);
    if (phaseDiff !== 0) return phaseDiff;
    return (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3);
  });

  const counts = { error: 0, warning: 0, info: 0 };
  for (const d of diagnostics) counts[d.severity] = (counts[d.severity] || 0) + 1;

  const parts = [];
  if (counts.error) parts.push(`${counts.error} error${counts.error > 1 ? 's' : ''}`);
  if (counts.warning) parts.push(`${counts.warning} warning${counts.warning > 1 ? 's' : ''}`);
  if (counts.info) parts.push(`${counts.info} info note${counts.info > 1 ? 's' : ''}`);

  const phaseCounts = {};
  for (const d of diagnostics) {
    const p = d.phase ?? -1;
    if (!phaseCounts[p]) phaseCounts[p] = { error: 0, warning: 0, info: 0 };
    phaseCounts[p][d.severity] = (phaseCounts[p][d.severity] || 0) + 1;
  }

  let currentPhase = null;
  const completed = [];
  for (let p = 0; p <= 7; p++) {
    const pc = phaseCounts[p];
    if (!pc || (pc.error === 0 && pc.warning === 0)) {
      completed.push(p);
    } else if (currentPhase === null) {
      currentPhase = p;
    }
  }
  if (currentPhase === null) currentPhase = completed.length > 0 ? Math.max(...completed) + 1 : 0;

  const issuesInCurrent = phaseCounts[currentPhase];
  const issueCount = issuesInCurrent ? issuesInCurrent.error + issuesInCurrent.warning : 0;
  const nextPhase = currentPhase < 7 ? currentPhase + 1 : null;

  const result = {
    valid: counts.error === 0,
    counts,
    diagnostics,
    summary: parts.length ? parts.join(', ') : 'No issues found',
    ts: new Date().toISOString(),
    buildPhase: {
      current: currentPhase,
      currentLabel: PHASE_LABELS[currentPhase] || 'Complete',
      completed,
      issuesInCurrentPhase: issueCount,
      next: issueCount > 0
        ? `Fix ${issueCount} issue${issueCount > 1 ? 's' : ''} in phase ${currentPhase} (${PHASE_LABELS[currentPhase] || ''}), then resubmit for phase ${nextPhase ?? 'complete'} guidance.`
        : (currentPhase >= 7 ? 'Step template is complete.' : `Phase ${currentPhase} is clean. Move to phase ${nextPhase} (${PHASE_LABELS[nextPhase] || ''}).`),
    },
  };

  result.inputType = response?.inputType ?? null;
  if (response?.beautified) result.beautified = response.beautified;

  const ANNOTATION_WORTHY = new Set([
    'TEMPLATE_ICON_NOT_CUSTOM', 'TEMPLATE_ICON_SVG_NO_VIEWBOX', 'TEMPLATE_ICON_SVG_DARK_BG',
    'TEMPLATE_ICON_HTTP_URL', 'TEMPLATE_ICON_DATA_URI_TOO_LARGE',
    'NO_CODE', 'STEP_NO_EXITS', 'EXIT_NOT_DEFINED',
    'SECRET_IN_CODE', 'NO_DEBUGGER', 'NO_EVAL',
    'TEMPLATE_MISSING_FORM', 'SELECT_OPTION_NOT_EXPRESSION',
    'OUTPUT_NO_DATAOUT', 'OUTPUT_EXAMPLE_MISSING',
  ]);
  result.annotationHints = diagnostics.filter(
    d => d.severity !== 'info' && ANNOTATION_WORTHY.has(d.code)
  );

  return result;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { validateStep, beautifyCode, isClassBased, classifyInput, RUNTIME_MERGE_FIELDS };
}
