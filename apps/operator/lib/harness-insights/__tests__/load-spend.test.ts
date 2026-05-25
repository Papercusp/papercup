/**
 * loadHarnessSpend tests.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessSpend } from '../load-spend';

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

describe('loadHarnessSpend', () => {
  it('zeros when no rows', async () => {
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: makeRunQuery([]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.viewerUsdThisWeek).toBe(0);
    expect(out.proxyWitnessExplainerHref).toBeNull();
  });

  it('converts microcents to USD for both totals', async () => {
    let firstCall = true;
    const runQuery = vi.fn(async (query: string) => {
      // The first matching query (no user_id_text filter) = total
      if (firstCall && /tool_invocations/.test(query)) {
        firstCall = false;
        return [{ sum: 100_000_000 }]; // $100
      }
      if (/user_id_text/.test(query)) {
        return [{ sum: 25_500_000 }]; // $25.50
      }
      return [];
    }) as unknown as RunQuery;
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery,
    });
    expect(out.harnessTotalUsdThisWeek).toBe(100);
    expect(out.viewerUsdThisWeek).toBe(25.5);
  });

  it('threads explainer href through', async () => {
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      proxyWitnessExplainerHref: '/internal/docs/proxy-witness-pattern',
      runQuery: makeRunQuery([]),
    });
    expect(out.proxyWitnessExplainerHref).toBe(
      '/internal/docs/proxy-witness-pattern',
    );
  });

  it('per-source failures are swallowed', async () => {
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: makeRunQuery([
        {
          match: /tool_invocations/,
          rows: () => {
            throw new Error('relation does not exist');
          },
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.viewerUsdThisWeek).toBe(0);
  });

  it('coerces string microcents to number', async () => {
    let firstCall = true;
    const runQuery = vi.fn(async (query: string) => {
      if (firstCall && /tool_invocations/.test(query)) {
        firstCall = false;
        return [{ sum: '50000000' }];
      }
      return [];
    }) as unknown as RunQuery;
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery,
    });
    expect(out.harnessTotalUsdThisWeek).toBe(50);
  });

  it('handles null sum (no rows in window)', async () => {
    const out = await loadHarnessSpend({
      harness_slug: 'papercup',
      viewer_github_user_id: 42,
      runQuery: makeRunQuery([
        { match: /tool_invocations/, rows: [{ sum: null }] },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.viewerUsdThisWeek).toBe(0);
  });
});
