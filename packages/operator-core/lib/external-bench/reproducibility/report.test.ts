import { describe, expect, it } from 'vitest';
import type { TaskRunResult } from '@papercusp/bench-metrics';
import type { PreregRecord } from './schema';
import { buildRunReports } from './store';

const prereg = (config: Record<string, unknown> = {}): PreregRecord => ({
  runId: 'assigned-run', preregHash: 'frozen-hash', suites: ['swe-bench-pro'],
  config: { taskIds: ['a', 'b'], seeds: [0, 1, 2], arms: ['papercusp', 'baseline-b-native'], ...config },
  filePath: 'benchmarks/preregistrations/assigned-run.json', gitCommitted: true, createdAt: '2026-10-09T00:00:00Z',
});
const result = (over: Partial<TaskRunResult> = {}): TaskRunResult => ({
  runId: 'assigned-run', suite: 'swe-bench-pro', taskId: 'a', arm: 'papercusp', seed: 0,
  modality: 'diff', resolved: true, graderStatus: 'passed', graderFamily: 'official', graderVersion: 'pinned',
  generationStatus: 'completed', tokensIn: 1, tokensOut: 1, tokensTotal: 2, costUsd: 0.1,
  priceTableVersion: 'price-table-v1', wallClockMs: 10, turns: 1, capped: false, modelId: 'claude-opus-4-8',
  harnessVersion: 'current', preregHash: 'frozen-hash', rolloutId: 'r', createdAt: '2026-10-09T00:00:01Z', ...over,
});

describe('preregistered product reports', () => {
  it('retains missing task, seed and whole-arm outcomes from the frozen assignment', () => {
    const [report] = buildRunReports([result()], prereg());
    expect(report.assignment).toMatchObject({ basis: 'frozen', taskIds: ['a', 'b'], seeds: [0, 1, 2], preregHash: 'frozen-hash' });
    expect(report.arms[0]).toMatchObject({ tasks: 2, attempts: 1, absentTasks: 1, conditionalPassAt1: 1 });
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
    expect(report.arms[1]).toMatchObject({ arm: 'baseline-b-native', tasks: 2, attempts: 0, passAt1: 0, absentTasks: 2 });
    expect(report.frontier.map(point => point.arm)).toEqual(['papercusp']);
    expect(report.deltas).toEqual([]); // An absent arm has no measured cost for efficiency.
  });

  it('reports a wholly unattempted frozen run instead of erasing it', () => {
    const [report] = buildRunReports([], prereg());
    expect(report.arms).toHaveLength(2);
    expect(report.arms.every(arm => arm.tasks === 2 && arm.passAt1 === 0 && arm.attempts === 0)).toBe(true);
    expect(report.frontier).toEqual([]);
    expect(report.deltas).toEqual([]);
  });

  it('keeps agent timeout as an assigned outcome and grader outage inconclusive', () => {
    const [report] = buildRunReports([
      result({ generationStatus: 'timeout', resolved: null, graderStatus: 'error' }),
      result({ arm: 'baseline-b-native', resolved: null, graderStatus: 'error' }),
    ], prereg());
    expect(report.arms[0]).toMatchObject({ passAt1: 0, missingMeasurements: 0 });
    expect(report.arms[1]).toMatchObject({ passAt1: null, missingMeasurements: 1 });
    expect(report.deltas).toEqual([]);
  });

  it.each([
    { taskId: 'foreign' }, { arm: 'undeclared' }, { seed: 3 }, { runId: 'other-run' }, { suite: 'other-suite' },
  ])('refuses an out-of-assignment result %j', over => {
    expect(() => buildRunReports([result(over)], prereg())).toThrow(/frozen/);
  });

  it.each([{ seeds: [] }, { seeds: [0, 0] }, { arms: [] }, { taskIds: ['a', 'a'] }])('refuses malformed frozen assignment %j', config => {
    expect(() => buildRunReports([result()], prereg(config))).toThrow(/invalid frozen/);
  });

  it('supports the existing seed-count convention without inferring missing seeds from rows', () => {
    const [report] = buildRunReports([result()], prereg({ seeds: 3 }));
    expect(report.assignment?.seeds).toEqual([0, 1, 2]);
    expect(report.arms[0].passAt1).toBeCloseTo(1 / 6);
  });

  it('labels old observed-only evidence without inventing a preregistered population', () => {
    const legacy = prereg(); legacy.config = { model: 'old', seeds: 3 };
    expect(buildRunReports([result()], legacy)[0].assignment?.basis).toBe('observed');
    expect(buildRunReports([], legacy)).toEqual([]);
  });
});
