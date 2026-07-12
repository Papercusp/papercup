/**
 * Scout signal accumulator (blender-self-learning-2026-07-12 P-001 / WI-4317).
 * Pure tests for the watermark derivation (last-run vs the bounded lookback
 * floor), the weighted new-signal score the P-002 cadence gate consumes
 * (score 0 = no fire; clamping of corrupt counts), the in-process sweep
 * throttle, and the env tunables / kill switches. The IO deps are mocked only
 * so importing the module has no load-time side effects (mirrors
 * ungraded-filings-watchdog.test.ts).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@papercusp/db-org', () => ({ getOrgPg: () => ({ sql: () => Promise.resolve([]) }) }));
vi.mock('../pot/started', () => ({ listStartedPots: vi.fn(async () => []) }));
vi.mock('./tick-ledger', () => ({ readLastRanTickAtMs: vi.fn(async () => null) }));

import {
  SIGNAL_LANES,
  DEFAULT_LANE_WEIGHTS,
  effectiveWatermarkMs,
  weightedSignalScore,
  shouldSweepNow,
  signalAccumulatorLookbackSec,
  signalAccumulatorSweepSec,
  scoutSignalAccumulatorSweep,
  __resetSweepThrottleForTests,
} from './signal-accumulator';

const NOW = Date.parse('2026-07-12T12:00:00Z');
const DAY = 86_400_000;

afterEach(() => {
  vi.unstubAllEnvs();
  __resetSweepThrottleForTests();
});

describe('effectiveWatermarkMs — the recount baseline', () => {
  it('uses the last successful run when it is inside the lookback window', () => {
    const lastRan = NOW - 2 * 3_600_000; // 2h ago, lookback 7d
    expect(effectiveWatermarkMs(lastRan, NOW, 604_800)).toBe(lastRan);
  });

  it('floors a never-ran scope at now - lookback (never scans from epoch)', () => {
    expect(effectiveWatermarkMs(null, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });

  it('floors an ANCIENT last-run the same way (bounded scan)', () => {
    expect(effectiveWatermarkMs(NOW - 90 * DAY, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });

  it('treats a non-finite last-run as never-ran', () => {
    expect(effectiveWatermarkMs(Number.NaN, NOW, 604_800)).toBe(NOW - 7 * DAY);
  });
});

describe('weightedSignalScore — what the cadence gate consumes', () => {
  it('scores zero on an empty / all-zero accumulator (score 0 never fires)', () => {
    expect(weightedSignalScore({})).toBe(0);
    expect(
      weightedSignalScore(Object.fromEntries(SIGNAL_LANES.map((l) => [l, 0]))),
    ).toBe(0);
  });

  it('applies the approved per-lane weights', () => {
    expect(weightedSignalScore({ 'scorecard-rating-changes': 2 })).toBe(6); // 3×
    expect(weightedSignalScore({ observations: 3 })).toBe(6); // 2×
    expect(weightedSignalScore({ captures: 4 })).toBe(4); // 1×
    expect(weightedSignalScore({ reverts: 1 })).toBe(3); // 3×
    expect(weightedSignalScore({ deferrals: 2 })).toBe(2); // 1×
    expect(weightedSignalScore({ completions: 4 })).toBe(2); // 0.5×
  });

  it('sums across lanes', () => {
    expect(weightedSignalScore({ observations: 1, reverts: 1, completions: 2 })).toBe(2 + 3 + 1);
  });

  it('ignores unknown lanes and clamps corrupt (negative / non-finite) counts', () => {
    expect(weightedSignalScore({ bogus: 100 } as never)).toBe(0);
    expect(weightedSignalScore({ observations: -5, captures: Number.NaN })).toBe(0);
    // A negative count in one lane must not mask real signal in another.
    expect(weightedSignalScore({ observations: -5, captures: 2 })).toBe(2);
  });

  it('accepts override weights (the per-routine cadence payload knob)', () => {
    const flat = Object.fromEntries(SIGNAL_LANES.map((l) => [l, 1])) as Record<
      (typeof SIGNAL_LANES)[number],
      number
    >;
    expect(weightedSignalScore({ 'scorecard-rating-changes': 2, completions: 2 }, flat)).toBe(4);
  });

  it('every declared lane carries a default weight', () => {
    for (const lane of SIGNAL_LANES) {
      expect(DEFAULT_LANE_WEIGHTS[lane]).toBeGreaterThan(0);
    }
  });
});

describe('shouldSweepNow — the in-process throttle', () => {
  it('always sweeps on a fresh process (null last-sweep)', () => {
    expect(shouldSweepNow(null, NOW, 120)).toBe(true);
  });

  it('withholds inside the window, allows at/after it', () => {
    expect(shouldSweepNow(NOW - 119_000, NOW, 120)).toBe(false);
    expect(shouldSweepNow(NOW - 120_000, NOW, 120)).toBe(true);
    expect(shouldSweepNow(NOW - 121_000, NOW, 120)).toBe(true);
  });
});

describe('env tunables', () => {
  it('lookback defaults to 7d and reads the env override', () => {
    expect(signalAccumulatorLookbackSec()).toBe(604_800);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', '3600');
    expect(signalAccumulatorLookbackSec()).toBe(3600);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', 'not-a-number');
    expect(signalAccumulatorLookbackSec()).toBe(604_800);
  });

  it('sweep throttle defaults to 120s and rejects negatives', () => {
    expect(signalAccumulatorSweepSec()).toBe(120);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC', '30');
    expect(signalAccumulatorSweepSec()).toBe(30);
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_SWEEP_SEC', '-1');
    expect(signalAccumulatorSweepSec()).toBe(120);
  });
});

describe('scoutSignalAccumulatorSweep — fail-soft shell', () => {
  it('kill switch (lookback <= 0) selects nothing and touches no IO', async () => {
    vi.stubEnv('PAPERCUSP_SIGNAL_ACCUM_LOOKBACK_SEC', '0');
    const { listStartedPots } = await import('../pot/started');
    await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
    expect(vi.mocked(listStartedPots)).not.toHaveBeenCalled();
  });

  it('no started pots ⇒ no results, and the throttle withholds the next tick', async () => {
    const { listStartedPots } = await import('../pot/started');
    vi.mocked(listStartedPots).mockResolvedValue([]);
    await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
    expect(vi.mocked(listStartedPots)).toHaveBeenCalledTimes(1);
    // 30s later (a routinesTick) the throttle withholds — no second listStartedPots.
    await expect(scoutSignalAccumulatorSweep({ now: NOW + 30_000 })).resolves.toEqual([]);
    expect(vi.mocked(listStartedPots)).toHaveBeenCalledTimes(1);
  });

  it('never throws when the pot listing fails (fail-soft)', async () => {
    // The fail-soft path deliberately console.warns instead of throwing.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { listStartedPots } = await import('../pot/started');
      vi.mocked(listStartedPots).mockRejectedValue(new Error('pg down'));
      await expect(scoutSignalAccumulatorSweep({ now: NOW })).resolves.toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed'));
    } finally {
      warn.mockRestore();
    }
  });
});
