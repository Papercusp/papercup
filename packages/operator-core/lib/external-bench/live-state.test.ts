import { describe, expect, it } from 'vitest';
import { aggregateBenchRunLiveState, type LiveSpawnRow, type LiveSampleRow } from './live-state';

const NOW = 2_000_000_000_000;
const queen = (startedMsAgo: number, status = 'running', restartCount = 0): LiveSpawnRow => ({
  childRole: 'mug', status, startedAtMs: NOW - startedMsAgo, finishedAtMs: null, restartCount,
});
const bee = (status: string): LiveSpawnRow => ({ childRole: 'cup', status, startedAtMs: NOW - 60_000, finishedAtMs: null, restartCount: 0 });
const sample = (model: string, costUsd = 1): LiveSampleRow => ({ model, modelClass: null, costUsd });

describe('aggregateBenchRunLiveState', () => {
  it('a healthy live run: queen alive, bees bucketed, opus-only, spend + wall', () => {
    const st = aggregateBenchRunLiveState({
      runId: 'r', status: 'running', potSlug: 'hive-r', startedAtMs: NOW - 300_000, nowMs: NOW,
      agents: [queen(600_000), bee('running'), bee('working'), bee('done'), bee('evicted'), bee('failed')],
      samples: [sample('claude-opus-4-8'), sample('opus')],
      taskCounts: { todo: 2, in_progress: 1, collected: 3, graded: 5 },
    });
    expect(st.isLive).toBe(true);
    expect(st.queen.alive).toBe(true);
    expect(st.queen.ageSec).toBe(600);
    expect(st.queen.reclaims).toBe(0);
    expect(st.bees.total).toBe(5);
    expect(st.bees.working).toBe(2); // running + working
    expect(st.bees.done).toBe(1);
    expect(st.bees.evicted).toBe(1);
    expect(st.bees.failed).toBe(1);
    expect(st.models.opusOnly).toBe(true);
    expect(st.models.nonOpusSamples).toBe(0);
    expect(st.spendUsd).toBe(2);
    expect(st.wallSec).toBe(300);
    expect(st.taskProgress.total).toBe(11);
    expect(st.taskProgress.graded).toBe(5);
  });

  it('detects a non-opus model leak', () => {
    const st = aggregateBenchRunLiveState({
      runId: 'r', status: 'running', potSlug: 'hive-r', startedAtMs: NOW - 1000, nowMs: NOW,
      agents: [queen(600_000)],
      samples: [sample('claude-opus-4-8'), sample('claude-sonnet-4-6'), sample('claude-haiku-4-5')],
      taskCounts: {},
    });
    expect(st.models.opusOnly).toBe(false);
    expect(st.models.nonOpusSamples).toBe(2);
    expect(st.models.distinctModels).toContain('claude-sonnet-4-6');
  });

  it('counts queen reclaims (a respawned queen)', () => {
    const st = aggregateBenchRunLiveState({
      runId: 'r', status: 'running', potSlug: 'hive-r', startedAtMs: NOW - 1000, nowMs: NOW,
      agents: [queen(600_000, 'done'), queen(120_000, 'running', 1)],
      samples: [], taskCounts: {},
    });
    // 2 queen rows (1 extra) + 1 restart = 2 reclaims; newest (running, 120s) is alive.
    expect(st.queen.reclaims).toBe(2);
    expect(st.queen.alive).toBe(true);
    expect(st.queen.ageSec).toBe(120);
  });

  it('a completed/imported run (no hive): not live, signals null', () => {
    const st = aggregateBenchRunLiveState({
      runId: 'm3', status: 'done', potSlug: null, startedAtMs: null, nowMs: NOW,
      agents: [], samples: [], taskCounts: { graded: 11 },
    });
    expect(st.isLive).toBe(false);
    expect(st.queen.alive).toBeNull();
    expect(st.models.opusOnly).toBeNull();
    expect(st.spendUsd).toBeNull();
    expect(st.taskProgress.graded).toBe(11);
  });

  it('no samples yet → opus-only unknown (null), not a false pass', () => {
    const st = aggregateBenchRunLiveState({
      runId: 'r', status: 'running', potSlug: 'hive-r', startedAtMs: NOW - 1000, nowMs: NOW,
      agents: [queen(60_000)], samples: [], taskCounts: {},
    });
    expect(st.models.opusOnly).toBeNull();
    expect(st.models.totalSamples).toBe(0);
  });
});
