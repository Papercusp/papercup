/**
 * METR HCAST accumulation unit tests (plan benchmark-suite-metr-hcast-2026-06-17 P-005).
 * Focus: per-arm JSONL append/load round-trip + coverage counting (distinct scored/baselined tasks) — the
 * incremental persistence that lets brief opus windows bank rows toward the horizon. Temp dir; no docker.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accumCoverage, appendAccumResult, loadAccumulatedResults } from './metr-hcast-accum';
import type { MetrHcastTaskResult } from './metr-hcast-runner';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'metr-accum-')); });
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const res = (id: string, hm: number | null, resolved: boolean | null, seed = '0'): MetrHcastTaskResult => ({
  attempt: { arm: 'x', blueprintId: 'metr-hcast', instanceId: id, seed, diff: '', tokensIn: 1, tokensOut: 1, costUsd: 0, turns: 1, wallClockMs: 1, trajectoryRef: '', stopReason: resolved === null ? 'error' : 'done', armMeta: { family: id.split('__')[0] } },
  grade: { instanceId: id, prefix: seed, resolved, score: resolved === null ? null : resolved ? 1 : 0, graderFamily: 'metr-hcast', graderVersion: '1', rawGraderOutput: {} },
  humanMinutes: hm,
});

describe('append + load round-trip', () => {
  it('appends per-arm and loads the union back', () => {
    appendAccumResult(dir, 'papercusp', res('f__a', 10, true));
    appendAccumResult(dir, 'papercusp', res('f__b', 20, false));
    appendAccumResult(dir, 'baseline-a-ablation', res('f__a', 10, false));
    const loaded = loadAccumulatedResults(dir);
    expect(loaded['papercusp']).toHaveLength(2);
    expect(loaded['baseline-a-ablation']).toHaveLength(1);
    expect(loaded['papercusp'][0].attempt.instanceId).toBe('f__a');
    expect(loaded['papercusp'][1].grade.resolved).toBe(false);
  });

  it('an empty/absent dir loads to {}', () => {
    expect(loadAccumulatedResults(dir)).toEqual({});
  });

  it('accumulates across calls (a later partial run appends, not overwrites)', () => {
    appendAccumResult(dir, 'papercusp', res('f__a', 10, true, '0'));
    appendAccumResult(dir, 'papercusp', res('f__a', 10, false, '1')); // a 2nd sample of the same task
    expect(loadAccumulatedResults(dir)['papercusp']).toHaveLength(2);
  });
});

describe('accumCoverage', () => {
  it('counts DISTINCT baselined + scored tasks per arm (infra-null excluded from scored)', () => {
    const rows = [
      res('f__a', 10, true),
      res('f__a', 10, false, '1'), // same task, still 1 distinct scored
      res('f__b', 20, null), //        baselined but all-infra → not scored
      res('f__c', null, true), //      no baseline → neither
    ];
    const cov = accumCoverage({ papercusp: rows });
    expect(cov['papercusp'].baselinedTasks).toBe(2); // f__a, f__b
    expect(cov['papercusp'].scoredTasks).toBe(1); // only f__a has a scored attempt
  });
});
