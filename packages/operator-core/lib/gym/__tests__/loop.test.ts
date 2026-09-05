import { describe, it, expect } from 'vitest';
import { createCandidateVersionVerdict, runOptimizationLoop, type LoopConfig, type LoopDeps, type LoopProposalRecord } from '../loop';
import type { VariantEval } from '../gate-engine';
import type { CandidateProposal } from '../proposer';
import { LlmCallError } from '@papercusp/testing-shell/llm';
import type { TurnError } from '../../agent-chat-stream';

const rateLimited = (resetAt?: number): LlmCallError =>
  new LlmCallError({ class: 'rate_limited', message: '429', provider: 'anthropic', retryable: true, ...(resetAt !== undefined ? { resetAt } : {}) } as TurnError);

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

/**
 * P-003: a deterministic guardrail that WAS collected and passed. These suites are about
 * loop orchestration, so every variant is fully instrumented — the not-measured paths are
 * covered in gates.test.ts and loop-deps.test.ts.
 */
const MEASURED_PASS = {
  status: 'pass' as const,
  coverage: { measured: 1, required: 1, unmeasuredTaskIds: [] },
  artifacts: ['trace://t1'],
};

function evalOf(id: string, agg: number): VariantEval {
  return { variantId: id, trainAgg: agg, trainVector: [agg], devAnchorAgg: agg, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS };
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
      return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
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

  it('charges proposer spend before a successful evaluation is settled', async () => {
    const { d } = baseDeps({
      async propose() {
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0.25 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    // baseline evaluation ($1) + proposer ($0.25) + candidate evaluation ($1).
    expect(res.spentUsd).toBeCloseTo(2.25, 6);
  });

  it('charges a proposer error that reports burned provider spend', async () => {
    const { d } = baseDeps({
      async propose() {
        throw Object.assign(new Error('proposer failed after dispatch'), { costUsd: 0.35 });
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(1);
    expect(res.spentUsd).toBeCloseTo(1.35, 6);
  });

  it('charges partial evaluator spend when the candidate evaluation throws', async () => {
    const { d } = baseDeps({
      async propose() {
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0.25 };
      },
      async evaluate(variantId) {
        if (variantId !== 'baseline') {
          throw Object.assign(new Error('evaluation failed part-way through'), { costUsd: 0.75 });
        }
        return { evalResult: evalOf(variantId, 7.0), worstTraces: [], costUsd: 1.0 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(1);
    // baseline ($1) + proposer ($0.25) + partial evaluation ($0.75).
    expect(res.spentUsd).toBeCloseTo(2.0, 6);
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

  it('records each candidate as a proposal (gym UI seam); autoPromote:false skips the harness write', async () => {
    const recorded: LoopProposalRecord[] = [];
    const { d, calls } = baseDeps({ recordProposal: async (r) => { recorded.push(r); } });
    const res = await runOptimizationLoop({ ...config, autoPromote: false }, d);
    expect(recorded).toHaveLength(res.cycles); // one record per cycle
    expect(recorded[0].candidateId).toBe('cand-1');
    expect(recorded[0].overlay.promptOverrides.worker).toBe('improved');
    expect(recorded[0].parentOverlay).toBeDefined();
    expect(recorded[0].verdict).toBe('accept'); // improving candidates accept
    expect(recorded[0].candidateVersion.verdict).toBe('accept');
    expect(recorded[0].candidateVersion.gateResults).toHaveLength(5);
    expect(recorded[0].candidateVersion.hashes.variantHash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof recorded[0].devAnchorDelta).toBe('number');
    expect(calls).not.toContain('promote'); // human-gated: no external harness write
    expect(res.championId).toBe('cand-3'); // internal champion still advances
  });

  it('builds a reject verdict when any gate fails, regardless of dev-anchor movement', () => {
    const verdict = createCandidateVersionVerdict({
      candidateId: 'cand-1',
      parentId: 'baseline',
      variant: { promptOverrides: { worker: 'candidate' } },
      parent: { promptOverrides: {} },
      gateResults: [{ gate: 'no-new-regressions', pass: false, status: 'fail' as const, detail: 'regression' }],
      recordedAt: 1,
      provenance: { evaluatorHash: 'e', rubricHash: 'r', taskHash: 't', codeHash: 'c' },
    });
    expect(verdict.verdict).toBe('reject');
    expect(verdict.hashes).toEqual({
      variantHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      parentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      evaluatorHash: 'e',
      rubricHash: 'r',
      taskHash: 't',
      codeHash: 'c',
    });
  });

  it('still auto-promotes by default (autoPromote undefined) + records when the dep is present', async () => {
    const recorded: LoopProposalRecord[] = [];
    const { d, calls } = baseDeps({ recordProposal: async (r) => { recorded.push(r); } });
    const res = await runOptimizationLoop(config, d);
    expect(recorded).toHaveLength(res.cycles);
    expect(calls.filter((c) => c === 'promote').length).toBeGreaterThanOrEqual(1);
  });

  // RB-006 — a rate-limited (or otherwise failed) propose/evaluate must SKIP the cycle, never
  // crash the loop or lose the progress accrued so far.
  it('skips a cycle whose propose is rate-limited (far reset) and keeps going', async () => {
    let proposeN = 0;
    const { d } = baseDeps({
      now: () => 0, // so resetAt=1e9ms reads as ~11 days out (> maxPause) → skip, not retry
      sleep: async () => {},
      async propose() {
        proposeN++;
        if (proposeN === 2) throw rateLimited(1_000_000_000); // far reset → no pause, skip cycle 2
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
      },
    });
    const res = await runOptimizationLoop(config, d); // maxCycles 3
    expect(res.skipped).toBe(1);
    expect(res.cycles).toBe(3); // loop did NOT abort
    expect(res.accepts).toBe(2); // cycles 1 + 3 (cycle 2 skipped)
  });

  it('PAUSES+RESUMES a near-reset rate-limited evaluate (injected clock), no skip', async () => {
    let clock = 0;
    let candEvalN = 0;
    const { d } = baseDeps({
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      async evaluate(variantId) {
        if (variantId !== 'baseline') {
          candEvalN++;
          if (candEvalN === 1) throw rateLimited(5000); // first candidate eval 429s; retry succeeds
        }
        return { evalResult: evalOf(variantId, variantId === 'baseline' ? 7.0 : 7.5), worstTraces: [], costUsd: 1.0 };
      },
    });
    const res = await runOptimizationLoop({ ...config, maxCycles: 1 }, d);
    expect(res.skipped).toBe(0);
    expect(clock).toBe(5000); // waited out the reset
    expect(res.cycles).toBe(1);
  });

  it('skips a cycle on a NON-rate propose error (never crashes)', async () => {
    let proposeN = 0;
    const { d } = baseDeps({
      async propose() {
        proposeN++;
        if (proposeN === 1) throw new Error('proposer boom');
        return { overlay: { promptOverrides: { worker: 'improved' } }, rationale: 'better', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal;
      },
    });
    const res = await runOptimizationLoop(config, d);
    expect(res.skipped).toBe(1);
    expect(res.cycles).toBe(3);
    // WI-5674: the swallowed reason is now CAPTURED (not discarded) so the silent-skip
    // failure mode is diagnosable from the run report.
    expect(res.skipReasons).toHaveLength(1);
    expect(res.skipReasons[0]).toContain('proposer boom');
    expect(res.skipReasons[0]).toContain('cycle 1');
  });

  // P-011 (D-008) — quality-diversity parent selection. The novelty signal is only
  // consulted when config.qualityDiversity is set, and when it is, it can steer the
  // pick toward an under-explored (novel) frontier member instead of pure headroom.
  it('does NOT consult noveltyForVariant when qualityDiversity is absent (default path unchanged)', async () => {
    let called = false;
    const { d } = baseDeps({ async noveltyForVariant() { called = true; return 0.9; } });
    await runOptimizationLoop(config, d); // no qualityDiversity ⇒ legacy fitness-only selection
    expect(called).toBe(false);
  });

  it('quality-diversity selects the NOVEL frontier parent where fitness-only selects the under-served one', async () => {
    // Build a 2-member frontier: baseline (trainVector [7,7]) + cand-1 ([9,5]) trade
    // off, so neither Pareto-dominates → both persist on the frontier. baseline has
    // the lower trainAgg (what selectParent picks); cand-1 is flagged the novel one.
    function runWith(qd: LoopConfig['qualityDiversity']): Promise<string[]> {
      const parents: string[] = [];
      const d: LoopDeps = {
        baseline: { variantId: 'baseline', overlay: { promptOverrides: {} } },
        async evaluate(variantId) {
          if (variantId === 'baseline') {
            return { evalResult: { variantId, trainAgg: 7.0, trainVector: [7, 7], devAnchorAgg: 7.0, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS }, worstTraces: [], costUsd: 1.0 };
          }
          // higher trainAgg (clears the improvement gate) but a trade-off vector so it
          // does not dominate baseline → the frontier keeps both members.
          return { evalResult: { variantId, trainAgg: 7.5, trainVector: [9, 5], devAnchorAgg: 7.2, meanCost: 1.0, regressionEvidence: MEASURED_PASS, probeEvidence: MEASURED_PASS }, worstTraces: [], costUsd: 1.0 };
        },
        async propose() { return { overlay: { promptOverrides: { worker: 'v' } }, rationale: 'x', diffFromParent: 'worker', costUsd: 0 } as CandidateProposal; },
        async promote() {},
        async revert() {},
        async persistCycle(rec) { parents.push(rec.parentId); },
        newVariantId: (cycle) => `cand-${cycle}`,
        // baseline = under-served (low trainAgg); cand-1 = the novel/sparse member.
        async noveltyForVariant(variantId) { return variantId === 'baseline' ? 0.0 : 1.0; },
      };
      return runOptimizationLoop({ ...config, maxCycles: 2, qualityDiversity: qd }, d).then(() => parents);
    }
    // Cycle 1 parent is always baseline (sole frontier member); cycle 2 selects over
    // the 2-member frontier [baseline, cand-1].
    const qdParents = await runWith({ noveltyWeight: 1.0 });
    expect(qdParents[1]).toBe('cand-1'); // pure novelty → the sparse member
    const fitnessParents = await runWith(undefined);
    expect(fitnessParents[1]).toBe('baseline'); // fitness-only → the under-served member
  });
});
