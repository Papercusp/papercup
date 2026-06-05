/**
 * loadHarnessSpend tests (cross-backend-cost-capture P-006).
 *
 * Reads real per-harness spend from `agent_usage_samples` — total $cost,
 * the estimated-from-tokens subset (cost_source='estimated'), token
 * throughput, and run count, all workspace + harness scoped.
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
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([]),
    });
    expect(out).toEqual({
      harnessTotalUsdThisWeek: 0,
      estimatedUsdThisWeek: 0,
      tokensThisWeek: 0,
      runsThisWeek: 0,
    });
  });

  it('reads total / estimated / tokens / runs from agent_usage_samples', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: 7, total_usd: 12.5, estimated_usd: 4.5, tokens: 1_500_000 }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(12.5);
    expect(out.estimatedUsdThisWeek).toBe(4.5);
    expect(out.tokensThisWeek).toBe(1_500_000);
    expect(out.runsThisWeek).toBe(7);
  });

  it('coerces string aggregates (postgres bigint/numeric come back as strings)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: '3', total_usd: '0.030000', estimated_usd: '0', tokens: '4096' }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBeCloseTo(0.03, 9);
    expect(out.estimatedUsdThisWeek).toBe(0);
    expect(out.tokensThisWeek).toBe(4096);
    expect(out.runsThisWeek).toBe(3);
  });

  it('degrades to zeros when the table/columns are missing (pre-migration substrate)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: () => {
            throw new Error('column "cost_source" does not exist');
          },
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.estimatedUsdThisWeek).toBe(0);
  });

  it('scopes the query by workspace_id + harness_slug as $1/$2 (P-041)', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return [{ runs: 0, total_usd: 0, estimated_usd: 0, tokens: 0 }];
    }) as unknown as RunQuery;
    await loadHarnessSpend({
      workspace_id: 'ws-alpha',
      harness_slug: 'papercup',
      runQuery,
    });
    expect(calls.length).toBe(1);
    expect(calls[0].query).toMatch(/workspace_id\s*=\s*\$1/);
    expect(calls[0].query).toMatch(/harness_slug\s*=\s*\$2/);
    expect(calls[0].params[0]).toBe('ws-alpha');
    expect(calls[0].params[1]).toBe('papercup');
  });

  it('handles null aggregates (no rows in window)', async () => {
    const out = await loadHarnessSpend({
      workspace_id: 'ws-test',
      harness_slug: 'papercup',
      runQuery: makeRunQuery([
        {
          match: /agent_usage_samples/,
          rows: [{ runs: 0, total_usd: null, estimated_usd: null, tokens: null }],
        },
      ]),
    });
    expect(out.harnessTotalUsdThisWeek).toBe(0);
    expect(out.tokensThisWeek).toBe(0);
  });
});
