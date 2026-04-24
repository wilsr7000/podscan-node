// test/playbookAssets.test.js — tests for the shared playbook-asset helper.
//
// Enforces the CANONICAL WISER NoteAsset shape (discovered by inspecting
// real assets in KV):
//
//   { id, type, name, data, createdAt, derivedFrom?, derivativeFormat?, prompt? }
//
// Old shape ({ kind, title, content, data: <object>, meta }) is no longer
// accepted — those field names aren't what WISER's UI renders against and
// caused `Cannot read properties of undefined (reading 'color')` crashes.
//
// Coverage:
//   - mergeAssets: dedup by id, append unseen
//   - buildAsset: canonical shape enforcement
//   - buildStepBuildingPlaybookAsset: convenience builder for the
//     type=derivative + derivativeFormat=evaluation + name='Step Building Playbook' combo
//   - addPlaybookAsset / addPlaybookAssets: KV round-trip, shape validation
//   - listPlaybookAssets filters by type AND derivativeFormat
//   - Graph sync: fire-and-forget semantics
//   - Edison wire format: PUT with itemValue + stringified value body

'use strict';

const http = require('node:http');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}: ${e.message}\n      ${(e.stack || '').split('\n')[1] || ''}`); failed++; }
}
function assert(c, m) { if (!c) throw new Error(m || 'assert failed'); }
function assertEq(a, b, m) { if (a !== b) throw new Error(`${m}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }

// Canonical WISER NoteAsset factory for tests
function mkValidAsset(overrides = {}) {
  return {
    id: overrides.id || 'test-asset-1',
    type: overrides.type || 'derivative',
    name: overrides.name || 'Test Asset',
    data: overrides.data !== undefined ? overrides.data : '# markdown body',
    createdAt: overrides.createdAt || new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock Edison HTTP server — matches real wire format:
//   PUT  /keyvalue?id=<coll>&key=<key>   body: { id, key, itemValue: <str> }
//   GET  /keyvalue?id=<coll>&key=<key>   → { value: "<stringified>" } | { Status: "No data found." }
// ---------------------------------------------------------------------------
function mkServer({ kv = new Map(), graphBehavior = 'ok' } = {}) {
  let graphCalls = 0;
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname.endsWith('/keyvalue')) {
        if (req.method === 'GET') {
          const k = `${url.searchParams.get('id')}/${url.searchParams.get('key')}`;
          const v = kv.get(k);
          if (!v) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ Status: 'No data found.' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ value: v }));
          return;
        }
        if (req.method === 'PUT') {
          let body = {};
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
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

      if (url.pathname.endsWith('/omnidata/neon')) {
        graphCalls++;
        if (graphBehavior === 'error-500') {
          res.writeHead(500); res.end(JSON.stringify({ error: 'server-err' })); return;
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

function installFetchRewrite(mockUrl) {
  const origFetch = global.fetch;
  global.fetch = async (url, init) => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'em.edison.api.onereach.ai') {
      const rewrote = new URL(parsed.pathname + parsed.search, mockUrl);
      return origFetch(rewrote.toString(), init);
    }
    return origFetch(url, init);
  };
  return () => { global.fetch = origFetch; };
}

(async () => {
  console.log('\n== Pure helpers ==');

  await test('mergeAssets appends unseen ids, replaces same ids', () => {
    delete require.cache[require.resolve('../lib/playbookAssets')];
    const { mergeAssets } = require('../lib/playbookAssets');
    const out = mergeAssets(
      [{ id: 'a', v: 1 }, { id: 'b', v: 2 }],
      [{ id: 'b', v: 99 }, { id: 'c', v: 3 }],
    );
    assertEq(out.length, 3);
    assertEq(out.find((x) => x.id === 'b').v, 99);
    assertEq(out.find((x) => x.id === 'c').v, 3);
  });

  await test('assetIdFor produces kind:playbook:scope format', () => {
    const { assetIdFor } = require('../lib/playbookAssets');
    assertEq(assetIdFor('step-building-playbook', 'abc'), 'step-building-playbook:abc:latest');
    assertEq(assetIdFor('derivative', 'abc', 'job-42'), 'derivative:abc:job-42');
    assertEq(assetIdFor('foo', 'abc', 'bad/scope with spaces'), 'foo:abc:bad_scope_with_spaces');
  });

  console.log('\n== buildAsset — canonical WISER NoteAsset shape ==');

  await test('requires id, type, name, and string data', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    let caught = 0;
    try { buildAsset({}); } catch { caught++; }
    try { buildAsset({ id: 'x' }); } catch { caught++; }
    try { buildAsset({ id: 'x', type: 't' }); } catch { caught++; }
    try { buildAsset({ id: 'x', type: 't', name: 'n' }); } catch { caught++; }  // data missing
    try { buildAsset({ id: 'x', type: 't', name: 'n', data: {} }); } catch { caught++; }  // data is object, not string
    assertEq(caught, 5, 'all 5 invalid shapes rejected');
  });

  await test('accepts minimal canonical shape', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    const a = buildAsset({ id: 'x', type: 'html', name: 'X', data: '<p>body</p>' });
    assertEq(a.id, 'x');
    assertEq(a.type, 'html');
    assertEq(a.name, 'X');
    assertEq(a.data, '<p>body</p>');
    assert(a.createdAt, 'createdAt auto-stamped');
    assert(!('kind' in a), 'no legacy kind field');
    assert(!('title' in a), 'no legacy title field');
    assert(!('content' in a), 'no legacy content field');
    assert(!('meta' in a), 'no legacy meta field');
  });

  await test('derivedFrom as string is normalized to { noteId } object', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    const a = buildAsset({ id: 'x', type: 'derivative', name: 'X', data: 'b', derivedFrom: 'pb-1' });
    assertEq(typeof a.derivedFrom, 'object');
    assertEq(a.derivedFrom.noteId, 'pb-1');
  });

  await test('derivedFrom as object is preserved', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    const a = buildAsset({
      id: 'x', type: 'derivative', name: 'X', data: 'b',
      derivedFrom: { noteId: 'pb-1', noteTitle: 'Title' },
    });
    assertEq(a.derivedFrom.noteId, 'pb-1');
    assertEq(a.derivedFrom.noteTitle, 'Title');
  });

  await test('passes through derivativeFormat + prompt', () => {
    const { buildAsset } = require('../lib/playbookAssets');
    const a = buildAsset({
      id: 'x', type: 'derivative', name: 'X', data: 'b',
      derivativeFormat: 'evaluation',
      prompt: 'Generated via pipeline',
    });
    assertEq(a.derivativeFormat, 'evaluation');
    assertEq(a.prompt, 'Generated via pipeline');
  });

  console.log('\n== buildStepBuildingPlaybookAsset ==');

  await test('produces the canonical Step Building Playbook shape', () => {
    const { buildStepBuildingPlaybookAsset } = require('../lib/playbookAssets');
    const a = buildStepBuildingPlaybookAsset({
      playbookId: 'pb-1',
      playbookTitle: 'My playbook',
      stepLabel: 'Find & Replace Agent',
      markdown: '# Plan body',
      jobId: 'job-42',
    });
    assertEq(a.type, 'derivative');
    assertEq(a.derivativeFormat, 'evaluation');
    assertEq(a.name, 'Step Building Playbook');
    assertEq(a.derivedFrom.noteId, 'pb-1');
    assertEq(a.derivedFrom.noteTitle, 'My playbook');
    assert(a.id.includes('step-building-playbook'));
    assert(a.id.includes('pb-1'));
    assert(a.id.includes('job-42'));
    assert(a.data === '# Plan body');
    assert(a.prompt, 'prompt default populated');
  });

  await test('sanitizes jobId for asset id', () => {
    const { buildStepBuildingPlaybookAsset } = require('../lib/playbookAssets');
    const a = buildStepBuildingPlaybookAsset({
      playbookId: 'pb-1',
      markdown: 'body',
      jobId: 'job/42 with/slashes',
    });
    assert(!/[/ ]/.test(a.id.split(':').pop()), 'jobId slashes/spaces sanitized');
  });

  console.log('\n== KV round-trip (canonical shape) ==');

  await test('addPlaybookAsset rejects non-canonical shapes', async () => {
    delete require.cache[require.resolve('../lib/playbookAssets')];
    const { addPlaybookAsset } = require('../lib/playbookAssets');
    let caught = 0;
    // Missing type
    try { await addPlaybookAsset('pb', { id: 'a', name: 'n', data: 'd' }); } catch { caught++; }
    // Missing name
    try { await addPlaybookAsset('pb', { id: 'a', type: 't', data: 'd' }); } catch { caught++; }
    // data is object not string (old shape)
    try { await addPlaybookAsset('pb', { id: 'a', type: 't', name: 'n', data: { k: 'v' } }); } catch { caught++; }
    // Old shape with kind/content
    try { await addPlaybookAsset('pb', { id: 'a', kind: 'foo', content: 'c' }); } catch { caught++; }
    assertEq(caught, 4);
  });

  await test('append a new Step Building Playbook asset — reads back correctly', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({
      id: 'pb-1', title: 'Test Playbook',
      createdInWiser: true, createdInRiff: true, spaceId: 'unclassified',
    }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildStepBuildingPlaybookAsset } = require('../lib/playbookAssets');
      const asset = buildStepBuildingPlaybookAsset({
        playbookId: 'pb-1',
        playbookTitle: 'Test Playbook',
        stepLabel: 'MyStep',
        markdown: '# Step Build Plan',
        jobId: 'job-42',
      });
      const r = await addPlaybookAsset('pb-1', asset, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.playbook.assets.length, 1);
      const stored = JSON.parse(kv.get('riff:sheets/pb-1'));
      assertEq(stored.assets[0].type, 'derivative');
      assertEq(stored.assets[0].derivativeFormat, 'evaluation');
      assertEq(stored.assets[0].name, 'Step Building Playbook');
      assertEq(stored.assets[0].data, '# Step Build Plan');
      // CRITICAL — createdInWiser/createdInRiff must be preserved
      assertEq(stored.createdInWiser, true, 'createdInWiser preserved');
      assertEq(stored.createdInRiff, true, 'createdInRiff preserved');
      assertEq(stored.spaceId, 'unclassified', 'spaceId preserved');
    } finally { restore(); await srv.close(); }
  });

  await test('replace same-id asset on re-run (idempotent)', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({
      id: 'pb-1',
      assets: [mkValidAsset({ id: 'dup', type: 'derivative', name: 'X', data: 'v1' })],
    }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const a2 = buildAsset({ id: 'dup', type: 'derivative', name: 'X', data: 'v2' });
      const r = await addPlaybookAsset('pb-1', a2, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.playbook.assets.length, 1, 'still one asset — replaced');
      assertEq(r.playbook.assets[0].data, 'v2');
    } finally { restore(); await srv.close(); }
  });

  await test('batch: multiple assets in one KV write', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1' }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAssets, buildAsset } = require('../lib/playbookAssets');
      const batch = [
        buildAsset({ id: 'a1', type: 'derivative', name: 'N1', data: 'd1' }),
        buildAsset({ id: 'a2', type: 'html', name: 'N2', data: 'd2' }),
      ];
      const r = await addPlaybookAssets('pb-1', batch, { syncGraph: false, log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.playbook.assets.length, 2);
    } finally { restore(); await srv.close(); }
  });

  console.log('\n== listPlaybookAssets filters ==');

  await test('filter by type and derivativeFormat', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({
      id: 'pb-1',
      assets: [
        { id: 'a1', type: 'html', name: 'Interview Plan', data: 'x' },
        { id: 'a2', type: 'derivative', name: 'Plan Evaluation', data: 'y', derivativeFormat: 'evaluation' },
        { id: 'a3', type: 'derivative', name: 'Step Building Playbook', data: 'z', derivativeFormat: 'evaluation' },
        { id: 'a4', type: 'derivative', name: 'Other', data: 'w', derivativeFormat: 'summary' },
      ],
    }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { listPlaybookAssets } = require('../lib/playbookAssets');
      assertEq((await listPlaybookAssets('pb-1')).length, 4, 'all 4');
      assertEq((await listPlaybookAssets('pb-1', { type: 'derivative' })).length, 3);
      assertEq((await listPlaybookAssets('pb-1', { type: 'derivative', derivativeFormat: 'evaluation' })).length, 2);
      assertEq((await listPlaybookAssets('pb-1', { derivativeFormat: 'summary' })).length, 1);
    } finally { restore(); await srv.close(); }
  });

  console.log('\n== Graph sync (fire-and-forget) ==');

  await test('graph proxy HTTP 500 does NOT fail the write — ok:true, synced:false', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1' }));
    const srv = await mkServer({ kv, graphBehavior: 'error-500' });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      const r = await addPlaybookAsset('pb-1', buildAsset({ id: 'a', type: 'html', name: 'n', data: 'd' }), { log: () => {} });
      assertEq(r.ok, true);
      assertEq(r.synced, false);
    } finally { restore(); await srv.close(); }
  });

  await test('syncGraph:false skips proxy entirely', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1' }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      await addPlaybookAsset('pb-1', buildAsset({ id: 'a', type: 'html', name: 'n', data: 'd' }), { syncGraph: false, log: () => {} });
      assertEq(srv.getGraphCalls(), 0);
    } finally { restore(); await srv.close(); }
  });

  console.log('\n== Edison wire format (PUT + itemValue) ==');

  await test('kvGet handles { Status: "No data found." }', async () => {
    const srv = await mkServer();  // empty kv
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { fetchPlaybook } = require('../lib/playbookAssets');
      assertEq(await fetchPlaybook('nope'), null);
    } finally { restore(); await srv.close(); }
  });

  await test('kvPut writes PUT with itemValue (not POST with value)', async () => {
    const kv = new Map();
    kv.set('riff:sheets/pb-1', JSON.stringify({ id: 'pb-1' }));
    const srv = await mkServer({ kv });
    const restore = installFetchRewrite(srv.url);
    try {
      delete require.cache[require.resolve('../lib/playbookAssets')];
      const { addPlaybookAsset, buildAsset } = require('../lib/playbookAssets');
      await addPlaybookAsset('pb-1', buildAsset({ id: 'a', type: 'html', name: 'n', data: 'd' }), { syncGraph: false, log: () => {} });
      const stored = kv.get('riff:sheets/pb-1');
      assert(typeof stored === 'string', 'stored value is a string (itemValue)');
      const parsed = JSON.parse(stored);
      assert(Array.isArray(parsed.assets) && parsed.assets.length === 1);
    } finally { restore(); await srv.close(); }
  });

  console.log(`\n---\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
