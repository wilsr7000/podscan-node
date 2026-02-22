#!/usr/bin/env node
// ---------------------------------------------------------------------------
// deploy-step.js — Build, validate, and deploy a step directory to Edison
//
// Usage:
//   node deploy-step.js steps/clicktime/create-task
//   node deploy-step.js steps/clicktime/create-task --force
//   node deploy-step.js steps/clicktime/create-task --dry-run
//   BOT_ID=xxx REFERENCE_FLOW_ID=yyy node deploy-step.js steps/clicktime/create-task
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Flows } = require('@or-sdk/flows');
const { buildStepTemplate } = require('./lib/stepBuilder');

const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
const DISCOVERY_URL = 'https://discovery.edison.api.onereach.ai';
const TOKEN_URL = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/refresh_token`;
const BOT_ID = process.env.BOT_ID || '8fdf773f-d3f5-4c90-ab36-b161e049f9c7';
const REFERENCE_FLOW_ID = process.env.REFERENCE_FLOW_ID || '5cc36867-bece-4fad-b2e9-983eab265f87';

const STEP_VALIDATOR_URL = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/step-validator`;
const FLOW_VALIDATOR_URL = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/validate-flow-v3`;

function uuid() { return crypto.randomUUID(); }

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function getToken() {
  let token = process.env.EDISON_TOKEN;
  if (token) return token.startsWith('FLOW ') ? token : `FLOW ${token}`;
  const resp = await fetch(TOKEN_URL);
  if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
  const data = await resp.json();
  token = data.token;
  return token.startsWith('FLOW ') ? token : `FLOW ${token}`;
}

// ---------------------------------------------------------------------------
// Step Validator API (deployed on Edison — async with polling)
// ---------------------------------------------------------------------------
async function validateStepViaAPI(template) {
  const resp = await fetch(STEP_VALIDATOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepJSON: JSON.stringify(template) }),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Step Validator POST failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const submission = await resp.json();

  if (!submission.jobId) return submission;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const poll = await fetch(`${STEP_VALIDATOR_URL}?jobId=${submission.jobId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!poll.ok) continue;
    const result = await poll.json();
    if (result.status === 'complete' || result.status === 'error') return result;
    process.stdout.write(`    Step validator poll ${i + 1}: ${result.status || 'processing'}...\r`);
  }
  throw new Error('Step Validator polling timed out');
}

// ---------------------------------------------------------------------------
// Flow Validator API (deployed on Edison)
// ---------------------------------------------------------------------------
async function validateFlowViaAPI(flowJSON) {
  const resp = await fetch(FLOW_VALIDATOR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(flowJSON),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) throw new Error(`Flow Validator POST failed: ${resp.status} ${await resp.text().catch(() => '')}`);
  const result = await resp.json();

  if (!result.jobId) return result;

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 4000));
    const poll = await fetch(`${FLOW_VALIDATOR_URL}?jobId=${result.jobId}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (!poll.ok) continue;
    const body = await poll.json();
    if (body.status === 'complete' || body.status === 'error' || body.diagnostics) return body;
    process.stdout.write(`    Flow validator poll ${i + 1}: ${body.status || 'processing'}...\r`);
  }
  throw new Error('Flow Validator polling timed out');
}

// ---------------------------------------------------------------------------
// Local validation fallback (stepBuilder.validateStep + stepValidator)
// ---------------------------------------------------------------------------
function runLocalValidation(stepDir) {
  let diagnostics = [];
  try {
    const { validateStep } = require('./lib/stepBuilder');
    const result = validateStep(stepDir);
    if (result.diagnostics) diagnostics = result.diagnostics;
  } catch (e) {
    try {
      const { validateStep } = require('./lib/stepValidator');
      const template = buildStepTemplate(stepDir);
      const result = validateStep(template);
      if (result.diagnostics) {
        for (const d of result.diagnostics) diagnostics.push({ source: 'step-validator', ...d });
      }
    } catch (_) {}
  }
  const errors = diagnostics.filter(d => d.severity === 'error');
  const warnings = diagnostics.filter(d => d.severity === 'warning');
  const infos = diagnostics.filter(d => d.severity === 'info');
  return { diagnostics, errors, warnings, infos };
}

// ---------------------------------------------------------------------------
// Clone reference flow with remapped IDs
// ---------------------------------------------------------------------------
function cloneFlow(ref, flowLabel, httpPath) {
  const flow = JSON.parse(JSON.stringify(ref));

  const idMap = new Map();
  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (step?.id) {
        const newId = uuid();
        idMap.set(step.id, newId);
        step.id = newId;
      }
    }
  }

  for (const tree of Object.values(flow.data.trees)) {
    if (!tree?.steps) continue;
    for (const step of tree.steps) {
      if (step?.data?.exits) {
        for (const exit of step.data.exits) {
          if (exit.stepId && idMap.has(exit.stepId)) exit.stepId = idMap.get(exit.stepId);
          if (exit.targetStepId && idMap.has(exit.targetStepId)) exit.targetStepId = idMap.get(exit.targetStepId);
        }
      }
      if (step?.data?.skipStepLogicExit?.stepId && idMap.has(step.data.skipStepLogicExit.stepId)) {
        step.data.skipStepLogicExit.stepId = idMap.get(step.data.skipStepLogicExit.stepId);
      }
    }
  }
  if (flow.data.meta?.globalProcessErrorStepId && idMap.has(flow.data.meta.globalProcessErrorStepId)) {
    flow.data.meta.globalProcessErrorStepId = idMap.get(flow.data.meta.globalProcessErrorStepId);
  }
  if (Array.isArray(flow.data.meta?.dataOuts)) {
    for (const d of flow.data.meta.dataOuts) {
      if (d.stepId && idMap.has(d.stepId)) d.stepId = idMap.get(d.stepId);
    }
  }

  flow.id = 'new';
  flow.version = '';
  flow.dateCreated = Date.now();
  flow.dateModified = Date.now();
  flow.data.label = flowLabel;

  const mainSteps = flow.data.trees?.main?.steps || {};
  const stepArr = Array.isArray(mainSteps) ? mainSteps : Object.values(mainSteps);
  const gwStep = stepArr.find(s => s.isGatewayStep);
  if (gwStep) {
    gwStep.data.path = `\`${httpPath}\``;
    if (gwStep.stepInputData) gwStep.stepInputData.path = `\`${httpPath}\``;
  }

  return flow;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter(a => a.startsWith('--'));
  const positional = args.filter(a => !a.startsWith('--'));

  const force = flags.includes('--force');
  const dryRun = flags.includes('--dry-run');

  if (!positional.length) {
    console.error('Usage: node deploy-step.js <step-directory> [--force] [--dry-run]');
    console.error('  e.g. node deploy-step.js steps/clicktime/create-task');
    process.exit(1);
  }

  const stepDir = path.resolve(positional[0]);
  if (!fs.existsSync(path.join(stepDir, 'step.json'))) {
    console.error(`Error: ${stepDir}/step.json not found`);
    process.exit(1);
  }
  if (!fs.existsSync(path.join(stepDir, 'logic.js'))) {
    console.error(`Error: ${stepDir}/logic.js not found`);
    process.exit(1);
  }

  const spec = JSON.parse(fs.readFileSync(path.join(stepDir, 'step.json'), 'utf-8'));
  const stepLabel = spec.label || spec.name;
  const httpPath = slugify(spec.name || path.basename(stepDir));
  const flowLabel = `Step Test: ${stepLabel}`;

  console.log(`\nStep Deployer\n`);
  console.log(`  Step:     ${stepLabel}`);
  console.log(`  Dir:      ${stepDir}`);
  console.log(`  Endpoint: /${httpPath}`);
  console.log('');

  // 1. Build template
  console.log('  Building template...');
  const template = buildStepTemplate(stepDir);
  console.log(`    Template: ${template.label} v${template.version}`);
  console.log(`    Code:     ${template.template.length} chars`);
  console.log(`    Inputs:   ${template.formBuilder.stepInputs.length} components`);
  console.log(`    Exits:    ${template.data.exits.map(e => e.id).join(', ')}`);

  // 2. Validate step via deployed API
  console.log('\n  Validating step via API...');
  let stepErrors = [];
  try {
    const stepResult = await validateStepViaAPI(template);
    const diags = stepResult.diagnostics || [];
    stepErrors = diags.filter(d => d.severity === 'error');
    const stepWarnings = diags.filter(d => d.severity === 'warning');
    const stepInfos = diags.filter(d => d.severity === 'info');

    console.log(`    API result: valid=${stepResult.valid}, ${stepErrors.length} error(s), ${stepWarnings.length} warning(s), ${stepInfos.length} info`);
    for (const d of diags.slice(0, 15)) {
      const icon = d.severity === 'error' ? 'ERR' : d.severity === 'warning' ? 'WRN' : 'INF';
      console.log(`    [${icon}] ${d.code}: ${d.message}`);
    }
  } catch (apiErr) {
    console.warn(`    Step Validator API unavailable: ${apiErr.message}`);
    console.log('    Falling back to local validation...');
    const local = runLocalValidation(stepDir);
    stepErrors = local.errors;
    if (local.errors.length) console.log(`    Errors:   ${local.errors.length}`);
    if (local.warnings.length) console.log(`    Warnings: ${local.warnings.length}`);
    if (local.infos.length) console.log(`    Info:     ${local.infos.length}`);
    for (const d of local.diagnostics.slice(0, 10)) {
      const icon = d.severity === 'error' ? 'ERR' : d.severity === 'warning' ? 'WRN' : 'INF';
      console.log(`    [${icon}] ${d.code}: ${d.message}`);
    }
  }

  if (stepErrors.length && !force) {
    console.error('\n  Deploy blocked: fix step errors or use --force to override.');
    process.exit(1);
  }

  if (dryRun) {
    console.log('\n  --dry-run: skipping deploy.');
    console.log('\n  Generated template:');
    console.log(JSON.stringify(template, null, 2));
    return;
  }

  // 3. Deploy
  console.log('\n  Connecting to Edison...');
  const token = await getToken();
  console.log('    Token acquired');

  const flows = new Flows({ token, discoveryUrl: DISCOVERY_URL });

  // Search for existing flow by label — check both the configured BOT_ID and
  // the reference flow's bot (cloned flows inherit the reference's botId)
  const ref = await flows.getFlow(REFERENCE_FLOW_ID);
  const searchBotIds = [...new Set([BOT_ID, ref.botId].filter(Boolean))];
  let flow;
  for (const bid of searchBotIds) {
    const existing = await flows.listFlows({ query: { botId: bid } });
    flow = existing.items.find(f => f.data.label === flowLabel);
    if (flow) break;
  }

  if (flow) {
    console.log(`    Found existing flow: "${flow.data.label}" (${flow.id})`);
    flow = await flows.getFlow(flow.id);
  } else {
    console.log('    Creating new flow from reference...');
    flow = cloneFlow(ref, flowLabel, httpPath);
    flow.data.description = `Test flow for: ${spec.description || stepLabel}`;

    const saved = await flows.saveFlow(flow);
    console.log(`    Created flow: ${saved.id}`);
    flow = await flows.getFlow(saved.id);
  }

  // 4. Inject template into only the custom step templates (not infrastructure)
  //    Infrastructure steps: gateway, error handlers, response senders
  const infraLabels = new Set();
  const steps = flow.data.trees?.main?.steps || {};
  for (const inst of Object.values(steps)) {
    if (!inst.label) continue;
    const lower = inst.label.toLowerCase();
    if (lower.includes('error') || lower.includes('response') || lower.includes('gateway')) {
      infraLabels.add(inst.type);
    }
  }

  const customTemplates = flow.data.stepTemplates.filter(t =>
    !t.isGatewayStep && !infraLabels.has(t.id)
  );

  const matchByLabel = customTemplates.filter(t => t.label === stepLabel);
  const PLACEHOLDER_LABELS = ['Template Step', 'Step Template', 'Your Step Here'];
  const matchByDefault = customTemplates.filter(t =>
    PLACEHOLDER_LABELS.some(p => t.label === p || t.label?.startsWith(p))
  );
  let targets = matchByLabel.length > 0 ? matchByLabel : matchByDefault;
  if (targets.length === 0 && customTemplates.length > 0) {
    targets = [customTemplates[customTemplates.length - 1]];
  }
  if (targets.length === 0) {
    const fallback = flow.data.stepTemplates.find(t =>
      !t.isGatewayStep && t.template !== undefined
    );
    if (!fallback) throw new Error('No injectable template step found in the reference flow');
    targets = [fallback];
  }

  for (const tpl of targets) {
    tpl.template = template.template;
    tpl.label = template.label;
    tpl.data = template.data;
    tpl.formBuilder = template.formBuilder;
    tpl.icon = template.icon;
    tpl.iconType = template.iconType;
    tpl.iconUrl = template.iconUrl;
    tpl.shape = template.shape;
    tpl.description = template.description;
    tpl.categories = template.categories;
    tpl.tags = template.tags;
    delete tpl.size;
    if (tpl.version !== undefined) tpl.version = template.version;
    if (tpl.help !== undefined) tpl.help = template.help;
    if (tpl.outputExample !== undefined) tpl.outputExample = template.outputExample;
  }

  console.log(`    Injected template into ${targets.length} template(s): "${template.label}" (${template.template.length} chars)`);
  if (template.iconType === 'custom' && template.iconUrl) {
    console.log(`    Icon:     custom (${template.iconUrl.substring(0, 60)}${template.iconUrl.length > 60 ? '...' : ''})`);
  } else if (template.icon) {
    console.log(`    Icon:     ${template.icon}`);
  }

  // 4a-ii. Sync icon/shape and stepInputData on step instances
  const syncTplIds = new Set(targets.map(t => t.id));
  const allStepsForSync = flow.data.trees?.main?.steps || {};
  let syncedCount = 0;
  for (const inst of Object.values(allStepsForSync)) {
    if (!inst.type || !syncTplIds.has(inst.type)) continue;
    inst.icon = template.icon;
    inst.iconType = template.iconType;
    inst.iconUrl = template.iconUrl;
    inst.shape = template.shape;
    inst.label = template.label;

    // Rebuild stepInputData to wire template inputs to the gateway merge field
    const newInputData = {};
    const gwMerge = 'httpGatewayStep';
    for (const si of (template.formBuilder?.stepInputs || [])) {
      const variable = si.data?.variable;
      if (!variable) continue;
      if (si.component === 'formDataOut') continue;
      newInputData[variable] = `await this.mergeFields['${gwMerge}'].get({path: 'request.body.${variable}'})`;
    }
    // Preserve processError / processTimeout from template defaults
    const tplData = template.data || {};
    if (tplData.exits) {
      const hasProcessError = tplData.exits.some(e => e.condition === 'processError');
      if (hasProcessError) newInputData.processError = true;
    }
    inst.stepInputData = newInputData;
    inst.data = inst.data || {};
    for (const [k, v] of Object.entries(newInputData)) {
      inst.data[k] = v;
    }
    syncedCount++;
  }
  if (syncedCount) {
    console.log(`    Synced icon/shape + stepInputData on ${syncedCount} step instance(s)`);
  }

  // 4a-iii. Wire "Set Validation Result To Storage" to read the custom step's full output
  //         The reference flow's async pattern: custom step → store to KV → GET poll reads from KV
  //         The custom step instance keeps the reference's dataOut name (e.g. "stepTemplatePost").
  {
    const currentSteps = flow.data.trees?.main?.steps || {};
    const injectedTplIds = new Set(targets.map(t => t.id));
    let customMergeField;
    for (const inst of Object.values(currentSteps)) {
      if (inst.type && injectedTplIds.has(inst.type) && inst.data?.dataOut?.name) {
        customMergeField = inst.data.dataOut.name;
        break;
      }
    }
    if (!customMergeField) customMergeField = spec.dataOut?.name || 'stepTemplate';

    let storageWired = 0;
    for (const inst of Object.values(currentSteps)) {
      const lbl = (inst.label || '').toLowerCase();
      if (lbl.includes('set') && lbl.includes('result') && lbl.includes('storage')) {
        const valueExpr = `await this.mergeFields['${customMergeField}'].get()`;
        if (inst.data) inst.data.value = valueExpr;
        if (inst.stepInputData) inst.stepInputData.value = valueExpr;
        storageWired++;
      }
    }
    if (storageWired) {
      console.log(`    Wired ${storageWired} storage step(s) to read from merge field "${customMergeField}"`);
    }
  }

  // 4b. Undo any IIFE wrapping from previous deploys on inherited templates
  for (const tpl of flow.data.stepTemplates) {
    if (!tpl.template || targets.includes(tpl)) continue;
    if (/^\s*\(async function\(\)\s*\{/.test(tpl.template) && tpl.template.trimEnd().endsWith('}).call(this);')) {
      tpl.template = tpl.template
        .replace(/^\s*\(async function\(\)\s*\{\n/, '')
        .replace(/\n\}\)\.call\(this\);\s*$/, '');
      console.log(`    Unwrapped "${tpl.label}" template (reverted IIFE)`);
    }
  }

  // 4c. Remove empty-key entries from stepInputData (causes node --check failure)
  const treeSteps = flow.data.trees?.main?.steps || {};
  let cleanedCount = 0;
  for (const [instId, inst] of Object.entries(treeSteps)) {
    if (inst.stepInputData && '' in inst.stepInputData) {
      delete inst.stepInputData[''];
      cleanedCount++;
    }
  }
  if (cleanedCount) {
    console.log(`    Cleaned empty stepInputData keys from ${cleanedCount} step instance(s)`);
  }

  // 4d. Wire error exits on ALL step instances whose template defines __error__
  const SEND_RESPONSE_TPL_ID = 'f08d2d37-8047-400e-aa94-e3f6e3435b1b';
  const allSteps = flow.data.trees?.main?.steps || {};
  const globalErrorStepId = flow.data.meta?.globalProcessErrorStepId;

  // Build a set of template IDs that define __error__ exits
  const tplErrorMap = new Map();
  for (const tpl of flow.data.stepTemplates) {
    const exits = tpl.data?.exits || [];
    if (exits.some(e => e.id === '__error__' || e.condition === 'processError')) {
      tplErrorMap.set(tpl.id, tpl);
    }
  }

  function createResponseStep(mergeFieldName, label, httpCode) {
    const stepId = uuid();
    return {
      id: stepId,
      label,
      icon: 'http',
      iconType: 'default',
      iconUrl: '',
      shape: 'circle',
      type: SEND_RESPONSE_TPL_ID,
      description: '',
      isGatewayStep: false,
      pinLabel: true,
      data: {
        body: `await this.mergeFields['${mergeFieldName}'].get()`,
        code: String(httpCode),
        exits: [],
        dataOut: { ttl: 86400000, meta: {}, name: 'sendErrorResponse', type: 'session' },
        headers: [],
        useFiles: false,
        __codeModes: {},
        attachments: [],
        contentType: "'application/json'",
        fileLocation: '',
        typeResponse: 'body',
        isRequestBody: false,
        bodyOutputData: '{}',
        codeAdditionalOptions: [],
        isWaitForAnotherRequest: false,
        contentTypeAdditionalOptions: [],
      },
      stepInputData: {
        body: `await this.mergeFields['${mergeFieldName}'].get()`,
        code: String(httpCode),
        exits: '[]',
        headers: '[]',
        useFiles: 'false',
        attachments: '[]',
        contentType: "'application/json'",
        fileLocation: '""',
        typeResponse: '"body"',
        isWaitForAnotherRequest: 'false',
      },
      reporting: { step: { tags: [], type: 'step', label: 'Step', enabled: true } },
      dataOutLabelConnected: true,
    };
  }

  if (!flow.data.trees) flow.data.trees = {};
  if (!flow.data.trees.main) flow.data.trees.main = { position: { x: 0, y: 0 } };
  if (!flow.data.trees.main.steps) flow.data.trees.main.steps = {};
  const cleanedSteps = flow.data.trees.main.steps;
  const stepKeys = Object.keys(cleanedSteps).map(Number).filter(n => !isNaN(n));
  let newNextIdx = stepKeys.length > 0 ? Math.max(...stepKeys) + 1 : 0;
  if (!flow.data.meta) flow.data.meta = {};
  if (!flow.data.meta.dataOuts) flow.data.meta.dataOuts = [];

  // Create a shared termination step for all Send HTTP Response next exits
  const terminationStep = { id: uuid(), icon: 'add', iconType: 'default', iconUrl: '', shape: 'empty', type: 'empty', pinLabel: true, stepInputData: {} };
  cleanedSteps[String(newNextIdx)] = terminationStep;
  newNextIdx++;

  let wiredCount = 0;
  for (const [instIdx, inst] of Object.entries(cleanedSteps)) {
    if (!inst.type || !tplErrorMap.has(inst.type)) continue;
    if (inst.id === globalErrorStepId || inst.isGatewayStep) continue;

    if (!inst.data) inst.data = {};
    const exits = inst.data.exits || [];
    const errorExit = exits.find(e => e.id === '__error__' && e.stepId);
    if (errorExit) {
      if (!inst.data.processError) inst.data.processError = true;
      // Ensure custom condition-based exits also point to the error handler
      const tplExits = tplErrorMap.get(inst.type)?.data?.exits || [];
      for (const tplExit of tplExits) {
        if (tplExit.id === '__error__' || !tplExit.condition) continue;
        if (!exits.some(e => e.id === tplExit.id && e.stepId)) {
          exits.push({ id: tplExit.id, label: tplExit.label || tplExit.id, stepId: errorExit.stepId, condition: tplExit.condition });
        }
      }
      inst.data.exits = exits;
      continue;
    }

    inst.data.processError = true;
    const closest = inst.label || 'step';
    const errStep = createResponseStep('handleFlowError', `Error: ${closest}`, 500);
    errStep.data.exits = [{ id: 'next', label: 'next', stepId: terminationStep.id, condition: '' }];
    cleanedSteps[String(newNextIdx)] = errStep;
    newNextIdx++;

    exits.push({ id: '__error__', label: 'error', stepId: errStep.id, condition: 'processError' });

    // Also wire any custom condition-based exits (e.g. template exit id="error" with condition="processError")
    const tplExits = tplErrorMap.get(inst.type)?.data?.exits || [];
    for (const tplExit of tplExits) {
      if (tplExit.id === '__error__' || !tplExit.condition) continue;
      const alreadyHas = exits.some(e => e.id === tplExit.id && e.stepId);
      if (!alreadyHas) {
        exits.push({ id: tplExit.id, label: tplExit.label || tplExit.id, stepId: errStep.id, condition: tplExit.condition });
      }
    }

    inst.data.exits = exits;

    flow.data.meta.dataOuts.push({ name: 'sendErrorResponse', type: 'session', stepId: errStep.id, stepTemplateId: SEND_RESPONSE_TPL_ID });
    wiredCount++;
  }

  // Wire Handle Flow Error error/timeout exits if they point to empty steps
  if (globalErrorStepId) {
    const errHandler = Object.values(cleanedSteps).find(s => s.id === globalErrorStepId);
    if (errHandler && errHandler.data?.exits) {
      for (const exitId of ['error', 'timeout']) {
        const exit = errHandler.data.exits.find(e => e.id === exitId);
        if (exit && exit.stepId) {
          const targetKey = Object.keys(cleanedSteps).find(k => cleanedSteps[k].id === exit.stepId);
          if (targetKey && cleanedSteps[targetKey].type === 'empty') {
            const errStep = createResponseStep('handleFlowError', `Send ${exitId === 'timeout' ? 'Timeout' : 'Error'} Response (500)`, 500);
            errStep.data.body = "await this.mergeFields['handleFlowError'].get({path: 'error.message'})";
            errStep.stepInputData.body = "await this.mergeFields['handleFlowError'].get({path: 'error.message'})";
            errStep.data.exits = [{ id: 'next', label: 'next', stepId: terminationStep.id, condition: '' }];
            cleanedSteps[targetKey] = errStep;
            flow.data.meta.dataOuts.push({ name: 'sendErrorResponse', type: 'session', stepId: errStep.id, stepTemplateId: SEND_RESPONSE_TPL_ID });
            wiredCount++;
          }
        }
      }
    }
  }

  // Ensure ALL Send HTTP Response steps have a next exit pointing to termination
  for (const inst of Object.values(cleanedSteps)) {
    if (inst.type !== SEND_RESPONSE_TPL_ID) continue;
    if (!inst.data) inst.data = {};
    const exits = inst.data.exits || [];
    const hasNext = exits.some(e => e.id === 'next' && e.stepId);
    if (!hasNext) {
      exits.push({ id: 'next', label: 'next', stepId: terminationStep.id, condition: '' });
      inst.data.exits = exits;
    }
  }

  // Set gateway bodyOutputData so the merge field picker shows request body fields
  const gwStep = Object.values(cleanedSteps).find(s => s.isGatewayStep);
  if (gwStep && gwStep.data) {
    if (!gwStep.data.bodyOutputData || gwStep.data.bodyOutputData === '{}') {
      const bodyFields = {};
      for (const si of (template.formBuilder?.stepInputs || [])) {
        const v = si.data?.variable;
        if (!v || si.component === 'formDataOut') continue;
        bodyFields[v] = '';
      }
      if (Object.keys(bodyFields).length) {
        gwStep.data.bodyOutputData = JSON.stringify(bodyFields);
        gwStep.data.isRequestBody = true;
      }
    }
  }

  if (wiredCount) {
    console.log(`    Wired error exits on ${wiredCount} step(s)`);
  }

  // 4e. Validate assembled flow via deployed API
  console.log('\n  Validating flow via API...');
  let flowErrors = [];
  try {
    const flowResult = await validateFlowViaAPI(flow);
    const allDiags = flowResult.diagnostics || [];
    flowErrors = allDiags.filter(d => d.severity === 'error');
    const fWarnings = allDiags.filter(d => d.severity === 'warning');
    const fInfos = allDiags.filter(d => d.severity === 'info');

    console.log(`    API result: valid=${flowResult.valid}, ${flowErrors.length} error(s), ${fWarnings.length} warning(s), ${fInfos.length} info`);
    for (const d of [...flowErrors, ...fWarnings].slice(0, 20)) {
      const icon = d.severity === 'error' ? 'ERR' : 'WRN';
      console.log(`    [${icon}] ${d.code}: ${d.message}`);
    }
  } catch (apiErr) {
    console.warn(`    Flow Validator API unavailable: ${apiErr.message}`);
    console.log('    Falling back to local flow validation...');
    try {
      const { validateFlow } = require('./lib/flowValidator');
      const result = validateFlow(flow);
      const allDiags = result.diagnostics || [];
      flowErrors = allDiags.filter(d => d.severity === 'error');
      const fWarnings = allDiags.filter(d => d.severity === 'warning');
      if (flowErrors.length || fWarnings.length) {
        console.log(`    Local: ${flowErrors.length} error(s), ${fWarnings.length} warning(s)`);
        for (const d of [...flowErrors, ...fWarnings].slice(0, 20)) {
          const icon = d.severity === 'error' ? 'ERR' : 'WRN';
          console.log(`    [${icon}] ${d.code}: ${d.message}`);
        }
      }
    } catch (localErr) {
      console.warn(`    Local flow validator also unavailable: ${localErr.message}`);
    }
  }

  if (flowErrors.length && !force) {
    console.error('\n  Deploy blocked by flow validation errors. Use --force to override.');
    process.exit(1);
  }

  // 4f. Sanitize template properties for Edison schema (size must be number|null)
  for (const t of flow.data.stepTemplates) {
    if (typeof t.size === 'string') delete t.size;
    if (t.modules === null) delete t.modules;
  }

  // 5. Save
  const saved = await flows.saveFlow(flow, { previousVersion: flow.version });
  console.log(`\n  Saved flow v${saved.version}`);

  // 6. Activate
  console.log('  Activating...');
  try {
    await flows.activateFlow(saved, false, (p) => {
      process.stdout.write(`    ${p.status}: ${p.data?.progress || 0}%\r`);
    });
    console.log('\n  Activated');
  } catch (err) {
    if (err.message?.includes('imeout')) {
      console.log('\n  Activation timed out (may complete server-side)');
    } else {
      console.warn(`\n  Activation failed (flow saved): ${err.message?.slice(0, 200)}`);
      console.warn('  The flow is saved and can be activated via the Edison UI.');
    }
  }

  // 7. Test
  const baseUrl = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/${httpPath}`;
  console.log('\n  Testing endpoint...');
  await new Promise(r => setTimeout(r, 3000));

  try {
    const resp = await fetch(baseUrl);
    const body = await resp.json();
    console.log(`  GET ${resp.status}: ${JSON.stringify(body).slice(0, 200)}`);
  } catch (err) {
    console.log(`  GET failed: ${err.message}`);
  }

  console.log(`\nDone.`);
  console.log(`\nEndpoint: ${baseUrl}`);
  console.log(`Flow:     ${flow.id}`);
  console.log(`Bot:      ${BOT_ID}\n`);
}

main().catch(err => {
  console.error('FATAL:', err.message || err);
  if (err.response?.data) console.error('  Detail:', JSON.stringify(err.response.data));
  process.exit(1);
});
