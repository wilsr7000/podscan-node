import type { Checkpoint, Pagination } from './types.js';

/**
 * A function that fetches one page of results.
 * The paginator calls it with incrementing page numbers.
 */
export type PageFetcher<T> = (page: number) => Promise<{
  items: T[];
  pagination: Pagination;
}>;

/**
 * Extracts the `posted_at` or `created_at` timestamp from an item, if present.
 * Used internally for checkpoint tracking.
 */
function extractTimestamp(item: unknown): string | null {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    if (typeof record.posted_at === 'string') return record.posted_at;
    if (typeof record.created_at === 'string') return record.created_at;
  }
  return null;
}

/**
 * Extracts an ID field from an item (tries common patterns).
 */
function extractId(item: unknown): string | null {
  if (item && typeof item === 'object') {
    const record = item as Record<string, unknown>;
    for (const key of [
      'episode_id',
      'podcast_id',
      'topic_id',
      'entity_id',
      'alert_id',
      'mention_id',
    ]) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return null;
}

/**
 * An async-iterable paginator that walks through all pages of a paginated
 * API response, yielding individual items.
 *
 * ```ts
 * const paginator = new Paginator(async (page) => {
 *   const res = await client.episodes.search({ query: 'AI', page, per_page: 50 });
 *   return { items: res.episodes, pagination: res.pagination };
 * });
 *
 * for await (const episode of paginator) {
 *   console.log(episode.episode_title);
 * }
 *
 * console.log(paginator.checkpoint());
 * ```
 */
export class Paginator<T> implements AsyncIterable<T> {
  private readonly fetcher: PageFetcher<T>;
  private _totalSeen = 0;
  private _lastSeenAt: string | null = null;
  private _lastSeenId: string | null = null;

  constructor(fetcher: PageFetcher<T>) {
    this.fetcher = fetcher;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let currentPage = 1;
    let lastPage = 1;

    do {
      const result = await this.fetcher(currentPage);
      lastPage = result.pagination.last_page;

      for (const item of result.items) {
        this._totalSeen++;
        const ts = extractTimestamp(item);
        const id = extractId(item);
        if (ts) this._lastSeenAt = ts;
        if (id) this._lastSeenId = id;
        yield item;
      }

      currentPage++;
    } while (currentPage <= lastPage);
  }

  /**
   * Returns a checkpoint representing the sync position after iteration.
   * Save this and pass `checkpoint.lastSeenAt` as `since` on the next run
   * to only fetch new items.
   */
  checkpoint(): Checkpoint {
    return {
      lastSeenAt: this._lastSeenAt ?? '',
      lastSeenId: this._lastSeenId ?? '',
      totalSeen: this._totalSeen,
    };
  }

  /** Total number of items yielded so far. */
  get totalSeen(): number {
    return this._totalSeen;
  }
}
