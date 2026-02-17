# podscan

Lightweight, zero-dependency TypeScript SDK for the [Podscan REST API](https://podscan.fm/rest-api). Optimized for AWS Lambda and serverless environments.

- **Zero runtime dependencies** -- uses native `fetch` (Node 18+)
- **Dual format** -- ESM and CommonJS
- **Fully typed** -- complete TypeScript definitions for all 25 API endpoints
- **Tiny** -- under 10 KB minified (ESM)

## Install

```bash
npm install podscan
```

## Quick Start

```typescript
import { PodscanClient } from 'podscan';

const client = new PodscanClient({
  apiKey: process.env.PODSCAN_API_KEY!,
});

// Search episodes
const results = await client.episodes.search({
  query: 'AI marketing',
  language: 'en',
  per_page: 10,
});

console.log(`Found ${results.pagination.total} episodes`);

for (const episode of results.episodes) {
  console.log(`${episode.episode_title} — ${episode.podcast?.podcast_name}`);
}
```

## Lambda Usage

The SDK uses native `fetch` with no external dependencies, so cold starts are fast and bundle size is minimal.

```typescript
import { PodscanClient } from 'podscan';

const client = new PodscanClient({
  apiKey: process.env.PODSCAN_API_KEY!,
  timeout: 10_000, // tighter timeout for Lambda
});

export const handler = async (event: any) => {
  const results = await client.episodes.search({
    query: event.queryStringParameters?.q ?? 'tech',
  });

  return {
    statusCode: 200,
    body: JSON.stringify(results.episodes),
  };
};
```

## Configuration

```typescript
const client = new PodscanClient({
  apiKey: 'your-api-key',   // Required. Bearer token for Podscan API.
  baseUrl: 'https://...',   // Optional. Override API base URL.
  timeout: 30_000,          // Optional. Request timeout in ms (default: 30000).
});
```

## API Reference

All methods return typed promises. Parameters mirror the [Podscan API docs](https://podscan.fm/docs/api).

### `client.episodes`

| Method | Description |
|---|---|
| `search(params)` | Full-text search across episode transcripts, titles, and descriptions |
| `get(params)` | Get detailed info about a specific episode |
| `getTranscript(params)` | Get the full transcript of an episode |
| `getRecent(params?)` | Get the most recently published episodes |
| `getByPodcast(params)` | List all episodes for a specific podcast |

```typescript
// Search episodes with filters
const results = await client.episodes.search({
  query: 'machine learning',
  language: 'en',
  has_guests: true,
  since: '2026-01-01',
  order_by: 'relevance',
  per_page: 25,
});

// Get episode details with transcript and entities
const episode = await client.episodes.get({
  episode_id: 'ep_m9v2x7kq4pn8rjsw',
  include_transcript: true,
  include_entities: true,
});

// Get transcript with search highlighting
const transcript = await client.episodes.getTranscript({
  episode_id: 'ep_m9v2x7kq4pn8rjsw',
  format: 'timestamped',
  search: 'artificial intelligence',
});

// Get recent episodes
const recent = await client.episodes.getRecent({ limit: 10, language: 'en' });

// List episodes for a podcast
const podcastEpisodes = await client.episodes.getByPodcast({
  podcast_id: 'pd_ka86x53ynan9wgdv',
  order_by: 'posted_at',
  per_page: 50,
});
```

### `client.podcasts`

| Method | Description |
|---|---|
| `search(params)` | Search podcasts by name, topic, or characteristics |
| `get(params)` | Get detailed info about a specific podcast |
| `getSimilar(params)` | Find podcasts similar to a given podcast |
| `getReviews(params)` | Get aggregated review and rating data |
| `getDemographics(params?)` | Search podcasts by audience demographics |

```typescript
// Search podcasts
const podcasts = await client.podcasts.search({
  query: 'business',
  has_guests: true,
  min_episode_count: 50,
  order_by: 'audience_size',
});

// Get podcast with episodes and demographics
const podcast = await client.podcasts.get({
  podcast_id: 'pd_ka86x53ynan9wgdv',
  include_episodes: true,
  episode_limit: 5,
  include_demographics: true,
});

// Find similar podcasts
const similar = await client.podcasts.getSimilar({
  podcast_id: 'pd_ka86x53ynan9wgdv',
  limit: 10,
});

// Get reviews
const reviews = await client.podcasts.getReviews({
  podcast_id: 'pd_ka86x53ynan9wgdv',
});
```

### `client.alerts`

| Method | Description |
|---|---|
| `list(params?)` | List your team's content monitoring alerts |
| `getMentions(params)` | Get mentions found by a specific alert |
| `create(params)` | Create a new content monitoring alert |

```typescript
// List alerts
const alerts = await client.alerts.list({ enabled_only: true });

// Get mentions for an alert
const mentions = await client.alerts.getMentions({
  alert_id: 'al_h3f5g8k2m7n4p9q6',
  since: '2026-02-01',
});

// Create an alert with filter expressions
const alert = await client.alerts.create({
  name: 'Brand Monitor',
  filters: '"Acme Corp"\nAcme AND (product OR service)',
  webhook_url: 'https://example.com/webhook',
  webhook_active: true,
});
```

### `client.topics`

| Method | Description |
|---|---|
| `search(params)` | Discover topics discussed across podcasts |
| `get(params)` | Get detailed info about a specific topic |
| `getEpisodes(params)` | Get episodes where a topic was mentioned |
| `getTrending(params?)` | Get currently trending topics |

```typescript
// Search topics
const topics = await client.topics.search({
  query: 'cryptocurrency',
  min_episodes: 100,
});

// Get topic with 30-day history
const topic = await client.topics.get({
  topic_id: 'tp_z8x6c4v2b0n9m7k5',
  with_history: true,
});

// Get episodes for a topic
const topicEpisodes = await client.topics.getEpisodes({
  topic_id: 'tp_z8x6c4v2b0n9m7k5',
  podcast_audience_min: 10000,
  per_page: 25,
});

// Get trending topics
const trending = await client.topics.getTrending({ period: '7d', limit: 20 });
```

### `client.entities`

| Method | Description |
|---|---|
| `search(params)` | Search for people and organizations mentioned in podcasts |
| `get(params)` | Get detailed info about a person or organization |
| `getAppearances(params)` | Get all podcast appearances for an entity |

```typescript
// Search entities
const entities = await client.entities.search({
  query: 'Elon',
  entity_type: 'person',
  min_appearances: 100,
});

// Get entity with recent appearances
const entity = await client.entities.get({
  entity_id: 'en_p4o2i8u6y3t1r5e9',
  with_appearances: true,
  appearances_limit: 10,
});

// Get all appearances filtered by role
const appearances = await client.entities.getAppearances({
  entity_id: 'en_p4o2i8u6y3t1r5e9',
  role: 'guest',
  order_dir: 'desc',
});
```

### `client.lists`

| Method | Description |
|---|---|
| `list(params?)` | Get all lists/collections for your team |
| `getItems(params)` | Get contents of a specific list |
| `addItems(params)` | Add items to a list (podcasts, episodes, entities, topics) |

```typescript
// List all collections
const lists = await client.lists.list();

// Get list items filtered by type
const items = await client.lists.getItems({
  list_id: 'cl_q9w3e5r7t1y4u8i2',
  item_type: 'podcasts',
});

// Add items to a list
const result = await client.lists.addItems({
  list_id: 'cl_q9w3e5r7t1y4u8i2',
  item_ids: 'pd_ka86x53ynan9wgdv,ep_m9v2x7kq4pn8rjsw',
});
```

### `client.charts`

| Method | Description |
|---|---|
| `get(params)` | Get podcast chart rankings from Apple Podcasts and Spotify |

```typescript
const charts = await client.charts.get({
  platform: 'apple',
  chart_type: 'top',
  country: 'us',
  limit: 50,
});
```

### `client.publishers`

| Method | Description |
|---|---|
| `get(params)` | Get publisher info with their podcast portfolio |

```typescript
const publisher = await client.publishers.get({
  publisher_id: 'pb_l7k5j3h1g9f6d4s2',
  include_podcasts: true,
  podcast_limit: 20,
});
```

## Error Handling

All API errors throw a `PodscanError` with structured details:

```typescript
import { PodscanClient, PodscanError } from 'podscan';

try {
  const results = await client.episodes.search({ query: 'test' });
} catch (error) {
  if (error instanceof PodscanError) {
    console.error(error.code);    // 'quota_exceeded', 'not_found', etc.
    console.error(error.message);  // Human-readable message
    console.error(error.status);   // HTTP status code (0 for network/timeout errors)
    console.error(error.details);  // Additional context from the API
  }
}
```

### Error Codes

| Code | Description |
|---|---|
| `api_error` | Generic API error |
| `not_found` | Resource does not exist |
| `quota_exceeded` | Daily request limit reached |
| `access_denied` | Resource belongs to another team |
| `validation_error` | Invalid parameter value |
| `timeout` | Request timed out |
| `network_error` | Network connectivity issue |

## Rate Limits

Rate-limit info is available after each request:

```typescript
await client.episodes.search({ query: 'test' });

console.log(client.rateLimit);
// { limit: 2000, remaining: 1999, used: 1, resetsAt: '2026-02-17T00:00:00Z' }
```

## Requirements

- Node.js >= 18.0.0 (uses native `fetch`)
- A [Podscan](https://podscan.fm) account with API access

## License

MIT
