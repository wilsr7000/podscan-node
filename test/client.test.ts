import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { PodscanClient } from '../src/client.js';
import { PodscanError } from '../src/http.js';
import { EpisodesResource } from '../src/resources/episodes.js';
import { PodcastsResource } from '../src/resources/podcasts.js';
import { AlertsResource } from '../src/resources/alerts.js';
import { TopicsResource } from '../src/resources/topics.js';
import { EntitiesResource } from '../src/resources/entities.js';
import { ListsResource } from '../src/resources/lists.js';
import { PublishersResource } from '../src/resources/publishers.js';
import { mockFetch, mockFetchSequence } from './helpers.js';

describe('PodscanClient', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  // -----------------------------------------------------------------------
  // Resource composition
  // -----------------------------------------------------------------------

  it('exposes all 7 resource properties', () => {
    const mock = mockFetch();
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });

    assert.ok(client.episodes instanceof EpisodesResource);
    assert.ok(client.podcasts instanceof PodcastsResource);
    assert.ok(client.alerts instanceof AlertsResource);
    assert.ok(client.topics instanceof TopicsResource);
    assert.ok(client.entities instanceof EntitiesResource);
    assert.ok(client.lists instanceof ListsResource);
    assert.ok(client.publishers instanceof PublishersResource);
  });

  // -----------------------------------------------------------------------
  // Rate limit passthrough
  // -----------------------------------------------------------------------

  it('rateLimit is null before any request', () => {
    const mock = mockFetch();
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });
    assert.equal(client.rateLimit, null);
  });

  it('rateLimit is populated after a request', async () => {
    const mock = mockFetch({
      body: { episodes: [], pagination: { total: 0 } },
      headers: {
        'x-ratelimit-limit': '2000',
        'x-ratelimit-remaining': '1999',
        'x-ratelimit-used': '1',
        'x-ratelimit-reset': '2026-02-17T00:00:00Z',
      },
    });
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });
    await client.episodes.search({ query: 'test' });

    assert.deepEqual(client.rateLimit, {
      limit: 2000,
      remaining: 1999,
      used: 1,
      resetsAt: '2026-02-17T00:00:00Z',
    });
  });

  it('rateLimit updates after each request', async () => {
    const mock = mockFetchSequence([
      {
        body: { episodes: [], pagination: { total: 0 } },
        headers: {
          'x-ratelimit-limit': '2000',
          'x-ratelimit-remaining': '1999',
          'x-ratelimit-used': '1',
        },
      },
      {
        body: { podcasts: [], pagination: { total: 0 } },
        headers: {
          'x-ratelimit-limit': '2000',
          'x-ratelimit-remaining': '1998',
          'x-ratelimit-used': '2',
        },
      },
    ]);
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });

    await client.episodes.search({ query: 'test' });
    assert.equal(client.rateLimit?.remaining, 1999);

    await client.podcasts.search({ query: 'test' });
    assert.equal(client.rateLimit?.remaining, 1998);
  });

  // -----------------------------------------------------------------------
  // End-to-end flow
  // -----------------------------------------------------------------------

  it('full workflow: search, get episode', async () => {
    const mock = mockFetchSequence([
      {
        body: {
          episodes: [
            {
              episode_id: 'ep_found',
              episode_title: 'AI Today',
              episode_duration: 3600,
            },
          ],
          pagination: { total: 1, per_page: 25, current_page: 1, last_page: 1 },
        },
        headers: { 'x-ratelimit-remaining': '1997' },
      },
      {
        body: {
          episode: {
            episode_id: 'ep_found',
            episode_title: 'AI Today',
            episode_duration: 3600,
            episode_description: 'About AI',
          },
        },
        headers: { 'x-ratelimit-remaining': '1996' },
      },
    ]);
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });

    const searchResults = await client.episodes.search({ query: 'artificial intelligence' });
    assert.equal(searchResults.episodes.length, 1);
    assert.equal(searchResults.episodes[0].episode_id, 'ep_found');
    assert.equal(searchResults.pagination.total, 1);

    const episode = await client.episodes.get({ episode_id: 'ep_found' });
    assert.equal(episode.episode.episode_description, 'About AI');

    assert.equal(mock.captured.length, 2);
    assert.equal(client.rateLimit?.remaining, 1996);
  });

  // -----------------------------------------------------------------------
  // Error propagation
  // -----------------------------------------------------------------------

  it('API errors propagate through resources', async () => {
    const mock = mockFetch({
      status: 404,
      body: { error: 'Not found. Check your request and try again.' },
    });
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key' });

    await assert.rejects(
      () => client.episodes.get({ episode_id: 'ep_nonexistent' }),
      (err: unknown) => {
        assert.ok(err instanceof PodscanError);
        assert.equal(err.status, 404);
        return true;
      },
    );
  });

  // -----------------------------------------------------------------------
  // Configuration options
  // -----------------------------------------------------------------------

  it('accepts custom baseUrl', async () => {
    const mock = mockFetch({ body: {} });
    restore = mock.restore;

    const client = new PodscanClient({
      apiKey: 'key',
      baseUrl: 'https://staging.podscan.fm/api/v1',
    });
    await client.episodes.search({ query: 'test' });

    assert.ok(mock.captured[0].url.startsWith('https://staging.podscan.fm/api/v1'));
  });

  it('accepts custom timeout', async () => {
    const abortError = new DOMException('Aborted', 'AbortError');
    const mock = mockFetch({ throwError: abortError });
    restore = mock.restore;

    const client = new PodscanClient({ apiKey: 'key', timeout: 5000 });

    await assert.rejects(
      () => client.episodes.search({ query: 'test' }),
      (err: unknown) => {
        assert.ok(err instanceof PodscanError);
        assert.equal(err.code, 'timeout');
        assert.ok(err.message.includes('5000'));
        return true;
      },
    );
  });
});

// ==========================================================================
// Barrel exports
// ==========================================================================

describe('Package exports', () => {
  it('exports all expected symbols from index', async () => {
    const exports = await import('../src/index.js');

    assert.ok(exports.PodscanClient);
    assert.ok(exports.PodscanError);
    assert.ok(exports.periods);
    assert.ok(exports.Paginator);
    assert.ok(exports.EpisodesResource);
    assert.ok(exports.PodcastsResource);
    assert.ok(exports.AlertsResource);
    assert.ok(exports.TopicsResource);
    assert.ok(exports.EntitiesResource);
    assert.ok(exports.ListsResource);
    assert.ok(exports.PublishersResource);
  });

  it('PodscanError is a proper Error subclass', () => {
    const err = new PodscanError({ code: 'test', message: 'test msg', status: 400 });

    assert.ok(err instanceof Error);
    assert.equal(err.name, 'PodscanError');
    assert.equal(err.code, 'test');
    assert.equal(err.message, 'test msg');
    assert.equal(err.status, 400);
    assert.ok(err.stack);
  });
});
