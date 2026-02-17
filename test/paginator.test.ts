import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Paginator } from '../src/paginator.js';
import type { Pagination } from '../src/types.js';

function makePagination(page: number, lastPage: number, total: number): Pagination {
  return {
    total,
    per_page: 2,
    current_page: page,
    last_page: lastPage,
    from: (page - 1) * 2 + 1,
    to: Math.min(page * 2, total),
  };
}

describe('Paginator', () => {
  // -----------------------------------------------------------------------
  // Basic iteration
  // -----------------------------------------------------------------------

  it('yields all items across multiple pages', async () => {
    const data = [
      { episode_id: 'ep_1', posted_at: '2026-02-15T10:00:00Z' },
      { episode_id: 'ep_2', posted_at: '2026-02-15T11:00:00Z' },
      { episode_id: 'ep_3', posted_at: '2026-02-15T12:00:00Z' },
      { episode_id: 'ep_4', posted_at: '2026-02-16T08:00:00Z' },
      { episode_id: 'ep_5', posted_at: '2026-02-16T09:00:00Z' },
    ];

    let fetchCount = 0;
    const paginator = new Paginator(async (page) => {
      fetchCount++;
      const start = (page - 1) * 2;
      const items = data.slice(start, start + 2);
      return { items, pagination: makePagination(page, 3, 5) };
    });

    const collected: string[] = [];
    for await (const item of paginator) {
      collected.push(item.episode_id);
    }

    assert.deepEqual(collected, ['ep_1', 'ep_2', 'ep_3', 'ep_4', 'ep_5']);
    assert.equal(fetchCount, 3, 'should have fetched 3 pages');
  });

  // -----------------------------------------------------------------------
  // Single page
  // -----------------------------------------------------------------------

  it('handles a single page of results', async () => {
    const paginator = new Paginator(async (page) => {
      return {
        items: [{ podcast_id: 'pd_1' }, { podcast_id: 'pd_2' }],
        pagination: makePagination(page, 1, 2),
      };
    });

    const collected: string[] = [];
    for await (const item of paginator) {
      collected.push(item.podcast_id);
    }

    assert.deepEqual(collected, ['pd_1', 'pd_2']);
  });

  // -----------------------------------------------------------------------
  // Empty results
  // -----------------------------------------------------------------------

  it('handles zero results gracefully', async () => {
    const paginator = new Paginator(async () => {
      return {
        items: [],
        pagination: { total: 0, per_page: 25, current_page: 1, last_page: 1, from: null, to: null },
      };
    });

    const collected: unknown[] = [];
    for await (const item of paginator) {
      collected.push(item);
    }

    assert.equal(collected.length, 0);
  });

  // -----------------------------------------------------------------------
  // Checkpoint
  // -----------------------------------------------------------------------

  it('checkpoint() tracks the last seen item', async () => {
    const paginator = new Paginator(async (page) => {
      const items =
        page === 1
          ? [
              { episode_id: 'ep_a', posted_at: '2026-02-14T10:00:00Z' },
              { episode_id: 'ep_b', posted_at: '2026-02-15T10:00:00Z' },
            ]
          : [{ episode_id: 'ep_c', posted_at: '2026-02-16T10:00:00Z' }];
      return { items, pagination: makePagination(page, 2, 3) };
    });

    for await (const _item of paginator) {
      // consume all
    }

    const cp = paginator.checkpoint();
    assert.equal(cp.lastSeenId, 'ep_c');
    assert.equal(cp.lastSeenAt, '2026-02-16T10:00:00Z');
    assert.equal(cp.totalSeen, 3);
  });

  it('checkpoint() returns empty strings before iteration', () => {
    const paginator = new Paginator(async () => ({
      items: [],
      pagination: { total: 0, per_page: 25, current_page: 1, last_page: 1, from: null, to: null },
    }));

    const cp = paginator.checkpoint();
    assert.equal(cp.lastSeenAt, '');
    assert.equal(cp.lastSeenId, '');
    assert.equal(cp.totalSeen, 0);
  });

  it('checkpoint() works with topic_id items', async () => {
    const paginator = new Paginator(async () => ({
      items: [{ topic_id: 'tp_abc', created_at: '2026-02-16T00:00:00Z' }],
      pagination: makePagination(1, 1, 1),
    }));

    for await (const _item of paginator) {
      // consume
    }

    const cp = paginator.checkpoint();
    assert.equal(cp.lastSeenId, 'tp_abc');
    assert.equal(cp.lastSeenAt, '2026-02-16T00:00:00Z');
    assert.equal(cp.totalSeen, 1);
  });

  // -----------------------------------------------------------------------
  // totalSeen
  // -----------------------------------------------------------------------

  it('totalSeen updates during iteration', async () => {
    const paginator = new Paginator(async () => ({
      items: [
        { episode_id: 'ep_1', posted_at: '2026-02-16T00:00:00Z' },
        { episode_id: 'ep_2', posted_at: '2026-02-16T01:00:00Z' },
      ],
      pagination: makePagination(1, 1, 2),
    }));

    assert.equal(paginator.totalSeen, 0);

    for await (const _item of paginator) {
      // consume
    }

    assert.equal(paginator.totalSeen, 2);
  });

  // -----------------------------------------------------------------------
  // Lazy fetching
  // -----------------------------------------------------------------------

  it('only fetches the next page when the current is exhausted', async () => {
    const fetchedPages: number[] = [];
    const paginator = new Paginator(async (page) => {
      fetchedPages.push(page);
      return {
        items: [{ episode_id: `ep_${page}`, posted_at: '2026-02-16T00:00:00Z' }],
        pagination: {
          total: 3,
          per_page: 1,
          current_page: page,
          last_page: 3,
          from: page,
          to: page,
        },
      };
    });

    const iter = paginator[Symbol.asyncIterator]();

    await iter.next();
    assert.deepEqual(fetchedPages, [1], 'should have fetched page 1');

    await iter.next();
    assert.deepEqual(fetchedPages, [1, 2], 'should have fetched page 2');

    await iter.next();
    assert.deepEqual(fetchedPages, [1, 2, 3], 'should have fetched page 3');
  });
});
