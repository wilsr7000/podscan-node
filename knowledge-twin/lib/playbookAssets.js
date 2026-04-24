// ---------------------------------------------------------------------------
// playbookAssets.js — the one-and-only write path for attaching a derived
// artifact to a WISER playbook.
//
// CONTRACT — mirrors the WISER Playbook Service (cf. WISER's
// wiserPlaybookService.ts in the AI First Notes project):
//
//   1. Playbooks live in BOTH:
//        - KeyValue (authoritative body — the full playbook JSON including
//          its `assets: NoteAsset[]` array)
//        - OmniGraph / Neo4j (authoritative index — Playbook node + edges
//          to tickets, derivatives, spaces, etc.)
//   2. Assets DO NOT become separate graph nodes. They live INSIDE
//      `playbook.assets` in KV. The graph only tracks the playbook node
//      + its relationships; the asset array travels along in the KV body.
//   3. Every write goes through this module so the KV + graph stay in
//      sync. Fire-and-forget on the graph side — KV is authoritative, so
//      a failed graph sync retries on the next mutation.
//
// WHY THIS EXISTS — every flow in the step-building pipeline (decompose,
// conceive, generateCode, testStep, designUI, testWithUI, spawnTestHarness)
// produces a derived artifact for the source playbook: a detailed plan,
// a step spec, generated code, test results, a UI schema, a live flow URL.
// Today those artifacts are written ad-hoc under `playbook.stages.<stage>`
// or not at all. Moving them onto `playbook.assets` via this helper gives:
//
//   - ONE shape for all derived outputs (browsable in WISER UI)
//   - Graph visibility (the WISER graph traversal can hydrate them)
//   - Deduplication by asset id (re-runs replace, don't pile up)
//   - A single audit trail for "what has this pipeline produced?"
//
// USAGE — the most common path:
//
//   const { addPlaybookAsset } = require('./playbookAssets');
//
//   await addPlaybookAsset(playbookId, {
//     id:    `plan:${playbookId}:${jobId}`,        // stable id — re-runs overwrite
//     kind:  'detailed-plan',                      // pipeline stage / artifact type
//     title: 'Detailed plan (decompose)',
//     content: bestPlan,                           // human-readable body (markdown / JSON)
//     data: { initialScore, bestScore, iterations, extracted, objective },
//     meta: {
//       pipelineStage: 'decompose',
//       pipelineJobId: jobId,
//       generatedAt: new Date().toISOString(),
//     },
//   });
//
// Every pipeline stage can call this with a consistent shape. The function
// handles KV read → merge-by-id → KV write → graph sync → return updated
// playbook.
//
// The helper is also exported as `buildAsset(kind, params)` for callers that
// just want the shape without writing — e.g. batching multiple assets into
// one call.
// ---------------------------------------------------------------------------

'use strict';

const ACCOUNT_ID = process.env.ONEREACH_ACCOUNT_ID || '35254342-4a2e-475b-aec1-18547e517e29';
const BASE_URL = `https://em.edison.api.onereach.ai/http/${ACCOUNT_ID}`;

// Playbooks live in the 'riff:sheets' KV collection (verified against the
// live graph: Playbook.kv_collection === 'riff:sheets'). The Playbook schema
// version at time of writing is 2.0.0 — propagated to new graph writes so
// consumers can detect schema drift.
const KV_COLLECTION_DEFAULT = 'riff:sheets';
const PLAYBOOK_SCHEMA_VERSION = '2.0.0';

// Neo4j Cypher Proxy flow path — deployed via deploy-neo4j-proxy.js. The
// proxy accepts { cypher, parameters } and returns { records, summary }.
const GRAPH_PROXY_PATH = process.env.PLAYBOOK_GRAPH_PROXY_PATH || 'omnidata/neon';
const GRAPH_PROXY_URL = `${BASE_URL}/${GRAPH_PROXY_PATH.replace(/^\//, '')}`;

// ---------------------------------------------------------------------------
// Low-level KV read/write. Matches playbookStore's HTTP contract.
// ---------------------------------------------------------------------------
async function kvGet(collection, key) {
  const url = `${BASE_URL}/keyvalue?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(key)}`;
  const resp = await fetch(url, { headers: { accept: 'application/json' } });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`KV get failed: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }
  const body = await resp.json().catch(() => null);
  // Edison's KV wraps values as `{ value, ... }` or returns the raw value
  if (body && typeof body === 'object' && 'value' in body && Object.keys(body).length <= 3) {
    return body.value;
  }
  return body;
}

async function kvPut(collection, key, value) {
  const url = `${BASE_URL}/keyvalue`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: collection, key, value }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`KV put failed: HTTP ${resp.status} — ${txt.slice(0, 200)}`);
  }
  return resp.json().catch(() => ({}));
}

// ---------------------------------------------------------------------------
// mergeAssets — merge by id, later entries win. Unseen ids append.
// Mirrors the WISER service's mergeAssets helper exactly so behavior is
// consistent between front-end writes and pipeline writes.
// ---------------------------------------------------------------------------
function mergeAssets(existing, incoming) {
  const existingArr = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return existingArr;
  const byId = new Map();
  for (const a of existingArr) {
    if (a && typeof a === 'object' && a.id) byId.set(a.id, a);
  }
  for (const a of incoming) {
    if (!a || typeof a !== 'object' || !a.id) continue;
    byId.set(a.id, a);
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// buildAsset — canonical shape constructor. Callers pass the fields that
// matter to their kind; this fills in timestamps and enforces the shape.
// Use this when you want to build + pass to a batch write.
//
// Shape:
//   {
//     id:       string (required — stable across re-runs)
//     kind:     string (required — 'detailed-plan' | 'step-spec' |
//                       'generated-code' | 'test-results' | 'ui-schema' |
//                       'deployed-flow-ref' | custom)
//     title?:   string (human-readable label)
//     content?: string (human-readable body, typically markdown/text)
//     data?:    any    (structured data keyed to `kind`)
//     meta?:    { pipelineStage, pipelineJobId, generatedAt, ... }
//   }
// ---------------------------------------------------------------------------
function buildAsset({ id, kind, title, content, data, meta } = {}) {
  if (typeof id !== 'string' || !id) throw new Error('buildAsset: id is required and must be a non-empty string');
  if (typeof kind !== 'string' || !kind) throw new Error('buildAsset: kind is required and must be a non-empty string');
  return {
    id,
    kind,
    title: typeof title === 'string' ? title : undefined,
    content: typeof content === 'string' ? content : undefined,
    data: (data !== undefined && data !== null) ? data : undefined,
    meta: {
      generatedAt: new Date().toISOString(),
      ...(meta && typeof meta === 'object' ? meta : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// syncPlaybookToGraph — fire-and-forget Cypher write via the Neo4j Cypher
// Proxy flow. Updates the Playbook node's timestamps + asset-count
// properties so the graph stays approximately in sync with KV.
//
// Follows the user's preferred pattern: inline Cypher, fire-and-forget,
// failure is logged but doesn't break the write path. KV is authoritative.
// ---------------------------------------------------------------------------
async function syncPlaybookToGraph(playbook, { log = console.log, timeoutMs = 15000 } = {}) {
  if (!playbook || typeof playbook !== 'object' || !playbook.id) {
    log('[playbookAssets:graph] skip — no playbook.id');
    return { ok: false, reason: 'no-id' };
  }

  // Property names below MUST match the live Playbook schema in NEON
  // (discovered via `MATCH (p:Playbook) RETURN keys(p)`):
  //   - `spaceId` (NOT `spacesSpaceId`)
  //   - `updated_at` in epoch millis (not ISO string)
  //   - `kv_ref` as the full HTTPS URL to the KV endpoint (not a path)
  //   - `kv_collection` kept in sync with the collection used for writes
  //   - `schema_version` stamped at 2.0.0 for drift detection
  //
  // We don't invent properties (no more `assetCount`). The count lives on
  // the KV body; the graph indexes identity + location only.
  const nowMillis = Date.now();
  const collection = KV_COLLECTION_DEFAULT;
  const kvRefUrl = `${BASE_URL}/keyvalue?id=${encodeURIComponent(collection)}&key=${encodeURIComponent(playbook.id)}`;
  const cypher = `
    MERGE (p:Playbook {id: $playbookId})
    SET p.title          = coalesce($title, p.title),
        p.updated_at     = $updatedAt,
        p.spaceId        = coalesce($spaceId, p.spaceId),
        p.kv_ref         = $kvRef,
        p.kv_collection  = $kvCollection,
        p.schema_version = coalesce(p.schema_version, $schemaVersion)
    RETURN p.id AS id
  `;
  const parameters = {
    playbookId: playbook.id,
    title: playbook.title || null,
    updatedAt: nowMillis,
    spaceId: playbook.spaceId || null,  // Real schema property — NOT spacesSpaceId
    kvRef: kvRefUrl,
    kvCollection: collection,
    schemaVersion: PLAYBOOK_SCHEMA_VERSION,
  };

  try {
    const postResp = await fetch(GRAPH_PROXY_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cypher, parameters }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!postResp.ok) {
      log(`[playbookAssets:graph] proxy POST failed: HTTP ${postResp.status}`);
      return { ok: false, reason: `http-${postResp.status}` };
    }
    const postJson = await postResp.json().catch(() => ({}));
    // Async flow: poll briefly for completion. We don't wait forever — graph
    // sync is fire-and-forget; if it's still pending we return ok and let
    // the next write catch up.
    const jobId = postJson.jobId || postJson.jobID;
    if (!jobId) {
      return { ok: true, sync: 'inline', result: postJson };
    }
    const pollUrl = GRAPH_PROXY_URL + '?jobId=' + encodeURIComponent(jobId) + '&jobID=' + encodeURIComponent(jobId);
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 800));
      const r = await fetch(pollUrl);
      const txt = await r.text().catch(() => '');
      let p = null; try { p = JSON.parse(txt); } catch {}
      if (p && !(typeof p.status === 'string' && /start|pending|running/i.test(p.status))) {
        return { ok: true, sync: 'polled', result: p };
      }
    }
    return { ok: true, sync: 'fire-and-forget', jobId };
  } catch (err) {
    log(`[playbookAssets:graph] sync threw (non-fatal): ${err.message}`);
    return { ok: false, reason: 'threw', error: err.message };
  }
}

// ---------------------------------------------------------------------------
// fetchPlaybook — read the playbook body from KV by id.
//
// Checks the `playbooks` collection by default. Returns null when the
// playbook isn't present. Does NOT touch the graph — this is a body read.
// ---------------------------------------------------------------------------
async function fetchPlaybook(playbookId, { collection = KV_COLLECTION_DEFAULT } = {}) {
  if (typeof playbookId !== 'string' || !playbookId) {
    throw new Error('fetchPlaybook: playbookId required');
  }
  const raw = await kvGet(collection, playbookId);
  if (!raw) return null;
  return (typeof raw === 'object' && raw !== null) ? raw : null;
}

// ---------------------------------------------------------------------------
// addPlaybookAsset — append or update a single asset on a playbook.
//
// The canonical entry point. Every stage / flow that produces a derived
// artifact calls this with an asset object.
//
// Input:
//   playbookId — string, the playbook's KV key
//   asset      — { id, kind, ...fields } — ids merge; same id replaces
//   options    — { collection, log, syncGraph }
//                  - collection: KV collection (default 'playbooks')
//                  - log: logger (default console.log)
//                  - syncGraph: false to skip graph write (default true)
//
// Output:
//   { ok, playbook, assetId, synced: boolean, reason? }
//
// Failure modes:
//   - Playbook not in KV → { ok: false, reason: 'not-found' }
//   - Asset shape invalid → throws
//   - KV write fails → throws (KV is authoritative; can't recover silently)
//   - Graph sync fails → logged, { synced: false } but ok still true
// ---------------------------------------------------------------------------
async function addPlaybookAsset(playbookId, asset, options = {}) {
  const {
    collection = KV_COLLECTION_DEFAULT,
    log = console.log,
    syncGraph = true,
  } = options;

  if (typeof playbookId !== 'string' || !playbookId) {
    throw new Error('addPlaybookAsset: playbookId required');
  }
  if (!asset || typeof asset !== 'object' || !asset.id || !asset.kind) {
    throw new Error('addPlaybookAsset: asset must be an object with { id, kind, ... }');
  }

  log(`[playbookAssets] fetching ${collection}/${playbookId}...`);
  const current = await fetchPlaybook(playbookId, { collection });
  if (!current) {
    log(`[playbookAssets] playbook ${playbookId} not found in ${collection} — skipping asset attach`);
    return { ok: false, reason: 'not-found' };
  }

  const existingAssets = Array.isArray(current.assets) ? current.assets : [];
  const updatedAssets = mergeAssets(existingAssets, [asset]);

  const updated = {
    ...current,
    assets: updatedAssets,
    updated_at: Date.now(),  // epoch millis — matches graph schema convention
  };

  log(`[playbookAssets] writing ${collection}/${playbookId} with ${updatedAssets.length} asset(s) (merged ${asset.kind}:${asset.id})`);
  await kvPut(collection, playbookId, updated);

  let synced = false;
  let syncResult = null;
  if (syncGraph) {
    syncResult = await syncPlaybookToGraph(updated, { log });
    synced = syncResult.ok === true;
  }

  return {
    ok: true,
    playbook: updated,
    assetId: asset.id,
    synced,
    syncResult,
  };
}

// ---------------------------------------------------------------------------
// addPlaybookAssets — batch variant. Takes an array of assets, merges all
// in one KV round-trip + one graph sync.
// ---------------------------------------------------------------------------
async function addPlaybookAssets(playbookId, assets, options = {}) {
  const {
    collection = KV_COLLECTION_DEFAULT,
    log = console.log,
    syncGraph = true,
  } = options;

  if (typeof playbookId !== 'string' || !playbookId) {
    throw new Error('addPlaybookAssets: playbookId required');
  }
  if (!Array.isArray(assets) || assets.length === 0) {
    return { ok: true, playbook: null, assetIds: [], synced: false, reason: 'no-assets' };
  }
  for (const a of assets) {
    if (!a || typeof a !== 'object' || !a.id || !a.kind) {
      throw new Error('addPlaybookAssets: every asset must be { id, kind, ... }');
    }
  }

  const current = await fetchPlaybook(playbookId, { collection });
  if (!current) {
    log(`[playbookAssets] playbook ${playbookId} not found — skipping batch attach`);
    return { ok: false, reason: 'not-found' };
  }

  const existingAssets = Array.isArray(current.assets) ? current.assets : [];
  const updatedAssets = mergeAssets(existingAssets, assets);

  const updated = {
    ...current,
    assets: updatedAssets,
    updated_at: Date.now(),
  };

  log(`[playbookAssets] writing ${collection}/${playbookId} with ${updatedAssets.length} asset(s) (+${assets.length} new, kinds: ${[...new Set(assets.map((a) => a.kind))].join(',')})`);
  await kvPut(collection, playbookId, updated);

  let synced = false;
  let syncResult = null;
  if (syncGraph) {
    syncResult = await syncPlaybookToGraph(updated, { log });
    synced = syncResult.ok === true;
  }

  return {
    ok: true,
    playbook: updated,
    assetIds: assets.map((a) => a.id),
    synced,
    syncResult,
  };
}

// ---------------------------------------------------------------------------
// getPlaybookAsset — read a single asset by id off a playbook. Used by
// downstream stages to pick up what an earlier stage produced.
// ---------------------------------------------------------------------------
async function getPlaybookAsset(playbookId, assetId, options = {}) {
  const { collection = KV_COLLECTION_DEFAULT } = options;
  const pb = await fetchPlaybook(playbookId, { collection });
  if (!pb) return null;
  return (pb.assets || []).find((a) => a.id === assetId) || null;
}

// ---------------------------------------------------------------------------
// listPlaybookAssets — read all assets, optionally filtered by kind.
// ---------------------------------------------------------------------------
async function listPlaybookAssets(playbookId, { kind, collection = KV_COLLECTION_DEFAULT } = {}) {
  const pb = await fetchPlaybook(playbookId, { collection });
  if (!pb) return [];
  const assets = pb.assets || [];
  return typeof kind === 'string' ? assets.filter((a) => a.kind === kind) : assets;
}

// ---------------------------------------------------------------------------
// Standard asset-id helpers — use these so every stage produces consistent,
// discoverable ids. Pattern: `<kind>:<playbookId>:<scope>`.
// ---------------------------------------------------------------------------
function assetIdFor(kind, playbookId, scope = 'latest') {
  if (typeof kind !== 'string' || !kind) throw new Error('assetIdFor: kind required');
  if (typeof playbookId !== 'string' || !playbookId) throw new Error('assetIdFor: playbookId required');
  const safeScope = String(scope).replace(/[^A-Za-z0-9_-]/g, '_');
  return `${kind}:${playbookId}:${safeScope}`;
}

module.exports = {
  // Read
  fetchPlaybook,
  getPlaybookAsset,
  listPlaybookAssets,
  // Write
  addPlaybookAsset,
  addPlaybookAssets,
  // Helpers
  buildAsset,
  mergeAssets,
  assetIdFor,
  syncPlaybookToGraph,
  // Schema constants — exported for consumers building against the
  // canonical Playbook shape.
  PLAYBOOK_SCHEMA_VERSION,
  KV_COLLECTION_DEFAULT,
  // Exposed for tests only — don't use directly
  _kvGet: kvGet,
  _kvPut: kvPut,
};
