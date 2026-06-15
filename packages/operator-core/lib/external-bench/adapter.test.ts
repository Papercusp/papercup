/**
 * Adapter orchestration unit tests — grading + delegation to the injected emit (= P-010's emitFromAttempt).
 * The per-row run-result MAPPING (stop→status, METR exclusion, cost) is emitFromAttempt's own tests; here we
 * verify the adapter grades the right attempts and hands emitFromAttempt the correct EmitFromAttemptInput.
 */
import { describe, expect, it } from 'vitest';
import { gradeAndEmitBatch, runTaskThroughAdapter, seedPrefix, type EmitFromAttemptInput, type EmitRollout } from './adapter';
import { makeFakeGrader } from './grader';
import type { ArmAttempt, BenchTask } from './types';

function attempt(over: Partial<ArmAttempt> = {}): ArmAttempt {
  return {
    arm: 'papercusp',
    blueprintId: 'external-bench',
    instanceId: 'i1',
    seed: 'seed-0',
    diff: 'DIFF',
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.3,
    turns: 5,
    wallClockMs: 900,
    trajectoryRef: 'roll://1',
    stopReason: 'done',
    ...over,
  };
}
function task(id = 'i1'): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: 'p', repo: 'a/b', baseCommit: 'abc1234', graderMeta: {} };
}
function fakeEmit(): { emit: EmitRollout; inputs: EmitFromAttemptInput[] } {
  const inputs: EmitFromAttemptInput[] = [];
  const emit: EmitRollout = async (input) => {
    inputs.push(input);
    return { rolloutId: `ro-${inputs.length}`, runId: input.runId };
  };
  return { emit, inputs };
}
const ctx = { runId: 'run1', preregHash: 'pre1', modelId: 'claude-opus-4-8', harnessVersion: 'hv1' };

describe('seedPrefix', () => {
  it('maps an int seed to a stable prefix', () => {
    expect(seedPrefix(3)).toBe('seed-3');
  });
});

describe('gradeAndEmitBatch', () => {
  it('grades only scoreable attempts and delegates one emit per entry with the canonical input', async () => {
    const completed = attempt({ instanceId: 'i1', seed: 'seed-0', tokensCacheRead: 4000, tokensCacheWrite: 1000, armMeta: { costSource: 'native' } });
    const errored = attempt({ instanceId: 'i2', seed: 'seed-0', stopReason: 'error', generationError: 'died', diff: '' });
    const grader = makeFakeGrader({ verdicts: { i1: true } });
    const { emit, inputs } = fakeEmit();

    const rows = await gradeAndEmitBatch(
      [
        { attempt: completed, task: task('i1'), seedIndex: 0 },
        { attempt: errored, task: task('i2'), seedIndex: 0 },
      ],
      grader,
      emit,
      ctx,
    );

    // emit once per entry; canonical fields threaded
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toMatchObject({ runId: 'run1', preregHash: 'pre1', arm: 'papercusp', seed: 0, modelId: 'claude-opus-4-8', harnessVersion: 'hv1' });
    expect(inputs[0].task.instanceId).toBe('i1');
    expect(inputs[0].grade.resolved).toBe(true); // i1 graded
    expect(inputs[0].tokensCacheRead).toBe(4000); // cache tokens carried through (Opus $)
    expect(inputs[0].tokensCacheWrite).toBe(1000);
    expect(inputs[0].attempt.armMeta).toMatchObject({ costSource: 'native' }); // arm meta rides the attempt

    // the infra-failed attempt is NOT graded but still emits a placeholder grade
    expect(inputs[1].attempt.stopReason).toBe('error');
    expect(inputs[1].grade.graderVersion).toBe(''); // placeholder

    // returned rows: real grade for scoreable, undefined for infra-failed
    expect(rows[0].grade?.resolved).toBe(true);
    expect(rows[1].grade).toBeUndefined();
    expect(rows[0].rollout.rolloutId).toBe('ro-1');
  });

  it('grades budget-/turn-capped attempts (capped ≠ infra fail) but skips stopReason=error', async () => {
    const capped = attempt({ instanceId: 'i1', stopReason: 'budget-exhausted', diff: 'PARTIAL' });
    const grader = makeFakeGrader({ verdicts: { i1: false } });
    const spy = grader.grade;
    const { emit, inputs } = fakeEmit();
    await gradeAndEmitBatch([{ attempt: capped, task: task('i1'), seedIndex: 0 }], grader, emit, ctx);
    expect(inputs[0].grade.resolved).toBe(false); // it WAS graded (capped run is a genuine attempt)
    expect(spy).toBeDefined();
  });

  it('does not call the grader when nothing is scoreable', async () => {
    const grader = makeFakeGrader({ verdicts: {} });
    let graded = 0;
    const wrapped = { ...grader, grade: async (...a: Parameters<typeof grader.grade>) => { graded += 1; return grader.grade(...a); } };
    const { emit, inputs } = fakeEmit();
    await gradeAndEmitBatch([{ attempt: attempt({ stopReason: 'error', diff: '' }), task: task(), seedIndex: 0 }], wrapped, emit, ctx);
    expect(graded).toBe(0);
    expect(inputs).toHaveLength(1); // still emits the infra row
  });

  it('threads budgetTokens + fleetRunId from ctx onto the emit input', async () => {
    const grader = makeFakeGrader({ verdicts: { i1: true } });
    const { emit, inputs } = fakeEmit();
    await gradeAndEmitBatch([{ attempt: attempt(), task: task('i1'), seedIndex: 0 }], grader, emit, { ...ctx, budgetTokens: 500_000, fleetRunId: 'fleet-7' });
    expect(inputs[0].budgetTokens).toBe(500_000);
    expect(inputs[0].fleetRunId).toBe('fleet-7');
  });
});

describe('runTaskThroughAdapter (one task, end-to-end)', () => {
  it('generates with the seed prefix, grades, and emits with the int seed', async () => {
    const generate = async (t: BenchTask, seed: string) => attempt({ instanceId: t.instanceId, seed });
    const grader = makeFakeGrader({ verdicts: { i1: true } });
    const { emit, inputs } = fakeEmit();

    const row = await runTaskThroughAdapter({
      task: task('i1'),
      ctx: { ...ctx, seedIndex: 2 },
      generate,
      grader,
      emit,
    });

    expect(inputs[0].seed).toBe(2); // int seed on the row
    expect(inputs[0].attempt.seed).toBe('seed-2'); // string prefix on the attempt
    expect(row.grade?.resolved).toBe(true);
    expect(row.rollout.rolloutId).toBe('ro-1');
  });
});
