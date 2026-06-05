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
import { loadHarnessActivity, mergeActivityEvents } from '../load';
import type { ActivityFeedEvent } from '../../harness-insights/card-types';

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

  it('interleaves githubEvents with the PG ledger by tsEpoch desc', async () => {
    const now = Date.now();
    const ghPr: ActivityFeedEvent = {
      id: 'pr-gh-500',
      kind: 'pr_merged',
      text: 'merged PR #500 — from GitHub',
      actorLogin: 'octocat',
      whenLabel: '2m ago',
      href: 'https://github.com/x/y/pull/500',
      tsEpoch: now - 120_000, // 2m ago — between the two PG events below
      dedupKey: 'pr:500',
    };
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      githubEvents: [ghPr],
      runQuery: makeRunQuery([
        {
          match: /harness_features_consolidated/,
          rows: [
            {
              feature_id: 'F-RECENT',
              title: 'Recent',
              updated_ts: now - 30_000, // 30s ago — newest
              taken_by: 'a',
            },
          ],
        },
        {
          match: /FROM harness_shared\.contributors/,
          rows: [
            { github_username: 'old', joined_at: new Date(now - 7 * 86_400_000) }, // 7d ago — oldest
          ],
        },
      ]),
    });
    expect(events.map((e) => e.id)).toEqual([
      'feature-F-RECENT',
      'pr-gh-500',
      'contrib-old-' + (now - 7 * 86_400_000),
    ]);
  });

  it('dedupes a PR present in both PG and GitHub (GitHub wins)', async () => {
    const now = Date.now();
    const ghPr: ActivityFeedEvent = {
      id: 'pr-gh-77',
      kind: 'pr_merged',
      text: 'merged PR #77 — verified from GitHub',
      actorLogin: 'octocat',
      whenLabel: '1m ago',
      href: 'https://github.com/x/y/pull/77',
      tsEpoch: now - 60_000,
      dedupKey: 'pr:77',
    };
    const events = await loadHarnessActivity({
      workspace_id: 'ws-1',
      harness_slug: 'papercup',
      githubEvents: [ghPr],
      runQuery: makeRunQuery([
        {
          match: /auto_review_audit/,
          rows: [
            {
              id: '999',
              pr_number: 77, // same PR as the GitHub event → dedup key pr:77
              pr_url: null,
              author_github_id: 42,
              ts: new Date(now - 65_000),
            },
          ],
        },
      ]),
    });
    // Only one PR #77 row, and it's the GitHub (tier-A) one.
    const prRows = events.filter((e) => e.kind === 'pr_merged');
    expect(prRows).toHaveLength(1);
    expect(prRows[0]?.id).toBe('pr-gh-77');
    expect(prRows[0]?.text).toContain('verified from GitHub');
  });
});

function ev(
  id: string,
  tsEpoch: number,
  overrides: Partial<ActivityFeedEvent> = {},
): ActivityFeedEvent {
  return {
    id,
    kind: 'pr_merged',
    text: id,
    actorLogin: 'x',
    whenLabel: 'now',
    tsEpoch,
    ...overrides,
  };
}

describe('mergeActivityEvents', () => {
  it('sorts both streams by tsEpoch desc', () => {
    const out = mergeActivityEvents(
      [ev('pg-old', 100), ev('pg-new', 300)],
      [ev('gh-mid', 200, { dedupKey: 'pr:1' })],
      10,
    );
    expect(out.map((e) => e.id)).toEqual(['pg-new', 'gh-mid', 'pg-old']);
  });

  it('dedupes by dedupKey, keeping the GitHub event over the PG one', () => {
    const out = mergeActivityEvents(
      [ev('pg-pr', 100, { dedupKey: 'pr:5', text: 'pg copy' })],
      [ev('gh-pr', 100, { dedupKey: 'pr:5', text: 'gh copy' })],
      10,
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.id).toBe('gh-pr');
    expect(out[0]?.text).toBe('gh copy');
  });

  it('never dedupes unkeyed events against each other', () => {
    const out = mergeActivityEvents(
      [ev('a', 100), ev('b', 90)],
      [ev('c', 110)],
      10,
    );
    expect(out).toHaveLength(3);
  });

  it('caps to limit', () => {
    const pg = Array.from({ length: 30 }, (_, i) => ev(`e${i}`, 1000 - i));
    expect(mergeActivityEvents(pg, [], 20)).toHaveLength(20);
  });

  it('sorts events without tsEpoch last', () => {
    const out = mergeActivityEvents(
      [ev('has-ts', 500), { ...ev('no-ts', 0), tsEpoch: undefined }],
      [],
      10,
    );
    expect(out[0]?.id).toBe('has-ts');
    expect(out[1]?.id).toBe('no-ts');
  });
});
