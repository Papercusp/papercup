/**
 * createStallWakerDeps().fetchStalls — the read-side of the EI-2431 durability fix.
 *
 * The gateway's in-memory ring buffer (served over GET /admin/stalls) is wiped by a gateway
 * restart. fetchStalls must merge in anything durably recorded to PG (gateway-stall-store.ts) so
 * a stall recorded just before a restart still reaches the waker, independent of the HTTP path.
 * Exercised against InMemoryGatewayStallStore (mirrors gateway-stall-store.test.ts's injection
 * contract) with global `fetch` stubbed — no live gateway or DB required.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createStallWakerDeps } from './stall-waker-loop';
import {
  InMemoryGatewayStallStore,
  configureGatewayStallStore,
  resetGatewayStallStore,
  recordGatewayStall,
} from './gateway-stall-store';

const BASE = Date.parse('2026-07-18T00:00:00.000Z');

describe('createStallWakerDeps().fetchStalls — PG durability merge (EI-2431)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    configureGatewayStallStore(new InMemoryGatewayStallStore());
    vi.useFakeTimers();
    vi.setSystemTime(BASE);
  });
  afterEach(() => {
    resetGatewayStallStore();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('merges a PG-only stall (survived a "gateway restart") alongside the HTTP-sourced ones', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ now: BASE, stalls: [{ ownerId: 'bee-http', accountId: 'acct-a', soonestResetAt: BASE + 5000, at: BASE }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    // A stall the gateway durably recorded but whose in-memory ring is gone (simulated restart) —
    // the HTTP mock above deliberately does NOT include it.
    await recordGatewayStall({ ownerId: 'bee-pg-only', accountId: 'acct-b', soonestResetAt: BASE + 9000, at: BASE + 500 }, 'default');

    const deps = createStallWakerDeps('default');
    const res = await deps.fetchStalls(BASE - 1000);
    expect(res.stalls.map((s) => s.ownerId).sort()).toEqual(['bee-http', 'bee-pg-only']);
  });

  it('dedupes when the same (ownerId, at) is reported by BOTH sources (the normal case — recordStall writes both)', async () => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ now: BASE, stalls: [{ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 5000, at: BASE }] }), {
        status: 200,
      }),
    ) as unknown as typeof fetch;
    await recordGatewayStall({ ownerId: 'bee-1', accountId: 'acct-a', soonestResetAt: BASE + 5000, at: BASE }, 'default');

    const deps = createStallWakerDeps('default');
    const res = await deps.fetchStalls(BASE - 1000);
    expect(res.stalls).toHaveLength(1);
  });

  it('falls back to PG entirely when the gateway is unreachable (mid-restart) — the exact EI-2431 race', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED — gateway mid-restart');
    }) as unknown as typeof fetch;
    await recordGatewayStall({ ownerId: 'bee-durable', accountId: 'acct-a', soonestResetAt: BASE + 9000, at: BASE }, 'default');

    const deps = createStallWakerDeps('default');
    const res = await deps.fetchStalls(BASE - 1000);
    expect(res.stalls.map((s) => s.ownerId)).toEqual(['bee-durable']);
  });

  it('never throws when BOTH the gateway and PG are unreachable — degrades to an empty tick', async () => {
    global.fetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    configureGatewayStallStore({
      record: async () => {
        throw new Error('pg down');
      },
      listSince: async () => {
        throw new Error('pg down');
      },
    });

    const deps = createStallWakerDeps('default');
    const res = await deps.fetchStalls(BASE - 1000);
    expect(res.stalls).toEqual([]);
  });
});
