import { describe, expect, it } from 'vitest';
import { D024_BASELINE_P95_MS } from './chunk-search-latency';
import {
  R33_AB_ARMS,
  R33_AB_FLOOR_MS,
  R33_AB_SITES,
  armOrder,
  r33AbBudgetMs,
  r33AbPasses,
  r33AbVerdicts,
  summarisePaired,
  type PairedSample,
  type PairedSummary,
  type R33AbSite,
} from './chunk-search-ab';

/** 20 pairs: A takes aMs, B takes bMs, both return `rows` rows. */
function pairs(aMs: number, bMs: number, rows = 30, round = 0): PairedSample[] {
  return Array.from({ length: 20 }, (_, q) => ({ round, q, aMs, bMs, aRows: rows, bRows: rows }));
}

describe('chunk-search same-time A/B (R-33, D-040)', () => {
  it('budgets are 0.25 x the D-024 baseline p95 with a 10 ms floor', () => {
    expect(Object.fromEntries(R33_AB_SITES.map((s) => [s, r33AbBudgetMs(s)]))).toEqual({
      plans: 413,
      turns: 348,
      work_item: 402.3,
      work_items_search: 100,
      consult: 10,
    });
    // The floor applies only where 0.25 x baseline is below it (consult: 3.5 ms).
    expect(0.25 * D024_BASELINE_P95_MS.consult).toBeLessThan(R33_AB_FLOOR_MS);
    expect(0.25 * D024_BASELINE_P95_MS.work_items_search).toBeGreaterThanOrEqual(R33_AB_FLOOR_MS);
  });

  it('every site has a baseline, a budget and a described A and B arm', () => {
    for (const site of R33_AB_SITES) {
      expect(D024_BASELINE_P95_MS[site]).toBeGreaterThan(0);
      expect(R33_AB_ARMS[site].a.length).toBeGreaterThan(0);
      expect(R33_AB_ARMS[site].b.length).toBeGreaterThan(0);
    }
    expect(Object.keys(R33_AB_ARMS).sort()).toEqual([...R33_AB_SITES].sort());
  });

  it('arm order alternates per pair, so each arm goes first in half the pairs', () => {
    let aFirst = 0;
    for (let r = 0; r < 3; r++) for (let q = 0; q < 30; q++) if (armOrder(r, q)[0] === 'A') aFirst++;
    expect(aFirst).toBe(45);
    expect(armOrder(0, 0)).toEqual(['A', 'B']);
    expect(armOrder(0, 1)).toEqual(['B', 'A']);
    // A new round flips the order a query saw in the previous round.
    expect(armOrder(1, 0)).toEqual(['B', 'A']);
  });

  it('the reading is B p95 minus A p95, with paired median delta and ratio', () => {
    const samples = [...pairs(10, 16), ...pairs(20, 30, 30, 1)];
    const s = summarisePaired(samples);
    expect(s).toMatchObject({ n: 40, pairs: 40, aErrors: 0, bErrors: 0, bEmptyWhereAHadRows: 0 });
    expect(s.a.p95).toBe(20);
    expect(s.b.p95).toBe(30);
    expect(s.addedP95).toBe(10);
    // Deltas are 6 x20 and 10 x20; nearest-rank median picks the 20th of 40.
    expect(s.pairedMedianDeltaMs).toBe(6);
    expect(s.pairedMedianRatio).toBe(1.5);
  });

  it('an errored pair stays out of the percentiles and is counted per arm', () => {
    const samples: PairedSample[] = [
      ...pairs(10, 12),
      { round: 1, q: 0, aMs: 9_000, bMs: 1, aRows: 0, bRows: 0, bError: 'connection reset' },
    ];
    const s = summarisePaired(samples);
    expect(s).toMatchObject({ n: 21, pairs: 20, aErrors: 0, bErrors: 1 });
    expect(s.a.max).toBe(10);
    expect(s.firstErrors).toEqual(['B: connection reset']);
  });

  it('top-hit agreement counts only pairs that recorded both tops', () => {
    const samples = pairs(10, 12).map((p, i) => ({
      ...p,
      ...(i < 10 ? { aTop: `x${i}`, bTop: i < 7 ? `x${i}` : 'other' } : {}),
    }));
    samples[0] = { ...samples[0], aTop: null, bTop: null }; // both empty agree
    expect(summarisePaired(samples).topHitAgreement).toEqual({ compared: 10, same: 7 });
    expect(summarisePaired(pairs(1, 1)).topHitAgreement).toEqual({ compared: 0, same: 0 });
  });

  it('counts pairs where B came back empty but A had rows', () => {
    const samples = pairs(10, 2);
    samples[3] = { ...samples[3], bRows: 0 };
    samples[4] = { ...samples[4], aRows: 0, bRows: 0 }; // both empty: not a B failure
    expect(summarisePaired(samples).bEmptyWhereAHadRows).toBe(1);
  });

  describe('verdicts', () => {
    const at = (addedP95: number): PairedSummary => {
      const s = summarisePaired(pairs(100, 100 + addedP95));
      expect(s.addedP95).toBe(addedP95);
      return s;
    };
    const valid = (over: Partial<Record<R33AbSite, PairedSummary>>) => ({
      plans: at(6),
      turns: at(47),
      work_item: at(9),
      work_items_search: at(67),
      consult: at(6.3),
      ...over,
    });

    it('passes the D-040 measurements, which sit inside every budget', () => {
      const v = r33AbVerdicts(valid({}));
      expect(v.map((x) => x.withinBudget)).toEqual([true, true, true, true, true]);
      expect(r33AbPasses(v)).toBe(true);
    });

    it('at the budget passes; one tenth of a millisecond over fails', () => {
      const v = r33AbVerdicts(valid({ consult: at(10), plans: at(413.1) }));
      const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
      expect(bySite.consult.withinBudget).toBe(true);
      expect(bySite.plans.withinBudget).toBe(false);
      expect(r33AbPasses(v)).toBe(false);
    });

    it('a missing site, an errored call or a silently empty B arm is invalid, never a pass', () => {
      const errored = summarisePaired([
        ...pairs(10, 11),
        { round: 1, q: 0, aMs: 1, bMs: 1, aRows: 1, bRows: 0, aError: 'statement timeout' },
      ]);
      const emptyB = summarisePaired(pairs(10, 1).map((p, i) => (i === 0 ? { ...p, bRows: 0 } : p)));
      const { consult: _omit, ...withoutConsult } = valid({ turns: errored, work_item: emptyB });
      const v = r33AbVerdicts(withoutConsult);
      const bySite = Object.fromEntries(v.map((x) => [x.site, x]));
      expect(bySite.consult).toMatchObject({ withinBudget: null, invalidReason: 'no completed pair' });
      expect(bySite.turns.withinBudget).toBeNull();
      expect(bySite.turns.invalidReason).toContain('statement timeout');
      expect(bySite.work_item.withinBudget).toBeNull();
      expect(bySite.work_item.invalidReason).toContain('B returned no rows in 1 pair');
      expect(bySite.plans.withinBudget).toBe(true);
      expect(r33AbPasses(v)).toBe(false);
    });
  });
});
