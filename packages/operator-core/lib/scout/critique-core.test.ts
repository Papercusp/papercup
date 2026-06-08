/**
 * Tests for the pure critique core (P-005 / D-005). These pin the deterministic
 * invariants the LLM layer (critics.ts) sits on top of:
 *   - search-first novelty rejects the obvious / already-tried;
 *   - the moonshot bucket PRESERVES high-novelty/low-feasibility leaps (D-005);
 *   - the moonshot bucket is capped so leaps don't flood the pipeline.
 */
import { describe, it, expect } from 'vitest';
import {
  corpusNovelty,
  verdictFor,
  bucketByCritique,
  type CorpusEntry,
  type CritiqueScores,
} from './critique-core';

describe('corpusNovelty (search-first)', () => {
  it('an idea identical to a prior is minimally novel and surfaces the match', () => {
    const corpus: CorpusEntry[] = [
      { ref: 'plan:x', kind: 'plan', text: 'Token bucket rate limiter for the operator' },
    ];
    const r = corpusNovelty('Token bucket rate limiter for the operator', corpus);
    expect(r.novelty).toBe(0);
    expect(r.matches).toHaveLength(1);
    expect(r.matches[0].ref).toBe('plan:x');
    expect(r.matches[0].similarity).toBe(1);
  });

  it('a genuinely new idea against an unrelated corpus is maximally novel with no matches', () => {
    const corpus: CorpusEntry[] = [
      { ref: 'plan:x', kind: 'plan', text: 'token bucket limiter operator throughput' },
    ];
    const r = corpusNovelty('phi accrual failure detector bee heartbeats', corpus);
    expect(r.novelty).toBe(1);
    expect(r.matches).toEqual([]);
    expect(r.alreadyTried).toBe(false);
  });

  it('a near-match to an already-DECIDED (dropped) prior is "already tried" and penalised below an open prior', () => {
    const idea = 'operator backpressure token bucket scheduler latency';
    const priorText = 'operator backpressure token bucket';
    const open = corpusNovelty(idea, [{ ref: 'i:1', kind: 'idea', text: priorText, state: 'open' }]);
    const dropped = corpusNovelty(idea, [{ ref: 'i:1', kind: 'idea', text: priorText, state: 'dropped' }]);

    expect(open.alreadyTried).toBe(false);
    expect(dropped.alreadyTried).toBe(true);
    // Same base similarity, but the decided prior carries the extra penalty.
    expect(dropped.novelty).toBeLessThan(open.novelty);
    expect(open.novelty - dropped.novelty).toBeCloseTo(0.15, 5);
  });

  it('text with no comparable tokens is treated as novel with nothing surfaced', () => {
    const r = corpusNovelty('   !!!   ', [{ ref: 'plan:x', kind: 'plan', text: 'anything at all here' }]);
    expect(r.novelty).toBe(1);
    expect(r.matches).toEqual([]);
    expect(r.alreadyTried).toBe(false);
  });

  it('only matches at/above the floor are surfaced, strongest first', () => {
    const corpus: CorpusEntry[] = [
      { ref: 'a', kind: 'plan', text: 'operator backpressure token bucket scheduler' }, // strong
      { ref: 'b', kind: 'plan', text: 'completely unrelated immune system markets' }, // ~0
    ];
    const r = corpusNovelty('operator backpressure token bucket scheduler queue', corpus);
    expect(r.matches.map((m) => m.ref)).toEqual(['a']);
    expect(r.matches[0].similarity).toBeGreaterThanOrEqual(0.5);
  });
});

describe('verdictFor (two critics in tension)', () => {
  it('novel + feasible → keep', () => {
    expect(verdictFor({ id: 'a', novelty: 0.8, feasibility: 0.7 }).verdict).toBe('keep');
  });
  it('not novel (obvious / already tried) → reject regardless of feasibility', () => {
    expect(verdictFor({ id: 'b', novelty: 0.2, feasibility: 0.95 }).verdict).toBe('reject');
  });
  it('high novelty + low feasibility → moonshot (preserved leap)', () => {
    expect(verdictFor({ id: 'c', novelty: 0.8, feasibility: 0.3 }).verdict).toBe('moonshot');
  });
  it('mid novelty + low feasibility → reject (not a strong enough leap)', () => {
    expect(verdictFor({ id: 'd', novelty: 0.5, feasibility: 0.2 }).verdict).toBe('reject');
  });
});

describe('bucketByCritique (D-005 moonshot preservation + cap)', () => {
  it('partitions into keep / moonshot / reject and records verdicts', () => {
    const items: CritiqueScores[] = [
      { id: 'keep', novelty: 0.8, feasibility: 0.7 },
      { id: 'obvious', novelty: 0.2, feasibility: 0.9 },
      { id: 'leap', novelty: 0.8, feasibility: 0.3 },
    ];
    const b = bucketByCritique(items);
    expect(b.kept.map((i) => i.id)).toEqual(['keep']);
    expect(b.rejected.map((i) => i.id)).toEqual(['obvious']);
    // The D-005 invariant: a high-novelty/low-feasibility leap is PRESERVED, not rejected.
    expect(b.moonshot.map((i) => i.id)).toEqual(['leap']);
    expect(b.verdicts['leap'].verdict).toBe('moonshot');
  });

  it('caps the moonshot bucket — keeps the most-novel leaps, demotes the rest to rejected', () => {
    const items: CritiqueScores[] = [
      { id: 'm1', novelty: 0.9, feasibility: 0.2 },
      { id: 'm2', novelty: 0.8, feasibility: 0.2 },
      { id: 'm3', novelty: 0.7, feasibility: 0.2 },
    ];
    const b = bucketByCritique(items, { maxMoonshots: 2 });
    expect(b.moonshot.map((i) => i.id)).toEqual(['m1', 'm2']);
    expect(b.rejected.map((i) => i.id)).toEqual(['m3']);
    expect(b.verdicts['m3'].reason).toMatch(/bucket full/i);
  });
});
