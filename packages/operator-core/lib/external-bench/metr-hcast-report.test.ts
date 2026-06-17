/**
 * METR HCAST report unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-006/P-007).
 *
 * Focus: per-arm horizon aggregation (mean success over scored seeds; infra-null rows excluded; tasks with no
 * baseline dropped), the two-arm LIFT (hive vs single-opus), the MANDATORY honest-framing caveats (D-002/D-003),
 * and the human-readable formatter. Pure — synthetic runner results, no docker/horizon-data dependency.
 */
import { describe, expect, it } from 'vitest';
import { buildMetrHcastReport, formatMetrHcastReport, toHorizonTasks } from './metr-hcast-report';
import type { MetrHcastTaskResult } from './metr-hcast-runner';

/** Build a synthetic per-(task,seed) result. */
function result(
  instanceId: string,
  humanMinutes: number | null,
  resolved: boolean | null,
  score: number | null = resolved === null ? null : resolved ? 1 : 0,
): MetrHcastTaskResult {
  const family = instanceId.split('__')[0];
  return {
    attempt: {
      arm: 'x',
      blueprintId: 'metr-hcast',
      instanceId,
      seed: '0',
      diff: '',
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.001,
      turns: 1,
      wallClockMs: 100,
      trajectoryRef: '',
      stopReason: resolved === null ? 'error' : 'done',
      armMeta: { family },
    },
    grade: {
      instanceId,
      prefix: '0',
      resolved,
      score,
      graderFamily: 'metr-hcast',
      graderVersion: '1.0.0',
      rawGraderOutput: { score },
    },
    humanMinutes,
  };
}

/**
 * A success curve that collapses around `mid` minutes: tasks shorter than mid solved, longer not.
 * The hive arm uses a LARGER mid → its horizon is longer (the lift we want to detect).
 */
function arm(mid: number): MetrHcastTaskResult[] {
  const mins = [2, 4, 8, 16, 32, 64, 128, 256];
  return mins.map((m) => {
    const fam = `fam${Math.floor(Math.log2(m))}`;
    const resolved = m <= mid;
    return result(`${fam}__t${m}`, m, resolved);
  });
}

describe('toHorizonTasks', () => {
  it('averages success over scored seeds, excludes infra-null rows, drops baseline-less tasks', () => {
    const results: MetrHcastTaskResult[] = [
      result('f__a', 10, true), // seed 0 solved
      { ...result('f__a', 10, false), attempt: { ...result('f__a', 10, false).attempt, seed: '1' } }, // seed 1 failed → rate 0.5
      result('f__b', 20, null), // all-infra → dropped from fit
      result('f__c', null, true), // no baseline → dropped
    ];
    const { tasks, baselinedTasksSeen } = toHorizonTasks(results);
    const a = tasks.find((t) => t.taskId === 'f__a')!;
    expect(a.successRate).toBe(0.5);
    expect(tasks.find((t) => t.taskId === 'f__b')).toBeUndefined(); // all-infra dropped
    expect(tasks.find((t) => t.taskId === 'f__c')).toBeUndefined(); // no baseline dropped
    expect(baselinedTasksSeen).toBe(2); // f__a + f__b have baselines (f__c does not)
  });
});

describe('buildMetrHcastReport', () => {
  it('fits a horizon per arm and computes a positive hive-vs-single-opus lift', () => {
    const report = buildMetrHcastReport(
      {
        'baseline-a-ablation': arm(16), // single-opus solves up to ~16 min
        papercusp: arm(64), //            hive solves up to ~64 min → longer horizon
      },
      { bootstrap: 200, seed: 1, weighting: 'equal' },
    );
    expect(report.suite).toBe('metr-hcast');
    expect(report.arms).toHaveLength(2);
    const hive = report.arms.find((a) => a.arm === 'papercusp')!;
    const solo = report.arms.find((a) => a.arm === 'baseline-a-ablation')!;
    expect(hive.fit.degenerate).toBe(false);
    expect(solo.fit.degenerate).toBe(false);

    const hiveP50 = hive.points.find((p) => p.quantile === 0.5)!;
    const soloP50 = solo.points.find((p) => p.quantile === 0.5)!;
    // The hive's 50%-horizon is longer than single-opus's.
    expect(hiveP50.horizonMinutes).toBeGreaterThan(soloP50.horizonMinutes);

    const lift50 = report.lifts.find((l) => l.quantile === 0.5)!;
    expect(lift50.liftRatio).toBeGreaterThan(1);
    expect(lift50.treatmentMinutes).toBe(hiveP50.horizonMinutes);
    expect(lift50.baselineMinutes).toBe(soloP50.horizonMinutes);
    expect(report.humanTimeRangeMin).toEqual([2, 256]);
  });

  it('ALWAYS emits the three mandatory honest-framing caveats (D-002/D-003)', () => {
    const report = buildMetrHcastReport({ papercusp: arm(32), 'baseline-a-ablation': arm(16) }, { bootstrap: 0 });
    expect(report.caveats).toHaveLength(3);
    expect(report.caveats[0]).toMatch(/ILLUSTRATIVE-ONLY|NOT leaderboard-comparable/i);
    expect(report.caveats[1]).toMatch(/LIFT IS THE DEFENSIBLE SIGNAL/i);
    expect(report.caveats[2]).toMatch(/SINGLE-AGENT BY CONSTRUCTION/i);
  });

  it('emits no lift when an arm is missing (only single-opus ran)', () => {
    const report = buildMetrHcastReport({ 'baseline-a-ablation': arm(16) }, { bootstrap: 0 });
    expect(report.lifts).toEqual([]);
    expect(report.arms).toHaveLength(1);
  });

  it('CI-bracketed p50 horizon is produced when bootstrap > 0', () => {
    const report = buildMetrHcastReport({ papercusp: arm(32) }, { bootstrap: 200, seed: 3, weighting: 'equal' });
    const p50 = report.arms[0].points.find((p) => p.quantile === 0.5)!;
    expect(p50.ci).toBeDefined();
    expect(p50.ci!.lower).toBeLessThanOrEqual(p50.horizonMinutes);
    expect(p50.ci!.upper).toBeGreaterThanOrEqual(p50.horizonMinutes);
  });
});

describe('formatMetrHcastReport', () => {
  it('renders the headline lift + per-arm horizons + the caveats', () => {
    const report = buildMetrHcastReport(
      { papercusp: arm(64), 'baseline-a-ablation': arm(16) },
      { bootstrap: 100, seed: 1, weighting: 'equal', runId: 'run-xyz' },
    );
    const text = formatMetrHcastReport(report);
    expect(text).toMatch(/METR HCAST horizon report/);
    expect(text).toMatch(/HEADLINE — horizon LIFT/);
    expect(text).toMatch(/× lift/);
    expect(text).toMatch(/CAVEATS \(must surface\)/);
    expect(text).toMatch(/run-xyz/);
  });
});
