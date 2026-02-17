/**
 * Integration tests against the live Podscan API.
 *
 * These tests make REAL HTTP requests and require a valid API key.
 * They only use READ-ONLY endpoints to avoid side effects.
 *
 * Setup:
 *   1. Copy .env.example to .env
 *   2. Fill in your PODSCAN_API_KEY
 *   3. Run: npm run test:integration
 *
 * Quota impact: ~10 requests per run (uses per_page:1 / limit:1 everywhere).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PodscanClient } from '../src/client.js';
import { PodscanError } from '../src/http.js';
import { periods } from '../src/periods.js';

const API_KEY = process.env.PODSCAN_API_KEY;

if (!API_KEY) {
  console.log('\n  Skipping integration tests: PODSCAN_API_KEY is not set.');
  console.log('  To run: cp .env.example .env && edit .env && npm run test:integration\n');
  process.exit(0);
}

const client = new PodscanClient({
  apiKey: API_KEY,
  timeout: 15_000,
});

let discoveredEpisodeId: string;
let discoveredPodcastId: string;

// ============================================================================
// Episodes
// ============================================================================

describe('Integration: Episodes', () => {
  it('search() returns episodes with expected shape', async () => {
    const result = await client.episodes.search({
      query: 'technology',
      per_page: 1,
    });

    assert.ok(result.episodes, 'response should have episodes array');
    assert.ok(Array.isArray(result.episodes), 'episodes should be an array');
    assert.ok(result.pagination, 'response should have pagination');
    assert.ok(typeof result.pagination.total === 'number', 'pagination.total should be a number');
    assert.ok(result.episodes.length > 0, 'should find at least one episode');

    const episode = result.episodes[0];
    assert.ok(episode.episode_id, 'episode should have episode_id');
    assert.ok(episode.episode_id.startsWith('ep_'), 'episode_id should start with ep_');
    assert.ok(episode.episode_title, 'episode should have episode_title');

    discoveredEpisodeId = episode.episode_id;
    discoveredPodcastId = episode.podcast?.podcast_id ?? '';
  });

  it('get() returns episode details for a discovered ID', async () => {
    assert.ok(discoveredEpisodeId, 'need a discovered episode ID from search');

    const result = await client.episodes.get({
      episode_id: discoveredEpisodeId,
    });

    assert.ok(result.episode, 'response should have episode');
    assert.equal(result.episode.episode_id, discoveredEpisodeId);
    assert.ok(result.episode.episode_title, 'should have episode_title');
    assert.ok(result.episode.posted_at, 'should have posted_at');
  });

  it('getRecent() returns recent episodes', async () => {
    const result = await client.episodes.getRecent({ limit: 1 });

    assert.ok(result.episodes, 'response should have episodes');
    assert.ok(Array.isArray(result.episodes), 'episodes should be an array');
    assert.ok(result.episodes.length > 0, 'should have at least one recent episode');
    assert.ok(result.episodes[0].episode_id, 'episode should have an ID');
  });

  it('getByPodcast() returns episodes for a podcast', async () => {
    assert.ok(discoveredPodcastId, 'need a discovered podcast ID');

    const result = await client.episodes.getByPodcast({
      podcast_id: discoveredPodcastId,
      per_page: 1,
    });

    assert.ok(result.episodes, 'response should have episodes');
    assert.ok(Array.isArray(result.episodes), 'episodes should be an array');
  });
});

// ============================================================================
// Podcasts
// ============================================================================

describe('Integration: Podcasts', () => {
  it('search() returns podcasts with expected shape', async () => {
    const result = await client.podcasts.search({
      query: 'business',
      per_page: 1,
    });

    assert.ok(result.podcasts, 'response should have podcasts array');
    assert.ok(Array.isArray(result.podcasts), 'podcasts should be an array');
    assert.ok(result.podcasts.length > 0, 'should find at least one podcast');

    const podcast = result.podcasts[0];
    assert.ok(podcast.podcast_id, 'podcast should have podcast_id');
    assert.ok(podcast.podcast_id.startsWith('pd_'), 'podcast_id should start with pd_');
    assert.ok(podcast.podcast_name, 'podcast should have a name');

    if (!discoveredPodcastId) {
      discoveredPodcastId = podcast.podcast_id;
    }
  });

  it('get() returns podcast details', async () => {
    assert.ok(discoveredPodcastId, 'need a discovered podcast ID');

    const result = await client.podcasts.get({
      podcast_id: discoveredPodcastId,
    });

    assert.ok(result.podcast, 'response should have podcast');
    assert.equal(result.podcast.podcast_id, discoveredPodcastId);
    assert.ok(result.podcast.podcast_name, 'should have name');
  });
});

// ============================================================================
// Topics
// ============================================================================

describe('Integration: Topics', () => {
  it('search() returns topics with expected shape', async () => {
    const result = await client.topics.search({
      query: 'artificial intelligence',
      per_page: 1,
    });

    assert.ok(result.topics, 'response should have topics array');
    assert.ok(Array.isArray(result.topics), 'topics should be an array');
    assert.ok(result.topics.length > 0, 'should find at least one topic');

    const topic = result.topics[0];
    assert.ok(topic.topic_id, 'topic should have topic_id');
    assert.ok(topic.topic_id.startsWith('tp_'), 'topic_id should start with tp_');
  });

  it('getTrending() returns trending topics', async () => {
    const result = await client.topics.getTrending({ period: '7d', limit: 1 });

    assert.ok(result.topics, 'response should have topics');
    assert.ok(Array.isArray(result.topics), 'topics should be an array');
    assert.ok(result.topics.length > 0, 'should have at least one trending topic');

    const topic = result.topics[0];
    assert.ok(topic.topic_id, 'trending topic should have topic_id');
  });
});

// ============================================================================
// Entities
// ============================================================================

describe('Integration: Entities', () => {
  it('search() returns people/brands with expected shape', async () => {
    const result = await client.entities.search({
      query: 'Google',
      per_page: 1,
    });

    assert.ok(result.entities, 'response should have entities array');
    assert.ok(Array.isArray(result.entities), 'entities should be an array');
    assert.ok(result.entities.length > 0, 'should find at least one entity');

    const entity = result.entities[0];
    assert.ok(entity.entity_id, 'entity should have entity_id');
    assert.ok(entity.entity_id.startsWith('en_'), 'entity_id should start with en_');
    assert.ok(entity.entity_name, 'entity should have entity_name');
    assert.ok(
      entity.entity_type === 'person' || entity.entity_type === 'organization',
      'entity_type should be person or organization',
    );
  });
});

// ============================================================================
// Periods + searchAll (auto-pagination)
// ============================================================================

describe('Integration: Periods + searchAll', () => {
  it('searchAll() with periods.lastNDays(7) yields episodes with checkpoint', async () => {
    const paginator = client.episodes.searchAll({
      query: 'technology',
      ...periods.lastNDays(7),
      per_page: 1,
    });

    let count = 0;
    for await (const ep of paginator) {
      assert.ok(ep.episode_id, 'episode should have episode_id');
      assert.ok(ep.episode_title, 'episode should have episode_title');
      count++;
      if (count >= 2) break;
    }

    assert.ok(count >= 1, 'should yield at least 1 episode');

    const cp = paginator.checkpoint();
    assert.ok(cp.lastSeenId, 'checkpoint should have lastSeenId');
    assert.ok(cp.lastSeenAt, 'checkpoint should have lastSeenAt');
    assert.ok(cp.totalSeen >= 1, 'checkpoint totalSeen should be >= 1');
  });
});

// ============================================================================
// Typed Metadata (hosts, guests, speakers)
// ============================================================================

describe('Integration: Episode Metadata', () => {
  it('episode with guests has typed metadata', async () => {
    const results = await client.episodes.search({
      query: 'interview',
      has_guests: true,
      per_page: 1,
    });

    assert.ok(results.episodes.length > 0, 'should find an episode with guests');
    const ep = results.episodes[0];
    const meta = ep.metadata;

    if (meta) {
      assert.ok(typeof meta.has_guests === 'boolean', 'has_guests should be boolean');
      assert.ok(typeof meta.has_hosts === 'boolean', 'has_hosts should be boolean');
      assert.ok(Array.isArray(meta.guests), 'guests should be an array');
      assert.ok(Array.isArray(meta.hosts), 'hosts should be an array');
      assert.ok(typeof meta.speakers === 'object', 'speakers should be an object');

      if (meta.guests.length > 0) {
        const guest = meta.guests[0];
        assert.ok(guest.guest_name, 'guest should have guest_name');
        assert.ok('guest_company' in guest, 'guest should have guest_company field');
        assert.ok('speaker_label' in guest, 'guest should have speaker_label field');
      }

      if (meta.summary_short) {
        assert.ok(typeof meta.summary_short === 'string', 'summary_short should be a string');
      }

      if (meta.summary_keywords) {
        assert.ok(Array.isArray(meta.summary_keywords), 'summary_keywords should be an array');
      }
    }
  });
});

// ============================================================================
// Rate Limit Tracking
// ============================================================================

describe('Integration: Rate Limits', () => {
  it('client.rateLimit is populated after requests', () => {
    const rl = client.rateLimit;
    assert.ok(rl, 'rateLimit should be populated after API calls');
    assert.ok(typeof rl.limit === 'number', 'limit should be a number');
    assert.ok(typeof rl.remaining === 'number', 'remaining should be a number');
    assert.ok(typeof rl.used === 'number', 'used should be a number');
    assert.ok(rl.limit > 0, 'limit should be positive');
    assert.ok(rl.remaining >= 0, 'remaining should be non-negative');
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe('Integration: Error Handling', () => {
  it('returns PodscanError for a nonexistent resource', async () => {
    await assert.rejects(
      () => client.episodes.get({ episode_id: 'ep_nonexistent_000000' }),
      (err: unknown) => {
        assert.ok(err instanceof PodscanError, 'should throw PodscanError');
        assert.ok(err.status >= 400, 'status should be 4xx');
        assert.ok(err.message, 'should have an error message');
        return true;
      },
    );
  });
});
