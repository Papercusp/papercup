import { describe, expect, it, vi } from 'vitest';
import {
  ATTENTION_COUNTS_FALLBACK_MS,
  attentionCountsRowFromOutcome,
  withDeadlineFallback,
} from './attention-counts';

describe('attention-counts sync deadline', () => {
  it('stays below the outer 10s sync resolver deadline', () => {
    expect(ATTENTION_COUNTS_FALLBACK_MS).toBeLessThan(10_000);
  });

  it('returns the operation result before the deadline', async () => {
    await expect(
      withDeadlineFallback(Promise.resolve('fresh'), 8_000, () => 'fallback'),
    ).resolves.toEqual({ value: 'fresh', degraded: false });
  });

  it('returns the graceful fallback when the operation is still pending', async () => {
    vi.useFakeTimers();
    try {
      let resolveOperation!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        resolveOperation = resolve;
      });
      const result = withDeadlineFallback(operation, 8_000, () => 'fallback');

      await vi.advanceTimersByTimeAsync(7_999);
      await expect(Promise.race([result.then(() => 'settled'), Promise.resolve('pending')])).resolves.toBe(
        'pending',
      );

      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toEqual({ value: 'fallback', degraded: true });
      resolveOperation('late');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn a real operation error into a fallback', async () => {
    await expect(
      withDeadlineFallback(Promise.reject(new Error('read failed')), 8_000, () => 'fallback'),
    ).rejects.toThrow('read failed');
  });
});

/**
 * WI-39779 — the badge's honesty guard.
 *
 * THE BUG THIS PINS. `plans.attentionCounts` wraps the attention read in an 8s
 * deadline whose graceful fallback is EMPTY GROUPS. Empty groups derive to
 * all-zeros, and the always-mounted "needs you" badge renders a zero by showing
 * NOTHING. So a fired deadline was displayed to the user as a confident
 * "nothing needs you" — when the truth was "we never found out". The two states
 * were byte-identical on the wire, so no consumer could tell them apart even in
 * principle.
 *
 * WHY THESE ASSERTIONS AND NOT "degraded === true". A test that only checks the
 * flag on the degraded row passes just as happily if the REAL row is also
 * marked degraded — i.e. if the marker is a constant. The load-bearing property
 * is DISTINGUISHABILITY: the timed-out row and the genuinely-empty row must not
 * be equal. That is asserted directly below, so both ways of breaking it (drop
 * the marker, or hardcode it) turn this suite red.
 */
describe('WI-39779: a deadline-fallback row is distinguishable from a real empty inbox', () => {
  const ZERO_COUNTS = { decisionItems: 0, decisionPlans: 0, alerts: 0, total: 0 };

  it('marks the row degraded when the value is the deadline fallback', () => {
    const row = attentionCountsRowFromOutcome({ value: { groups: [] }, degraded: true });
    expect(row).toEqual({ ...ZERO_COUNTS, degraded: true });
  });

  it('does not mark a genuinely empty inbox as degraded', () => {
    const row = attentionCountsRowFromOutcome({ value: { groups: [] }, degraded: false });
    expect(row).toEqual({ ...ZERO_COUNTS, degraded: false });
  });

  /**
   * THE GUARD. Both rows carry identical zero counts; only the marker separates
   * them. Return the graceful empty UNMARKED — or mark every row — and this
   * fails, which is the whole point.
   */
  it('a timed-out zero is NOT equal to a real zero', () => {
    const timedOut = attentionCountsRowFromOutcome({ value: { groups: [] }, degraded: true });
    const reallyEmpty = attentionCountsRowFromOutcome({ value: { groups: [] }, degraded: false });

    expect(timedOut).not.toEqual(reallyEmpty);
    // ...and the difference is ONLY the honesty bit, not a count that drifted.
    const { degraded: _t, ...timedOutCounts } = timedOut;
    const { degraded: _r, ...reallyEmptyCounts } = reallyEmpty;
    expect(timedOutCounts).toEqual(reallyEmptyCounts);
  });

  it('carries real counts through undegraded', () => {
    const groups = [
      { items: [{ id: 'd1', tier: 'decision', planSlug: 'alpha' }, { id: 'a1', tier: 'alert' }] },
    ];
    expect(attentionCountsRowFromOutcome({ value: { groups }, degraded: false })).toEqual({
      decisionItems: 1,
      decisionPlans: 1,
      alerts: 1,
      total: 2,
      degraded: false,
    });
  });

  it('preserves projected counts and the inner cache deadline marker', () => {
    const counts = { decisionItems: 2, decisionPlans: 1, alerts: 3, total: 7 };
    expect(attentionCountsRowFromOutcome({ value: { counts, degraded: false }, degraded: false }))
      .toEqual({ ...counts, degraded: false });
    expect(attentionCountsRowFromOutcome({ value: { counts: ZERO_COUNTS, degraded: true }, degraded: false }))
      .toEqual({ ...ZERO_COUNTS, degraded: true });
    expect(attentionCountsRowFromOutcome({ value: { counts }, degraded: true }))
      .toEqual({ ...counts, degraded: true });
  });

  it('survives a fallback whose value has no groups at all', () => {
    expect(attentionCountsRowFromOutcome({ value: undefined, degraded: true })).toEqual({
      ...ZERO_COUNTS,
      degraded: true,
    });
  });
});
