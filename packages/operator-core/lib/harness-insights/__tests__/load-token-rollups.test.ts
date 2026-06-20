/**
 * load-token-rollups tests (B-TOK-ROLL) — the pricing-book read, the coordination
 * token breakdown (trigger + role-class), and the coord-poll quantification. Pure
 * logic via an injected runQuery (mirrors load-spend/load-tokens tests).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  loadModelPricingBook,
  loadCoordTokenBreakdown,
  loadCoordPollVolume,
  type RunQuery,
} from '../load-token-rollups';

function makeRunQuery(stubs: Array<{ match: RegExp; rows: unknown[] | (() => never) }>): RunQuery {
  return vi.fn(async (query: string): Promise<unknown[]> => {
    for (const s of stubs) {
      if (s.match.test(query)) return typeof s.rows === 'function' ? s.rows() : s.rows;
    }
    return [];
  }) as unknown as RunQuery;
}

describe('loadModelPricingBook', () => {
  it('reads the model_pricing rate book', async () => {
    const book = await loadModelPricingBook(
      makeRunQuery([
        {
          match: /model_pricing/,
          rows: [
            {
              model_id: 'claude-opus-4-8',
              input_per_mtok: '5.0',
              output_per_mtok: '25.0',
              cache_read_per_mtok: '0.5',
              cache_creation_per_mtok: '6.25',
              effective_date: '2026-06-05',
              source: 'code-table',
            },
          ],
        },
      ]),
    );
    expect(book).toHaveLength(1);
    expect(book[0]).toMatchObject({ modelId: 'claude-opus-4-8', inputPerMtok: 5, cacheReadPerMtok: 0.5 });
  });

  it('degrades to [] when the table is missing (pre-migration substrate)', async () => {
    const book = await loadModelPricingBook(
      makeRunQuery([{ match: /model_pricing/, rows: () => { throw new Error('relation does not exist'); } }]),
    );
    expect(book).toEqual([]);
  });
});

describe('loadCoordTokenBreakdown', () => {
  it('marks trigger attribution UNAVAILABLE when every row is unattributed (turn_trigger NULL — deploy-gated)', async () => {
    const out = await loadCoordTokenBreakdown({
      workspace_id: 'ws',
      runQuery: makeRunQuery([
        // turn_trigger query → only the 'unattributed' bucket
        { match: /turn_trigger/, rows: [{ trigger: 'unattributed', tokens: '100', cost_usd: '1', runs: '2' }] },
        // role-class query
        { match: /role = 'interactive'/, rows: [
          { role_class: 'fleet', tokens: '900', cost_usd: '9.0', runs: '5' },
          { role_class: 'interactive', tokens: '100', cost_usd: '1.0', runs: '3' },
        ] },
      ]),
    });
    expect(out.triggerAttributionAvailable).toBe(false);
    expect(out.byRoleClass.find((r) => r.roleClass === 'fleet')?.costUsd).toBe(9);
    expect(out.byRoleClass.find((r) => r.roleClass === 'interactive')?.costUsd).toBe(1);
  });

  it('marks trigger attribution AVAILABLE once a real trigger appears', async () => {
    const out = await loadCoordTokenBreakdown({
      workspace_id: 'ws',
      runQuery: makeRunQuery([
        { match: /turn_trigger/, rows: [
          { trigger: 'coord-wake', tokens: '800', cost_usd: '8', runs: '4' },
          { trigger: 'user', tokens: '200', cost_usd: '2', runs: '2' },
        ] },
        { match: /role = 'interactive'/, rows: [] },
      ]),
    });
    expect(out.triggerAttributionAvailable).toBe(true);
    expect(out.byTrigger.find((r) => r.trigger === 'coord-wake')?.costUsd).toBe(8);
  });

  it('role-class query degrades to [] but trigger section still resolves (independent defensiveness)', async () => {
    const out = await loadCoordTokenBreakdown({
      workspace_id: 'ws',
      runQuery: makeRunQuery([
        { match: /turn_trigger/, rows: [{ trigger: 'coord-wake', tokens: '5', cost_usd: '0.5', runs: '1' }] },
        { match: /role = 'interactive'/, rows: () => { throw new Error('boom'); } },
      ]),
    });
    expect(out.byTrigger).toHaveLength(1);
    expect(out.byRoleClass).toEqual([]);
  });

  it('adds the harness predicate as $2 only when harness_slug is given', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = vi.fn(async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return [];
    }) as unknown as RunQuery;
    await loadCoordTokenBreakdown({ workspace_id: 'ws', harness_slug: 'papercusp', runQuery });
    expect(calls[0].query).toMatch(/harness_slug = \$2/);
    expect(calls[0].params).toEqual(['ws', 'papercusp', expect.any(Number)]);

    calls.length = 0;
    await loadCoordTokenBreakdown({ workspace_id: 'ws', runQuery });
    expect(calls[0].query).not.toMatch(/harness_slug/);
    expect(calls[0].params).toEqual(['ws', expect.any(Number)]);
  });
});

describe('loadCoordPollVolume', () => {
  it('quantifies the wake-board poll and its share of all tool-invocation rows', async () => {
    const out = await loadCoordPollVolume({
      workspace_id: 'ws',
      runQuery: makeRunQuery([
        { match: /tool_name LIKE 'coord:%'/, rows: [
          { tool_name: 'coord:wake-queue', calls: '411036', distinct_callers: '1' },
          { tool_name: 'coord:wake-mode', calls: '410699', distinct_callers: '2' },
          { tool_name: 'coord:inbox', calls: '12364', distinct_callers: '12247' },
        ] },
        { match: /poll_rows/, rows: [{ total_rows: '1098013', poll_rows: '817713' }] },
      ]),
    });
    expect(out.wakePollCalls).toBe(411036 + 410699);
    expect(out.wakePollRowSharePct).toBeCloseTo(74.5, 1);
    expect(out.tools[0].toolName).toBe('coord:wake-queue');
  });

  it('degrades to an empty shape when tool_invocations is unavailable', async () => {
    const out = await loadCoordPollVolume({
      workspace_id: 'ws',
      runQuery: makeRunQuery([{ match: /coord:/, rows: () => { throw new Error('no table'); } }]),
    });
    expect(out).toMatchObject({ tools: [], wakePollCalls: 0, wakePollRowSharePct: 0 });
  });
});
