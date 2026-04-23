// ---------------------------------------------------------------------------
// playbookStore.js — KV-backed playbook as state machine.
//
// Every pipeline run has ONE playbook in KV. Each stage reads the current
// state, does its work, writes its output back. This replaces the pipeline's
// previous in-memory `ctx` state machine with a durable, resumable, and
// cross-flow-visible state.
//
// Schema:
//   {
//     id:      '<uuid>',                              // Playbook identifier
//     source:  { markdown, originalPath, createdAt }, // User-authored input
//                                                     // (strategic WISER brief,
//                                                     //  tactical step plan, etc.)
//     config:  {                                      // Pipeline inputs that
//                                                     // aren't user-authored content
//       botId?:       '<uuid>',                       // Target bot for Conceive
//       flowUrl?:     '<uuid-or-studio-url>',         // Override target flow for
//                                                     // SpliceStep (normally
//                                                     // derived from
//                                                     // stages.conceive.data.flowId)
//       flowLabel?:   '<string>',                     // Flow label override
//       // Additional infra knobs may be added here by WISER or future tools.
//     },
//     job: {                                          // Current/latest pipeline run
//       id:           '<timestamp-rand>',             // pipelineJobId — path to
//                                                     // .pipeline-jobs/<id>/
//       startedAt:    <iso>,
//       completedAt?: <iso>,
//       status:       'running' | 'completed' | 'failed',
//       resumeFrom?:  '<stage-name>',                 // --resume-from value
//       stopAfter?:   '<stage-name>',                 // --stop-after value
//       outerAttempts?: <number>,                     // outer retry attempts
//       // Overwritten on each new pipeline run — terminal-status prior runs
//       // are archived into jobs[] below before overwrite.
//     },
//     jobs: [                                         // Historical pipeline runs (up to 20)
//       { id, startedAt, completedAt, status, archivedAt, ... },
//     ],
//     stages:  {                                      // One entry per pipeline stage
//       decompose:      { status, startedAt, completedAt, data },
//       templateFinder: { status, startedAt, completedAt, data },
//       conceive:       { status, startedAt, completedAt, data },
//       generateCode:   { status, startedAt, completedAt, data },
//       harnessCode:    { status, startedAt, completedAt, data },
//       validate:       { status, startedAt, completedAt, data },
//       testStep:       { status, startedAt, completedAt, data },
//       designUI:       { status, startedAt, completedAt, data },
//       ...
//     },
//     history: [ { at, stage, event, note } ],       // Append-only audit
//     flow:    { flowId, templateId, httpPath, studioUrl },  // Deployment summary
//     updatedAt: <iso>,
//   }
//
// Transport: Edison's HTTP /keyvalue endpoint (same one the pipeline already
// uses for job persistence). Collection is namespaced by playbook collection
// name (default: 'playbooks') and key is the playbook UUID.
//
// Stage status values: 'pending' | 'running' | 'done' | 'error'
//
// ── Extensibility policy (important — read before adding fields) ──
//
// The playbook object is written by MULTIPLE producers:
//   - The pipeline orchestrator (lib/playbookStore.js helpers)
//   - Each pipeline flow (Conceive, GenerateCode, SpliceStep, DesignStep)
//   - External tools (WISER Playbooks UI, future WISER-adjacent services)
//
// Rules to keep this object safe across producers:
//   1. New fields: OK to add at any level. MUST be optional with sensible
//      defaults — the absence of a field must not break any reader.
//   2. Existing fields: never remove, never rename, never narrow the type.
//   3. Unknown fields from other writers MUST survive every write. The
//      current merge logic (spread-and-preserve in ensurePlaybook; in-place
//      mutation in updateStage) guarantees this; any new merge logic MUST
//      continue to.
//   4. Consumers MUST tolerate unknown fields in JSON.
//   5. Writers SHOULD scope their writes narrowly. Never replace the full
//      object; always merge-on-fetch or touch only specific fields.
//
// Following these rules lets WISER, the pipeline, and future tools evolve
// the schema independently without coordinating releases.
// ---------------------------------------------------------------------------

'use strict';

const crypto = require('crypto');

const DEFAULT_COLLECTION = 'playbooks';
const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
const KV_BASE = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}/keyvalue`;

// ─── Low-level KV primitives (HTTP — same endpoint pipeline job state uses)

async function _kvPut(collection, key, value) {
  const resp = await fetch(
    `${KV_BASE}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: collection, key, itemValue: JSON.stringify(value) }),
    }
  );
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`KV put failed: HTTP ${resp.status} — ${text.slice(0, 200)}`);
  }
  return true;
}

async function _kvGet(collection, key) {
  const resp = await fetch(
    `${KV_BASE}?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`
  );
  const data = await resp.json().catch(() => ({}));
  if (data.Status === 'No data found.') return null;
  if (data.value) {
    try { return JSON.parse(data.value); } catch { return data.value; }
  }
  return null;
}

// ─── Playbook-level API

/**
 * Create a new playbook entry in KV. Returns the handle { id, collection, key }
 * that stages use for all subsequent reads/writes.
 *
 * @param {string} markdown - The playbook source text
 * @param {object} options
 * @param {string} [options.id]          - Pre-chosen UUID; auto-generated if omitted
 * @param {string} [options.collection]  - KV collection name (default: 'playbooks')
 * @param {string} [options.originalPath] - Path of the source file (for audit)
 * @returns {Promise<{id: string, collection: string, key: string}>}
 */
async function createPlaybook(markdown, options = {}) {
  const id = options.id || crypto.randomUUID();
  const collection = options.collection || DEFAULT_COLLECTION;
  const key = id;

  const playbook = {
    id,
    source: {
      markdown: markdown || '',
      originalPath: options.originalPath || null,
      createdAt: new Date().toISOString(),
    },
    stages: {},
    history: [{
      at: new Date().toISOString(),
      stage: null,
      event: 'created',
      note: 'Playbook initialized',
    }],
    flow: null,
    updatedAt: new Date().toISOString(),
  };

  await _kvPut(collection, key, playbook);
  return { id, collection, key };
}

/**
 * Idempotent playbook initializer. If an entry already exists at `id`:
 *   - preserves existing `stages`, `flow`, and accumulated `history`
 *   - appends a `rerun-started` history event marking the re-entry
 *   - refreshes `source` ONLY if the caller passes new markdown — a resume
 *     with no new markdown keeps the original
 *   - bumps `updatedAt`
 * If no entry exists: behaves identically to createPlaybook (writes a
 * fresh one with a `created` history event).
 *
 * Intended for:
 *   - WISER Playbooks kicking off the pipeline with its own id, where the
 *     same id may be run through the pipeline multiple times and the UI
 *     wants a continuous state/history timeline instead of a fresh wipe.
 *   - Pipeline `--resume-from` on an existing playbook without losing
 *     the earlier run's stage snapshots.
 *
 * Return shape extends createPlaybook's with two diagnostic fields:
 *   { id, collection, key, reused: boolean, priorStages: number }
 */
async function ensurePlaybook(markdown, options = {}) {
  const id = options.id || crypto.randomUUID();
  const collection = options.collection || DEFAULT_COLLECTION;
  const key = id;

  const existing = await _kvGet(collection, key);
  const now = new Date().toISOString();

  // Build a merged `config` block:
  //   1. Start with whatever already exists (preserve WISER/external writes)
  //   2. Overlay caller-supplied options.config fields (shallow merge — each
  //      key wins if explicitly set; null/undefined don't overwrite existing)
  // Config is OPTIONAL at every level; downstream readers fall back to body
  // params or defaults when a field isn't set here.
  function mergeConfig(prior, incoming) {
    const merged = { ...(prior && typeof prior === 'object' ? prior : {}) };
    if (incoming && typeof incoming === 'object') {
      for (const [k, v] of Object.entries(incoming)) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
    }
    return merged;
  }

  if (!existing || typeof existing !== 'object') {
    // No prior entry — behave like createPlaybook, with optional config.
    const playbook = {
      id,
      source: {
        markdown: markdown || '',
        originalPath: options.originalPath || null,
        createdAt: now,
      },
      config: mergeConfig(null, options.config),
      stages: {},
      history: [{ at: now, stage: null, event: 'created', note: 'Playbook initialized' }],
      flow: null,
      updatedAt: now,
    };
    await _kvPut(collection, key, playbook);
    return { id, collection, key, reused: false, priorStages: 0 };
  }

  // Re-entry: preserve stages/flow/history/config, append a rerun event.
  // Top-level spread preserves any fields we don't explicitly overwrite —
  // including ones added by WISER or other producers we don't know about.
  const priorStages = existing.stages && typeof existing.stages === 'object'
    ? Object.keys(existing.stages).length : 0;
  const updated = {
    ...existing,
    source: {
      markdown: markdown && markdown.length > 0
        ? markdown
        : (existing.source?.markdown || ''),
      originalPath: options.originalPath || existing.source?.originalPath || null,
      createdAt: existing.source?.createdAt || now,
      // Re-runs append a rerunAt marker for the UI to display "last rerun at..."
      rerunAt: now,
    },
    config: mergeConfig(existing.config, options.config),
    history: Array.isArray(existing.history) ? [...existing.history] : [],
    updatedAt: now,
  };
  updated.history.push({
    at: now,
    stage: null,
    event: 'rerun-started',
    note: `Pipeline re-entered with same id; ${priorStages} prior stage(s) preserved`,
  });
  await _kvPut(collection, key, updated);
  return { id, collection, key, reused: true, priorStages };
}

/**
 * Fetch the current playbook state.
 * @returns {Promise<object|null>} - null if not found
 */
async function getPlaybook(id, collection = DEFAULT_COLLECTION, key = id) {
  if (!id) throw new Error('getPlaybook: id is required');
  return _kvGet(collection, key || id);
}

/**
 * Set or merge a stage's result into the playbook.
 *
 * @param {object} handle - { id, collection, key }
 * @param {string} stageName
 * @param {object} patch - fields to merge into the stage entry
 *   common keys: { status: 'running'|'done'|'error', data: {...} }
 *   startedAt / completedAt auto-set based on transitions.
 */
async function updateStage(handle, stageName, patch) {
  const { id, collection = DEFAULT_COLLECTION, key = id } = handle;
  if (!id || !stageName) throw new Error('updateStage: id + stageName required');

  const current = await _kvGet(collection, key);
  if (!current) throw new Error(`updateStage: playbook ${id} not found in KV`);

  const now = new Date().toISOString();
  const prev = current.stages[stageName] || {};
  const merged = { ...prev, ...patch };

  // Auto-timestamps based on status transitions
  if (patch.status === 'running' && !prev.startedAt) merged.startedAt = now;
  if ((patch.status === 'done' || patch.status === 'error') && !prev.completedAt) {
    merged.completedAt = now;
    if (prev.startedAt) {
      try {
        merged.durationMs = new Date(now).getTime() - new Date(prev.startedAt).getTime();
      } catch {}
    }
  }

  current.stages[stageName] = merged;
  current.updatedAt = now;

  // Append history for status transitions
  if (patch.status) {
    current.history.push({
      at: now,
      stage: stageName,
      event: patch.status,
      note: patch.note || null,
    });
  }

  await _kvPut(collection, key, current);
  return current.stages[stageName];
}

/**
 * Append an audit entry to history without touching any stage.
 */
async function appendHistory(handle, entry) {
  const { id, collection = DEFAULT_COLLECTION, key = id } = handle;
  const current = await _kvGet(collection, key);
  if (!current) throw new Error(`appendHistory: playbook ${id} not found`);
  current.history.push({
    at: new Date().toISOString(),
    stage: entry.stage || null,
    event: entry.event || 'note',
    note: entry.note || '',
  });
  current.updatedAt = new Date().toISOString();
  await _kvPut(collection, key, current);
  return current.history.length;
}

/**
 * Set or update the playbook's current pipeline job pointer.
 *
 * WISER UI reads `playbook.job.id` to know which pipeline run is currently
 * processing this playbook (or which one last ran). The `.pipeline-jobs/<id>/`
 * directory on the orchestrator machine holds the full local artifacts for
 * that run; `playbook.job.id` is the pointer that lets a caller locate them.
 *
 * Called:
 *   - At pipeline start — status: 'running', startedAt set
 *   - At pipeline end   — status: 'completed' | 'failed', completedAt set
 *   - On --resume-from  — records resumeFrom + increments outerAttempts
 *
 * Extensibility-safe: uses shallow merge so fields we don't set here are
 * preserved (e.g. a WISER-written `job.externalRef` would survive).
 */
async function setJob(handle, jobPatch) {
  const { id, collection = DEFAULT_COLLECTION, key = id } = handle;
  const current = await _kvGet(collection, key);
  if (!current) throw new Error(`setJob: playbook ${id} not found`);
  const prior = (current.job && typeof current.job === 'object') ? current.job : {};

  // Historical-jobs archiving: when a NEW pipeline job starts (i.e. the
  // patch provides a new .id that differs from the prior .id AND the prior
  // job reached a terminal state), archive the prior job into jobs[] before
  // overwriting. This gives WISER UI a "past runs" list without losing the
  // current-job pointer (playbook.job stays the authoritative "latest").
  //
  // Cap: keep last 20 jobs to bound KV payload size.
  if (jobPatch && jobPatch.id && prior.id && jobPatch.id !== prior.id) {
    const isTerminal = prior.status === 'completed' || prior.status === 'failed';
    if (isTerminal) {
      if (!Array.isArray(current.jobs)) current.jobs = [];
      current.jobs.push({ ...prior, archivedAt: new Date().toISOString() });
      if (current.jobs.length > 20) current.jobs = current.jobs.slice(-20);
    }
  }

  const merged = { ...prior };
  for (const [k, v] of Object.entries(jobPatch || {})) {
    if (v !== undefined) merged[k] = v;
  }
  current.job = merged;
  current.updatedAt = new Date().toISOString();
  await _kvPut(collection, key, current);
  return current.job;
}

/**
 * Set the final deployment summary after splice + activation.
 */
async function setFlowSummary(handle, summary) {
  const { id, collection = DEFAULT_COLLECTION, key = id } = handle;
  const current = await _kvGet(collection, key);
  if (!current) throw new Error(`setFlowSummary: playbook ${id} not found`);
  current.flow = {
    flowId: summary.flowId || null,
    templateId: summary.templateId || null,
    httpPath: summary.httpPath || null,
    studioUrl: summary.studioUrl || null,
    flowVersion: summary.flowVersion || null,
    updatedAt: new Date().toISOString(),
  };
  current.updatedAt = new Date().toISOString();
  await _kvPut(collection, key, current);
  return current.flow;
}

/**
 * Get a stage's data (convenience getter).
 */
async function getStage(handle, stageName) {
  const playbook = await getPlaybook(handle.id, handle.collection, handle.key);
  return playbook?.stages?.[stageName] || null;
}

module.exports = {
  createPlaybook,
  ensurePlaybook,
  getPlaybook,
  updateStage,
  appendHistory,
  setFlowSummary,
  setJob,
  getStage,
  DEFAULT_COLLECTION,
};
