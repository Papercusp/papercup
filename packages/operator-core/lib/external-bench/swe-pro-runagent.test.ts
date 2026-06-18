import { describe, it, expect, vi } from 'vitest';
import { makeSweProRunAgent, type SweProSpawn } from './swe-pro-runagent';
import type { ArmAttempt, BenchTask, TaskCheckout } from './types';
import type { RunAgentInput } from './run-topology';

function task(id = 'inst-1'): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: 'fix it', repo: 'o/r', baseCommit: 'a'.repeat(40), graderMeta: {} } as BenchTask;
}
function handle(): TaskCheckout {
  return { dir: '/tmp/wt', repo: 'o/r', baseCommit: 'a'.repeat(40), cleanup: async () => {} };
}
function input(over: Partial<RunAgentInput<TaskCheckout>> = {}): RunAgentInput<TaskCheckout> {
  return {
    task: task(),
    handle: handle(),
    role: 'worker',
    arm: 'dist-broadcast',
    teamKey: 'team-1',
    topic: 'bench:dist-broadcast:team-1',
    directive: 'Coordinate via coord:send; broadcast findings to your team topic.',
    forbidTools: [],
    attemptBudget: { maxModelCalls: 40, maxCostUsd: 5, maxTokens: 2_000_000 },
    ...over,
  };
}
function attempt(over: Partial<ArmAttempt> = {}): ArmAttempt {
  return {
    arm: 'dist-broadcast', blueprintId: 'coding-solo', instanceId: 'inst-1', seed: 's',
    diff: 'diff --git a/x b/x', tokensIn: 1000, tokensOut: 500, costUsd: 0.42, turns: 7,
    wallClockMs: 1234, trajectoryRef: 'ref', stopReason: 'done',
    ...over,
  } as ArmAttempt;
}

describe('makeSweProRunAgent', () => {
  it('maps a completed spawn → submission(diff) + usage + coordCalls (C4 evidence)', async () => {
    const spawn: SweProSpawn = async () => ({ ...attempt(), modelCalls: 35, coordCalls: 12 });
    const out = await makeSweProRunAgent({ spawn })(input());
    expect(out).toMatchObject({
      submission: 'diff --git a/x b/x',
      status: 'completed',
      modelCalls: 35,
      tokensIn: 1000,
      tokensOut: 500,
      costUsd: 0.42,
      turns: 7,
      coordCalls: 12, // surfaced for the fairness audit's C4 check
      error: null,
    });
  });

  it('passes the worktree handle + directive + budget through to the spawn', async () => {
    const spawn = vi.fn<SweProSpawn>(async () => ({ ...attempt() }));
    const h = handle();
    await makeSweProRunAgent({ spawn })(input({ handle: h, directive: 'DIR-X', forbidTools: ['coord:send'] }));
    const arg = spawn.mock.calls[0][0];
    expect(arg.handle).toBe(h); // the EXISTING worktree, not a re-clone
    expect(arg.directive).toBe('DIR-X');
    expect(arg.forbidTools).toEqual(['coord:send']);
    expect(arg.seedPrefix).toBe('dist-broadcast-inst-1');
    expect(arg.budget).toEqual({ maxUsd: 5, maxTokens: 2_000_000 }); // IsoBudget → GenerationBudget
  });

  it('falls back to turns when the binding cannot separate modelCalls', async () => {
    const spawn: SweProSpawn = async () => ({ ...attempt({ turns: 9 }) }); // no modelCalls field
    expect((await makeSweProRunAgent({ spawn })(input())).modelCalls).toBe(9);
  });

  it('an error stopReason → status error; a budget-exhausted attempt → capped', async () => {
    const errOut = await makeSweProRunAgent({ spawn: async () => ({ ...attempt({ stopReason: 'error', generationError: 'spawn died' }) }) })(input());
    expect(errOut.status).toBe('error');
    expect(errOut.error).toBe('spawn died');
    const capOut = await makeSweProRunAgent({ spawn: async () => ({ ...attempt({ stopReason: 'budget-exhausted' }) }) })(input());
    expect(capOut.capped).toBe(true);
  });

  it('NEVER throws — a spawn crash becomes an infra row (status error, empty submission, coordCalls 0)', async () => {
    const out = await makeSweProRunAgent({ spawn: async () => { throw new Error('docker exploded'); } })(input());
    expect(out).toMatchObject({ submission: '', status: 'error', coordCalls: 0, error: 'docker exploded' });
  });

  it('requires a spawn seam', () => {
    expect(() => makeSweProRunAgent({})).toThrow(/spawn seam is required/);
  });
});
