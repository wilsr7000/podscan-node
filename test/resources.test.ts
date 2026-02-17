import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HttpClient } from '../src/http.js';
import { EpisodesResource } from '../src/resources/episodes.js';
import { PodcastsResource } from '../src/resources/podcasts.js';
import { AlertsResource } from '../src/resources/alerts.js';
import { TopicsResource } from '../src/resources/topics.js';
import { EntitiesResource } from '../src/resources/entities.js';
import { ListsResource } from '../src/resources/lists.js';
import { ChartsResource } from '../src/resources/charts.js';
import { PublishersResource } from '../src/resources/publishers.js';
import { mockFetch } from './helpers.js';

function makeHttp(): HttpClient {
  return new HttpClient({ apiKey: 'test-key' });
}

// ==========================================================================
// Episodes Resource (5 endpoints)
// ==========================================================================

describe('EpisodesResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /episodes/search with params', async () => {
    const mock = mockFetch({
      body: { episodes: [{ episode_id: 'ep_1' }], pagination: { total: 1 } },
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
  });

  it('get() calls GET /episodes/:id with query options', async () => {
    const mock = mockFetch({
      body: { episode: { episode_id: 'ep_abc', episode_title: 'Test' } },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.get({ episode_id: 'ep_abc', include_transcript: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/ep_abc');
    assert.equal(url.searchParams.get('include_transcript'), 'true');
    assert.equal(url.searchParams.has('episode_id'), false);
  });

  it('getTranscript() calls GET /episodes/:id/transcript', async () => {
    const mock = mockFetch({
      body: { transcript: 'Hello world', word_count: 2 },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    const result = await resource.getTranscript({
      episode_id: 'ep_xyz',
      format: 'timestamped',
      search: 'hello',
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/ep_xyz/transcript');
    assert.equal(url.searchParams.get('format'), 'timestamped');
    assert.equal(url.searchParams.get('search'), 'hello');
    assert.equal(result.transcript, 'Hello world');
  });

  it('getRecent() calls GET /episodes/recent with optional params', async () => {
    const mock = mockFetch({
      body: { episodes: [], count: 0 },
    });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.getRecent({ limit: 5, language: 'en' });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/recent');
    assert.equal(url.searchParams.get('limit'), '5');
  });

  it('getRecent() works without params', async () => {
    const mock = mockFetch({ body: { episodes: [], count: 0 } });
    restore = mock.restore;

    const resource = new EpisodesResource(makeHttp());
    await resource.getRecent();

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/episodes/recent');
  });

  it('getByPodcast() calls GET /podcasts/:id/episodes', async () => {
    const mock = mockFetch({
      body: { episodes: [], pagination: { total: 0 } },
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
});

// ==========================================================================
// Podcasts Resource (5 endpoints)
// ==========================================================================

describe('PodcastsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('search() calls GET /podcasts/search', async () => {
    const mock = mockFetch({
      body: { podcasts: [{ podcast_id: 'pd_1' }], pagination: { total: 1 } },
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
  });

  it('get() calls GET /podcasts/:id', async () => {
    const mock = mockFetch({
      body: { podcast: { podcast_id: 'pd_abc', podcast_name: 'My Show' } },
    });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    const result = await resource.get({
      podcast_id: 'pd_abc',
      include_episodes: true,
      episode_limit: 5,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_abc');
    assert.equal(url.searchParams.get('include_episodes'), 'true');
    assert.equal(url.searchParams.get('episode_limit'), '5');
    assert.equal(result.podcast.podcast_name, 'My Show');
  });

  it('getSimilar() calls GET /podcasts/:id/similar', async () => {
    const mock = mockFetch({ body: { podcasts: [] } });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    await resource.getSimilar({ podcast_id: 'pd_xyz', limit: 10 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_xyz/similar');
    assert.equal(url.searchParams.get('limit'), '10');
  });

  it('getReviews() calls GET /podcasts/:id/reviews', async () => {
    const mock = mockFetch({
      body: { reviews: { combined_rating: 4.5, itunes_rating_average: 4.6 } },
    });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    const result = await resource.getReviews({ podcast_id: 'pd_abc' });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/pd_abc/reviews');
    assert.equal(result.reviews.combined_rating, 4.5);
  });

  it('getDemographics() calls GET /podcasts/demographics', async () => {
    const mock = mockFetch({
      body: { podcasts: [], pagination: { total: 0 } },
    });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    await resource.getDemographics({ language: 'en', min_audience_size: 1000 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/demographics');
    assert.equal(url.searchParams.get('language'), 'en');
    assert.equal(url.searchParams.get('min_audience_size'), '1000');
  });

  it('getDemographics() works without params', async () => {
    const mock = mockFetch({ body: { podcasts: [], pagination: {} } });
    restore = mock.restore;

    const resource = new PodcastsResource(makeHttp());
    await resource.getDemographics();

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/podcasts/demographics');
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
      body: { alerts: [{ alert_id: 'al_1' }], pagination: { total: 1 } },
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
    const mock = mockFetch({ body: { alerts: [], pagination: {} } });
    restore = mock.restore;

    const resource = new AlertsResource(makeHttp());
    await resource.list();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/alerts');
  });

  it('getMentions() calls GET /alerts/:id/mentions', async () => {
    const mock = mockFetch({
      body: { mentions: [{ mention_id: 'mn_1' }], pagination: { total: 1 } },
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
    assert.equal(body.webhook_url, 'https://example.com/hook');
    assert.equal(body.webhook_active, true);
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
      body: { topics: [{ topic_id: 'tp_1' }], pagination: { total: 1 } },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    await resource.search({ query: 'cryptocurrency', min_episodes: 100 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/search');
    assert.equal(url.searchParams.get('query'), 'cryptocurrency');
    assert.equal(url.searchParams.get('min_episodes'), '100');
  });

  it('get() calls GET /topics/:id', async () => {
    const mock = mockFetch({
      body: { topic: { topic_id: 'tp_abc', topic_name: 'AI' } },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    const result = await resource.get({ topic_id: 'tp_abc', with_history: true });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/tp_abc');
    assert.equal(url.searchParams.get('with_history'), 'true');
    assert.equal(result.topic.topic_name, 'AI');
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
      body: { topics: [{ topic_id: 'tp_1', mention_count: 500 }] },
    });
    restore = mock.restore;

    const resource = new TopicsResource(makeHttp());
    const result = await resource.getTrending({ period: '7d', limit: 20 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/topics/trending');
    assert.equal(url.searchParams.get('period'), '7d');
    assert.equal(url.searchParams.get('limit'), '20');
    assert.equal(result.topics.length, 1);
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
      body: { entities: [{ entity_id: 'en_1', entity_name: 'Elon Musk' }], pagination: {} },
    });
    restore = mock.restore;

    const resource = new EntitiesResource(makeHttp());
    const result = await resource.search({
      query: 'Elon',
      entity_type: 'person',
      min_appearances: 100,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/entities/search');
    assert.equal(url.searchParams.get('query'), 'Elon');
    assert.equal(url.searchParams.get('entity_type'), 'person');
    assert.equal(result.entities[0].entity_name, 'Elon Musk');
  });

  it('get() calls GET /entities/:id', async () => {
    const mock = mockFetch({
      body: { entity: { entity_id: 'en_abc', total_appearances: 500 } },
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
    assert.equal(url.searchParams.get('appearances_limit'), '10');
    assert.equal(result.entity.total_appearances, 500);
  });

  it('getAppearances() calls GET /entities/:id/appearances', async () => {
    const mock = mockFetch({
      body: { appearances: [], pagination: { total: 0 } },
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
    assert.equal(url.searchParams.get('order_dir'), 'desc');
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
      body: { lists: [{ list_id: 'cl_1' }], pagination: { total: 1 } },
    });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    const result = await resource.list({ page: 1, per_page: 10 });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/lists');
    assert.equal(result.lists.length, 1);
  });

  it('list() works without params', async () => {
    const mock = mockFetch({ body: { lists: [], pagination: {} } });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    await resource.list();

    assert.equal(new URL(mock.captured[0].url).pathname, '/api/v1/lists');
  });

  it('getItems() calls GET /lists/:id/items', async () => {
    const mock = mockFetch({
      body: { items: [{ id: 'pd_1', type: 'podcast' }], pagination: {} },
    });
    restore = mock.restore;

    const resource = new ListsResource(makeHttp());
    const result = await resource.getItems({
      list_id: 'cl_abc',
      item_type: 'podcasts',
    });

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
    const result = await resource.addItems({
      list_id: 'cl_abc',
      item_ids: 'pd_1,ep_2',
    });

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
// Charts Resource (1 endpoint)
// ==========================================================================

describe('ChartsResource', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('get() calls GET /charts with platform and options', async () => {
    const mock = mockFetch({
      body: { charts: [{ position: 1, podcast_id: 'pd_top' }] },
    });
    restore = mock.restore;

    const resource = new ChartsResource(makeHttp());
    const result = await resource.get({
      platform: 'apple',
      chart_type: 'top',
      country: 'us',
      limit: 50,
    });

    const url = new URL(mock.captured[0].url);
    assert.equal(url.pathname, '/api/v1/charts');
    assert.equal(url.searchParams.get('platform'), 'apple');
    assert.equal(url.searchParams.get('chart_type'), 'top');
    assert.equal(url.searchParams.get('country'), 'us');
    assert.equal(url.searchParams.get('limit'), '50');
    assert.equal(result.charts.length, 1);
    assert.equal(result.charts[0].position, 1);
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
