/**
 * Controls for the inferential core of P-019 / D-088 R5.
 *
 * The CLI these back reports whether a SHIPPED predictor has any validity. Its
 * numbers are unfalsifiable against live data — a wrong ρ still looks like a ρ —
 * so the arithmetic is pinned here against series whose answers are known
 * independently.
 *
 * ⚠ Several cases are PERMANENT CONTROLS rather than examples: they encode the
 * defects that would produce a plausible-but-wrong ruling (order-dependent ties,
 * a null that is not centred, a rarity inversion, an unattainable p=0). Do not
 * "simplify" them away — a statistic with no failing case is a statistic nobody
 * has tested.
 */
import { describe, expect, it } from 'vitest';

import {
  averageRanks,
  mean,
  permutationNull,
  permute,
  postRetrievalClarity,
  spearman,
  teaserOf,
} from './corpus-clarity-validity';

/** Whitespace tokenizer — the real CLI passes `corpusTerms`; these controls only
 *  need a deterministic split, and injecting it keeps this file corpus-free. */
const words = (t: string): string[] => t.split(/\s+/).filter(Boolean);

describe('mean', () => {
  it('returns null for an empty series rather than 0', () => {
    // 0 would read as a measurement. There is no measurement.
    expect(mean([])).toBeNull();
    expect(mean([2, 4])).toBe(3);
  });
});

describe('averageRanks', () => {
  it('shares the average rank across a tie group', () => {
    // 10 is rank 1; the three 20s occupy ranks 2,3,4 and share 3.
    expect(averageRanks([10, 20, 20, 20, 30])).toEqual([1, 3, 3, 3, 5]);
  });

  it('is INDEPENDENT OF INPUT ORDER on a tie-saturated series', () => {
    // ⚠ PERMANENT CONTROL. Admitted-line counts live in 0..6, so this study's
    // outcome series are ~7 distinct values over thousands of rows. A ranker
    // that broke ties by position would make ρ depend on row order — stable
    // across re-runs (the sample is deterministic) and therefore invisible.
    const xs = [3, 1, 3, 0, 1, 3, 0];
    const ranks = averageRanks(xs);
    const byValue = new Map<number, number>();
    xs.forEach((v, i) => {
      const seen = byValue.get(v);
      if (seen === undefined) byValue.set(v, ranks[i]!);
      else expect(ranks[i]).toBe(seen);
    });
    expect(byValue.size).toBe(3);
  });
});

describe('spearman', () => {
  it('is +1 on a strictly monotone-increasing pairing', () => {
    expect(spearman([1, 2, 3, 4, 5], [10, 20, 30, 40, 50])).toBeCloseTo(1, 10);
  });

  it('is -1 on a strictly monotone-decreasing pairing', () => {
    expect(spearman([1, 2, 3, 4, 5], [50, 40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });

  it('is monotone-invariant — it ranks, it does not regress', () => {
    // Squaring a positive series preserves order but destroys linearity, so a
    // Pearson-on-values implementation would move here and Spearman must not.
    const x = [1, 2, 3, 4, 5, 6];
    const y = [2, 3, 5, 8, 13, 21];
    expect(spearman(x, y)).toBeCloseTo(spearman(x, y.map((v) => v ** 3))!, 10);
  });

  it('matches a hand-computed ρ with no ties', () => {
    // d = [0,0,-1,1,0] → Σd² = 2 → ρ = 1 − 6·2/(5·24) = 0.9
    expect(spearman([1, 2, 3, 4, 5], [1, 2, 4, 3, 5])).toBeCloseTo(0.9, 10);
  });

  it('returns null — not 0 — when a series is CONSTANT', () => {
    // ⚠ PERMANENT CONTROL. ρ is undefined against a constant. Reporting 0 would
    // read as "measured no association" when nothing was measurable at all.
    expect(spearman([1, 2, 3, 4], [7, 7, 7, 7])).toBeNull();
  });

  it('refuses mismatched lengths and samples too small to rank', () => {
    expect(spearman([1, 2, 3], [1, 2])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });
});

describe('permute', () => {
  it('is a permutation — same multiset, deterministic per seed', () => {
    const xs = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = permute(xs, 7);
    expect([...a].sort()).toEqual([...xs].sort());
    expect(permute(xs, 7)).toEqual(a);
  });

  it('actually REORDERS, and different seeds give different orders', () => {
    // A permute that quietly returned its input would make every control pass
    // by reporting the OBSERVED ρ as the null — the failure mode that would
    // silently validate any finding at all.
    const xs = Array.from({ length: 40 }, (_, i) => i);
    expect(permute(xs, 1)).not.toEqual(xs);
    expect(permute(xs, 1)).not.toEqual(permute(xs, 2));
  });
});

describe('permutationNull', () => {
  const x = Array.from({ length: 60 }, (_, i) => i);

  it('centres on ~0 for INDEPENDENT series and brackets 0 in its band', () => {
    const y = permute(x, 991);
    const nul = permutationNull(x, y, spearman(x, y)!, 400)!;
    expect(Math.abs(nul.mean)).toBeLessThan(0.06);
    expect(nul.lo).toBeLessThan(0);
    expect(nul.hi).toBeGreaterThan(0);
  });

  it('assigns a small p to a strong real association', () => {
    const nul = permutationNull(x, x, spearman(x, x)!, 400)!;
    expect(nul.p).toBeLessThan(0.01);
  });

  it('assigns a LARGE p to a shuffled pairing — the falsifying case', () => {
    // ⚠ PERMANENT CONTROL. Without this, a p that is always small would look
    // like a strong finding everywhere and nothing would contradict it.
    const y = permute(x, 4242);
    const nul = permutationNull(x, y, spearman(x, y)!, 400)!;
    expect(nul.p).toBeGreaterThan(0.05);
  });

  it('can never report p = 0', () => {
    // The observed pairing is itself one of the arrangements the null contains,
    // so p is bounded below by 1/(draws+1). A printed 0 would overstate
    // certainty without bound.
    const nul = permutationNull(x, x, spearman(x, x)!, 50)!;
    expect(nul.p).toBeGreaterThan(0);
    expect(nul.p).toBeCloseTo(1 / (nul.draws + 1), 10);
  });

  it('refuses a sample too small to permute', () => {
    expect(permutationNull([1, 2], [1, 2], 1, 10)).toBeNull();
  });
});

describe('postRetrievalClarity', () => {
  const ndocs = 1000;
  const df = (t: string): number => ({ the: 900, and: 800, kettle: 5, holepunch: 3 })[t] ?? 0;

  it('scores a RARE retrieved set as more concentrated than a common one', () => {
    const rare = postRetrievalClarity(['kettle holepunch kettle'], words, df, ndocs, 2);
    const common = postRetrievalClarity(['the and the'], words, df, ndocs, 2);
    expect(rare.bits).not.toBeNull();
    expect(common.bits).not.toBeNull();
    expect(rare.bits!).toBeGreaterThan(common.bits!);
  });

  it('EXCLUDES unattested terms instead of scoring them as maximally clear', () => {
    // ⚠ PERMANENT CONTROL — this models the D-064 inversion directly. A hex
    // digest has df 0, so P(w|C)=0 and its KL contribution is infinite; scoring
    // it would rank a set of pure nonces as the MOST concentrated retrieval in
    // the corpus. The bits must equal the attested-only score exactly, and the
    // exclusion must show up in attestedRatio rather than vanishing.
    const clean = postRetrievalClarity(['kettle kettle'], words, df, ndocs, 2);
    const noisy = postRetrievalClarity(['kettle a3f9e1 kettle 77bc02'], words, df, ndocs, 2);
    expect(noisy.bits).toBeCloseTo(clean.bits!, 10);
    expect(Number.isFinite(noisy.bits!)).toBe(true);
    expect(noisy.attestedRatio).toBeCloseTo(0.5, 10);
    expect(clean.attestedRatio).toBeCloseTo(1, 10);
  });

  it('honours the attestation floor, so a hapax term never counts', () => {
    // minDf 4 puts `holepunch` (df 3) below the floor.
    expect(postRetrievalClarity(['holepunch'], words, df, ndocs, 4).bits).toBeNull();
    expect(postRetrievalClarity(['holepunch'], words, df, ndocs, 2).bits).not.toBeNull();
  });

  it('returns null bits — never 0 — when nothing attested was retrieved', () => {
    // 0 bits means "exactly the collection distribution", a real and very
    // different reading from "there was nothing to score".
    expect(postRetrievalClarity(['a3f9e1'], words, df, ndocs, 2).bits).toBeNull();
    expect(postRetrievalClarity([], words, df, ndocs, 2)).toEqual({ bits: null, attestedRatio: null });
  });

  it('is unmeasurable, not zero, against an empty collection', () => {
    expect(postRetrievalClarity(['kettle'], words, df, 0, 2).bits).toBeNull();
  });

  it('CALIBRATION: a set matching the collection distribution scores ~0 bits', () => {
    // ⚠ Pairs with the rarity control above. Without a calibration case, the
    // controls also pass when the statistic is broken in a way that merely
    // preserves ordering — the exact gap that let a length meter masquerade as
    // a clarity meter earlier in P-019.
    const flat = (t: string): number => ({ a: 100, b: 100 })[t] ?? 0;
    const got = postRetrievalClarity(['a b'], words, flat, 200, 2);
    expect(got.bits!).toBeCloseTo(0, 10);
  });
});

describe('teaserOf', () => {
  it('extracts the teaser from a rendered corpus line', () => {
    const line = "- [work-item WI-6512 · 2026-08-09] the teaser text → work_items:get { id: 'WI-6512' }";
    expect(teaserOf(line)).toBe('the teaser text');
  });

  it('drops the resolve call, which is boilerplate present in EVERY line', () => {
    // ⚠ PERMANENT CONTROL. Leaving it in folds one shared vocabulary into every
    // retrieved language model, damping every divergence toward a constant —
    // shrinking the exact signal the study measures.
    const line = "- [session abc · 2026-08-09] kettle → sessions:search { session: 'abc', query: 'kettle' }";
    expect(teaserOf(line)).toBe('kettle');
    expect(teaserOf(line)).not.toContain('sessions:search');
  });

  it('survives a line with no resolve call or no label', () => {
    expect(teaserOf('- [work-item WI-1] just a teaser')).toBe('just a teaser');
    expect(teaserOf('no label at all')).toBe('no label at all');
  });
});
