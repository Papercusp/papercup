import { describe, expect, it } from 'vitest';
import {
  buildAdmissionShardPlan,
  type AdmissionCensusEdge,
  type AdmissionCensusItem,
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
