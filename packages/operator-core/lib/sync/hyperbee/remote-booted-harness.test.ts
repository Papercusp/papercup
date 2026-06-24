/**
 * remote-booted-harness.test.ts — Phase 1 of the substrate store relocation
 * (substrate-sidecar-store-relocation-2026-06-23, P-001).
 *
 * Proves the main-side proxy maps `BootedHarnessHandle` calls onto the right
 * IPC methods, using an injected fake RPC client (no sidecar / no socket):
 *   - append(op)        → substrate:appendOp (HLC-stamped in the sidecar)
 *   - ownLog.append(op) → substrate:appendOp { raw:true }
 *   - ownLog.keyHex     → the boot-provided key (data, no IPC)
 *   - mergeNow/revoke/rekey/close → their IPC methods
 *   - store/onAnnounce  → throw (sidecar-internal); swarm null; admitted empty
 */

import { describe, it, expect, vi } from 'vitest';
import { RemoteBootedHarnessHandle, type SubstrateRpcCaller } from './remote-booted-harness';
import type { LocalWriteOp } from './boot';
import type { PeerLogOp } from './peer-log';

const KEY = 'a'.repeat(64);

interface CallLog {
  method: string;
  params: unknown;
}

function makeClient(responder?: (method: string, params: unknown) => unknown): {
  client: SubstrateRpcCaller;
  calls: CallLog[];
} {
  const calls: CallLog[] = [];
  const client: SubstrateRpcCaller = {
    async call<T>(method: string, params?: unknown): Promise<T> {
      calls.push({ method, params });
      return (responder ? responder(method, params) : undefined) as T;
    },
  };
  return { client, calls };
}

function makeHandle(client: SubstrateRpcCaller, ownLogLength = 0): RemoteBootedHarnessHandle {
  return new RemoteBootedHarnessHandle({
    workspaceId: 'ws',
    harnessSlug: 'h-1',
    storeId: 'store-1',
    ownLogKey: KEY,
    ownLogLength,
    client,
  });
}

const op: LocalWriteOp = { type: 'put', table: 'feature_queue', hbKey: 'k', value: { x: 1 }, ts: 1, schema_version: 1 };

describe('RemoteBootedHarnessHandle (P-001)', () => {
  it('carries workspaceId/harnessSlug + the own-log key without IPC', () => {
    const { client, calls } = makeClient();
    const h = makeHandle(client);
    expect(h.workspaceId).toBe('ws');
    expect(h.harnessSlug).toBe('h-1');
    expect(h.ownLog.keyHex).toBe(KEY);
    expect(calls).toHaveLength(0);
  });

  it('append(op) routes to substrate:appendOp (non-raw) + updates tracked length', async () => {
    const { client, calls } = makeClient((m) =>
      m === 'substrate:appendOp' ? { ok: true, ownLogLength: 7, hlc: 'h' } : undefined,
    );
    const h = makeHandle(client);
    await h.append(op);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('substrate:appendOp');
    expect(calls[0].params).toMatchObject({ storeId: 'store-1', op });
    expect((calls[0].params as { raw?: boolean }).raw).toBeUndefined();
    expect(h.ownLog.length).toBe(7);
  });

  it('ownLog.append(op) routes to substrate:appendOp with raw:true', async () => {
    const { client, calls } = makeClient((m) =>
      m === 'substrate:appendOp' ? { ok: true, ownLogLength: 1, hlc: null } : undefined,
    );
    const h = makeHandle(client);
    const peerOp: PeerLogOp = {
      type: 'put',
      table: 'feature_claims',
      hbKey: 'c-1',
      value: {},
      ts: 5,
      schema_version: 1,
      author_pubkey: 'dev',
    };
    await h.ownLog.append(peerOp);
    expect(calls[0].method).toBe('substrate:appendOp');
    expect(calls[0].params).toMatchObject({ storeId: 'store-1', op: peerOp, raw: true });
    expect(h.ownLog.length).toBe(1);
  });

  it('mergeNow routes to substrate:triggerMergeNow and returns mergedOps', async () => {
    const { client, calls } = makeClient((m) =>
      m === 'substrate:triggerMergeNow' ? { mergedOps: 3, durationMs: 1 } : undefined,
    );
    const h = makeHandle(client);
    const n = await h.mergeNow();
    expect(n).toBe(3);
    expect(calls[0].method).toBe('substrate:triggerMergeNow');
    expect(calls[0].params).toMatchObject({ storeId: 'store-1' });
  });

  it('revoke + rekey route to their IPC methods', async () => {
    const { client, calls } = makeClient();
    const h = makeHandle(client);
    await h.revoke('devpub');
    await h.rekey({ kind: 'hive', value: 'pub' } as never);
    expect(calls[0]).toMatchObject({ method: 'substrate:revoke', params: { storeId: 'store-1', devicePubkey: 'devpub' } });
    expect(calls[1]).toMatchObject({ method: 'substrate:rekey', params: { storeId: 'store-1' } });
  });

  it('close runs close-hooks (in order) then substrate:closeStore; idempotent', async () => {
    const { client, calls } = makeClient();
    const h = makeHandle(client);
    const order: string[] = [];
    h.registerCloseHook(() => {
      order.push('hook-a');
    });
    h.registerCloseHook(async () => {
      order.push('hook-b');
    });
    await h.close();
    await h.close(); // idempotent — no second closeStore
    expect(order).toEqual(['hook-a', 'hook-b']);
    const closeCalls = calls.filter((c) => c.method === 'substrate:closeStore');
    expect(closeCalls).toHaveLength(1);
  });

  it('an unregistered close-hook does not run', async () => {
    const { client } = makeClient();
    const h = makeHandle(client);
    const hook = vi.fn();
    const unregister = h.registerCloseHook(hook);
    unregister();
    await h.close();
    expect(hook).not.toHaveBeenCalled();
  });

  it('store access throws (sidecar-internal); swarm null; admitted empty; onAnnounce throws', () => {
    const { client } = makeClient();
    const h = makeHandle(client);
    expect(() => h.store).toThrow(/lives in the\s+substrate sidecar/);
    expect(h.swarm).toBeNull();
    expect(h.admitted.size).toBe(0);
    expect(() => h.onAnnounce({} as never)).toThrow(/handled inside the/);
    // onAdmitted returns a no-op unsubscribe (does not throw)
    const unsub = h.onAdmitted(() => {});
    expect(typeof unsub).toBe('function');
    unsub();
  });
});
