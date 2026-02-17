# podscan

Lightweight, zero-dependency TypeScript SDK for the [Podscan REST API](https://podscan.fm/rest-api). Optimized for AWS Lambda and serverless environments.

- **Zero runtime dependencies** -- uses native `fetch` (Node 18+)
- **Dual format** -- ESM and CommonJS
- **Fully typed** -- complete TypeScript definitions including episode metadata (hosts, guests, speakers)
- **Auto-pagination** -- `searchAll()` async iterators walk all pages automatically
- **Time period helpers** -- `periods.thisWeek()`, `periods.lastMonth()`, etc.
- **Delta sync** -- checkpoint-based tracking for incremental data pulls
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

// Get episode details with transcript
const episode = await client.episodes.get({
  episode_id: 'ep_m9v2x7kq4pn8rjsw',
  include_transcript: true,
  include_entities: true,
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

```typescript
// Search podcasts
const podcasts = await client.podcasts.search({
  query: 'business',
  has_guests: true,
  min_episode_count: 50,
  order_by: 'audience_size',
});

// Get podcast details
const podcast = await client.podcasts.get({
  podcast_id: 'pd_ka86x53ynan9wgdv',
  include_episodes: true,
  episode_limit: 5,
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

// Get topic with history
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

## Time Periods

The `periods` helper computes date ranges you can spread into any search call:

```typescript
import { PodscanClient, periods } from 'podscan';

const client = new PodscanClient({ apiKey: process.env.PODSCAN_API_KEY! });

// This week's AI episodes
const results = await client.episodes.search({
  query: 'AI',
  ...periods.thisWeek(),
  per_page: 50,
});
```

Available presets:

| Method | Range |
|---|---|
| `periods.today()` | Midnight UTC today to now |
| `periods.yesterday()` | Yesterday midnight to today midnight |
| `periods.last24Hours()` | Rolling 24-hour window |
| `periods.thisWeek()` | Monday 00:00 UTC to now |
| `periods.lastWeek()` | Previous Monday to this Monday |
| `periods.thisMonth()` | 1st of month to now |
| `periods.lastMonth()` | 1st of last month to 1st of this month |
| `periods.lastNDays(n)` | Rolling N-day window |
| `periods.lastNHours(n)` | Rolling N-hour window |
| `periods.since(date)` | Everything after a Date or ISO string |

All dates are UTC ISO 8601 strings. Each returns `{ since, before? }`.

## Auto-Pagination

Every paginated resource has a `searchAll()` method that returns an async iterator, walking all pages automatically:

```typescript
// Iterate every matching episode across all pages
for await (const episode of client.episodes.searchAll({
  query: 'artificial intelligence',
  ...periods.thisWeek(),
  has_guests: true,
})) {
  console.log(episode.episode_title);
  console.log('  Guests:', episode.metadata?.guests.map(g => g.guest_name).join(', '));
}
```

Available auto-paginating methods:

| Resource | Method | Yields |
|---|---|---|
| `client.episodes` | `searchAll(params)` | `Episode` |
| `client.episodes` | `getByPodcastAll(params)` | `Episode` |
| `client.podcasts` | `searchAll(params)` | `Podcast` |
| `client.topics` | `searchAll(params)` | `TopicSummary` |
| `client.topics` | `getEpisodesAll(params)` | `Episode` |
| `client.entities` | `searchAll(params)` | `Entity` |

## Delta Sync (Checkpoints)

Track what you've already pulled so the next run only fetches new content:

```typescript
import { PodscanClient, periods } from 'podscan';

const client = new PodscanClient({ apiKey: process.env.PODSCAN_API_KEY! });

// First run: pull this week's episodes
const paginator = client.episodes.searchAll({
  query: 'AI',
  ...periods.thisWeek(),
});

for await (const episode of paginator) {
  await saveToDatabase(episode);
}

// Save checkpoint
const checkpoint = paginator.checkpoint();
// { lastSeenAt: '2026-02-16T14:30:00Z', lastSeenId: 'ep_abc123', totalSeen: 142 }
await saveCheckpoint(checkpoint);

// Next run: only get new episodes since last checkpoint
const lastCheckpoint = await loadCheckpoint();
const newEpisodes = client.episodes.searchAll({
  query: 'AI',
  since: lastCheckpoint.lastSeenAt,
});

for await (const episode of newEpisodes) {
  await saveToDatabase(episode);
}
```

## Transcripts and Guest Data

Every episode includes full transcript and structured metadata with host/guest/speaker info:

```typescript
const results = await client.episodes.search({
  query: 'machine learning',
  has_guests: true,
  ...periods.thisWeek(),
  per_page: 10,
});

for (const ep of results.episodes) {
  // Full transcript with timestamps and speaker labels
  console.log(ep.episode_transcript);
  // "[00:00:08] [SPEAKER_01] Welcome to the show..."

  // Structured metadata
  const meta = ep.metadata;
  if (meta) {
    // Hosts
    for (const host of meta.hosts) {
      console.log(`Host: ${host.host_name} (${host.host_company})`);
    }

    // Guests with social links and occupation
    for (const guest of meta.guests) {
      console.log(`Guest: ${guest.guest_name}`);
      console.log(`  Occupation: ${guest.guest_occupation}`);
      console.log(`  Social: ${guest.guest_social_media_links?.join(', ')}`);
    }

    // Speaker label to name mapping
    console.log('Speakers:', meta.speakers);
    // { "SPEAKER_01": "John Smith", "SPEAKER_02": "Jane Doe" }

    // AI-generated summaries
    console.log('Summary:', meta.summary_short);
    console.log('Keywords:', meta.summary_keywords);
  }
}
```

Transcript formatting options:

```typescript
// Clean text without timestamps
const clean = await client.episodes.search({
  query: 'AI',
  remove_timestamps: true,
  remove_speaker_labels: true,
});

// Paragraphs (merges segments)
const paragraphs = await client.episodes.search({
  query: 'AI',
  transcript_formatter: 'paragraphs',
});

// Exclude transcript entirely (saves bandwidth)
const noTranscript = await client.episodes.search({
  query: 'AI',
  exclude_transcript: true,
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
