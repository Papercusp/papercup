/**
 * METR HCAST task-set loader unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-001/P-007).
 *
 * Focus: the metr-hcast loaders (`metr-hcast-pilot` / `metr-hcast` / `metr-hcast-horizon` /
 * `metr-hcast-custom`) read the corpus JSONL, map it through {@link metrHcastRowToBenchTask} (carrying
 * `benchmark: 'metr-hcast'`, the in-container image + taskhelper args + the human-time baseline in
 * graderMeta, NO repo/baseCommit), that `metr-hcast-horizon` filters to baseline-carrying tasks, that
 * knownTaskSets() advertises the sets, and a missing corpus throws honestly. Temp fixtures + env overrides
 * → host-independent (no network / no docker).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { knownTaskSets, loadBenchTaskSet, metrHcastRowToBenchTask } from './task-sets';

let dir: string;

// Representative corpus rows (the schema the P-001 vendoring writes): a horizon-eligible task (has a
// human-time baseline) and a runnable-but-not-eligible task (no released baseline).
const ROW_ELIGIBLE = {
  instanceId: 'local_research__atari_epochs',
  taskId: 'local_research/atari_epochs',
  family: 'local_research',
  task: 'atari_epochs',
  sampleId: 'atari_epochs',
  version: '0.4.0',
  image: 'registry-1.docker.io/metrevals/public-tasks:local_research-0.4.0',
  problemStatement: 'How many epochs did the original PPO paper use for Atari?',
  humanMinutes: 1.8,
  humanSource: 'baseline',
  horizonEligible: true,
};
const ROW_NOT_ELIGIBLE = {
  instanceId: 'crossword__5x5_verify',
  taskId: 'crossword/5x5_verify',
  family: 'crossword',
  task: '5x5_verify',
  image: 'registry-1.docker.io/metrevals/public-tasks:crossword-0.1.8',
  humanMinutes: null,
  humanSource: null,
  horizonEligible: false,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'metr-'));
  writeFileSync(
    join(dir, 'tasks.jsonl'),
    [JSON.stringify(ROW_ELIGIBLE), JSON.stringify(ROW_NOT_ELIGIBLE)].join('\n') + '\n',
    'utf8',
  );
  writeFileSync(join(dir, 'pilot.jsonl'), JSON.stringify(ROW_ELIGIBLE) + '\n', 'utf8');
  process.env.PAPERCUSP_BENCH_METR_HCAST_JSONL = join(dir, 'tasks.jsonl');
  process.env.PAPERCUSP_BENCH_METR_HCAST_PILOT_JSONL = join(dir, 'pilot.jsonl');
});

afterEach(() => {
  delete process.env.PAPERCUSP_BENCH_METR_HCAST_JSONL;
  delete process.env.PAPERCUSP_BENCH_METR_HCAST_PILOT_JSONL;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('metrHcastRowToBenchTask', () => {
  it('maps to the metr-hcast family with in-container grader meta (image + taskhelper args + baseline)', () => {
    const t = metrHcastRowToBenchTask(ROW_ELIGIBLE);
    expect(t.benchmark).toBe('metr-hcast');
    expect(t.instanceId).toBe('local_research__atari_epochs');
    expect(t.problemStatement).toMatch(/PPO paper/);
    expect(t.repo).toBeUndefined();
    expect(t.baseCommit).toBeUndefined();
    expect(t.graderMeta.image).toBe('registry-1.docker.io/metrevals/public-tasks:local_research-0.4.0');
    expect(t.graderMeta.family).toBe('local_research');
    expect(t.graderMeta.task).toBe('atari_epochs');
    expect(t.graderMeta.sampleId).toBe('atari_epochs');
    expect(t.graderMeta.humanMinutes).toBe(1.8);
    expect(t.graderMeta.humanSource).toBe('baseline');
    expect(t.graderMeta.horizonEligible).toBe(true);
  });

  it('defaults sampleId to task, derives horizonEligible from humanMinutes, defaults a problemStatement', () => {
    const t = metrHcastRowToBenchTask({
      instanceId: 'esolang__broccoli_collatz',
      family: 'esolang',
      task: 'broccoli_collatz',
      image: 'metrevals/public-tasks:esolang-0.1.10',
      humanMinutes: 18.5,
    });
    expect(t.graderMeta.sampleId).toBe('broccoli_collatz');
    expect(t.graderMeta.horizonEligible).toBe(true);
    expect(t.problemStatement).toMatch(/taskhelper setup/);
  });

  it('marks a task with no humanMinutes as not horizon-eligible', () => {
    const t = metrHcastRowToBenchTask(ROW_NOT_ELIGIBLE);
    expect(t.graderMeta.humanMinutes).toBeNull();
    expect(t.graderMeta.horizonEligible).toBe(false);
  });
});

describe('loadBenchTaskSet (METR HCAST)', () => {
  it('metr-hcast-pilot reads the pilot subset', async () => {
    const tasks = await loadBenchTaskSet('metr-hcast-pilot');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('local_research__atari_epochs');
    expect(tasks[0].benchmark).toBe('metr-hcast');
  });

  it('metr-hcast reads the full corpus (runnable, incl. non-eligible)', async () => {
    const tasks = await loadBenchTaskSet('metr-hcast');
    expect(tasks.map((t) => t.instanceId).sort()).toEqual(['crossword__5x5_verify', 'local_research__atari_epochs']);
  });

  it('metr-hcast-horizon filters to baseline-carrying (horizon-eligible) tasks only', async () => {
    const tasks = await loadBenchTaskSet('metr-hcast-horizon');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('local_research__atari_epochs');
    expect(tasks[0].graderMeta.horizonEligible).toBe(true);
  });

  it('metr-hcast-custom filters to the requested task ids', async () => {
    const tasks = await loadBenchTaskSet('metr-hcast-custom', ['crossword__5x5_verify']);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].instanceId).toBe('crossword__5x5_verify');
  });

  it('metr-hcast-custom with an empty id list rejects', async () => {
    await expect(loadBenchTaskSet('metr-hcast-custom', [])).rejects.toThrow(/non-empty taskIds/);
  });

  it('a missing corpus throws an honest not-vendored error', async () => {
    process.env.PAPERCUSP_BENCH_METR_HCAST_JSONL = join(dir, 'does-not-exist.jsonl');
    await expect(loadBenchTaskSet('metr-hcast')).rejects.toThrow(/not found|vendor/i);
  });
});

describe('knownTaskSets', () => {
  it('advertises the METR HCAST pilot + horizon + full sets with counts from the fixtures', () => {
    const sets = knownTaskSets();
    const pilot = sets.find((s) => s.id === 'metr-hcast-pilot');
    const horizon = sets.find((s) => s.id === 'metr-hcast-horizon');
    const full = sets.find((s) => s.id === 'metr-hcast');
    expect(pilot?.count).toBe(1);
    expect(horizon?.count).toBe(1); // only the eligible row carries a baseline
    expect(full?.count).toBe(2);
  });
});
