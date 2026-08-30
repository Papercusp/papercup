import { describe, expect, it } from 'vitest';
import {
  ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS,
  buildAdmissionShardPlan,
  partitionTextContextIds,
  withCensusStatementTimeout,
  TEXT_CONTEXT_BATCH_SIZE,
  type AdmissionCensusEdge,
  type AdmissionCensusItem,
  type AdmissionCensusRunOptions,
} from './work-items-admission-census';

function item(
  id: string,
  tokens: number,
  originClass: AdmissionCensusItem['originClass'] = 'agent-filed',
): AdmissionCensusItem {
  return {
    id,
    title: id,
    summary: '',
    estimatedTokens: tokens,
    originClass,
    hasEmbedding: true,
    embeddingMode: 'gemma',
  };
}

function edge(a: string, b: string, similarity: number): AdmissionCensusEdge {
  return { a, b, similarity, source: 'cosine' };
}

describe('buildAdmissionShardPlan', () => {
  it('is deterministic and covers every corpus item exactly once as a member', () => {
    const items = [item('a', 60), item('b', 50), item('c', 60), item('d', 50), item('e', 20)];
    const edges = [edge('a', 'b', 0.95), edge('c', 'd', 0.94), edge('a', 'c', 0.88)];
    const first = buildAdmissionShardPlan(
      items,
      edges,
      edges.filter((e) => e.similarity >= 0.9),
      {
        targetTokens: 130,
        ghostFraction: 0.5,
      },
    );
    const second = buildAdmissionShardPlan(
      [...items].reverse(),
      [...edges].reverse(),
      edges.filter((e) => e.similarity >= 0.9),
      {
        targetTokens: 130,
        ghostFraction: 0.5,
      },
    );

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.memberRows).toBe(items.length);
    expect(new Set(first.shards.flatMap((shard) => shard.members)).size).toBe(items.length);
    expect(first.shards.every((shard) => shard.memberTokens <= 130)).toBe(true);
  });

  it('allows one item to be ghost context in multiple shards without duplicating its home membership', () => {
    const items = [item('g', 10), item('a', 100), item('b', 100), item('c', 100)];
    const edges = [edge('g', 'a', 0.89), edge('g', 'b', 0.88), edge('g', 'c', 0.87)];
    const plan = buildAdmissionShardPlan(items, edges, [], { targetTokens: 110, ghostFraction: 0.5 });

    expect(plan.shards.filter((shard) => shard.members.includes('g'))).toHaveLength(1);
    expect(plan.shards.filter((shard) => shard.ghosts.includes('g')).length).toBeGreaterThanOrEqual(2);
    expect(plan.memberRows).toBe(4);
  });

  it('splits an oversized hard component by raising its threshold and preserves severed edges as ghost candidates', () => {
    const items = [item('a', 70), item('b', 70), item('c', 70)];
    const edges = [edge('a', 'b', 0.91), edge('b', 'c', 0.95)];
    const plan = buildAdmissionShardPlan(items, edges, edges, { targetTokens: 150, ghostFraction: 0.5 });

    expect(plan.splitOversizedComponents).toBe(1);
    expect(plan.shards.every((shard) => shard.memberTokens <= 150)).toBe(true);
    expect(plan.memberRows).toBe(3);
  });

  it('projects full-corpus bulk work only above the D-002 outside-machine threshold', () => {
    const items = [
      item('m1', 10, 'machine-emitter'),
      item('m2', 10, 'machine-emitter'),
      item('a1', 10, 'agent-filed'),
      item('a2', 10, 'agent-filed'),
    ];
    const pairs = [edge('m1', 'm2', 0.96), edge('a1', 'a2', 0.95)];
    const targeted = buildAdmissionShardPlan(items, pairs, pairs, { fullCorpusPairThreshold: 1 });
    const full = buildAdmissionShardPlan(items, pairs, pairs, { fullCorpusPairThreshold: 0 });

    expect(targeted.projection.recommendedBulkScope).toBe('machine-emitter-targeted');
    expect(full.projection.recommendedBulkScope).toBe('full-corpus');
    expect(full.projection.outsideMachineEmitterPairs).toBe(1);
  });

  it('refuses duplicate ids and items above the evidence-gated shard ceiling', () => {
    expect(() => buildAdmissionShardPlan([item('a', 1), item('a', 1)], [])).toThrow(/duplicate census item/);
    expect(() =>
      buildAdmissionShardPlan([item('huge', 101)], [], [], { targetTokens: 50, ceilingTokens: 100 }),
    ).toThrow(/ceiling/);
  });
});

describe('text-context scan bounds', () => {
  it('partitions missing-embedding anchors into deterministic bounded batches', () => {
    const ids = Array.from({ length: TEXT_CONTEXT_BATCH_SIZE * 2 + 1 }, (_, i) => `missing-${i}`);
    const batches = partitionTextContextIds(ids);

    expect(batches).toHaveLength(3);
    expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(TEXT_CONTEXT_BATCH_SIZE);
    expect(batches.flat()).toEqual(ids);
    expect(partitionTextContextIds([...ids].reverse()).flat()).toEqual([...ids].reverse());
  });
});

/**
 * REGRESSION GUARD — the census's declared statement_timeout must not open a
 * NESTED transaction on a handle the caller already has in one.
 *
 * WI-1194246 correctly wrapped the two long scans in `sql.begin` to carry
 * `SET LOCAL statement_timeout`. A postgres.js TRANSACTION handle has no
 * `.begin` (it exposes `savepoint`), so on the `withinTransaction: true` path
 * that wrapper threw `TypeError: sql.begin is not a function` and took the
 * whole scheduled bulk-dedup stage down with it — the census runs on the
 * stage's own `tx`.
 *
 * The escape was that NOTHING CHEAP looked: typecheck passed, and the census's
 * own integration test passed because it only exercises the bare-pool path.
 * The test that did catch it lives in a sibling *.integration.test.ts that a
 * plain `test:affected` on this file never selects. So the guard belongs HERE,
 * in the unit suite, where editing this file actually runs it.
 */
describe('withCensusStatementTimeout', () => {
  const opts = (withinTransaction: boolean): AdmissionCensusRunOptions =>
    ({ workspaceId: 'ws', harnessSlug: 'h', withinTransaction }) as AdmissionCensusRunOptions;

  it('declares the bound on the CALLER handle when already inside a transaction', async () => {
    const statements: string[] = [];
    // Shaped like a real postgres.js transaction handle: `unsafe` but NO
    // `begin`. Reaching for `.begin` here is the exact production crash.
    const tx = {
      unsafe: async (sql: string) => {
        statements.push(sql);
      },
    } as never;

    const result = await withCensusStatementTimeout(tx, opts(true), async (handle) => {
      expect(handle).toBe(tx);
      return 'ran-on-caller-handle';
    });

    expect(result).toBe('ran-on-caller-handle');
    expect(statements).toEqual([`SET LOCAL statement_timeout = ${ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}`]);
  });

  it('still opens its own transaction on a bare pool checkout', async () => {
    const statements: string[] = [];
    let begins = 0;
    const inner = {
      unsafe: async (sql: string) => {
        statements.push(sql);
      },
    };
    const pool = {
      begin: async (body: (tx: unknown) => Promise<unknown>) => {
        begins += 1;
        return body(inner);
      },
    } as never;

    const result = await withCensusStatementTimeout(pool, opts(false), async (handle) => {
      expect(handle).toBe(inner as never);
      return 'ran-in-own-tx';
    });

    expect(begins).toBe(1);
    expect(result).toBe('ran-in-own-tx');
    expect(statements).toEqual([`SET LOCAL statement_timeout = ${ADMISSION_CENSUS_STATEMENT_TIMEOUT_MS}`]);
  });

  it('control: an unconditional-begin implementation FAILS on the transaction handle', async () => {
    // Non-vacuity. The pre-fix shape, which always reached for `sql.begin` and
    // never consulted withinTransaction. Against the same no-begin handle the
    // transaction case supplies, it reproduces the production TypeError.
    const nestedBegin = async (sql: Record<string, unknown>): Promise<void> => {
      await (sql.begin as (body: (tx: unknown) => Promise<unknown>) => Promise<unknown>)(async () => undefined);
    };
    const transactionHandle: Record<string, unknown> = { unsafe: async () => undefined };
    await expect(nestedBegin(transactionHandle)).rejects.toThrow(/is not a function/);
  });
});
