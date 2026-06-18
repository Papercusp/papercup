import { describe, it, expect } from 'vitest';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import { buildFrontierSweSuiteData, FRONTIER_SWE_CAVEATS } from './frontier-report';

/** Minimal frontier-swe row — only the fields buildFrontierSweSuiteData reads matter; rest cast away. */
function row(
  taskId: string,
  arm: string,
  seed: number,
  score: number | null,
  over: Partial<TaskRunResult> = {},
): TaskRunResult {
  return {
    suite: 'frontier-swe',
    taskId,
    arm,
    seed,
    score,
    generationStatus: 'completed',
    graderStatus: 'passed',
    ...over,
  } as unknown as TaskRunResult;
}

/** 5 trials of one (task, arm) at a constant score. */
function trials(taskId: string, arm: string, score: number, over: Partial<TaskRunResult> = {}): TaskRunResult[] {
  return [0, 1, 2, 3, 4].map((s) => row(taskId, arm, s, score, over));
}

describe('buildFrontierSweSuiteData', () => {
  it('rolls up per-arm mean@5/best@5 + AVG-RANK + dominance over scored rows', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6),
      ...trials('impl1', 'opus', 0.3),
      ...trials('perf1', 'hive', 0.5),
      ...trials('perf1', 'opus', 0.8),
    ];
    const sd = buildFrontierSweSuiteData(rows, {
      k: 5,
      taskBucket: { impl1: 'implementation', perf1: 'performance' },
    });
    expect(sd.k).toBe(5);
    expect(sd.taskCount).toBe(2);
    expect(sd.trialCount).toBe(20);
    expect(sd.excludedCount).toBe(0);
    const hive = sd.arms.find((a) => a.arm === 'hive')!;
    const opus = sd.arms.find((a) => a.arm === 'opus')!;
    // impl1: hive 0.6 > opus 0.3; perf1: opus 0.8 > hive 0.5 → each wins one → avgRank 1.5 both.
    expect(hive.avgRank).toBeCloseTo(1.5);
    expect(opus.avgRank).toBeCloseTo(1.5);
    expect(hive.bestAtK).toBeCloseTo((0.6 + 0.5) / 2);
    // per-bucket present
    expect(sd.perBucket.implementation).toBeDefined();
    expect(sd.perBucket.performance).toBeDefined();
    // in the implementation bucket alone, hive wins → rank 1
    expect(sd.perBucket.implementation.find((a) => a.arm === 'hive')!.avgRank).toBeCloseTo(1);
  });

  it('EXCLUDES infra non-completions (not scored 0) and surfaces the count (C6)', () => {
    const rows = [
      ...trials('impl1', 'hive', 0.6),
      row('impl1', 'hive', 5, null, { generationStatus: 'error' }), // infra → excluded
      row('impl1', 'hive', 6, null, { graderStatus: 'timeout' }), //   infra → excluded
    ];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.trialCount).toBe(5);
    expect(sd.excludedCount).toBe(2);
    // the excluded rows did NOT drag the score toward 0
    expect(sd.arms.find((a) => a.arm === 'hive')!.meanAtK).toBeCloseTo(0.6);
  });

  it('a real 0 score COUNTS (capability fail, not excluded)', () => {
    const sd = buildFrontierSweSuiteData(trials('impl1', 'opus', 0), { k: 5 });
    expect(sd.excludedCount).toBe(0);
    expect(sd.trialCount).toBe(5);
    expect(sd.arms.find((a) => a.arm === 'opus')!.bestAtK).toBe(0);
  });

  it('ignores non-frontier-swe rows', () => {
    const rows = [...trials('impl1', 'hive', 0.6), row('x', 'hive', 0, 0.9, { suite: 'gdpval' } as Partial<TaskRunResult>)];
    const sd = buildFrontierSweSuiteData(rows, { k: 5 });
    expect(sd.taskCount).toBe(1);
    expect(sd.trialCount).toBe(5);
  });

  it('always carries the mandatory caveats', () => {
    const sd = buildFrontierSweSuiteData([], { k: 5 });
    expect(sd.caveats).toEqual(FRONTIER_SWE_CAVEATS);
    expect(sd.caveats.length).toBe(3);
    expect(sd.arms).toEqual([]);
  });
});
