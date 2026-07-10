/**
 * read-cursors — the two-phase ACK-ON-NEXT-READ contract
 * (fleet-deltas-leader-primitives-2026-07-10 P-004; mig 537).
 *
 * Exercised on InMemoryReadCursorStore (the same store tests inject via
 * configureReadCursorStore — mirrors watermarks.ts's injection contract). The
 * Pg store's single-statement CTE implements the identical promote-then-advance
 * semantics; its live behavior is verified against the real table in the P-004
 * close-out (psql round-trip), not here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  InMemoryReadCursorStore,
  configureReadCursorStore,
  resetReadCursorStore,
  ackAndAdvance,
  clearReadCursor,
} from './read-cursors';

describe('read-cursors — ack-on-next-read (P-004)', () => {
  beforeEach(() => configureReadCursorStore(new InMemoryReadCursorStore()));
  afterEach(() => resetReadCursorStore());

  it('first call for a surface is a BASELINE (no committed state to diff against)', async () => {
    const r = await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    expect(r).toEqual({ committed: null, baseline: true });
  });

  it("call N+1 promotes call N's pending → committed (the arrival IS the ack)", async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N' });
    const r2 = await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N+1' });
    // Diff base for call N+1 = what call N DELIVERED, now provably seen.
    expect(r2).toEqual({ committed: { state: 'N' }, baseline: false });
    const r3 = await ackAndAdvance('su-1', 'fleet:monitor', { state: 'N+2' });
    expect(r3.committed).toEqual({ state: 'N+1' });
  });

  it('a died wake RE-RECEIVES: the diff base does not advance until the next call arrives', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1'] }); // call 1 (baseline delivered)
    // Call 2 delivers delta vs call-1 state… and the caller DIES mid-turn.
    const call2 = await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1', 'm2'] });
    expect(call2.committed).toEqual({ seen: ['m1'] });
    // Call 3 (the recovery wake): committed is call-2's pending — everything
    // call 2 delivered is INSIDE the new diff window, so nothing is skipped.
    // (committed advanced exactly one delivery; had call 2's delivery been
    // committed at delivery time, its content would be lost forever.)
    const call3 = await ackAndAdvance('su-1', 'fleet:monitor', { seen: ['m1', 'm2', 'm3'] });
    expect(call3.committed).toEqual({ seen: ['m1', 'm2'] });
  });

  it('cursors are isolated per (owner, surface)', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    const otherOwner = await ackAndAdvance('su-2', 'fleet:monitor', { b: 2 });
    const otherSurface = await ackAndAdvance('su-1', 'inbox', { c: 3 });
    expect(otherOwner.baseline).toBe(true);
    expect(otherSurface.baseline).toBe(true);
    const own = await ackAndAdvance('su-1', 'fleet:monitor', { a: 2 });
    expect(own.committed).toEqual({ a: 1 });
  });

  it('clear() resets a surface to baseline (fingerprint-schema invalidation path)', async () => {
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 1 });
    await ackAndAdvance('su-1', 'fleet:monitor', { a: 2 });
    await clearReadCursor('su-1', 'fleet:monitor');
    const r = await ackAndAdvance('su-1', 'fleet:monitor', { a: 3 });
    expect(r).toEqual({ committed: null, baseline: true });
  });
});
