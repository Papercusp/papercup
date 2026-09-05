import { describe, expect, it } from 'vitest';
import { compareOptimizers, validateMatchedOptimizerComparison, type MatchedOptimizerPins, type OptimizerRun, type OptimizerTaskSplits } from './optimizer-comparison';

const pins: MatchedOptimizerPins = {
  taskHash: 'tasks-v1', modelHash: 'model-v1', promptHash: 'prompt-v1', rubricHash: 'rubric-v1', codeHash: 'code-v1', evaluatorHash: 'eval-v1',
  randomizationSeed: 'seed-7', repeats: 2, budgetUsd: 9, exposure: { population: 'pot:blender', percentage: 100 },
};
const splits: OptimizerTaskSplits = {
  development: ['dev-1'], 'sealed-acceptance': ['holdout-1', 'holdout-2'], 'fresh-monitoring': ['fresh-1'],
};
const run = (method: OptimizerRun['method'], quality: number[], uncertainty: number[] = [0, 0], regression: 'pass' | 'fail' | 'not-measured' = 'pass', costUsd = 3): OptimizerRun => ({
  method, ...pins, totalCostUsd: costUsd,
  scores: [
    { taskId: 'dev-1', split: 'development', quality: quality[0]!, uncertainty: uncertainty[0]!, regression, costUsd: costUsd / 4 },
    { taskId: 'holdout-1', split: 'sealed-acceptance', quality: quality[1]!, uncertainty: uncertainty[1]!, regression, costUsd: costUsd / 4 },
    { taskId: 'holdout-2', split: 'sealed-acceptance', quality: quality[1]!, uncertainty: uncertainty[1]!, regression, costUsd: costUsd / 4 },
    { taskId: 'fresh-1', split: 'fresh-monitoring', quality: quality[0]!, uncertainty: uncertainty[0]!, regression, costUsd: costUsd / 4 },
  ],
});

describe('P-010 matched optimizer comparison', () => {
  it('requires all three methods and exact task split coverage', () => {
    const result = validateMatchedOptimizerComparison({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5]), run('gepa', [0.6, 0.6])] });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('exactly 3 optimizer runs are required');
    expect(result.errors).toContain('missing optimizer run: trace-reflection');
  });

  it('rejects a model or budget mismatch before ranking', () => {
    const mismatched = { ...run('gepa', [0.8, 0.8]), modelHash: 'different-model', budgetUsd: 8 };
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5]), run('trace-reflection', [0.6, 0.6]), mismatched] });
    expect(result.verdict).toBe('invalid');
    expect(result.errors).toEqual(expect.arrayContaining(['runs[2].modelHash does not match pins.modelHash', 'runs[2].budgetUsd does not match pins.budgetUsd']));
  });

  it('selects a challenger only when its uncertainty-adjusted holdout quality clears Gym', () => {
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.60], [0.02, 0.03]), run('trace-reflection', [0.6, 0.61], [0.02, 0.03]), run('gepa', [0.7, 0.70], [0.01, 0.01], 'pass', 4)] });
    expect(result.verdict).toBe('selected');
    expect(result.selected).toBe('gepa');
    expect(result.summaries.find((s) => s.method === 'gepa')?.qualityLowerBound).toBeCloseTo(0.69);
  });

  it('treats a measured regression as ineligible even when quality rises', () => {
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5]), run('trace-reflection', [0.7, 0.9], [0, 0], 'fail'), run('gepa', [0.5, 0.5])] });
    expect(result.selected).toBeNull();
    expect(result.verdict).toBe('baseline-holds');
    expect(result.summaries.find((s) => s.method === 'trace-reflection')?.exclusionReasons).toContain('sealed-acceptance regression measured');
  });

  it('keeps an unmeasured regression or uncertainty as a gap, never a pass', () => {
    const unknownRegression = run('trace-reflection', [0.8, 0.8], [0, 0], 'not-measured');
    const unknownUncertainty = run('gepa', [0.8, 0.8], [null as unknown as number, null as unknown as number]);
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5]), unknownRegression, unknownUncertainty] });
    expect(result.selected).toBeNull();
    expect(result.verdict).toBe('inconclusive');
    expect(result.summaries.find((s) => s.method === 'trace-reflection')?.regression).toBe('not-measured');
    expect(result.summaries.find((s) => s.method === 'gepa')?.uncertaintyMean).toBeNull();
  });

  it('uses actual cost as the deterministic tie-break between equally good methods', () => {
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5], [0, 0], 'pass', 3), run('trace-reflection', [0.7, 0.7], [0, 0], 'pass', 5), run('gepa', [0.7, 0.7], [0, 0], 'pass', 4)] });
    expect(result.selected).toBe('gepa');
    expect(result.summaries.find((s) => s.method === 'trace-reflection')?.costRatioVsGym).toBeCloseTo(5 / 3);
  });

  it('supports an explicit cost-ratio cap', () => {
    const result = compareOptimizers({ pins, taskSplits: splits, thresholds: { maxCostRatio: 1.1 }, runs: [run('gym', [0.5, 0.5], [0, 0], 'pass', 3), run('trace-reflection', [0.8, 0.8], [0, 0], 'pass', 5), run('gepa', [0.6, 0.6], [0, 0], 'pass', 3)] });
    expect(result.selected).toBe('gepa');
    expect(result.summaries.find((s) => s.method === 'trace-reflection')?.exclusionReasons).toEqual(expect.arrayContaining([expect.stringContaining('cost ratio')]));
  });

  it('returns inconclusive when Gym has no complete uncertainty or regression evidence', () => {
    const result = compareOptimizers({ pins, taskSplits: splits, runs: [run('gym', [0.5, 0.5], [null as unknown as number, null as unknown as number], 'not-measured'), run('trace-reflection', [0.8, 0.8]), run('gepa', [0.8, 0.8])] });
    expect(result.verdict).toBe('inconclusive');
    expect(result.selected).toBeNull();
  });
});
