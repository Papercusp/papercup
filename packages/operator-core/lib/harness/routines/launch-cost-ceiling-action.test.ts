/**
 * Tests for `system:launch-cost-ceiling` (plan agent-launch-context-cost-2026-09-18,
 * P-009(c); D-016).
 *
 * The cases are written against the REAL measured history this routine exists to have
 * caught, not against invented numbers — 2026-08-13 median 107,841 through 2026-09-17
 * median 305,926, with the +134k step on 2026-09-11. If a future threshold change stops
 * the `catches the real 2026-09-11 step` case firing, that is a genuine regression in the
 * detector and not a stale fixture.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CEILING_TOKENS,
  evaluateLaunchCost,
  MIN_SAMPLES,
} from './launch-cost-ceiling-action';
import type { DayStats } from '../../launch-cost/launch-cost-metrics';

/** A day row with only the fields the evaluator reads; the rest are structurally required. */
function day(d: string, medianTotal: number, count = 40): DayStats {
  return {
    day: d,
    count,
    medianTotal,
    p10Total: Math.round(medianTotal * 0.7),
    p90Total: Math.round(medianTotal * 1.4),
    minTotal: Math.round(medianTotal * 0.5),
    maxTotal: Math.round(medianTotal * 2),
    medianCacheRead: Math.round(medianTotal * 0.45),
    medianCacheCreation: Math.round(medianTotal * 0.45),
    medianInput: Math.round(medianTotal * 0.1),
  };
}

describe('evaluateLaunchCost — the detector that should have existed', () => {
  it('catches the real 2026-09-11 step (151k -> 285k) as a regression', () => {
    const days = [
      day('2026-09-05', 150_057),
      day('2026-09-06', 151_380),
      day('2026-09-07', 149_900),
      day('2026-09-08', 150_057),
      day('2026-09-09', 151_000),
      day('2026-09-10', 150_500),
      day('2026-09-11', 152_000),
      day('2026-09-15', 284_907),
      day('2026-09-17', 305_926),
    ];
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });

    expect(v.insufficient).toBeNull();
    expect(v.legs.map((l) => l.key).sort()).toEqual(['ceiling', 'regression']);
    // The baseline is the seven pre-step days, the recent window the two post-step ones.
    expect(v.baselineMedian).toBeGreaterThan(149_000);
    expect(v.baselineMedian).toBeLessThan(153_000);
    expect(v.recentMedian).toBeGreaterThan(290_000);
    expect(v.legs.find((l) => l.key === 'regression')!.summary).toContain('%');
  });

  it('stays quiet on a flat series — no alarm without a crossing', () => {
    const days = Array.from({ length: 9 }, (_, i) => day(`2026-08-0${i + 1}`, 107_841 + i * 200));
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });
    expect(v.insufficient).toBeNull();
    expect(v.legs).toEqual([]);
  });

  it('fires the ceiling leg with NO baseline at all (a cold install is still protected)', () => {
    const v = evaluateLaunchCost([day('2026-09-17', 305_926)], { recentDays: 2, baselineDays: 7 });
    expect(v.legs.map((l) => l.key)).toEqual(['ceiling']);
    expect(v.legs[0]!.detail).toContain('before its first tool call'.replace('before', 'BEFORE'));
  });

  it('reports INSUFFICIENT rather than a false all-clear when the sample is thin', () => {
    // A shrinking sample and a shrinking median look identical in the headline number.
    const v = evaluateLaunchCost([day('2026-09-17', 90_000, MIN_SAMPLES - 1)], { recentDays: 1 });
    expect(v.legs).toEqual([]);
    expect(v.insufficient).toMatch(/below the \d+ needed/);
    expect(v.recentMedian).toBe(90_000);
  });

  it('a 4-session day cannot swing the verdict — the median is sample-weighted', () => {
    // One tiny catastrophic day beside a large healthy one must not trip the ceiling.
    const days = [
      ...Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, 100_000, 100)),
      day('2026-09-16', 100_000, 400),
      day('2026-09-17', 900_000, 4),
    ];
    const v = evaluateLaunchCost(days, { recentDays: 2, baselineDays: 7 });
    // Unweighted this pair averages 500,000 and would alarm; weighted it is ~107,900.
    expect(v.recentMedian).toBeLessThan(120_000);
    expect(v.legs).toEqual([]);
  });

  it('honours both kill switches independently', () => {
    const days = [
      ...Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, 150_000)),
      day('2026-09-16', 300_000),
      day('2026-09-17', 300_000),
    ];
    expect(evaluateLaunchCost(days, { ceilingTokens: 0 }).legs.map((l) => l.key)).toEqual(['regression']);
    expect(evaluateLaunchCost(days, { regressionPct: 0 }).legs.map((l) => l.key)).toEqual(['ceiling']);
    expect(evaluateLaunchCost(days, { ceilingTokens: 0, regressionPct: 0 }).legs).toEqual([]);
  });

  it('pins the ceiling to the fleet-member compaction limit', () => {
    // Not a magic number: a member session at this launch cost is past its 90% steer
    // point at birth. If COMPACTION_LIMIT_DEFAULT_1M_FLEET_MEMBER_CAP moves, this moves.
    expect(DEFAULT_CEILING_TOKENS).toBe(250_000);
  });

  it('is order-insensitive — days need not arrive sorted', () => {
    const unsorted = [day('2026-09-17', 300_000), day('2026-09-01', 150_000), day('2026-09-16', 300_000)];
    const sorted = [day('2026-09-01', 150_000), day('2026-09-16', 300_000), day('2026-09-17', 300_000)];
    expect(evaluateLaunchCost(unsorted, { recentDays: 2, baselineDays: 7 })).toEqual(
      evaluateLaunchCost(sorted, { recentDays: 2, baselineDays: 7 }),
    );
  });
});
