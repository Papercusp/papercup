/**
 * producer-consumer — the bounded buffer that NEEDS the backpressure governor. Credits
 * model the buffer's free slots: a producer takes a slot (admit consumes a credit); a
 * full buffer (0 credits) refuses the producer instead of overrunning; a consumer frees
 * a slot (grants a credit). The token bucket gives the same property by rate. The
 * genericity proof for the governor — same algorithm the PG integration test exercises,
 * here over the in-memory store.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createGovernor, type Governor } from './governor';
import { createInMemoryGovernorStore } from './mem-store';

const WS = 'default';
let gov: Governor;
beforeEach(() => { gov = createGovernor(createInMemoryGovernorStore()); });

describe('producer-consumer — bounded buffer backpressure', () => {
  it('a full buffer refuses producers; a consumer frees a slot and unblocks them', async () => {
    await gov.configureCredits({ workspaceId: WS, scopeKey: 'role:worker', credits: 2, max: 2 });

    expect((await gov.admitSpawn({ workspaceId: WS, role: 'worker' })).admitted).toBe(true);  // slot 1
    expect((await gov.admitSpawn({ workspaceId: WS, role: 'worker' })).admitted).toBe(true);  // slot 2
    const full = await gov.admitSpawn({ workspaceId: WS, role: 'worker' });                    // buffer full
    expect(full.admitted).toBe(false);
    expect(full.reason).toBe('no_credits:role:worker');

    await gov.grantCredits({ workspaceId: WS, scopeKey: 'role:worker', n: 1 });                 // consumer frees a slot
    expect((await gov.admitSpawn({ workspaceId: WS, role: 'worker' })).admitted).toBe(true);    // producer unblocked
    expect((await gov.admitSpawn({ workspaceId: WS, role: 'worker' })).admitted).toBe(false);   // full again
  });

  it('grantCredits never exceeds the configured max', async () => {
    await gov.configureCredits({ workspaceId: WS, scopeKey: 'role:worker', credits: 0, max: 2 });
    expect(await gov.grantCredits({ workspaceId: WS, scopeKey: 'role:worker', n: 5 })).toBe(2); // capped
  });

  it('the token bucket bounds the long-run production RATE (refill-paced)', async () => {
    const t0 = 7_000_000;
    await gov.configureBucket({ workspaceId: WS, scopeKey: 'global', capacity: 2, refillPerSec: 1, now: t0 });
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 })).admitted).toBe(true);   // burst 1
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 })).admitted).toBe(true);   // burst 2
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 })).admitted).toBe(false);  // burst exhausted
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 + 1000 })).admitted).toBe(true);  // +1 token
    expect((await gov.admitSpawn({ workspaceId: WS, now: t0 + 1000 })).admitted).toBe(false);
  });
});
