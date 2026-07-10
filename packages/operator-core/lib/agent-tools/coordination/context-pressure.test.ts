/**
 * context-pressure.test.ts — the coarse per-member context-pressure bucket
 * (fleet-deltas-leader-primitives-2026-07-10 P-007).
 */
import { describe, it, expect } from 'vitest';
import { deriveContextPressure, fetchContextPressure, type ContextPressureBucket } from './context-pressure';
import { CONTEXT_GAUGE_LOUD_PCT, CONTEXT_GAUGE_CRITICAL_PCT } from './tools/inbox-context-usage';

describe('deriveContextPressure (pure)', () => {
  it('null when usage cannot be computed (no limit / no estimate)', () => {
    expect(deriveContextPressure(null, null)).toBeNull();
    expect(deriveContextPressure(1000, null)).toBeNull();
    expect(deriveContextPressure(null, 100_000)).toBeNull();
    expect(deriveContextPressure(1000, 0)).toBeNull(); // a zero limit is meaningless, not 0%
  });

  it("'ok' below the LOUD band — the common, comfortably-under-limit case", () => {
    expect(deriveContextPressure(0, 100_000)).toBe('ok');
    expect(deriveContextPressure(50_000, 100_000)).toBe('ok'); // 50%
    // Just under LOUD (79%) is still 'ok' — matches contextGaugeBand's 'quiet' band.
    expect(deriveContextPressure((CONTEXT_GAUGE_LOUD_PCT - 1) * 1000, 100_000)).toBe('ok');
  });

  it("'high' at/above LOUD, below CRITICAL", () => {
    expect(deriveContextPressure(CONTEXT_GAUGE_LOUD_PCT * 1000, 100_000)).toBe('high');
    expect(deriveContextPressure((CONTEXT_GAUGE_CRITICAL_PCT - 1) * 1000, 100_000)).toBe('high');
  });

  it("'critical' at/above CRITICAL", () => {
    expect(deriveContextPressure(CONTEXT_GAUGE_CRITICAL_PCT * 1000, 100_000)).toBe('critical');
    expect(deriveContextPressure(130_000, 100_000)).toBe('critical'); // over 100% (force-compact band)
  });

  it('the bucket is always one of exactly three strings, or null — never coerced/mixed', () => {
    const cases: Array<[number | null, number | null]> = [
      [0, 100_000],
      [80_000, 100_000],
      [95_000, 100_000],
      [null, null],
    ];
    for (const [tokens, limit] of cases) {
      const b = deriveContextPressure(tokens, limit);
      expect(b === null || b === 'ok' || b === 'high' || b === 'critical').toBe(true);
    }
  });
});

describe('fetchContextPressure (IO seam)', () => {
  it('empty ownerIds is a no-op that never calls sql', async () => {
    const out = await fetchContextPressure([]);
    expect(out).toEqual(new Map());
  });
});

describe('ContextPressureBucket type surface', () => {
  it('accepts the three literal buckets', () => {
    const buckets: ContextPressureBucket[] = ['ok', 'high', 'critical'];
    expect(buckets).toHaveLength(3);
  });
});
