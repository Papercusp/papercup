/**
 * Unit tests for InMemoryPresenceStore (the swappable double). The PG
 * impl is exercised by the operator's live coord:presence dispatch (it
 * needs a real harness_shared schema); here we pin the contract behavior
 * with a deterministic injected clock.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryPresenceStore, PRESENCE_STALE_MS, type PresenceIdentity } from './index';

function ident(ownerId: string, workspaceId: string | null = 'w1'): PresenceIdentity {
  return { ownerId, ownerLabel: `lbl-${ownerId}`, source: 'static-client', workspaceId };
}

describe('InMemoryPresenceStore', () => {
  it('write upserts and preserves startedAt across re-writes; bumps heartbeat', async () => {
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

  it('touchHeartbeat bumps only heartbeat; no-op on missing', async () => {
    let t = 1000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A'), { intent: 'keep' });
    t = 9000;
    await store.touchHeartbeat('A');
    await store.touchHeartbeat('missing'); // no throw
    const rec = await store.get('A');
    expect(rec?.intent).toBe('keep');
    expect(rec?.heartbeatAt).toBe(new Date(9000).toISOString());
  });

  it('clear removes the row', async () => {
    const store = new InMemoryPresenceStore();
    await store.write(ident('A'));
    await store.clear('A');
    expect(await store.get('A')).toBeNull();
  });

  it('list sorts by heartbeat desc and filters by workspace', async () => {
    let t = 1000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A', 'w1'));
    t = 2000;
    await store.write(ident('B', 'w2'));
    t = 3000;
    await store.write(ident('C', 'w1'));
    const all = await store.list();
    expect(all.map((r) => r.ownerId)).toEqual(['C', 'B', 'A']);
    const w1 = await store.list({ workspaceId: 'w1' });
    expect(w1.map((r) => r.ownerId)).toEqual(['C', 'A']);
  });

  it('marks stale when heartbeat older than PRESENCE_STALE_MS', async () => {
    let t = 1_000_000;
    const store = new InMemoryPresenceStore({ now: () => t });
    await store.write(ident('A'));
    t = 1_000_000 + PRESENCE_STALE_MS + 1;
    expect((await store.get('A'))?.stale).toBe(true);
    t = 1_000_000 + PRESENCE_STALE_MS - 1;
    // re-write to refresh heartbeat to current t, then it's fresh
    await store.write(ident('A'));
    expect((await store.get('A'))?.stale).toBe(false);
  });
});
