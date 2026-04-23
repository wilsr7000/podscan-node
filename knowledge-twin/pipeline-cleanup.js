#!/usr/bin/env node
// pipeline-cleanup — delete (soft-delete) stale test flows produced by
// pipeline runs. Reads local .pipeline-jobs/ + KV playbooks/ to find
// every flowId the pipeline has ever created, and deletes those whose
// label matches one of the test-run prefixes.
//
// Usage:
//   node pipeline-cleanup.js --dry-run           # list candidates
//   node pipeline-cleanup.js --by-label Weather  # delete flows whose label contains "Weather"
//   node pipeline-cleanup.js --older-than 24h    # by age (skip recent-in-progress runs)
//   node pipeline-cleanup.js --playbook <id>     # all flows referenced by a specific playbook's history
//   node pipeline-cleanup.js --keep <flowId>     # explicit keep list (comma-separated)
//
// Safety:
//   - Always defaults to --dry-run unless a filter is supplied
//   - Default-excludes flows whose label contains "Prod" / "Production"
//   - Never deletes flows whose ID is in knownPipelineFlowIds (SpliceStep,
//     Conceive, GenerateCode, DesignStep — the pipeline's own backend flows)
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const dh = require('./lib/deployHelper');

// Pipeline backend flow IDs — NEVER delete these.
const PROTECTED_IDS = new Set([
  '021297fa-b6c1-4dcb-a1a6-4b9b5bbfbc2e',  // SpliceStep
  'a7206f84-9dd9-4d83-9cd8-091dfee94be6',  // Conceive
  'c5d5ee49-23d4-470b-9406-804efc41c823',  // GenerateCode
  '0ad31746-2e87-4bb0-8766-77e857d4543d',  // DesignStep
  '064be225-6f36-4128-8df3-cff3e29fa2c6',  // templateFinder / flow-template-discovery
]);

function parseArgs(argv) {
  const opts = { dryRun: false, byLabel: null, olderThan: null, playbook: null, keep: [] };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--by-label' && argv[i + 1]) opts.byLabel = argv[++i];
    else if (a === '--older-than' && argv[i + 1]) opts.olderThan = argv[++i];
    else if (a === '--playbook' && argv[i + 1]) opts.playbook = argv[++i];
    else if (a === '--keep' && argv[i + 1]) opts.keep = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else { console.error(`unknown arg: ${a}`); printHelp(); process.exit(1); }
  }
  // Safety: if no filter at all, force dry-run
  if (!opts.byLabel && !opts.olderThan && !opts.playbook) opts.dryRun = true;
  return opts;
}

function printHelp() {
  console.log(`pipeline-cleanup — delete stale pipeline test flows

Usage:
  node pipeline-cleanup.js [options]

Options:
  --dry-run              Show candidates without deleting (implied if no filter)
  --by-label <str>       Match flows whose label contains <str> (e.g. "Weather")
  --older-than <dur>     Match flows older than <dur> (e.g. "24h", "7d")
  --playbook <id>        All flows referenced by this playbook's stages.*.data.flowId
  --keep <ids>           Comma-separated flow IDs to exclude from deletion

Protected (never deleted): the 4 pipeline backend flows and templateFinder.

Examples:
  # See what would be deleted if we purged all Weather test flows:
  node pipeline-cleanup.js --by-label Weather --dry-run

  # Actually delete them:
  node pipeline-cleanup.js --by-label Weather

  # Delete everything older than 2 days (cautiously):
  node pipeline-cleanup.js --older-than 2d --dry-run
`);
}

function parseDuration(s) {
  const m = String(s).match(/^(\d+)\s*([smhd])$/i);
  if (!m) throw new Error(`invalid duration: ${s}`);
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  const mult = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit];
  return n * mult;
}

async function main() {
  const opts = parseArgs(process.argv);
  console.log('[cleanup] opts:', JSON.stringify(opts));

  const token = await dh.getToken();
  const api = dh.initFlowsApi(token);
  const flows = await api.listFlows({ limit: 500 });
  const items = (flows.items || []).filter((f) => !f.isDeleted);
  console.log(`[cleanup] ${items.length} non-deleted flows in account`);

  let candidates = items.filter((f) => !PROTECTED_IDS.has(f.id));
  if (opts.keep.length > 0) {
    const keep = new Set(opts.keep);
    candidates = candidates.filter((f) => !keep.has(f.id));
  }

  if (opts.byLabel) {
    const needle = opts.byLabel.toLowerCase();
    candidates = candidates.filter((f) => String(f.data?.label || '').toLowerCase().includes(needle));
  }
  if (opts.olderThan) {
    const cutoff = Date.now() - parseDuration(opts.olderThan);
    candidates = candidates.filter((f) => {
      const ts = f.dateModified || f.dateCreated;
      return ts && new Date(ts).getTime() < cutoff;
    });
  }
  if (opts.playbook) {
    const pb = require('./lib/playbookStore');
    const entry = await pb.getPlaybook(opts.playbook);
    if (!entry) { console.error(`playbook ${opts.playbook} not found in KV`); process.exit(1); }
    const ids = new Set();
    for (const stage of Object.values(entry.stages || {})) {
      const flowId = stage?.data?.flowId;
      if (flowId) ids.add(flowId);
    }
    if (entry.flow?.flowId) ids.add(entry.flow.flowId);
    for (const j of entry.jobs || []) {
      if (j?.flowId) ids.add(j.flowId);
    }
    console.log(`[cleanup] playbook ${opts.playbook} references ${ids.size} flowIds`);
    candidates = candidates.filter((f) => ids.has(f.id));
  }

  // Default safety: exclude "prod" labels
  candidates = candidates.filter((f) => !/prod(uction)?/i.test(String(f.data?.label || '')));

  console.log(`[cleanup] ${candidates.length} delete candidate(s):`);
  for (const f of candidates) {
    const label = f.data?.label || '(no label)';
    const dateM = f.dateModified || f.dateCreated || '?';
    console.log(`  ${f.id.slice(0, 8)} | ${label.slice(0, 50).padEnd(50)} | ${dateM}`);
  }

  if (opts.dryRun) {
    console.log('\n[cleanup] --dry-run — no deletes performed. Re-run without --dry-run to apply.');
    return;
  }
  if (candidates.length === 0) {
    console.log('[cleanup] nothing to delete.');
    return;
  }

  console.log(`\n[cleanup] deleting ${candidates.length} flow(s)...`);
  let deleted = 0, failed = 0;
  for (const f of candidates) {
    try {
      await api.deleteFlow(f.id);
      deleted++;
      console.log(`  ✓ deleted ${f.id.slice(0, 8)} — ${(f.data?.label || '').slice(0, 40)}`);
    } catch (err) {
      failed++;
      console.log(`  ✗ failed  ${f.id.slice(0, 8)}: ${err.message?.slice(0, 100)}`);
    }
  }
  console.log(`\n[cleanup] ${deleted} deleted, ${failed} failed.`);
}

main().catch((err) => {
  console.error('[cleanup] FATAL:', err.message);
  process.exit(1);
});
