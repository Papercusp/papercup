import { describe, it, expect } from 'vitest';
import { runOptimizationLoop, type LoopConfig, type LoopDeps } from '../loop';
import type { VariantEval } from '../gate-engine';
import type { CandidateProposal } from '../proposer';

/**
 * Continuous loop driver (P-022): select parent → propose → evaluate → gate →
 * accept(frontier+champion+promote) / reject → changelog → circuit-breaker → repeat,
 * budget/cycle-capped, unattended. All effects injected.
 */
const config: LoopConfig = {
  thresholds: { epsilon: 0.2, delta: 0.3, costCeiling: 2.0 },
  baselineMeanCost: 1.0,
  baselineOfRecord: 7.0,
  dropThreshold: 0.5,
  maxCycles: 3,
  budgetUsd: null,
  proposerModel: 'claude-sonnet-4-6',
};

function evalOf(id: string, agg: number): VariantEval {
  return { variantId: id, trainAgg: agg, trainVector: [agg], devAnchorAgg: agg, meanCost: 1.0, anyNewRegression: false, allProbesCaught: true };
}

function baseDeps(over: Partial<LoopDeps> = {}): { d: LoopDeps; calls: string[] } {
  const calls: string[] = [];
  let agg = 7.0;
  const d: LoopDeps = {
    baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
    async evaluate(variantId) {
      calls.push(`eval:${variantId}`);
      // each evaluated candidate is strictly better than the last
      if (variantId !== 'baseline') agg += 0.5;
      return { evalResult: evalOf(variantId, variantId === 'baseline' ? 7.0 : agg), worstTraces: [], costUsd: 1.0 };
    },
    async propose() {
      calls.push('propose');
      return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker' } as CandidateProposal;
    },
    async promote() { calls.push('promote'); },
    async revert() { calls.push('revert'); },
    async persistCycle() { calls.push('persist'); },
    newVariantId: (cycle) => `cand-${cycle}`,
    ...over,
  };
  return { d, calls };
}

describe('runOptimizationLoop', () => {
  it('runs maxCycles, accepts improving candidates, and promotes the champion', async () => {
    const { d, calls } = baseDeps();
    const res = await runOptimizationLoop(config, d);
    expect(res.cycles).toBe(3);
    expect(res.accepts).toBe(3);
    expect(res.championId).toBe('cand-3'); // last + best
    expect(calls.filter((c) => c === 'promote').length).toBeGreaterThanOrEqual(1);
    expect(calls).toContain('eval:baseline');
  });

  it('stops when the budget is exhausted', async () => {
    const { d } = baseDeps();
    const res = await runOptimizationLoop({ ...config, budgetUsd: 2.0, maxCycles: 99 }, d);
    // baseline eval (1.0) + ~1 candidate cycle (1.0) ≈ budget 2.0
    expect(res.cycles).toBeLessThanOrEqual(2);
    expect(res.spentUsd).toBeGreaterThanOrEqual(2.0);
  });

  it('trips the circuit-breaker and reverts when the champion drifts below baseline-of-record', async () => {
    // baselineOfRecord 9.0 (well above the champion's ~7.5 dev-anchor) ⇒ champion
    // sits below baseline − drop ⇒ breaker trips + reverts after cycle 1.
    const { d, calls } = baseDeps();
    const res = await runOptimizationLoop({ ...config, baselineOfRecord: 9.0, dropThreshold: 0.5 }, d);
    expect(res.breakerTripped).toBe(true);
    expect(calls).toContain('revert');
    expect(res.cycles).toBeLessThan(3); // stopped early
  });
});
