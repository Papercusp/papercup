/**
 * cup-wake-efficiency unit tests — pure aggregation over an injected row source,
 * no DB (bee-context-efficiency-2026-06-14 P-001).
 */
import { describe, expect, it } from 'vitest';
import {
  cupWakeEfficiency,
  EMPTY_CUP_WAKE_EFFICIENCY,
  type CupWakeSampleRow,
} from './cup-wake-efficiency';

/** Helper to build a raw row (PG-shaped). */
function row(o: Partial<CupWakeSampleRow> & { session_id: string; ts: number }): CupWakeSampleRow {
  return {
    run_id: o.run_id ?? `run-${o.ts}`,
    session_id: o.session_id,
    ts: o.ts,
    input_tokens: o.input_tokens ?? 0,
    output_tokens: o.output_tokens ?? 0,
    cache_read_tokens: o.cache_read_tokens ?? 0,
    cache_creation_tokens: o.cache_creation_tokens ?? 0,
    cost_usd: o.cost_usd ?? null,
    turn_count: o.turn_count ?? null,
  };
}

describe('cupWakeEfficiency', () => {
  it('returns the zeroed aggregate on no rows (fail-soft, e.g. migration 279 not yet applied)', async () => {
    const r = await cupWakeEfficiency('ws', { deps: { fetchSamples: async () => [] } });
    expect(r).toEqual(EMPTY_CUP_WAKE_EFFICIENCY);
  });

  it('groups wakes by session and measures the per-session carry trajectory', async () => {
    // Session A: 3 wakes (warm-injected twice) — cache_read GROWS as the
    // transcript accumulates. Session B: a single wake (never warm-injected).
    // Rows arrive newest-first (ts DESC), as the real SELECT returns them.
    const rows: CupWakeSampleRow[] = [
      row({ session_id: 'A', ts: 300, input_tokens: 300, cache_read_tokens: 9000, cache_creation_tokens: 100, output_tokens: 40, cost_usd: 0.03, turn_count: 2 }),
      row({ session_id: 'A', ts: 200, input_tokens: 300, cache_read_tokens: 5000, cache_creation_tokens: 100, output_tokens: 40, cost_usd: 0.02, turn_count: 2 }),
      row({ session_id: 'B', ts: 150, input_tokens: 900, cache_read_tokens: 300, cache_creation_tokens: 400, output_tokens: 30, cost_usd: 0.01, turn_count: 2 }),
      row({ session_id: 'A', ts: 100, input_tokens: 1000, cache_read_tokens: 200, cache_creation_tokens: 500, output_tokens: 50, cost_usd: 0.01, turn_count: 3 }),
    ];

    const r = await cupWakeEfficiency('ws', { deps: { fetchSamples: async () => rows } });

    expect(r.sessions).toBe(2);
    expect(r.totalWakes).toBe(4);
    expect(r.multiWakeSessions).toBe(1); // only A warm-injected
    expect(r.avgWakesPerMultiSession).toBe(3); // A has 3 wakes
    // Carry = cache_read on the non-first wakes of A: 5000 + 9000.
    expect(r.totalCarriedReadTokens).toBe(14000);
    expect(r.avgCarriedPerWarmInject).toBe(7000); // 14000 / 2 warm-injects
    // prompt tokens = cache_read(14500) + cache_creation(1100) + input(2500) = 18100.
    expect(r.carryShareOfPrompt).toBeCloseTo(14000 / 18100, 6);
    expect(r.totalCostUsd).toBeCloseTo(0.07, 6);

    // perSession is newest-session-first by last wake; A (last ts 300) before B (150).
    expect(r.perSession.map((s) => s.sessionId)).toEqual(['A', 'B']);
    const a = r.perSession[0];
    expect(a.wakes.map((w) => w.tsMs)).toEqual([100, 200, 300]); // chronological within session
    expect(a.carriedReadTokens).toBe(14000);
    expect(a.carryGrowthTokens).toBe(8800); // 9000 (last) − 200 (first)
    expect(a.peakCacheReadTokens).toBe(9000);

    const b = r.perSession[1];
    expect(b.wakes).toHaveLength(1);
    expect(b.carriedReadTokens).toBe(0); // single wake ⇒ no carry
    expect(b.carryGrowthTokens).toBe(0);
  });

  it('reports zero carry when every cup session is single-wake (the resume path is unsampled)', async () => {
    // The Phase-0 reality before the wake-executor resume-sampling lands: each
    // cup shows ONE wake (its invoke.ts spawn). The reader makes that legible —
    // multiWakeSessions=0 IS the "resume path unsampled" finding, not a bug.
    const rows: CupWakeSampleRow[] = [
      row({ session_id: 'S1', ts: 100, input_tokens: 8000, cache_read_tokens: 1200 }),
      row({ session_id: 'S2', ts: 200, input_tokens: 7500, cache_read_tokens: 1100 }),
    ];
    const r = await cupWakeEfficiency('ws', { deps: { fetchSamples: async () => rows } });
    expect(r.sessions).toBe(2);
    expect(r.multiWakeSessions).toBe(0);
    expect(r.totalCarriedReadTokens).toBe(0);
    expect(r.avgCarriedPerWarmInject).toBeNull();
    expect(r.avgWakesPerMultiSession).toBeNull();
  });

  it('coerces string PG numerics', async () => {
    const rows: CupWakeSampleRow[] = [
      { run_id: 'r1', session_id: 'X', ts: '100', input_tokens: '500', output_tokens: '10', cache_read_tokens: '0', cache_creation_tokens: '200', cost_usd: '0.005', turn_count: '1' },
      { run_id: 'r2', session_id: 'X', ts: '200', input_tokens: '100', output_tokens: '10', cache_read_tokens: '4000', cache_creation_tokens: '50', cost_usd: '0.006', turn_count: '1' },
    ];
    const r = await cupWakeEfficiency('ws', { deps: { fetchSamples: async () => rows } });
    expect(r.totalWakes).toBe(2);
    expect(r.totalCarriedReadTokens).toBe(4000); // second wake's cache_read
    expect(r.perSession[0].carryGrowthTokens).toBe(4000); // 4000 − 0
  });
});
