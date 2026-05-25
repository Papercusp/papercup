/**
 * insights_first_visit helpers — P-074 tests.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  getInsightsFirstVisit,
  markInsightsSeen,
  shouldForceRouteToInsights,
} from '../first-visit';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(rows: unknown[] | (() => never)): RunQuery {
  return vi.fn(async () => {
    if (typeof rows === 'function') return rows();
    return rows;
  }) as unknown as RunQuery;
}

const base = {
  workspace_id: 'ws-1',
  harness_slug: 'papercup',
  user_id: 'user-42',
};

describe('getInsightsFirstVisit', () => {
  it('returns null when no row', async () => {
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery([]),
    });
    expect(ts).toBeNull();
  });

  it('returns null when seen_at_ts is null', async () => {
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery([{ seen_at_ts: null }]),
    });
    expect(ts).toBeNull();
  });

  it('parses Date column value', async () => {
    const d = new Date('2026-05-25T00:00:00Z');
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery([{ seen_at_ts: d }]),
    });
    expect(ts).toBe(d.getTime());
  });

  it('parses string column value', async () => {
    const iso = '2026-05-25T00:00:00.000Z';
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery([{ seen_at_ts: iso }]),
    });
    expect(ts).toBe(new Date(iso).getTime());
  });

  it('returns null on unparseable string', async () => {
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery([{ seen_at_ts: 'not-a-date' }]),
    });
    expect(ts).toBeNull();
  });

  it('returns null when table is missing', async () => {
    const ts = await getInsightsFirstVisit({
      ...base,
      runQuery: makeRunQuery(() => {
        throw new Error('relation does not exist');
      }),
    });
    expect(ts).toBeNull();
  });
});

describe('markInsightsSeen', () => {
  it('runs an INSERT...ON CONFLICT statement', async () => {
    const runQuery = vi.fn(async () => []) as unknown as RunQuery;
    await markInsightsSeen({ ...base, runQuery });
    const [query, params] = (runQuery as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0];
    expect(query).toMatch(/INSERT INTO harness_shared\.insights_first_visit/);
    expect(query).toMatch(/ON CONFLICT/);
    expect(params).toEqual(['ws-1', 'papercup', 'user-42']);
  });

  it('swallows table-missing errors', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('relation does not exist');
    }) as unknown as RunQuery;
    await expect(markInsightsSeen({ ...base, runQuery })).resolves.toBeUndefined();
  });
});

describe('shouldForceRouteToInsights', () => {
  it('is true on first visit (no row)', async () => {
    const force = await shouldForceRouteToInsights({
      ...base,
      runQuery: makeRunQuery([]),
    });
    expect(force).toBe(true);
  });

  it('is false after the row has been seen', async () => {
    const force = await shouldForceRouteToInsights({
      ...base,
      runQuery: makeRunQuery([{ seen_at_ts: new Date() }]),
    });
    expect(force).toBe(false);
  });
});
