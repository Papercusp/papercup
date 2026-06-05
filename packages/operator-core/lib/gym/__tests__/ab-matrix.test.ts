import { describe, it, expect } from 'vitest';
import {
  expandAbMatrix,
  abCellId,
  aggregateAbMatrix,
  compareVariantsFromOutcomes,
  type AbCellOutcome,
} from '../ab-matrix';

/**
 * P-013 — the A/B eval-matrix as a runtime DAG + the pure comparison/aggregation
 * primitive. The genuinely-new piece of the gym blueprint port.
 */

const DERIVE = { sigmaMultiple: 2, targetStandardError: 0.25 };

describe('expandAbMatrix (matrix → Level-2 DAG)', () => {
  it('produces variants × tasks × repeats independent cell nodes', () => {
    const dag = expandAbMatrix({ variantIds: ['A', 'B'], taskIds: ['t1', 't2', 't3'], repeats: 2 });
    expect(dag.size).toBe(2 * 3 * 2);
    expect(dag.cells).toHaveLength(12);
    // every cell is independent (wave 0 — fully parallel)
    expect(dag.cells.every((c) => c.dependsOn.length === 0)).toBe(true);
    // deterministic ids matching the live runner's newRunId (`v::t::rN`)
    expect(dag.cells[0].id).toBe(abCellId('A', 't1', 0));
    expect(new Set(dag.cells.map((c) => c.id)).size).toBe(12); // all unique
  });

  it('the aggregate node depends on EVERY cell (wave 1)', () => {
    const dag = expandAbMatrix({ variantIds: ['A', 'B'], taskIds: ['t1'], repeats: 1 });
    expect(dag.aggregate.dependsOn).toHaveLength(dag.cells.length);
    expect([...dag.aggregate.dependsOn].sort()).toEqual(dag.cells.map((c) => c.id).sort());
    // two dependency waves: all cells, then the aggregate
    expect(dag.waves).toEqual([dag.cells.map((c) => c.id), ['aggregate']]);
  });

  it('rejects a non-positive repeat count', () => {
    expect(() => expandAbMatrix({ variantIds: ['A'], taskIds: ['t1'], repeats: 0 })).toThrow(/repeats/);
  });

  it('an empty matrix still yields a (degenerate) aggregate wave', () => {
    const dag = expandAbMatrix({ variantIds: [], taskIds: [], repeats: 1 });
    expect(dag.size).toBe(0);
    expect(dag.waves).toEqual([['aggregate']]);
  });
});

describe('compareVariantsFromOutcomes (mean-based A-vs-B)', () => {
  const oc = (variantId: string, taskId: string, repeat: number, composite: number, status?: AbCellOutcome['status']): AbCellOutcome => ({
    variantId, taskId, repeat, composite, pipelineUsd: 1, judgeUsd: 0.1, status,
  });

  it('uses the MEAN composite per (variant, task) and signs delta B − A', () => {
    const outcomes = [
      oc('A', 't1', 0, 6), oc('A', 't1', 1, 8), // A mean = 7
      oc('B', 't1', 0, 9), oc('B', 't1', 1, 9), // B mean = 9
    ];
    const cmp = compareVariantsFromOutcomes(outcomes, 'A', 'B');
    expect(cmp).toEqual([{ taskId: 't1', aComposite: 7, bComposite: 9, delta: 2 }]);
  });

  it('nulls the side a variant did not evaluate', () => {
    const cmp = compareVariantsFromOutcomes([oc('A', 't1', 0, 5)], 'A', 'B');
    expect(cmp).toEqual([{ taskId: 't1', aComposite: 5, bComposite: null, delta: null }]);
  });

  it('excludes non-scored (rate-limited / errored) cells from the mean', () => {
    const outcomes = [
      oc('A', 't1', 0, 10),
      oc('A', 't1', 1, 0, 'errored'), // excluded — would drag the mean to 5 if counted
      oc('B', 't1', 0, 4),
    ];
    const cmp = compareVariantsFromOutcomes(outcomes, 'A', 'B');
    expect(cmp[0].aComposite).toBe(10); // not 5
    expect(cmp[0].delta).toBe(-6);
  });
});

describe('aggregateAbMatrix (the AGGREGATE node body)', () => {
  const oc = (variantId: string, taskId: string, repeat: number, composite: number, pipelineUsd = 1, judgeUsd = 0.1, status?: AbCellOutcome['status']): AbCellOutcome => ({
    variantId, taskId, repeat, composite, pipelineUsd, judgeUsd, status,
  });

  it('folds cells into per-task variance, cost, and comparison', () => {
    const outcomes = [
      oc('A', 't1', 0, 6), oc('A', 't1', 1, 8),
      oc('B', 't1', 0, 9), oc('B', 't1', 1, 7),
    ];
    const res = aggregateAbMatrix(outcomes, { deriveOpts: DERIVE });
    expect(res.scoredCells).toBe(4);
    expect(res.excludedCells).toBe(0);
    // per-(variant,task) variance entries (A,t1) + (B,t1)
    expect(res.perTaskVariance).toHaveLength(2);
    const aVar = res.perTaskVariance.find((v) => v.variantId === 'A')!;
    expect(aVar.mean).toBe(7);
    expect(aVar.n).toBe(2);
    // cost = 4 cells × (1 + 0.1)
    expect(res.cost.totalUsd).toBeCloseTo(4.4, 5);
    expect(res.cost.perVariant.A).toBeCloseTo(2.2, 5);
    // comparison: A mean 7 vs B mean 8 → delta +1
    expect(res.comparison).toEqual([{ taskId: 't1', aComposite: 7, bComposite: 8, delta: 1 }]);
  });

  it('counts an excluded cell in cost but not in variance/comparison', () => {
    const outcomes = [
      oc('A', 't1', 0, 8),
      oc('A', 't1', 1, 0, 2, 0, 'rate_limited'), // pipeline cost 2 still counts
      oc('B', 't1', 0, 5),
    ];
    const res = aggregateAbMatrix(outcomes, { deriveOpts: DERIVE });
    expect(res.scoredCells).toBe(2);
    expect(res.excludedCells).toBe(1);
    const aVar = res.perTaskVariance.find((v) => v.variantId === 'A')!;
    expect(aVar.mean).toBe(8); // not (8+0)/2
    expect(aVar.n).toBe(1);
    // cost includes the excluded cell's pipeline spend: (1+0.1) + (2+0) + (1+0.1)
    expect(res.cost.totalUsd).toBeCloseTo(4.2, 5);
  });

  it('defaults A/B to the first two distinct variants seen', () => {
    const res = aggregateAbMatrix([oc('base', 't1', 0, 5), oc('cand', 't1', 0, 8)], { deriveOpts: DERIVE });
    expect(res.comparison).toEqual([{ taskId: 't1', aComposite: 5, bComposite: 8, delta: 3 }]);
  });
});
