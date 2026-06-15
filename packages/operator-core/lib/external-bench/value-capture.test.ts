/**
 * L3 value-capture layer unit tests — grader-agnostic, fake generate/grader/emit.
 */
import { describe, expect, it, vi } from 'vitest';
import { runValueCaptureTask, taskValueUsd } from './value-capture';
import { makeFakeGrader } from './grader';
import type { ArmAttempt, BenchTask } from './types';

function task(over: Partial<BenchTask> = {}): BenchTask {
  return { benchmark: 'swe-lancer', instanceId: 'ic-1', problemStatement: 'ship the feature', repo: 'a/b', baseCommit: 'abc1234', graderMeta: {}, ...over };
}
function attempt(over: Partial<ArmAttempt> = {}): ArmAttempt {
  return { arm: 'papercusp', blueprintId: 'external-bench', instanceId: 'ic-1', seed: 'seed-0', diff: 'DIFF', tokensIn: 10, tokensOut: 5, costUsd: 0.1, turns: 2, wallClockMs: 100, trajectoryRef: 'r', stopReason: 'done', ...over };
}

describe('taskValueUsd', () => {
  it('reads the typed valueUsd', () => {
    expect(taskValueUsd(task({ valueUsd: 250 }))).toBe(250);
  });
  it('falls back to graderMeta.payoutUsd', () => {
    expect(taskValueUsd(task({ graderMeta: { payoutUsd: 1000 } }))).toBe(1000);
  });
  it('is 0 for a non-value task', () => {
    expect(taskValueUsd(task())).toBe(0);
  });
});

describe('runValueCaptureTask', () => {
  it('stamps the task payout onto the emitted row (arm_meta.valueUsd)', async () => {
    const generate = vi.fn(async (t: BenchTask, seed: string) => attempt({ instanceId: t.instanceId, seed }));
    const grader = makeFakeGrader({ verdicts: { 'ic-1': true } });
    const emit = vi.fn(async (i) => ({ rolloutId: 'ro', runId: i.runId }));

    const row = await runValueCaptureTask({
      task: task({ valueUsd: 750 }),
      ctx: { runId: 'r', preregHash: 'p', modelId: 'm', harnessVersion: 'h', seedIndex: 0 },
      generate,
      grader,
      emit,
    });

    expect(row.grade?.resolved).toBe(true); // resolved → its $750 is captured
    expect(emit.mock.calls[0][0].attempt.armMeta).toMatchObject({ valueUsd: 750 });
  });

  it('carries $0 when the task has no payout, and preserves any pre-existing armMeta', async () => {
    const generate = vi.fn(async (t: BenchTask, seed: string) => attempt({ instanceId: t.instanceId, seed, armMeta: { costSource: 'native' } }));
    const grader = makeFakeGrader({ verdicts: { 'ic-1': false } });
    const emit = vi.fn(async (i) => ({ rolloutId: 'ro', runId: i.runId }));

    await runValueCaptureTask({
      task: task(),
      ctx: { runId: 'r', preregHash: 'p', modelId: 'm', harnessVersion: 'h', seedIndex: 0 },
      generate,
      grader,
      emit,
    });

    expect(emit.mock.calls[0][0].attempt.armMeta).toMatchObject({ valueUsd: 0, costSource: 'native' });
  });
});
