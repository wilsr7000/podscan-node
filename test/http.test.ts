import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient, PodscanError } from '../src/http.js';
import { mockFetch } from './helpers.js';

describe('HttpClient', () => {
  let restore: () => void;

  afterEach(() => {
    restore?.();
  });

  // -----------------------------------------------------------------------
  // Constructor defaults
  // -----------------------------------------------------------------------

  it('uses default base URL and timeout', async () => {
    const mock = mockFetch({ body: { ok: true } });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'test-key' });
    await client.get('/test');

    assert.equal(mock.captured.length, 1);
    assert.ok(mock.captured[0].url.startsWith('https://podscan.fm/api/v1/test'));
  });

  it('allows overriding base URL', async () => {
    const mock = mockFetch({ body: { ok: true } });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key', baseUrl: 'https://custom.api.com/v2' });
    await client.get('/foo');

    assert.ok(mock.captured[0].url.startsWith('https://custom.api.com/v2/foo'));
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  it('sends Bearer token in Authorization header', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'sk_secret_123' });
    await client.get('/test');

    assert.equal(mock.captured[0].headers['Authorization'], 'Bearer sk_secret_123');
  });

  it('sends correct Content-Type and Accept headers', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    await client.get('/test');

    assert.equal(mock.captured[0].headers['Content-Type'], 'application/json');
    assert.equal(mock.captured[0].headers['Accept'], 'application/json');
  });

  // -----------------------------------------------------------------------
  // GET requests with query params
  // -----------------------------------------------------------------------

  it('sends GET request with no params', async () => {
    const mock = mockFetch({ body: { data: 'hello' } });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    const result = await client.get<{ data: string }>('/endpoint');

    assert.equal(result.data, 'hello');
    assert.equal(mock.captured[0].method, 'GET');
  });

  it('serializes query parameters into URL', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    await client.get('/search', { query: 'AI marketing', page: 2, has_guests: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.searchParams.get('query'), 'AI marketing');
    assert.equal(url.searchParams.get('page'), '2');
    assert.equal(url.searchParams.get('has_guests'), 'true');
  });

  it('skips undefined and null query params', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    await client.get('/search', { query: 'test', language: undefined, region: null });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.searchParams.get('query'), 'test');
    assert.equal(url.searchParams.has('language'), false);
    assert.equal(url.searchParams.has('region'), false);
  });

  // -----------------------------------------------------------------------
  // POST requests
  // -----------------------------------------------------------------------

  it('sends POST request with JSON body', async () => {
    const mock = mockFetch({ body: { id: 'al_123' } });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    const result = await client.post<{ id: string }>('/alerts', { name: 'Test', filters: '"brand"' });

    assert.equal(result.id, 'al_123');
    assert.equal(mock.captured[0].method, 'POST');
    const sentBody = JSON.parse(mock.captured[0].body!);
    assert.equal(sentBody.name, 'Test');
    assert.equal(sentBody.filters, '"brand"');
  });

  it('sends POST request without body', async () => {
    const mock = mockFetch({ body: { ok: true } });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    await client.post('/action');

    assert.equal(mock.captured[0].method, 'POST');
    assert.equal(mock.captured[0].body, null);
  });

  // -----------------------------------------------------------------------
  // Rate limit header parsing
  // -----------------------------------------------------------------------

  it('parses rate limit headers from response', async () => {
    const mock = mockFetch({
      body: {},
      headers: {
        'x-ratelimit-limit': '2000',
        'x-ratelimit-remaining': '1995',
        'x-ratelimit-used': '5',
        'x-ratelimit-reset': '2026-02-17T00:00:00Z',
      },
    });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    assert.equal(client.rateLimit, null);

    await client.get('/test');

    assert.deepEqual(client.rateLimit, {
      limit: 2000,
      remaining: 1995,
      used: 5,
      resetsAt: '2026-02-17T00:00:00Z',
    });
  });

  it('rate limit is null when no headers present', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });
    await client.get('/test');

    assert.equal(client.rateLimit, null);
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  it('throws PodscanError on 4xx with API error body', async () => {
    const mock = mockFetch({
      status: 429,
      body: {
        error: true,
        code: 'quota_exceeded',
        message: 'Daily API quota exceeded (2000/2000)',
        details: { daily_used: 2000, daily_limit: 2000 },
      },
    });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });

    await assert.rejects(() => client.get('/test'), (err: unknown) => {
      assert.ok(err instanceof PodscanError);
      assert.equal(err.code, 'quota_exceeded');
      assert.equal(err.message, 'Daily API quota exceeded (2000/2000)');
      assert.equal(err.status, 429);
      assert.deepEqual(err.details, { daily_used: 2000, daily_limit: 2000 });
      return true;
    });
  });

  it('throws PodscanError on 5xx without body', async () => {
    const mock = mockFetch({ status: 500, body: null });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });

    await assert.rejects(() => client.get('/test'), (err: unknown) => {
      assert.ok(err instanceof PodscanError);
      assert.equal(err.code, 'api_error');
      assert.equal(err.status, 500);
      return true;
    });
  });

  it('throws PodscanError on network failure', async () => {
    const mock = mockFetch({ throwError: new TypeError('Failed to fetch') });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key' });

    await assert.rejects(() => client.get('/test'), (err: unknown) => {
      assert.ok(err instanceof PodscanError);
      assert.equal(err.code, 'network_error');
      assert.equal(err.message, 'Failed to fetch');
      assert.equal(err.status, 0);
      return true;
    });
  });

  it('throws PodscanError on timeout (AbortError)', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    const mock = mockFetch({ throwError: abortError });
    restore = mock.restore;

    const client = new HttpClient({ apiKey: 'key', timeout: 5000 });

    await assert.rejects(() => client.get('/test'), (err: unknown) => {
      assert.ok(err instanceof PodscanError);
      assert.equal(err.code, 'timeout');
      assert.ok(err.message.includes('5000'));
      assert.equal(err.status, 0);
      return true;
    });
  });

  // -----------------------------------------------------------------------
  // PodscanError
  // -----------------------------------------------------------------------

  it('PodscanError extends Error with correct name', () => {
    const err = new PodscanError({
      code: 'not_found',
      message: 'Podcast not found',
      status: 404,
    });

    assert.ok(err instanceof Error);
    assert.ok(err instanceof PodscanError);
    assert.equal(err.name, 'PodscanError');
    assert.equal(err.code, 'not_found');
    assert.equal(err.message, 'Podcast not found');
    assert.equal(err.status, 404);
    assert.equal(err.details, undefined);
  });
});
