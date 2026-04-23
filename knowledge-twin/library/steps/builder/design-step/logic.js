const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-opus-4-6';
const SONNET_MODEL = 'claude-sonnet-4-20250514';
const THINKING_MODELS = ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5'];
const COLLECTION = '__authorization_service_Anthropic';
const DEFAULT_DISCOVERY_URL = 'https://discovery.edison.api.onereach.ai';
const DEFAULT_ACCOUNT_ID = '35254342-4a2e-475b-aec1-18547e517e29';
const STAGING_COMPONENTS_URL = 'https://components.staging.onereach.ai/index.js';
const CDN_BASE = 'https://files.edison.api.onereach.ai/public';

const REQUIRED_PLUGIN_REFS = [
  'onereach-studio-plugin["' + STAGING_COMPONENTS_URL + '"]["or-ui-components"]',
  'onereach-studio-form-input["' + STAGING_COMPONENTS_URL + '"]["formAsyncModule"]',
];

const REQUIRED_META = {
  name: 'formAsyncModule',
  type: 'onereach-studio-form-input',
  version: '1.0',
};

const NATIVE_INPUT_COMPONENTS = new Set([
  'formTextInput', 'formCode', 'formSwitch', 'formTextBox',
  'formSelectExpression', 'formCheckBox', 'formList',
  'formMergeTagInput', 'formTextMessage', 'radioGroup', 'datepicker',
]);

const SYSTEM_FIELDS = new Set([
  'processError', 'processTimeout', 'timeoutDuration',
  'exits', 'dataOut', '__codeModes', 'skipStepLogicExit',
]);

// ---------------------------------------------------------------------------
// Tooltip infrastructure
// ---------------------------------------------------------------------------

const TOOLTIP_INIT_JS = `
if (!window.__amTipInit) {
  window.__amTipInit = true;
  (function () {
    var tip = null, current = null, showT = null, hideT = null;
    function create() {
      tip = document.createElement('div');
      tip.className = 'am-tooltip';
      tip.style.cssText = 'position:fixed;display:none;z-index:10000;pointer-events:none;';
      document.body.appendChild(tip);
    }
    function pos(anchor) {
      if (!tip) return;
      tip.style.display = 'block';
      var r = anchor.getBoundingClientRect();
      var tw = tip.offsetWidth, th = tip.offsetHeight;
      var vw = window.innerWidth, vh = window.innerHeight;
      var top = r.top - th - 8, left = r.left + r.width / 2 - tw / 2, pl = 'top';
      if (top < 4) { top = r.bottom + 8; pl = 'bottom'; }
      if (top + th > vh - 4) { top = Math.max(4, vh - th - 4); }
      left = Math.max(4, Math.min(left, vw - tw - 4));
      tip.className = 'am-tooltip am-tooltip-' + pl;
    }
    document.addEventListener('mouseover', function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!el || el === current) return;
      current = el;
      clearTimeout(hideT); clearTimeout(showT);
      showT = setTimeout(function () {
        if (!tip) create();
        tip.textContent = el.getAttribute('data-tip');
        pos(el);
      }, 120);
    });
    document.addEventListener('mouseout', function (e) {
      var el = e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!el) return;
      clearTimeout(showT);
      hideT = setTimeout(function () { current = null; if (tip) tip.style.display = 'none'; }, 80);
    });
  })();
}
`.trim();

const TOOLTIP_STYLES = [
  '.am-tooltip { position: fixed; z-index: 10000; background: #1a1a2e; color: rgba(255,255,255,.92); font-size: 12px; line-height: 1.4; padding: 6px 10px; border-radius: 4px; max-width: 260px; pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.35); word-wrap: break-word; }',
  '.am-tooltip-top::after { content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-top-color: #1a1a2e; }',
  '.am-tooltip-bottom::after { content: ""; position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%); border: 5px solid transparent; border-bottom-color: #1a1a2e; }',
  '.am-tip-icon { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; font-size: 12px; font-style: normal; color: rgba(255,255,255,.35); cursor: help; margin-left: 4px; vertical-align: middle; border-radius: 50%; transition: color 0.15s; }',
  '.am-tip-icon:hover { color: rgba(100,180,255,.8); }',
  '.am-has-tip { position: relative; }',
  '.am-has-tip > .am-tip-icon { position: absolute; top: 0; right: 0; z-index: 1; }',
];

// ---------------------------------------------------------------------------
// Design Step system prompt (unchanged)
// ---------------------------------------------------------------------------

const DESIGN_SYSTEM = `You are an Edison step architect. Given a natural language description of what a step should do, generate a complete step.json specification.

Edison steps are ESM modules with a class extending Step that has an async runStep() method. They run inside the Edison flow runtime.

Return ONLY valid JSON with this exact structure:
{
  "spec": {
    "name": "kebab-case-name",
    "label": "Human Readable Label",
    "description": "Step Building Pipeline — Clear description. Inputs: list required/optional inputs. Returns: list output fields.",
    "version": "1.0.0",
    "kind": "logic",
    "icon": "material_icon_name",
    "shape": "circle",
    "size": "small",
    "service": "Service Category",
    "categories": ["Pre-release", "Category"],
    "modules": [{ "name": "@or-sdk/flows", "version": "^1" }],
    "inputs": [
      { "variable": "camelCaseName", "label": "Human Label", "type": "text|json|code|switch|textarea|auth|select", "required": true|false, "helpText": "Clear description of this input." }
    ],
    "exits": [
      { "id": "next", "label": "next" },
      { "id": "__error__", "label": "on error", "condition": "processError" },
      { "id": "__timeout__", "label": "on timeout", "condition": "processTimeout" }
    ],
    "processTimeout": true,
    "timeout": "\\\`120 sec\\\`",
    "dataOut": { "name": "camelCaseResult", "type": "session", "ttl": 86400000 },
    "outputExample": { "field1": "example", "field2": 123 }
  },
  "logicPlan": {
    "behavior": "Detailed description of what the step logic should do, step by step.",
    "errorHandling": "How errors should be handled. Use throw new Error() — the global error handler catches them.",
    "codeNotes": "Technical notes for the code generator: APIs to use, data transformations, edge cases.",
    "modules": ["@or-sdk/flows"],
    "externalApis": ["any external API endpoints the step calls"]
  }
}

Rules:
- Input types: text (strings), json (objects/arrays), code (long text/code), switch (boolean), textarea (multiline text), auth (API keys via Edison auth system), select (dropdown with options array)
- For auth inputs, use: { "type": "auth", "config": { "collection": "__authorization_service_ServiceName", "authType": "token", "fieldList": [{ "masked": true, "fieldName": "auth", "fieldLabel": "API Key" }] } }
- Always include __error__ and __timeout__ exits
- Set timeout based on what the step does
- The name should be kebab-case, the label Title Case
- dataOut.name should be camelCase derived from the label
- outputExample should have realistic sample data
- modules: include @or-sdk/flows if reading/writing flows, @or-sdk/files-sync-node (version "0.0.6") if uploading files
- description should follow: "What it does. Inputs: list required/optional inputs. Returns: list output fields."
- icon should be a valid Material Icons name

UI Design Rules — make the step pleasant and intuitive to configure:
- Labels should be concise, human-friendly, and action-oriented
- helpText should explain WHAT to put in the field and WHY
- Use "default" for sensible defaults
- Order inputs from most important to least: required first, then optional, then advanced
- Use switch type for on/off toggles, select for fixed choices, textarea for multi-line, code for JSON
- Include a "placeholder" field with example values
- The step should be usable with just the required inputs filled in`;

// ---------------------------------------------------------------------------
// Async UI LLM system prompt
// ---------------------------------------------------------------------------

const ASYNC_UI_SYSTEM = `You are an expert Vue 2.7 component developer for OneReach Edison async modules.

Your job: create a high-quality async module that provides a polished configuration UI for a step.

DESIGN PRINCIPLES — improvements must be real, not different for the sake of different:
- Group related fields logically (connection settings, options, output config)
- Add section headers to break up long forms
- Use tooltips (data-tip attribute) for contextual help that doesn't clutter the UI
- Use conditional visibility to hide fields until relevant
- For >8 fields: use a summary card that opens a modal overlay
- Use consistent spacing and visual hierarchy

TOOLTIPS — use data-tip for contextual help:
Any element with data-tip="Help text" shows a position:fixed tooltip on hover.
- For host elements: wrap in <div class="am-has-tip"> and add <i class="am-tip-icon" data-tip="...">&#8505;</i>
- For labels: <label class="am-label">Name <i class="am-tip-icon" data-tip="...">&#8505;</i></label>
- For section headers: <div class="am-section-header">Group <i class="am-tip-icon" data-tip="...">&#8505;</i></div>
- Keep tooltip text concise (1-2 sentences). Explain WHY or WHEN, not just repeat the label.

CRITICAL TECHNICAL RULES:
- Use const $schema = inject('$schema') or VCA.inject('$schema')
- Use ONLY <or-text-expression> and <or-select-expression> as input elements
- ALL host elements MUST have :steps, :step-id, :readonly, :merge-fields props
- Computed get/set with equality guards: if ($schema.x !== v) $schema.x = v
- Select option values MUST be backtick-wrapped: { value: '\`foo\`' }
- Module runs in ~360px wide side panel
- Switch/checkbox fields use native <input type="checkbox"> with am-switch class
- Include tooltip init (guarded with __amTipInit) in componentLogic

Return JSON:
{
  "componentTemplate": "<div class='async-module'>...template HTML...</div>",
  "componentLogic": "// tooltip init\\nif(!window.__amTipInit){...}\\nconst { computed, inject, ref } = window.VueCompositionAPI;\\nconst $schema = inject('$schema');\\n...\\nreturn { field1, field2 };",
  "componentStyles": ".async-module { ... } .am-tooltip { ... } .am-tip-icon { ... }",
  "esmSource": "const VCA = window.VueCompositionAPI;\\nexport default VCA.defineComponent({ name: '...', props: { v:{...}, schema:{...}, step:{...}, steps:{...}, stepId:{...}, isNew:{...}, readonly:{...}, stepTemplates:{...}, mergeFields:{...}, designMode:{...}, additionalProps:{...} }, template: \`<div class='async-module'>...FULL HTML template here...</div>\`, setup(props) { ... } });",
  "changes": ["grouped fields into 3 sections", "added tooltips to 4 fields"]
}

CRITICAL: The esmSource MUST include the \`template\` property with the FULL HTML template inside defineComponent. Without it the component renders nothing. The template MUST use <or-text-expression> and <or-select-expression> elements with all required host props. Do NOT put template HTML only in componentTemplate — it MUST also be inside esmSource's defineComponent.
The esmSource MUST define ALL 11 props: v, schema, step, steps, stepId, isNew, readonly, stepTemplates, mergeFields, designMode, additionalProps.

IMPORTANT: Return ONLY valid JSON. No markdown, no code fences.`;

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function uuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout after ' + (ms / 1000) + 's')), ms)),
  ]);
}

async function getFlowToken(tokenUrl) {
  const resp = await fetch(tokenUrl);
  if (!resp.ok) throw new Error('Token fetch ' + resp.status);
  const data = await resp.json();
  return data.token || data.access_token || data;
}

// ---------------------------------------------------------------------------
// Field extraction from template
// ---------------------------------------------------------------------------

function extractFieldsFromTemplate(template) {
  const inputs = template.formBuilder?.stepInputs || [];
  const fields = [];
  function walk(items) {
    for (const item of items) {
      const comp = Array.isArray(item.component) ? item.component[0] : (item.component || '');
      // Skip non-field components but recurse into collapsible groups
      if (comp === 'formDataOut' || comp === 'auth-external-component') {
        if (Array.isArray(item.data?.inputs)) walk(item.data.inputs);
        continue;
      }
      // For existing async modules: extract fields from data.data (the field defaults)
      if (comp === 'formAsyncModule') {
        if (Array.isArray(item.data?.inputs)) walk(item.data.inputs);
        let amData = item.data?.data;
        if (typeof amData === 'string') { try { amData = JSON.parse(amData); } catch (_) { amData = null; } }
        if (amData && typeof amData === 'object') {
          for (const [k, v] of Object.entries(amData)) {
            if (SYSTEM_FIELDS.has(k)) continue;
            const defVal = typeof v === 'string' ? v : '';
            fields.push({ name: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim(), type: 'text', helpText: '', defaultValue: defVal, fromAsyncModule: true });
          }
        }
        continue;
      }
      if (comp === 'formCollapsible') {
        if (Array.isArray(item.data?.inputs)) walk(item.data.inputs);
        continue;
      }
      const d = item.data || {};
      const variable = d.variable || d.name || '';
      if (!variable || SYSTEM_FIELDS.has(variable)) {
        if (Array.isArray(d.inputs)) walk(d.inputs);
        continue;
      }
      const type = ({
        formTextInput: 'text', formTextBox: 'textarea', formSelectExpression: 'select',
        formCode: 'code', formSwitch: 'switch', formCheckBox: 'checkbox',
        formList: 'list', formMergeTagInput: 'text', formTextMessage: 'textarea',
        radioGroup: 'radio', datepicker: 'date',
      })[comp] || 'text';
      const field = { name: variable, label: d.label || variable, type, helpText: d.helpText || '' };
      if (d.validateRequired || d.required) field.required = true;
      if (d.defaultValue !== undefined && d.defaultValue !== null) field.defaultValue = d.defaultValue;
      if ((type === 'select' || d.options) && Array.isArray(d.options)) {
        field.options = d.options.map(o =>
          typeof o === 'object' ? { label: o.label || o.value, value: o.value } : { label: String(o), value: String(o) }
        );
        field.type = 'select';
      }
      if (d.visibleWhen) field.visibleWhen = d.visibleWhen;
      fields.push(field);
      if (Array.isArray(d.inputs)) walk(d.inputs);
    }
  }
  walk(inputs);
  return fields;
}

// ---------------------------------------------------------------------------
// Module source evaluation
// ---------------------------------------------------------------------------

function evaluateModuleSource(sourceCode) {
  const diags = [];
  function d(code, severity, message) { diags.push({ code, severity, message }); }
  if (!sourceCode || sourceCode.trim().length < 50) {
    d('AM_SOURCE_EMPTY', 'error', 'Source is empty or too short');
    return { diags, score: 0 };
  }
  // ESM modules need props or BaseInput; inline modules use inject
  if (!sourceCode.includes('extends: BaseInput') && !sourceCode.includes('props:') &&
      !sourceCode.includes("inject('$schema')") && !sourceCode.includes('inject("$schema")')) {
    d('AM_NO_SCHEMA_INJECT', 'error', 'Component does not inject $schema or define props');
  }
  const hostEls = ['or-text-expression', 'or-select-expression'];
  for (const el of hostEls) {
    const matches = sourceCode.match(new RegExp('<' + el + '[\\s\\S]*?>', 'g')) || [];
    for (const m of matches) {
      if (!m.includes(':steps=') && !m.includes('v-bind:steps=')) { d('AM_HOST_MISSING_STEPS', 'warning', '<' + el + '> missing :steps'); break; }
      if (!m.includes(':step-id=') && !m.includes('v-bind:step-id=')) { d('AM_HOST_MISSING_STEP_ID', 'warning', '<' + el + '> missing :step-id'); break; }
    }
  }
  if (!sourceCode.includes('VueCompositionAPI') && !sourceCode.includes('VCA')) {
    d('AM_NO_VCA', 'warning', 'Module should use window.VueCompositionAPI');
  }
  // ESM modules MUST have a template property — without it the component renders nothing
  if (sourceCode.includes('defineComponent') && !sourceCode.includes('template:') && !sourceCode.includes('template :')) {
    d('AM_NO_TEMPLATE', 'error', 'defineComponent is missing template property — component will render nothing');
  }
  // ESM modules should have host elements in the template
  if (sourceCode.includes('defineComponent') && !sourceCode.includes('or-text-expression') && !sourceCode.includes('or-select-expression')) {
    d('AM_NO_HOST_ELEMENTS', 'warning', 'Module has no <or-text-expression> or <or-select-expression> input elements');
  }
  // Catch invalid :multiline prop on or-text-expression
  if (sourceCode.includes(':multiline=') || sourceCode.includes('v-bind:multiline=')) {
    d('AM_INVALID_MULTILINE', 'error', 'or-text-expression does not have a :multiline prop — remove it');
  }
  const dataTipCount = (sourceCode.match(/data-tip=/g) || []).length;
  const hasTooltipInit = sourceCode.includes('__amTipInit');
  if (dataTipCount > 0 && !hasTooltipInit) {
    d('AM_TOOLTIP_NO_INIT', 'warning', 'data-tip found but tooltip init missing');
  }
  let score = 100;
  for (const diag of diags) {
    if (diag.severity === 'error') score -= 20;
    else if (diag.severity === 'warning') score -= 8;
    else if (diag.severity === 'info') score -= 2;
  }
  if (dataTipCount > 0 && hasTooltipInit) score = Math.min(100, score + 3);
  if (dataTipCount >= 3) score = Math.min(100, score + 2);
  return { diags, score: Math.max(0, score) };
}

// ---------------------------------------------------------------------------
// Inline module generator — produces componentTemplate, componentLogic, componentStyles
// ---------------------------------------------------------------------------

function generateInlineModule(moduleName, fields) {
  const safeName = moduleName.replace(/[^a-zA-Z0-9]/g, '');
  const useModal = fields.length > 8;
  const setupLines = [];
  const returnFields = [];

  for (const f of fields) {
    const vn = f.name;
    setupLines.push('    const ' + vn + ' = computed({');
    setupLines.push('      get: () => $schema.' + vn + ',');
    setupLines.push('      set: (v) => { if ($schema.' + vn + ' !== v) $schema.' + vn + ' = v; },');
    setupLines.push('    });');
    returnFields.push(vn);
    if (f.type === 'select' && f.options) {
      const optsVar = vn + 'Options';
      const optsLiteral = f.options.map(o => {
        const ol = (typeof o === 'object' ? o.label : String(o)).replace(/'/g, "\\'");
        const ov = (typeof o === 'object' ? o.value : String(o)).replace(/'/g, "\\'");
        return "{ label: '" + ol + "', value: '`" + ov + "`' }";
      }).join(', ');
      setupLines.push('    const ' + optsVar + ' = [' + optsLiteral + '];');
      returnFields.push(optsVar);
    }
  }
  if (useModal) { setupLines.push("    const showModal = ref(false);"); returnFields.push('showModal'); }

  // Build template
  const templateLines = [];
  const indent = useModal ? 6 : 2;
  for (const f of fields) {
    const vn = f.name;
    const lbl = (f.label || f.name).replace(/"/g, '&quot;');
    const help = (f.helpText || '').replace(/"/g, '&quot;');
    const tipAttr = help ? ' data-tip="' + help + '"' : '';
    const pad = ' '.repeat(indent);
    if (f.type === 'select' && f.options) {
      if (help) {
        templateLines.push(pad + '<div class="am-has-tip">');
        templateLines.push(pad + '  <or-select-expression :value="' + vn + '" :options="' + vn + 'Options" label="' + lbl + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" :has-search="true" @input="' + vn + ' = $event" />');
        templateLines.push(pad + '  <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>');
        templateLines.push(pad + '</div>');
      } else {
        templateLines.push(pad + '<or-select-expression :value="' + vn + '" :options="' + vn + 'Options" label="' + lbl + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" :has-search="true" @input="' + vn + ' = $event" />');
      }
    } else if (f.type === 'switch' || f.type === 'checkbox') {
      templateLines.push(pad + '<div class="am-switch">');
      templateLines.push(pad + '  <input type="checkbox" :checked="' + vn + " === 'true' || " + vn + ' === true || ' + vn + " === '`true`'" + '" @change="' + vn + " = $event.target.checked ? '`true`' : '`false`'" + '" :disabled="readonly" />');
      templateLines.push(pad + '  <span class="am-switch-label">' + lbl + (help ? ' <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>' : '') + '</span>');
      templateLines.push(pad + '</div>');
    } else {
      if (help) {
        templateLines.push(pad + '<div class="am-has-tip">');
        templateLines.push(pad + '  <or-text-expression :value="' + vn + '" label="' + lbl + '" placeholder="Enter ' + lbl.toLowerCase() + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" @input="' + vn + ' = $event" />');
        templateLines.push(pad + '  <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>');
        templateLines.push(pad + '</div>');
      } else {
        templateLines.push(pad + '<or-text-expression :value="' + vn + '" label="' + lbl + '" placeholder="Enter ' + lbl.toLowerCase() + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" @input="' + vn + ' = $event" />');
      }
    }
  }

  const componentTemplate = '<div class="async-module">\n' + templateLines.join('\n') + '\n</div>';

  const componentLogic = '// Tooltip init\n' + TOOLTIP_INIT_JS + '\n\n'
    + "const { computed, inject, ref } = window.VueCompositionAPI;\n"
    + "const $schema = inject('$schema');\n"
    + setupLines.join('\n') + '\n'
    + 'return { ' + returnFields.join(', ') + ' };';

  const styleLines = [
    '.async-module { padding: 4px 0; font-family: Roboto, sans-serif; }',
    '.am-section-header { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: rgba(255,255,255,.5); margin: 16px 0 6px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,.1); }',
    '.am-help { font-size: 11px; color: rgba(255,255,255,.4); margin: -4px 0 8px; padding: 0 2px; }',
    '.am-switch { display: flex; align-items: center; gap: 8px; margin: 8px 0; }',
    '.am-switch-label { color: rgba(255,255,255,.87); font-size: 13px; }',
    '.am-field { margin: 8px 0; }',
    '.am-label { display: block; font-size: 12px; color: rgba(255,255,255,.6); margin-bottom: 4px; }',
    '.am-code { width: 100%; box-sizing: border-box; background: rgba(0,0,0,.3); color: rgba(255,255,255,.87); border: 1px solid rgba(255,255,255,.15); border-radius: 4px; padding: 8px; font-family: monospace; font-size: 12px; resize: vertical; }',
    '.am-code:focus { outline: none; border-color: rgba(100,180,255,.5); }',
    ...TOOLTIP_STYLES,
  ];
  const componentStyles = styleLines.join('\n');

  return { componentTemplate, componentLogic, componentStyles };
}

// ---------------------------------------------------------------------------
// ESM module source generator — full Vue 2.7 component with all 11 props
// ---------------------------------------------------------------------------

function generateModuleSource(moduleName, fields) {
  const safeName = moduleName.replace(/[^a-zA-Z0-9]/g, '');
  const setupLines = [];
  const templateLines = [];
  const returnFields = [];

  for (const f of fields) {
    const vn = f.name;
    const lbl = (f.label || f.name).replace(/"/g, '&quot;');
    const help = (f.helpText || '').replace(/"/g, '&quot;');
    const tipAttr = help ? ' data-tip="' + help + '"' : '';

    setupLines.push('    const ' + vn + ' = VCA.computed({');
    setupLines.push('      get: () => $schema.' + vn + ',');
    setupLines.push('      set: (v) => { if ($schema.' + vn + ' !== v) $schema.' + vn + ' = v; },');
    setupLines.push('    });');
    returnFields.push(vn);

    if (f.type === 'select' && f.options) {
      const optsVar = vn + 'Options';
      const optsLiteral = f.options.map(o => {
        const ol = (typeof o === 'object' ? o.label : String(o)).replace(/'/g, "\\'");
        const ov = (typeof o === 'object' ? o.value : String(o)).replace(/'/g, "\\'");
        return "{ label: '" + ol + "', value: '" + ov + "' }";
      }).join(', ');
      setupLines.push('    const ' + optsVar + ' = [' + optsLiteral + '];');
      returnFields.push(optsVar);
      if (help) {
        templateLines.push('      <div class="am-has-tip">');
        templateLines.push('        <or-select-expression :value="' + vn + '" :options="' + optsVar + '" label="' + lbl + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" :has-search="true" @input="' + vn + ' = $event" />');
        templateLines.push('        <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>');
        templateLines.push('      </div>');
      } else {
        templateLines.push('      <or-select-expression :value="' + vn + '" :options="' + optsVar + '" label="' + lbl + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" :has-search="true" @input="' + vn + ' = $event" />');
      }
    } else if (f.type === 'switch' || f.type === 'checkbox') {
      templateLines.push('      <div class="am-switch"><input type="checkbox" :checked="' + vn + " === 'true' || " + vn + ' === true" @change="' + vn + " = $event.target.checked ? 'true' : 'false'" + '" :disabled="readonly" /><span class="am-switch-label">' + lbl + (help ? ' <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>' : '') + '</span></div>');
    } else {
      if (help) {
        templateLines.push('      <div class="am-has-tip">');
        templateLines.push('        <or-text-expression :value="' + vn + '" label="' + lbl + '" placeholder="Enter ' + lbl.toLowerCase() + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" @input="' + vn + ' = $event" />');
        templateLines.push('        <i class="am-tip-icon"' + tipAttr + '>&#8505;</i>');
        templateLines.push('      </div>');
      } else {
        templateLines.push('      <or-text-expression :value="' + vn + '" label="' + lbl + '" placeholder="Enter ' + lbl.toLowerCase() + '" :readonly="readonly" :merge-fields="mergeFields" :steps="steps" :step-id="stepId" @input="' + vn + ' = $event" />');
      }
    }
  }

  const tooltipSetup = '    // Tooltip init\n    if (!window.__amTipInit) { ' + TOOLTIP_INIT_JS.replace(/\n/g, ' ') + ' }\n';
  const styleBlock = TOOLTIP_STYLES.concat([
    '.async-module { padding: 4px 0; font-family: Roboto, sans-serif; }',
    '.am-switch { display: flex; align-items: center; gap: 8px; margin: 8px 0; }',
    '.am-switch-label { color: rgba(255,255,255,.87); font-size: 13px; }',
  ]).map(s => '      ' + s).join('\\n');

  return '// Auto-generated async module: ' + moduleName + '\n'
    + 'const VCA = window.VueCompositionAPI;\n\n'
    + 'export default VCA.defineComponent({\n'
    + '  name: \'' + safeName + 'Module\',\n'
    + '  props: {\n'
    + '    v: { type: Object, required: true },\n'
    + '    schema: { type: Object, required: true },\n'
    + '    step: { type: Object, required: true },\n'
    + '    steps: { type: Array, required: true },\n'
    + '    stepId: { type: String, required: true },\n'
    + '    isNew: { type: Boolean, required: true },\n'
    + '    readonly: { type: Boolean, required: true },\n'
    + '    stepTemplates: { type: Array, required: true },\n'
    + '    mergeFields: { type: Array, required: true },\n'
    + '    designMode: { type: Boolean, required: true },\n'
    + '    additionalProps: { type: Object, required: true },\n'
    + '  },\n'
    + '  template: `\n'
    + '    <div class="async-module">\n'
    + templateLines.join('\n') + '\n'
    + '    </div>\n'
    + '  `,\n'
    + '  setup(props) {\n'
    + tooltipSetup
    + '    const $schema = VCA.inject(\'$schema\');\n'
    + setupLines.join('\n') + '\n'
    + '    return { ' + returnFields.join(', ') + ' };\n'
    + '  },\n'
    + '});\n';
}

// ---------------------------------------------------------------------------
// Async module data helpers — toJson, validators, default data
// ---------------------------------------------------------------------------

function buildAsyncModuleToJson() {
  return [
    'function toJson(data) {',
    '  if (_.isArray(data)) {',
    '    return `[${_.map(data, toJson).join(\',\')}]`;',
    '  }',
    '  if (_.isObject(data)) {',
    '    return `{${_.map(data, (value, key) => `${key}: ${toJson(value)}`).join(\',\')}`;',
    '  }',
    '  return data;',
    '}',
    '',
    'return _.mapValues(data, toJson);',
  ].join('\n');
}

function buildAsyncModuleValidators(fields) {
  const requiredFields = fields.filter(f => f.required);
  if (requiredFields.length === 0) return '';
  const entries = requiredFields.map(f => {
    const label = f.label || f.name.replace(/([A-Z])/g, ' $1').trim();
    return '  ' + f.name + ': {\n    required(value) {\n      const isStatic = typeof value === "string" && !value.includes("${") && value.startsWith("`") && value.endsWith("`");\n      if (!isStatic) return true;\n      return validators.helpers.withParams({ type: "required", message: "' + label + ' is required." }, validators.required)(value.slice(1, -1));\n    }\n  }';
  });
  return '{\n' + entries.join(',\n') + '\n}';
}

function buildAsyncModuleDataJson(fields) {
  const obj = {};
  for (const f of fields) {
    let def = f.defaultValue;
    if (def === undefined || def === null) def = '';
    if (typeof def === 'string' && !def.startsWith('`')) def = '`' + def + '`';
    obj[f.name] = def;
  }
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// formAsyncModule input builder — complete with toJson, validators, meta
// ---------------------------------------------------------------------------

function buildAsyncModuleInput({ componentUrl, fields, componentName, label, componentTemplate, componentLogic, componentStyles }) {
  const id = uuid();
  const name = componentName || ('or-async-' + uuid().replace(/-/g, '').slice(0, 20));
  const defaultRCB = {
    label: '`Conditional visibility`',
    rules: [], trueValue: 'any', description: '``',
    defaultValue: true, isNotCollapsed: false, isEditableHeader: false,
  };
  return {
    id,
    component: 'formAsyncModule',
    data: {
      allowCodeMode: true,
      applyToJson: true,
      componentCompiledStyles: componentStyles || '',
      componentLogic: componentLogic || '',
      componentName: name,
      componentOriginalStyles: componentStyles || '',
      componentTemplate: componentTemplate || '',
      componentUrl: componentUrl || '',
      data: buildAsyncModuleDataJson(fields || []),
      formTemplate: '',
      renderCondition: defaultRCB,
      renderConditionBuilder: defaultRCB,
      toJson: buildAsyncModuleToJson(),
      validators: buildAsyncModuleValidators(fields || []),
      wildcardTemplates: [],
    },
    compiled: {},
    label: label || 'Module Configuration',
    meta: { ...REQUIRED_META },
    pluginRefs: [...REQUIRED_PLUGIN_REFS],
  };
}

// ---------------------------------------------------------------------------
// CDN upload helper + HEAD verification
// ---------------------------------------------------------------------------

async function tryUploadToCdn(source, moduleName, version, token, accountId, discoveryUrl) {
  const acctId = accountId || DEFAULT_ACCOUNT_ID;
  const cdnPrefix = 'step-modules/' + moduleName + '/' + version + '/';
  const cdnUrl = CDN_BASE + '/' + acctId + '/' + cdnPrefix + 'index.mjs';
  try {
    const mod = await import('@or-sdk/files-sync-node');
    const FilesSyncNode = mod.FilesSyncNode || mod.Files || mod.default;
    const fsn = new FilesSyncNode({ token: typeof token === 'function' ? token : () => token, discoveryUrl: discoveryUrl || DEFAULT_DISCOVERY_URL });
    const client = fsn.filesClient || fsn;
    if (client.uploadFile) {
      await client.uploadFile({
        type: 'application/javascript',
        name: 'index.mjs',
        fileModel: Buffer.from(source, 'utf-8'),
        prefix: cdnPrefix,
        isPublic: true,
        rewriteMode: 'rewrite',
      });
    } else {
      const path = '/public/' + acctId + '/' + cdnPrefix + 'index.mjs';
      await client.upload(Buffer.from(source, 'utf8'), path, { contentType: 'application/javascript' });
    }
    // HEAD check to verify CDN accessibility
    try {
      const headResp = await fetch(cdnUrl, { method: 'HEAD' });
      if (!headResp.ok) return { uploaded: true, cdnUrl, warning: 'CDN HEAD returned ' + headResp.status };
    } catch (headErr) {
      return { uploaded: true, cdnUrl, warning: 'CDN HEAD failed: ' + headErr.message };
    }
    return { uploaded: true, cdnUrl };
  } catch (e) {
    return { uploaded: false, cdnUrl, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

class DesignStep extends Step {

  /* ── Playbook KV state machine ──────────────────────────────────────
   *
   * Each pipeline flow (Conceive, GenerateCode, Splice, DesignStep)
   * fetches playbook state on entry and writes its result back on exit.
   * Downstream consumers read their predecessors' output from KV rather
   * than body params. All KV operations are best-effort.
   */
  // HTTP /keyvalue primitives — same endpoint the orchestrator uses so the
  // KV state machine is interoperable between orchestrator + all four flows.
  _kvBaseUrl() {
    return 'https://em.edison.api.onereach.ai/http/35254342-4a2e-475b-aec1-18547e517e29/keyvalue';
  }

  async _getPlaybookKV(collection, key) {
    const url = `${this._kvBaseUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
    try {
      const resp = await fetch(url);
      const data = await resp.json().catch(() => ({}));
      if (!data || data.Status === 'No data found.') return null;
      if (typeof data.value !== 'string' || !data.value) return null;
      try { return JSON.parse(data.value); } catch { return null; }
    } catch (err) {
      this.log.warn('Playbook KV GET failed', { error: err.message });
      return null;
    }
  }

  async _updatePlaybookStageKV(collection, key, stageName, patch) {
    let pb = null;
    try { pb = await this._getPlaybookKV(collection, key); } catch { pb = null; }
    const now = new Date().toISOString();
    if (!pb || typeof pb !== 'object') {
      pb = {
        id: key,
        source: { markdown: '', createdAt: now },
        stages: {},
        history: [{ at: now, stage: null, event: 'created-by-flow', note: 'Initialized by DesignStep' }],
        flow: null,
        updatedAt: now,
      };
    }
    if (!pb.stages) pb.stages = {};
    if (!pb.history) pb.history = [];
    const prev = pb.stages[stageName] || {};
    const merged = { ...prev, ...patch };
    if (patch.status === 'running' && !prev.startedAt) merged.startedAt = now;
    if ((patch.status === 'done' || patch.status === 'error') && !merged.completedAt) {
      merged.completedAt = now;
      if (prev.startedAt) {
        try {
          merged.durationMs = new Date(now).getTime() - new Date(prev.startedAt).getTime();
        } catch {}
      }
    }
    pb.stages[stageName] = merged;
    pb.updatedAt = now;
    // Only push history when we have a meaningful note — orchestrator
    // already records bare status transitions. See conceive-step v1.8.1
    // for rationale (history dedupe).
    if (patch.status && patch.note) {
      pb.history.push({
        at: now,
        stage: stageName,
        event: 'flow:' + patch.status,
        note: patch.note,
      });
    }
    const url = `${this._kvBaseUrl()}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key, itemValue: JSON.stringify(pb) }),
    });
    if (!resp.ok) throw new Error(`KV PUT failed: HTTP ${resp.status}`);
    return pb.stages[stageName];
  }

  _cleanRuntimeValue(v) {
    const s = String(v == null ? '' : v).trim();
    if (!s || s === 'undefined' || s === 'null' || s === '``') return '';
    return s;
  }

  // ── Resolve API key from auth storage ──
  //
  // Robust against the three shapes splice-step can produce for the auth
  // input, depending on how it was wired:
  //   (a) plain credId string:    "6fd21caf-4b5f-4281-9b65-8d18651e2755"
  //   (b) credId with suffix:     "6fd21caf-…::token::Anthropic Key"
  //   (c) object-literal string:  '{auth: "6fd21caf-…::token::…", authData: {…}, …}'
  //   (d) actual object:          { auth: "6fd21caf-…::…", authData: {…} }
  // Case (c) is what splice-step v3.2+ writes into stepInputData after
  // canonicalizing auth-external-component — the runtime evaluates the
  // expression and delivers either a string or object to this.data.auth.
  // Previously this method assumed (a) and broke on (c)/(d) with a silent
  // null → "Anthropic API key required" error.
  async _resolveApiKey() {
    // Priority 1: explicit apiKey input (plain-text override, e.g. POST body
    // when the caller chooses to supply their own credential). Matches
    // Conceive Step's pattern — the pipeline orchestrator forwards
    // ANTHROPIC_API_KEY via `body.apiKey` so steps work regardless of
    // whether the auth-external-component collection is populated in this
    // account. Treat the literal string "undefined" as absent.
    // Using this.log.warn() throughout so messages pass the flow's default
    // logLevel='warn' filter. Switching to .info() would suppress them.
    const explicitKey = this.data.apiKey;
    if (typeof explicitKey === 'string') {
      const cleaned = explicitKey.replace(/^`|`$/g, '').trim();
      if (cleaned && cleaned !== 'undefined' && cleaned !== 'null') {
        this.log.warn('[_resolveApiKey] Priority 1 hit: using explicit apiKey input', { keyStart: cleaned.slice(0, 8) + '...' });
        return cleaned;
      }
      this.log.warn('[_resolveApiKey] Priority 1 skipped: apiKey empty/undefined', { rawType: typeof explicitKey, rawLen: explicitKey.length, rawPreview: explicitKey.slice(0, 40) });
    } else {
      this.log.warn('[_resolveApiKey] Priority 1 skipped: apiKey not a string', { rawType: typeof explicitKey });
    }

    // Priority 2: auth-external-component → Storage.get(collection, authId).
    let auth = this.data.auth;
    if (!auth) {
      this.log.warn('[_resolveApiKey] Priority 2 failed: this.data.auth is falsy', { rawAuth: auth });
      return null;
    }
    this.log.warn('[_resolveApiKey] Priority 2: this.data.auth present', { type: typeof auth, preview: typeof auth === 'string' ? auth.slice(0, 80) : JSON.stringify(auth).slice(0, 120) });

    // Object-literal STRING form (compiled expression returned verbatim)
    if (typeof auth === 'string' && auth.trim().startsWith('{')) {
      const m = auth.match(/\bauth(?:Selected)?\s*:\s*["']([^"']+)["']/);
      auth = m ? m[1] : '';
      this.log.warn('[_resolveApiKey] parsed object-literal-string form', { extracted: String(auth).slice(0, 40) });
    }
    // Actual object form (runtime evaluated the template expression)
    if (typeof auth === 'object' && auth !== null) {
      auth = auth.auth || auth.authSelected || '';
      this.log.warn('[_resolveApiKey] unwrapped object form', { extracted: String(auth).slice(0, 40) });
    }
    if (!auth) {
      this.log.warn('[_resolveApiKey] Priority 2 failed: auth id empty after unwrap');
      return null;
    }

    // DO NOT strip Edison's "::token::<label>" suffix — matches Conceive Step's
    // pattern. The credential is stored under the FULL auth id string
    // (including the ::token::<label> suffix), and stripping it causes
    // storage.get() to miss the entry. Verified by running Conceive Step with
    // an identical credential ID: Conceive passes the full id and succeeds.
    auth = String(auth).replace(/^`|`$/g, '').trim();
    if (!auth) {
      this.log.warn('[_resolveApiKey] Priority 2 failed: auth id empty after trim');
      return null;
    }
    this.log.warn('[_resolveApiKey] full auth id (no strip)', { authId: auth.slice(0, 40) + '...' });

    // Handle "inherited" marker (cross-step auth sharing)
    if (auth === 'inherited') {
      if (typeof this.getShared === 'function') {
        try { auth = await this.getShared(`shared_${COLLECTION}`); } catch { auth = ''; }
      }
      if (!auth || auth === 'inherited') {
        this.log.warn('[_resolveApiKey] Priority 2 failed: inherited marker but no shared value');
        return null;
      }
    } else if (typeof this.setShared === 'function') {
      try { await this.setShared(`shared_${COLLECTION}`, auth); } catch { /* best effort */ }
    }

    try {
      const Storage = require('or-sdk/storage');
      const storage = new Storage(this);
      this.log.warn('[_resolveApiKey] calling storage.get', { collection: COLLECTION, authId: auth.slice(0, 8) + '...' });
      const rec = await storage.get(COLLECTION, auth);
      this.log.warn('[_resolveApiKey] storage.get returned', { hasRec: !!rec, fields: rec ? Object.keys(rec) : [] });
      const raw = (rec?.apiKey || rec?.auth || rec?.anthropicKey || rec?.token || '');
      const cleaned = String(raw).replace(/\s*\[RIFF:[^\]]*\]\s*$/, '').replace(/[\r\n].*/s, '').trim();
      if (!cleaned) {
        this.log.warn('[_resolveApiKey] Priority 2 failed: storage.get returned record but no usable key field');
        return null;
      }
      this.log.warn('[_resolveApiKey] Priority 2 hit: resolved key from auth-external-component', { keyStart: cleaned.slice(0, 8) + '...' });
      return cleaned;
    } catch (e) {
      this.log.warn(`[_resolveApiKey] Priority 2 storage.get threw: ${e.message}`);
      return null;
    }
  }

  // ── Call Anthropic LLM (with thinking model support) ──
  async _callLLM(system, userContent, apiKey, model, maxTokens) {
    const apiUrl = String(this.data.apiUrl || '').trim() || DEFAULT_API_URL;
    const resolvedModel = model || SONNET_MODEL;
    const useThinking = THINKING_MODELS.some(m => resolvedModel.startsWith(m));
    const startMs = Date.now();

    const reqBody = {
      model: resolvedModel,
      system,
      messages: [{ role: 'user', content: userContent }],
      max_tokens: useThinking ? 16000 : (maxTokens || 8000),
    };

    if (useThinking) {
      reqBody.thinking = { type: 'adaptive' };
    } else {
      reqBody.temperature = 0.2;
    }

    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(reqBody),
      signal: typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(160000)
        : undefined,
    });

    const durationMs = Date.now() - startMs;

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error(`Anthropic API ${resp.status}: ${errBody.slice(0, 300)}`);
    }
    const data = await resp.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    return { text: textBlock ? textBlock.text : '', usage: data.usage || {}, durationMs, model: data.model || resolvedModel };
  }

  // ── Action: designStep (original behavior) ──
  async _designStep(apiKey) {
    const description = String(this.data.description || '').trim();
    if (!description) throw new Error('description is required for designStep action');

    const service = String(this.data.service || '').trim();
    const context = String(this.data.context || '').trim();
    const model = String(this.data.model || '').replace(/`/g, '').trim().replace(/^undefined$/, '') || DEFAULT_MODEL;

    const userPrompt = [
      '## Step Description', description,
      service ? `\n## Service Category\n${service}` : '',
      context ? `\n## Additional Context\n${context}` : '',
    ].filter(Boolean).join('\n');

    this.log.info(`Designing step from description (${description.length} chars) with ${model}`);

    const { text: raw, usage } = await this._callLLM(DESIGN_SYSTEM, userPrompt, apiKey, model, 16384);
    this.log.info(`LLM response: ${raw.length} chars`);

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM returned no parseable JSON');

    let parsed;
    try { parsed = JSON.parse(jsonMatch[0]); }
    catch (e) { throw new Error(`Failed to parse LLM JSON: ${e.message}`); }

    if (!parsed.spec) throw new Error('LLM response missing spec field');
    if (!parsed.spec.name || !parsed.spec.label) throw new Error('LLM spec missing name or label');

    this.log.info(`Designed step: "${parsed.spec.label}" with ${(parsed.spec.inputs || []).length} inputs`);

    return { action: 'designStep', spec: parsed.spec, logicPlan: parsed.logicPlan || {}, model, usage };
  }

  // ── Action: buildAsyncUI ──
  async _buildAsyncUI(apiKey) {
    const flowId = String(this.data.flowId || '').replace(/`/g, '').trim();
    const templateId = String(this.data.templateId || '').replace(/`/g, '').trim();
    const uiPlan = String(this.data.uiPlan || '').replace(/^`|`$/g, '').trim();
    if (!flowId) throw new Error('flowId is required for buildAsyncUI');
    if (!templateId) throw new Error('templateId is required for buildAsyncUI');
    if (!uiPlan) throw new Error('uiPlan (UI playbook) is required — describe the UI you want');

    const activate = this.data.activate === true || this.data.activate === 'true' || this.data.activate === '`true`';
    const model = String(this.data.model || '').replace(/`/g, '').trim().replace(/^undefined$/, '') || SONNET_MODEL;

    // 1. Auth + SDK init — prefer this.config (native Edison context) before HTTP fallback
    const accountId = String(this.data.accountId || '').replace(/`/g, '').trim()
      || (this.config && this.config.accountId ? this.config.accountId : '')
      || (typeof this.accountId === 'string' ? this.accountId : '')
      || DEFAULT_ACCOUNT_ID;
    let token;
    // Try native Edison token first (avoids an HTTP roundtrip)
    if (this.config && this.config.authorization && this.config.authorization.length > 5) {
      token = this.config.authorization;
      this.log.info('Using native config.authorization token');
    } else {
      const tokenUrl = 'https://em.edison.api.onereach.ai/http/' + accountId + '/refresh_token';
      try { token = await getFlowToken(tokenUrl); }
      catch (e) { throw new Error('Token fetch failed: ' + e.message); }
    }
    token = token.startsWith('FLOW ') ? token : 'FLOW ' + token;

    const discoveryUrl = DEFAULT_DISCOVERY_URL;
    let flows;
    try {
      const mod = await import('@or-sdk/flows');
      flows = new mod.Flows({ token: () => token, discoveryUrl });
    } catch (e) { throw new Error('Flows SDK init failed: ' + e.message); }

    // 2. Load flow + find template
    this.log.info('Loading flow ' + flowId);
    let flow;
    try { flow = await withTimeout(flows.getFlow(flowId), 15000); }
    catch (e) { throw new Error('Failed to load flow: ' + e.message); }

    const tpls = flow.data?.stepTemplates || [];
    const tpl = (Array.isArray(tpls) ? tpls : Object.values(tpls)).find(t => t.id === templateId);
    if (!tpl) throw new Error('Template ' + templateId + ' not found in flow');

    // 3. Extract fields (recursive — handles collapsible groups + existing async modules)
    let fields = extractFieldsFromTemplate(tpl);
    // Fallback: if no fields found from formBuilder, try template data defaults
    if (fields.length === 0 && tpl.data) {
      const skip = new Set([...SYSTEM_FIELDS, 'exits', 'dataOut']);
      for (const [k, v] of Object.entries(tpl.data)) {
        if (skip.has(k)) continue;
        fields.push({ name: k, label: k.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim(), type: typeof v === 'boolean' ? 'switch' : 'text', helpText: '', defaultValue: typeof v === 'string' ? v : '' });
      }
    }
    this.log.info('Extracted ' + fields.length + ' fields from template "' + (tpl.label || templateId) + '"');
    if (fields.length === 0) throw new Error('No configurable fields found in template');

    // 4. Determine mode
    const hasExistingModule = (tpl.formBuilder?.stepInputs || []).some(i => {
      const c = Array.isArray(i.component) ? i.component[0] : i.component;
      return c === 'formAsyncModule';
    });
    const mode = hasExistingModule ? 'improve-existing' : 'replace-native';
    this.log.info('Mode: ' + mode);

    // 5. Generate baseline inline + full ESM module
    const mName = String(this.data.moduleName || '').replace(/`/g, '').trim()
      || (tpl.label || 'module').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-');
    const moduleVersion = String(this.data.moduleVersion || '').replace(/`/g, '').trim() || '1.0.0';
    if (!/^\d+\.\d+\.\d+/.test(moduleVersion)) {
      throw new Error('moduleVersion "' + moduleVersion + '" is not valid semver — use major.minor.patch (e.g. "1.0.0")');
    }
    const priorInline = generateInlineModule(mName, fields);
    let moduleSource = generateModuleSource(mName, fields);
    const priorModuleEval = evaluateModuleSource(priorInline.componentLogic);
    this.log.info('Baseline module score: ' + priorModuleEval.score);

    // 6. Field summary for LLM
    const fieldSummary = fields.map(f => {
      let desc = '- ' + f.name + ' (' + f.type + '): "' + f.label + '"';
      if (f.helpText) desc += ' — ' + f.helpText;
      if (f.options) desc += ' [options: ' + f.options.map(o => typeof o === 'object' ? o.label : o).join(', ') + ']';
      if (f.required) desc += ' [required]';
      return desc;
    }).join('\n');

    // 7. Call LLM for improved module
    this.log.info('Calling LLM for async UI generation with ' + model);
    const llmUser = `## STEP: "${tpl.label || templateId}"
${tpl.description || ''}

## CURRENT LAYOUT (${mode === 'improve-existing' ? 'has existing async module' : 'native components only'})
Baseline template:
${priorInline.componentTemplate}

Baseline logic:
${priorInline.componentLogic}

## FIELDS (${fields.length} total)
${fieldSummary}

## UI PLAYBOOK
${uiPlan}

## GOAL: Create a polished async module UI following the playbook. Score must beat ${priorModuleEval.score}/100.`;

    const { text: llmRaw, usage, durationMs: llmDuration } = await this._callLLM(ASYNC_UI_SYSTEM, llmUser, apiKey, model, 8000);
    this.log.info('LLM response: ' + llmRaw.length + ' chars in ' + ((llmDuration || 0) / 1000).toFixed(1) + 's');

    const jsonMatch = llmRaw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('LLM returned no parseable JSON for async UI');

    let improved;
    try { improved = JSON.parse(jsonMatch[0]); }
    catch (e) { throw new Error('Failed to parse LLM async UI JSON: ' + e.message); }

    if (!improved.componentTemplate) throw new Error('LLM response missing componentTemplate');

    // 8. Safety net: if LLM's esmSource is missing the template property, reconstruct
    //    the ESM from componentTemplate + componentLogic so the CDN module renders.
    if (improved.esmSource && !improved.esmSource.includes('template:') && !improved.esmSource.includes('template :')) {
      this.log.warn('LLM esmSource missing template property — injecting componentTemplate');
      // Insert template: `...` right before setup( in the defineComponent
      const tplLiteral = '  template: `' + improved.componentTemplate.replace(/`/g, '\\`') + '`,\n';
      const setupIdx = improved.esmSource.indexOf('setup(');
      if (setupIdx > 0) {
        improved.esmSource = improved.esmSource.slice(0, setupIdx) + tplLiteral + '  ' + improved.esmSource.slice(setupIdx);
      } else {
        // Fallback: discard LLM esmSource, use generated baseline instead
        this.log.warn('Could not inject template into esmSource — falling back to baseline');
        improved.esmSource = moduleSource;
      }
    }
    // If LLM esmSource has only minimal props, prefer the baseline (which has all 11 props + template)
    if (improved.esmSource && !improved.esmSource.includes('or-text-expression') && !improved.esmSource.includes('or-select-expression')) {
      this.log.warn('LLM esmSource has no host input elements — falling back to baseline module');
      improved.esmSource = moduleSource;
    }

    // 8a. Auto-fix common host element issues — patch missing :steps/:step-id/:readonly/:merge-fields
    const hostFixPatterns = [
      { tag: 'or-text-expression', attr: ':steps', fix: ' :steps="steps"' },
      { tag: 'or-text-expression', attr: ':step-id', fix: ' :step-id="stepId"' },
      { tag: 'or-text-expression', attr: ':readonly', fix: ' :readonly="readonly"' },
      { tag: 'or-text-expression', attr: ':merge-fields', fix: ' :merge-fields="mergeFields"' },
      { tag: 'or-select-expression', attr: ':steps', fix: ' :steps="steps"' },
      { tag: 'or-select-expression', attr: ':step-id', fix: ' :step-id="stepId"' },
      { tag: 'or-select-expression', attr: ':readonly', fix: ' :readonly="readonly"' },
      { tag: 'or-select-expression', attr: ':merge-fields', fix: ' :merge-fields="mergeFields"' },
    ];
    let autoFixCount = 0;
    for (const src of ['esmSource', 'componentTemplate']) {
      if (!improved[src]) continue;
      // Add missing required host props
      for (const { tag, attr, fix } of hostFixPatterns) {
        const tagRe = new RegExp('<' + tag + '([\\s\\S]*?)(/?>)', 'g');
        improved[src] = improved[src].replace(tagRe, (m, attrs, close) => {
          if (attrs.includes(attr + '=') || attrs.includes(attr.replace(':', 'v-bind:') + '=')) return m;
          autoFixCount++;
          return '<' + tag + attrs + fix + close;
        });
      }
      // Remove invalid :multiline prop (or-text-expression doesn't support it)
      const beforeLen = improved[src].length;
      improved[src] = improved[src].replace(/:multiline="[^"]*"/g, '');
      improved[src] = improved[src].replace(/v-bind:multiline="[^"]*"/g, '');
      improved[src] = improved[src].replace(/:multiline='[^']*'/g, '');
      if (improved[src].length !== beforeLen) autoFixCount++;
    }
    if (autoFixCount > 0) this.log.info('Auto-fixed ' + autoFixCount + ' host element issues');

    // 8b. Quality gate — evaluate both inline logic and ESM source
    const postSource = improved.esmSource || improved.componentLogic || '';
    const postModuleEval = evaluateModuleSource(postSource);
    const delta = postModuleEval.score - priorModuleEval.score;
    this.log.info('Quality gate: prior=' + priorModuleEval.score + ' improved=' + postModuleEval.score + ' delta=' + delta);

    // Allow small tolerance (5 points) — LLM design improvements may trigger minor eval deltas
    const QUALITY_TOLERANCE = 5;
    if (postModuleEval.score < (priorModuleEval.score - QUALITY_TOLERANCE)) {
      return {
        action: 'buildAsyncUI', status: 'rejected', mode,
        reason: 'Improved module scored too low (' + postModuleEval.score + ') vs baseline (' + priorModuleEval.score + ', tolerance=' + QUALITY_TOLERANCE + ')',
        evaluation: { prior: priorModuleEval.score, improved: postModuleEval.score, delta, diagnostics: postModuleEval.diags },
      };
    }

    // 9. Upload ESM to CDN (use LLM ESM if provided, otherwise generated baseline)
    let cdnUrl = '', uploadError = '';
    const esmToUpload = improved.esmSource || moduleSource;
    try {
      const result = await tryUploadToCdn(esmToUpload, mName, moduleVersion, token, accountId, discoveryUrl);
      if (result.uploaded) {
        cdnUrl = result.cdnUrl;
        this.log.info('CDN upload: ' + cdnUrl + (result.warning ? ' (' + result.warning + ')' : ''));
      } else {
        uploadError = result.error || 'Upload returned false';
        this.log.warn('CDN upload failed: ' + uploadError);
      }
    } catch (e) {
      uploadError = e.message;
      this.log.warn('CDN upload error: ' + e.message);
    }

    // 10. Wire formAsyncModule into template (with full toJson, validators, data)
    const amInput = buildAsyncModuleInput({
      componentUrl: cdnUrl,
      fields,
      componentName: 'or-async-' + mName.replace(/[^a-z0-9]/g, ''),
      label: (tpl.label || 'Module') + ' Configuration',
      componentTemplate: improved.componentTemplate,
      componentLogic: improved.componentLogic || priorInline.componentLogic,
      componentStyles: improved.componentStyles || priorInline.componentStyles,
    });

    if (!tpl.formBuilder) tpl.formBuilder = {};
    if (!tpl.formBuilder.stepInputs) tpl.formBuilder.stepInputs = [];

    // Ensure plugin refs on template
    if (!tpl.formBuilder.pluginRefs) tpl.formBuilder.pluginRefs = [];
    for (const ref of REQUIRED_PLUGIN_REFS) {
      if (!tpl.formBuilder.pluginRefs.includes(ref)) tpl.formBuilder.pluginRefs.push(ref);
    }

    // For replace-native: remove native inputs now handled by the module
    if (mode === 'replace-native') {
      const handledFields = new Set(fields.map(f => f.name));
      tpl.formBuilder.stepInputs = tpl.formBuilder.stepInputs.filter(i => {
        const c = Array.isArray(i.component) ? i.component[0] : i.component;
        if (!NATIVE_INPUT_COMPONENTS.has(c)) return true;
        return !handledFields.has(i.data?.variable);
      });
    }

    // Replace or insert async module input
    const existingIdx = tpl.formBuilder.stepInputs.findIndex(i => {
      const c = Array.isArray(i.component) ? i.component[0] : i.component;
      return c === 'formAsyncModule';
    });
    if (existingIdx >= 0) {
      tpl.formBuilder.stepInputs[existingIdx] = amInput;
    } else {
      const doIdx = tpl.formBuilder.stepInputs.findIndex(i => {
        const c = Array.isArray(i.component) ? i.component[0] : i.component;
        return c === 'formDataOut';
      });
      if (doIdx >= 0) tpl.formBuilder.stepInputs.splice(doIdx, 0, amInput);
      else tpl.formBuilder.stepInputs.push(amInput);
    }

    // Update cacheVersion
    tpl.cacheVersion = uuid();

    // 11. Save flow (retry loop with 2 attempts)
    this.log.info('Saving flow with updated template');
    let saved, savedVersion = '';
    for (let saveAttempt = 0; saveAttempt < 2; saveAttempt++) {
      try {
        saved = await withTimeout(flows.saveFlow(flow, { previousVersion: flow.version }), 20000);
        savedVersion = saved.version || '';
        break;
      } catch (saveErr) {
        this.log.warn('Save attempt ' + (saveAttempt + 1) + ' failed: ' + saveErr.message);
        if (saveAttempt === 1) throw saveErr;
        await new Promise(r => setTimeout(r, 2000));
        // Re-auth and re-fetch
        if (this.config && this.config.authorization && this.config.authorization.length > 5) {
          token = this.config.authorization;
        } else {
          const retryTokenUrl = 'https://em.edison.api.onereach.ai/http/' + accountId + '/refresh_token';
          token = await getFlowToken(retryTokenUrl);
        }
        token = token.startsWith('FLOW ') ? token : 'FLOW ' + token;
        const mod2 = await import('@or-sdk/flows');
        flows = new mod2.Flows({ token: () => token, discoveryUrl });
        const freshFlow = await withTimeout(flows.getFlow(flowId), 15000);
        const freshTpls = freshFlow.data?.stepTemplates || [];
        const freshTpl = (Array.isArray(freshTpls) ? freshTpls : Object.values(freshTpls)).find(t => t.id === templateId);
        if (freshTpl) {
          freshTpl.formBuilder = tpl.formBuilder;
          freshTpl.help = tpl.help;
          freshTpl.cacheVersion = tpl.cacheVersion;
        }
        flow = freshFlow;
      }
    }

    this.log.info('Saved flow v' + savedVersion);

    // 12. Optional activation
    let activated = false;
    if (activate) {
      try {
        const freshFlow = await withTimeout(flows.getFlow(saved.id || flow.id), 15000);
        await withTimeout(flows.deployer.activateFlowNoPoll(freshFlow), 20000);
        activated = true;
        this.log.info('Flow activated');
      } catch (actErr) { this.log.warn('Activation skipped: ' + actErr.message); }
    }

    return {
      action: 'buildAsyncUI', status: 'ok', mode,
      flowId: saved.id || flow.id, flowVersion: savedVersion,
      saved: true, activated,
      templateId, templateLabel: tpl.label || '',
      moduleName: mName, moduleVersion,
      fieldsCount: fields.length,
      fields: fields.map(f => ({ name: f.name, label: f.label, type: f.type })),
      changes: improved.changes || [],
      evaluation: {
        prior: priorModuleEval.score, improved: postModuleEval.score, delta,
        diagnostics: postModuleEval.diags,
      },
      cdnUrl: cdnUrl || null,
      uploadError: uploadError || null,
      usage,
      llmDuration: llmDuration || null,
    };
  }

  // ── Main entry point ──
  async runStep() {
    // ── Playbook KV state machine context ─────────────────────────────
    // When playbookID is present, DesignStep becomes stateful: on entry we
    // fetch playbook state (so we can read stages.splice.flowId / .templateId
    // as fallbacks when body.flowId / body.templateId are missing), and on
    // exit we write stages.designUI back. Best-effort throughout.
    const playbookID = this._cleanRuntimeValue(this.data.playbookID);
    const playbookCollection = this._cleanRuntimeValue(this.data.playbookCollection) || 'playbooks';
    const playbookKey = this._cleanRuntimeValue(this.data.playbookKey) || playbookID;
    const playbookCtx = playbookID ? { playbookID, collection: playbookCollection, key: playbookKey } : null;
    let playbookState = null;

    if (playbookCtx) {
      try {
        playbookState = await this._getPlaybookKV(playbookCollection, playbookKey);
        if (playbookState) {
          this.log.info('Playbook KV state loaded', {
            playbookID,
            stages: Object.keys(playbookState.stages || {}),
            lastUpdate: playbookState.updatedAt,
          });
        } else {
          this.log.info('Playbook KV state not found (first writer)', { playbookID });
        }
      } catch (e) {
        this.log.warn('Playbook KV fetch failed (continuing with body inputs)', { error: e.message });
      }
      try {
        await this._updatePlaybookStageKV(playbookCollection, playbookKey, 'designUI', {
          status: 'running',
          note: 'DesignStep flow started',
        });
      } catch (e) {
        this.log.warn('Playbook KV mark-running failed (not blocking)', { error: e.message });
      }

      // Fall back to KV for missing buildAsyncUI inputs. stageSplice writes
      // stages.splice.data.{flowId, templateId, stepId}; stageHarnessCode
      // writes stages.harnessCode.data.template.
      const spliceData = playbookState?.stages?.splice?.data;
      if (spliceData) {
        if (!this._cleanRuntimeValue(this.data.flowId) && spliceData.flowId) {
          this.data.flowId = spliceData.flowId;
          this.log.info('Using stages.splice.data.flowId from KV', { flowId: spliceData.flowId });
        }
        if (!this._cleanRuntimeValue(this.data.templateId) && spliceData.templateId) {
          this.data.templateId = spliceData.templateId;
          this.log.info('Using stages.splice.data.templateId from KV', { templateId: spliceData.templateId });
        }
      }
    }

    try {
      const apiKey = await this._resolveApiKey();
      if (!apiKey) throw new Error('Anthropic API key required — configure the auth input');

      const action = String(this.data.action || '').replace(/`/g, '').trim() || 'designStep';
      this.log.info('Action: ' + action);

      let result;
      switch (action) {
        case 'designStep':
          result = await this._designStep(apiKey);
          break;
        case 'buildAsyncUI':
          result = await this._buildAsyncUI(apiKey);
          break;
        default:
          throw new Error('Unknown action: ' + action + '. Use designStep or buildAsyncUI.');
      }

      // Playbook KV: write stages.designUI on success
      if (playbookCtx) {
        try {
          await this._updatePlaybookStageKV(playbookCtx.collection, playbookCtx.key, 'designUI', {
            status: 'done',
            data: {
              action,
              status: result?.status || 'ok',
              templateLabel: result?.templateLabel || null,
              fieldsCount: result?.fieldsCount || null,
              evaluation: result?.evaluation || null,
              flowId: result?.flowId || this.data.flowId || null,
              templateId: result?.templateId || this.data.templateId || null,
            },
          });
          this.log.info('Playbook KV stages.designUI written', { playbookID: playbookCtx.playbookID });
        } catch (e) {
          this.log.warn('Playbook KV designUI-done write failed (not blocking)', { error: e.message });
        }
      }

      return this.exitStep('next', result);
    } catch (err) {
      this.log.error(`DesignStep failed: ${err.message}`);
      // Playbook KV: record the error so downstream consumers see stages.designUI.status='error'
      if (playbookCtx) {
        this._updatePlaybookStageKV(playbookCtx.collection, playbookCtx.key, 'designUI', {
          status: 'error',
          note: String(err.message || err).slice(0, 300),
          data: { message: String(err.message || err) },
        }).catch(() => { /* best effort */ });
      }
      throw err;
    }
  }
}

export { DesignStep as step };
