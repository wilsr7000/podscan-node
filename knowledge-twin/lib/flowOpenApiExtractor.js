// ---------------------------------------------------------------------------
// flowOpenApiExtractor.js — derive an OpenAPI 3.0 spec from a deployed
// Edison flow's step template + gateway path.
//
// Deterministic: no LLM, no network calls. Input is a template object and
// metadata; output is a JSON-serializable OpenAPI 3.0 document.
//
// This is Phase 2 of the behavioral-verification plan. The output feeds:
//   - Phase 3's test-playbook generator (LLM reads this spec + the source
//     playbook to produce behavioral scenarios)
//   - Human documentation for any deployed flow (drop into Swagger UI)
//   - Cross-referencing at runtime (did the response shape match declared
//     output?)
//
// Scope:
//   - ONE path per flow (the gateway path itself).
//   - POST = submit a job (sync or async-with-jobId).
//   - GET  = poll by jobId.
//   - Request body schema derived from formBuilder.stepInputs.
//   - Response schemas derived from outputExample + per-exit distinct shapes.
//   - Security requirements flagged when auth inputs are present.
//
// Out-of-scope for this module (handled elsewhere or later):
//   - Gateway-step orchestration flows (multi-path, thread forks).
//   - Subflow chaining.
//   - Authentication flow (token refresh, OAuth).
// ---------------------------------------------------------------------------

'use strict';

// ---------------------------------------------------------------------------
// Edison component → JSON Schema type mapping. Matches what the platform's
// runtime parses out of a POST body.
// ---------------------------------------------------------------------------
const COMPONENT_TYPE = {
  formTextInput: 'string',
  formTextBox: 'string',
  formTextArea: 'string',
  formTextarea: 'string',
  formNumber: 'number',
  formNumberInput: 'number',
  formSwitch: 'boolean',
  formCheckbox: 'boolean',
  formSelectExpression: 'string',
  formSelect: 'string',
  formRadio: 'string',
  formDate: 'string',  // date format added below
  formCode: 'string',
  formJson: 'object',  // json can be array or object; we pick object and note oneOf
  'auth-external-component': 'string',
};

// ---------------------------------------------------------------------------
// inputsToSchema — build a JSON Schema for the request body from a flow's
// formBuilder.stepInputs array.
//
// Auth inputs are NOT included in the body schema — they're modeled as
// security requirements. Every other input becomes a property.
// ---------------------------------------------------------------------------
function inputsToSchema(stepInputs = []) {
  const properties = {};
  const required = [];
  const authVars = [];

  for (const inp of stepInputs) {
    if (!inp || typeof inp !== 'object') continue;
    const d = inp.data || {};
    const variable = d.variable;
    if (!variable) continue;  // input without a variable is a formDataOut / wildcard
    const comp = Array.isArray(inp.component) ? inp.component[0] : (inp.component || 'formTextInput');

    if (comp === 'auth-external-component') {
      authVars.push(variable);
      continue;
    }

    const type = COMPONENT_TYPE[comp] || 'string';
    const prop = { type, description: (d.helpText || d.label || variable).toString().slice(0, 500) };

    // Format hints
    if (comp === 'formDate') prop.format = 'date-time';
    if (comp === 'formJson') delete prop.type;  // allow any JSON value; use oneOf below

    if (comp === 'formJson') {
      prop.oneOf = [{ type: 'object' }, { type: 'array' }];
    }

    // Enum (select/radio)
    if (Array.isArray(d.options) && d.options.length > 0) {
      const enumValues = d.options
        .map((o) => (typeof o === 'object' ? (o.value ?? o.label) : o))
        .filter((v) => v !== undefined && v !== null);
      if (enumValues.length > 0) prop.enum = enumValues;
    }

    // Default (Edison stores backtick-wrapped; strip for clean schema output)
    if (d.defaultValue !== undefined && d.defaultValue !== null && d.defaultValue !== '') {
      let dv = d.defaultValue;
      if (typeof dv === 'string') dv = dv.replace(/^`|`$/g, '').trim();
      if (dv !== '') {
        // Try to coerce to declared type for cleaner schema
        if (type === 'number') {
          const n = Number(dv);
          if (Number.isFinite(n)) prop.default = n;
        } else if (type === 'boolean') {
          prop.default = dv === 'true' || dv === true;
        } else {
          prop.default = dv;
        }
      }
    }

    // Example (optional helper for Swagger UI)
    if (d.example !== undefined && d.example !== null && d.example !== '') {
      prop.example = d.example;
    } else if (prop.default !== undefined) {
      prop.example = prop.default;
    }

    properties[variable] = prop;
    if (d.validateRequired === true) required.push(variable);
  }

  const schema = {
    type: 'object',
    properties,
  };
  if (required.length > 0) schema.required = required;
  return { schema, authVars };
}

// ---------------------------------------------------------------------------
// inferSchemaFromValue — best-effort JSON-schema inference from a JS value.
// Used for outputExample: look at what's there and describe it.
// ---------------------------------------------------------------------------
function inferSchemaFromValue(val, { depth = 0, maxDepth = 4 } = {}) {
  if (val === null) return { type: 'null' };
  if (val === undefined) return { type: 'object', nullable: true };
  if (Array.isArray(val)) {
    if (val.length === 0) return { type: 'array', items: {} };
    // Use the first element to infer item schema (could be smarter — union —
    // but an example array is usually homogeneous).
    return { type: 'array', items: inferSchemaFromValue(val[0], { depth: depth + 1, maxDepth }) };
  }
  const t = typeof val;
  if (t === 'string') return { type: 'string', example: val.length > 80 ? val.slice(0, 77) + '...' : val };
  if (t === 'number') return { type: Number.isInteger(val) ? 'integer' : 'number', example: val };
  if (t === 'boolean') return { type: 'boolean', example: val };
  if (t === 'object' && depth < maxDepth) {
    const properties = {};
    for (const [k, v] of Object.entries(val)) {
      properties[k] = inferSchemaFromValue(v, { depth: depth + 1, maxDepth });
    }
    return { type: 'object', properties };
  }
  return { type: 'object' };
}

// ---------------------------------------------------------------------------
// exitsToResponseVariants — for each declared exit, produce a named response
// variant that describes what the flow returns when that exit fires.
//
// Edison's async protocol returns the exit's payload under a well-known
// key shape; for our purposes it's just the raw outputExample (extended
// with `code` when the exit is __error__-style).
// ---------------------------------------------------------------------------
function exitsToResponseVariants(exits = [], outputExample) {
  const variants = {};
  for (const ex of exits) {
    if (!ex || !ex.id) continue;
    const isError = ex.id === '__error__' || ex.id === 'error' || ex.condition === 'processError';
    const isTimeout = ex.id === '__timeout__' || ex.condition === 'processTimeout';
    const tag = isError ? 'error' : isTimeout ? 'timeout' : 'success';
    const name = ex.id.replace(/^__|__$/g, '') || 'next';

    let schema;
    if (isError || isTimeout) {
      schema = {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Error code identifier (e.g. MISSING_INPUT, TIMEOUT)' },
          message: { type: 'string', description: 'Human-readable error message' },
        },
        required: ['code', 'message'],
      };
    } else {
      schema = outputExample ? inferSchemaFromValue(outputExample) : { type: 'object' };
    }
    variants[name] = {
      tag,
      exitId: ex.id,
      label: ex.label || name,
      condition: ex.condition || '',
      schema,
    };
  }
  return variants;
}

// ---------------------------------------------------------------------------
// buildOpenApi — main entry. Deterministic top-to-bottom.
//
// Input:
//   {
//     template,       // deployed step template (step.json + formBuilder + data + outputExample)
//     gatewayPath,    // e.g. 'gsx' or '/gsx' (leading slash normalized)
//     accountId?,     // OneReach account id for full URL; defaults to env
//     baseUrl?,       // full base; overrides accountId
//     flowId?,        // added to description + info block
//     flowLabel?,     // fallback label if template.label missing
//   }
//
// Output:
//   OpenAPI 3.0 document as a plain JS object. Safe to JSON.stringify.
// ---------------------------------------------------------------------------
function buildOpenApi(opts = {}) {
  const {
    template = {},
    gatewayPath = '',
    accountId = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29',
    baseUrl = null,
    flowId = null,
    flowLabel = null,
  } = opts;

  const pathStr = '/' + String(gatewayPath).replace(/^\//, '').replace(/\?.*$/, '');
  const resolvedBaseUrl = baseUrl || `https://em.edison.api.onereach.ai/http/${accountId}`;
  const label = template.label || flowLabel || 'Flow';
  const description = [
    template.description ? String(template.description).slice(0, 1000) : '',
    flowId ? `\n\n**Flow ID**: \`${flowId}\`` : '',
    template.version ? `\n**Version**: \`${template.version}\`` : '',
  ].filter(Boolean).join('');

  const { schema: requestBodySchema, authVars } = inputsToSchema(template.formBuilder?.stepInputs || []);
  const exitVariants = exitsToResponseVariants(template.data?.exits || [], template.outputExample);

  // Build the 200 POST response: sync shape (outputExample) OR async shape
  // (jobId wrapper). Edison flows can return either depending on whether
  // the flow completes synchronously.
  const postResponse200 = {
    description: 'Submission accepted. Either a jobId (async) or the final result (sync, rare).',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } } },
            ...Object.values(exitVariants).map((v) => v.schema),
          ],
        },
      },
    },
  };

  const getResponse200 = {
    description: 'Polling response. `status` ∈ pending/started/running while in flight; absent/success once the exit fires.',
    content: {
      'application/json': {
        schema: {
          oneOf: [
            { type: 'object', properties: { status: { type: 'string', enum: ['pending', 'started', 'running'] } } },
            ...Object.values(exitVariants).map((v) => v.schema),
          ],
        },
      },
    },
  };

  const security = authVars.length > 0 ? [{ ApiAuth: [] }] : [];
  const securitySchemes = authVars.length > 0 ? {
    ApiAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'x-edison-auth',
      description: `Edison auth credential reference. Required because the flow declares ${authVars.length} auth input(s) (${authVars.join(', ')}).`,
    },
  } : undefined;

  const doc = {
    openapi: '3.0.3',
    info: {
      title: label,
      version: template.version || '1.0.0',
      description: description || `Deployed Edison flow at ${pathStr}.`,
    },
    servers: [{ url: resolvedBaseUrl }],
    paths: {
      [pathStr]: {
        post: {
          summary: `Invoke ${label}`,
          description: `Submit a job to the flow. Returns either a jobId for async polling or the final result inline.`,
          operationId: (template.name || 'invoke').replace(/\s+/g, '_') + 'Invoke',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: requestBodySchema } },
          },
          responses: {
            200: postResponse200,
            400: { description: 'Invalid request body (missing required field, type mismatch).' },
            404: { description: 'Endpoint not live (flow not deployed or not activated).' },
            500: { description: 'Server error (Edison runtime unavailable).' },
          },
          ...(security.length > 0 ? { security } : {}),
        },
        get: {
          summary: `Poll ${label} job status`,
          description: `Retrieve the status or final result of an in-flight job by its jobId.`,
          operationId: (template.name || 'invoke').replace(/\s+/g, '_') + 'Poll',
          parameters: [
            { name: 'jobId', in: 'query', required: true, schema: { type: 'string' }, description: 'The jobId returned from POST.' },
            { name: 'jobID', in: 'query', required: false, schema: { type: 'string' }, description: 'Legacy alias of jobId — some runtime versions check this casing.' },
          ],
          responses: {
            200: getResponse200,
            404: { description: 'Unknown jobId.' },
          },
        },
      },
    },
    components: {
      schemas: Object.fromEntries(
        Object.entries(exitVariants).map(([name, v]) => [name, v.schema]),
      ),
      ...(securitySchemes ? { securitySchemes } : {}),
    },
  };

  // Edison-specific extensions — useful for the test-playbook generator to
  // cross-reference without re-parsing the raw template.
  doc['x-edison'] = {
    flowId,
    gatewayPath: pathStr,
    templateId: template.id,
    templateVersion: template.version,
    exits: Object.entries(exitVariants).map(([name, v]) => ({
      name,
      exitId: v.exitId,
      label: v.label,
      condition: v.condition,
      kind: v.tag,
    })),
    authRequired: authVars,
    harnessScenarioHints: buildScenarioHints(requestBodySchema, exitVariants, template),
  };

  return doc;
}

// ---------------------------------------------------------------------------
// buildScenarioHints — collect signals the test-playbook generator can use
// to propose scenarios without re-deriving them.
//
// Not part of the OpenAPI standard; under `x-edison.harnessScenarioHints`
// so tools can ignore it if they only consume the standard fields.
// ---------------------------------------------------------------------------
function buildScenarioHints(requestBodySchema, exitVariants, template) {
  const hints = {
    requiredFields: Array.isArray(requestBodySchema.required) ? [...requestBodySchema.required] : [],
    enumFields: [],
    numericRanges: [],
    defaultedFields: [],
    exitIds: Object.values(exitVariants).map((v) => v.exitId),
    behaviorCues: [],
  };

  for (const [name, prop] of Object.entries(requestBodySchema.properties || {})) {
    if (Array.isArray(prop.enum)) hints.enumFields.push({ name, values: prop.enum });
    if (prop.type === 'number' || prop.type === 'integer') {
      hints.numericRanges.push({ name, default: prop.default });
    }
    if (prop.default !== undefined) hints.defaultedFields.push({ name, default: prop.default });
  }

  // Scan description + outputExample for behavioral cues. If any of these
  // tokens appear in the schema's descriptions, the generator should probably
  // propose a behavioral assertion scenario.
  const behavioralKeywords = ['rewrite', 'transform', 'replace', 'diff', 'match', 'generate', 'summar', 'classify', 'extract', 'translate'];
  const haystack = (String(template.description || '') + ' ' + JSON.stringify(template.outputExample || {})).toLowerCase();
  for (const kw of behavioralKeywords) {
    if (haystack.includes(kw)) hints.behaviorCues.push(kw);
  }

  return hints;
}

module.exports = {
  buildOpenApi,
  inputsToSchema,
  inferSchemaFromValue,
  exitsToResponseVariants,
  buildScenarioHints,
  COMPONENT_TYPE,
};
