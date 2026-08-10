/**
 * Controls for the reranker INTEGRATION benchmark's inferential core (WI-37653).
 *
 * ⚠ These are PERMANENT CONTROLS, not examples. Each encodes a way this
 * benchmark could produce a confident, well-formed, WRONG conclusion — which is
 * the shape the thing it replaces actually failed in. Do not "simplify" them
 * away: a statistic with no failing case is a statistic nobody has tested.
 *
 * The load-bearing one is `refuses to call D-093's sample a null`. It replays
 * the real historical failure — an underpowered 0-of-2 read as "reranking does
 * not help" — and fails if the instrument ever again lets that shape through.
 */
import { describe, expect, it } from 'vitest';

import {
  classifyOpportunity,
  instrumentValidity,
  pairedDifference,
  requiredPairs,
  rescueCeiling,
  reweightToPopulation,
} from './rerank-decision';

describe('classifyOpportunity', () => {
  it('separates the three strata on the cut boundary', () => {
    expect(classifyOpportunity(null, 6)).toBe('not-retrieved');
    expect(classifyOpportunity(0, 6)).toBe('admitted');
    expect(classifyOpportunity(5, 6)).toBe('admitted');
    expect(classifyOpportunity(6, 6)).toBe('order-blocked');
    expect(classifyOpportunity(23, 6)).toBe('order-blocked');
  });

  /**
   * PERMANENT CONTROL. "Absent from the pool" and "present but ranked last" are
   * the two states that look most alike in a log and need OPPOSITE fixes: the
   * first needs better retrieval (an anchor, a wider pool), the second is the
   * only one a reranker can address. Collapsing them is how a reranker gets
   * credited — or blamed — for retrieval's behaviour.
   */
  it('never reports a row absent from the pool as rescuable by reordering', () => {
    for (const cut of [1, 3, 6, 10, 100]) {
      expect(classifyOpportunity(null, cut)).not.toBe('order-blocked');
      expect(classifyOpportunity(-1, cut)).not.toBe('order-blocked');
    }
  });
});

describe('pairedDifference', () => {
  it('recovers a known mean difference and brackets it with the CI', () => {
    const control = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
    const treatment = control.map((c) => c + 0.1);
    const out = pairedDifference(control, treatment);
    expect(out).not.toBeNull();
    expect(out!.n).toBe(8);
    expect(out!.meanDiff).toBeCloseTo(0.1, 10);
    // A constant shift has zero variance in the DIFFERENCES, so the CI collapses.
    expect(out!.sdDiff).toBeCloseTo(0, 10);
    expect(out!.ci95[0]).toBeCloseTo(0.1, 8);
    expect(out!.ci95[1]).toBeCloseTo(0.1, 8);
  });

  /**
   * ⚠⚠ THE CONTROL THIS FILE EXISTS FOR — D-093's failure, replayed.
   *
   * Two order-blocked pairs, neither rescued: the exact evidence that closed
   * P-008 as "measured and not adopted". The instrument must NOT return an
   * informative null here. Any implementation that reports `nullIsInformative:
   * true` off this sample has reproduced the original defect.
   */
  it('refuses to call D-093\'s sample a null (n=2 is not a measurement)', () => {
    // Below the 3-pair floor entirely: not a measurement at all.
    expect(pairedDifference([0, 0], [0, 0])).toBeNull();
  });

  /**
   * The same defect one step up: enough pairs to compute, nowhere near enough
   * to conclude. A flat zero delta on a noisy, small sample must come back
   * `null` (= "could not tell"), never `true` (= "no effect").
   */
  it('reports an underpowered zero delta as UNDECIDABLE, not as absence of effect', () => {
    // Differences average ~0 but are wildly noisy — the small-n null.
    const control = [0.1, 0.9, 0.2, 0.8, 0.3];
    const treatment = [0.9, 0.1, 0.8, 0.2, 0.35];
    const out = pairedDifference(control, treatment);
    expect(out).not.toBeNull();
    expect(out!.nullIsInformative).toBeNull();
    // And the MDE must be large enough to explain WHY it is undecidable.
    expect(out!.mde80).toBeGreaterThan(0.2);
  });

  /**
   * The complement: a tight zero on a large sample IS an informative null.
   * Without this, an implementation that always returned `null` would pass the
   * case above and the instrument could never conclude anything.
   */
  it('reports a tight zero delta on a large sample as an INFORMATIVE null', () => {
    // 400 pairs, differences alternating +/-0.001 => mean 0, tiny SD.
    const control = Array.from({ length: 400 }, (_, i) => 0.5 + (i % 7) * 0.01);
    const treatment = control.map((c, i) => c + (i % 2 === 0 ? 0.001 : -0.001));
    const out = pairedDifference(control, treatment);
    expect(out).not.toBeNull();
    expect(out!.nullIsInformative).toBe(true);
    expect(out!.mde80).toBeLessThan(0.02);
  });

  it('reports a real effect as not-a-null', () => {
    const control = Array.from({ length: 200 }, (_, i) => (i % 10) / 20);
    const treatment = control.map((c) => c + 0.08);
    const out = pairedDifference(control, treatment);
    expect(out!.nullIsInformative).toBe(false);
    expect(out!.ci95[0]).toBeGreaterThan(0);
  });

  it('returns null on mismatched arms rather than silently truncating', () => {
    expect(pairedDifference([1, 2, 3], [1, 2])).toBeNull();
  });
});

describe('requiredPairs', () => {
  /**
   * Sizes a run BEFORE it is spent — the step whose absence made D-093's run
   * incapable of answering its own question. 2 nDCG points at a typical IR
   * spread needs samples in the hundreds, not single digits.
   */
  it('demands hundreds of pairs for a 2-point nDCG effect', () => {
    const n = requiredPairs(0.2, 0.02);
    expect(n).not.toBeNull();
    expect(n!).toBeGreaterThan(600);
    expect(n!).toBeLessThan(1200);
  });

  it('scales with the square of the inverse effect size', () => {
    const big = requiredPairs(0.2, 0.04)!;
    const small = requiredPairs(0.2, 0.02)!;
    expect(small / big).toBeCloseTo(4, 0);
  });

  it('returns null rather than 0 or Infinity for a degenerate ask', () => {
    expect(requiredPairs(0, 0.02)).toBeNull();
    expect(requiredPairs(0.2, 0)).toBeNull();
  });
});

describe('reweightToPopulation', () => {
  /**
   * PERMANENT CONTROL against the hazard oversampling introduces. A big effect
   * confined to a small stratum must NOT be reported at its within-stratum
   * size: 0.30 inside a stratum that is 20% of traffic is 0.06 in production.
   * An implementation that skipped reweighting would report 0.30 and overstate
   * the case for shipping by 5x.
   */
  it('scales a within-stratum effect down to its population share', () => {
    const out = reweightToPopulation([
      { name: 'order-blocked', share: 0.2, effect: 0.3, se: 0.01 },
      { name: 'admitted', share: 0.5, effect: 0, se: 0.01 },
      { name: 'not-retrieved', share: 0.3, effect: 0, se: 0.01 },
    ]);
    expect(out).not.toBeNull();
    expect(out!.effect).toBeCloseTo(0.06, 10);
  });

  /**
   * Rerank can DEMOTE an already-admitted row. A negative stratum must be able
   * to cancel the win — an instrument that only counted the winning stratum
   * would recommend shipping a net-harmful change.
   */
  it('lets a negative stratum offset a positive one', () => {
    const out = reweightToPopulation([
      { name: 'order-blocked', share: 0.2, effect: 0.3, se: 0.01 },
      { name: 'admitted', share: 0.8, effect: -0.1, se: 0.01 },
    ]);
    expect(out!.effect).toBeCloseTo(0.2 * 0.3 + 0.8 * -0.1, 10);
    expect(out!.effect).toBeLessThan(0);
  });

  it('names a stratum it could not measure instead of treating it as zero', () => {
    const out = reweightToPopulation([
      { name: 'order-blocked', share: 0.5, effect: 0.2, se: 0.02 },
      { name: 'not-retrieved', share: 0.5, effect: Number.NaN, se: 0.02 },
    ]);
    expect(out!.unmeasured).toEqual(['not-retrieved']);
  });
});

describe('instrumentValidity', () => {
  it('accepts a run whose stage engaged, moved order, and named its engine', () => {
    const v = instrumentValidity({ attempted: 500, total: 500, ordersMoved: 310, engine: 'local' });
    expect(v.ok).toBe(true);
    expect(v.reasons).toEqual([]);
  });

  /**
   * PERMANENT CONTROL. `rerankRows` returns the INPUT order when no engine
   * resolves — byte-identical to the control arm. So a dead engine yields a
   * flawless 0.000 delta that reads as "reranking does not help". The run must
   * be VOIDED, never published.
   */
  it('voids a dead-engine run instead of publishing its perfect zero', () => {
    const v = instrumentValidity({ attempted: 0, total: 500, ordersMoved: 0, engine: null });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/NEVER engaged/);
  });

  it('voids a run where the order never moved even though the stage engaged', () => {
    const v = instrumentValidity({ attempted: 500, total: 500, ordersMoved: 0, engine: 'local' });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/never moved/);
  });

  /** WI-37649: ZeroEntropy wins over local whenever a key exists, so an
   *  unattributed result may describe a reranker that is not the deployed one. */
  it('voids a run that did not record which engine scored it', () => {
    const v = instrumentValidity({ attempted: 500, total: 500, ordersMoved: 200, engine: null });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/engine was recorded/);
  });

  it('voids a half-engaged run rather than mixing two populations', () => {
    const v = instrumentValidity({ attempted: 250, total: 500, ordersMoved: 100, engine: 'local' });
    expect(v.ok).toBe(false);
    expect(v.engineFailures).toBe(250);
    expect(v.reasons.join(' ')).toMatch(/250\/500 RERANKABLE/);
  });

  it('reports no exclusions and no caveats for a fully-engaged run', () => {
    const v = instrumentValidity({ attempted: 500, total: 500, ordersMoved: 310, engine: 'local' });
    expect(v.excludedNonEngaged).toBe(0);
    expect(v.warnings).toEqual([]);
    expect(v.engagementRate).toBe(1);
  });

  /**
   * PERMANENT CONTROL — the 2026-08-10 pool=24 regression. A flapping rerank
   * sidecar left ONE query of 390 fail-soft, and an all-or-nothing guard binned
   * all 389 good pairs, so a 20-minute run produced no verdict at all. Voiding
   * for partial engagement is a power failure in its own right; the remedy is to
   * EXCLUDE the fail-soft pair, which is treatment == control by construction.
   */
  it('keeps a 389/390 run and excludes the one fail-soft pair instead of binning 389 good ones', () => {
    const v = instrumentValidity({ attempted: 389, total: 390, ordersMoved: 347, engine: 'local' });
    expect(v.ok).toBe(true);
    expect(v.excludedNonEngaged).toBe(1);
    expect(v.warnings.join(' ')).toMatch(/EXCLUDED/);
  });

  /** The exclusion must not silently become "the effect of enabling rerank":
   *  a sidecar that drops on the slowest queries makes the excluded set non-random. */
  it('states the narrowed estimand rather than implying the effect of enabling it', () => {
    const v = instrumentValidity({ attempted: 389, total: 390, ordersMoved: 347, engine: 'local' });
    expect(v.warnings.join(' ')).toMatch(/WHEN the reranker runs/);
  });

  /** D-093's protection survives the relaxation: a substantially dead engine
   *  still voids, no matter how many pairs it managed to produce. */
  it('still voids below the engagement floor even with a large sample', () => {
    const v = instrumentValidity({ attempted: 800, total: 1000, ordersMoved: 500, engine: 'local' });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/90% floor/);
  });

  /** Boundary control: exactly at the floor is ACCEPTED. Fails if the
   *  comparison is ever tightened to strict, which would void a legal run. */
  it('accepts a run sitting exactly on the engagement floor', () => {
    const v = instrumentValidity({ attempted: 900, total: 1000, ordersMoved: 500, engine: 'local' });
    expect(v.ok).toBe(true);
    expect(v.excludedNonEngaged).toBe(100);
  });

  /**
   * PERMANENT CONTROL — `rerankRows` reports `attempted:false` for reasons that
   * mean OPPOSITE things: 'nothing-to-reorder' (pool ≤ 1, the engine was never
   * asked) vs 'no-engine'/'threw:*' (the engine was asked and failed). Charging
   * benign skips against engine health would let a genuinely dark engine hide
   * behind a pile of un-rerankable queries — D-093's failure with extra steps.
   */
  it('does not charge structurally un-rerankable queries against engine health', () => {
    // 300 of 400 had a 1-row pool; the engine handled every query it was asked.
    const v = instrumentValidity({ attempted: 100, total: 400, ordersMoved: 60, engine: 'local', benignSkips: 300 });
    expect(v.ok).toBe(true);
    expect(v.engagementRate).toBe(1);
    expect(v.benignSkips).toBe(300);
    expect(v.engineFailures).toBe(0);
    expect(v.warnings.join(' ')).toMatch(/structurally un-rerankable/);
  });

  /** The other direction: benign skips must not LAUNDER real engine failures. */
  it('still voids when the engine fails most of the queries it was actually asked', () => {
    // 100 benign skips; of the 300 rerankable the engine handled only 150.
    const v = instrumentValidity({ attempted: 150, total: 400, ordersMoved: 90, engine: 'local', benignSkips: 100 });
    expect(v.ok).toBe(false);
    expect(v.engineFailures).toBe(150);
    expect(v.reasons.join(' ')).toMatch(/RERANKABLE/);
  });

  /** A run of nothing but 1-row pools never exercised the reranker at all. */
  it('voids a run in which every query was structurally un-rerankable', () => {
    const v = instrumentValidity({ attempted: 0, total: 50, ordersMoved: 0, engine: null, benignSkips: 50 });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/never exercised/);
  });

  /** benignSkips can never exceed the actual non-engaged count, however called. */
  it('clamps a benignSkips claim larger than the non-engaged population', () => {
    const v = instrumentValidity({ attempted: 390, total: 400, ordersMoved: 300, engine: 'local', benignSkips: 999 });
    expect(v.benignSkips).toBe(10);
    expect(v.engineFailures).toBe(0);
  });
});

/**
 * The JUSTIFICATION for excluding fail-soft pairs, as an executable control
 * rather than a comment. A fail-soft pair contributes an exact 0 difference, so
 * mixing it in shrinks a real effect toward zero — manufacturing the very
 * "reranking does not help" reading this instrument exists to prevent.
 */
describe('rescueCeiling', () => {
  /**
   * The load-bearing case: `order-blocked` came back EMPTY. The naive reading is
   * "underpowered". But absence bounds the share, and the share bounds the
   * population effect — so an empty band yields a CONCLUSION, not a shortfall.
   */
  it('bounds the population contribution from a stratum never observed', () => {
    const c = rescueCeiling({ observed: 0, n: 390 });
    // Wilson at 0/390 lands near the rule of three (3/390 ≈ 0.77%).
    expect(c!.shareUpperBound).toBeGreaterThan(0.005);
    expect(c!.shareUpperBound).toBeLessThan(0.015);
    // nDCG ∈ [0,1] ⇒ the ceiling equals the share bound.
    expect(c!.populationCeiling).toBeCloseTo(c!.shareUpperBound, 12);
  });

  /** Never 0: a zero upper bound would assert certainty a finite sample cannot buy. */
  it('never returns a zero ceiling for a finite sample', () => {
    for (const n of [10, 100, 5000]) {
      const c = rescueCeiling({ observed: 0, n });
      expect(c!.shareUpperBound).toBeGreaterThan(0);
    }
  });

  /** More evidence of absence ⇒ a tighter bound. This is what makes it a conclusion. */
  it('tightens the bound as the sample grows', () => {
    const small = rescueCeiling({ observed: 0, n: 100 })!;
    const large = rescueCeiling({ observed: 0, n: 10_000 })!;
    expect(large.shareUpperBound).toBeLessThan(small.shareUpperBound);
  });

  it('exceeds the point estimate when the stratum IS observed', () => {
    const c = rescueCeiling({ observed: 20, n: 400 })!; // p = 5%
    expect(c.shareUpperBound).toBeGreaterThan(0.05);
    expect(c.shareUpperBound).toBeLessThan(0.12);
  });

  it('scales the ceiling by the metric range', () => {
    const unit = rescueCeiling({ observed: 0, n: 390 })!;
    const half = rescueCeiling({ observed: 0, n: 390, maxPerPairGain: 0.5 })!;
    expect(half.populationCeiling).toBeCloseTo(unit.populationCeiling / 2, 12);
  });

  it('refuses a degenerate ask instead of returning a misleading zero', () => {
    expect(rescueCeiling({ observed: 0, n: 0 })).toBeNull();
    expect(rescueCeiling({ observed: 5, n: 4 })).toBeNull();
    expect(rescueCeiling({ observed: -1, n: 10 })).toBeNull();
  });
});

describe('fail-soft pairs dilute a real effect (why the CLI analyses engaged pairs only)', () => {
  it('shrinks a real gain toward zero when un-reranked pairs are mixed in', () => {
    const control = [0.2, 0.2, 0.2, 0.2];
    const treatment = [0.6, 0.6, 0.6, 0.6];
    const engagedOnly = pairedDifference(control, treatment);
    // Four fail-soft pairs: the stage never ran, so treatment === control.
    const mixed = pairedDifference([...control, 0.5, 0.5, 0.5, 0.5], [...treatment, 0.5, 0.5, 0.5, 0.5]);

    expect(engagedOnly?.meanDiff).toBeCloseTo(0.4, 6);
    expect(mixed?.meanDiff).toBeCloseTo(0.2, 6);
    expect(mixed!.meanDiff).toBeLessThan(engagedOnly!.meanDiff);
  });
});
