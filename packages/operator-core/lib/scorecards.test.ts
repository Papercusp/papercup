/**
 * scorecards.test.ts — pure unit tests for the trend DIRECTION logic
 * (plan-templates-and-rubric-v2-2026-06-20 P-010). The end-to-end aggregation
 * (reading real scorecards → a RubricTrend) is covered by the integration suite;
 * this pins the direction calc, which is the one non-trivial branch — the
 * default-ordinal severity (healthy<degraded<broken) with unknown/custom ratings
 * excluded as unassessable.
 */
import { describe, it, expect } from 'vitest';
import { computeTrendDirection } from './scorecards';

const s = (...ratings: string[]) => ratings.map((rating, i) => ({ at: `2026-06-20T0${i}:00:00.000Z`, rating }));

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
