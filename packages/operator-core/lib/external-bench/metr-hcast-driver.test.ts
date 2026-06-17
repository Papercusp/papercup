/**
 * METR HCAST driver unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-005).
 *
 * Focus: the two-arm × multi-sample orchestration merges per-seed results per arm and feeds the horizon
 * report; never throws on a failing task; progress is reported. Fake ops — no docker, no spend.
 */
import { describe, expect, it, vi } from 'vitest';
import { runMetrHcastSuite } from './metr-hcast-driver';
import type { MetrHcastRunnerOps } from './metr-hcast-runner';
import type { BenchTask } from './types';

const mkTask = (id: string, humanMinutes: number): BenchTask => ({
  benchmark: 'metr-hcast',
  instanceId: id,
  problemStatement: id,
  graderMeta: { image: `i:${id}`, family: id.split('__')[0], task: id.split('__')[1] ?? id, humanMinutes, version: '1' },
});

/** Fake ops: score = 1 when task humanMinutes ≤ competence (keyed off the task via prepareTask env). */
function competenceOps(competence: number): MetrHcastRunnerOps {
  const hmByContainer = new Map<string, number>();
  return {
    now: () => 0,
    concurrencyCap: () => 4,
    prepareTask: async ({ task }) => {
      const cid = `c-${task.instanceId}`;
      hmByContainer.set(cid, Number(task.graderMeta.humanMinutes));
      return { containerId: cid, image: 'i', family: 'f', task: 't', instructions: '' };
    },
    driveArm: async () => ({ telemetry: { tokensIn: 10, tokensOut: 5, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: 'done' }, submission: 'x' }),
    score: async ({ env }) => ({ score: (hmByContainer.get(env.containerId) ?? 1e9) <= competence ? 1 : 0, raw: {} }),
    teardownTask: async () => {},
  };
}

const TASKS = [2, 4, 8, 16, 32, 64, 128].map((m) => mkTask(`fam${m}__t${m}`, m));

describe('runMetrHcastSuite', () => {
  it('runs both arms × samples, merges results, and builds a report with a lift', async () => {
    const opsFor = (arm: string) => competenceOps(arm === 'papercusp' ? 64 : 16);
    const progress: number[] = [];
    const { resultsByArm, report } = await runMetrHcastSuite({
      tasks: TASKS,
      samplesPerTask: 2,
      opsFor,
      report: { bootstrap: 100, seed: 1, weighting: 'equal' },
      onProgress: (e) => progress.push(e.done),
    });
    // 7 tasks × 2 samples = 14 rows per arm.
    expect(resultsByArm['papercusp']).toHaveLength(14);
    expect(resultsByArm['baseline-a-ablation']).toHaveLength(14);
    expect(report.lifts.length).toBeGreaterThan(0);
    const hive = report.arms.find((a) => a.arm === 'papercusp')!;
    const solo = report.arms.find((a) => a.arm === 'baseline-a-ablation')!;
    const hiveP50 = hive.points.find((p) => p.quantile === 0.5)!.horizonMinutes;
    const soloP50 = solo.points.find((p) => p.quantile === 0.5)!.horizonMinutes;
    expect(hiveP50).toBeGreaterThan(soloP50); // hive solves longer tasks
    expect(progress.length).toBe(4); // 2 arms × 2 samples
  });

  it('a single arm produces no lift but a valid per-arm horizon', async () => {
    const { report } = await runMetrHcastSuite({
      tasks: TASKS,
      arms: ['baseline-a-ablation'],
      opsFor: () => competenceOps(16),
      report: { bootstrap: 0 },
    });
    expect(report.lifts).toEqual([]);
    expect(report.arms).toHaveLength(1);
  });

  it('never throws when an arm op fails for a task', async () => {
    const flaky: MetrHcastRunnerOps = {
      ...competenceOps(32),
      driveArm: async ({ task }) => {
        if (task.instanceId.includes('t8')) throw new Error('boom');
        return { telemetry: { tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: 'done' }, submission: 'x' };
      },
    };
    const { resultsByArm } = await runMetrHcastSuite({ tasks: TASKS, arms: ['papercusp'], opsFor: () => flaky, report: { bootstrap: 0 } });
    const failed = resultsByArm['papercusp'].find((r) => r.attempt.instanceId.includes('t8'))!;
    expect(failed.grade.resolved).toBeNull(); // excluded, not thrown
  });
});
