/**
 * Recurrence guards for the two conclusion bugs the P-008 rerank-reach
 * instrument shipped with (see `corpus-rerank-reach.ts` header). Both produced
 * a confident, well-formed, WRONG verdict rather than an obvious failure, and
 * both were live in a run whose numbers were reported to a peer.
 *
 * Each block below contains a case that PASSES under the corrected rule and
 * FAILS under the earlier, narrower one — that pairing is the point. A guard
 * that only asserts current behaviour cannot tell you it is still guarding
 * anything.
 */

import { describe, expect, it } from 'vitest';

import { sensitivityVerdict, tierShape } from './corpus-rerank-reach';

const PAGE = 6;

describe('tierShape — confinement requires a lower tier to be confined OUT of', () => {
  it('does NOT report confinement for a single-tier pool, however large', () => {
    // The BM25-only regime: no embedder ⇒ every hit is 1-ranker. 10 survivors,
    // page of 6 — the old rule (topTierSize >= pageSize) called this CONFINED
    // and the arm reported 47.4% confinement. There is no lower tier here, so
    // the reranker is locked out of nothing.
    const shape = tierShape(Array(10).fill(1), PAGE);
    expect(shape.singleTier).toBe(true);
    expect(shape.topTierSize).toBe(10);
    expect(shape.confined).toBe(false);
  });

  it('DOES report confinement when a lower tier exists and the top tier fills the page', () => {
    // 7 two-ranker hits and 5 one-ranker hits: the page is drawn entirely from
    // the top tier, so no 1-ranker hit is reachable at any rerank score.
    const shape = tierShape([...Array(7).fill(2), ...Array(5).fill(1)], PAGE);
    expect(shape.singleTier).toBe(false);
    expect(shape.topTierSize).toBe(7);
    expect(shape.confined).toBe(true);
  });

  it('does not report confinement when the top tier leaves room in the page', () => {
    // 3 two-ranker + 6 one-ranker: the top tier cannot fill 6 slots, so lower
    // tier hits reach the page and a reranker can influence which.
    const shape = tierShape([...Array(3).fill(2), ...Array(6).fill(1)], PAGE);
    expect(shape.singleTier).toBe(false);
    expect(shape.confined).toBe(false);
  });

  it('buckets by agreement and orders the top tier by ranker count, not by size', () => {
    // The top tier is the HIGHEST agreement, even when a lower tier is bigger —
    // the sort key is agreement, so a large 1-ranker bucket is still beneath a
    // small 2-ranker one.
    const shape = tierShape([2, 1, 1, 1, 1], PAGE);
    expect(shape.tiers).toEqual({ 2: 1, 1: 4 });
    expect(shape.topTierSize).toBe(1);
  });

  it('treats a missing/zero ranker count as one ranker rather than its own tier', () => {
    // A hit with no `rankers` array must not manufacture a phantom tier-0 that
    // would flip `singleTier` and, with it, the verdict.
    const shape = tierShape([1, 0, 1], PAGE);
    expect(shape.tiers).toEqual({ 1: 3 });
    expect(shape.singleTier).toBe(true);
  });
});

describe('sensitivityVerdict — a rate over a population that cannot show the effect is not evidence', () => {
  it('returns not-a-test when NO query could exhibit the override, even at an extreme rate', () => {
    // The exact bug: the BM25-only arm measured 75.4% top-1 change and the old
    // rule printed "HIGH — this FALSIFIES the reach-ceiling concern". That arm
    // is 100% single-tier by construction; its high sensitivity is the CONTROL
    // working, and it says nothing whatsoever about the override.
    expect(sensitivityVerdict(0, 0.754)).toBe('not-a-test');
    expect(sensitivityVerdict(0, 1)).toBe('not-a-test');
    expect(sensitivityVerdict(0, 0)).toBe('not-a-test');
  });

  it('reports high once the effect is reachable and the rate clears the threshold', () => {
    // The measured hybrid arm: 35 multi-tier queries, 42.9% top-1 change.
    expect(sensitivityVerdict(35, 0.429)).toBe('high');
  });

  it('reports low when the effect is reachable but the rate does not clear it', () => {
    // The n=15 probe's reading — the same statistic that inverted at n=120.
    expect(sensitivityVerdict(6, 0.208)).toBe('low');
  });

  it('is decided by the multi-tier rate, never a pooled rate', () => {
    // Pooled sensitivity is dominated by single-tier queries, where a reorder
    // trivially reaches the page. Passing that pooled figure here would read
    // HIGH while the restricted rate is LOW — so the caller must restrict, and
    // this pins the contract that the rate argument is already restricted.
    expect(sensitivityVerdict(6, 0.208)).toBe('low');
    expect(sensitivityVerdict(6, 0.443)).toBe('high');
  });

  it('treats the threshold as exclusive so a rate exactly at it is not called low', () => {
    expect(sensitivityVerdict(10, 0.25)).toBe('high');
    expect(sensitivityVerdict(10, 0.2499)).toBe('low');
  });
});
