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
  effectiveMoonshotFloor,
  DEFAULT_BUCKET_OPTIONS,
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

  it('empty input → all-empty buckets + empty verdicts', () => {
    const b = bucketByCritique([]);
    expect(b).toEqual({ kept: [], moonshot: [], rejected: [], verdicts: {} });
  });

  it('threads custom options into verdictFor — a raised noveltyFloor rejects an otherwise-kept idea', () => {
    const items: CritiqueScores[] = [{ id: 'x', novelty: 0.5, feasibility: 0.9 }];
    expect(bucketByCritique(items).kept.map((i) => i.id)).toEqual(['x']); // default floor 0.34 → keep
    const b = bucketByCritique(items, { noveltyFloor: 0.6 });
    expect(b.kept).toEqual([]);
    expect(b.rejected.map((i) => i.id)).toEqual(['x']);
  });
});

// ── WI-39492: the batch-RELATIVE moonshot floor ──────────────────────────────
// The fixed 0.66 floor drifted out of reach as the corpus densified — measured
// live: 0 moonshots across 96 scored ideas / 12 cycles, per-cycle max novelty
// 0.48–0.68, every low-feasibility leap rejected as "not strong enough". These
// pin the fix AND its guardrails (the floor must not manufacture leaps either).
describe('effectiveMoonshotFloor (WI-39492)', () => {
  /** A real cycle's novelty distribution, from the live scout_cycle_stage_artifacts. */
  const COMPRESSED_BATCH = [0.2, 0.28, 0.31, 0.35, 0.42, 0.48, 0.58, 0.65];

  it('tracks the batch quantile when the corpus has compressed novelty below the absolute floor', () => {
    // 8 ideas, q=0.75 → the 2nd-highest (0.58) — reachable, unlike the fixed 0.66.
    expect(effectiveMoonshotFloor(COMPRESSED_BATCH)).toBe(0.58);
  });

  it('never demands MORE than the absolute floor — an all-novel batch stays at 0.66', () => {
    // The empty-corpus case: search-first novelty is 1 for everything.
    expect(effectiveMoonshotFloor([1, 1, 1, 1, 1, 1])).toBe(
      DEFAULT_BUCKET_OPTIONS.moonshotNoveltyFloor,
    );
  });

  it('never drops below moonshotFloorMin — a uniformly unoriginal batch gets no free leaps', () => {
    expect(effectiveMoonshotFloor([0.1, 0.15, 0.2, 0.22, 0.25])).toBe(
      DEFAULT_BUCKET_OPTIONS.moonshotFloorMin,
    );
  });

  it('falls back to the absolute floor for a batch too small to take a quantile of', () => {
    expect(effectiveMoonshotFloor([0.5, 0.55, 0.6])).toBe(
      DEFAULT_BUCKET_OPTIONS.moonshotNoveltyFloor,
    );
  });

  it('honors custom knobs (quantile + min)', () => {
    // A lower quantile tracks further down the batch — floorMin dropped out of the
    // way so this observes the QUANTILE, not the clamp.
    expect(
      effectiveMoonshotFloor(COMPRESSED_BATCH, { moonshotFloorQuantile: 0.5, moonshotFloorMin: 0.1 }),
    ).toBe(0.42);
    // …and with the default floorMin (0.45) that same quantile is clamped back up.
    expect(effectiveMoonshotFloor(COMPRESSED_BATCH, { moonshotFloorQuantile: 0.5 })).toBe(
      DEFAULT_BUCKET_OPTIONS.moonshotFloorMin,
    );
    expect(effectiveMoonshotFloor(COMPRESSED_BATCH, { moonshotFloorMin: 0.62 })).toBe(0.62);
  });
});

describe('bucketByCritique — relative floor restores D-005 leap preservation (WI-39492)', () => {
  /** The measured regression shape: a full 8-idea cycle whose two most-novel
   *  ideas are low-feasibility leaps, none of them clearing the fixed 0.66. */
  const CYCLE: CritiqueScores[] = [
    { id: 'leap-top', novelty: 0.65, feasibility: 0.3 },
    { id: 'leap-2nd', novelty: 0.58, feasibility: 0.25 },
    { id: 'buildable', novelty: 0.48, feasibility: 0.8 },
    { id: 'buildable-2', novelty: 0.42, feasibility: 0.7 },
    { id: 'midling', novelty: 0.35, feasibility: 0.4 },
    { id: 'obvious-a', novelty: 0.31, feasibility: 0.9 },
    { id: 'obvious-b', novelty: 0.28, feasibility: 0.6 },
    { id: 'obvious-c', novelty: 0.2, feasibility: 0.5 },
  ];

  it('preserves the cycle’s genuine leaps instead of rejecting all of them', () => {
    const b = bucketByCritique(CYCLE);
    expect(b.moonshot.map((i) => i.id)).toEqual(['leap-top', 'leap-2nd']);
    expect(b.verdicts['leap-top'].verdict).toBe('moonshot');
  });

  it('CONTROL: the same batch under the OLD absolute floor preserves NOTHING — the bug', () => {
    // Pinning floorMin at the absolute floor degenerates the relative floor back
    // to the pre-fix behaviour, so this test FAILS if the mechanism stops mattering.
    const b = bucketByCritique(CYCLE, { moonshotFloorMin: 0.66 });
    expect(b.moonshot).toEqual([]);
    expect(b.rejected.map((i) => i.id)).toContain('leap-top');
  });

  it('does NOT manufacture leaps: a feasible top-novelty idea is still a keep', () => {
    const feasibleTop = CYCLE.map((i) =>
      i.id === 'leap-top' ? { ...i, feasibility: 0.9 } : i,
    );
    const b = bucketByCritique(feasibleTop);
    expect(b.kept.map((i) => i.id)).toContain('leap-top');
    expect(b.moonshot.map((i) => i.id)).not.toContain('leap-top');
  });

  it('does NOT manufacture leaps: an unoriginal batch yields no moonshots (floorMin holds)', () => {
    const dull: CritiqueScores[] = [
      { id: 'a', novelty: 0.36, feasibility: 0.2 },
      { id: 'b', novelty: 0.38, feasibility: 0.2 },
      { id: 'c', novelty: 0.4, feasibility: 0.2 },
      { id: 'd', novelty: 0.42, feasibility: 0.2 },
      { id: 'e', novelty: 0.44, feasibility: 0.2 },
    ];
    // Every novelty is above the reject floor (0.34) but below moonshotFloorMin (0.45).
    expect(bucketByCritique(dull).moonshot).toEqual([]);
  });

  it('still caps the moonshot bucket under the relative floor (D-005 cap survives)', () => {
    const manyLeaps: CritiqueScores[] = [
      { id: 'm1', novelty: 0.65, feasibility: 0.2 },
      { id: 'm2', novelty: 0.63, feasibility: 0.2 },
      { id: 'm3', novelty: 0.61, feasibility: 0.2 },
      { id: 'm4', novelty: 0.6, feasibility: 0.2 },
      { id: 'm5', novelty: 0.58, feasibility: 0.2 },
    ];
    const b = bucketByCritique(manyLeaps);
    expect(b.moonshot).toHaveLength(DEFAULT_BUCKET_OPTIONS.maxMoonshots);
    expect(b.moonshot.map((i) => i.id)).toEqual(['m1', 'm2']);
  });

  it('names the EFFECTIVE floor in the verdict reason (the audit trail)', () => {
    const b = bucketByCritique(CYCLE);
    // 0.58, not the absolute 0.66 — a reader must see what "a leap" meant here.
    expect(b.verdicts['leap-top'].reason).toContain('0.58');
    expect(b.verdicts['midling'].reason).toContain('0.58');
  });
});

// ── Threshold boundaries + custom options (depth pass, su-7f3e0376) ──────────
describe('verdictFor — exact threshold boundaries (the <,>= edges)', () => {
  it('novelty exactly AT the noveltyFloor (0.34) is NOT rejected; just below IS', () => {
    expect(verdictFor({ id: 'a', novelty: 0.34, feasibility: 0.5 }).verdict).toBe('keep'); // 0.34 < 0.34 is false
    expect(verdictFor({ id: 'b', novelty: 0.33, feasibility: 0.95 }).verdict).toBe('reject');
  });

  it('feasibility exactly AT the feasibilityFloor (0.5) → keep (>=)', () => {
    expect(verdictFor({ id: 'c', novelty: 0.8, feasibility: 0.5 }).verdict).toBe('keep');
    expect(verdictFor({ id: 'd', novelty: 0.8, feasibility: 0.49 }).verdict).toBe('moonshot'); // novel leap, low feas
  });

  it('novelty exactly AT the moonshotNoveltyFloor (0.66) + low feasibility → moonshot; just below → reject', () => {
    expect(verdictFor({ id: 'e', novelty: 0.66, feasibility: 0.4 }).verdict).toBe('moonshot');
    expect(verdictFor({ id: 'f', novelty: 0.65, feasibility: 0.4 }).verdict).toBe('reject'); // mid novelty, not a strong leap
  });

  it('honors custom floors (a raised noveltyFloor flips keep → reject)', () => {
    expect(verdictFor({ id: 'g', novelty: 0.5, feasibility: 0.9 }, { noveltyFloor: 0.6 }).verdict).toBe('reject');
    expect(verdictFor({ id: 'h', novelty: 0.5, feasibility: 0.9 }).verdict).toBe('keep');
  });
});

describe('corpusNovelty — clamp, cap, and custom decided-states', () => {
  const idea = 'operator backpressure token bucket scheduler latency';

  it('clamps novelty to 0 — an identical ALREADY-DECIDED prior cannot go negative past the penalty', () => {
    const r = corpusNovelty(idea, [{ ref: 'i:1', kind: 'idea', text: idea, state: 'dropped' }]);
    expect(r.alreadyTried).toBe(true);
    expect(r.novelty).toBe(0); // 1 - 1.0 - 0.15 = -0.15 → clamped to 0, never negative
  });

  it('caps the surfaced matches at maxMatches (most-similar first)', () => {
    const corpus: CorpusEntry[] = Array.from({ length: 5 }, (_, i) => ({
      ref: `dup:${i}`,
      kind: 'plan' as const,
      text: idea, // identical → similarity 1.0, all above the floor
    }));
    const r = corpusNovelty(idea, corpus, { maxMatches: 2 });
    expect(r.matches).toHaveLength(2);
  });

  it('a non-default state counts as already-tried only when included in custom decidedStates', () => {
    const prior: CorpusEntry = { ref: 'i:1', kind: 'idea', text: idea, state: 'archived' };
    expect(corpusNovelty(idea, [prior]).alreadyTried).toBe(false); // 'archived' not in the default decided set
    expect(corpusNovelty(idea, [prior], { decidedStates: ['archived'] }).alreadyTried).toBe(true);
  });
});

/**
 * EI-19899846879024832 — the semantic leg must not reject every in-domain idea.
 *
 * Embedding cosine does not share lexical similarity's origin: measured on the live
 * corpus, two UNRELATED same-domain entries sit around 0.62 and reach 0.77, while
 * genuine Scout ideas score 0.73-0.82. Blending that raw via `max(lexical, cosine)`
 * put EVERY in-domain idea above the reject line — 520 ideas generated, 0 routed,
 * for six days. These pin the calibration that fixes it.
 */
describe('corpusNovelty — semantic leg calibration (EI-19899846879024832)', () => {
  const NOVELTY_FLOOR = 0.34; // bucketByCritique rejects below this

  // A corpus of same-domain neighbours sharing no vocabulary with the probe idea,
  // so the LEXICAL leg is ~0 and the semantic leg alone decides the verdict.
  const corpus: CorpusEntry[] = [
    { ref: 'far:0', kind: 'plan', text: 'Persimmon vinegar fermentation in buried amphorae' },
    ...Array.from({ length: 59 }, (_, i) => ({
      ref: `nb:${i}`,
      kind: 'plan' as const,
      text: `Distinct neighbouring concern number ${i} about unrelated subsystem wiring`,
    })),
  ];
  const idea = 'Escalation storms remount known-benign conditions hundreds of times per day';

  /** Realistic cosines: one far entry, a same-domain bulk ~0.62, one nearest at 0.78. */
  const sims = new Map<string, number>([
    ['far:0', 0.0],
    ...corpus.slice(1).map((e, i) => [e.ref, i === 58 ? 0.78 : 0.6 + (i % 7) * 0.01] as const),
  ]);

  it('the lexical leg alone considers this idea novel (guards the setup)', () => {
    // If this ever fails the fixture has drifted and the tests below prove nothing.
    expect(corpusNovelty(idea, corpus).novelty).toBeGreaterThanOrEqual(NOVELTY_FLOOR);
  });

  it('does NOT reject a novel idea merely for being in the corpus domain', () => {
    const n = corpusNovelty(idea, corpus, { semanticSimByRef: sims });
    expect(n.novelty).toBeGreaterThanOrEqual(NOVELTY_FLOOR);
  });

  it('UNCALIBRATED, the same inputs reject — this is what the fix changes', () => {
    // Falsifiability control. `semanticBaselineQuantile: 0` picks the minimum cosine
    // (0.0, the far entry) as the baseline, which makes the calibration an identity
    // and reproduces the old raw `max(lexical, cosine)` blend exactly. Same corpus,
    // same cosines, opposite verdict — so the passing test above is attributable to
    // the calibration and not to a fixture that would pass either way.
    const raw = corpusNovelty(idea, corpus, { semanticSimByRef: sims, semanticBaselineQuantile: 0 });
    expect(raw.novelty).toBeLessThan(NOVELTY_FLOOR);
  });

  it('still flags a near-verbatim restatement as unnovel', () => {
    // Calibration must not blind the leg to the case it exists for: a re-worded
    // re-encounter with near-identical meaning still has to collide.
    const dupeSims = new Map(sims);
    dupeSims.set('nb:0', 0.98);
    const n = corpusNovelty(idea, corpus, { semanticSimByRef: dupeSims });
    expect(n.novelty).toBeLessThan(NOVELTY_FLOOR);
  });

  it('leaves scoring untouched when no cosine map is supplied', () => {
    const withMap = corpusNovelty(idea, corpus, { semanticSimByRef: new Map() });
    expect(withMap.novelty).toBe(corpusNovelty(idea, corpus).novelty);
  });
});
