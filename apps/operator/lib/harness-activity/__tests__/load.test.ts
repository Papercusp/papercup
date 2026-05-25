/**
 * loadHarnessActivity tests.
 *
 * Fakes runQuery so no PG is touched. Verifies:
 *   - empty PG → empty array
 *   - missing-table errors are swallowed per source
 *   - merge sorts by recency desc
 *   - limit clips the output
 *   - buildHref override flows through
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadHarnessActivity } from '../load';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(
  byMatcher: Array<{ match: RegExp; rows: unknown[] | (() => never) }>,
): RunQuery {
  return vi.fn(async (query: string): Promise<unknown[]> => {
    for (const s of byMatcher) {
      if (s.match.test(query)) {
        if (typeof s.rows === 'function') return s.rows();
        return s.rows;
      }
    }
    return [];
  }) as unknown as RunQuery;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-25T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('loadHarnessActivity', () => {
  it('returns empty array when no rows', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(events).toEqual([]);
  });

  it('aggregates feature_shipped rows', async () => {
    const now = Date.now();
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              feature_id: 'F-1',
              title: 'First',
              updated_ts: now - 60_000,
              taken_by: 'alice',
            },
          ],
        },
      ]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('feature_shipped');
    expect(events[0]?.text).toContain('F-1');
    expect(events[0]?.text).toContain('First');
    expect(events[0]?.actorLogin).toBe('alice');
  });

  it('aggregates pr_merged from auto_review_audit', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '7',
              pr_number: 123,
              pr_url: 'https://github.com/x/y/pull/123',
              author_github_id: 42,
              ts: new Date(Date.now() - 30_000),
            },
          ],
        },
      ]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('pr_merged');
    expect(events[0]?.text).toContain('#123');
    expect(events[0]?.href).toBe('https://github.com/x/y/pull/123');
  });

  it('aggregates contributor_joined rows', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.contributors/,
          rows: [
            { github_username: 'alice', joined_at: new Date(Date.now() - 86_400_000) },
          ],
        },
      ]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('contributor_joined');
    expect(events[0]?.actorLogin).toBe('alice');
  });

  it('aggregates escalation_opened from claim_audit', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.claim_audit/,
          rows: [
            {
              id: '1',
              feature_id: 'F-5',
              claimer_github_user_id: '42',
              outcome: 'lost-race',
              ts: new Date(Date.now() - 600_000),
            },
          ],
        },
      ]),
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('escalation_opened');
    expect(events[0]?.text).toContain('F-5');
    expect(events[0]?.text).toContain('lost-race');
  });

  it('missing-table failures are swallowed per source', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: () => {
            throw new Error('relation does not exist');
          },
        },
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '1',
              pr_number: 1,
              pr_url: null,
              author_github_id: null,
              ts: new Date(Date.now() - 10_000),
            },
          ],
        },
      ]),
    });
    // shipped source threw — pr_merged still surfaces.
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe('pr_merged');
  });

  it('sorts by recency (most recent first)', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              feature_id: 'F-OLD',
              title: 'Old',
              updated_ts: Date.now() - 7 * 24 * 3_600_000, // 7 days
              taken_by: 'a',
            },
          ],
        },
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '1',
              pr_number: 1,
              pr_url: null,
              author_github_id: 1,
              ts: new Date(Date.now() - 60_000), // 1 minute
            },
          ],
        },
      ]),
    });
    expect(events[0]?.kind).toBe('pr_merged');
    expect(events[1]?.kind).toBe('feature_shipped');
  });

  it('respects limit', async () => {
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      limit: 2,
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: Array.from({ length: 5 }, (_, i) => ({
            feature_id: `F-${i}`,
            title: `T${i}`,
            updated_ts: Date.now() - (i + 1) * 60_000,
            taken_by: 'a',
          })),
        },
      ]),
    });
    expect(events).toHaveLength(2);
  });

  it('threads buildHref through to event.href', async () => {
    const buildHref = vi.fn(
      (kind: string, refId: string) => `/test/${kind}/${refId}`,
    );
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      buildHref,
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              feature_id: 'F-1',
              title: 'x',
              updated_ts: Date.now() - 1000,
              taken_by: 'a',
            },
          ],
        },
      ]),
    });
    expect(events[0]?.href).toBe('/test/feature_shipped/F-1');
  });
});
