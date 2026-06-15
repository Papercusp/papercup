/**
 * Unit tests for the Baseline C LIVE binding (BRIEF 6 / P-008): the visible-tests verifier
 * orchestration + the fairness-invariant-#2 structural enforcement (the verifier never sees
 * `graderMeta`) + the grade-wrapping glue. The exec itself is faked (owner-gated leaf).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  makeVisibleTestVerifier,
  makeLiveBestOfNPorts,
  toVisibleTask,
  type VisibleTask,
  type VisibleTestVerifierOps,
} from './baseline-best-of-n-live';
import type { SingleAgentAttempt } from './baseline-best-of-n';
import type { BenchTask, GradeResult, OfficialGrader, TaskCheckout } from './types';

const TASK: BenchTask = {
  benchmark: 'swe-bench-pro',
  instanceId: 'instance_x',
  problemStatement: 'Fix the bug.',
  repo: 'o/r',
  baseCommit: 'a'.repeat(40),
  graderMeta: { FAIL_TO_PASS: ['secret_test'], PASS_TO_PASS: ['existing'], test_patch: 'diff...' },
};

function attempt(over: Partial<SingleAgentAttempt> = {}): SingleAgentAttempt {
  return {
    arm: 'baseline-a-ablation',
    blueprintId: 'coding-solo',
    instanceId: 'instance_x',
    seed: '0-c0',
    diff: 'diff --git a/f b/f',
    tokensIn: 100,
    tokensOut: 100,
    costUsd: 0,
    turns: 3,
    wallClockMs: 1000,
    trajectoryRef: 'traj://0-c0',
    stopReason: 'done',
    ...over,
  };
}

interface FakeOpts {
  applied?: boolean;
  reproPassed?: boolean;
  regressionOk?: boolean;
  regressionPassed?: number;
  regressionTotal?: number;
  reproTokensIn?: number;
  throwAt?: 'clone' | 'apply' | 'regression' | 'repro';
}

function makeFakeVerifierOps(opts: FakeOpts = {}) {
  const tasksSeen: VisibleTask[] = [];
  let cleaned = 0;
  const checkout: TaskCheckout = {
    dir: '/tmp/clean',
    repo: 'o/r',
    baseCommit: 'a'.repeat(40),
    cleanup: async () => {
      cleaned += 1;
    },
  };
  const ops: VisibleTestVerifierOps = {
    async cloneAtBase(task) {
      tasksSeen.push(task);
      if (opts.throwAt === 'clone') throw new Error('clone failed');
      return checkout;
    },
    async applyDiff(_c, _diff) {
      if (opts.throwAt === 'apply') throw new Error('apply crashed');
      return { applied: opts.applied ?? true, raw: 'apply-out' };
    },
    async runRegressionSuite(_c, task) {
      tasksSeen.push(task);
      if (opts.throwAt === 'regression') throw new Error('regression crashed');
      const total = opts.regressionTotal ?? 5;
      const passed = opts.regressionPassed ?? total;
      return { ok: opts.regressionOk ?? passed === total, passed, total, raw: 'reg-out' };
    },
    async runReproTest(_c, task) {
      tasksSeen.push(task);
      if (opts.throwAt === 'repro') throw new Error('repro crashed');
      return { passed: opts.reproPassed ?? true, raw: 'repro-out', tokensIn: opts.reproTokensIn ?? 0, tokensOut: 0, turns: 0 };
    },
  };
  return { ops, tasksSeen, cleaned: () => cleaned };
}

describe('toVisibleTask', () => {
  it('strips graderMeta', () => {
    const v = toVisibleTask(TASK);
    expect('graderMeta' in v).toBe(false);
    expect(v.instanceId).toBe('instance_x');
    expect(v.problemStatement).toBe('Fix the bug.');
  });
});

describe('makeVisibleTestVerifier', () => {
  it('scores 0 and applied=false when the diff does not apply', async () => {
    const fake = makeFakeVerifierOps({ applied: false });
    const verify = makeVisibleTestVerifier(fake.ops);
    const r = await verify({ task: TASK, attempt: attempt() });
    expect(r.applied).toBe(false);
    expect(r.score).toBe(0);
    expect(fake.cleaned()).toBe(1);
  });

  it('scores high when the repro test and the regression suite both pass', async () => {
    const fake = makeFakeVerifierOps({ reproPassed: true, regressionOk: true, regressionTotal: 4, regressionPassed: 4 });
    const verify = makeVisibleTestVerifier(fake.ops);
    const r = await verify({ task: TASK, attempt: attempt() });
    expect(r.applied).toBe(true);
    expect(r.reproPassed).toBe(true);
    expect(r.regressionsPassed).toBe(true);
    expect(r.visiblePassed).toBe(5); // 1 repro + 4 regression
    expect(r.visibleTotal).toBe(5); // 1 repro + 4 regression
    expect(r.score).toBeCloseTo(1, 5);
  });

  it('ranks a repro-pass candidate above a repro-fail candidate', async () => {
    const pass = makeVisibleTestVerifier(makeFakeVerifierOps({ reproPassed: true }).ops);
    const fail = makeVisibleTestVerifier(makeFakeVerifierOps({ reproPassed: false }).ops);
    const rPass = await pass({ task: TASK, attempt: attempt() });
    const rFail = await fail({ task: TASK, attempt: attempt() });
    expect(rPass.score).toBeGreaterThan(rFail.score);
  });

  it('counts the verifier model tokens (repro authoring) for the arm budget', async () => {
    const fake = makeFakeVerifierOps({ reproTokensIn: 40 });
    const verify = makeVisibleTestVerifier(fake.ops);
    const r = await verify({ task: TASK, attempt: attempt() });
    expect(r.tokensIn).toBe(40);
  });

  it('returns generationError + score 0 on a verifier infra failure (does not throw)', async () => {
    const fake = makeFakeVerifierOps({ throwAt: 'regression' });
    const verify = makeVisibleTestVerifier(fake.ops);
    const r = await verify({ task: TASK, attempt: attempt() });
    expect(r.score).toBe(0);
    expect(r.generationError).toContain('regression crashed');
    expect(fake.cleaned()).toBe(1); // cleanup still ran
  });

  it('NEVER exposes graderMeta to the verifier ops (invariant #2, structural)', async () => {
    const fake = makeFakeVerifierOps();
    const verify = makeVisibleTestVerifier(fake.ops);
    await verify({ task: TASK, attempt: attempt() });
    expect(fake.tasksSeen.length).toBeGreaterThan(0);
    for (const seen of fake.tasksSeen) {
      expect('graderMeta' in seen).toBe(false);
    }
  });
});

describe('makeLiveBestOfNPorts', () => {
  it('grade wraps the batch grader to a single (submission, task) and returns the one result', async () => {
    const graded: { submissions: unknown[]; tasks: unknown[] }[] = [];
    const grader: OfficialGrader = {
      family: 'swe-bench-pro',
      modality: 'diff',
      async grade(submissions, tasks) {
        graded.push({ submissions, tasks });
        const result: GradeResult = {
          instanceId: TASK.instanceId,
          prefix: '0',
          resolved: true,
          rawGraderOutput: {},
          graderFamily: 'swe-bench-pro',
          graderVersion: 'v1',
        };
        return [result];
      },
    };
    const ports = makeLiveBestOfNPorts({
      generationPorts: { clone: vi.fn(), extractDiff: vi.fn(), instantiate: vi.fn() } as never,
      grader,
      verifierOps: makeFakeVerifierOps().ops,
      emit: async (input) => ({ rollout_id: 'r1', run_id: input.run_id }),
      now: () => 0,
    });

    const r = await ports.grade({ task: TASK, patch: 'PATCH', prefix: '0' });
    expect(r.resolved).toBe(true);
    expect(graded).toHaveLength(1);
    expect(graded[0].submissions).toEqual([{ modality: 'diff', instanceId: 'instance_x', patch: 'PATCH', prefix: '0' }]);
    expect(graded[0].tasks).toEqual([TASK]);
  });
});
