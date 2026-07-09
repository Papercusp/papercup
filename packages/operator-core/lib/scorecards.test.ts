/**
 * scorecards.test.ts — pure unit tests for the trend DIRECTION logic
 * (plan-templates-and-rubric-v2-2026-06-20 P-010). The end-to-end aggregation
 * (reading real scorecards → a RubricTrend) is covered by the integration suite;
 * this pins the direction calc, which is the one non-trivial branch — the
 * default-ordinal severity (healthy<degraded<broken) with unknown/custom ratings
 * excluded as unassessable.
 */
import { describe, it, expect } from 'vitest';
import { computeTrendDirection, computeRubricStaleness, compressSeries, ratingScore10, scorecardScore10 } from './scorecards';
import type { CriterionTrend } from './scorecards';

const s = (...ratings: string[]) => ratings.map((rating, i) => ({ at: `2026-06-20T0${i}:00:00.000Z`, rating }));

/** Build a minimal CriterionTrend from a rating list (only the fields staleness reads).
 *  `idleCount` = how many of the 'unknown' ratings are idle-tagged (EI-7624). */
const crit = (criterion: string, ...ratings: string[]): CriterionTrend => critIdle(criterion, 0, ...ratings);
const critIdle = (criterion: string, idleCount: number, ...ratings: string[]): CriterionTrend => {
  const distribution: Record<string, number> = {};
  for (const r of ratings) distribution[r] = (distribution[r] ?? 0) + 1;
  return {
    criterion,
    count: ratings.length,
    distribution,
    idleCount,
    first: { rating: ratings[0] ?? 'unknown', at: '2026-06-20T00:00:00.000Z' },
    latest: { rating: ratings[ratings.length - 1] ?? 'unknown', at: '2026-06-20T01:00:00.000Z' },
    direction: 'unknown',
  };
};

describe('computeTrendDirection (P-010)', () => {
  it('worsening — severity rises first→latest', () => {
    expect(computeTrendDirection(s('healthy', 'degraded', 'broken'))).toBe('worsening');
    expect(computeTrendDirection(s('healthy', 'broken'))).toBe('worsening');
    expect(computeTrendDirection(s('degraded', 'broken'))).toBe('worsening');
  });

  it('improving — severity falls first→latest', () => {
    expect(computeTrendDirection(s('broken', 'degraded', 'healthy'))).toBe('improving');
    expect(computeTrendDirection(s('broken', 'healthy'))).toBe('improving');
  });

  it('stable — first and latest assessable ratings are equal (incl. a dip that recovers)', () => {
    expect(computeTrendDirection(s('healthy', 'healthy'))).toBe('stable');
    expect(computeTrendDirection(s('degraded', 'broken', 'degraded'))).toBe('stable'); // net first→latest only
  });

  it('unknown — fewer than 2 ASSESSABLE points', () => {
    expect(computeTrendDirection(s())).toBe('unknown'); // empty
    expect(computeTrendDirection(s('healthy'))).toBe('unknown'); // single point
    expect(computeTrendDirection(s('unknown', 'unknown'))).toBe('unknown'); // no assessable
    expect(computeTrendDirection(s('unknown', 'broken'))).toBe('unknown'); // only 1 assessable
  });

  it('excludes unknown + custom ratings from the calc (orders only the default scale)', () => {
    // unknown in the middle is skipped: assessable = [healthy(0), broken(2)] → worsening.
    expect(computeTrendDirection(s('healthy', 'unknown', 'broken'))).toBe('worsening');
    // a custom (non-default) rating is unassessable, like unknown.
    expect(computeTrendDirection(s('degraded', 'flapping', 'healthy'))).toBe('improving'); // [1, 0]
    expect(computeTrendDirection(s('custom-a', 'custom-b'))).toBe('unknown'); // none orderable
  });

  it('is case-insensitive on the rating vocabulary', () => {
    expect(computeTrendDirection(s('HEALTHY', 'Broken'))).toBe('worsening');
  });
});

describe('computeRubricStaleness (P-011)', () => {
  it('flags a criterion persistently rated unknown (model drifted)', () => {
    const r = computeRubricStaleness([crit('placement-health', 'unknown', 'unknown', 'unknown')]);
    expect(r.stale).toBe(true);
    expect(r.staleCriteria).toHaveLength(1);
    expect(r.staleCriteria[0].criterion).toBe('placement-health');
    expect(r.staleCriteria[0].staleFraction).toBe(1);
    expect(r.staleCriteria[0].samples).toBe(3);
    expect(r.reason).toMatch(/placement-health/);
  });

  it('does NOT flag a criterion being assessed (healthy/degraded/broken)', () => {
    const r = computeRubricStaleness([crit('end-to-end-flow', 'healthy', 'degraded', 'broken')]);
    expect(r.stale).toBe(false);
    expect(r.staleCriteria).toEqual([]);
    expect(r.reason).toMatch(/no staleness/);
  });

  it('does NOT flag persistent broken (a real system finding, not a stale rubric)', () => {
    // The default staleRatings is ['unknown'] only — persistent 'broken' is the
    // trend's worsening/broken signal, not staleness.
    const r = computeRubricStaleness([crit('watchdog-determinism', 'broken', 'broken', 'broken', 'broken')]);
    expect(r.stale).toBe(false);
  });

  it('needs ≥ minSamples (default 3) before judging — too few unknowns is quiet, not stale', () => {
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown')]).stale).toBe(false); // 2 < 3
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown')], { minSamples: 2 }).stale).toBe(true);
  });

  it('flags at/above the staleFraction threshold (default 0.5)', () => {
    // 2/4 unknown = 0.5 → stale (>= threshold).
    expect(computeRubricStaleness([crit('c', 'unknown', 'unknown', 'healthy', 'degraded')]).stale).toBe(true);
    // 1/4 unknown = 0.25 → not stale.
    expect(computeRubricStaleness([crit('c', 'unknown', 'healthy', 'degraded', 'broken')]).stale).toBe(false);
  });

  it('reports only the stale criteria across a mixed rubric', () => {
    const r = computeRubricStaleness([
      crit('fresh', 'healthy', 'degraded', 'healthy'),
      crit('drifted', 'unknown', 'unknown', 'unknown'),
      crit('also-fresh', 'broken', 'degraded', 'broken'),
    ]);
    expect(r.stale).toBe(true);
    expect(r.staleCriteria.map((c) => c.criterion)).toEqual(['drifted']);
  });

  it('is case-insensitive on the stale rating, and honors a custom staleRatings set', () => {
    expect(computeRubricStaleness([crit('c', 'UNKNOWN', 'Unknown', 'unknown')]).stale).toBe(true);
    // widen to also treat 'broken' as stale evidence (D-004's broader signal).
    const r = computeRubricStaleness([crit('c', 'broken', 'broken', 'unknown')], { staleRatings: ['unknown', 'broken'] });
    expect(r.stale).toBe(true);
    expect(r.staleCriteria[0].staleFraction).toBe(1);
  });

  it('empty criteria → not stale', () => {
    const r = computeRubricStaleness([]);
    expect(r.stale).toBe(false);
    expect(r.staleCriteria).toEqual([]);
  });

  // EI-7624: idle-tagged unknowns ("the stage did not run") are no-signal, not
  // drift-signal — excluded from BOTH sides of the fraction.
  describe('idle-tagged unknowns (EI-7624)', () => {
    it('a mostly-idle window does not manufacture staleness', () => {
      // 9 idle-unknowns + 3 healthy: pre-fix 9/12 = stale; post-fix 0/3 → fresh.
      const c = critIdle('bee-execution', 9, ...Array(9).fill('unknown'), 'healthy', 'healthy', 'healthy');
      expect(computeRubricStaleness([c]).stale).toBe(false);
    });

    it('idle exclusion does not dilute a real drift signal in the non-idle samples', () => {
      // 9 idle-unknowns + 3 bare-unknowns + 1 healthy: the non-idle base is 4,
      // of which 3 are unassessable → 0.75 ≥ 0.5 → stale.
      const c = critIdle('drifted', 9, ...Array(12).fill('unknown'), 'healthy');
      const r = computeRubricStaleness([c]);
      expect(r.stale).toBe(true);
      expect(r.staleCriteria[0].samples).toBe(4);
      expect(r.staleCriteria[0].staleFraction).toBe(0.75);
      expect(r.staleCriteria[0].idleExcluded).toBe(9);
      expect(r.staleCriteria[0].reason).toMatch(/9 idle-tagged excluded/);
    });

    it('idle exclusion applies to the minSamples gate (all-idle window → quiet, not stale)', () => {
      const c = critIdle('paused-stage', 5, ...Array(5).fill('unknown'));
      expect(computeRubricStaleness([c]).stale).toBe(false); // 0 non-idle samples < 3
    });

    it('idleExcluded is 0 and the reason unchanged when nothing was idle-tagged', () => {
      const r = computeRubricStaleness([crit('c', 'unknown', 'unknown', 'unknown')]);
      expect(r.staleCriteria[0].idleExcluded).toBe(0);
      expect(r.staleCriteria[0].reason).not.toMatch(/idle-tagged excluded/);
    });

    it('idleCount is ignored when unknown is not in the staleRatings set', () => {
      // staleRatings ['broken']: idle-unknowns are irrelevant to that calc.
      const c = critIdle('c', 2, 'unknown', 'unknown', 'broken', 'broken', 'broken');
      const r = computeRubricStaleness([c], { staleRatings: ['broken'] });
      expect(r.stale).toBe(true);
      expect(r.staleCriteria[0].samples).toBe(5); // no idle exclusion
      expect(r.staleCriteria[0].staleFraction).toBe(0.6);
    });
  });
});

describe('compressSeries (WI-2943)', () => {
  const at = (i: number) => `2026-06-20T${String(i).padStart(2, '0')}:00:00.000Z`;

  it('empty → no runs', () => {
    expect(compressSeries([])).toEqual([]);
  });

  it('a single rating is one run of 1', () => {
    expect(compressSeries([{ at: at(0), rating: 'healthy' }])).toEqual([
      { rating: 'healthy', from: at(0), to: at(0), n: 1 },
    ]);
  });

  it('collapses consecutive identical ratings into runs with from/to/n', () => {
    const series = [
      { at: at(0), rating: 'unknown' },
      { at: at(1), rating: 'unknown' },
      { at: at(2), rating: 'unknown' },
      { at: at(3), rating: 'healthy' },
      { at: at(4), rating: 'unknown' },
    ];
    expect(compressSeries(series)).toEqual([
      { rating: 'unknown', from: at(0), to: at(2), n: 3 },
      { rating: 'healthy', from: at(3), to: at(3), n: 1 },
      { rating: 'unknown', from: at(4), to: at(4), n: 1 },
    ]);
  });

  it('preserves the total count across runs (lossless on n)', () => {
    const ratings = ['a', 'a', 'b', 'a', 'c', 'c', 'c', 'b'];
    const series = ratings.map((rating, i) => ({ at: at(i), rating }));
    const runs = compressSeries(series);
    expect(runs.reduce((n, r) => n + r.n, 0)).toBe(ratings.length);
  });
});

describe('numeric 0–10 read-time projection (rubrics-tab-scorecard-ui P-004 / D-001)', () => {
  it('ratingScore10 maps both shared vocabularies; unknown/custom → null', () => {
    expect(ratingScore10('pass')).toBe(10);
    expect(ratingScore10('Partial')).toBe(5); // case-insensitive
    expect(ratingScore10('fail')).toBe(0);
    expect(ratingScore10('healthy')).toBe(10);
    expect(ratingScore10('degraded')).toBe(5);
    expect(ratingScore10('broken')).toBe(0);
    expect(ratingScore10('unknown')).toBeNull();
    expect(ratingScore10('some-custom-rating')).toBeNull();
  });

  it('ratingScore10 honors per-rubric overrides without mutating the default', () => {
    expect(ratingScore10('partial', { partial: 7 })).toBe(7);
    expect(ratingScore10('partial')).toBe(5); // default untouched
    expect(ratingScore10('custom-tier', { 'custom-tier': 3 })).toBe(3);
  });

  it('scorecardScore10 is the mean over MAPPABLE ratings only (unknown excluded, never 0)', () => {
    const score = scorecardScore10({
      a: { rating: 'pass' }, // 10
      b: { rating: 'partial' }, // 5
      c: { rating: 'fail' }, // 0
      d: { rating: 'unknown' }, // excluded
    });
    expect(score).toBe(5); // (10+5+0)/3, NOT /4
  });

  it('scorecardScore10 rounds to 1 decimal and is null for an all-unknown scorecard', () => {
    expect(scorecardScore10({ a: { rating: 'pass' }, b: { rating: 'pass' }, c: { rating: 'partial' } })).toBe(8.3);
    expect(scorecardScore10({ a: { rating: 'unknown' }, b: { rating: 'unknown' } })).toBeNull();
    expect(scorecardScore10({})).toBeNull();
  });

  it('computeTrendDirection now orders the pass vocabulary (was silently unknown pre-P-004)', () => {
    expect(computeTrendDirection(s('pass', 'fail'))).toBe('worsening');
    expect(computeTrendDirection(s('fail', 'partial', 'pass'))).toBe('improving');
    expect(computeTrendDirection(s('pass', 'pass'))).toBe('stable');
    // mixed-vocabulary series still works (both are ordinal 0..2)
    expect(computeTrendDirection(s('healthy', 'fail'))).toBe('worsening');
  });
});
