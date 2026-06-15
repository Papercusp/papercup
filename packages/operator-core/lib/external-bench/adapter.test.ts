/**
 * Adapter orchestration unit tests — the pure ArmAttempt+GradeResult → emitRollout mapping, batch
 * grade-and-emit, and the one-task end-to-end path. Fake grader + emit, no PG / Docker.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  gradeAndEmitBatch,
  generationStatus,
  runTaskThroughAdapter,
  seedPrefix,
  toEmitInput,
  type EmitContext,
} from './adapter';
import { makeFakeGrader } from './grader';
import type { ArmAttempt, BenchTask, GradeResult } from './types';

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
function grade(over: Partial<GradeResult> = {}): GradeResult {
  return { instanceId: 'i1', prefix: 'seed-0', resolved: true, rawGraderOutput: { ok: true }, graderFamily: 'swe-bench-pro', graderVersion: 'v1', ...over };
}
function ctx(over: Partial<EmitContext> = {}): EmitContext {
  return { runId: 'run1', preregHash: 'pre1', suite: 'swe-bench-pro', seedIndex: 0, modelId: 'claude-opus-4-8', harnessVersion: 'hv1', graderFamily: 'swe-bench-pro', graderVersion: 'v1', ...over };
}
function task(id = 'i1'): BenchTask {
  return { benchmark: 'swe-bench-pro', instanceId: id, problemStatement: 'p', repo: 'a/b', baseCommit: 'abc1234', graderMeta: {} };
}

describe('seedPrefix / generationStatus', () => {
  it('seedPrefix maps an int seed to a stable prefix', () => {
    expect(seedPrefix(3)).toBe('seed-3');
  });
  it('maps stop reasons onto the wire generation status', () => {
    expect(generationStatus(attempt({ stopReason: 'done' }))).toBe('completed');
    expect(generationStatus(attempt({ stopReason: 'escalate' }))).toBe('completed');
    expect(generationStatus(attempt({ stopReason: 'max-turns' }))).toBe('completed');
    expect(generationStatus(attempt({ stopReason: 'budget-exhausted' }))).toBe('budget_exhausted');
    expect(generationStatus(attempt({ stopReason: 'error' }))).toBe('error');
  });
});

describe('toEmitInput', () => {
  it('a completed + resolved attempt → a scoreable passed row', () => {
    const e = toEmitInput(attempt(), grade(), ctx());
    expect(e).toMatchObject({ run_id: 'run1', prereg_hash: 'pre1', suite: 'swe-bench-pro', task_id: 'i1', arm: 'papercusp', seed: 0, modality: 'diff' });
    expect(e.generation.status).toBe('completed');
    expect(e.generation.tokens_total).toBe(150); // coordination overhead counted (in+out)
    expect(e.generation.submission).toBe('DIFF');
    expect(e.generation.arm_meta).toMatchObject({ blueprintId: 'external-bench', stopReason: 'done' });
    expect(e.generation.trajectory_ref).toBe('roll://1');
    expect(e.grading.status).toBe('passed');
    expect(e.grading.resolved).toBe(true);
    expect(e.grading.structured_output).toBeDefined();
  });

  it('a completed + unresolved attempt → failed', () => {
    const e = toEmitInput(attempt(), grade({ resolved: false }), ctx());
    expect(e.grading.status).toBe('failed');
    expect(e.grading.resolved).toBe(false);
  });

  it('a budget-exhausted generation → budget_exhausted + capped, grading skipped (resolved null)', () => {
    const e = toEmitInput(attempt({ stopReason: 'budget-exhausted' }), undefined, ctx());
    expect(e.generation.status).toBe('budget_exhausted');
    expect(e.generation.capped).toBe(true);
    expect(e.grading.status).toBe('skipped');
    expect(e.grading.resolved).toBeNull();
  });

  it('a generation infra error → grading skipped (excluded from accuracy)', () => {
    const e = toEmitInput(attempt({ stopReason: 'error', generationError: 'died' }), undefined, ctx());
    expect(e.generation.status).toBe('error');
    expect(e.generation.error).toBe('died');
    expect(e.grading.status).toBe('skipped');
    expect(e.grading.resolved).toBeNull();
  });

  it('a grader infra error → grading error, resolved null (distinct from "not resolved")', () => {
    const e = toEmitInput(attempt(), grade({ graderError: 'image pull failed', resolved: false }), ctx());
    expect(e.grading.status).toBe('error');
    expect(e.grading.resolved).toBeNull();
    expect(e.grading.error).toBe('image pull failed');
  });

  it('records the iso-budget cap on the row when provided', () => {
    const e = toEmitInput(attempt(), grade(), ctx({ budgetTokens: 500_000 }));
    expect(e.generation.budget_tokens).toBe(500_000);
  });
});

describe('gradeAndEmitBatch', () => {
  it('grades only completed attempts, emits every row, matches grades by instance+seed', async () => {
    const completed = attempt({ instanceId: 'i1', seed: 'seed-0' });
    const errored = attempt({ instanceId: 'i2', seed: 'seed-0', stopReason: 'error', generationError: 'died', diff: '' });
    const grader = makeFakeGrader({ verdicts: { i1: true } });
    const emit = vi.fn(async (i) => ({ rollout_id: `ro-${i.task_id}`, run_id: i.run_id }));

    const rows = await gradeAndEmitBatch(
      [
        { attempt: completed, task: task('i1'), seedIndex: 0 },
        { attempt: errored, task: task('i2'), seedIndex: 0 },
      ],
      grader,
      emit,
      { runId: 'run1', preregHash: 'pre1', suite: 'swe-bench-pro', modelId: 'm', harnessVersion: 'h' },
    );

    expect(emit).toHaveBeenCalledTimes(2);
    expect(rows[0].grade?.resolved).toBe(true);
    expect(rows[1].grade).toBeUndefined(); // the errored attempt was never graded
    const statuses = emit.mock.calls.map((c) => c[0].grading.status);
    expect(statuses).toContain('passed');
    expect(statuses).toContain('skipped');
  });

  it('does not call the grader when no attempt is scoreable', async () => {
    const grader = makeFakeGrader({ verdicts: {} });
    const spy = vi.spyOn(grader, 'grade');
    const emit = vi.fn(async (i) => ({ rollout_id: 'ro', run_id: i.run_id }));
    await gradeAndEmitBatch(
      [{ attempt: attempt({ stopReason: 'error', diff: '' }), task: task(), seedIndex: 0 }],
      grader,
      emit,
      { runId: 'run1', preregHash: 'pre1', suite: 'swe-bench-pro', modelId: 'm', harnessVersion: 'h' },
    );
    expect(spy).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledOnce();
  });
});

describe('runTaskThroughAdapter (one task, end-to-end)', () => {
  it('generates with the seed prefix, grades, and emits a graded costed row', async () => {
    const generate = vi.fn(async (t: BenchTask, seed: string) => attempt({ instanceId: t.instanceId, seed }));
    const grader = makeFakeGrader({ verdicts: { i1: true } });
    const emit = vi.fn(async (i) => ({ rollout_id: 'ro', run_id: i.run_id }));

    const row = await runTaskThroughAdapter({
      task: task('i1'),
      ctx: { runId: 'r', preregHash: 'p', suite: 'swe-bench-pro', modelId: 'm', harnessVersion: 'h', seedIndex: 2 },
      generate,
      grader,
      emit,
    });

    expect(generate).toHaveBeenCalledWith(task('i1'), 'seed-2');
    expect(row.grade?.resolved).toBe(true);
    expect(row.rollout.rollout_id).toBe('ro');
    expect(emit.mock.calls[0][0].grading.status).toBe('passed');
  });
});
