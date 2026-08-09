import { describe, expect, it } from 'vitest';

import {
  CORPUS_CLARITY_FOCUSED_BITS,
  assessCorpusQueryClarity,
  clarityWarrantsEscalation,
  scoreCorpusQueryClarity,
  type QueryClarityOptions,
} from './corpus-query-clarity';

/** A collection big enough that log2(ndocs/df) lands in a readable range. */
const NDOCS = 1000;

/** DF lookup over an explicit table. Absence ⇒ 0, exactly like the real
 *  `corpusTermDfLookup`, where absence from `corpus_term_df` IS the verdict
 *  "unattested" rather than a missing measurement. */
const dfOver =
  (table: Record<string, number>) =>
  (term: string): number =>
    table[term] ?? 0;

const opts = (table: Record<string, number>, extra: QueryClarityOptions = {}): QueryClarityOptions => ({
  df: dfOver(table),
  ndocs: NDOCS,
  ...extra,
});

const log2 = (x: number): number => Math.log(x) / Math.LN2;

describe('scoreCorpusQueryClarity', () => {
  it('computes SCS as KL divergence of the query LM from the collection LM', () => {
    // Two attested terms, df 10 each, N=1000.
    //   idf      = log2(1000/10)          = 6.6439
    //   SCS      = Σ (idf - log2(n)) / n  = (6.6439 - 1) = 5.6439
    const a = scoreCorpusQueryClarity(['alpha', 'beta'], opts({ alpha: 10, beta: 10 }));
    const expected = log2(NDOCS / 10) - log2(2);

    expect(a.scs).toBeCloseTo(expected, 10);
    expect(a.avgIdf).toBeCloseTo(log2(NDOCS / 10), 10);
    expect(a.maxIdf).toBeCloseTo(log2(NDOCS / 10), 10);
    expect(a.attestedTerms).toBe(2);
    expect(a.attestedRatio).toBe(1);
  });

  it('scores a query of corpus-common words BELOW one of corpus-rare words', () => {
    // The ordering property the whole predictor rests on. If this inverts, the
    // escalation tier fires on precisely the wrong half of traffic.
    const common = scoreCorpusQueryClarity(['session', 'turns'], opts({ session: 800, turns: 750 }));
    const rare = scoreCorpusQueryClarity(['pgbouncer', 'holepunch'], opts({ pgbouncer: 6, holepunch: 4 }));

    expect(common.scs).not.toBeNull();
    expect(rare.scs).not.toBeNull();
    expect(rare.scs!).toBeGreaterThan(common.scs!);
    expect(common.verdict).toBe('unfocused');
    expect(rare.verdict).toBe('focused');
  });

  it('separates UNRETRIEVABLE from UNFOCUSED — an all-hapax query is not merely diffuse', () => {
    // D-064: a term the corpus attests fewer than twice cannot retrieve at all.
    // Widening/grading/re-ranking operate on documents the query MATCHED, so a
    // query matching nothing is a different problem from a diffuse one.
    const noise = scoreCorpusQueryClarity(
      ['a1b2c3d4e5f6', 'deadbeefcafe'],
      opts({ session: 800 }), // neither query term is in the table
    );

    expect(noise.verdict).toBe('unretrievable');
    expect(noise.attestedTerms).toBe(0);
    expect(noise.attestedRatio).toBe(0);
    expect(noise.scs).toBeNull();
  });

  it('counts unattested terms in attestedRatio but excludes them from the scores', () => {
    const mixed = scoreCorpusQueryClarity(
      ['pgbouncer', 'a1b2c3d4e5f6'],
      opts({ pgbouncer: 6 }),
    );

    expect(mixed.terms).toBe(2);
    expect(mixed.attestedTerms).toBe(1);
    expect(mixed.attestedRatio).toBe(0.5);
    // Scored over the ONE attested term only: n=1, so log2(n)=0 and SCS=idf.
    expect(mixed.scs).toBeCloseTo(log2(NDOCS / 6), 10);
    expect(mixed.note).toContain('unattested');
  });

  it('respects minDf — a term below the floor counts as unattested', () => {
    const table = { edgecase: 1 };
    expect(scoreCorpusQueryClarity(['edgecase'], opts(table)).verdict).toBe('unretrievable');
    expect(scoreCorpusQueryClarity(['edgecase'], opts(table, { minDf: 1 })).verdict).not.toBe(
      'unretrievable',
    );
  });
});

describe('the keyed short-circuit', () => {
  it('reports keyed for a resolvable record handle, and does NOT need a DF signal', () => {
    const a = scoreCorpusQueryClarity(['deploy', 'wi-6512', 'failed'], {});

    expect(a.verdict).toBe('keyed');
    expect(a.idToken).toBe('wi-6512');
    // Not measured, not measured-zero. The short-circuit precedes attestation.
    expect(a.attestedRatio).toBeNull();
  });

  it('shares the short-circuit RULE with corpusQueryText rather than copying it', () => {
    // A bare digit run must NOT key the query (WI-7237): "127" out of 127.0.0.1
    // is not a record handle, and letting it decide the query discards all the
    // real prose. This asserts the imported rule, so a change to the regex in
    // corpus-recall.ts moves both call sites together.
    const bare = scoreCorpusQueryClarity(['1500', 'pgbouncer'], opts({ pgbouncer: 6, '1500': 40 }));
    expect(bare.verdict).not.toBe('keyed');
    expect(bare.idToken).toBeNull();
  });

  it('is checked BEFORE the unknown guard, so a keyed query survives a dead DF table', () => {
    const a = scoreCorpusQueryClarity(['wi-6512'], { df: undefined, ndocs: 0 });
    expect(a.verdict).toBe('keyed');
  });
});

describe('absence of evidence is not focus', () => {
  it('returns unknown — never focused — when there is no DF signal', () => {
    for (const bad of [{}, { ndocs: NDOCS }, { df: dfOver({ x: 5 }) }, { df: dfOver({ x: 5 }), ndocs: 0 }]) {
      const a = scoreCorpusQueryClarity(['alpha', 'beta'], bad as QueryClarityOptions);
      expect(a.verdict).toBe('unknown');
      expect(a.scs).toBeNull();
      expect(a.attestedRatio).toBeNull();
    }
  });

  it('never escalates on unknown — a broken signal must not arm the expensive tier', () => {
    expect(clarityWarrantsEscalation('unknown')).toBe(false);
    expect(clarityWarrantsEscalation('keyed')).toBe(false);
    expect(clarityWarrantsEscalation('focused')).toBe(false);
    expect(clarityWarrantsEscalation('unfocused')).toBe(true);
    expect(clarityWarrantsEscalation('unretrievable')).toBe(true);
  });
});

describe('assessCorpusQueryClarity (text wrapper)', () => {
  it('tokenizes with corpusTerms — stopwords and short tokens do not count as terms', () => {
    const a = assessCorpusQueryClarity('why did the pgbouncer holepunch fail', opts({ pgbouncer: 6, holepunch: 4, fail: 300 }));
    // 'why'/'did'/'the' are stopwords or under the 4-char floor.
    expect(a.terms).toBe(3);
    expect(a.attestedTerms).toBe(3);
  });

  it('reports unretrievable for text with no candidate terms at all', () => {
    const a = assessCorpusQueryClarity('a of the', opts({}));
    expect(a.terms).toBe(0);
    expect(a.verdict).toBe('unretrievable');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FALSIFIABILITY CONTROL — permanently resident, never a mutation of the tree.
//
// Repo rule ("Proving a guard is falsifiable"): a guard test that has never
// failed is a guard you have not tested, and the way to prove it CAN fail is a
// deliberately-wrong implementation kept HERE — never by mutating the real
// module, which races git-sync's whole-tree sweep and has already committed a
// mutant once (EI-19450431506682666).
//
// The bug modelled is the exact one D-064/D-066 measured and reverted: treat an
// UNATTESTED term as maximally rare instead of as unretrievable. A miss reads
// as df 0 ⇒ maximal idf ⇒ maximal "clarity", so a query of pure hex noise
// scores as the most focused query in the corpus. It still looks like a working
// predictor, which is what makes it expensive.
// ─────────────────────────────────────────────────────────────────────────────

function scoreWithRarityInversionBug(
  terms: readonly string[],
  table: Record<string, number>,
): number {
  // Every term scored, unattested ones smoothed to df=1 (i.e. "maximally rare").
  const idfs = terms.map((t) => log2(NDOCS / Math.max(table[t] ?? 0, 1)));
  const n = idfs.length;
  return idfs.reduce((sum, idf) => sum + (idf - log2(n)) / n, 0);
}

describe('control: the rarity-inversion bug this module must not have', () => {
  const hexNoise = ['a1b2c3d4e5f6', 'deadbeefcafe'];
  const realQuery = ['pgbouncer', 'holepunch'];
  const table = { pgbouncer: 6, holepunch: 4 };

  it('CONTROL FAILS: the buggy implementation ranks hex noise as the MOST focused query', () => {
    const noise = scoreWithRarityInversionBug(hexNoise, table);
    const real = scoreWithRarityInversionBug(realQuery, table);

    // This is the defect, asserted so it cannot quietly stop being reproduced:
    // noise outscores a genuinely discriminating query.
    expect(noise).toBeGreaterThan(real);
  });

  it('SUBJECT PASSES: the real implementation refuses to score hex noise at all', () => {
    const noise = scoreCorpusQueryClarity(hexNoise, opts(table));
    const real = scoreCorpusQueryClarity(realQuery, opts(table));

    expect(noise.verdict).toBe('unretrievable');
    expect(noise.scs).toBeNull();
    expect(real.verdict).toBe('focused');

    // Calibration: the control and the subject must genuinely disagree here.
    // Without this line both could "pass" by the subject also being broken.
    expect(scoreWithRarityInversionBug(hexNoise, table)).toBeGreaterThan(
      scoreWithRarityInversionBug(realQuery, table),
    );
    expect(noise.scs).not.toEqual(real.scs);
  });
});

describe('the threshold constant', () => {
  it('is exported so a measurement can move it in one place', () => {
    // Guards against someone inlining the number back into the comparison —
    // the constant is deliberately a placeholder pending a distribution
    // measurement over real traffic, and an inlined copy cannot be recalibrated.
    expect(typeof CORPUS_CLARITY_FOCUSED_BITS).toBe('number');
    const below = scoreCorpusQueryClarity(['alpha'], opts({ alpha: 900 }));
    const above = scoreCorpusQueryClarity(['alpha'], opts({ alpha: 2 }));
    expect(below.verdict).toBe('unfocused');
    expect(above.verdict).toBe('focused');
  });
});
