import { describe, it, expect } from 'vitest';
import { runTotalUsd, cycleCostUsd, meanRunCostUsd, estimateConvergence } from '../cost';

/**
 * Cost instrumentation (P-027, D-017). Deterministic $/run, $/cycle, and a
 * $/converged-run estimate — a required P-014 deliverable BEFORE the loop runs,
 * because the economics are non-trivial. Pure aggregation; per-run token→cost comes
 * from agent_runs_consolidated (the PG read is the integration layer).
 */
describe('runTotalUsd', () => {
  it('sums pipeline + judge cost for one run', () => {
    expect(runTotalUsd({ pipelineUsd: 1.2, judgeUsd: 0.5 })).toBeCloseTo(1.7, 6);
  });
});

describe('cycleCostUsd', () => {
  it('sums all run costs in a cycle plus the proposer cost', () => {
    const runs = [{ pipelineUsd: 1, judgeUsd: 0.5 }, { pipelineUsd: 2, judgeUsd: 0.5 }];
    expect(cycleCostUsd(runs, 0.1)).toBeCloseTo(4.1, 6);
  });
});

describe('meanRunCostUsd', () => {
  it('averages total run cost', () => {
    expect(meanRunCostUsd([{ pipelineUsd: 1, judgeUsd: 0 }, { pipelineUsd: 3, judgeUsd: 0 }])).toBeCloseTo(2, 6);
  });
  it('is 0 for no runs', () => {
    expect(meanRunCostUsd([])).toBe(0);
  });
});

describe('estimateConvergence', () => {
  it('derives expected cycles per accept and $/converged-run from the accept rate', () => {
    const e = estimateConvergence(10, 0.25);
    expect(e.expectedCyclesPerAccept).toBeCloseTo(4, 6);
    expect(e.costPerConvergedRun).toBeCloseTo(40, 6);
  });
  it('reports an unbounded estimate when nothing is accepted', () => {
    expect(estimateConvergence(10, 0).expectedCyclesPerAccept).toBe(Infinity);
    expect(estimateConvergence(10, 0).costPerConvergedRun).toBe(Infinity);
  });
});
