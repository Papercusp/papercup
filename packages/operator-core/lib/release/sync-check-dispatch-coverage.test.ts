import { describe, expect, it } from 'vitest';
import { COVERAGE_EXPECTED_INTERVAL_MS as I, creditLateJudgedSlots } from './sync-batch-delta-check';
import { mergeSyncCheckCoverage, observeSyncCheckDispatch } from './sync-check-dispatch-coverage';

describe('dispatch coverage while a source check cannot complete', () => {
  it('records the current due bucket before it closes and later accounts missed buckets without an action fire', () => {
    const before = { ticks: [{ atMs: 10 * I, evaluated: true, status: 'green' as const }] };
    const held = observeSyncCheckDispatch(before, 11 * I + 2 * 60_000);
    expect(held.ticks.at(-1)).toMatchObject({ atMs: 11 * I, evaluated: false, status: 'pending' });
    const delayed = observeSyncCheckDispatch(held, 14 * I + 1);
    expect(delayed.ticks.map(t => [t.atMs / I, t.status, t.evaluated])).toEqual([
      [10, 'green', true], [11, 'missed-opportunity', false], [12, 'missed-opportunity', false],
      [13, 'missed-opportunity', false], [14, 'pending', false],
    ]);
    expect(observeSyncCheckDispatch(delayed, 14 * I + 2)).toBe(delayed);
  });

  it('does not invent bootstrap history or evict distinct buckets using a record-count cap', () => {
    expect(observeSyncCheckDispatch(undefined, 500 * I).ticks).toHaveLength(1);
    const prior = { ticks: Array.from({ length: 800 }, (_, i) =>
      ({ atMs: I + i, evaluated: true, status: 'green' as const })) };
    const next = observeSyncCheckDispatch(prior, 290 * I);
    expect(next.ticks[0]?.atMs).toBe(2 * I);
    expect(next.ticks).toHaveLength(289);
  });

  it('a stale completion retains dispatch observations and an older pending write cannot erase a judgment', () => {
    const current = observeSyncCheckDispatch(undefined, 10 * I);
    const completed = mergeSyncCheckCoverage(current, {
      ticks: [{ atMs: 9 * I, evaluated: true, status: 'green' }],
    })!;
    expect(completed.ticks.map(t => t.atMs)).toEqual([9 * I, 10 * I]);
    const judged = mergeSyncCheckCoverage(completed, {
      ticks: [{ atMs: 10 * I, evaluated: true, status: 'green' }],
    })!;
    expect(mergeSyncCheckCoverage(judged, current)?.ticks.at(-1)).toMatchObject({ evaluated: true, status: 'green' });
    expect(creditLateJudgedSlots(current, { throughMs: 10 * I, judgedAtMs: 11 * I }).ticks[0])
      .toMatchObject({ evaluated: true, status: 'pending', judgedAtMs: 11 * I });
  });
});
