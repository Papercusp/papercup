/**
 * routine-tick-overlap-guard.test.ts — pins the EI-9935 routinesTick overlap
 * guard: don't let two invocations of the 30s-cadence scheduled tick run
 * concurrently (the confirmed root cause of the 2026-07-12 00:15-00:30 EDT
 * dead-routines flap — see routine-tick-overlap-guard.ts's header for the
 * live evidence).
 */
import { describe, expect, it, vi } from 'vitest';
import { anotherRoutinesTickInFlight, shouldShedForOverlap, type InFlightRow } from './routine-tick-overlap-guard';

describe('shouldShedForOverlap (pure)', () => {
  it('no other in-flight rows ⇒ do not shed', () => {
    expect(shouldShedForOverlap([])).toBe(false);
  });
  it('at least one other in-flight row ⇒ shed', () => {
    expect(shouldShedForOverlap([{ workflow_uuid: 'other-1' }])).toBe(true);
  });
});

describe('anotherRoutinesTickInFlight', () => {
  it('returns false when the query finds nothing (normal case, no overlap)', async () => {
    const queryInFlight = vi.fn(async () => [] as InFlightRow[]);
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(false);
    expect(queryInFlight).toHaveBeenCalledWith('self-id', 1_000_000 - 5 * 60_000);
  });

  it('returns true when another PENDING tick is found within the stale window', async () => {
    const queryInFlight = vi.fn(async () => [{ workflow_uuid: 'other-tick' }]);
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(true);
  });

  it('passes the caller-provided staleMs through as the cutoff', async () => {
    const queryInFlight = vi.fn(async () => []);
    await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 }, 30_000);
    expect(queryInFlight).toHaveBeenCalledWith('self-id', 1_000_000 - 30_000);
  });

  it('is FAIL-SOFT: a query error resolves to false, never wedging the scheduler', async () => {
    const queryInFlight = vi.fn(async () => {
      throw new Error('pg connection refused');
    });
    const result = await anotherRoutinesTickInFlight('self-id', { queryInFlight, now: () => 1_000_000 });
    expect(result).toBe(false);
  });

  it('defaults `now` to Date.now when not provided', async () => {
    const before = Date.now();
    const queryInFlight = vi.fn(async (_selfId: string, _cutoffEpochMs: number) => [] as InFlightRow[]);
    await anotherRoutinesTickInFlight('self-id', { queryInFlight });
    const after = Date.now();
    const cutoffArg = queryInFlight.mock.calls[0][1];
    // cutoff = now() - 5min, so it must fall within [before-5min, after-5min]
    expect(cutoffArg).toBeGreaterThanOrEqual(before - 5 * 60_000 - 1);
    expect(cutoffArg).toBeLessThanOrEqual(after - 5 * 60_000 + 1);
  });
});
