import { describe, it, expect } from 'vitest';
import { tau2ResultsToRows, reportTau2Comparison, type Tau2ResultsFile } from './tau2-results-report';

/** A synthetic results.json for one arm: per (task, trial) reward. */
function results(rewards: Array<{ task: string; trial: number; reward: number | null; agentCost?: number }>): Tau2ResultsFile {
  return {
    info: { max_steps: 200, agent_info: { llm: 'claude-opus-4-8' } },
    simulations: rewards.map((r) => ({
      task_id: r.task,
      trial: r.trial,
      reward_info: r.reward === null ? { reward: null } : { reward: r.reward },
      agent_cost: r.agentCost ?? 0.1,
      user_cost: 0.02,
      messages: [1, 2, 3, 4],
      termination_reason: r.reward === null ? 'too_many_errors' : 'user_stop',
    })),
  };
}

describe('tau2ResultsToRows', () => {
  it('maps reward→resolved/score, trial→seed, agent+user cost→costUsd', () => {
    const rows = tau2ResultsToRows(
      results([
        { task: 't0', trial: 0, reward: 1, agentCost: 0.2 },
        { task: 't0', trial: 1, reward: 0 },
      ]),
      'vanilla',
      { runId: 'r1' },
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ suite: 'tau2-bench', taskId: 't0', arm: 'vanilla', seed: 0, resolved: true, score: 1, generationStatus: 'completed' });
    expect(rows[0].costUsd).toBeCloseTo(0.22, 6); // 0.2 agent + 0.02 user
    expect(rows[1]).toMatchObject({ resolved: false, score: 0, graderStatus: 'failed' });
    expect(rows[0].modelId).toBe('claude-opus-4-8'); // read from info.agent_info.llm
  });

  it('normalizes a litellm-prefixed model id so the cost layer resolves it (real tau2 uses anthropic/…)', () => {
    const r: Tau2ResultsFile = {
      info: { agent_info: { llm: 'anthropic/claude-opus-4-8' } },
      simulations: [{ task_id: 't0', trial: 0, reward_info: { reward: 1 }, agent_cost: 0.1, user_cost: 0.02 }],
    };
    expect(tau2ResultsToRows(r, 'vanilla', { runId: 'r1' })[0].modelId).toBe('claude-opus-4-8');
  });

  it('maps a no-reward conversation to an infra row (resolved null, generationStatus error)', () => {
    const rows = tau2ResultsToRows(results([{ task: 't9', trial: 0, reward: null }]), '+memory', { runId: 'r1' });
    expect(rows[0]).toMatchObject({ resolved: null, score: null, generationStatus: 'error', graderStatus: 'error' });
  });
});

describe('reportTau2Comparison', () => {
  it('produces per-arm rollups, fair attribution (both metrics), a fairness audit, and markdown', () => {
    // vanilla: rewards [0.2, 0]; +memory: rewards [1, 0.8] → memory lifts both pass@1 and meanScore.
    const vanilla = results([
      { task: 't0', trial: 0, reward: 0.2 },
      { task: 't1', trial: 0, reward: 0 },
    ]);
    const memory = results([
      { task: 't0', trial: 0, reward: 1 },
      { task: 't1', trial: 0, reward: 0.8 },
    ]);
    const rep = reportTau2Comparison({ vanilla, memory, runId: 'tau2-cmp-1' });

    // rollups
    const van = rep.rollups.find((r) => r.arm === 'vanilla')!;
    const mem = rep.rollups.find((r) => r.arm === '+memory')!;
    expect(van.avgReward).toBeCloseTo(0.1, 6);
    expect(mem.avgReward).toBeCloseTo(0.9, 6);
    expect(mem.passAt1).toBeCloseTo(0.5, 6); // t0 reward 1 → resolved; t1 0.8 → not
    expect(van.passAt1).toBeCloseTo(0, 6);

    // meanScore attribution: +memory lifts the partial-credit reward
    const memScore = rep.attributionMeanScore.capabilities.find((c) => c.capability === '+memory')!;
    expect(memScore.valueDelta).toBeCloseTo(0.8, 6); // 0.9 − 0.1
    expect(memScore.unlockedTasks).toEqual(['t0', 't1']);

    // pass@1 attribution: +memory unlocked t0 (reward 1) only
    const memPass = rep.attributionPassAt1.capabilities.find((c) => c.capability === '+memory')!;
    expect(memPass.unlockedTasks).toEqual(['t0']);

    // fairness audit present + C-criteria
    expect(rep.audit.criteria.find((c) => c.id === 'C1')).toBeDefined();
    expect(rep.audit.arms).toEqual(['vanilla', '+memory']);

    // markdown surfaces the headline + attribution + audit
    expect(rep.markdown).toContain('# tau2-bench — vanilla vs +memory');
    expect(rep.markdown).toContain('avg_reward');
    expect(rep.markdown).toContain('+memory vs vanilla on tau2-bench');
    expect(rep.markdown).toContain('Fairness audit');
  });

  it('counts an infra-failed +memory conversation as false under the fair same-denominator headline', () => {
    const vanilla = results([{ task: 't0', trial: 0, reward: 1 }]);
    const memory = results([{ task: 't0', trial: 0, reward: null }]); // infra-failed
    const rep = reportTau2Comparison({ vanilla, memory, runId: 'r2' });
    const memScore = rep.attributionMeanScore.capabilities.find((c) => c.capability === '+memory')!;
    // vanilla 1.0 vs +memory infra→0 → regression on t0 (the C1/C6 fair counting)
    expect(memScore.regressedTasks).toEqual(['t0']);
    expect(memScore.capabilityCoverage.infraOnly).toBe(1);
  });
});
