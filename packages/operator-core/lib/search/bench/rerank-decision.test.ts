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

  it('flags a partially-engaged run, which silently mixes two populations', () => {
    const v = instrumentValidity({ attempted: 250, total: 500, ordersMoved: 100, engine: 'local' });
    expect(v.ok).toBe(false);
    expect(v.reasons.join(' ')).toMatch(/only 250\/500/);
  });
});
