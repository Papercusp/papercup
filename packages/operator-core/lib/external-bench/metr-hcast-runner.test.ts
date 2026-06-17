/**
 * METR HCAST runner unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-003/P-004/P-005).
 *
 * Focus: the per-task lifecycle (prepare → drive → score → teardown), the never-throw generation-failure
 * contract (prepare fail / drive throw / non-scored terminal / score crash → resolved=null, excluded), the
 * score→resolved threshold derivation, humanMinutes passthrough for the horizon fit, teardown-always, and the
 * bounded concurrency pool. All with an injected fake ops — NO docker, NO live arm.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  runMetrHcastBacklog,
  runOneMetrHcastTask,
  type MetrHcastRunnerOps,
  type MetrHcastTaskEnv,
} from './metr-hcast-runner';
import type { BenchTask, GenerationStopReason, GenerationTelemetry } from './types';

const task = (id: string, humanMinutes: number | null = 30, extra: Record<string, unknown> = {}): BenchTask => ({
  benchmark: 'metr-hcast',
  instanceId: id,
  problemStatement: `task ${id}`,
  graderMeta: { image: `metrevals/public-tasks:${id}`, family: id.split('__')[0], task: id.split('__')[1] ?? id, humanMinutes, version: '1.0.0', ...extra },
});

const telem = (over: Partial<GenerationTelemetry> = {}): GenerationTelemetry => ({
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.01,
  turns: 3,
  wallClockMs: 1234,
  trajectoryRef: 'traj-1',
  stopReason: 'done' as GenerationStopReason,
  ...over,
});

function fakeOps(over: Partial<MetrHcastRunnerOps> = {}): MetrHcastRunnerOps & { teardowns: string[] } {
  const teardowns: string[] = [];
  const base: MetrHcastRunnerOps = {
    now: () => 1000,
    concurrencyCap: () => 2,
    prepareTask: async ({ task }) => ({
      containerId: `c-${task.instanceId}`,
      image: String(task.graderMeta.image),
      family: String(task.graderMeta.family),
      task: String(task.graderMeta.task),
      instructions: 'do the thing',
    }),
    driveArm: async () => ({ telemetry: telem(), submission: 'answer' }),
    score: async () => ({ score: 1.0, raw: { score: 1.0 } }),
    teardownTask: async ({ env }) => {
      teardowns.push(env.containerId);
    },
    ...over,
  };
  return Object.assign(base, { teardowns });
}

describe('runOneMetrHcastTask — happy path', () => {
  it('prepare → drive → score → resolved=true when score ≥ threshold; threads humanMinutes', async () => {
    const ops = fakeOps();
    const r = await runOneMetrHcastTask(ops, { task: task('a__1', 42), arm: 'baseline-a-ablation', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.attempt.arm).toBe('baseline-a-ablation');
    expect(r.attempt.stopReason).toBe('done');
    expect(r.attempt.tokensIn).toBe(100);
    expect(r.grade.resolved).toBe(true);
    expect(r.grade.score).toBe(1.0);
    expect(r.grade.graderFamily).toBe('metr-hcast');
    expect(r.humanMinutes).toBe(42);
    expect(ops.teardowns).toEqual(['c-a__1']); // torn down
  });

  it('resolved=false when score below threshold', async () => {
    const ops = fakeOps({ score: async () => ({ score: 0.0, raw: { score: 0 } }) });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.grade.resolved).toBe(false);
    expect(r.grade.score).toBe(0.0);
  });

  it('honours a per-task scoreThreshold (partial-credit tasks)', async () => {
    const ops = fakeOps({ score: async () => ({ score: 0.6, raw: {} }) });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1', 30, { scoreThreshold: 0.5 }), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.grade.resolved).toBe(true); // 0.6 ≥ 0.5
  });
});

describe('runOneMetrHcastTask — never-throw infra contract', () => {
  it('prepare failure → error attempt, resolved=null, no teardown attempted (no env)', async () => {
    const ops = fakeOps({ prepareTask: async () => { throw new Error('image pull 500'); } });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.attempt.stopReason).toBe('error');
    expect(r.attempt.generationError).toMatch(/image pull 500/);
    expect(r.grade.resolved).toBeNull();
    expect(r.grade.graderError).toMatch(/prepareTask/);
    expect(ops.teardowns).toEqual([]);
  });

  it('drive throw → infra-failed, resolved=null, still torn down', async () => {
    const ops = fakeOps({ driveArm: async () => { throw new Error('429 at gateway'); } });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.attempt.stopReason).toBe('infra-failed');
    expect(r.grade.resolved).toBeNull();
    expect(ops.teardowns).toEqual(['c-a__1']);
  });

  it('non-scored terminal (timeout) → attempt kept, resolved=null, score() NOT called', async () => {
    const score = vi.fn();
    const ops = fakeOps({
      driveArm: async () => ({ telemetry: telem({ stopReason: 'timeout', generationError: 'wall clock' }), submission: '' }),
      score: score as unknown as MetrHcastRunnerOps['score'],
    });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.attempt.stopReason).toBe('timeout');
    expect(r.grade.resolved).toBeNull();
    expect(score).not.toHaveBeenCalled();
    expect(ops.teardowns).toEqual(['c-a__1']);
  });

  it('score crash → resolved=null, excluded, still torn down', async () => {
    const ops = fakeOps({ score: async () => { throw new Error('score() crashed'); } });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.grade.resolved).toBeNull();
    expect(r.grade.graderError).toMatch(/score failed/);
    expect(ops.teardowns).toEqual(['c-a__1']);
  });

  it('score() returns null (None) → resolved=null with a graderError', async () => {
    const ops = fakeOps({ score: async () => ({ score: null, raw: null }) });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(r.grade.score).toBeNull();
    expect(r.grade.resolved).toBeNull();
    expect(r.grade.graderError).toMatch(/null|None/);
  });

  it('budget-exhausted is a SCORED terminal → score() IS called', async () => {
    const score = vi.fn(async () => ({ score: 1.0, raw: {} }));
    const ops = fakeOps({
      driveArm: async () => ({ telemetry: telem({ stopReason: 'budget-exhausted' }), submission: 'x' }),
      score: score as unknown as MetrHcastRunnerOps['score'],
    });
    const r = await runOneMetrHcastTask(ops, { task: task('a__1'), arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(score).toHaveBeenCalledOnce();
    expect(r.grade.resolved).toBe(true);
  });
});

describe('runMetrHcastBacklog — bounded pool', () => {
  it('runs every task once, never throws on a failing task, respects the cap', async () => {
    let live = 0;
    let maxLive = 0;
    const ops = fakeOps({
      concurrencyCap: () => 2,
      prepareTask: async ({ task }) => {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return { containerId: `c-${task.instanceId}`, image: 'i', family: 'f', task: 't', instructions: '' };
      },
      // one task drive throws
      driveArm: async ({ task }) => {
        if (task.instanceId === 'b__2') throw new Error('boom');
        return { telemetry: telem(), submission: 'x' };
      },
    });
    const backlog = ['a__1', 'b__2', 'c__3', 'd__4'].map((id) => task(id));
    const results = await runMetrHcastBacklog(ops, { backlog, arm: 'papercusp', budget: {}, seed: '0', workspaceId: 'w' });
    expect(results).toHaveLength(4);
    expect(maxLive).toBeLessThanOrEqual(2); // cap honoured
    const failed = results.find((r) => r.attempt.instanceId === 'b__2')!;
    expect(failed.grade.resolved).toBeNull();
    const ok = results.filter((r) => r.grade.resolved === true);
    expect(ok).toHaveLength(3);
  });
});
