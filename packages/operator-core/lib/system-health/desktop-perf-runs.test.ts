import { describe, expect, it } from 'vitest';
import {
  computeDesktopPerfTrend,
  extractDesktopPerfMeasures,
  summarizeMeasureStatus,
  toRunStatus,
  type DesktopPerfRun,
} from './desktop-perf-runs';
import type { AdminTestCheckResult, DesktopPerfMeasure } from '../admin-test-suites-shared';

function run(id: string, createdTs: number, measures: DesktopPerfMeasure[]): DesktopPerfRun {
  return { id, workspaceId: 'default', createdTs, source: 'admin-suite', status: 'pass', gitSha: null, buildSha: null, runId: null, measures };
}

describe('extractDesktopPerfMeasures', () => {
  it('flattens measures across check results and skips checks without any', () => {
    const results: AdminTestCheckResult[] = [
      {
        suiteId: 'desktop-performance', id: 'a', label: 'A', status: 'pass', expected: '', actual: '', durationMs: 1,
        measures: [{ key: 'route:harness-warm', value: 900, unit: 'ms', budget: 1500, ok: true }],
      },
      // no measures — contributes nothing
      { suiteId: 'desktop-performance', id: 'b', label: 'B', status: 'fail', expected: '', actual: '', durationMs: 1 },
      {
        suiteId: 'desktop-performance', id: 'c', label: 'C', status: 'fail', expected: '', actual: '', durationMs: 1,
        measures: [
          { key: 'memory:rss-kb', value: 2_000_000, unit: 'kb', budget: 3_670_016, ok: true },
          { key: 'chaos:frame-drops', value: 12, unit: 'count', budget: 8, ok: false },
        ],
      },
    ];
    const measures = extractDesktopPerfMeasures(results);
    expect(measures.map((m) => m.key)).toEqual(['route:harness-warm', 'memory:rss-kb', 'chaos:frame-drops']);
    expect(measures[2]).toMatchObject({ value: 12, unit: 'count', budget: 8, ok: false });
  });

  it('coerces missing/invalid fields to safe defaults', () => {
    const results = [
      {
        suiteId: 'desktop-performance', id: 'a', label: 'A', status: 'pass', expected: '', actual: '', durationMs: 1,
        measures: [{ key: 'x', value: Number.NaN as unknown as number, unit: undefined as never, budget: undefined as never, ok: undefined as never }],
      } as unknown as AdminTestCheckResult,
    ];
    const [m] = extractDesktopPerfMeasures(results);
    expect(m).toMatchObject({ key: 'x', value: 0, unit: 'ms', budget: null, ok: true });
  });
});

describe('summarizeMeasureStatus / toRunStatus', () => {
  it('flags fail when any budgeted measure missed its budget', () => {
    expect(summarizeMeasureStatus([{ key: 'a', value: 10, unit: 'ms', budget: 5, ok: false }])).toBe('fail');
    expect(summarizeMeasureStatus([{ key: 'a', value: 1, unit: 'ms', budget: 5, ok: true }])).toBe('pass');
    // an unbudgeted (budget:null) miss is NOT a fail — recorded, never a regression
    expect(summarizeMeasureStatus([{ key: 'a', value: 10, unit: 'ms', budget: null, ok: false }])).toBe('pass');
  });

  it('collapses skip to pass and preserves warn/fail', () => {
    expect(toRunStatus('skip')).toBe('pass');
    expect(toRunStatus('pass')).toBe('pass');
    expect(toRunStatus('warn')).toBe('warn');
    expect(toRunStatus('fail')).toBe('fail');
  });
});

describe('computeDesktopPerfTrend', () => {
  it('diffs each measure against the nearest older run with the same key', () => {
    // newest first
    const runs: DesktopPerfRun[] = [
      run('r3', 3000, [{ key: 'route:harness-warm', value: 1200, unit: 'ms', budget: 1500, ok: true }]),
      run('r2', 2000, [{ key: 'route:harness-warm', value: 1000, unit: 'ms', budget: 1500, ok: true }]),
      run('r1', 1000, [{ key: 'route:harness-warm', value: 800, unit: 'ms', budget: 1500, ok: true }]),
    ];
    const trend = computeDesktopPerfTrend(runs);
    // r3 vs r2: +200ms, +20%
    expect(trend[0].measures[0]).toMatchObject({ prevValue: 1000, deltaValue: 200, deltaPct: 0.2 });
    // r2 vs r1: +200ms, +25%
    expect(trend[1].measures[0]).toMatchObject({ prevValue: 800, deltaValue: 200, deltaPct: 0.25 });
    // r1 is the oldest — no prior
    expect(trend[2].measures[0]).toMatchObject({ prevValue: null, deltaValue: null, deltaPct: null });
  });

  it('skips over an intervening run that lacks the measure key', () => {
    const runs: DesktopPerfRun[] = [
      run('r3', 3000, [{ key: 'interaction:plan-popup-open', value: 500, unit: 'ms', budget: 1500, ok: true }]),
      run('r2', 2000, [{ key: 'route:harness-warm', value: 1000, unit: 'ms', budget: 1500, ok: true }]), // no interaction key
      run('r1', 1000, [{ key: 'interaction:plan-popup-open', value: 400, unit: 'ms', budget: 1500, ok: true }]),
    ];
    const trend = computeDesktopPerfTrend(runs);
    // r3's interaction diffs against r1 (r2 lacks the key)
    expect(trend[0].measures[0]).toMatchObject({ prevValue: 400, deltaValue: 100 });
  });

  it('leaves deltaPct null when the previous value is 0', () => {
    const runs: DesktopPerfRun[] = [
      run('r2', 2000, [{ key: 'chaos:frame-drops', value: 3, unit: 'count', budget: 8, ok: true }]),
      run('r1', 1000, [{ key: 'chaos:frame-drops', value: 0, unit: 'count', budget: 8, ok: true }]),
    ];
    const trend = computeDesktopPerfTrend(runs);
    expect(trend[0].measures[0]).toMatchObject({ prevValue: 0, deltaValue: 3, deltaPct: null });
  });

  it('preserves run identity fields', () => {
    const runs: DesktopPerfRun[] = [
      { ...run('r1', 1000, []), source: 'wdio', status: 'warn', gitSha: 'abc123', runId: 'testrun-1' },
    ];
    const [pt] = computeDesktopPerfTrend(runs);
    expect(pt).toMatchObject({ id: 'r1', source: 'wdio', status: 'warn', gitSha: 'abc123', runId: 'testrun-1' });
  });
});
