/**
 * loadYourPlace tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadYourPlace } from '../load-your-place';

type RunQuery = <T = unknown>(query: string, params: unknown[]) => Promise<T[]>;

function makeRunQuery(
  stubs: Array<{ match: RegExp; rows: unknown[] | (() => never) }>,
): RunQuery {
  return vi.fn(async (query: string): Promise<unknown[]> => {
    for (const s of stubs) {
      if (s.match.test(query)) {
        if (typeof s.rows === 'function') return s.rows();
        return s.rows;
      }
    }
    return [];
  }) as unknown as RunQuery;
}

const baseArgs = {
  workspace_id: 'ws-1',
  harness_slug: 'papercup',
  viewer_github_user_id: 42,
};

describe('loadYourPlace', () => {
  it('returns zero counts when every table is empty', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([]),
    });
    expect(out).toEqual({
      queue: { queued: 0, working: 0, shipped_this_week: 0 },
      role: {
        pr_reviewer_enabled: false,
        is_provisional_owner: false,
        is_claimant: false,
      },
      trust: { trusted_authors_count: 0, trusted_by_count: 0 },
      spend: { spent_usd_this_week: 0 },
    });
  });

  it('reads queue counts', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([
        { match: /FROM harness_shared\.feature_queue/, rows: [{ n: '3' }] },
        {
          match: /status IN \('claiming', 'working', 'wip'\)/,
          rows: [{ n: 1 }],
        },
        {
          match: /status = 'shipped'/,
          rows: [{ n: 5 }],
        },
      ]),
    });
    expect(out.queue).toEqual({ queued: 3, working: 1, shipped_this_week: 5 });
  });

  it('reads role flags', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([
        {
          match: /pr_reviewer_role_enabled AS b/,
          rows: [{ b: true }],
        },
        {
          match: /provisional_owner_github_user_id = \$3/,
          rows: [{ b: true }],
        },
        {
          match: /claimed_by_github_user_ids\)/,
          rows: [{ b: false }],
        },
      ]),
    });
    expect(out.role).toEqual({
      pr_reviewer_enabled: true,
      is_provisional_owner: true,
      is_claimant: false,
    });
  });

  it('counts trust both directions', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([
        {
          match: /trusted_by_github_user_id = \$3/,
          rows: [{ n: 2 }],
        },
        {
          match: /trusted_github_user_id = \$3/,
          rows: [{ n: 7 }],
        },
      ]),
    });
    expect(out.trust).toEqual({
      trusted_authors_count: 2,
      trusted_by_count: 7,
    });
  });

  it('converts spend microcents to dollars', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([
        {
          match: /tool_invocations/,
          rows: [{ cents: 12_345_678 }],
        },
      ]),
    });
    expect(out.spend.spent_usd_this_week).toBeCloseTo(12.345678, 6);
  });

  it('per-section failures are swallowed', async () => {
    const out = await loadYourPlace({
      ...baseArgs,
      runQuery: makeRunQuery([
        {
          match: /FROM harness_shared\.feature_queue/,
          rows: () => {
            throw new Error('relation does not exist');
          },
        },
        {
          match: /pr_reviewer_role_enabled AS b/,
          rows: [{ b: true }],
        },
      ]),
    });
    expect(out.queue.queued).toBe(0);
    expect(out.role.pr_reviewer_enabled).toBe(true);
  });

  it('respects custom window for shipped-this-week + spend', async () => {
    const customWindow = 86_400_000; // 1d
    const captured: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      captured.push({ query, params });
      return [];
    }) as unknown as RunQuery;
    await loadYourPlace({
      ...baseArgs,
      windowMs: customWindow,
      runQuery,
    });
    // Find the shipped-this-week query in captured params. P-041 prepended
    // workspace_id as $1, so the param order is now
    // [workspace_id, harness_slug, viewer, windowStart] → windowStart is [3].
    const shipped = captured.find((c) => /status = 'shipped'/.test(c.query));
    expect(shipped).toBeTruthy();
    expect(shipped!.params[0]).toBe('ws-1'); // workspace-scoped (P-041)
    const ts = shipped!.params[3] as number;
    const expected = Date.now() - customWindow;
    expect(Math.abs(ts - expected)).toBeLessThan(5_000);
  });
});
