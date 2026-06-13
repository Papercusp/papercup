/**
 * Full-battery-green integration (HE-07, P-061) — the seeded scenario corpus runs end-to-end
 * through the SCORED generation runner and produces a scored DISTRIBUTION per scenario, with the
 * HE-06 un-gameable gate flowing through. Deterministic over the fake hive ports + a fake score
 * extractor (the live ports/extraction are owner-gated P-051); no LLM spend.
 */
import { describe, it, expect } from 'vitest';
import { runHiveEvalGeneration, type HiveEvalScoreExtractor, type HiveRunScoreInputs } from './generation-runner';
import { makeFakeHivePorts } from './run-harness';
import { createInMemoryHiveEvalStore } from './store';
import { HIVE_EVAL_SCENARIOS } from './scenarios';
import { computeParallelismStructure } from './scenario';
import { computeEfficiencyMetrics } from './efficiency-metrics';
import { computeSpeedMetrics } from './speed-metrics';
import { DEFAULT_HIVE_SCORE_RUBRIC_V1, hiveScoreRubricHash } from './scoring';
import type { OutcomeMetrics } from './outcome-metrics';
import type { HiveScenarioBatteryConfig } from './battery';
import type { InstanceManifest } from './store';

const INSTANCE: InstanceManifest = {
  instanceId: 'gen0-test-ws',
  workspaceId: 'ws-test',
  codeSha: 'test',
  genomeId: undefined,
  batterySliceId: 'hive-eval',
  createdAt: new Date(0),
};

const PER_ITEM_MS = 100;

/** A fake extractor: yields metric bundles built from the real compute fns, with the outcome
 *  controllable so a test can drive a gate-pass or a gate-fail generation. */
function fakeExtractor(outcomeFor: () => OutcomeMetrics): HiveEvalScoreExtractor {
  return {
    async extract({ scenario }) {
      const n = scenario.workItems.length;
      const ideal = computeParallelismStructure(scenario.workItems, () => PER_ITEM_MS).idealWallClockUnits;
      const inputs: HiveRunScoreInputs = {
        outcome: outcomeFor(),
        efficiency: computeEfficiencyMetrics({
          beesBusySamples: [n, n],
          beeCap: n,
          idleWhileReadyMs: 0,
          coordMessages: n,
          completedItems: n,
          beesSpawned: n,
          uselessBees: 0,
          collisions: 0,
          rework: 0,
          lockContentionMs: 0,
          totalTokens: 1000 * n,
          costUsd: 0.5 * n,
        }),
        speed: computeSpeedMetrics(scenario, {
          wallClockMs: ideal, // ratio ~1.0 — optimally parallel
          perItemDurationMs: Object.fromEntries(scenario.workItems.map((w) => [w.id, PER_ITEM_MS])),
          timeToFirstPlacementMs: 0,
          maxStuckMs: 0,
        }),
      };
      return inputs;
    },
  };
}

const goodOutcome = (): OutcomeMetrics => ({
  acceptancePass: true,
  plantedBugCaught: true,
  regressions: false,
  fabrication: { detected: false, fabricatedItems: [] },
  outcomeGatePassed: true,
});

const config = (repeats: number): HiveScenarioBatteryConfig => ({
  instance: INSTANCE,
  scenarios: HIVE_EVAL_SCENARIOS,
  repeats,
  seed: 1,
  budgetUsdCap: 1,
  beeCap: 4,
});

describe('runHiveEvalGeneration — full battery green (P-061)', () => {
  it('runs the whole corpus end-to-end and produces a scored distribution per scenario', async () => {
    const store = createInMemoryHiveEvalStore();
    const { ports, booted, tornDown } = makeFakeHivePorts();
    const repeats = 2;

    const result = await runHiveEvalGeneration(config(repeats), { store, ports, extractor: fakeExtractor(goodOutcome) });

    const expectedRuns = HIVE_EVAL_SCENARIOS.length * repeats; // 4 × 2 = 8
    expect(result.scores).toHaveLength(expectedRuns);
    expect(store.scores.size).toBe(expectedRuns); // every score persisted
    expect(result.scoreDistributions).toHaveLength(HIVE_EVAL_SCENARIOS.length);
    expect(result.rubricHash).toBe(hiveScoreRubricHash(DEFAULT_HIVE_SCORE_RUBRIC_V1));

    // No hive leaks — every booted throwaway hive was torn down.
    expect(tornDown.sort()).toEqual(booted.sort());

    for (const dist of result.scoreDistributions) {
      expect(dist.scoredRuns).toBe(repeats);
      expect(dist.outcomeGatePassRate).toBe(1); // every run did a good job
      expect(dist.composite.mean).toBeGreaterThan(7); // good-and-efficient
      expect(dist.composite.mean).toBeLessThanOrEqual(10);
      expect(dist.criticalPathRatio.mean).toBeCloseTo(1, 1); // optimally parallel
    }

    // A persisted score round-trips under its rubric hash.
    const first = result.scores[0];
    const row = await store.getScore(first.runId, result.rubricHash);
    expect(row).not.toBeNull();
    expect(row!.composite).toBeCloseTo(first.score.composite, 6);
    expect(row!.outcomeGatePassed).toBe(true);
  });

  it('a gate-failing generation scores zero across the board (the un-gameable gate flows through)', async () => {
    const store = createInMemoryHiveEvalStore();
    const { ports } = makeFakeHivePorts();
    const badOutcome = (): OutcomeMetrics => ({ ...goodOutcome(), acceptancePass: false, outcomeGatePassed: false });

    const result = await runHiveEvalGeneration(config(1), { store, ports, extractor: fakeExtractor(badOutcome) });

    expect(result.scores.every((s) => s.score.composite === 0)).toBe(true);
    for (const dist of result.scoreDistributions) {
      expect(dist.outcomeGatePassRate).toBe(0);
      expect(dist.composite.mean).toBe(0);
    }
  });

  it('errored runs (infra failure) are recorded but excluded from scoring', async () => {
    const store = createInMemoryHiveEvalStore();
    // The serial-pipeline scenario's runs all fail at drive → errored, no record, no score.
    const { ports } = makeFakeHivePorts((cell) =>
      cell.scenario.id === 'serial-pipeline' ? { throwAt: 'drive' } : {},
    );

    const result = await runHiveEvalGeneration(config(1), { store, ports, extractor: fakeExtractor(goodOutcome) });

    // serial-pipeline produced no scored run, so it has no score distribution row.
    expect(result.scoreDistributions.find((d) => d.scenarioId === 'serial-pipeline')).toBeUndefined();
    expect(result.scoreDistributions).toHaveLength(HIVE_EVAL_SCENARIOS.length - 1);
    // the errored run is still visible in the battery outcomes.
    expect(result.battery.outcomes.some((o) => o.scenarioId === 'serial-pipeline' && o.status === 'errored')).toBe(true);
  });
});
