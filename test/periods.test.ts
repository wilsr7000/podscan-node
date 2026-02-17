import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { periods } from '../src/periods.js';

function isISO(s: string): boolean {
  return !isNaN(new Date(s).getTime()) && s.includes('T');
}

describe('periods', () => {
  // -----------------------------------------------------------------------
  // today()
  // -----------------------------------------------------------------------

  it('today() returns since as midnight UTC today', () => {
    const result = periods.today();
    assert.ok(isISO(result.since), 'since should be ISO string');
    assert.equal(result.before, undefined, 'before should be undefined (open-ended)');

    const sinceDate = new Date(result.since);
    const now = new Date();
    assert.equal(sinceDate.getUTCHours(), 0);
    assert.equal(sinceDate.getUTCMinutes(), 0);
    assert.equal(sinceDate.getUTCSeconds(), 0);
    assert.equal(sinceDate.getUTCDate(), now.getUTCDate());
  });

  // -----------------------------------------------------------------------
  // yesterday()
  // -----------------------------------------------------------------------

  it('yesterday() returns a closed range from yesterday midnight to today midnight', () => {
    const result = periods.yesterday();
    assert.ok(isISO(result.since));
    assert.ok(result.before, 'before should be defined');
    assert.ok(isISO(result.before!));

    const since = new Date(result.since);
    const before = new Date(result.before!);
    const diffMs = before.getTime() - since.getTime();
    assert.equal(diffMs, 24 * 60 * 60 * 1000, 'should span exactly 24 hours');
    assert.equal(since.getUTCHours(), 0);
    assert.equal(before.getUTCHours(), 0);
  });

  // -----------------------------------------------------------------------
  // last24Hours()
  // -----------------------------------------------------------------------

  it('last24Hours() returns since ~24h ago', () => {
    const result = periods.last24Hours();
    assert.ok(isISO(result.since));
    assert.equal(result.before, undefined);

    const since = new Date(result.since);
    const now = new Date();
    const diffHours = (now.getTime() - since.getTime()) / (60 * 60 * 1000);
    assert.ok(diffHours >= 23.99 && diffHours <= 24.01, `should be ~24h ago, got ${diffHours}h`);
  });

  // -----------------------------------------------------------------------
  // thisWeek()
  // -----------------------------------------------------------------------

  it('thisWeek() returns since as Monday midnight UTC', () => {
    const result = periods.thisWeek();
    assert.ok(isISO(result.since));
    assert.equal(result.before, undefined);

    const since = new Date(result.since);
    const dayOfWeek = since.getUTCDay();
    assert.equal(dayOfWeek, 1, 'should be Monday (1)');
    assert.equal(since.getUTCHours(), 0);
    assert.equal(since.getUTCMinutes(), 0);
  });

  // -----------------------------------------------------------------------
  // lastWeek()
  // -----------------------------------------------------------------------

  it('lastWeek() returns Monday-to-Monday 7-day range', () => {
    const result = periods.lastWeek();
    assert.ok(isISO(result.since));
    assert.ok(result.before);
    assert.ok(isISO(result.before!));

    const since = new Date(result.since);
    const before = new Date(result.before!);
    const diffDays = (before.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
    assert.equal(diffDays, 7, 'should span exactly 7 days');
    assert.equal(since.getUTCDay(), 1, 'since should be Monday');
    assert.equal(before.getUTCDay(), 1, 'before should be Monday');
  });

  // -----------------------------------------------------------------------
  // thisMonth()
  // -----------------------------------------------------------------------

  it('thisMonth() returns since as 1st of current month', () => {
    const result = periods.thisMonth();
    assert.ok(isISO(result.since));
    assert.equal(result.before, undefined);

    const since = new Date(result.since);
    const now = new Date();
    assert.equal(since.getUTCDate(), 1, 'should be 1st of month');
    assert.equal(since.getUTCMonth(), now.getUTCMonth());
    assert.equal(since.getUTCHours(), 0);
  });

  // -----------------------------------------------------------------------
  // lastMonth()
  // -----------------------------------------------------------------------

  it('lastMonth() returns 1st-to-1st month range', () => {
    const result = periods.lastMonth();
    assert.ok(isISO(result.since));
    assert.ok(result.before);
    assert.ok(isISO(result.before!));

    const since = new Date(result.since);
    const before = new Date(result.before!);
    assert.equal(since.getUTCDate(), 1, 'since should be 1st');
    assert.equal(before.getUTCDate(), 1, 'before should be 1st');
    assert.ok(before.getTime() > since.getTime(), 'before should be after since');
  });

  // -----------------------------------------------------------------------
  // lastNDays()
  // -----------------------------------------------------------------------

  it('lastNDays(3) returns since ~3 days ago', () => {
    const result = periods.lastNDays(3);
    assert.ok(isISO(result.since));
    assert.equal(result.before, undefined);

    const since = new Date(result.since);
    const now = new Date();
    const diffDays = (now.getTime() - since.getTime()) / (24 * 60 * 60 * 1000);
    assert.ok(diffDays >= 2.99 && diffDays <= 3.01, `should be ~3 days ago, got ${diffDays}`);
  });

  // -----------------------------------------------------------------------
  // lastNHours()
  // -----------------------------------------------------------------------

  it('lastNHours(6) returns since ~6 hours ago', () => {
    const result = periods.lastNHours(6);
    assert.ok(isISO(result.since));
    assert.equal(result.before, undefined);

    const since = new Date(result.since);
    const now = new Date();
    const diffHours = (now.getTime() - since.getTime()) / (60 * 60 * 1000);
    assert.ok(diffHours >= 5.99 && diffHours <= 6.01, `should be ~6h ago, got ${diffHours}`);
  });

  // -----------------------------------------------------------------------
  // since()
  // -----------------------------------------------------------------------

  it('since() accepts an ISO string', () => {
    const result = periods.since('2026-02-01T00:00:00Z');
    assert.equal(result.since, '2026-02-01T00:00:00.000Z');
    assert.equal(result.before, undefined);
  });

  it('since() accepts a Date object', () => {
    const d = new Date('2026-01-15T12:00:00Z');
    const result = periods.since(d);
    assert.equal(result.since, '2026-01-15T12:00:00.000Z');
  });

  // -----------------------------------------------------------------------
  // Spreadability
  // -----------------------------------------------------------------------

  it('results can be spread into search params', () => {
    const range = periods.thisWeek();
    const params = {
      query: 'AI',
      ...range,
      per_page: 50,
    };
    assert.equal(params.query, 'AI');
    assert.equal(params.since, range.since);
    assert.equal(params.per_page, 50);
  });
});
