#!/usr/bin/env node
// ---------------------------------------------------------------------------
// run-step-flow-pipeline.js — CLI for the step iteration pipeline
//
// Orchestrates a step from playbook through decompose, conceive, code gen,
// validation, UI design, and approval. One stage at a time.
//
// Usage:
//   node run-step-flow-pipeline.js --playbook .tmp/my-step.md
//   node run-step-flow-pipeline.js --playbook .tmp/my-step.md --stop-after decompose
//   node run-step-flow-pipeline.js --resume-from generateCode --flow-id abc --template-id xyz
//   node run-step-flow-pipeline.js --playbook .tmp/my-step.md --focus api
// ---------------------------------------------------------------------------

'use strict';

const { runPipeline, STAGES, loadJobState, jobDir } = require('./lib/stepFlowPipeline');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--playbook' && args[i + 1])      { opts.playbookPath = args[++i]; continue; }
    if (arg === '--playbook-id' && args[i + 1])   { opts.playbookID = args[++i]; continue; }
    if (arg === '--playbook-collection' && args[i + 1]) { opts.playbookCollection = args[++i]; continue; }
    if (arg === '--stop-after' && args[i + 1])     { opts.stopAfter = args[++i]; continue; }
    if (arg === '--resume-from' && args[i + 1])    { opts.resumeFrom = args[++i]; continue; }
    if (arg === '--flow-id' && args[i + 1])        { opts.flowId = args[++i]; continue; }
    if (arg === '--template-id' && args[i + 1])    { opts.templateId = args[++i]; continue; }
    if (arg === '--job-id' && args[i + 1])         { opts.jobId = args[++i]; continue; }
    if (arg === '--focus' && args[i + 1])          { opts.focus = args[++i]; continue; }
    if (arg === '--max-iterations' && args[i + 1]) { opts.maxIterations = parseInt(args[++i], 10); continue; }
    if (arg === '--api-key' && args[i + 1])       { opts.apiKey = args[++i]; continue; }
    if (arg === '--bot-id' && args[i + 1])        { opts.botId = args[++i]; continue; }
    if (arg === '--flow-url' && args[i + 1])      { opts.flowUrl = args[++i]; continue; }
    if (arg === '--inject-probe' && args[i + 1])  { opts.injectProbe = args[++i]; continue; }
    if (arg === '--monitor') { opts.monitor = true; continue; }
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
Step Flow Pipeline — build a step one stage at a time

Usage:
  node run-step-flow-pipeline.js --playbook <path> [options]

Options:
  --playbook <path>              Path to playbook markdown file (required for stage 1)
  --playbook-id <id>             Use this id as the KV playbook key instead of auto-generating.
                                 Let WISER Playbooks pass its own id so the pipeline state
                                 is readable from GET /keyvalue?id=<collection>&key=<id>.
                                 Idempotent — re-using an existing id preserves prior stages.
  --playbook-collection <name>   KV collection name (default: 'playbooks'). Override to isolate
                                 pipeline runs from other playbook consumers if desired.
  --bot-id <id>                  Target bot for Conceive. Written to playbook.config.botId so
                                 each flow can resolve it from KV without needing it in every
                                 body. WISER can set this once per playbook.
  --flow-url <id-or-url>         Target flow for SpliceStep. Written to playbook.config.flowUrl.
                                 If absent, SpliceStep derives from stages.conceive.data.flowId.
  --stop-after <stage>           Stop after this stage completes
  --resume-from <stage>          Skip earlier stages and start from here
  --job-id <id>                  Resume a previous job (loads saved state)
  --flow-id <id>                 Flow ID (override, or required when resuming without job-id)
  --template-id <id>             Template ID (override)
  --focus <profile>              Focus profile: api, logic, or empty for balanced
  --max-iterations <n>           Max plan iteration rounds (default: 6)
  --monitor                      Poll with natural-language job + log summaries (also: STEP_PIPELINE_MONITOR=1)

Stages (in order):
${STAGES.map((s, i) => `  ${(i + 1).toString().padStart(2)}. ${s}`).join('\n')}

Examples:
  # Run just playbook + decompose
  node run-step-flow-pipeline.js --playbook .tmp/my-step.md --stop-after decompose

  # Resume from code generation with existing flow
  node run-step-flow-pipeline.js --resume-from generateCode --flow-id abc --template-id xyz

  # Run a WISER Playbook through the pipeline — KV key matches WISER's id,
  # so the WISER UI can pull pipeline state via GET /keyvalue?id=playbooks&key=pb-123...
  node run-step-flow-pipeline.js --playbook wiser-export.md --playbook-id pb-1776829123456
`);
}

async function main() {
  const opts = parseArgs(process.argv);

  // Require at least one entry point:
  //   --playbook <file>     — fresh run from local markdown
  //   --playbook-id <id>    — hydrate markdown from KV source.markdown (resume
  //                           or WISER-triggered re-run)
  //   --resume-from <stage> — resume using previously-saved local job state
  if (!opts.playbookPath && !opts.playbookID && !opts.resumeFrom) {
    printHelp();
    process.exit(1);
  }

  if (opts.stopAfter && !STAGES.includes(opts.stopAfter)) {
    console.error(`Unknown stage: ${opts.stopAfter}\nValid stages: ${STAGES.join(', ')}`);
    process.exit(1);
  }
  if (opts.resumeFrom && !STAGES.includes(opts.resumeFrom)) {
    console.error(`Unknown stage: ${opts.resumeFrom}\nValid stages: ${STAGES.join(', ')}`);
    process.exit(1);
  }

  if (opts.jobId && opts.resumeFrom) {
    try {
      const saved = loadJobState(opts.jobId);
      if (!opts.flowId && saved.flowId) opts.flowId = saved.flowId;
      if (!opts.templateId && saved.templateId) opts.templateId = saved.templateId;
    } catch (_) {}
  }

  console.log('Step Flow Pipeline');
  console.log('══════════════════════════════════════════════════════════════');
  if (opts.jobId)             console.log(`  Job ID:            ${opts.jobId}`);
  if (opts.playbookPath)      console.log(`  Playbook:          ${opts.playbookPath}`);
  if (opts.playbookID)        console.log(`  Playbook KV id:    ${opts.playbookID} (caller-supplied — re-use will preserve prior stages)`);
  if (opts.playbookCollection)console.log(`  Playbook KV coll:  ${opts.playbookCollection}`);
  if (opts.stopAfter)         console.log(`  Stop after:        ${opts.stopAfter}`);
  if (opts.resumeFrom)        console.log(`  Resume from:       ${opts.resumeFrom}`);
  if (opts.flowId)            console.log(`  Flow ID:           ${opts.flowId}`);
  if (opts.templateId)        console.log(`  Template ID:       ${opts.templateId}`);
  if (opts.focus)             console.log(`  Focus:             ${opts.focus}`);
  console.log('');

  const result = await runPipeline(opts);

  console.log(`\n  Job artifacts: ${result.jobDir}`);

  if (!opts.stopAfter || opts.stopAfter === 'done') {
    console.log('\nPipeline finished.');
  } else {
    console.log(`\nResume with: node run-step-flow-pipeline.js --job-id ${result.jobId} --resume-from <next-stage>`);
  }

  return result;
}

main().catch(err => {
  console.error(`\nFATAL: ${err.message}`);
  process.exit(1);
});
