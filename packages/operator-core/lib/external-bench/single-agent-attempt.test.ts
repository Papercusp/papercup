/**
 * Unit tests for Port 2 (`runSingleAgentAttempt`, P-006 / BRIEF 4) — driven entirely through
 * injected fake ports (hive-eval live-ports pattern), so the wiring + the fairness invariants
 * are verified without a real clone / harness / git.
 */
import { describe, it, expect, vi } from 'vitest';
import type {
  BenchHarnessRun,
  BenchTask,
  GenerationBudget,
  GenerationPorts,
  GenerationStopReason,
  GenerationTelemetry,
  TaskCheckout,
} from './types';
import {
  runSingleAgentAttempt,
  BASELINE_A_ARM,
  SINGLE_AGENT_BLUEPRINT,
} from './single-agent-attempt';

const TASK: BenchTask = {
  benchmark: 'swe-bench-pro',
  instanceId: 'instance_astropy__astropy-12345',
  problemStatement: 'Fix the off-by-one in the WCS transform.',
  repo: 'astropy/astropy',
  baseCommit: 'abc1234',
  graderMeta: { dockerhub_tag: 'astropy-12345', FAIL_TO_PASS: ['t1'], PASS_TO_PASS: ['t2'] },
};

const BUDGET: GenerationBudget = { maxTokens: 200_000 };

function telemetry(over: Partial<GenerationTelemetry> = {}): GenerationTelemetry {
  return {
    tokensIn: 1000,
    tokensOut: 500,
    costUsd: 0.042,
    turns: 7,
    wallClockMs: 12_345,
    trajectoryRef: 'rollout://traj/abc',
    stopReason: 'done',
    ...over,
  };
}

/** Build a fake port set; records clone/cleanup/instantiate/extract calls for assertions. */
function fakePorts(opts: {
  telemetry?: GenerationTelemetry;
  diff?: string;
  cloneThrows?: Error;
  instantiateThrows?: Error;
  extractThrows?: Error;
} = {}) {
  const cleanup = vi.fn(async () => {});
  const checkout: TaskCheckout = {
    dir: '/scratch/astropy',
    repo: TASK.repo!,
    baseCommit: TASK.baseCommit!,
    cleanup,
  };
  const clone = vi.fn(async (_task: BenchTask): Promise<TaskCheckout> => {
    if (opts.cloneThrows) throw opts.cloneThrows;
    return checkout;
  });
  const instantiate = vi.fn(
    async (
      _blueprintId: string,
      _task: BenchTask,
      _checkout: TaskCheckout,
      _budget: GenerationBudget,
    ): Promise<BenchHarnessRun> => {
      if (opts.instantiateThrows) throw opts.instantiateThrows;
      return { worktreePath: checkout.dir, telemetry: opts.telemetry ?? telemetry() };
    },
  );
  const extractDiff = vi.fn(async (_checkout: TaskCheckout, _task: BenchTask): Promise<string> => {
    if (opts.extractThrows) throw opts.extractThrows;
    return opts.diff ?? 'diff --git a/x b/x\n+fix';
  });
  const ports: GenerationPorts = { clone, extractDiff, instantiate };
  return { ports, clone, instantiate, extractDiff, cleanup, checkout };
}

describe('runSingleAgentAttempt — the shared single-agent generation unit', () => {
  it('happy path: clones, runs coding-solo to DONE, extracts the diff, maps telemetry', async () => {
    const { ports, clone, instantiate, extractDiff, cleanup } = fakePorts({
      diff: 'diff --git a/wcs.py b/wcs.py\n+correct',
    });

    const attempt = await runSingleAgentAttempt(TASK, 'seed-1', BUDGET, ports);

    // identity — the fairness-critical fields
    expect(attempt.arm).toBe(BASELINE_A_ARM); // 'baseline-a-ablation'
    expect(attempt.blueprintId).toBe(SINGLE_AGENT_BLUEPRINT); // 'coding-solo' — spine OFF, always
    expect(attempt.instanceId).toBe(TASK.instanceId);
    expect(attempt.seed).toBe('seed-1');

    // submission + telemetry passthrough
    expect(attempt.diff).toBe('diff --git a/wcs.py b/wcs.py\n+correct');
    expect(attempt.tokensIn).toBe(1000);
    expect(attempt.tokensOut).toBe(500);
    expect(attempt.costUsd).toBe(0.042);
    expect(attempt.turns).toBe(7);
    expect(attempt.wallClockMs).toBe(12_345);
    expect(attempt.trajectoryRef).toBe('rollout://traj/abc');
    expect(attempt.stopReason).toBe('done');
    expect(attempt.generationError).toBeUndefined();

    // the worker is ALWAYS instantiated as coding-solo, with the task + budget threaded through
    expect(clone).toHaveBeenCalledWith(TASK);
    expect(instantiate).toHaveBeenCalledWith(SINGLE_AGENT_BLUEPRINT, TASK, expect.anything(), BUDGET);
    expect(extractDiff).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1); // scratch checkout always cleaned up
  });

  it('lets the caller (Baseline C) override the arm id; blueprintId stays coding-solo', async () => {
    const { ports } = fakePorts();
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports, { arm: 'baseline-c-bestofn' });
    expect(attempt.arm).toBe('baseline-c-bestofn');
    expect(attempt.blueprintId).toBe(SINGLE_AGENT_BLUEPRINT); // still spine-OFF — C is "A sampled N times"
  });

  it('seed becomes the prefix discriminator (distinct seeds → distinct attempts)', async () => {
    const { ports } = fakePorts();
    const a = await runSingleAgentAttempt(TASK, 'seed-1', BUDGET, ports);
    const b = await runSingleAgentAttempt(TASK, 'seed-2', BUDGET, ports);
    expect(a.seed).toBe('seed-1');
    expect(b.seed).toBe('seed-2');
  });

  it('a partial/capped run (budget-exhausted) still submits its diff — excluded by status, not dropped', async () => {
    const { ports, extractDiff } = fakePorts({
      telemetry: telemetry({ stopReason: 'budget-exhausted', costUsd: 1.5 }),
      diff: 'diff --git a/partial b/partial\n+wip',
    });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('budget-exhausted');
    expect(attempt.diff).toBe('diff --git a/partial b/partial\n+wip'); // partial work IS the submission
    expect(attempt.costUsd).toBe(1.5); // capped runs still cost — counted honestly
    expect(extractDiff).toHaveBeenCalledTimes(1);
  });

  it('an ESCALATE run still submits whatever diff it produced', async () => {
    const { ports, extractDiff } = fakePorts({ telemetry: telemetry({ stopReason: 'escalate' }) });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('escalate');
    expect(extractDiff).toHaveBeenCalledTimes(1);
  });

  it('generation infra-error: preserves cost telemetry, skips diff extraction, surfaces generationError', async () => {
    const { ports, extractDiff } = fakePorts({
      telemetry: telemetry({ stopReason: 'error', generationError: 'agent OOM', costUsd: 0.9 }),
    });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('error');
    expect(attempt.generationError).toBe('agent OOM');
    expect(attempt.diff).toBe(''); // no trustworthy worktree → no submission
    expect(attempt.costUsd).toBe(0.9); // tokens were still spent — record them
    expect(extractDiff).not.toHaveBeenCalled();
  });

  it('clone failure → zeroed infra-error attempt (never scored as a task failure)', async () => {
    const { ports, instantiate, cleanup } = fakePorts({ cloneThrows: new Error('repo gone') });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('error');
    expect(attempt.generationError).toMatch(/clone failed: repo gone/);
    expect(attempt.diff).toBe('');
    expect(attempt.tokensIn).toBe(0);
    expect(attempt.costUsd).toBe(0); // nothing ran
    expect(instantiate).not.toHaveBeenCalled();
    expect(cleanup).not.toHaveBeenCalled(); // no checkout to clean
  });

  it('instantiate failure → infra-error attempt + the checkout is still cleaned up', async () => {
    const { ports, cleanup, extractDiff } = fakePorts({ instantiateThrows: new Error('spawn refused') });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('error');
    expect(attempt.generationError).toMatch(/instantiate failed: spawn refused/);
    expect(extractDiff).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1); // clone succeeded → must clean the scratch dir
  });

  it('diff-extraction failure after a good run: keeps telemetry, marks errored, empties the diff', async () => {
    const { ports, cleanup } = fakePorts({ extractThrows: new Error('git diff exploded') });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.stopReason).toBe('error'); // can't grade a submission we couldn't extract
    expect(attempt.generationError).toMatch(/extractDiff failed: git diff exploded/);
    expect(attempt.diff).toBe('');
    expect(attempt.tokensIn).toBe(1000); // the generation DID happen — cost is real, keep it
    expect(attempt.costUsd).toBe(0.042);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('a no-op solution (empty diff) is a valid submission, not an error', async () => {
    const { ports } = fakePorts({ diff: '' });
    const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
    expect(attempt.diff).toBe('');
    expect(attempt.stopReason).toBe('done');
    expect(attempt.generationError).toBeUndefined();
  });

  it('exercises the documented stop reasons without coercing them', async () => {
    const reasons: GenerationStopReason[] = ['done', 'escalate', 'budget-exhausted', 'max-turns'];
    for (const r of reasons) {
      const { ports } = fakePorts({ telemetry: telemetry({ stopReason: r }) });
      const attempt = await runSingleAgentAttempt(TASK, 's', BUDGET, ports);
      expect(attempt.stopReason).toBe(r);
    }
  });
});
