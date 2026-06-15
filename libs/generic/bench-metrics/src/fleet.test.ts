import { describe, it, expect } from 'vitest';
import {
  throughputMetrics,
  valueMetrics,
  buildHiveReport,
  mastHeadlineRate,
  MS_PER_HOUR,
  type FleetRunSummary,
  type HiveArmInput,
} from './fleet';

function summary(over: Partial<FleetRunSummary> = {}): FleetRunSummary {
  return {
    runId: 'run1',
    suite: 'swe-bench-pro',
    arm: 'hive',
    tasks: 10,
    resolved: 8,
    wallClockMs: MS_PER_HOUR, // 1 hour
    costUsd: 100,
    tokensTotal: 1_000_000,
    tasksZeroHumanGate: 9,
    ...over,
  };
}

describe('throughputMetrics', () => {
  it('computes per-hour, per-dollar, autonomy, and speedup-vs-serial', () => {
    const t = throughputMetrics(summary(), 3 * MS_PER_HOUR); // serial took 3h
    expect(t.resolvedPerHour).toBeCloseTo(8, 10);
    expect(t.resolvedPerDollar).toBeCloseTo(0.08, 10);
    expect(t.autonomyRate).toBeCloseTo(0.9, 10);
    expect(t.speedupVsSerial).toBeCloseTo(3, 10);
    expect(t.costUsd).toBe(100);
    expect(t.backlogDrainMs).toBe(MS_PER_HOUR);
  });

  it('speedup is null without a serial baseline', () => {
    expect(throughputMetrics(summary()).speedupVsSerial).toBeNull();
  });
});

describe('valueMetrics', () => {
  it('captures the $ of resolved tasks and checks the budget', () => {
    const v = valueMetrics(
      [
        { taskId: 'a', dollarValue: 100, resolved: true, costUsd: 10 },
        { taskId: 'b', dollarValue: 50, resolved: false, costUsd: 5 },
      ],
      'hive',
      20,
    );
    expect(v.valueCaptured).toBe(100);
    expect(v.valueAvailable).toBe(150);
    expect(v.captureRate).toBeCloseTo(100 / 150, 10);
    expect(v.valuePerDollar).toBeCloseTo(100 / 15, 10);
    expect(v.withinBudget).toBe(true); // $15 ≤ $20
    expect(valueMetrics([{ taskId: 'a', dollarValue: 1, resolved: true, costUsd: 15 }], 'hive', 10).withinBudget).toBe(false);
  });
});

describe('mastHeadlineRate', () => {
  it('prefers the judge overall rate, else sums the substrate rates', () => {
    expect(mastHeadlineRate({ arm: 'hive', tasks: 1, byCategory: null, byMode: null, overallFailureRate: 0.3, substrate: null, masBaselineBand: [0.41, 0.86] })).toBe(0.3);
    expect(
      mastHeadlineRate({
        arm: 'hive',
        tasks: 10,
        byCategory: null,
        byMode: null,
        overallFailureRate: null,
        substrate: { duplicationRate: 0.1, coordinationBreakdownRate: 0, misalignmentRate: 0.05, redundantWorkRate: 0, counts: { duplicate: 1, breakdown: 0, misalignment: 0, redundant: 0 }, coordinationActions: 5 },
        masBaselineBand: [0.41, 0.86],
      }),
    ).toBeCloseTo(0.15, 10);
    expect(mastHeadlineRate(null)).toBeNull();
  });
});

describe('buildHiveReport', () => {
  it('reports per-arm metrics + the hive−queen-ablated delta (the Queen value)', () => {
    const arms: HiveArmInput[] = [
      {
        summary: summary({ arm: 'hive', wallClockMs: MS_PER_HOUR, costUsd: 100, resolved: 8 }),
        taskValues: [
          { taskId: 'a', dollarValue: 100, resolved: true, costUsd: 10 },
          { taskId: 'b', dollarValue: 50, resolved: true, costUsd: 8 },
        ],
        coordEvents: [{ kind: 'duplicate_completion' }], // substrate dup rate 1/10
      },
      {
        summary: summary({ arm: 'queen-ablated', wallClockMs: 2 * MS_PER_HOUR, costUsd: 80, resolved: 5 }),
        taskValues: [
          { taskId: 'a', dollarValue: 100, resolved: true, costUsd: 10 },
          { taskId: 'b', dollarValue: 50, resolved: false, costUsd: 8 },
        ],
        coordEvents: [{ kind: 'duplicate_completion' }, { kind: 'duplicate_completion' }, { kind: 'duplicate_completion' }], // 3/10
      },
      { summary: summary({ arm: 'native-serial', wallClockMs: 3 * MS_PER_HOUR, costUsd: 50, resolved: 4 }) },
    ];
    const r = buildHiveReport(arms);
    expect(r.arms).toHaveLength(3);

    const hive = r.arms.find((a) => a.arm === 'hive')!;
    expect(hive.throughput.speedupVsSerial).toBeCloseTo(3, 10); // 3h serial / 1h hive

    const d = r.queenDelta!;
    expect(d.treatment).toBe('hive');
    expect(d.baseline).toBe('queen-ablated');
    expect(d.throughputRatio).toBeCloseTo((8 / 1) / (5 / 2), 10); // 8/hr vs 2.5/hr = 3.2
    expect(d.costRatio).toBeCloseTo(100 / 80, 10);
    expect(d.valueCapturedDelta).toBeCloseTo(150 - 100, 10); // hive captured both, qa only 'a'
    expect(d.coordFailureRateDelta).toBeCloseTo(0.1 - 0.3, 10); // negative = hive coordinates better
  });

  it('throws on empty input', () => {
    expect(() => buildHiveReport([])).toThrow(/no arms/);
  });
});
