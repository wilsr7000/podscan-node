# Edison Platform Rules (Canonical Reference)

This is the **single source of truth** for Edison Flow Builder / step development rules. The generate-code LLM reads the compressed version of this doc as its system prompt. The step harness, validator, and patchers all cross-reference sections here by anchor.

When you add a new rule: put it here once. Consumers (generator, harness, validator, patchers) pick it up automatically via `lib/platformRules.js`.

**Audience**: the LLM generator, step authors, and reviewers. Each rule is imperative, short, with a DO/DON'T pair grounded in real library step code.

---

## Table of Contents

1. [Module Loading](#1-module-loading)
2. [Logging](#2-logging)
3. [Variables & Data Access](#3-variables--data-access)
4. [Exits & Step Navigation](#4-exits--step-navigation)
5. [Form Builder / UI Configuration](#5-form-builder--ui-configuration)
6. [Async Modules (formAsyncModule)](#6-async-modules-formasyncmodule)
7. [Help & Documentation](#7-help--documentation)
8. [Versioning](#8-versioning)
9. [Migration & Backward Compatibility](#9-migration--backward-compatibility)
10. [NPM Packages & Modules](#10-npm-packages--modules)
11. [Auth / Credential Wiring](#11-auth--credential-wiring)
12. [Error Handling](#12-error-handling)
13. [DataOut & Merge Field Output](#13-dataout--merge-field-output)
14. [Reusability](#14-reusability)
15. [Special Patterns](#15-special-patterns)
16. [Validator Rules Index](#16-validator-rules-index)
17. [Known Issues Registry](#17-known-issues-registry)
18. [Thread-Level APIs Accessible from Steps](#18-thread-level-apis-accessible-from-steps)

---

## 1. Module Loading

### Rule 1.1 — Load the Flow SDK Step class via top-level `await import`

**DO**:
```javascript
const StepMod = await import('@onereach/flow-sdk/step.js');
const Step = StepMod.default || StepMod;
```
*(See `library/steps/icons/create-icon/logic.js:1566`)*

**DON'T**:
```javascript
const Step = require('@onereach/flow-sdk/step.js');   // old gateway-only pattern
import Step from '@onereach/flow-sdk/step.js';         // ES-module `import` is rejected
```

**Why**: Edison wraps the step body in an async loader. Top-level await is legal there. Top-level ES-module `import` statements cause SYNTAX_ERROR at compile. `require(...)` is *rewritten* by the compiler (`flow_compiler.js:473-486`) to `(await import('…').then(m => m.default || m))` — so `require` technically runs, but writing the `await import` form directly is canonical and matches what the harness produces. This applies to gateway and non-gateway steps identically.

**Validator**: `RAW_CODE_NO_STEP_CLASS`. **Known issue**: KI-031.

### Rule 1.2 — Only require `@onereach/flow-sdk/step.js` and listed `modules[]`

The step can `await import()` or `require()` ONLY:
1. `@onereach/flow-sdk/step.js` (the Step class)
2. Any package declared in step.json's `modules[]` array
3. `or-sdk/storage` for auth resolution (Rule 11.2)

**DON'T**:
```javascript
const moment = require('moment-timezone');  // unless declared in modules[]
```

**Why**: Edison builds a Lambda layer from `modules[]`. Importing anything else → runtime `Cannot find module` → step dies.

### Rule 1.3 — CommonJS export, not ES-module export

**DO**:
```javascript
class MyStep extends Step { async runStep() { ... } }
exports.step = MyStep;
```

**DON'T**:
```javascript
export { MyStep as step };   // ES-module syntax — rejected
export default MyStep;
module.exports = MyStep;     // wrong property
```

**Why**: Edison parses the template as a CommonJS module expecting `exports.step`. ES-module export throws at compile. **Validator**: `RAW_CODE_NO_EXPORT`.

---

## 2. Logging

### Rule 2.1 — Use `this.log.*`, never `console.*`

**DO**:
```javascript
this.log.info('Processing calendar events', { count: events.length });
this.log.warn(`No OAuth token for source "${source.label}"`);
this.log.error('CreateIcon error', { error: err.message });
```
*(See `library/steps/calendar/calendar-trigger/logic.js:716`, `library/steps/icons/create-icon/logic.js:1634`)*

**DON'T**:
```javascript
console.log('processing');     // swallowed at runtime
console.error('fail', err);    // never reaches CloudWatch
```

**Why**: `console.*` calls are dropped by the Edison runtime. Only `this.log.*` surfaces to CloudWatch. **Validator**: `NO_CONSOLE`.

### Rule 2.2 — Log level semantics

The Edison logger (`ILogger`, `flow-sdk/src/types/logger.ts`) exposes 7 levels. Prefer the lowercase form; uppercase variants (`FATAL?`, `ERROR?`, `VITAL?`, `WARN?`, `INFO?`, `DEBUG?`, `TRACE?`) are optional-chainable and skip the argument-evaluation cost when the level is below threshold — use them for hot paths.

| Level | When to use |
|---|---|
| `this.log.fatal` | Irrecoverable failure; the process should not continue. Paired with thrown error. |
| `this.log.error` | Caught exceptions, validation failures the user needs to see. |
| `this.log.vital` | Business-critical signal that must survive log-level filtering (auditing, compliance). |
| `this.log.warn` | Recoverable issues, fallback paths, optional feature unavailable. |
| `this.log.info` | Progress milestones, decision points, inputs received, exit taken. |
| `this.log.debug` | Verbose diagnostics — gated off in production by default. |
| `this.log.trace` | Deepest trace, per-iteration details. |

Helpers: `this.log.isEnabled(level)`, `this.log.setFlowLogLevel(level?)`, `this.log.setLocalLogLevel(level?)`.

### Rule 2.3 — Log lifecycle: start, decisions, exit

Every `runStep()` should emit:
- One `this.log.info` at the top summarizing inputs received
- `this.log.info` at each decision branch ("taking path X because Y")
- `this.log.info` before returning via `exitStep('next', ...)`
- `this.log.error` in every catch block

**Why**: When a flow fails in production, CloudWatch logs are the only forensic trail. **Validator**: reusability-judge flags missing lifecycle logs.

### Rule 2.4 — Never log full credentials or large blobs

**DO**:
```javascript
this.log.info('auth resolved', { authId: auth.slice(0, 8) + '...' });
```

**DON'T**:
```javascript
this.log.info('creds', creds);    // leaks secret
this.log.info('body', bigBuffer);  // fills log budget
```

---

## 3. Variables & Data Access

### Rule 3.1 — Read all inputs from `this.data`

**DO**:
```javascript
const { location, apiBaseUrl, anomalyThreshold } = this.data;
```

**DON'T**:
```javascript
const location = this.mergeFields['httpCall'].get({path: 'request.body.location'});  // couples to upstream
const apiKey = process.env.ANTHROPIC_API_KEY;                                         // forbidden
```

**Why**: Flow authors wire `stepInputData` at design time; the SDK hydrates `this.data` at runtime. Direct `mergeFields` access or `process.env` makes the step un-reusable across flows. **Validator**: `STEP_LOGIC_HARDCODED_MERGE_REF`, `STEP_LOGIC_READS_API_INPUT`.

### Rule 3.2 — Never hardcode URLs, model names, IDs, collections

**DO**:
```javascript
const url = this.data.apiBaseUrl + '/current';
const model = this.data.model;                        // from input with default
```

**DON'T**:
```javascript
const url = 'https://api.weatherapi.com/v1/current';  // HARDCODED_URL
const model = 'claude-opus-4-6';                       // HARDCODED_MODEL
const accountId = '35254342-...';                      // HARDCODED (use this.data)
```

**Why**: Hardcoding breaks environment portability and locks the step to one account/vendor. Use inputs with `defaultValue` in formBuilder.

**Validator**: `HARDCODED_URL`, `HARDCODED_MODEL`, `HARDCODED_COLLECTION`, `HARDCODED_THRESHOLD`. **Patcher**: `HARDCODED_URL`.

### Rule 3.3 — Destructure at top (with defaults) for readability

**DO** (regular step):
```javascript
async runStep() {
  const { location, apiBaseUrl, anomalyThreshold } = this.data;
  ...
}
```

**DO** (gateway step — cache everything upfront):
```javascript
const calendars    = this.data.calendars || [];
const pollInterval = this.data.pollInterval || '5 min';
const filters      = this.data.filters || {};
```
*(See `library/steps/calendar/calendar-trigger/logic.js:23-36`)*

---

## 4. Exits & Step Navigation

### Rule 4.1 — Always `return` the exitStep call

**DO**:
```javascript
return this.exitStep('next', { result });
```

**DON'T**:
```javascript
this.exitStep('next', { result });   // execution continues unexpectedly
return;
```

**Why**: `exitStep` is a regular async function; the runtime expects its promise returned. Omitting `return` causes execution to fall through to downstream code. **Validator**: `EXITSTEP_NO_RETURN`.

### Rule 4.2 — `__error__` exit must appear in `data.exits[]`

The real invariant is exit-list membership, not a boolean. At runtime the thread does `currentStep?.getExitStepId('__error__')` (`flow-sdk/src/thread.ts:2123`) and jumps there if an exit with that id is on the step. No `processError` flag is read by the SDK.

The `processError` field is a **step-builder-ui convention**: when `hasProcessError: true`, the UI auto-appends `{ id: '__error__', label: 'error', condition: 'processError' }` to `exits[]` (see `step-builder-ui/packages/ui/src/utils/build/buildStepInitialSettings.js:26-32`) and also writes `processError: true` onto the step data. The `condition: 'processError'` field hides the exit in the canvas when the data flag is off; it does **not** gate the runtime.

**DO** (step.json):
```json
{
  "data": {
    "processError": true,
    "exits": [
      { "id": "next", "label": "next" },
      { "id": "__error__", "label": "error", "condition": "processError" }
    ]
  }
}
```

**DO** (logic.js):
```javascript
try {
  // ...
} catch (err) {
  this.log.error('runStep failed', { error: err.message, code: err.code });
  if (this.data.processError) {
    return this.exitStep('__error__', { code: err.code || 'STEP_ERROR', message: err.message });
  }
  throw err;  // let thread-level error handler surface it
}
```

**DON'T**:
```javascript
// __error__ is missing from exits[]:
return this.exitStep('__error__', { ... });   // getExitStepId returns undefined → thread falls through
```

**Why**: If the exit is missing from `exits[]`, `exitStep('__error__', …)` never routes and the thrown/caught error may silently drop. Guarding with `if (this.data.processError)` keeps logic.js in sync with the UI flag when step.json was generated from the builder. **Validator**: `ERROR_EXIT_NOT_ENABLED` (exit missing from list), `ERROR_EXIT_CALLED_BUT_DISABLED` (code exits to `__error__` without guard or exit entry). **Patcher**: `UNCONDITIONAL_ERROR_EXIT` + `ERROR_EXIT_NOT_ENABLED` (template-shape).

### Rule 4.3 — `__timeout__` exit must appear in `data.exits[]` and have a timeout source

Runtime check: `currentStep?.getExitStepId('__timeout__')` (`flow-sdk/src/thread.ts:2120`). A timeout event only fires if the step installs one — `Step.runHandle` (`flow-sdk/src/step.ts:200-208`) auto-installs `this.triggers.timeout(ms)` from `data.timeoutDuration` when no trigger exists, otherwise the step must call `this.triggers.timeout(...)` explicitly.

```json
{
  "data": {
    "processTimeout": true,
    "timeoutDuration": "`180 sec`",
    "exits": [
      { "id": "next", "label": "next" },
      { "id": "__timeout__", "label": "timeout", "condition": "processTimeout" }
    ]
  }
}
```

**Validator**: `TIMEOUT_EXIT_NOT_ENABLED` (exit missing) or `TIMEOUT_EXIT_NO_DURATION` (flag on but no trigger source). **Patcher**: `TIMEOUT_EXIT_NOT_ENABLED`.

### Rule 4.4 — Exit payload: success has data, error has `{code, message}`

**DO**:
```javascript
return this.exitStep('next', { items, count, timestamp });          // success
return this.exitStep('__error__', { code: 'NO_DATA', message: '...' });  // error
```

**DON'T**:
```javascript
return this.exitStep('__error__', 'no data');   // must be object
return this.exitStep('__error__', { error: '...' });  // code field required
```

**Why**: Downstream steps + upstream retry logic key off `code`. Generic strings lose that hook.

### Rule 4.5 — Every `data.exits[].id` must be reachable in code

Code should call `exitStep('X', ...)` for every `X` declared in `data.exits[].id`. Orphan exits → dead branches the flow author can't wire. **Validator**: `EXIT_NOT_DEFINED` (reverse direction: code exits to an id not in the list).

---

## 5. Form Builder / UI Configuration

### Rule 5.1 — Declare every runtime input in `formBuilder.stepInputs`

Structure (step.json):
```json
{
  "formBuilder": {
    "stepInputs": [
      {
        "component": ["formTextInput", "url-of-component"],
        "data": {
          "variable": "location",
          "label": "Location",
          "allowMergeFields": true,
          "defaultValue": ""
        },
        "pluginRefs": [...]
      }
    ]
  }
}
```

**Why**: formBuilder drives the Edison Studio config UI. Without an entry, the flow author has no way to pass a value; `this.data.X` is undefined at runtime.

### Rule 5.2 — Use `allowMergeFields: true` on every text input that can read from upstream

**DO**:
```json
{ "data": { "variable": "apiKey", "allowMergeFields": true } }
```

**Why**: Enables the flow author to pull `apiKey` from an upstream step's merge fields. Without it, they can only type a literal — often not what's wanted.

**Validator**: `FORM_INPUT_NO_MERGE_FIELDS`.

### Rule 5.3 — `stepInputData` values must be backtick-wrapped expressions

**DO** (in step instance on canvas):
```json
{
  "stepInputData": {
    "location": "`London`",
    "threshold": "`1.5`",
    "flag": "`true`"
  }
}
```

**Why**: Edison's compiler wraps each stepInputData value in `await (<value>)`. A naked string `"London"` becomes `await (London)` → ReferenceError. Backticks make it a template literal: `await (\`London\`)` → `"London"`. **Known issue**: KI-033, `STEP_INPUT_DEFAULT_VALUE_NOT_BACKTICKED`.

### Rule 5.4 — Auth uses `auth-external-component`, not `formTextInput`

**DO**:
```json
{
  "component": ["auth-external-component", "https://.../auth-external-component/1.3.6/index.js"],
  "data": {
    "variable": "auth",
    "keyValueCollection": "__authorization_service_Anthropic",
    "authType": "token"
  }
}
```

**Why**: Only `auth-external-component` gives the flow author a credential-picker dropdown backed by the tenant vault. `formTextInput` would make them paste the credential in plaintext → never acceptable.

---

## 6. Async Modules (formAsyncModule)

Use a `formAsyncModule` when the config UI needs Vue logic beyond what static `stepInputs` give you — conditional visibility, dynamic lookups, rich validation, multi-pane layouts, nested summary/expanded states.

### Rule 6.1 — The stepInput envelope

Every async-module entry in `formBuilder.stepInputs` has this shape (see `lib/asyncModuleBuilder.js:95-145` for the generator):

```json
{
  "id": "<uuid>",
  "component": "formAsyncModule",
  "label": "Async Module",
  "meta": {
    "name": "formAsyncModule",
    "type": "onereach-studio-form-input",
    "version": "1.0"
  },
  "pluginRefs": [
    "onereach-studio-plugin[\"<components-url>\"][\"or-ui-components\"]",
    "onereach-studio-form-input[\"<components-url>\"][\"formAsyncModule\"]"
  ],
  "data": {
    "componentUrl": "https://files.edison.api.onereach.ai/public/{ACCOUNT_ID}/step-modules/my-module/1.0.0/index.mjs",
    "componentName": "or-async-my-module",
    "data": "{ field1: `default`, field2: `` }",
    "toJson": "/* required */",
    "validators": "/* required */",
    "renderConditionBuilder": { "label": "`Conditional visibility`", "rules": [], "trueValue": "any", "defaultValue": true, "isNotCollapsed": false, "isEditableHeader": false },
    "renderCondition": { "...same shape as renderConditionBuilder" },
    "allowCodeMode": true,
    "applyToJson": true,
    "formTemplate": "",
    "componentTemplate": "",
    "componentLogic": "",
    "componentCompiledStyles": "",
    "componentOriginalStyles": "",
    "wildcardTemplates": []
  }
}
```

Both `pluginRefs` are required; Studio refuses to mount the module without them. `meta.version` is the schema version (`1.0`), not the module's own version.

### Rule 6.2 — `$schema` is the reactive store; every write is backtick-wrapped

Inside the Vue component, `$schema` is injected and bound to `data.data`. Every value written to `$schema.X` must be a **string containing a backtick-wrapped expression** — the compiler wraps it in `await (<value>)` at flow-compile time (§5.3).

**DO**:
```javascript
$schema.model = '`openai`';
$schema.temperature = '`0.7`';                         // numbers are strings too
$schema.prompt = '`Hello \${flow.variables.name}`';    // merge-field interpolation
```

**DON'T**:
```javascript
$schema.model = 'openai';   // compiler emits `await (openai)` → ReferenceError
$schema = { ... };          // replacing $schema detaches it from the host proxy
```

Unwrap for display with:
```javascript
function unwrap(v) { const s = String(v ?? ''); return s.startsWith('`') && s.endsWith('`') ? s.slice(1, -1) : s; }
```

**Reactivity edge cases (Vue 2.7 semantics)**:

- **Arrays** — mutate in place. `$schema.items.push(x)` / `$schema.items.splice(i, 1)` are observed; `$schema.items = [...]` detaches the array from the host proxy and reactivity breaks.
- **Index assignment on arrays** — Vue 2 cannot detect `$schema.items[3] = '`new`'`. Use `VCA.set($schema.items, 3, '`new`')` or splice.
- **Deep-nested objects** — mutation at any depth is observed *only if every intermediate key existed at mount time*. For new branches use `VCA.set`.
- **New keys** — `$schema.newField = '`value`'` is NOT observed if `newField` wasn't present at mount. Use `VCA.set($schema, 'newField', '`value`')`. If the host provides all declared fields at mount (via the step.json `data.data` block), you rarely need this.
- **Undefined vs null vs empty** — the toJson serializer preserves the string you put. To clear a field, write `'` ` '` (empty backticks) — not `undefined` or `null`.

### Rule 6.3 — Vue is externalized, never bundled (Vue 2.7 + Composition API)

Async modules target **Vue 2.7** with the Composition API — NOT Vue 3. The host loads a single Vue instance and exposes it as `window.VueCompositionAPI`. Your bundle must consume that global rather than ship its own Vue.

Vite config must:
- Alias `vue` to a local shim (`shims/vue.js`) that re-exports `window.VueCompositionAPI`.
- Declare `rollupOptions.output.globals: { vue: 'Vue' }`.
- Use `cssInjectedByJsPlugin` so CSS is inlined (no separate stylesheet to host).
- Produce a single `index.mjs` (`build.lib.formats: ['es']`).

The shim `shims/vue.js`:
```javascript
const VueCompositionAPI = window.VueCompositionAPI;
export default VueCompositionAPI;
export const { computed, defineComponent, inject, provide, ref, reactive, set, watch, onMounted /* ... */ } = VueCompositionAPI;
```

Bundling Vue → double-registration → reactivity breaks silently. Do NOT upgrade to Vue 3; the host runtime is Vue 2.7 and will not switch during an async module's lifetime.

### Rule 6.4 — `toJson` and `validators` are mandatory

#### `toJson`
JS source string that runs at save time. The canonical serializer (`buildAsyncModuleToJson` in `lib/asyncModuleBuilder.js:31-45`) walks arrays/objects recursively and returns a **template-literal string** of backtick-wrapped leaves. Without it, objects serialize as `{}` and nested fields like `data.auth` end up empty (E2E #13 root cause).

Canonical implementation:
```javascript
function toJson(data) {
  if (_.isArray(data))  return `[${_.map(data, toJson).join(',')}]`;
  if (_.isObject(data)) return `{${_.map(data, (v, k) => `${k}: ${toJson(v)}`).join(',')}}`;
  return data;  // scalar (string already backtick-wrapped) — pass through
}
return _.mapValues(data, toJson);
```

Given `$schema = { model: '`openai`', temp: '`0.7`', nested: { depth: '`2`' } }`, the serializer returns:
```
{ model: `openai`, temp: `0.7`, nested: {depth: `2`} }
```
— a single JavaScript object literal (not JSON) whose leaves are template literals the Flow Builder then compiles.

Scalars pass through untouched. Functions and `undefined` values slip through as-is — if a leaf is a function the output is invalid; don't put functions on `$schema`.

Missing the closing `}}` (known regression) produces `{ model: `openai`,temp: `0.7`` with no closer — every downstream eval fails. If you write a custom toJson, match the canonical braces byte-for-byte.

#### `validators`
Vuelidate-style. Each required field gets a validator that passes through merge-field refs (strings containing `${`) and only checks the literal backtick case. See `buildAsyncModuleValidators` at `lib/asyncModuleBuilder.js:50-74` for the canonical shape. Validators run at DESIGN TIME in the step panel — not at flow runtime. Custom rules: extend the generated block before emit, or post-process the validators string.

**Validator**: `ASYNC_MODULE_NO_URL`, `ASYNC_MODULE_TOJSON_DISABLED`, `ASYNC_MODULE_VALIDATORS_MISSING` (new).

### Rule 6.5 — CDN URL and versioning

Published module URL:
```
https://files.edison.api.onereach.ai/public/{ACCOUNT_ID}/step-modules/{name}/{version}/index.mjs
```

Studio caches by URL. Bump the module's own `package.json` version on every change (the CDN path changes with it) — `bumpModuleVersion` (`lib/asyncModuleBuilder.js:207-224`) handles this. This is separate from the step's semver (§8).

### Rule 6.6 — Component shape: extend `BaseInput`, expose summary

The host renders the module in two states:
- **Collapsed** — shows a summary line.
- **Expanded** — shows the full form.

Export:
```javascript
export default defineComponent({
  name: 'MyModule',
  extends: BaseInput,              // provides properties.v (Vuelidate), $schema injection, etc.
  setup(properties) {
    const $v = properties.v;
    const $schema = inject('$schema');
    const field = (name) => computed({
      get: () => $schema[name],
      set: (v) => { if ($schema[name] !== v) $schema[name] = v; },
    });
    // expose summary* computed values for the collapsed state
    const summaryTitle = computed(() => unwrap($schema.title) || '(unnamed)');
    return { summaryTitle, /* ...fields... */ };
  }
});
```

See `async-modules/elevenlabs-music/src/main.vue` for a full example.

### Rule 6.7 — `renderConditionBuilder` is required

Even a no-op module needs a `renderConditionBuilder` block in `data` (plus a matching `renderCondition`). Minimum:
```json
{
  "label": "`Conditional visibility`",
  "rules": [],
  "trueValue": "any",
  "description": "``",
  "defaultValue": true,
  "isNotCollapsed": false,
  "isEditableHeader": false
}
```

**Validator**: `RENDER_CONDITION_BUILDER_MISSING`.

### Rule 6.8 — Testing in isolation

Two options:

1. **Vite dev server** (`pnpm dev` in the module dir) with a stub host that provides `$schema` via `provide('$schema', reactive({...}))` and a mock `properties.v`. Fastest iteration loop for a module under active development.
2. **Repo-root harness** at `/async-module-harness.html` — a standalone HTML page with the Edison dark theme, schema inspector, and log viewer. Load your built `dist/index.mjs` into it to verify mount without a Studio round-trip.

Both decouple module work from Studio deploys and surface reactivity bugs locally.

### Rule 6.9 — Host elements: use `or-text-expression` and `or-select-expression` only

Inside an async module, use ONLY these two Edison web components for user input. Other `or-*` components (`or-textbox`, `or-collapsible`, `or-list`, `or-switch`, `or-button`, `or-code`) are exposed in the native step-input surface but have NOT been validated inside async modules — treat them as unsupported until proven.

#### `<or-text-expression>`

| Prop             | Type   | Required | Notes                                                                 |
|------------------|--------|----------|-----------------------------------------------------------------------|
| `:value`         | String | ✓        | Backtick-wrapped string from `$schema`                                |
| `:readonly`      | Bool   | ✓        | Pass `readonly` prop through                                          |
| `:merge-fields`  | Array  | ✓        | Pass `mergeFields` prop through — required for merge-field picker     |
| `:steps`         | Array  | ✓        | Pass `steps` prop through — required for merge-field autocomplete     |
| `:step-id`       | String | ✓        | Pass `stepId` — host identifies which step owns this input            |
| `label`          | String | —        | Label rendered above the input                                        |
| `placeholder`    | String | —        | Empty-state placeholder                                               |
| `:error`         | String | —        | Error message to show under the input                                 |
| `:invalid`       | Bool   | —        | Puts the input in error state                                         |
| `@input`         | Event  | ✓        | Fires with the backtick-wrapped string on every edit                  |

**No `:multiline` prop exists.** Do not emit it. For long text, use layout/styling.

#### `<or-select-expression>`

| Prop                      | Type   | Required | Notes                                                                 |
|---------------------------|--------|----------|-----------------------------------------------------------------------|
| `:value`                  | String | ✓        | Backtick-wrapped selected value                                       |
| `:options`                | Array  | ✓        | `[{ label, value }]` — values MUST be backtick-wrapped                |
| `:readonly`               | Bool   | ✓        |                                                                       |
| `:merge-fields`           | Array  | ✓        |                                                                       |
| `:steps`                  | Array  | ✓        |                                                                       |
| `:step-id`                | String | ✓        |                                                                       |
| `label`                   | String | —        |                                                                       |
| `:has-search`             | Bool   | —        | Defaults true; set `false` for ≤5 options                             |
| `:loading`                | Bool   | —        | Spinner while options load                                            |
| `:error` / `:invalid`     | —      | —        | As above                                                              |
| `:extendable-options`     | Bool   | —        | Allow free-text entries beyond the options array                      |
| `:allow-use-merge-fields` | Bool   | —        | Permit a merge-field reference as the value                           |
| `@input`                  | Event  | ✓        | Fires with the selected backtick-wrapped value                        |

Option values MUST be backtick-wrapped. Plain-string values will look correct in the UI but break `toJson` round-trips through code mode:
```javascript
const fmtOptions = [
  { label: 'MP3 128kbps', value: '`mp3_44100_128`' },   // ✓ good
  { label: 'Opus 48kHz',  value: 'opus_48000_128' },    // ✗ bad — code mode corrupts on save
];
```

#### Native controls (outside the host library)

For boolean switches where Yes/No options feel heavy, use a plain `<input type="checkbox">` with class `am-switch`. Guard against string/bool confusion:
```html
<input type="checkbox"
  :checked="flag === '`true`' || flag === true"
  @change="flag = $event.target.checked ? '`true`' : '`false`'"
  :disabled="readonly" />
```

---

## 7. Help & Documentation

### Rule 7.1 — `step.json.help` follows the canonical skeleton

**DO**:
```markdown
## Inputs

- `apiKey`: The API authentication token
- `query`: Search term

## Output

- `items`: Array of results
- `count`: Number of matches

## Error handling

- Returns empty array if API fails
- Timeout after 30 seconds
```

**DON'T**:
- Duplicate the description verbatim (the patcher flags this)
- Omit the three `##` sections
- Write prose paragraphs without structure

**Why**: Flow authors learn the step's interface from `help`. Consistent structure = faster onboarding + grep-ability.

**Validator**: `TEMPLATE_NO_HELP`, `TEMPLATE_HELP_DUPLICATES_DESCRIPTION`. **Patcher**: `TEMPLATE_HELP_DUPLICATES_DESCRIPTION`.

### Rule 7.2 — `step.json.description` is 1-2 sentences, under 500 chars

Longer descriptions get truncated in the canvas tooltip. **Validator**: `TEMPLATE_DESCRIPTION_TOO_LONG`. **Patcher**: `TEMPLATE_DESCRIPTION_TOO_LONG`.

### Rule 7.3 — `step.json.label` is 1-3 words

**DO**: `"label": "Weather Anomaly"`, `"label": "Send Email"`.  
**DON'T**: `"label": "Analyze Weather Data and Detect Anomalies Using ML"` (truncated in canvas).

**Validator**: `TEMPLATE_LABEL_TOO_LONG`.

---

## 8. Versioning

### Rule 8.1 — `step.json.version` uses semver (Major.Minor.Patch)

**DO**: `"version": "1.0.0"`, `"version": "2.3.1"`.  
**DON'T**: `"version": "1.0.0-beta"`, `"version": "v2"`, `"version": "latest"`.

### Rule 8.2 — Bump the version on every change

- **Patch** (x.x.**N+1**): bug fix, doc update, internal refactor
- **Minor** (x.**N+1**.0): new optional input, new exit, UI change
- **Major** (**N+1**.0.0): breaking change — removed input, renamed variable, changed output shape

**Why**: Splice + activate reject identical version numbers. Downstream flow authors rely on semver to understand blast radius.

### Rule 8.3 — Major bumps require a migration (Rule 9)

---

## 9. Migration & Backward Compatibility

### Rule 9.1 — Renamed inputs need a migration script

If you change an input's `variable` from `apiUrl` to `endpoint`, existing flow instances still have `stepInputData.apiUrl`. Migration remaps.

**DO** (in logic.js or step-json migration hook):
```javascript
// Back-compat: accept old input name
const endpoint = this.data.endpoint || this.data.apiUrl;
```

**DON'T**: silently drop the old value — every live flow using this step breaks.

### Rule 9.2 — Removed inputs need a deprecation cycle

Before removing an input:
1. Mark it deprecated in `label` (e.g., `"Legacy API URL (deprecated)"`)
2. Keep the variable readable in logic.js
3. Wait one major version
4. Then remove

### Rule 9.3 — Shape changes on `dataOut` need a major version bump

Adding fields → minor. Removing or renaming fields → major + downstream flow audit.

---

## 10. NPM Packages & Modules

### Rule 10.1 — Declare third-party deps in `step.json.modules[]`

**DO**:
```json
{
  "modules": [
    { "name": "moment-timezone", "version": "^0.5.43" },
    { "name": "axios", "version": "^1.6.0" }
  ]
}
```

### Rule 10.2 — Pin to a major version, not exact and not wildcard

**DO**: `"version": "^4.17.21"` (minor/patch floats, major pinned)  
**DON'T**: `"version": "4.17.21"` (exact — brittle) or `"version": "*"` / `"latest"` (unpredictable)

### Rule 10.3 — Keep Lambda layer under 250MB unzipped

Each step's declared modules contribute to the Lambda layer. Total cap is 250MB unzipped. If you're pulling in `puppeteer` or `sharp`, use them in a dedicated step and avoid adding to shared-code steps.

### Rule 10.4 — Node runtime: target Node 20+ (current Edison is 22.x)

`@onereach/flow-sdk` declares `engines.node: >=20.0.0`; the Edison Lambda runtime currently runs Node 22.x. Optional chaining, nullish coalescing, top-level await, `Array.at`, `Object.hasOwn`, `structuredClone` are all available.

**DON'T** use features that require Node 23+ (e.g. new private decorator proposals) — they won't parse. **Validator**: `NUMERIC_SEPARATOR` (fine on Node 20+; false positives on older engines).

---

## 11. Auth / Credential Wiring

### Rule 11.1 — Resolve auth via `or-sdk/storage`, not direct `this.data.auth` read

**DO** (the canonical pattern):
```javascript
let _authInput = this.data.auth;
if (typeof _authInput === 'object' && _authInput !== null) {
  _authInput = _authInput.auth || _authInput.authSelected || '';
}
if (!_authInput) {
  return this.exitStep('__error__', { code: 'MISSING_AUTH', message: 'auth credential is required' });
}
const _Storage = require('or-sdk/storage');
const _storage = new _Storage(this);
const _creds = await _storage.get('__authorization_service_Anthropic', _authInput);
const _apiKey = _creds?.apiKey || _creds?.token || _creds?.auth;
if (!_apiKey) {
  return this.exitStep('__error__', { code: 'AUTH_RETRIEVAL_FAILED', message: 'Could not resolve credential' });
}
```

**DON'T**:
```javascript
const apiKey = this.data.auth;   // auth is an object, not the key
const apiKey = this.data.auth.auth;  // that's the credential vault id, not the secret
```

**Why**: `this.data.auth` is the vault reference (an ID like `6fd21caf-...::token::Anthropic Key`). The actual secret lives in a separate KV collection keyed by that ID. `storage.get(collection, id)` fetches it.

**Note on `this.getShared` / `this.setShared`**: the exemplar pattern above uses `typeof this.getShared === 'function'` as a cross-version guard. These methods are declared on `IThread` (`flow-sdk/src/types/thread.ts:317-320`), not on `IStep` (commented out at `flow-sdk/src/types/step.ts:134-137`). New code should prefer `this.thread.getShared(...)` explicitly (§18.1) — but the `typeof`-guarded `this.getShared(...)` form is what the Edison runtime currently exposes via its service proxy, and it is still the correct form for shared-credential caching inside auth resolution.

**Validator**: `AUTH_NO_KV_RESOLUTION`, `AUTH_PLAIN_TEXT_INPUT`. **Patcher**: `AUTH_NO_KV_RESOLUTION`.

### Rule 11.2 — Pass the FULL auth id to `storage.get`, including `::token::<label>` suffix

**DO**:
```javascript
const authId = '6fd21caf-4b5f-4281-9b65-8d18651e2755::token::Anthropic Key';
const creds = await storage.get('__authorization_service_Anthropic', authId);
```

**DON'T**:
```javascript
const authId = '6fd21caf-4b5f-4281-9b65-8d18651e2755';  // missing suffix
// or:
if (authId.includes('::')) authId = authId.split('::')[0];  // stripping breaks lookup
```

**Why**: The vault stores credentials under the full string key. Stripping the suffix → `storage.get` returns null → "Anthropic API key required" error. This is the exact bug that cost the E2E #11-#13 runs several hours to diagnose.

**Patcher**: `AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX`.

### Rule 11.3 — Support `this.data.apiKey` plain-text override (Priority 1)

Before auth-external-component resolution, check for a plain-text override. The pipeline orchestrator passes this in the body when running autonomously.

```javascript
const explicitKey = this.data.apiKey;
if (typeof explicitKey === 'string') {
  const cleaned = explicitKey.replace(/^`|`$/g, '').trim();
  if (cleaned && cleaned !== 'undefined' && cleaned !== 'null') return cleaned;
}
// ... fall through to auth-external-component
```

This makes the step testable autonomously without configuring a vault credential.

### Rule 11.4 — `data.auth` on the step instance must be the full object, not a string

When splicing, preserve or reconstruct the rich `data.auth` object:
```json
{
  "auth": "6fd21caf-...::token::Anthropic Key",
  "authData": { "authType": "token", "keyValueCollection": "__authorization_service_Anthropic" },
  "authSelected": "6fd21caf-...::token::Anthropic Key",
  "keyValueCollection": "__authorization_service_Anthropic"
}
```

**Why**: Edison Studio writes this object when a user picks a credential. Splice that strips it to `""` breaks runtime resolution even though `stepInputData.auth` has the credential. See `lib/localSplice.js` for reconstruction logic.

---

## 12. Error Handling

### Rule 12.1 — Wrap `runStep()` in try/catch

**DO**:
```javascript
async runStep() {
  try {
    const { input } = this.data;
    if (!input) {
      throw Object.assign(new Error('input is required'), { code: 'MISSING_INPUT' });
    }
    const result = await doWork(input);
    return this.exitStep('next', { result });
  } catch (err) {
    this.log.error('runStep failed', { error: err.message, code: err.code });
    if (this.data.processError) return this.exitStep('__error__', { code: err.code || 'STEP_ERROR', message: err.message });
    throw err;  // let the flow-level error handler process it
  }
}
```

### Rule 12.2 — Throw `Object.assign(new Error(msg), { code })`, not plain Error

**DO**:
```javascript
throw Object.assign(new Error('rate limit exceeded'), { code: 'RATE_LIMIT' });
```

**DON'T**:
```javascript
throw new Error('rate limit exceeded');   // no structured code
throw 'rate limit exceeded';              // not an Error object
```

**Why**: Catch blocks and the flow-level error handler key off `err.code`. Plain Error loses the category and forces fragile string-matching on `err.message`. **Validator**: `THROW_ERROR_OBJECT`.

### Rule 12.3 — Never `eval`, `new Function`, or silent catches

**DON'T**:
```javascript
eval(userInput);                    // NO_EVAL — security + sandbox escape
new Function(userInput);            // NO_NEW_FUNCTION
try { ... } catch {}                // NO_EMPTY_CATCH — swallows errors
```

**Why**: `eval`/`new Function` bypass the runtime's code-signing + security. Empty catches hide bugs. **Validator**: `NO_EVAL`, `NO_NEW_FUNCTION`, `NO_EMPTY_CATCH`.

### Rule 12.4 — Prompt-injection sanitization for LLM inputs

When concatenating user-supplied content into an LLM prompt:
```javascript
const clean = String(userText).slice(0, 4000)         // cap length
  .replace(/^(system|user|assistant)\s*:/gmi, '[role]:')  // strip role-override
  .replace(/\r?\n/g, '\n');
const prompt = `<user_content>\n${clean}\n</user_content>\n\nAnalyze the content.`;
```

XML-tag-wrap untrusted content so the LLM treats it as data. **Validator**: planned `UNSANITIZED_LLM_INPUT` rule.

---

## 13. DataOut & Merge Field Output

### Rule 13.1 — Declare `dataOut` in step.json

```json
{
  "data": {
    "dataOut": {
      "name": "weatherAnomaly",
      "type": "session",
      "ttl": 86400000
    }
  }
}
```

- **`name`**: the variable name downstream steps reference via merge fields
- **`type`**: `"session"` (5-min default), `"thread"` (thread-scoped), `"shared"` (cross-session TTL), `"global"` (cross-bot TTL)
- **`ttl`**: milliseconds (86400000 = 24 hours)

### Rule 13.2 — Keep dataOut payloads small (<1MB)

Store large blobs in S3/KV and return a reference, not the blob itself. Merge fields flow through Lambda event payloads which have size caps.

### Rule 13.3 — `outputExample` in step.json matches the actual dataOut shape

```json
{
  "outputExample": {
    "isAnomaly": false,
    "severity": "none",
    "score": 0.12,
    "summary": "Temperature within seasonal norms"
  }
}
```

**Why**: The canvas uses `outputExample` to populate merge-field autocomplete for downstream steps. Wrong example = flow authors wire the wrong fields.

**Validator**: `OUTPUT_EXAMPLE_MISSING`, `DATAOUT_MISMATCH`.

---

## 14. Reusability (the non-negotiable)

### Rule 14.1 — Every step works in ANY flow

The step must have no implicit dependencies on what came before it in the flow. Specifically:

- **DO** read everything from `this.data.<input>` (declared in formBuilder)
- **DON'T** reference other steps by name: `this.mergeFields['weatherStep']`
- **DON'T** assume what's upstream: "the HTTP call step put X in path Y"
- **DON'T** use `process.env` for configuration
- **DON'T** use error codes tied to one domain: `WEATHER_API_DOWN` → generic `API_FAILURE`

### Rule 14.2 — Tests populate `this.data` only, no merge-field mocking

Test scenarios pass inputs through the step's `input` field. If the test needs to mock `mergeFields`, the step is coupled — refactor until tests only need `this.data`.

### Rule 14.3 — Reusability judge runs as final gate

`lib/reusability-judge.js` runs multi-perspective evaluation on every generated step. Work that fails is refined. See the judge module for the actual criteria.

---

## 15. Special Patterns

### 15.1 — Gateway steps (`isGatewayStep: true`)

Gateway steps are the flow's HTTP entry point, created by the `configure-gateway` step. `isGatewayStep: true` lives on the **template** (`IStepTemplate`, `flow-sdk/src/types/step.ts:29`), not on the step data.

- They still extend `Step` and still implement `runStep`. The compiler's `require`-rewriting (§1.1) applies to them identically — there is no legacy-only import exception.
- Inbound-event handling uses `this.triggers.on(eventName, cb)` and friends (§15.6); `runStep` runs once per incoming event to decide routing.
- Gateway-specific settings live on the step data: `httpPath`, `httpMethods`, `oneLegForAllSelectedMethods`, `isMultiPath`, `multiPaths`, `useAuth`, `tokenTable`, `isRequestBody`.
- `this.fork` is **not** on `Step`. Forking is `this.thread.fork(state?, { session, timeout })` (`flow-sdk/src/types/thread.ts:356`), and most flows drive it declaratively via `isNewThread: true` on an exit (§15.2) rather than imperatively from code.

### 15.2 — Thread forking via `isNewThread`

```json
{ "exits": [{ "id": "worker", "label": "fork", "isNewThread": true }] }
```

When the step exits via a leg marked `isNewThread: true`, the runtime starts a new thread at the connected step. Used for parallel processing (e.g., process each calendar event in its own thread). No `this.fork(...)` call is needed — the routing is purely declarative.

### 15.3 — State machines across invocations (`this.state.name`)

`this.state` is a live getter/setter for `this.thread.state` (`flow-sdk/src/step.ts:135-141`). The critical field is `state.name` — the runtime uses it to **select which class method to run next** (`step.ts:168`: `stepLogic = this[state.name] ?? this.runStep`).

Define alternate entry methods on the class and jump between them by writing `this.state.name`:

```javascript
async runStep() {
  this.state.name = 'awaiting_confirm';
  return this.exitStep('prompt', { question: 'Continue?' });
}

async awaiting_confirm(event) {
  if (event?.params?.confirmed) return this.exitStep('confirmed', { value: event.params.value });
  return this.exitStep('cancelled', {});
}
```

Other `BaseThreadState` fields available: `phase`, `step`, `ended`, `ending`, `waits`, `current`, `result` (`flow-sdk/src/types/thread.ts:118-129`).

### 15.4 — `this.get` / `this.set` are merge-field APIs, not a raw KV

`this.get(key, default?)` / `this.set(key, value)` / `this.unset(key)` / `this.getset(key, valueOrFn)` / `this.getMergeField(key)` delegate to `this.thread` and resolve based on the **merge-field type** declared on the key (`thread` / `session` / `shared` / `global` — `flow-sdk/src/types/mergeFields.ts:3`). The key can be a string, a `string[]` path, or a full `IMergeField` object.

```javascript
// Session-scoped snapshot (the default merge-field type when a string is passed)
const snap = (await this.get('_calTrigger_' + this.id + '_snapshot')) || {};
snap.lastRun = Date.now();
await this.set('_calTrigger_' + this.id + '_snapshot', snap);
```

For raw cross-session/global storage, use `this.getShared` / `this.getGlobal` (§18.1) — those are thread-level APIs exposed on the step-runtime proxy.

Scope keys with a step-id prefix (`_calTrigger_${this.id}_...`) to avoid collisions across steps.

### 15.5 — Backtick-wrapped expressions everywhere

All `stepInputData` values, `data.defaultValue` fields, and async-module `$schema` writes are backtick-wrapped template literals. The compiler (`flow_compiler.js:490-499`) wraps each value as `await (<value>)` — unwrap with:

```javascript
const cleaned = String(value).replace(/^`|`$/g, '').trim();
```

### 15.6 — Triggers (timers, events, deadlines)

`this.triggers` (`flow-sdk/src/types/triggers.ts:51-80`) exposes:
- `this.triggers.timeout(ms, cb?)` — schedule a timeout callback. If the step declares `data.timeoutDuration` and no trigger is installed, `Step.runHandle` auto-installs one that throws `TimeoutError` (`step.ts:200-208`).
- `this.triggers.deadline(epochMs, cb?)` — absolute-time callback.
- `this.triggers.on(eventName, cb)` / `.once` / `.off` / `.local` / `.otherwise` / `.hook` — subscribe for channel or broadcast events.
- `this.triggers.hasTimeout()` / `.refreshTimeout(ms)` / `.refreshAll()` — inspect / manage.

`this.waits` is a read-only map of currently-registered triggers on this step.

### 15.7 — Thread hooks (`this.on` / `once` / `off`)

Step lifecycle hooks (`flow-sdk/src/step.ts:310-340`):

```javascript
async runStep() {
  this.on('end', 'onThreadEnd');     // register handler by method name
  this.once('error', this.reportErr); // or by function reference
  return this.exitStep('next', {});
}

async onThreadEnd({ action }) { this.log.info('thread ended', action); }
```

Handlers run in thread context via `thread.runHookStep`. Use for per-step observability without touching `runStep`. Hook names: `start`, `end`, `exit`, `error`, `step`, `goto`, `result`, `ended`, `ending`, `terminate`, `waitEnd`.

### 15.8 — Subflows (`callExit` / `callState`)

Subflows enter via `this.thread.callExit(exitLabelOrId, result?, returnState?)` or `this.thread.callState(state, result?, returnState?)` (`flow-sdk/src/types/thread.ts:376-377`). Return values bubble via the action stack; an `__error__` exit on the subflow is reachable from the caller (`thread.ts:2128-2135`). Typically generated by `insert-template` during splice; rarely written by hand.

**Return-value contract.** `callExit` enqueues `ACTION.call` with a `next: { name: ACTION.return, result: true, state: returnState }` frame on the stack (`flow-sdk/src/thread.ts:961-973`). When the subflow terminates via `this.exitFlow(result)`, `ACTION.exiting` copies `action.result` onto `this.result` (`thread.ts:1874-1881`); the runtime then notices the pending `return` frame, pops it, and sets `topAction.result = this.result` (`thread.ts:1890-1899`). Processing `ACTION.return` writes the subflow's result to the caller's **`this.state.result`** (`thread.ts:1809-1817`). `callExit` itself returns `void` — it is NOT awaitable, there is no promise, no callback, and no automatic merge into `this.data`. The caller reads `this.state.result` in its next `runStep` dispatch after return:

```javascript
// caller step
async runStep(event) {
  switch (this.state.name) {
    case 'onReturn': {
      const result = this.state.result;           // subflow's exitFlow() payload
      return this.exitStep('next', { result });
    }
    default:
      return this.thread.callExit('subflow', undefined, { name: 'onReturn' });
  }
}

// subflow terminal step
async runStep(event) {
  return this.exitFlow({ some: 'result' });        // lands in caller's this.state.result
}
```

DO NOT write `const r = await this.thread.callExit(...)` — `callExit` returns `void`. DO route the caller through a named `returnState` so its next dispatch can read `this.state.result`.

### 15.9 — `emitHttp` for outbound HTTP with platform auth

```javascript
const res = await this.thread.emitHttp('POST', '/some/internal/path', {
  body: { ... },
  headers: { 'content-type': 'application/json' },
  queryParams: { foo: 'bar' },
  timeout: 30000,
  resolveWithFullResponse: true,  // returns { code, headers, body }
});
```

Edison-internal HTTP that carries session auth (`flow-sdk/src/thread.ts:1138`). Use for flow-to-flow or platform-service calls; use plain `fetch` for third-party APIs.

### 15.10 — Reporter events (custom observability)

`this.reporter` (`flow-sdk/src/step.ts:123`) is session-scoped. Emit custom events via `this.reporter.fire({ Event, EventCategory, Tags })`.

Step-level reporting shape (step.json):
```json
{
  "reporting": {
    "stepExited": { "enabled": true,  "tags": [{ "category": "Outcome", "label": "exit", "value": "`${exit.id}`" }] },
    "stepError":  { "enabled": true,  "tags": [] },
    "customEvent": { "enabled": false, "tags": [] }
  }
}
```

This compiles into `reportingEventEnabled(key)` + `reportingTags(key, ctx)` hooks on `step.data` (`flow-sdk/src/compiler/templates/flow/step.js.tpl:42-66`) that the reporter consults before firing. Set `enabled: false` on high-frequency events to suppress noise. **Validator**: `UNGUARDED_RUNTIME_API` for `this.reporter.*` without null guard.

**Why the guard is required.** In the real Edison runtime `this.reporter` is lazily constructed on first access and is never null (`flow-sdk/src/thread.ts:545-547`; `Step.reporter` proxies through at `flow-sdk/src/step.ts:123-125`). The guard requirement is driven by **alternate runtimes** where the accessor may be stubbed or absent: the local step harness provides a minimal `{ fire(){}, write(){} }` stub (`lib/localStepRuntime.js:510-513`), and subflow / gateway early-init paths may not have initialized the thread service proxy yet. The validator (`lib/stepValidator.js:400-425`) enforces a guard so step code stays portable across these contexts. Same applies to `this.session.*`. Note: the canonical SDK method is `this.reporter.addEvent(...)` (`flow-sdk/src/types/reporter.ts:107`) or the `this.report(...)` shortcut (`flow-sdk/src/thread.ts:1387-1389`); `.fire(...)` is a local-harness convenience, not a real `IReporter` method.

```javascript
// DON'T — crashes in local harness / alt runtime if accessor is absent
this.reporter.addEvent({ Event: 'Tag', Tags: [...] });

// DO — optional-chain or explicit guard
this.reporter?.addEvent({ Event: 'Tag', Tags: [...] });
if (this.reporter) this.reporter.addEvent({ Event: 'Tag', Tags: [...] });
```

### 15.11 — Thread Model

Flows run as one or more **threads** over a persistent **session**. Most step code lives in a single linear thread and never has to reason about this model. When it does — forking for parallel work, caching credentials, coordinating via emitted events, installing triggers — the runtime's concurrency and persistence rules become load-bearing. This section defines what is *simulable locally* (and by which method), what the runtime actually exposes on `this` vs `this.thread`, and where generated code must defer to platform-team confirmation rather than guess.

The local runtime mock (`lib/localStepRuntime.js`) throws on a specific set of `this.*` methods: `this.triggers.on` / `.once` / `.off` / `.local` / `.hook` / `.otherwise` / `.timeout` / `.deadline` (`localStepRuntime.js:381-391`), `this.thread.fork` (`:366`), `this.thread.emit` / `.emitSync` / `.emitAsync` / `.emitQueue` / `.emitMultiple` / `.emitHttp` / `.waitBroadcast` (`:356-365`). **Those throws are not arbitrary.** Each corresponds to a runtime contract that has no in-process fidelity — no event bus, no session-wide thread registry, no Lambda invocation boundary — and where a silent stub would produce false-green scenarios. This section documents each throw and what question to ask the platform team if generated code needs it anyway.

#### 15.11.1 — Merge-field scopes

Four scopes coexist. The scope a write targets is determined by the **method** called, not by the key:

- **Global** — cross-bot, same-account (`flow-sdk/src/types/thread.ts:317-320`, §18.1). Written via `this.thread.setGlobal(name, value, ttlMs?)` (also `this.setGlobal(...)` via the runtime proxy). Persists until TTL expires; any step in any flow on the same account can read it. No access control beyond the account boundary. Use only for feature flags and account-wide config; the write fan-out makes this unsuitable for per-user state.
- **Session** — cross-thread, single session. The default scope for merge-field keys that have no explicit `type` (§15.4). Readable/writable from any thread in the session; persists for the session lifetime (default 5 min, configurable via `ISessionTimeout.session`). Carried across forks **yes** — a forked thread reads the same session store.
- **Thread** — per thread. Lives in `thread.local.data[path]`. Scope boundary is the thread id; a sibling or child thread reading the same key name without an explicit `thread: '<other-id>'` merge-field spec gets **its own** value. Fork behavior: see §15.11.3.
- **Step-local** — the `const { x } = this.data;` view inside `runStep`, plus any normal closure variables. Not visible to any other step, fork, or thread. No persistence. Re-derived from `this.data` + merge-field resolution every time the step runs.

API mapping (columns name the scope the API actually touches):

| Call | Scope | Backed by | Cross-fork visible? |
|---|---|---|---|
| `this.set(key, v)` / `this.get(key)` | **depends on key's merge-field type** (session default) | `thread.mergeFields` proxy | session: yes; thread: no (parent's thread-local is not the fork's thread-local) |
| `this.thread.set(...)` / `this.thread.get(...)` | same as above | same | same |
| `this.setShared(k, v)` / `this.getShared(k)` | **shared** (cross-session, same `beginningSessionId`) | Edison runtime proxy — declared on `IThread`, typeof-guarded on `Step` (§11.1) | N/A — survives the thread's death entirely |
| `this.setGlobal(k, v)` / `this.getGlobal(k)` | **global** (cross-bot, same account) | `IThread.setGlobal` (`thread.ts:317-320`) | N/A |
| `this.thread.setShared/Global(...)` | same as above | same | same |
| `mergeFields[X].get` | scope declared on the merge-field definition | `MergeFields.get` → lodash-get on session/thread/shared/global store | depends on `type` declared on `IMergeField` |
| `this.data.X` | **step-local** (read-only view of resolved inputs) | hydrated once at step start from `resolveDataIn` | N/A |

The `mergeFields[X].get` row is for completeness — library code must not do this (§3.1, validator `STEP_LOGIC_HARDCODED_MERGE_REF`). Listed here only because some generated code attempts it and needs to be redirected to `this.data`.

The local runtime (`localStepRuntime.js:458-501`) backs `this.get` / `this.set` with a flat in-memory map that does not respect scope — it treats every string key as session-scoped. For scenarios that depend on thread-scope isolation between forks, the local runtime cannot simulate the behavior; run the scenario against a spliced flow.

#### 15.11.2 — Trigger lifecycle

`this.triggers.*` (§15.6) is the step-level subscribe surface. Key methods and persistence:

```javascript
this.triggers.on('userMessage', this.handle);       // persisted in session, fires many times
this.triggers.once('confirm', this.handle);         // persisted, removed after first fire
this.triggers.local('internal', this.handle);       // thread-local only, not persisted
this.triggers.timeout(30_000, this.handle);         // relative, step-scoped
this.triggers.deadline(Date.now() + 60_000, fn);    // absolute, step-scoped
this.triggers.hook({ name: 'end', thread: 'w-1' }, fn);  // watch another thread's lifecycle
```

**Registration vs fire.** Registration happens when `runStep` returns. Between the `this.triggers.on(...)` call and the `exitStep`/end of `runStep`, the trigger is staged on `this.waits` but not yet live in the session (`flow-sdk/src/step.ts:200-208` registers on `runHandle`, which fires *after* `runStep`). Consequence: you cannot fire an event to yourself from inside the same `runStep` and have it caught by your own trigger — the trigger doesn't exist yet. Use `.local` only for cross-step-within-a-thread coordination, not self-coordination.

**Persistence.** Session-persisted triggers (`on`, `once`, `hook`) survive:
- Lambda cold-start (written to Redis at session-save).
- Warm-start between events (re-read from Redis on session-start).

What they **do not** survive is still **Unknown — needs platform-team confirmation**:
- A flow redeploy that changes the step's id. If the step that owns the trigger no longer exists under the same id, the trigger still sits in the session but fires into a step that's not there. Confirm: does session-load reap orphan triggers, or do they sit until TTL?
- Account-wide platform upgrades where the Event Manager's SQS trigger table is rebuilt.

**De-registration** is automatic for `once`; for `on`, the trigger survives until the step exits while the thread is still suspended on it, or until the session ends. Explicit removal: `this.triggers.off(name)`.

**Canonical gateway example.** A `calendar-trigger`-style gateway step was **not found** in the `library/` directory on inspection (no match for `calendar-trigger` or `this.triggers.on` in `/Users/richardwilson/podscan/knowledge-twin/library`). §15.1 cites `library/steps/calendar/calendar-trigger/logic.js` but that file does not exist in this tree. The cited snippet is consistent with the TypeScript types (`flow-sdk/src/types/triggers.ts:51-80`) but we have no runnable exemplar. **Unknown — needs a seeded copy of the calendar step (or equivalent gateway exemplar) for cross-reference.**

Local runtime status: all `this.triggers.*` methods except `hasTimeout` and `refreshAll` throw `'not supported in local runtime'` (`localStepRuntime.js:381-398`). Scenarios that depend on trigger-based waiting cannot be simulated locally — splice and run against a real session.

#### 15.11.3 — Fork semantics

Two imperative forms exist and have been conflated in external docs:

- **`this.thread.fork(state?, { session, timeout })`** — cited in §15.1 as the canonical imperative fork (`flow-sdk/src/types/thread.ts:356`). Local runtime throws (`localStepRuntime.js:366`).
- **`this.thread.runThread({ id, background, state })`** — cited in `flow-builder-reference §5.5, §16.3` as the imperative fork form. Not mentioned in this doc; the local runtime does not stub it (so it also throws, via undefined-property access).

Whether these are two names for the same primitive, two distinct primitives with different semantics (e.g. `fork` for sibling threads vs `runThread` for supervised background threads), or one is a legacy alias, is **Unknown — needs platform-team confirmation**. Ask whether `IThread.fork` and `IThread.runThread` are separate methods, and if so, which is preferred for (a) parallel batch processing, (b) long-running background work the main thread should wait on.

**`this.fork(name, payload)`** — not on `Step` (§15.1 is explicit), not on `IThread`. Local runtime throws. Do not emit.

**The declarative alternative is load-bearing.** The preferred form in generated flows is an exit with `isNewThread: true` (§15.2). When the step calls `exitStep('<fork-exit-id>', payload)` and the exit is marked `isNewThread: true`, the runtime starts a new thread at the connected step. No imperative API call needed. This is what library flows actually use.

**Does a fork start a new thread immediately, or queue a message?** **Unknown — needs platform-team confirmation.** The reference describes forks as an action type on the thread action queue (`fork`), which suggests queue semantics. That squares with `Process.handle` but is not independently cited. Ask whether a fork exit's downstream step begins executing within the same Lambda invocation that owns the parent step, or on a separate invocation routed via SQS.

**Inheritance.** What the forked thread inherits:
- **Session merge fields** — yes. Same `session.mergeFields` view. No copy.
- **Shared fields** (`setShared` values) — yes. Shared storage is keyed by `beginningSessionId`, invariant across forks.
- **Global fields** — yes (account-wide).
- **Thread-local data** — **no**. `thread.local.data` is per-thread-id. A forked thread gets a fresh `local` map.
- **Auth** — meaning the `shared_${collection}` credential cache set by a previous step: yes, because it's in shared storage (§15.11.5).
- **Merge-field definitions visible to the parent** — yes, flow-static (defined on step templates), not thread-dynamic.
- **Active triggers** — **no**. Triggers are per-thread. The forked thread inherits no subscriptions and must install its own.
- **`state.name`** — **Unknown — needs platform-team confirmation.** When a fork's destination step runs, does it start at fresh-thread default (`state.name === undefined` → `runStep`) or at some carried-over state? Ask whether `this.thread.fork(state, opts)` passes `state` as initial `IThreadState`, and if so whether it can include `state.name` to jump directly to a class method (§15.3).

**How does a forked thread end?** Same termination rules as any thread:
1. The thread explicitly calls `this.end(result?)` or `this.exitFlow(result?)`.
2. The step exits and no downstream step is connected — the thread auto-ends.
3. Session timeout fires.

A forked thread with `background: true` does not block session-end on the main thread's completion. This is the async fire-and-forget pattern. Non-background forks **do** block session-save until they end or reach a suspended-on-trigger state. Whether the main thread blocks on a non-background fork's completion specifically (vs just the session as a whole) is **Unknown — needs platform-team confirmation**.

**Can forks rejoin?** No. There is no join primitive. The nearest facsimile is `this.thread.waitThread(threadId, onExit)` — the parent installs a callback that fires on the child's `end` action — but that's a hook, not a join. The parent does not block; the callback runs when the fork completes. A parent that needs to proceed only after a child finishes must either install `waitThread` and perform its post-work in the callback, or use `this.triggers.hook({ name: 'end', thread: '<child-id>' }, fn)`.

#### 15.11.4 — `emit` / `emitQueue` / `emitHttp`

Three distinct delivery mechanisms, all thread-level (`flow-sdk/src/types/thread.ts:324-333`). All three throw in the local runtime (`localStepRuntime.js:356-364`); local scenarios that exercise them must be run against a spliced flow.

**`this.thread.emit(name, params?)`** — fire-and-forget onto the current thread's event queue. **Deferred**: the event does not fire during the current `runStep`; it fires after the step exits, during post-processing (see `library/steps/builder/step-validator/logic.js:874-884` — `DEFERRED_EMIT_IN_TRY` warning). Await does nothing; the step-validator flags `await this.emit(...)` as `EMIT_UNNECESSARY_AWAIT` (`logic.js:766-777`). Ordering: enqueue order within a single thread; no ordering guarantee across threads. Delivery: best-effort local dispatch — if no handler is subscribed when the event fires, it is discarded (or captured by `.otherwise`). Use for in-flow coordination where a downstream step or sibling thread installs a matching `this.triggers.on`.

**`this.thread.emitQueue(name, params?, timeout?)`** — route the event through the Event Manager's SQS queue, wait until the queue drains the message, then resolve. Delivery guarantee: at-least-once via SQS. Ordering: FIFO if the session has a session key (sessionful), otherwise standard SQS (no ordering). **Return value: void** — per `library/steps/builder/step-validator/logic.js:805-809`, assigning the result of `emitQueue` is an error (`EMIT_QUEUE_RESULT_UNUSED`). This contradicts `flow-builder-reference §12.5`'s `await this.emitQueue(...)` example, which the validator would flag. Use for cross-flow decoupling where delivery must survive a Lambda crash.

**`this.thread.emitHttp(method, path, options?)`** — Edison-internal HTTP that carries session auth (§15.9, `flow-sdk/src/thread.ts:1138`). Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD; the validator rejects anything else (`logic.js:791-802`, `EMIT_HTTP_INVALID_METHOD`). Targets the current account by default; pass `accountId` or `target` in options to cross accounts (`logic.js:841-850`, `EMIT_HTTP_NO_TARGET`). Return value: when `resolveWithFullResponse: true`, returns `{ code, headers, body }`; otherwise just the body. Use `emitHttp` **only** for flow-to-flow / platform-service calls — for third-party APIs use plain `fetch` since `emitHttp` carries Edison auth that third parties won't accept.

Related async-emit variants (`emitSync`, `emitAsync`, `emitMultiple*`) are documented in §18.2. All must be awaited (`EMIT_MISSING_AWAIT`, `logic.js:748-763`); `emit` and `emitMultiple` are the only two deferred forms that do not take await.

#### 15.11.5 — Shared state (auth-inheritance)

The canonical auth-inheritance pattern appears across ~25 library steps. Representative:

```javascript
// library/steps/flows/template-finder/logic.js:916-921
const COLLECTION = '__authorization_service_Anthropic';
if (auth === 'inherited') {
  if (typeof this.getShared === 'function') auth = await this.getShared(`shared_${COLLECTION}`);
  if (!auth || auth === 'inherited') return null;
} else if (typeof this.setShared === 'function') {
  await this.setShared(`shared_${COLLECTION}`, auth);
}
```

Also in `library/steps/builder/generate-help/logic.js:154-163`, `library/steps/builder/improve-template/logic.js:113-119`, `library/steps/builder/run-pipeline/logic.js:351-358`, `library/steps/meetings/summarize-transcript/logic.js:117-122`, `library/steps/eval/evaluate-output/logic.js:518-523`, and generated by `lib/authTemplate.js:528-572`.

**Q: When Step A sets a credential and Step B has `auth: 'inherited'`, what propagates?** Step A writes the credential ID (the vault key, not the secret) to `shared_${COLLECTION}` via `this.setShared`. Step B, seeing `auth === 'inherited'`, reads `shared_${COLLECTION}` via `this.getShared` and uses that ID to call `storage.get(COLLECTION, authId)`. What propagates is the **credential reference**, not the secret itself — the secret is always resolved fresh via `or-sdk/storage` (§11.1).

**Q: Does `this.setShared` on A make it visible to B in the same thread?** Yes. Shared storage is indexed by `beginningSessionId`, invariant within a session and carried into forks.

**Q: In a forked thread?** Yes, by the same reasoning.

**Q: In a parallel session?** **No, unless the sessions share `beginningSessionId`.** Shared scope is cross-session only when sessions chain via `beginningSessionId` (the first session's id, propagated through session-restart). A separate Lambda invocation that starts its own session and is not linked to the first gets a different `beginningSessionId` and a disjoint shared store. For account-wide sharing use `global` instead.

**Q: Is there a timing race (B runs before A sets)?** **Within a single thread, no** — steps run sequentially. A's `setShared` await resolves before the thread advances to B. **Across threads, yes in principle**: if A and B are in parallel forks and A's `setShared` has not completed when B does `getShared`, B reads nothing or stale. Mitigation: run the credential-setting step in the parent thread *before* the fork, so every fork inherits a populated shared store. The library steps cited above follow this pattern.

Whether `setShared` flushes to Redis synchronously or buffers until session-save is **Unknown — needs platform-team confirmation**. If it buffers, a sibling thread reading between the write and the flush sees nothing. Ask whether `setShared` performs an immediate Redis write or stages into `session.data.shared` for write-back at session-save. If the latter, parallel forks of a single session cannot observe one another's `setShared` until after a session-save/session-load cycle.

**Q: Is the `shared_${collection}` naming convention enforced by SDK or by convention only?** **By convention only.** No SDK code rejects a `setShared` call with an arbitrary key. The validator (`library/steps/builder/step-validator/logic.js:2430-2437`) warns `AUTH_MISSING_INHERITANCE` when a step has an auth-external-component but the logic doesn't show the pattern; the suggestion text quotes the `shared_${collection}` form verbatim. The authTemplate generator (`lib/authTemplate.js:546-557`) emits the same literal. Platform-wide naming discipline — if a step writes to `shared_${myOwnKey}` it will not collide with auth, but no other step will find its credentials.

#### 15.11.6 — Knowledge gaps and TODOs

Claims in this section that could not be verified against this codebase or the `flow-sdk` types in hand:

- Whether `IThread.fork` and `IThread.runThread` are the same method or two distinct primitives. Both throw in the local runtime. **Ask**: canonical imperative-fork API, and whether `runThread` is a synonym, legacy alias, or a different mechanism (supervised background thread vs sibling thread).
- Whether a fork exit starts the new thread synchronously within the current Lambda invocation or routes via SQS to a separate invocation. **Ask**: is a fork's first step guaranteed to start in the same Lambda execution as the parent's `exitStep`?
- Whether `this.thread.fork(state, opts)` passes an initial `state.name` to jump directly to a class method (§15.3) on the forked thread. **Ask**: can a fork be targeted at a specific class method via state?
- Whether session-persisted triggers (`on`, `once`) survive a flow redeploy that changes step ids. **Ask**: orphan triggers after redeploy — dropped at session-load, silently retained until TTL, or migrated?
- Whether `setShared` writes synchronously to Redis or buffers until session-save. Determines whether parallel forks of one session can observe one another's shared writes mid-invocation. **Ask**: immediate Redis write, or `session.data.shared` with write-back at session-save?
- Whether a non-background fork blocks the **main thread's** continuation (vs just the session's end). **Ask**: does a non-background fork prevent the main thread from returning after its own `exitStep`, or only prevent the Lambda/session from terminating?
- Whether `this.waits` reflects locally-staged triggers during `runStep` or only post-registration triggers. **Ask**: is `this.waits` mutated inline by `this.triggers.on(...)`, or only populated after `runHandle`?
- Whether `emitQueue` resolves its promise with a meaningful value or always with `undefined`. `flow-builder-reference §12.5` shows `await this.emitQueue(...)`; the step-validator flags assigning its result as an error. **Ask**: fire-and-forget (promise-for-throttling-only, resolves to void), or does it return a payload?
- Whether the `calendar-trigger` step (cited in §15.1 and elsewhere as the canonical gateway-with-triggers example) is intended to be seeded into this tree. The file `library/steps/calendar/calendar-trigger/logic.js` does not exist in this repo. **Ask**: is there an exemplar gateway-with-triggers step to seed for cross-reference?
- Whether `local_${threadId}_shared_${collection}` or similar prefixing is used anywhere to defeat the cross-fork propagation of auth credentials when isolation is wanted. **Ask**: is there ever a reason for a step to scope its auth to its own thread-id, and if so, what naming convention?

---

## 16. Validator Rules Index

The following validator rule IDs (from `lib/stepValidator.js`) map to platform-rules sections. When adding a new validator rule, cross-reference it here.

| Validator ID | Section | Severity |
|---|---|---|
| RAW_CODE_NO_STEP_CLASS | 1.1 | error |
| RAW_CODE_NO_EXITSTEP | 4 | error |
| RAW_CODE_NO_EXPORT | 1.3 | error |
| RAW_CODE_USES_PARAMS | 3.1 | error |
| NO_CONSOLE | 2.1 | warning |
| NO_VAR | — | warning |
| EQEQ | — | warning |
| NO_EVAL | 12.3 | error |
| NO_NEW_FUNCTION | 12.3 | warning |
| NO_EMPTY_CATCH | 12.3 | warning |
| THROW_ERROR_OBJECT | 12.2 | warning |
| STEP_LOGIC_HARDCODED_MERGE_REF | 3.1 | error |
| STEP_LOGIC_READS_API_INPUT | 3.1 | error |
| HARDCODED_URL | 3.2 | error |
| HARDCODED_MODEL | 3.2 | error |
| HARDCODED_COLLECTION | 3.2 | error |
| HARDCODED_THRESHOLD | 3.2 | error |
| SECRET_IN_CODE | 12.4 | error |
| ASYNC_NO_AWAIT | — | warning |
| EXITSTEP_NO_RETURN | 4.1 | error |
| EXIT_NOT_DEFINED | 4.5 | error |
| ERROR_EXIT_CALLED_BUT_DISABLED | 4.2 | error |
| ERROR_EXIT_NOT_ENABLED | 4.2 | error |
| TIMEOUT_EXIT_NOT_ENABLED | 4.3 | error |
| AUTH_NO_KV_RESOLUTION | 11.1 | error |
| AUTH_PLAIN_TEXT_INPUT | 11.1 | error |
| FORM_INPUT_NO_MERGE_FIELDS | 5.2 | error |
| RENDER_CONDITION_BUILDER_MISSING | 5 | warning |
| TEMPLATE_NO_ICON | — | warning |
| TEMPLATE_CUSTOM_ICON_NO_URL | — | error |
| TEMPLATE_NO_HELP | 7.1 | warning |
| TEMPLATE_HELP_DUPLICATES_DESCRIPTION | 7.1 | warning |
| TEMPLATE_DESCRIPTION_TOO_LONG | 7.2 | warning |
| TEMPLATE_LABEL_TOO_LONG | 7.3 | error |
| OUTPUT_EXAMPLE_MISSING | 13.3 | warning |
| DATAOUT_MISMATCH | 13.3 | warning |
| ASYNC_MODULE_NO_URL | 6.1 | error |
| ASYNC_MODULE_TOJSON_DISABLED | 6.4 | error |
| ASYNC_MODULE_NO_PLUGIN_REFS | 6.1 | error |
| ASYNC_MODULE_VUE_BUNDLED | 6.3 | warning |
| ASYNC_MODULE_VALIDATORS_MISSING | 6.4 | error |
| TIMEOUT_EXIT_NO_DURATION | 4.3 | error |
| UNSANITIZED_LLM_INPUT | 12.4 | warning |
| UNGUARDED_RUNTIME_API | 15.10 | warning |
| NUMERIC_SEPARATOR | 10.4 | info |

**New rules to add (per plan, not yet implemented)**:
- `LIFECYCLE_LOG_FORMAT` — log message shape mismatch with 2.3
- `DEFAULT_VALUE_MISMATCH` — code fallback differs from spec's declared default
- `STEP_INPUT_DEFAULT_VALUE_NOT_BACKTICKED` — a stepInputData value is not backtick-wrapped (§5.3). Must fire before the compiler wraps values as `await (<value>)`.

Rules promoted from "new" to enforced in this revision (now in the table above): `ASYNC_MODULE_NO_PLUGIN_REFS`, `ASYNC_MODULE_VUE_BUNDLED`, `ASYNC_MODULE_VALIDATORS_MISSING`, `TIMEOUT_EXIT_NO_DURATION`, `UNSANITIZED_LLM_INPUT`, `UNGUARDED_RUNTIME_API`.

---

## 17. Known Issues Registry

`lib/known-issues.js` contains 37 documented defects. Each has `{id, detect, fix, rationale}`. The ones with auto-fixes are the "patcher" layer's deterministic rules.

Active patchers (see `lib/patcher.js` + `lib/templateShapePatcher.js`):

| Patcher ID | Fixes | Section |
|---|---|---|
| AUTH_RESOLVE_STRIPS_TOKEN_SUFFIX | ::token:: strip in `_resolveApiKey` | 11.2 |
| UNCONDITIONAL_ERROR_EXIT | Unguarded `exitStep('__error__')` | 4.2 |
| EQEQ | Loose equality → strict | validator-only |
| HARDCODED_URL | URL literal → this.data input | 3.2 |
| AUTH_NO_KV_RESOLUTION | Missing or-sdk/storage block | 11.1 |
| TEMPLATE_NO_ICON | Missing iconUrl + iconType:"custom" | — |
| ERROR_EXIT_NOT_ENABLED | Flip `processError: true` | 4.2 |
| TIMEOUT_EXIT_NOT_ENABLED | Flip `processTimeout: true` | 4.3 |
| TEMPLATE_DESCRIPTION_TOO_LONG | Truncate description | 7.2 |
| TEMPLATE_HELP_DUPLICATES_DESCRIPTION | Insert structured skeleton | 7.1 |

When you add a known issue, link to the rule section here. When the validator gets a new rule, add a row in §16 and (if mechanically fixable) an entry in this table.

---

## 18. Thread-Level APIs Accessible from Steps

These are not methods on `IStep`; they live on `IThread`. Reach them via `this.thread.*`. Some are also exposed on `this` directly by the Edison runtime's service proxy (notably the shared/global storage helpers) — library steps invoke them both ways. New code should prefer the explicit `this.thread.*` form.

### Rule 18.1 — Shared / global storage

```javascript
const cached = await this.thread.getShared('lastSeen');
await this.thread.setShared('lastSeen', Date.now(), 86400000);   // ttl in ms
const flag = await this.thread.getGlobal('featureX', false);
await this.thread.setGlobal('featureX', true);
```

- **Shared**: cross-session, same-account scope. Good for caching auth responses, provider tokens, per-user state across threads.
- **Global**: cross-bot, same-account scope. Rarely needed; suitable for feature flags and account-wide config.

See `flow-sdk/src/types/thread.ts:317-320`. For merge-field-typed access (where the type is declared on the key, not the method), use `this.get` / `this.set` (§15.4).

### Rule 18.2 — Events and broadcast

For step-to-step coordination within a thread or across threads:

| Method | When to use |
|---|---|
| `this.thread.emit(name, params?)` | Fire-and-forget event on this thread. |
| `this.thread.emitSync(name, params?, timeout?)` | Emit and await synchronous listeners. |
| `this.thread.emitAsync(name, params?, timeout?)` | Emit and await async listeners. |
| `this.thread.emitQueue(name, params?, timeout?)` | Queue under the event manager; resolves when drained. |
| `this.thread.emitMultiple(events[])` | Batch emit of heterogeneous events. |
| `this.thread.waitBroadcast(event, onEvent)` | Block until a broadcast matching `event` is observed. |

See `flow-sdk/src/types/thread.ts:324-333, 386`. Use step-level triggers (§15.6) for the subscriber side.

### Rule 18.3 — `emitHttp`

See §15.9. Edison-internal HTTP with session auth; prefer plain `fetch` for third-party APIs.

### Rule 18.4 — Flow-level navigation

These are on `Step` directly (they delegate to `thread`) — use them, not the lower-level thread primitives:

| API | Behavior |
|---|---|
| `this.end(result?)` | End the flow with a result. |
| `this.exitFlow(result?)` | Terminal exit; no more steps run. |
| `this.exitState(state, result?)` | Exit current state with a result, route to `state`. |
| `this.gotoState(state, nextAction?)` | Switch active state without exiting. |
| `this.exitStep(label, dataOut?)` | The normal per-step exit (§4). |

`result` may be an `Error` — the `_handleError` path routes it to `__error__` if declared (see §4.2).

**The three non-terminal variants are not interchangeable.** `exitStep` (`flow-sdk/src/thread.ts:1323-1339`) resolves the exit label to a new `state.step` — a sequential advance to the *next step* in the flow graph; state name/params are cleared. `gotoState` (`flow-sdk/src/thread.ts:1306-1312`) keeps the same `state.step` and rewrites `state.name`; the runtime then re-dispatches to `this[state.name]` on the same `Step` instance (`flow-sdk/src/step.ts:168-172`) — a method-dispatch jump within one step. `exitState` (`flow-sdk/src/thread.ts:1299-1301`) is `gotoState` followed by an `ACTION.exiting` tail-action that surfaces `result` to the current flow — it does NOT pop a subflow frame (that's `ACTION.return` on the stack, §15.8). In a state-machine step:

```javascript
async runStep(event) {
  return this.gotoState('state_foo');         // same step, dispatch this.state_foo next
}
async state_foo(event) {
  if (this.data.done) return this.exitState('done', { ok: true });  // surface result, leave state machine
  return this.exitStep('next', { value: 42 });                       // advance to the connected step
}
```

`exitStep` always returns `dataOut` synchronously (`flow-sdk/src/thread.ts:1338`) so legacy `return this.exitStep(...)` shape still works — but the routing is the enqueued action, not the return value.

### Rule 18.5 — Background tasks

```javascript
const { error } = await this.thread.task(
  fireAndForget().catch(e => e),
  /* throwError */ false
);
```

`this.thread.task(promise, throwError?)` (`flow-sdk/src/types/thread.ts:337`) runs a promise under thread supervision and returns `{ error }` on catch. Use for work that must complete before the thread ends but whose failure should not crash the run.

### Rule 18.6 — What `this.thread.*` is **not** for

Don't reach through `this.thread` to sidestep platform rules:
- ❌ `this.thread.mergeFields[...]` to get upstream data — still violates §3.1.
- ❌ `this.thread.getShared` to skip the auth-external-component flow — §11 still applies.
- ❌ `this.thread.exitStep(...)` to reach a non-declared exit — the exit list (§4.5) still gates routing.

---

## Appendix: DO/DON'T at a glance (for LLM prompt compression)

```
Module loading:       await import('@onereach/flow-sdk/step.js'); exports.step = Cls
                      require(...) is auto-rewritten by the compiler; prefer await import
Logging:              this.log has 7 levels: fatal/error/vital/warn/info/debug/trace
                      never console.*
Variables:            const { x } = this.data   —  never mergeFields[name], never process.env
Hardcoding:           forbidden for URLs, model names, IDs, collections, thresholds
Exits:                return this.exitStep('next' | '__error__' | '__timeout__', payload)
                      exit id MUST appear in data.exits[]   (processError/processTimeout
                      are builder-UI toggles that populate the exit list)
Error payload:        { code: 'CODE_NAME', message: 'human readable' }
Error throw:          Object.assign(new Error(msg), { code: 'CODE' })
Auth:                 full ::token::<label> id → storage.get(collection, id)
                      never strip the suffix
                      this.getShared exists on the step-runtime proxy; prefer this.thread.getShared in new code
Input:                formBuilder.stepInputs with allowMergeFields: true
                      stepInputData values backtick-wrapped: `value`
Async modules:        formAsyncModule + 2 pluginRefs + toJson + validators + renderConditionBuilder
                      Vue externalized via shims/vue.js; build single index.mjs
Help:                 ## Inputs / ## Output / ## Error handling — no duplicating description
Version:              semver, bumped on every change
NPM:                  declared in modules[], ^major version pinning (Node >=20, Edison Lambda 22.x)
State machines:       this.state.name selects the class method the runtime calls next
Thread APIs:          this.thread.{getShared,setShared,emitHttp,emit,task,fork,waitBroadcast}
                      this.fork / this.emit are NOT on Step
Reusability:          never reference other steps, never process.env, never step-specific error codes
```
