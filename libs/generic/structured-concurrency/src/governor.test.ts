import { beforeEach, describe, expect, it } from 'vitest';
import { createGovernor, refilledTokens, type Governor } from './governor';
import { createInMemoryGovernorStore } from './mem-store';
import type { BucketRow } from './ports';

const WS = 'default';
let gov: Governor;
beforeEach(() => { gov = createGovernor(createInMemoryGovernorStore()); });

describe('refilledTokens (pure)', () => {
  it('accrues at refill_per_sec, capped at capacity', () => {
    const row: BucketRow = { capacity: 5, refillPerSec: 1, tokens: 2, updatedAtMs: 1_000_000 };
    expect(refilledTokens(row, 1_000_000)).toBe(2); // no time elapsed
    expect(refilledTokens(row, 1_002_000)).toBe(4); // +2s → +2 tokens
    expect(refilledTokens(row, 1_010_000)).toBe(5); // capped at capacity
  });
  it('treats a null updatedAt as now (no retro-accrual)', () => {
    expect(refilledTokens({ capacity: 5, refillPerSec: 1, tokens: 1, updatedAtMs: null }, 9_999)).toBe(1);
  });
});

describe('admitSpawn — token bucket', () => {
  it('debits on admit and refuses when exhausted; an unconfigured scope is unconstrained', async () => {
    // No bucket configured → always admitted (opt-in).
    expect((await gov.admitSpawn({ workspaceId: WS })).admitted).toBe(true);

    const t0 = 5_000_000;
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'global', capacity: 2, refillPerSec: 0, now: t0 });
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 })).admitted).toBe(true);
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 })).admitted).toBe(true);
    const denied = await gov.admitSpawn({ workspaceId: WS, now: t0 });
    expect(denied.admitted).toBe(false);
    expect(denied.reason).toBe('bucket_exhausted:global');
  });

  it('a per-harness bucket is a bulkhead — it does not drain the global pool', async () => {
    const t0 = 6_000_000;
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'global', capacity: 100, refillPerSec: 0, now: t0 });
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'harness:a', capacity: 1, refillPerSec: 0, now: t0 });
    expect((await gov.admitSpawn({ workspaceId: WS, harness: 'a', now: t0 })).admitted).toBe(true);
    // harness:a is drained, but harness:b (no bucket) still rides the global pool.
    expect((await gov.admitSpawn({ workspaceId: WS, harness: 'a', now: t0 })).admitted).toBe(false);
    expect((await gov.admitSpawn({ workspaceId: WS, harness: 'b', now: t0 })).admitted).toBe(true);
  });

  it('is all-or-nothing: a denied admit debits no bucket', async () => {
    const t0 = 7_000_000;
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'global', capacity: 5, refillPerSec: 0, now: t0 });
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'harness:a', capacity: 0, refillPerSec: 0, now: t0 });
    const r = await gov.admitSpawn({ workspaceId: WS, harness: 'a', now: t0 });
    expect(r.admitted).toBe(false);
    // global was NOT debited — a second admit on a different harness still has all 5.
    const r2 = await gov.admitSpawn({ workspaceId: WS, now: t0 });
    expect(r2.admitted).toBe(true);
    expect(r2.buckets.find((b) => b.scopeKey === 'global')?.tokensAfter).toBe(4);
  });
});

describe('admitSpawn — circuit breaker', () => {
  it('trips open at threshold, refuses while cooling, then admits a half_open probe', async () => {
    const t0 = 8_000_000;
    await gov.configureCircuit({ workspaceId: WS, scopeKey: 'harness:x', threshold: 2, cooldownSec: 60 });
    // Two failures → open.
    expect((await gov.recordCircuitFailure({ workspaceId: WS, scopeKey: 'harness:x', now: t0 }))?.state).toBe('closed');
    expect((await gov.recordCircuitFailure({ workspaceId: WS, scopeKey: 'harness:x', now: t0 }))?.state).toBe('open');
    // Open + still cooling → refuse.
    const denied = await gov.admitSpawn({ workspaceId: WS, harness: 'x', now: t0 + 30_000 });
    expect(denied).toMatchObject({ admitted: false, reason: 'circuit_open:harness:x' });
    // Past cooldown → admit one probe (half_open).
    expect((await gov.admitSpawn({ workspaceId: WS, harness: 'x', now: t0 + 61_000 })).admitted).toBe(true);
  });

  it('recordCircuitSuccess closes the circuit and clears failures', async () => {
    await gov.configureCircuit({ workspaceId: WS, scopeKey: 'role:w', threshold: 1, cooldownSec: 60 });
    await gov.recordCircuitFailure({ workspaceId: WS, scopeKey: 'role:w', now: 1 }); // → open
    await gov.recordCircuitSuccess({ workspaceId: WS, scopeKey: 'role:w' });
    // Closed again → admitted.
    expect((await gov.admitSpawn({ workspaceId: WS, role: 'w', now: 2 })).admitted).toBe(true);
  });

  it('returns null recording a failure on an unconfigured circuit', async () => {
    expect(await gov.recordCircuitFailure({ workspaceId: WS, scopeKey: 'nope' })).toBeNull();
  });
});
