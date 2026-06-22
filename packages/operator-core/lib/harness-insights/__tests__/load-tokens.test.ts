/**
 * loadHarnessTokens — B-TOK-UI Tokens dashboard loader tests.
 *
 * The whole point of B-TOK is CACHE-INCLUSIVE accounting (the old input+output-only
 * sum under-counted ~105×, cache-read = 92.5% of tokens), so the load-bearing
 * assertion here is that EVERY query sums all four token types. Pure logic — an
 * injected runQuery dispatches by query shape, so there is no DB dependency.
 */

import { describe, expect, it, vi } from 'vitest';
import { loadHarnessTokens } from '../load-tokens';

type Row = Record<string, unknown>;

/** A runQuery mock that returns canned rows keyed off the query's shape. */
function makeRunQuery(rows: {
  totals?: Row[];
  byModel?: Row[];
  byRole?: Row[];
  byAccount?: Row[];
  byDay?: Row[];
}) {
  const queries: string[] = [];
  const runQuery = vi.fn(async (query: string, _params: unknown[]) => {
    queries.push(query);
    if (query.includes('day_start')) return rows.byDay ?? [];
    if (query.includes('account_id AS key')) return rows.byAccount ?? [];
    if (query.includes("NULLIF(model")) return rows.byModel ?? [];
    if (query.includes("NULLIF(role")) return rows.byRole ?? [];
    return rows.totals ?? [];
  });
  return { runQuery, queries };
}

const baseOpts = { workspace_id: 'ws-1', harness_slug: 'papercusp' };

describe('loadHarnessTokens', () => {
  it('assembles a cache-inclusive snapshot with grouped breakdowns', async () => {
    const dayStart = Date.UTC(2026, 5, 14); // 2026-06-14 00:00 UTC
    const { runQuery, queries } = makeRunQuery({
      totals: [
        {
          runs: 120,
          total_usd: 42.5,
          estimated_usd: 5,
          tokens: 3_260_000_000,
          input_tokens: 10_000_000,
          output_tokens: 5_000_000,
          cache_read_tokens: 3_015_000_000,
          cache_creation_tokens: 230_000_000,
        },
      ],
      byModel: [
        { key: 'claude-opus-4', tokens: 2_900_000_000, cost_usd: 38, runs: 60 },
        { key: 'claude-sonnet-4', tokens: 360_000_000, cost_usd: 4.5, runs: 60 },
      ],
      byRole: [{ key: 'bee', tokens: 3_000_000_000, cost_usd: 40, runs: 100 }],
      byAccount: [{ key: 'acct-claude-a', tokens: 2_500_000_000, cost_usd: 35, runs: 80 }],
      byDay: [{ day_start: dayStart, tokens: 1_000_000, cost_usd: 12 }],
    });

    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });

    // Totals pass through, cache breakdown preserved.
    expect(snap.totals.tokens).toBe(3_260_000_000);
    expect(snap.totals.costUsd).toBe(42.5);
    expect(snap.totals.estimatedUsd).toBe(5);
    expect(snap.totals.runs).toBe(120);
    expect(snap.totals.cacheReadTokens).toBe(3_015_000_000);
    expect(snap.totals.cacheCreationTokens).toBe(230_000_000);

    // Grouped rows mapped + ordered as the query returned them.
    expect(snap.byModel.map((r) => r.key)).toEqual(['claude-opus-4', 'claude-sonnet-4']);
    expect(snap.byModel[0]).toMatchObject({ tokens: 2_900_000_000, costUsd: 38, runs: 60 });
    expect(snap.byRole).toHaveLength(1);
    expect(snap.byRole[0].key).toBe('bee');
    expect(snap.byAccount).toEqual([
      { key: 'acct-claude-a', tokens: 2_500_000_000, costUsd: 35, runs: 80 },
    ]);

    // Day bucket label is the deterministic UTC 'MMM D'.
    expect(snap.byDay).toEqual([{ startMs: dayStart, label: 'Jun 14', tokens: 1_000_000, costUsd: 12 }]);

    expect(snap.accountAttributionAvailable).toBe(true);
    expect(snap.windowMs).toBe(7 * 24 * 60 * 60 * 1000);

    // THE load-bearing guard: every query is cache-inclusive (all four token
    // columns), so the dashboard can never reproduce the undercount it exposes.
    expect(queries).toHaveLength(5);
    for (const q of queries) {
      expect(q).toContain('input_tokens');
      expect(q).toContain('output_tokens');
      expect(q).toContain('cache_read_tokens');
      expect(q).toContain('cache_creation_tokens');
    }
  });

  it('coerces string-typed numerics (pg returns SUM/COUNT as strings)', async () => {
    const { runQuery } = makeRunQuery({
      totals: [{ runs: '7', total_usd: '1.25', estimated_usd: '0', tokens: '900', input_tokens: '100', output_tokens: '50', cache_read_tokens: '700', cache_creation_tokens: '50' }],
      byModel: [{ key: 'opus', tokens: '900', cost_usd: '1.25', runs: '7' }],
    });
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals.tokens).toBe(900);
    expect(snap.totals.runs).toBe(7);
    expect(snap.byModel[0].tokens).toBe(900);
    expect(snap.byModel[0].runs).toBe(7);
  });

  it('honors windowMs + groupLimit (the LIMIT + window predicate)', async () => {
    const { runQuery, queries } = makeRunQuery({ totals: [{ runs: 0 }] });
    await loadHarnessTokens({ ...baseOpts, windowMs: 24 * 60 * 60 * 1000, groupLimit: 5, runQuery });
    const grouped = queries.filter((q) => q.includes('GROUP BY 1') && q.includes('LIMIT'));
    expect(grouped.length).toBeGreaterThan(0);
    for (const q of grouped) expect(q).toContain('LIMIT 5');
  });

  it('returns the empty snapshot when there are no samples', async () => {
    const { runQuery } = makeRunQuery({}); // every query returns []
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals.tokens).toBe(0);
    expect(snap.totals.runs).toBe(0);
    expect(snap.byModel).toEqual([]);
    expect(snap.byRole).toEqual([]);
    expect(snap.byAccount).toEqual([]);
    expect(snap.byDay).toEqual([]);
  });

  it('degrades to the empty snapshot when the query throws (pre-migration substrate)', async () => {
    const runQuery = vi.fn(async () => {
      throw new Error('column "cache_creation_tokens" does not exist');
    });
    const snap = await loadHarnessTokens({ ...baseOpts, runQuery });
    expect(snap.totals).toMatchObject({ tokens: 0, costUsd: 0, runs: 0 });
    expect(snap.byModel).toEqual([]);
    expect(snap.accountAttributionAvailable).toBe(false);
  });
});
