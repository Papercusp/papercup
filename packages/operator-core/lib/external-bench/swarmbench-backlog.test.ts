/**
 * SwarmBench backlog-driver + report unit tests (plan benchmark-suite-swarmbench-2026-06-17 P-006).
 * Focus: the driver rides makePoolBacklogDriver (canonical HiveBacklogResult with the sim score on armMeta);
 * arm→mode mapping; scenario↔BenchTask round-trip; never-throw on a sim infra error; and the report's
 * per-(task,arm) mean±SE + the decentralized-vs-centralized delta + the mandatory caveats. Fake RunSwarmSim.
 */
import { describe, expect, it } from 'vitest';
import {
  buildSwarmBenchReport,
  scenarioFromBenchTask,
  swarmbenchBacklogDriver,
  swarmbenchResultsFromFleet,
  swarmModeForFleetArm,
  swarmScenarioToBenchTask,
  type SwarmScenarioResult,
} from './swarmbench-backlog';
import type { RunSwarmSim, SwarmScenario, SwarmSimResult } from './swarmbench-live';
import type { HiveBacklogRunRequest } from './hive-backlog';

const scen = (task: string, seed: number, n = 4): SwarmScenario => ({ task, numAgents: n, width: 8, height: 8, seed, viewSize: 5, maxRound: 15 });

describe('swarmModeForFleetArm', () => {
  it('maps su-independent→openai, hive-realqueen→queen, random→random', () => {
    expect(swarmModeForFleetArm('su-independent')).toBe('openai');
    expect(swarmModeForFleetArm('hive-realqueen')).toBe('queen');
    expect(swarmModeForFleetArm('random')).toBe('random');
  });
});

describe('scenario ↔ BenchTask round-trip', () => {
  it('packs the scenario config into graderMeta and reads it back', () => {
    const s = scen('Pursuit', 42, 6);
    const t = swarmScenarioToBenchTask(s);
    expect(t.benchmark).toBe('swarmbench');
    expect(t.instanceId).toBe('Pursuit__n6_8x8_v5_r15_s42');
    expect(scenarioFromBenchTask(t)).toEqual(s);
  });
});

/** Fake sim: score = (task's coordination difficulty) — here we make the queen mode score higher to model a lift. */
function fakeSim(scoreByMode: (task: string, mode: string, seed: number) => number | null, errorOn?: (task: string) => boolean): RunSwarmSim {
  return async ({ scenario, mode }): Promise<SwarmSimResult> => {
    if (errorOn?.(scenario.task)) return { score: null, rounds: 0, agentTokens: 0, done: false, error: 'sim crash', raw: null };
    const score = scoreByMode(scenario.task, mode, scenario.seed);
    return { score, rounds: scenario.maxRound, agentTokens: scenario.numAgents * scenario.maxRound, done: true, raw: { score } };
  };
}

const req = (backlog: ReturnType<typeof swarmScenarioToBenchTask>[], arm: HiveBacklogRunRequest['arm']): HiveBacklogRunRequest => ({
  arm,
  suite: 'swarmbench',
  runId: 'r1',
  seed: 0,
  backlog,
  budget: {},
});

describe('swarmbenchBacklogDriver', () => {
  it('emits a canonical HiveBacklogResult with the sim score on armMeta', async () => {
    const sim = fakeSim(() => 5.0);
    const driver = swarmbenchBacklogDriver(sim, { sampleIntervalMs: 1 });
    const backlog = [scen('Pursuit', 1), scen('Pursuit', 2)].map(swarmScenarioToBenchTask);
    const res = await driver.run(req(backlog, 'su-independent'));
    expect(res.arm).toBe('su-independent');
    expect(res.suite).toBe('swarmbench');
    expect(res.taskResults).toHaveLength(2);
    const t = res.taskResults[0];
    expect(t.attempt.armMeta!.suite).toBe('swarmbench');
    expect(t.attempt.armMeta!.score).toBe(5.0);
    expect(t.attempt.armMeta!.mode).toBe('openai');
    expect(t.attempt.stopReason).toBe('done');
    expect(t.attempt.turns).toBe(15); // rounds
  });

  it('a sim infra error → stopReason infra-failed, score null (excluded), never throws', async () => {
    const sim = fakeSim(() => 1.0, (task) => task === 'Transport');
    const driver = swarmbenchBacklogDriver(sim, { sampleIntervalMs: 1 });
    const backlog = [scen('Transport', 1), scen('Pursuit', 1)].map(swarmScenarioToBenchTask);
    const res = await driver.run(req(backlog, 'su-independent'));
    const transport = res.taskResults.find((t) => t.attempt.instanceId.startsWith('Transport'))!;
    expect(transport.attempt.stopReason).toBe('infra-failed');
    expect(transport.attempt.armMeta!.score).toBeNull();
  });
});

describe('swarmbenchResultsFromFleet + buildSwarmBenchReport', () => {
  it('computes per-(task,arm) mean±SE and the hive-vs-su delta', async () => {
    // su-independent scores ~2 on Pursuit; hive ~5 → a positive (centralization-helps) delta.
    const suSim = fakeSim((_t, _m, seed) => 2 + (seed % 2)); // 2 or 3
    const hiveSim = fakeSim((_t, _m, seed) => 5 + (seed % 2)); // 5 or 6
    const backlog = [scen('Pursuit', 1), scen('Pursuit', 2), scen('Pursuit', 3)].map(swarmScenarioToBenchTask);
    const suRes = await swarmbenchBacklogDriver(suSim, { sampleIntervalMs: 1 }).run(req(backlog, 'su-independent'));
    const hiveRes = await swarmbenchBacklogDriver(hiveSim, { sampleIntervalMs: 1 }).run(req(backlog, 'hive-realqueen'));
    const report = buildSwarmBenchReport({
      'su-independent': swarmbenchResultsFromFleet(suRes.taskResults, 'su-independent'),
      'hive-realqueen': swarmbenchResultsFromFleet(hiveRes.taskResults, 'hive-realqueen'),
    });
    const pursuitDelta = report.deltas.find((d) => d.task === 'Pursuit')!;
    expect(pursuitDelta.suMean).toBeGreaterThan(0);
    expect(pursuitDelta.hiveMean).toBeGreaterThan(pursuitDelta.suMean!);
    expect(pursuitDelta.delta).toBeCloseTo(pursuitDelta.hiveMean! - pursuitDelta.suMean!, 6);
    // per-(task,arm) stat present with SE
    const suStat = report.stats.find((s) => s.arm === 'su-independent' && s.task === 'Pursuit')!;
    expect(suStat.scored).toBe(3);
    expect(suStat.se).toBeGreaterThanOrEqual(0);
    expect(report.caveats.length).toBe(3);
    expect(report.caveats[0]).toMatch(/FAIRNESS|AGGREGATED LOCAL/);
  });

  it('excludes infra-failed scenarios from the mean (not scored 0)', () => {
    const rows: SwarmScenarioResult[] = [
      { instanceId: 'Pursuit__a', task: 'Pursuit', arm: 'su-independent', score: 4 },
      { instanceId: 'Pursuit__b', task: 'Pursuit', arm: 'su-independent', score: null }, // infra
      { instanceId: 'Pursuit__c', task: 'Pursuit', arm: 'su-independent', score: 6 },
    ];
    const report = buildSwarmBenchReport({ 'su-independent': rows });
    const stat = report.stats.find((s) => s.arm === 'su-independent' && s.task === 'Pursuit')!;
    expect(stat.meanScore).toBe(5); // mean(4,6), the null excluded
    expect(stat.scored).toBe(2);
    expect(stat.attempted).toBe(3);
  });
});
