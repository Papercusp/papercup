/**
 * METR HCAST fleet-arm backlog driver tests (benchmark-suite-metr-hcast-2026-06-17 extraction).
 * Focus: the driver implements the canonical HiveBacklogDriver contract — emits a HiveBacklogResult
 * (FleetTaskResult[] + ConcurrencyTimeline) with the M2 score/resolved/humanMinutes on armMeta; the
 * arm→ArmId mapping; never-throw on a failing task; and the fleet↔MetrHcastTaskResult round-trip (so the
 * horizon report runs off the same fleet output). Fake ops — no docker, no spend.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  metrHcastArmIdForFleetArm,
  metrHcastBacklogDriver,
  metrHcastTaskResultsFromFleet,
} from './metr-hcast-backlog';
import type { MetrHcastRunnerOps } from './metr-hcast-runner';
import type { BenchTask } from './types';
import { buildMetrHcastReport } from './metr-hcast-report';

const task = (id: string, humanMinutes: number): BenchTask => ({
  benchmark: 'metr-hcast',
  instanceId: id,
  problemStatement: id,
  graderMeta: { image: `i:${id}`, family: id.split('__')[0], task: id.split('__')[1] ?? id, humanMinutes, version: '1' },
});

/** Fake ops: solves tasks with humanMinutes ≤ competence (keyed off the prepared env). */
function competenceOps(competence: number, over: Partial<MetrHcastRunnerOps> = {}): MetrHcastRunnerOps {
  const hmByContainer = new Map<string, number>();
  return {
    now: () => Date.now(),
    concurrencyCap: () => 3,
    prepareTask: async ({ task }) => {
      const cid = `c-${task.instanceId}`;
      hmByContainer.set(cid, Number(task.graderMeta.humanMinutes));
      return { containerId: cid, image: 'i', family: String(task.graderMeta.family), task: 't', instructions: '' };
    },
    driveArm: async () => ({ telemetry: { tokensIn: 10, tokensOut: 5, costUsd: 0.001, turns: 1, wallClockMs: 5, trajectoryRef: '', stopReason: 'done' }, submission: 'x' }),
    score: async ({ env }) => ({ score: (hmByContainer.get(env.containerId) ?? 1e9) <= competence ? 1 : 0, raw: {} }),
    teardownTask: async () => {},
    ...over,
  };
}

const BACKLOG = [2, 8, 32, 128].map((m) => task(`fam${m}__t${m}`, m));

describe('metrHcastArmIdForFleetArm', () => {
  it('maps su-independent → baseline-a-ablation, hive-realqueen → papercusp', () => {
    expect(metrHcastArmIdForFleetArm('su-independent')).toBe('baseline-a-ablation');
    expect(metrHcastArmIdForFleetArm('hive-realqueen')).toBe('papercusp');
    expect(metrHcastArmIdForFleetArm('hive')).toBe('papercusp');
  });
});

describe('metrHcastBacklogDriver', () => {
  it('emits the canonical HiveBacklogResult with timeline + score/humanMinutes on armMeta', async () => {
    const driver = metrHcastBacklogDriver(competenceOps(32), { sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'metr-hcast', runId: 'r1', seed: 0, backlog: BACKLOG, budget: {} });
    expect(res.arm).toBe('su-independent');
    expect(res.suite).toBe('metr-hcast');
    expect(res.runError).toBeUndefined();
    expect(res.taskResults).toHaveLength(4);
    expect(res.concurrencyTimeline).toBeDefined();
    expect(res.peakConcurrentBees).toBeGreaterThanOrEqual(1);
    const t2 = res.taskResults.find((t) => t.attempt.instanceId === 'fam2__t2')!;
    expect(t2.attempt.armMeta!.suite).toBe('metr-hcast');
    expect(t2.attempt.armMeta!.score).toBe(1); // 2min ≤ 32 competence → solved
    expect(t2.attempt.armMeta!.humanMinutes).toBe(2);
    expect(t2.disposition).toBe('spawn');
    const t128 = res.taskResults.find((t) => t.attempt.instanceId === 'fam128__t128')!;
    expect(t128.attempt.armMeta!.score).toBe(0); // 128min > 32 → failed
  });

  it('never throws when a task op fails — lands a resolved=null row', async () => {
    const flaky = competenceOps(64, {
      driveArm: async ({ task }) => {
        if (task.instanceId.includes('t8')) throw new Error('boom');
        return { telemetry: { tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: 'done' }, submission: 'x' };
      },
    });
    const driver = metrHcastBacklogDriver(flaky, { sampleIntervalMs: 1 });
    const res = await driver.run({ arm: 'su-independent', suite: 'metr-hcast', runId: 'r', seed: 0, backlog: BACKLOG, budget: {} });
    expect(res.taskResults).toHaveLength(4);
    const failed = res.taskResults.find((t) => t.attempt.instanceId === 'fam8__t8')!;
    expect(failed.attempt.armMeta!.resolved).toBeNull(); // infra-failed → excluded
  });

  it('round-trips through the horizon report (fleet output → MetrHcastTaskResult → buildMetrHcastReport)', async () => {
    // Run BOTH arms via the shared driver, then build the horizon report off the canonical fleet output.
    const big = [2, 4, 8, 16, 32, 64, 128].map((m) => task(`fam${m}__t${m}`, m));
    const soloRes = await metrHcastBacklogDriver(competenceOps(16), { sampleIntervalMs: 1 }).run({ arm: 'su-independent', suite: 'metr-hcast', runId: 'r', seed: 0, backlog: big, budget: {} });
    const hiveRes = await metrHcastBacklogDriver(competenceOps(64), { sampleIntervalMs: 1 }).run({ arm: 'hive-realqueen', suite: 'metr-hcast', runId: 'r', seed: 0, backlog: big, budget: {} });
    const report = buildMetrHcastReport(
      {
        'baseline-a-ablation': metrHcastTaskResultsFromFleet(soloRes),
        papercusp: metrHcastTaskResultsFromFleet(hiveRes),
      },
      { bootstrap: 50, seed: 1, weighting: 'equal' },
    );
    expect(report.arms).toHaveLength(2);
    const hive = report.arms.find((a) => a.arm === 'papercusp')!;
    const solo = report.arms.find((a) => a.arm === 'baseline-a-ablation')!;
    // hive (competence 64) solves longer tasks than solo (16) → longer horizon.
    expect(hive.points.find((p) => p.quantile === 0.5)!.horizonMinutes).toBeGreaterThan(
      solo.points.find((p) => p.quantile === 0.5)!.horizonMinutes,
    );
  });

  it('respects the concurrency cap from ops', async () => {
    let live = 0;
    let maxLive = 0;
    const ops = competenceOps(64, {
      concurrencyCap: () => 2,
      driveArm: async () => {
        live += 1; maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 3));
        live -= 1;
        return { telemetry: { tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: 'done' }, submission: 'x' };
      },
    });
    await metrHcastBacklogDriver(ops, { sampleIntervalMs: 1 }).run({ arm: 'su-independent', suite: 'metr-hcast', runId: 'r', seed: 0, backlog: BACKLOG, budget: {} });
    expect(maxLive).toBeLessThanOrEqual(2);
  });
});
