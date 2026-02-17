import type { DateRange } from './types.js';

/**
 * Computes an ISO 8601 UTC string for a Date.
 */
function toISO(d: Date): string {
  return d.toISOString();
}

/**
 * Returns midnight UTC for a given date (strips time).
 */
function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Returns the Monday 00:00 UTC of the week containing the given date.
 */
function startOfWeekUTC(d: Date): Date {
  const day = d.getUTCDay();
  const diff = day === 0 ? 6 : day - 1;
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - diff);
  return startOfDayUTC(monday);
}

/**
 * Returns the 1st of the month at 00:00 UTC.
 */
function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/**
 * Time period helpers for the Podscan SDK.
 *
 * Each method returns a `{ since, before? }` object that can be spread
 * directly into any search params:
 *
 * ```ts
 * const results = await client.episodes.search({
 *   query: 'AI',
 *   ...periods.thisWeek(),
 * });
 * ```
 */
export const periods = {
  /**
   * From midnight today (UTC) until now.
   */
  today(): DateRange {
    const now = new Date();
    return {
      since: toISO(startOfDayUTC(now)),
    };
  },

  /**
   * From midnight yesterday (UTC) to midnight today (UTC).
   */
  yesterday(): DateRange {
    const now = new Date();
    const todayStart = startOfDayUTC(now);
    const yesterdayStart = new Date(todayStart);
    yesterdayStart.setUTCDate(yesterdayStart.getUTCDate() - 1);
    return {
      since: toISO(yesterdayStart),
      before: toISO(todayStart),
    };
  },

  /**
   * Rolling window: now minus 24 hours.
   */
  last24Hours(): DateRange {
    const now = new Date();
    const past = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    return {
      since: toISO(past),
    };
  },

  /**
   * From Monday 00:00 UTC of the current week until now.
   */
  thisWeek(): DateRange {
    const now = new Date();
    return {
      since: toISO(startOfWeekUTC(now)),
    };
  },

  /**
   * From Monday 00:00 UTC of last week to Monday 00:00 UTC of this week.
   */
  lastWeek(): DateRange {
    const now = new Date();
    const thisMonday = startOfWeekUTC(now);
    const lastMonday = new Date(thisMonday);
    lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
    return {
      since: toISO(lastMonday),
      before: toISO(thisMonday),
    };
  },

  /**
   * From the 1st of the current month (UTC) until now.
   */
  thisMonth(): DateRange {
    const now = new Date();
    return {
      since: toISO(startOfMonthUTC(now)),
    };
  },

  /**
   * From the 1st of last month to the 1st of this month (UTC).
   */
  lastMonth(): DateRange {
    const now = new Date();
    const thisMonth = startOfMonthUTC(now);
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return {
      since: toISO(lastMonth),
      before: toISO(thisMonth),
    };
  },

  /**
   * Rolling window: now minus N days.
   */
  lastNDays(n: number): DateRange {
    const now = new Date();
    const past = new Date(now.getTime() - n * 24 * 60 * 60 * 1000);
    return {
      since: toISO(past),
    };
  },

  /**
   * Rolling window: now minus N hours.
   */
  lastNHours(n: number): DateRange {
    const now = new Date();
    const past = new Date(now.getTime() - n * 60 * 60 * 1000);
    return {
      since: toISO(past),
    };
  },

  /**
   * Everything after a given date. Accepts an ISO string or Date object.
   */
  since(date: string | Date): DateRange {
    const d = typeof date === 'string' ? new Date(date) : date;
    return {
      since: toISO(d),
    };
  },
};
