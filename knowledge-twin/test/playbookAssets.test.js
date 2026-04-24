// test/playbookAssets.test.js — tests for the shared playbook-asset helper.
//
// Coverage:
//   - mergeAssets: dedup by id, append unseen
//   - buildAsset: shape enforcement + timestamp injection
//   - assetIdFor: consistent id format
//   - fetchPlaybook / addPlaybookAsset / addPlaybookAssets: full roundtrip
//     through a local HTTP server that impersonates Edison's /keyvalue
//     endpoint and the Neo4j Cypher Proxy
//   - graph sync: fire-and-forget semantics — failure logged, not thrown
//   - shape contract: the playbook that comes back out of KV has the
//     asset merged in place

'use strict';

const http = require('node:http');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// ---------------------------------------------------------------------------
// Mock Edison HTTP server — impersonates both /keyvalue and the Cypher
// proxy path so we can test the real code paths without touching production.
// ---------------------------------------------------------------------------
function mkServer({ kv = new Map(), graphBehavior = 'ok' } = {}) {
  let graphCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');

      // /keyvalue — GET (read) + PUT (write) to match Edison's real shape
      // (NOT POST — POST hits a list endpoint; verified against production).
      if (url.pathname.endsWith('/keyvalue')) {
        if (req.method === 'GET') {
          const id = url.searchParams.get('id');
          const key = url.searchParams.get('key');
          const k = `${id}/${key}`;
          const storedString = kv.get(k);
          if (!storedString) {
            // Edison returns 200 with Status message for not-found, not 404
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ Status: 'No data found.' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ value: storedString }));
          return;
        }
        if (req.method === 'PUT') {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
          // Edison stores `itemValue` (stringified) — NOT `value`
          const id = body.id || url.searchParams.get('id');
          const key = body.key || url.searchParams.get('key');
          const k = `${id}/${key}`;
          const stored = typeof body.itemValue === 'string' ? body.itemValue : JSON.stringify(body.itemValue);
          kv.set(k, stored);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
      }

      // Graph proxy path (async: POST returns jobId, GET polls)
      if (url.pathname.endsWith('/omnidata/neon') || url.pathname.endsWith('/graph-proxy-test')) {
        graphCalls++;
        if (graphBehavior === 'error-500') {
          res.writeHead(500); res.end(JSON.stringify({ error: 'server-err' })); return;
        }
        if (graphBehavior === 'inline-ok') {
          // Synchronous response — no jobId
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ records: [{ id: 'ok' }] }));
          return;
        }
        if (req.method === 'POST') {
          const jobId = 'job-' + graphCalls;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId }));
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ records: [] }));
          return;
        }
      }

      res.writeHead(404); res.end('nope');
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        kv,
        getGraphCalls: () => graphCalls,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// Redirect the helper's Edison URL to the mock server. The helper reads
// from module-scope constants, so we need to clear-and-reload with the
// env vars overridden.
function loadHelperPointingAt(mockServer) {
  delete require.cache[require.resolve('../lib/playbookAssets')];
  const prevAccount = process.env.ONEREACH_ACCOUNT_ID;
  const prevProxy = process.env.PLAYBOOK_GRAPH_PROXY_PATH;

  // The helper builds URLs as `${BASE_URL}/${path}`. We override by
  // monkey-patching the exported constants after require. Cleaner: set
  // an env var the helper reads. Quickest: temporarily rewrite the
  // helper's base URL via a hacky reload + global patch.
  const helper = require('../lib/playbookAssets');
  // Rewrite URLs to the mock via a shim around fetch.
  // All calls in the helper go through global fetch, which we can
  // wrap per-test.
  return { helper, restoreEnv: () => {
    process.env.ONEREACH_ACCOUNT_ID = prevAccount;
    process.env.PLAYBOOK_GRAPH_PROXY_PATH = prevProxy;
  } };
}

// Because the helper builds URLs against the real Edison domain, we
// patch global fetch to rewrite those URLs at the network layer for the
// duration of each test.
function installFetchRewrite(mockUrl) {
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    // Rewrite any call to the Edison domain to our mock
    if (parsed.hostname === 'em.edison.api.onereach.ai') {
      const rewrote = new URL(parsed.pathname + parsed.search, mockUrl);
      return origFetch(rewrote.toString(), init);
    }
    return origFetch(url, init);
  };
  return () => { global.fetch = origFetch; };
}

(async () => {
  console.log('\n== Pure helpers (no network) ==');

  await test('mergeAssets appends unseen ids, replaces same ids', () => {
    delete require.cache[require.resolve('../lib/playbookAssets')];
    const { mergeAssets } = require('../lib/playbookAssets');
    const out = mergeAssets(
      [{ id: 'a', v: 1 }, { id: 'b', v: 2 }],
      [{ id: 'b', v: 99 }, { id: 'c', v: 3 }],
    );
    assertEq(out.length, 3);
    assertEq(out.find((x) => x.id === 'b').v, 99, 'b replaced');
    assertEq(out.find((x) => x.id === 'c').v, 3, 'c appended');
  });

  await test('mergeAssets handles null / empty inputs', () => {
    const { mergeAssets } = require('../lib/playbookAssets');
    assertEq(mergeAssets(null, null).length, 0);
    assertEq(mergeAssets([], null).length, 0);
    assertEq(mergeAssets(null, [{ id: 'x', kind: 'y' }]).length, 1);
  });

  await test('mergeAssets drops malformed incoming (no id)', () => {
    const { mergeAssets } = require('../lib/playbookAssets');
    const out = mergeAssets([{ id: 'a' }], [null, {}, { id: 'b' }, 42]);
    assertEq(out.length, 2, 'only valid entries merged in');
  });

  await test('buildAsset requires id + kind', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    let caught = 0;
    try { buildAsset({}); } catch { caught++; }
    try { buildAsset({ id: 'x' }); } catch { caught++; }
    try { buildAsset({ kind: 'x' }); } catch { caught++; }
    assertEq(caught, 3);
    const a = buildAsset({ id: 'x', kind: 'y' });
    assertEq(a.id, 'x');
    assertEq(a.kind, 'y');
    assert(typeof a.meta.generatedAt === 'string');
  });

  await test('buildAsset preserves custom meta', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    const a = buildAsset({
      id: 'x', kind: 'y', title: 't', content: 'c', data: { foo: 1 },
      meta: { pipelineStage: 'decompose', pipelineJobId: 'job-1' },
    });
    assertEq(a.title, 't');
    assertEq(a.content, 'c');
    assertEq(a.data.foo, 1);
    assertEq(a.meta.pipelineStage, 'decompose');
    assertEq(a.meta.pipelineJobId, 'job-1');
    assert(a.meta.generatedAt, 'generatedAt auto-set');
  });

  await test('assetIdFor produces kind:playbook:scope format', () => {
    const { assetIdFor } = require('../lib/playbookAssets');
    assertEq(assetIdFor('detailed-plan', 'abc-123'), 'detailed-plan:abc-123:latest');
    assertEq(assetIdFor('detailed-plan', 'abc', 'job-42'), 'detailed-plan:abc:job-42');
    // scope sanitized
    assertEq(assetIdFor('foo', 'abc', 'bad/scope with spaces'), 'foo:abc:bad_scope_with_spaces');
  });

  console.log('\n== Full KV round-trip via mock server ==');

  await test('fetchPlaybook returns null for missing playbook', async () => {
    const srv = await mkServer();
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { fetchPlaybook } = require('../lib/playbookAssets');
      const pb = await fetchPlaybook('nope');
      assertEq(pb, null);
    } finally { restore(); await srv.close(); }
  });

  await test('addPlaybookAsset returns not-found when playbook absent', async () => {
    const srv = await mkServer();
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset } = require('../lib/playbookAssets');
      const r = await addPlaybookAsset('missing-id', { id: 'a', kind: 'test' }, { syncGraph: false, log: () => {} });
      assertEq(r.ok, false);
      assertEq(r.reason, 'not-found');
    } finally { restore(); await srv.close(); }
  });

  await test('addPlaybookAsset appends a new asset and persists to KV', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', title: 'Test', assets: [] }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const asset = buildAsset({ id: 'a-1', kind: 'detailed-plan', content: 'plan body' });
      const r = await addPlaybookAsset('pb-1', asset, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.assetId, 'a-1');
      assertEq(r.playbook.assets.length, 1);
      assertEq(r.playbook.assets[0].kind, 'detailed-plan');
      // KV was actually written
      const stored = JSON.parse(kv.get('riff:sheets/pb-1'));
      assertEq(stored.assets.length, 1);
      assertEq(stored.assets[0].id, 'a-1');
      assert(typeof stored.updated_at === 'number', 'updated_at stamped as epoch millis');
      assert(stored.updated_at > Date.now() - 10000, 'updated_at is fresh');
    } finally { restore(); await srv.close(); }
  });

  await test('addPlaybookAsset replaces by id on re-run (same kind:playbookId:jobId)', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({
      id: 'pb-1',
      title: 'Test',
      assets: [{ id: 'a-1', kind: 'detailed-plan', content: 'v1' }],
    }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const asset = buildAsset({ id: 'a-1', kind: 'detailed-plan', content: 'v2' });
      const r = await addPlaybookAsset('pb-1', asset, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.playbook.assets.length, 1, 'still one asset — replaced not appended');
      assertEq(r.playbook.assets[0].content, 'v2');
    } finally { restore(); await srv.close(); }
  });

  await test('addPlaybookAsset validates asset shape — throws on missing id/kind', async () => {
    delete require.cache[require.resolve('../lib/playbookAssets')];
    const { addPlaybookAsset } = require('../lib/playbookAssets');
    let caught = 0;
    try { await addPlaybookAsset('pb', null); } catch { caught++; }
    try { await addPlaybookAsset('pb', { kind: 'x' }); } catch { caught++; }
    try { await addPlaybookAsset('pb', { id: 'x' }); } catch { caught++; }
    try { await addPlaybookAsset('', { id: 'x', kind: 'y' }); } catch { caught++; }
    assertEq(caught, 4);
  });

  await test('addPlaybookAssets batches multiple assets in one KV write', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', title: 'Test', assets: [] }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAssets, buildAsset } = require('../lib/playbookAssets');
      const batch = [
        buildAsset({ id: 'a1', kind: 'detailed-plan', content: 'plan' }),
        buildAsset({ id: 'a2', kind: 'step-spec', content: 'spec' }),
        buildAsset({ id: 'a3', kind: 'generated-code', content: 'code' }),
      ];
      const r = await addPlaybookAssets('pb-1', batch, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.assetIds.length, 3);
      assertEq(r.playbook.assets.length, 3);
      const stored = JSON.parse(kv.get('riff:sheets/pb-1'));
      assertEq(stored.assets.length, 3);
    } finally { restore(); await srv.close(); }
  });

  console.log('\n== Graph sync behavior ==');

  await test('syncGraph:true (default) calls the graph proxy', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', title: 'Test', assets: [] }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const r = await addPlaybookAsset('pb-1', buildAsset({ id: 'a', kind: 'x' }), { log: () => {} });
      assertEq(r.ok, true);
      assert(srv.getGraphCalls() > 0, 'graph proxy was called');
    } finally { restore(); await srv.close(); }
  });

  await test('graph proxy HTTP 500 does NOT fail the write — ok:true, synced:false', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', assets: [] }));
    const srv = await mkServer({ kv, graphBehavior: 'error-500' });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const r = await addPlaybookAsset('pb-1', buildAsset({ id: 'a', kind: 'x' }), { log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.synced, false);
      // KV still written
      assertEq(JSON.parse(kv.get('riff:sheets/pb-1')).assets.length, 1);
    } finally { restore(); await srv.close(); }
  });

  await test('syncGraph:false skips the proxy entirely', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', assets: [] }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      await addPlaybookAsset('pb-1', buildAsset({ id: 'a', kind: 'x' }), { syncGraph: false, log: () => {} });
      assertEq(srv.getGraphCalls(), 0, 'proxy not called');
    } finally { restore(); await srv.close(); }
  });

  console.log('\n== Readers ==');

  await test('getPlaybookAsset returns the matching asset by id', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', assets: [
      { id: 'a1', kind: 'x' }, { id: 'a2', kind: 'y' },
    ]}));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { getPlaybookAsset } = require('../lib/playbookAssets');
      const a = await getPlaybookAsset('pb-1', 'a2');
      assertEq(a.kind, 'y');
      const missing = await getPlaybookAsset('pb-1', 'nope');
      assertEq(missing, null);
    } finally { restore(); await srv.close(); }
  });

  await test('listPlaybookAssets filters by kind', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1', assets: [
      { id: 'a1', kind: 'detailed-plan' },
      { id: 'a2', kind: 'step-spec' },
      { id: 'a3', kind: 'detailed-plan' },
    ]}));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { listPlaybookAssets } = require('../lib/playbookAssets');
      const plans = await listPlaybookAssets('pb-1', { kind: 'detailed-plan' });
      assertEq(plans.length, 2);
      const all = await listPlaybookAssets('pb-1');
      assertEq(all.length, 3);
    } finally { restore(); await srv.close(); }
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
