import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isScoredRecord,
  readRunResults,
  appendRunResult,
  scoredTrials,
  missingTrials,
  isRunComplete,
  type FrontierSweResultRecord,
} from './frontier-swe-resume';

const rec = (over: Partial<FrontierSweResultRecord>): FrontierSweResultRecord => ({
  instanceId: 'cranelift-codegen-opt',
  seed: 0,
  score: 0.5,
  resolved: false,
  graderStatus: 'failed',
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'frontier-resume-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('isScoredRecord', () => {
  it('a non-infra row with a numeric score is scored', () => expect(isScoredRecord(rec({ score: 0 }))).toBe(true));
  it('an infra row (error/timeout) is NOT scored — it gets re-run', () => {
    expect(isScoredRecord(rec({ graderStatus: 'error', score: null, resolved: null }))).toBe(false);
    expect(isScoredRecord(rec({ graderStatus: 'timeout', score: null, resolved: null }))).toBe(false);
  });
  it('a row with neither score nor resolved is not scored', () =>
    expect(isScoredRecord(rec({ score: null, resolved: null, graderStatus: 'passed' }))).toBe(false));
});

describe('readRunResults / appendRunResult', () => {
  it('missing file → []', () => expect(readRunResults(join(dir, 'nope.jsonl'))).toEqual([]));

  it('append → read round-trips, creating the dir', () => {
    const p = join(dir, 'nested', 'results.jsonl');
    appendRunResult(p, rec({ seed: 0, score: 0.6 }));
    appendRunResult(p, rec({ seed: 1, score: 0.4 }));
    const got = readRunResults(p);
    expect(got).toHaveLength(2);
    expect(got.map((r) => r.seed)).toEqual([0, 1]);
  });

  it('skips a torn final line (interrupted write)', () => {
    const p = join(dir, 'results.jsonl');
    writeFileSync(p, JSON.stringify(rec({ seed: 0 })) + '\n' + '{"instanceId":"x","seed":1,'); // truncated
    expect(readRunResults(p)).toHaveLength(1);
  });
});

describe('scoredTrials + missingTrials (the resume plan)', () => {
  const records = [
    rec({ instanceId: 'a', seed: 0, score: 0.5 }),
    rec({ instanceId: 'a', seed: 1, score: 0.6 }),
    rec({ instanceId: 'a', seed: 2, score: 0.7 }),
    rec({ instanceId: 'a', seed: 3, graderStatus: 'error', score: null, resolved: null }), // infra → re-run
    rec({ instanceId: 'b', seed: 0, score: 1.0, resolved: true }),
  ];

  it('scoredTrials counts only non-infra results', () => {
    const m = scoredTrials(records);
    expect([...(m.get('a') ?? [])].sort()).toEqual([0, 1, 2]); // seed 3 was infra → not counted
    expect([...(m.get('b') ?? [])]).toEqual([0]);
  });

  it('missingTrials returns the seeds still needed (infra seed re-listed)', () => {
    const miss = missingTrials(['a', 'b', 'c'], 5, records);
    const a = miss.find((m) => m.instanceId === 'a')!;
    expect(a.seeds).toEqual([3, 4]); // 0,1,2 scored; 3 infra → re-run; 4 never attempted
    const b = miss.find((m) => m.instanceId === 'b')!;
    expect(b.seeds).toEqual([1, 2, 3, 4]); // only seed 0 done
    const c = miss.find((m) => m.instanceId === 'c')!;
    expect(c.seeds).toEqual([0, 1, 2, 3, 4]); // untouched
  });

  it('a fully-scored task is omitted from the resume plan', () => {
    const full = [0, 1, 2, 3, 4].map((s) => rec({ instanceId: 'a', seed: s, score: 0.5 }));
    expect(missingTrials(['a'], 5, full)).toEqual([]);
    expect(isRunComplete(['a'], 5, full)).toBe(true);
  });

  it('respects the arm filter', () => {
    const multi = [
      rec({ instanceId: 'a', seed: 0, arm: 'hive', score: 0.5 }),
      rec({ instanceId: 'a', seed: 0, arm: 'opus', score: 0.5 }),
    ];
    expect(missingTrials(['a'], 1, multi, 'hive')).toEqual([]); // hive seed 0 done
    expect(missingTrials(['a'], 1, multi, 'dist-broadcast')[0].seeds).toEqual([0]); // this arm hasn't run
  });

  it('rejects k < 1', () => expect(() => missingTrials(['a'], 0, records)).toThrow());
});
