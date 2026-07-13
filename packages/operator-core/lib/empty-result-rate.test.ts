/**
 * EI-10892 metric #4 — the axis must count REAL waste and must NOT cry wolf.
 *
 * The failure mode this guards against is the same one the detector itself guards
 * against, one level up: a false accusation here paints the fleet red for a quiet
 * window or a single unlucky call, and a panel that cries wolf is a panel agents
 * learn to ignore. So the grading is deliberately conservative at BOTH ends — a
 * thin window grades `unknown` (never `healthy`, which would let a real regression
 * hide behind a slow day), and a real rate must clear a floor before it degrades.
 */
import { describe, expect, it } from 'vitest';
import {
  rollupEmptyResults,
  gradeEmptyResultRate,
  readEmptyResultRate,
  EMPTY_RESULT_MIN_RUNS,
  EMPTY_RESULT_RATE_SQL,
  type EmptyResultRow,
} from './empty-result-rate';

const row = (o: Partial<EmptyResultRow> & { emptyRuns: number; totalRuns: number }): EmptyResultRow => ({
  ownerId: o.ownerId ?? 'su-aaaaaaaa-0000-0000-0000-000000000000',
  lastSeen: o.lastSeen ?? null,
  emptyRuns: o.emptyRuns,
  totalRuns: o.totalRuns,
});

describe('rollupEmptyResults', () => {
  it('sums numerator + denominator and computes the rate', () => {
    const roll = rollupEmptyResults([
      row({ ownerId: 'su-a', emptyRuns: 3, totalRuns: 30 }),
      row({ ownerId: 'su-b', emptyRuns: 1, totalRuns: 20 }),
    ]);
    expect(roll.totalEmptyRuns).toBe(4);
    expect(roll.totalRuns).toBe(50);
    expect(roll.pctEmpty).toBe(8); // 4/50
  });

  it('sorts worst-offender first (stable on ties)', () => {
    const roll = rollupEmptyResults([
      row({ ownerId: 'su-b', emptyRuns: 1, totalRuns: 10 }),
      row({ ownerId: 'su-c', emptyRuns: 9, totalRuns: 10 }),
      row({ ownerId: 'su-a', emptyRuns: 1, totalRuns: 10 }),
    ]);
    expect(roll.byOwner.map((r) => r.ownerId)).toEqual(['su-c', 'su-a', 'su-b']);
  });

  it('reports pctEmpty as null below the minimum-runs floor — a 1-of-1 blank is NOISE, not 100%', () => {
    // The whole point: without this floor, one unlucky call in a quiet window renders
    // as a 100% failure rate and reds the panel.
    const roll = rollupEmptyResults([row({ emptyRuns: 1, totalRuns: 1 })]);
    expect(roll.totalRuns).toBeLessThan(EMPTY_RESULT_MIN_RUNS);
    expect(roll.pctEmpty).toBeNull();
  });

  it('is empty-safe', () => {
    const roll = rollupEmptyResults([]);
    expect(roll).toMatchObject({ totalEmptyRuns: 0, totalRuns: 0, pctEmpty: null, byOwner: [] });
  });
});

describe('gradeEmptyResultRate', () => {
  it('grades a thin window UNKNOWN, never healthy (a quiet window is not evidence of health)', () => {
    const grade = gradeEmptyResultRate(rollupEmptyResults([row({ emptyRuns: 1, totalRuns: 2 })]));
    expect(grade.rating).toBe('unknown');
    expect(grade.evidence).toContain('too few to grade');
  });

  it('healthy at or below the floor', () => {
    // 1/50 = 2%
    expect(gradeEmptyResultRate(rollupEmptyResults([row({ emptyRuns: 1, totalRuns: 50 })])).rating).toBe('healthy');
  });

  it('degraded above the healthy floor but below broken', () => {
    // 3/50 = 6%
    expect(gradeEmptyResultRate(rollupEmptyResults([row({ emptyRuns: 3, totalRuns: 50 })])).rating).toBe('degraded');
  });

  it('BROKEN at the rate the motivating audit actually ran at (~30% wasted round-trips)', () => {
    // The 2026-07-13 session: ~9 of ~30 authored round-trips wasted, every one ok:true,
    // while this panel reported healthy. That session must now light the panel red.
    const grade = gradeEmptyResultRate(rollupEmptyResults([row({ emptyRuns: 9, totalRuns: 30 })]));
    expect(grade.rating).toBe('broken');
    expect(grade.evidence).toContain('30%');
    expect(grade.evidence).toContain('MIS-MAPPED');
  });

  it('names the worst offender so the panel points at someone', () => {
    const grade = gradeEmptyResultRate(
      rollupEmptyResults([
        row({ ownerId: 'su-1468da44-5b0b-4149-b09e-3ea810b90a27', emptyRuns: 8, totalRuns: 30 }),
        row({ ownerId: 'su-other', emptyRuns: 1, totalRuns: 30 }),
      ]),
    );
    expect(grade.evidence).toContain('su-1468da44-5');
  });

  it('healthy on a clean high-traffic window', () => {
    const grade = gradeEmptyResultRate(rollupEmptyResults([row({ emptyRuns: 0, totalRuns: 500 })]));
    expect(grade.rating).toBe('healthy');
    expect(grade.evidence).toContain('0%');
  });
});

describe('readEmptyResultRate', () => {
  it('passes sinceDays through and folds the rows', async () => {
    const calls: Array<{ query: string; params: unknown[] }> = [];
    const runQuery = (async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return [{ owner_id: 'su-a', empty_runs: '4', total_runs: '40', last_seen: '2026-07-13T00:00:00Z' }];
    }) as Parameters<typeof readEmptyResultRate>[0];

    const roll = await readEmptyResultRate(runQuery, { sinceDays: 3 });
    expect(calls[0]!.params).toEqual([3]);
    // PG count() comes back as a STRING over the wire — coercion must not yield NaN.
    expect(roll.totalEmptyRuns).toBe(4);
    expect(roll.totalRuns).toBe(40);
    expect(roll.pctEmpty).toBe(10);
  });

  it('defaults to a 7-day window', async () => {
    const calls: Array<unknown[]> = [];
    const runQuery = (async (_q: string, params: unknown[]) => {
      calls.push(params);
      return [];
    }) as Parameters<typeof readEmptyResultRate>[0];
    await readEmptyResultRate(runQuery);
    expect(calls[0]).toEqual([7]);
  });

  it('the SQL keys off the jsonb marker code:run actually stamps, and scopes to code:run', () => {
    // Pin the contract between the WRITER (code/run.ts stamps metadata_json.emptyMapping)
    // and this READER. If either side renames the key, this fails instead of the axis
    // silently reading zero forever — which would look exactly like "healthy".
    expect(EMPTY_RESULT_RATE_SQL).toContain("metadata_json ? 'emptyMapping'");
    expect(EMPTY_RESULT_RATE_SQL).toContain("tool_name = 'code:run'");
  });
});
