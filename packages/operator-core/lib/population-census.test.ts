import { describe, expect, it } from 'vitest';

import {
  censusFromCounts,
  describeCensus,
  selectPopulation,
  withShownCount,
  type PopulationCensus,
  type PopulationMeta,
} from './population-census';

const meta: PopulationMeta = {
  population: 'sessions',
  basis: 'a row is in scope if it started inside the requested window',
  withheldReason: 'outside the requested window',
  reveal: 'widen `since`',
};

/**
 * THE CONTROL. This is what a renderer that ignores the provenance fields
 * produces, and it is kept here permanently and deliberately.
 *
 * Every assertion below about `describeCensus` is only meaningful if the naive
 * rendering is genuinely dangerous, so the danger is demonstrated rather than
 * asserted in a comment. Without this, a later reader sees a lot of ceremony
 * around `candidatesAreFloor` and no evidence that dropping it costs anything —
 * which is exactly how a guard gets simplified away.
 */
function naiveRender(census: PopulationCensus): string {
  return `matched ${census.counted} of ${census.candidates} ${census.population}`;
}

describe('selectPopulation (in-memory: the denominator is measured by construction)', () => {
  const rows = [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }];

  it('filters and counts in one pass, so rows and census cannot disagree', () => {
    const { rows: kept, census } = selectPopulation(rows, (r) => r.n % 2 === 0, meta);

    expect(kept.map((r) => r.n)).toEqual([2, 4]);
    expect(census.counted).toBe(2);
    expect(census.candidates).toBe(4);
    expect(census.withheld).toBe(2);
    expect(census.counted).toBe(kept.length);
  });

  it('is always status "measured" — the strong case, never a floor', () => {
    const { census } = selectPopulation(rows, () => true, meta);

    expect(census.candidatesStatus).toBe('measured');
    expect(census.candidatesAreFloor).toBe(false);
    expect(census.candidatesNote).toBeNull();
  });

  it('reports withheld: 0 when the filter hid nothing, rather than omitting it', () => {
    const { census } = selectPopulation(rows, () => true, meta);

    // 0 is informative here precisely because the denominator IS known: it says
    // the filter had nothing to hide. That reading is only available to a
    // measured census, which is why the unmeasured case below uses null.
    expect(census.withheld).toBe(0);
    expect(census.withheldReason).toBeNull();
    expect(census.reveal).toBeNull();
  });

  it('names the reveal lever only when there is actually something to reveal', () => {
    const { census } = selectPopulation(rows, (r) => r.n === 1, meta);

    expect(census.withheld).toBe(3);
    expect(census.withheldReason).toBe(meta.withheldReason);
    expect(census.reveal).toBe('widen `since`');
  });
});

describe('censusFromCounts — measured', () => {
  it('publishes the exact denominator and derives withheld from it', () => {
    const census = censusFromCounts(8, { status: 'measured', candidates: 392 }, meta);

    expect(census.candidates).toBe(392);
    expect(census.candidatesStatus).toBe('measured');
    expect(census.withheld).toBe(384);
    expect(describeCensus(census)).toBe('matched 8 of 392 sessions');
  });
});

describe('censusFromCounts — bounded (the denominator was itself capped)', () => {
  const census = censusFromCounts(
    8,
    { status: 'bounded', atLeast: 500, boundedBy: 'the count query\'s own LIMIT 500' },
    meta,
  );

  it('marks the total as a floor in BOTH the status and the boolean', () => {
    expect(census.candidatesStatus).toBe('bounded');
    // Redundant on purpose: a renderer that reads only one of these still has
    // to actively ignore the other to produce a precise-looking total.
    expect(census.candidatesAreFloor).toBe(true);
    expect(census.candidatesNote).toContain('LIMIT 500');
  });

  it('NEVER renders a capped count as an exact total', () => {
    const rendered = describeCensus(census);

    expect(rendered).toContain('AT LEAST 500');
    expect(rendered).toContain('may be larger');
    expect(rendered).not.toBe('matched 8 of 500 sessions');
  });

  it('CONTROL: the naive renderer does produce the precise, wrong total', () => {
    // The whole point of the qualifier. `500` here is a floor that arrived
    // because the count query hit its own limit; rendering it this way asserts
    // a base rate that was never measured, and reads as authoritative.
    expect(naiveRender(census)).toBe('matched 8 of 500 sessions');
    expect(naiveRender(census)).not.toContain('AT LEAST');
  });

  it('treats withheld as a floor too, and never goes negative', () => {
    expect(census.withheld).toBe(492);

    // A cap below the returned count is incoherent input, but clamping to 0
    // beats publishing a negative "withheld" that a reader would have to
    // interpret. The floor stays a floor.
    const odd = censusFromCounts(
      12,
      { status: 'bounded', atLeast: 10, boundedBy: 'a cap smaller than the page' },
      meta,
    );
    expect(odd.withheld).toBe(0);
  });
});

describe('censusFromCounts — not-measured (no base rate was obtained)', () => {
  const census = censusFromCounts(
    8,
    {
      status: 'not-measured',
      reason: 'counting every indexed turn needs a full scan',
      measureWith: 'sessions:count { since }',
    },
    meta,
  );

  it('reports null rather than zero, because zero claims an empty population', () => {
    expect(census.candidates).toBeNull();
    expect(census.candidatesStatus).toBe('not-measured');
  });

  it('reports withheld as null — an unmeasured read cannot know nothing was hidden', () => {
    // This is the assertion that matters most in the whole file. `withheld: 0`
    // against an unknown population is a silent wrong answer: it states the
    // filter removed nothing, which is precisely what was not established.
    expect(census.withheld).toBeNull();
    expect(census.withheld).not.toBe(0);
  });

  it('says the base rate is unknown out loud, and names what would measure it', () => {
    const rendered = describeCensus(census);

    expect(rendered).toContain('UNKNOWN total');
    expect(rendered).toContain('cannot tell you whether 8 is many or few');
    expect(rendered).toContain('sessions:count { since }');
  });

  it('CONTROL: the naive renderer turns the absent denominator into "of null"', () => {
    // Not merely ugly — in a JSON payload the same absence reads as a missing
    // field, which a scanning agent skips entirely and replaces with the
    // assumption that the slice is the whole.
    expect(naiveRender(census)).toBe('matched 8 of null sessions');
  });

  it('still offers the reveal lever, since an unknown total is exactly when you want it', () => {
    expect(census.reveal).toBe('widen `since`');
  });

  it('tolerates having no cheap way to measure', () => {
    const nothing = censusFromCounts(
      3,
      { status: 'not-measured', reason: 'the upstream API returns no total', measureWith: null },
      meta,
    );

    expect(nothing.measureWith).toBeNull();
    expect(describeCensus(nothing)).not.toContain('Measure it with');
  });
});

describe('withShownCount (transport dropped rows the filter kept)', () => {
  it('records the second, independent discrepancy', () => {
    const census = withShownCount(
      censusFromCounts(50, { status: 'measured', candidates: 392 }, meta),
      20,
      'result-door byte budget',
    );

    expect(census.shown).toBe(20);
    expect(census.counted).toBe(50);
    expect(describeCensus(census)).toContain('only 20 present in this payload');
  });

  it('is a no-op when nothing was dropped, so callers can pass a page size blindly', () => {
    const base = censusFromCounts(8, { status: 'measured', candidates: 392 }, meta);

    expect(withShownCount(base, 8, 'page size')).toEqual(base);
    expect(withShownCount(base, 20, 'page size')).toEqual(base);
    expect(withShownCount(base, Number.NaN, 'page size')).toEqual(base);
  });

  it('preserves the measured subtype through the wrapper', () => {
    const { census } = selectPopulation([1, 2, 3], (n) => n > 1, meta);
    const shown = withShownCount(census, 1, 'budget');

    // Still the stronger type: candidates stays non-null for callers downstream.
    expect(shown.candidates).toBe(3);
    expect(shown.candidatesStatus).toBe('measured');
  });
});

describe('the 2026-08-02 regression this module exists for', () => {
  it('a cluster that looks remarkable is disclosed as a slice of an unknown whole', () => {
    // 7 session chains clustered at 23.8-24.1h looked like a hard 24h lifetime
    // cap. The same table held chains of 32/66/111/166/193h. The read that
    // produced the cluster never said what it was a slice of.
    const cluster = censusFromCounts(
      7,
      {
        status: 'not-measured',
        reason: 'the query filtered to chains ending in the last 24h and never counted the rest',
        measureWith: 'the same query without the window predicate',
      },
      {
        population: 'session chains',
        basis: 'chains whose last turn falls inside the requested window',
        withheldReason: 'chain ended outside the window',
        reveal: 'drop the window predicate',
      },
    );

    const rendered = describeCensus(cluster);

    expect(rendered).toContain('UNKNOWN total');
    expect(rendered).toContain('cannot tell you whether 7 is many or few');
    // The refutation was one query away, and the census names it.
    expect(cluster.measureWith).toBe('the same query without the window predicate');
  });
});
