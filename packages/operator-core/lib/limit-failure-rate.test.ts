/**
 * limit-failure-rate.test — WI-839 metric #1. Pure aggregation + grading with
 * an injected runQuery, so these are deterministic unit tests (mirrors
 * code-run-adoption.test.ts's structure).
 */
import { describe, it, expect } from 'vitest';
import {
  rollupLimitFailures,
  readLimitFailureRate,
  gradeLimitFailureRate,
  LIMIT_FAILURE_RATE_SQL,
  LIMIT_FAILURE_HEALTHY_BELOW,
  LIMIT_FAILURE_DEGRADED_BELOW,
  type LimitFailureRow,
} from './limit-failure-rate';

describe('rollupLimitFailures — folds per-tool rows, worst offender first', () => {
  it('sums totalErrs and sorts byTool desc by errs', () => {
    const rows: LimitFailureRow[] = [
      { toolName: 'a', errs: 3, lastSeen: null, sample: null },
      { toolName: 'b', errs: 10, lastSeen: null, sample: null },
      { toolName: 'c', errs: 5, lastSeen: null, sample: null },
    ];
    const roll = rollupLimitFailures(rows);
    expect(roll.totalErrs).toBe(18);
    expect(roll.byTool.map((r) => r.toolName)).toEqual(['b', 'c', 'a']);
  });

  it('empty input → zero total, empty breakdown', () => {
    const roll = rollupLimitFailures([]);
    expect(roll.totalErrs).toBe(0);
    expect(roll.byTool).toEqual([]);
  });

  it('ties break by tool name for determinism', () => {
    const roll = rollupLimitFailures([
      { toolName: 'z', errs: 2, lastSeen: null, sample: null },
      { toolName: 'a', errs: 2, lastSeen: null, sample: null },
    ]);
    expect(roll.byTool.map((r) => r.toolName)).toEqual(['a', 'z']);
  });
});

describe('gradeLimitFailureRate — cutoffs', () => {
  it('below LIMIT_FAILURE_HEALTHY_BELOW is healthy', () => {
    const roll = rollupLimitFailures([{ toolName: 'a', errs: LIMIT_FAILURE_HEALTHY_BELOW - 1, lastSeen: null, sample: null }]);
    expect(gradeLimitFailureRate(roll).rating).toBe('healthy');
  });

  it('at HEALTHY_BELOW is degraded (boundary is exclusive on the healthy side)', () => {
    const roll = rollupLimitFailures([{ toolName: 'a', errs: LIMIT_FAILURE_HEALTHY_BELOW, lastSeen: null, sample: null }]);
    expect(gradeLimitFailureRate(roll).rating).toBe('degraded');
  });

  it('at DEGRADED_BELOW or above is broken', () => {
    const roll = rollupLimitFailures([{ toolName: 'a', errs: LIMIT_FAILURE_DEGRADED_BELOW, lastSeen: null, sample: null }]);
    expect(gradeLimitFailureRate(roll).rating).toBe('broken');
  });

  it('evidence names the worst offender', () => {
    const roll = rollupLimitFailures([
      { toolName: 'fleet:place_batch.brief', errs: 412, lastSeen: null, sample: null },
      { toolName: 'other', errs: 1, lastSeen: null, sample: null },
    ]);
    expect(gradeLimitFailureRate(roll).evidence).toMatch(/fleet:place_batch\.brief ×412/);
  });

  it('zero total is healthy with a clean evidence line', () => {
    const grade = gradeLimitFailureRate(rollupLimitFailures([]));
    expect(grade.rating).toBe('healthy');
    expect(grade.evidence).toMatch(/^0 tool-arg limit-rejection failures/);
  });
});

describe('readLimitFailureRate — runs the canonical SQL through an injected runner', () => {
  it('passes sinceDays as the param and maps DB rows into a rollup', async () => {
    const captured: { query: string; params: unknown[] }[] = [];
    const fakeRun = async <T,>(query: string, params: unknown[]): Promise<T[]> => {
      captured.push({ query, params });
      return [
        { tool_name: 'fleet:place_batch.brief', errs: 412, last_seen: '2026-07-02T00:00:00Z', sample: 'too long' },
      ] as unknown as T[];
    };
    const roll = await readLimitFailureRate(fakeRun, { sinceDays: 14 });
    expect(captured[0].params).toEqual([14]);
    expect(captured[0].query).toBe(LIMIT_FAILURE_RATE_SQL);
    expect(roll.totalErrs).toBe(412);
    expect(roll.byTool[0]).toMatchObject({ toolName: 'fleet:place_batch.brief', errs: 412 });
  });

  it('defaults to a 14-day window', async () => {
    let seen: unknown[] = [];
    await readLimitFailureRate(async <T,>(_q: string, p: unknown[]): Promise<T[]> => {
      seen = p;
      return [] as unknown as T[];
    });
    expect(seen).toEqual([14]);
  });
});
