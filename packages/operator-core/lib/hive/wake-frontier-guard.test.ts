/**
 * Unit tests for the EI-309 wake-frontier guard decision (pure).
 */
import { describe, expect, it } from 'vitest';
import { evaluateWakeFrontierGuard } from './wake-frontier-guard';

describe('evaluateWakeFrontierGuard', () => {
  it('ALLOWS a wake with a time component regardless of the frontier (a timer re-wakes to place)', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: true, frontierIds: ['WI-1', 'WI-2'] })).toBeNull();
  });

  it('ALLOWS a no-time wake when the frontier is empty (nothing to place)', () => {
    expect(evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: [] })).toBeNull();
  });

  it('REFUSES a no-time (event-only/none) wake with a non-empty frontier — frontier_not_empty + ids', () => {
    const r = evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: ['WI-116', 'WI-117'] });
    expect(r).not.toBeNull();
    expect(r!.error).toBe('frontier_not_empty');
    expect(r!.frontier).toEqual(['WI-116', 'WI-117']);
    expect(r!.message).toMatch(/WI-116/);
    expect(r!.message).toMatch(/place them|time-wake/i);
  });

  it('truncates a long frontier list in the message but keeps the full ids array', () => {
    const ids = Array.from({ length: 15 }, (_, i) => `WI-${i}`);
    const r = evaluateWakeFrontierGuard({ hasTimeWake: false, frontierIds: ids })!;
    expect(r.frontier).toHaveLength(15);
    expect(r.message).toMatch(/\+5 more/);
  });
});
