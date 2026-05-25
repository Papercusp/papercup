/**
 * loadUserRecentActivity tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadUserRecentActivity } from '../load-activity';

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

describe('loadUserRecentActivity', () => {
  it('returns empty when no visible harnesses', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: [],
      runQuery: makeRunQuery([]),
    });
    expect(rows).toEqual([]);
  });

  it('returns shipped events as feature_shipped entries', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              harness_slug: 'papercup',
              feature_id: 'F-1',
              title: 'x',
              updated_ts: 1_000_000,
            },
          ],
        },
      ]),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('feature_shipped');
    expect(rows[0]?.label).toContain('F-1');
    expect(rows[0]?.label).toContain('papercup');
    expect(rows[0]?.href).toBe('/harness/papercup');
  });

  it('returns pr_merged + contributor_joined + escalation_opened', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
      runQuery: makeRunQuery([
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '1',
              harness_slug: 'papercup',
              pr_number: 7,
              pr_url: null,
              ts: new Date(2_000_000),
            },
          ],
        },
        {
          match: /FROM harness_shared\.contributors/,
          rows: [
            {
              harness_slug: 'papercup',
              joined_at: new Date(1_500_000),
            },
          ],
        },
        {
          match: /FROM harness_shared\.claim_audit/,
          rows: [
            {
              id: '1',
              harness_slug: 'papercup',
              feature_id: 'F-X',
              outcome: 'lost-race',
              ts: new Date(2_500_000),
            },
          ],
        },
      ]),
    });
    const kinds = rows.map((r) => r.kind);
    expect(kinds).toContain('pr_merged');
    expect(kinds).toContain('contributor_joined');
    expect(kinds).toContain('escalation_opened');
  });

  it('sorts by ts desc', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              harness_slug: 'papercup',
              feature_id: 'F-1',
              title: 'x',
              updated_ts: 1_000,
            },
            {
              harness_slug: 'papercup',
              feature_id: 'F-2',
              title: 'y',
              updated_ts: 5_000,
            },
          ],
        },
      ]),
    });
    expect(rows[0]?.label).toContain('F-2');
    expect(rows[1]?.label).toContain('F-1');
  });

  it('respects limit', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
      limit: 2,
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: Array.from({ length: 5 }, (_, i) => ({
            harness_slug: 'papercup',
            feature_id: `F-${i}`,
            title: `t${i}`,
            updated_ts: 1000 + i,
          })),
        },
      ]),
    });
    expect(rows).toHaveLength(2);
  });

  it('per-source missing-table errors are swallowed', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
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
              harness_slug: 'papercup',
              pr_number: 7,
              pr_url: null,
              ts: new Date(2_000_000),
            },
          ],
        },
      ]),
    });
    expect(rows.map((r) => r.kind)).toEqual(['pr_merged']);
  });

  it('uses pr_url as href when present, else falls back to /harness/<slug>', async () => {
    const rows = await loadUserRecentActivity({
      github_user_id: 42,
      visible_harness_slugs: ['papercup'],
      runQuery: makeRunQuery([
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '1',
              harness_slug: 'papercup',
              pr_number: 7,
              pr_url: 'https://github.com/x/y/pull/7',
              ts: new Date(1_000),
            },
            {
              id: '2',
              harness_slug: 'papercup',
              pr_number: 8,
              pr_url: null,
              ts: new Date(500),
            },
          ],
        },
      ]),
    });
    expect(rows[0]?.href).toBe('https://github.com/x/y/pull/7');
    expect(rows[1]?.href).toBe('/harness/papercup');
  });
});
