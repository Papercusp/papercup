/**
 * Unit tests for the LIVE capture → replay-extractor contract (P-063 / D-011). PURE — no DB / git /
 * LLM: the spawn-row transforms and the replay extractor are exercised over synthetic captures, the
 * same boundary HE-04/05 draw. The actual live capture (DB/git/acceptance reads) is integration-
 * tested where the rows are real; the owner-armed whole-Hive drive is P-051.
 */
import { describe, it, expect } from 'vitest';
import {
  packLiveRunCapture,
  readLiveRunCapture,
  beesBusySamplesFromIntervals,
  behaviorFromSpawnRows,
  timingsFromSpawnRows,
  makeReplayExtractor,
  type LiveRunCapture,
  type SpawnRunRow,
} from './live-capture';
import { getScenario } from './scenarios';
import type { HiveScenarioRunRecord } from './run-harness';
import type { RunGroundTruth } from './outcome-metrics';
import { computeParallelismStructure } from './scenario';

const scenario = getScenario('serial-pipeline')!; // w1→w2→w3→w4, plantedBug at src/ranker.js#topN

function spawn(p: Partial<SpawnRunRow> & { spawnId: string }): SpawnRunRow {
  return { featureId: null, status: 'done', startedAtMs: 0, finishedAtMs: null, durationMs: null, ...p };
}

/** A clean capture: acceptance passed, bug caught, no regression, every item genuinely done. */
function cleanCapture(): LiveRunCapture {
  const truth: RunGroundTruth = {
    reviewOutput: `validator: defect at ${scenario.plantedBug.location} fixed`,
    preTests: [{ name: 't1', passed: true }],
    postTests: [{ name: 't1', passed: true }],
    workItems: scenario.workItems.map((w) => ({ workItemId: w.id, claimedDone: true, actuallyDone: true, hasCommit: true })),
  };
  return {
    acceptance: { passed: true, output: 'acceptance ok' },
    groundTruth: truth,
    behavior: behaviorFromSpawnRows(
      scenario.workItems.map((w, i) => spawn({ spawnId: `s${i}`, featureId: w.id, startedAtMs: i * 100, finishedAtMs: i * 100 + 50, durationMs: 50 })),
      { beeCap: 4, completedFeatureIds: new Set(scenario.workItems.map((w) => w.id)) },
    ),
    timings: timingsFromSpawnRows(
      scenario.workItems.map((w, i) => spawn({ spawnId: `s${i}`, featureId: w.id, startedAtMs: i * 100, finishedAtMs: i * 100 + 50, durationMs: 50 })),
      scenario,
      { wallClockMs: 1000, runStartMs: 0 },
    ),
  };
}

function recordWith(extra: Record<string, unknown> | undefined): HiveScenarioRunRecord {
  return {
    runId: 'run-1',
    instanceId: 'inst',
    scenarioId: scenario.id,
    shape: scenario.shape,
    repeat: 0,
    seed: 1,
    budgetUsdCap: 5,
    beeCap: 4,
    startedAt: new Date(0),
    finishedAt: new Date(1000),
    observations: {
      terminalState: 'drained',
      wallClockMs: 1000,
      frontierDrained: true,
      workItemsTotal: scenario.workItems.length,
      workItemsCompleted: scenario.workItems.length,
      costUsd: 0,
      repoPath: '/gone/after/teardown',
      extra,
    },
    parallelism: computeParallelismStructure(scenario.workItems),
    distilledTrace: 'trace',
    traceRef: 'ref://run-1',
  };
}

describe('beesBusySamplesFromIntervals (pure parallelism proxy)', () => {
  it('non-overlapping spawns → serial (all-1 samples)', () => {
    const rows = [
      spawn({ spawnId: 'a', startedAtMs: 0, finishedAtMs: 100 }),
      spawn({ spawnId: 'b', startedAtMs: 100, finishedAtMs: 200 }),
    ];
    const samples = beesBusySamplesFromIntervals(rows);
    expect(samples.every((s) => s === 1)).toBe(true);
    expect(Math.max(...samples)).toBe(1);
  });

  it('overlapping spawns → concurrency >1 in the overlap window', () => {
    const rows = [
      spawn({ spawnId: 'a', startedAtMs: 0, finishedAtMs: 100 }),
      spawn({ spawnId: 'b', startedAtMs: 50, finishedAtMs: 150 }),
    ];
    expect(Math.max(...beesBusySamplesFromIntervals(rows))).toBe(2);
  });

  it('no rows → empty samples (utilization 0)', () => {
    expect(beesBusySamplesFromIntervals([])).toEqual([]);
  });
});

describe('behaviorFromSpawnRows (pure)', () => {
  it('counts spawns, completed items, and useless bees (no completed feature)', () => {
    const rows = [
      spawn({ spawnId: 's1', featureId: 'w1' }),
      spawn({ spawnId: 's2', featureId: 'w2' }),
      spawn({ spawnId: 's3', featureId: null }), // no feature → useless
      spawn({ spawnId: 's4', featureId: 'w9' }), // served an item that never completed → useless
    ];
    const b = behaviorFromSpawnRows(rows, { beeCap: 4, completedFeatureIds: new Set(['w1', 'w2']) });
    expect(b.beesSpawned).toBe(4);
    expect(b.completedItems).toBe(2);
    expect(b.uselessBees).toBe(2);
    expect(b.beeCap).toBe(4);
  });

  it('EKG-sourced fields pass through; absent ⇒ 0 (the conservative floor)', () => {
    const rows = [spawn({ spawnId: 's1', featureId: 'w1' })];
    const withEkg = behaviorFromSpawnRows(rows, {
      beeCap: 2,
      completedFeatureIds: new Set(['w1']),
      ekg: { coordMessages: 12, collisions: 3, costUsd: 1.5, totalTokens: 4000 },
    });
    expect(withEkg.coordMessages).toBe(12);
    expect(withEkg.collisions).toBe(3);
    expect(withEkg.costUsd).toBe(1.5);
    expect(withEkg.totalTokens).toBe(4000);

    const noEkg = behaviorFromSpawnRows(rows, { beeCap: 2, completedFeatureIds: new Set(['w1']) });
    expect(noEkg.coordMessages).toBe(0);
    expect(noEkg.collisions).toBe(0);
    expect(noEkg.costUsd).toBe(0);
    expect(noEkg.lockContentionMs).toBe(0);
  });
});

describe('timingsFromSpawnRows (pure)', () => {
  it('per-item duration = the longest spawn that served the item; ttfp from run start', () => {
    const rows = [
      spawn({ spawnId: 's1', featureId: 'w1', startedAtMs: 200, durationMs: 30 }),
      spawn({ spawnId: 's2', featureId: 'w1', startedAtMs: 240, durationMs: 80 }), // retry — longer
      spawn({ spawnId: 's3', featureId: 'w2', startedAtMs: 400, durationMs: 50 }),
    ];
    const t = timingsFromSpawnRows(rows, scenario, { wallClockMs: 1000, runStartMs: 100 });
    expect(t.perItemDurationMs.w1).toBe(80); // the longer retry
    expect(t.perItemDurationMs.w2).toBe(50);
    expect(t.perItemDurationMs.w3).toBe(0); // never served
    expect(t.timeToFirstPlacementMs).toBe(100); // 200 - 100
    expect(t.maxStuckMs).toBe(0); // first-live-run default
  });

  it('falls back to finished-started when durationMs is absent', () => {
    const rows = [spawn({ spawnId: 's1', featureId: 'w1', startedAtMs: 0, finishedAtMs: 70, durationMs: null })];
    expect(timingsFromSpawnRows(rows, scenario, { wallClockMs: 70, runStartMs: 0 }).perItemDurationMs.w1).toBe(70);
  });
});

describe('makeReplayExtractor (the live HiveEvalScoreExtractor)', () => {
  it('replays a clean capture → outcome gate PASSES, efficiency + speed computed', async () => {
    const record = recordWith(packLiveRunCapture(cleanCapture()));
    const inputs = await makeReplayExtractor().extract({ record, scenario });
    expect(inputs.outcome.acceptancePass).toBe(true);
    expect(inputs.outcome.plantedBugCaught).toBe(true);
    expect(inputs.outcome.fabrication.detected).toBe(false);
    expect(inputs.outcome.outcomeGatePassed).toBe(true);
    expect(inputs.outcome.regressions).toBe(false);
    expect(inputs.efficiency.parallelismUtilization).toBeGreaterThan(0);
    expect(inputs.speed.criticalPathRatio).toBeGreaterThan(0);
    expect(inputs.speed.criticalPath.length).toBeGreaterThan(0);
  });

  it('a fabricated DONE in the capture → outcome gate FAILS (D-005)', async () => {
    const cap = cleanCapture();
    cap.groundTruth.workItems[0] = { workItemId: scenario.workItems[0].id, claimedDone: true, actuallyDone: false, hasCommit: false };
    const inputs = await makeReplayExtractor().extract({ record: recordWith(packLiveRunCapture(cap)), scenario });
    expect(inputs.outcome.fabrication.detected).toBe(true);
    expect(inputs.outcome.fabrication.fabricatedItems).toContain(scenario.workItems[0].id);
    expect(inputs.outcome.outcomeGatePassed).toBe(false);
  });

  it('a failed acceptance → outcome gate FAILS even with the bug caught', async () => {
    const cap = cleanCapture();
    cap.acceptance = { passed: false, output: 'acceptance.mjs exited 1' };
    const inputs = await makeReplayExtractor().extract({ record: recordWith(packLiveRunCapture(cap)), scenario });
    expect(inputs.outcome.acceptancePass).toBe(false);
    expect(inputs.outcome.outcomeGatePassed).toBe(false);
  });

  it('throws a descriptive error when the record carries no capture (non-live record)', async () => {
    await expect(makeReplayExtractor().extract({ record: recordWith(undefined), scenario })).rejects.toThrow(
      /no LiveRunCapture/,
    );
  });
});

describe('pack/read round-trip', () => {
  it('packLiveRunCapture ↔ readLiveRunCapture preserves the capture; a bad shape reads null', () => {
    const cap = cleanCapture();
    expect(readLiveRunCapture(recordWith(packLiveRunCapture(cap)))).toEqual(cap);
    expect(readLiveRunCapture(recordWith({ capture: { bogus: true } }))).toBeNull();
    expect(readLiveRunCapture(recordWith(undefined))).toBeNull();
  });
});
