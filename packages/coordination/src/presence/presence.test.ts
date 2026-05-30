/**
 * InMemoryPresenceStore tests.
 *
 * The behavioral CONTRACT (write/get/touch/clear/list ordering + workspace
 * filter + freshness) is asserted by the shared `describePresenceConformance`
 * suite — the SAME suite that runs against the production `PgPresenceStore`
 * in the operator integration test
 * (apps/operator/lib/agent-tools/coordination/__tests__/presence-conformance.test.ts).
 * Running it against both impls is the P-050 swappability proof; before this
 * only the in-mem double was asserted.
 *
 * The cases below are the in-mem-ONLY extras that need a fake clock — exact
 * startedAt/heartbeat values and the precise stale boundary — which the PG
 * impl (real `now()`) can't pin deterministically.
 */
import { describe, expect, it } from 'vitest';
import { describePresenceConformance } from './conformance';
import { InMemoryPresenceStore, PRESENCE_STALE_MS, type PresenceIdentity } from './index';

describePresenceConformance('InMemoryPresenceStore', () => new InMemoryPresenceStore());

function ident(ownerId: string, workspaceId: string | null = 'w1'): PresenceIdentity {
  return { ownerId, ownerLabel: `lbl-${ownerId}`, source: 'static-client', workspaceId };
}

describe('InMemoryPresenceStore — clock-controlled extras', () => {
  it('preserves exact startedAt across re-writes; bumps heartbeat to current clock', async () => {
    let t = 1000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A'), { intent: 'first' });
    t = 5000;
    await store.write(ident('A'), { intent: 'second', currentFiles: ['x.ts'] });
    const rec = await store.get('A');
    expect(rec?.intent).toBe('second');
    expect(rec?.currentFiles).toEqual(['x.ts']);
    expect(rec?.startedAt).toBe(new Date(1000).toISOString());
    expect(rec?.heartbeatAt).toBe(new Date(5000).toISOString());
  });

  it('touchHeartbeat bumps heartbeat to the exact clock value', async () => {
    let t = 1000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A'), { intent: 'keep' });
    t = 9000;
    await store.touchHeartbeat('A');
    const rec = await store.get('A');
    expect(rec?.heartbeatAt).toBe(new Date(9000).toISOString());
  });

  it('marks stale exactly when heartbeat is older than PRESENCE_STALE_MS', async () => {
    let t = 1_000_000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A'));
    t = 1_000_000 + PRESENCE_STALE_MS + 1;
    expect((await store.get('A'))?.stale).toBe(true);
    t = 1_000_000 + PRESENCE_STALE_MS - 1;
    await store.write(ident('A')); // refresh heartbeat to current t
    expect((await store.get('A'))?.stale).toBe(false);
  });
});
