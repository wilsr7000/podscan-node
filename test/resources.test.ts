import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { EpisodesResource } from '../src/resources/episodes.js';
import { PodcastsResource } from '../src/resources/podcasts.js';
import { AlertsResource } from '../src/resources/alerts.js';
import { TopicsResource } from '../src/resources/topics.js';
import { EntitiesResource } from '../src/resources/entities.js';
import { ListsResource } from '../src/resources/lists.js';
import { PublishersResource } from '../src/resources/publishers.js';
import { mockFetch, mockFetchSequence } from './helpers.js';

function makeHttp(): HttpClient {
  return new HttpClient({ apiKey: 'test-key' });
}

// ==========================================================================
// Episodes Resource (4 endpoints)
// ==========================================================================

describe('EpisodesResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /episodes/search with params', async () => {
    const mock = mockFetch({
      body: {
        episodes: [{ episode_id: 'ep_1', episode_title: 'Test' }],
        pagination: { total: 1, per_page: 1, current_page: 1, last_page: 1 },
      },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    const result = await resource.search({ query: 'AI marketing', language: 'en', per_page: 10 });

    assert.equal(mock.captured[0].method, 'GET');
    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/search');
    assert.equal(url.searchParams.get('query'), 'AI marketing');
    assert.equal(url.searchParams.get('language'), 'en');
    assert.equal(url.searchParams.get('per_page'), '10');
    assert.equal(result.episodes.length, 1);
    assert.equal(result.pagination.total, 1);
  });

  it('get() calls GET /episodes/:id with query options', async () => {
    const mock = mockFetch({
      body: {
        episode: {
          episode_id: 'ep_abc',
          episode_title: 'Test',
          episode_duration: 1800,
          posted_at: '2026-01-01',
        },
      },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    const result = await resource.get({ episode_id: 'ep_abc', include_transcript: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/ep_abc');
    assert.equal(url.searchParams.get('include_transcript'), 'true');
    assert.equal(url.searchParams.has('episode_id'), false);
    assert.equal(result.episode.episode_title, 'Test');
    assert.equal(result.episode.episode_duration, 1800);
  });

  it('getRecent() calls GET /episodes/recent with optional params', async () => {
    const mock = mockFetch({
      body: { episodes: [{ episode_id: 'ep_r1' }] },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.getRecent({ limit: 5, language: 'en' });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/recent');
    assert.equal(url.searchParams.get('limit'), '5');
  });

  it('getRecent() works without params', async () => {
    const mock = mockFetch({ body: { episodes: [] } });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.getRecent();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/episodes/recent');
  });

  it('getByPodcast() calls GET /podcasts/:id/episodes', async () => {
    const mock = mockFetch({
      body: {
        episodes: [],
        pagination: { total: 0, per_page: 50, current_page: 1, last_page: 1 },
      },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.getByPodcast({ podcast_id: 'pd_abc', order_by: 'posted_at', per_page: 50 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_abc/episodes');
    assert.equal(url.searchParams.get('order_by'), 'posted_at');
    assert.equal(url.searchParams.get('per_page'), '50');
    assert.equal(url.searchParams.has('podcast_id'), false);
  });

  it('searchAll() auto-paginates across pages', async () => {
    const mock = mockFetchSequence([
      {
        body: {
          episodes: [{ episode_id: 'ep_1', posted_at: '2026-02-15T10:00:00Z' }],
          pagination: { total: 2, per_page: 1, current_page: 1, last_page: 2, from: 1, to: 1 },
        },
      },
      {
        body: {
          episodes: [{ episode_id: 'ep_2', posted_at: '2026-02-16T10:00:00Z' }],
          pagination: { total: 2, per_page: 1, current_page: 2, last_page: 2, from: 2, to: 2 },
        },
      },
    ]);
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    const collected: string[] = [];
    const paginator = resource.searchAll({ query: 'AI', per_page: 1 });

    for await (const ep of paginator) {
      collected.push(ep.episode_id);
    }

    assert.deepEqual(collected, ['ep_1', 'ep_2']);
    assert.equal(mock.captured.length, 2);
    assert.equal(paginator.totalSeen, 2);
    assert.equal(paginator.checkpoint().lastSeenId, 'ep_2');
  });

  it('getByPodcastAll() auto-paginates podcast episodes', async () => {
    const mock = mockFetchSequence([
      {
        body: {
          episodes: [{ episode_id: 'ep_a', posted_at: '2026-02-15T10:00:00Z' }],
          pagination: { total: 1, per_page: 1, current_page: 1, last_page: 1, from: 1, to: 1 },
        },
      },
    ]);
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    const collected: string[] = [];

    for await (const ep of resource.getByPodcastAll({ podcast_id: 'pd_abc', per_page: 1 })) {
      collected.push(ep.episode_id);
    }

    assert.deepEqual(collected, ['ep_a']);
    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_abc/episodes');
  });
});

// ==========================================================================
// Podcasts Resource (2 endpoints)
// ==========================================================================

describe('PodcastsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /podcasts/search', async () => {
    const mock = mockFetch({
      body: {
        podcasts: [{ podcast_id: 'pd_1', podcast_name: 'Biz Show' }],
        pagination: { total: 1, per_page: 1, current_page: 1, last_page: 1 },
      },
    });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    const result = await resource.search({
      query: 'business',
      has_guests: true,
      min_episode_count: 50,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/search');
    assert.equal(url.searchParams.get('query'), 'business');
    assert.equal(url.searchParams.get('has_guests'), 'true');
    assert.equal(url.searchParams.get('min_episode_count'), '50');
    assert.equal(result.podcasts.length, 1);
    assert.equal(result.podcasts[0].podcast_name, 'Biz Show');
  });

  it('get() calls GET /podcasts/:id', async () => {
    const mock = mockFetch({
      body: {
        podcast: {
          podcast_id: 'pd_abc',
          podcast_name: 'My Show',
          episode_count: 100,
          language: 'en',
        },
      },
    });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    const result = await resource.get({ podcast_id: 'pd_abc', include_episodes: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_abc');
    assert.equal(url.searchParams.get('include_episodes'), 'true');
    assert.equal(result.podcast.podcast_name, 'My Show');
    assert.equal(result.podcast.episode_count, 100);
  });
});

// ==========================================================================
// Alerts Resource (3 endpoints)
// ==========================================================================

describe('AlertsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('list() calls GET /alerts', async () => {
    const mock = mockFetch({
      body: {
        alerts: [{ alert_id: 'al_1', alert_name: 'Brand' }],
        pagination: { total: 1, per_page: 25, current_page: 1, last_page: 1 },
      },
    });
    restore = mock.restore;

    const resource = new AlertsResource(makeHttp());
    const result = await resource.list({ enabled_only: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/alerts');
    assert.equal(url.searchParams.get('enabled_only'), 'true');
    assert.equal(result.alerts.length, 1);
  });

  it('list() works without params', async () => {
    const mock = mockFetch({
      body: { alerts: [], pagination: { total: 0 } },
    });
    restore = mock.restore;

    const resource = new AlertsResource(makeHttp());
    await resource.list();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/alerts');
  });

  it('getMentions() calls GET /alerts/:id/mentions', async () => {
    const mock = mockFetch({
      body: {
        mentions: [{ mention_id: 'mn_1' }],
        pagination: { total: 1 },
      },
    });
    restore = mock.restore;

    const resource = new AlertsResource(makeHttp());
    const result = await resource.getMentions({
      alert_id: 'al_abc',
      since: '2026-02-01',
      detected_type: 'transcript',
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/alerts/al_abc/mentions');
    assert.equal(url.searchParams.get('since'), '2026-02-01');
    assert.equal(url.searchParams.get('detected_type'), 'transcript');
    assert.equal(url.searchParams.has('alert_id'), false);
    assert.equal(result.mentions.length, 1);
  });

  it('create() calls POST /alerts with body', async () => {
    const mock = mockFetch({
      body: { alert: { alert_id: 'al_new', alert_name: 'Brand Monitor' } },
    });
    restore = mock.restore;

    const resource = new AlertsResource(makeHttp());
    const result = await resource.create({
      name: 'Brand Monitor',
      filters: '"Acme Corp"',
      webhook_url: 'https://example.com/hook',
      webhook_active: true,
    });

    assert.equal(mock.captured[0].method, 'POST');
    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/alerts');
    const body = JSON.parse(mock.captured[0].body!);
    assert.equal(body.name, 'Brand Monitor');
    assert.equal(body.filters, '"Acme Corp"');
    assert.equal(result.alert.alert_name, 'Brand Monitor');
  });
});

// ==========================================================================
// Topics Resource (4 endpoints)
// ==========================================================================

describe('TopicsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /topics/search', async () => {
    const mock = mockFetch({
      body: {
        topics: [{ topic_id: 'tp_1', name: 'AI', occurrences_count: 500 }],
        pagination: { total: 1 },
      },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    const result = await resource.search({ query: 'AI', per_page: 1 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/search');
    assert.equal(url.searchParams.get('query'), 'AI');
    assert.equal(result.topics[0].name, 'AI');
  });

  it('get() calls GET /topics/:id', async () => {
    const mock = mockFetch({
      body: {
        topic: { topic_id: 'tp_abc', name: 'AI', occurrences_count: 7000 },
      },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    const result = await resource.get({ topic_id: 'tp_abc', with_history: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/tp_abc');
    assert.equal(url.searchParams.get('with_history'), 'true');
    assert.equal(result.topic.name, 'AI');
  });

  it('getEpisodes() calls GET /topics/:id/episodes', async () => {
    const mock = mockFetch({
      body: { episodes: [], pagination: { total: 0 } },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    await resource.getEpisodes({
      topic_id: 'tp_abc',
      podcast_audience_min: 10000,
      per_page: 25,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/tp_abc/episodes');
    assert.equal(url.searchParams.get('podcast_audience_min'), '10000');
    assert.equal(url.searchParams.has('topic_id'), false);
  });

  it('getTrending() calls GET /topics/trending', async () => {
    const mock = mockFetch({
      body: {
        topics: [{ topic_id: 'tp_1', name: 'AI', occurrences: 500 }],
        timeframe: '7d',
      },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    const result = await resource.getTrending({ period: '7d', limit: 20 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/trending');
    assert.equal(url.searchParams.get('period'), '7d');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(result.topics.length, 1);
    assert.equal(result.topics[0].occurrences, 500);
  });

  it('getTrending() works without params', async () => {
    const mock = mockFetch({ body: { topics: [] } });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    await resource.getTrending();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/topics/trending');
  });
});

// ==========================================================================
// Entities Resource (3 endpoints)
// ==========================================================================

describe('EntitiesResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /entities/search', async () => {
    const mock = mockFetch({
      body: {
        entities: [
          {
            entity_id: 'en_1',
            entity_name: 'Google',
            entity_type: 'organization',
            appearances: { total_count: 1177 },
          },
        ],
        pagination: { total: 1 },
        filters: {},
      },
    });
    restore = mock.restore;

    const resource = new EntitiesResource(makeHttp());
    const result = await resource.search({
      query: 'Google',
      entity_type: 'organization',
      per_page: 1,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/entities/search');
    assert.equal(url.searchParams.get('query'), 'Google');
    assert.equal(url.searchParams.get('entity_type'), 'organization');
    assert.equal(result.entities[0].entity_name, 'Google');
  });

  it('get() calls GET /entities/:id', async () => {
    const mock = mockFetch({
      body: {
        entity: {
          entity_id: 'en_abc',
          entity_name: 'Google',
          entity_type: 'organization',
          appearances: { total_count: 500 },
        },
      },
    });
    restore = mock.restore;

    const resource = new EntitiesResource(makeHttp());
    const result = await resource.get({
      entity_id: 'en_abc',
      with_appearances: true,
      appearances_limit: 10,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/entities/en_abc');
    assert.equal(url.searchParams.get('with_appearances'), 'true');
    assert.equal(result.entity.entity_name, 'Google');
  });

  it('getAppearances() calls GET /entities/:id/appearances', async () => {
    const mock = mockFetch({
      body: {
        entity: { entity_id: 'en_abc' },
        appearances: [],
        pagination: { total: 0 },
      },
    });
    restore = mock.restore;

    const resource = new EntitiesResource(makeHttp());
    await resource.getAppearances({
      entity_id: 'en_abc',
      role: 'guest',
      from: '2026-01-01',
      order_dir: 'desc',
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/entities/en_abc/appearances');
    assert.equal(url.searchParams.get('role'), 'guest');
    assert.equal(url.searchParams.get('from'), '2026-01-01');
    assert.equal(url.searchParams.has('entity_id'), false);
  });
});

// ==========================================================================
// Lists Resource (3 endpoints)
// ==========================================================================

describe('ListsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('list() calls GET /lists', async () => {
    const mock = mockFetch({
      body: {
        lists: [{ list_id: 'cl_1', list_name: 'Research' }],
        pagination: { total: 1 },
      },
    });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    const result = await resource.list({ page: 1, per_page: 10 });

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/lists');
    assert.equal(result.lists.length, 1);
  });

  it('list() works without params', async () => {
    const mock = mockFetch({ body: { lists: [], pagination: { total: 0 } } });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    await resource.list();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/lists');
  });

  it('getItems() calls GET /lists/:id/items', async () => {
    const mock = mockFetch({
      body: { items: [{ id: 'pd_1', type: 'podcast' }], pagination: { total: 1 } },
    });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    const result = await resource.getItems({ list_id: 'cl_abc', item_type: 'podcasts' });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/lists/cl_abc/items');
    assert.equal(url.searchParams.get('item_type'), 'podcasts');
    assert.equal(url.searchParams.has('list_id'), false);
    assert.equal(result.items.length, 1);
  });

  it('addItems() calls POST /lists/:id/items', async () => {
    const mock = mockFetch({
      body: { success: true, summary: { added: 2, skipped: 0, failed: 0 } },
    });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    const result = await resource.addItems({ list_id: 'cl_abc', item_ids: 'pd_1,ep_2' });

    assert.equal(mock.captured[0].method, 'POST');
    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/lists/cl_abc/items');
    const body = JSON.parse(mock.captured[0].body!);
    assert.equal(body.item_ids, 'pd_1,ep_2');
    assert.equal(body.list_id, undefined);
    assert.equal(result.success, true);
    assert.equal(result.summary.added, 2);
  });
});

// ==========================================================================
// Publishers Resource (1 endpoint)
// ==========================================================================

describe('PublishersResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('get() calls GET /publishers/:id', async () => {
    const mock = mockFetch({
      body: { publisher: { publisher_id: 'pb_abc', publisher_name: 'NPR' } },
    });
    restore = mock.restore;

    const resource = new PublishersResource(makeHttp());
    const result = await resource.get({
      publisher_id: 'pb_abc',
      include_podcasts: true,
      podcast_limit: 20,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/publishers/pb_abc');
    assert.equal(url.searchParams.get('include_podcasts'), 'true');
    assert.equal(url.searchParams.get('podcast_limit'), '20');
    assert.equal(url.searchParams.has('publisher_id'), false);
    assert.equal(result.publisher.publisher_name, 'NPR');
  });
});
