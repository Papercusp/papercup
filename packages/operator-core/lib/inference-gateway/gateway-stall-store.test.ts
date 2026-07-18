/**
 * gateway-stall-store — durable write-through for rate-limit stall candidates (EI-2431).
 *
 * Exercised on InMemoryGatewayStallStore (the same store tests inject via
 * configureGatewayStallStore — mirrors runtime-vintage.test.ts's injection contract).
 * The Pg store's insert/prune is exercised live by the gateway's own recordStall() +
 * the stall-waker-loop's fetchStalls merge, not here.
 *
 * All tests run on a fixed fake clock (a real 2026-ish epoch, not near-zero) so the
 * store's real `Date.now() - STALL_MAX_AGE_MS` age cutoff behaves exactly as it does
 * in production instead of tripping on the Unix-epoch/`now` mismatch a near-zero
 * fake `at` would create.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  InMemoryGatewayStallStore,
  configureGatewayStallStore,
  resetGatewayStallStore,
  recordGatewayStall,
  listGatewayStallsSince,
} from './gateway-stall-store';

const BASE = Date.parse('2026-07-18T00:00:00.000Z');

describe('gateway-stall-store — durable stall write-through (EI-2431)', () => {
  beforeEach(() => {
    configureGatewayStallStore(new InMemoryGatewayStallStore());
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    resetGatewayStallStore();
    vi.useRealTimers();
  });

  it('records a stall and lists it back since a watermark before it', async () => {
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 12345, at: BASE }, 'default');
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 12345, at: BASE });
  });

  it('excludes stalls at/before the watermark (since is exclusive, matching the in-memory ring contract)', async () => {
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    await recordGatewayStall({ ownerId: 'bee-2', accountId: 'acct-a', soonestResetAt: 2, at: BASE + 1000 }, 'default');
    const rows = await listGatewayStallsSince(BASE);
    expect(rows.map((r) => r.ownerId)).toEqual(['bee-2']);
  });

  it('returns rows oldest-first, mirroring the order the waker folds them in', async () => {
    await recordGatewayStall({ ownerId: 'bee-2', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 3000 }, 'default');
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 1000 }, 'default');
    const rows = await listGatewayStallsSince(BASE);
    expect(rows.map((r) => r.at)).toEqual([BASE + 1000, BASE + 3000]);
  });

  it('survives a "gateway restart" — the store is independent of any gateway-process in-memory state', async () => {
    // Simulates the exact EI-2431 race: a stall is recorded, then (from the store's point of
    // view) nothing about the gateway process matters — the row is durable in its own right.
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 999, at: BASE }, 'default');
    // "restart" = a fresh listGatewayStallsSince call with no shared in-process state required.
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerId).toBe('bee-1');
  });

  it("prunes rows past the max age on write (mirrors the in-memory ring's own age-based prune)", async () => {
    await recordGatewayStall({ ownerId: 'bee-old', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    // Advance past the 4h max-age window, then record a new stall — the old one is pruned on write.
    vi.setSystemTime(BASE + 5 * 60 * 60_000);
    await recordGatewayStall(
      { ownerId: 'bee-new', accountId: 'acct-a', soonestResetAt: 1, at: BASE + 5 * 60 * 60_000 },
      'default',
    );
    const rows = await listGatewayStallsSince(BASE - 1000);
    expect(rows.map((r) => r.ownerId)).toEqual(['bee-new']);
  });

  it('listSince also floors at the max-age cutoff even when since=0 (a fresh waker instance never replays hours-old stalls)', async () => {
    await recordGatewayStall({ ownerId: 'bee-old', accountId: 'acct-a', soonestResetAt: 1, at: BASE }, 'default');
    vi.setSystemTime(BASE + 5 * 60 * 60_000);
    const rows = await listGatewayStallsSince(0);
    expect(rows).toHaveLength(0);
  });
});
