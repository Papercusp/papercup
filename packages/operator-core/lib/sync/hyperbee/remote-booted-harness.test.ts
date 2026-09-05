/**
 * remote-booted-harness.test.ts — Phase 1 of the substrate store relocation
 * (substrate-sidecar-store-relocation-2026-06-23, P-001).
 *
 * Proves the main-side proxy maps `BootedHarnessHandle` calls onto the right
 * IPC methods, using an injected fake RPC client (no sidecar / no socket):
 *   - append(op)        → substrate:appendOp (HLC-stamped in the sidecar)
 *   - ownLog.append(op) → substrate:appendOp { raw:true }
 *   - ownLog.get(index) → substrate:getOwnLogOp (bounded diagnostic read)
 *   - ownLog.keyHex     → the boot-provided key (data, no IPC)
 *   - mergeNow/revoke/rekey/close → their IPC methods
 *   - store/onAnnounce  → throw (sidecar-internal); swarm null; admitted empty
 */

import { describe, it, expect, vi } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  openHiveGitDuplexViaExistingSidecar,
  RemoteBootedHarnessHandle,
  type SubstrateRpcCaller,
} from './remote-booted-harness';
import type { LocalWriteOp } from './boot';
import type { PeerLogOp } from './peer-log';
import { GIT_SERVING_LEASE_MS, guardGitServingSigner, type GitServingRequest, type GitServingState } from '../pot-git/serving-capability';

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
  it('P514 re-reads live serving authority across owner restart; never uses the boot identity cache', async () => {
    const request: GitServingRequest = { workspaceId: 'ws', installSlug: 'h-1', potHomeSlug: 'home', scope: { hive_id: 'hive', repo_key: 'repo' } };
    const issuedAtMs = Date.now();
    const first = { status: 'ready' as const, capability: { ...request, v: 1 as const, runtimeId: 'owner-1',
      identity: { devicePubkeyBase64: 'serving-device', githubUserId: 42, keychainId: 'serving-key' },
      context: { ...request.scope, store_generation: `sg2-1-${'a'.repeat(40)}` },
      issuedAtMs, expiresAtMs: issuedAtMs + GIT_SERVING_LEASE_MS } };
    let current: GitServingState = first;
    const { client, calls } = makeClient(() => ({ gitServing: current }));
    const handle = makeHandle(client);
    expect(handle.announceIdentity).toBeNull();
    expect(await handle.getGitServingCapability(request)).toEqual(first);
    const signer = vi.fn(async () => Buffer.from('signed'));
    const sign = guardGitServingSigner(first.capability, request, () => handle.getGitServingCapability(request), signer);
    expect(await sign(Buffer.from('message'))).toEqual(Buffer.from('signed'));
    current = { status: 'ready', capability: { ...first.capability, runtimeId: 'owner-2' } };
    await expect(sign(Buffer.from('stale message'))).rejects.toMatchObject({ retryable: true });
    expect(signer).toHaveBeenCalledTimes(1);
    expect(calls.every(c => c.method === 'substrate:getStoreStatus')).toBe(true);
    await handle.close();
    expect(await handle.getGitServingCapability(request)).toMatchObject({ status: 'stopped' });
  });

  it('P514 treats old or unreachable RPC owners as unknown', async () => {
    const request: GitServingRequest = { workspaceId: 'ws', installSlug: 'h-1', potHomeSlug: 'home', scope: { hive_id: 'hive', repo_key: 'repo' } };
    expect(await makeHandle(makeClient(() => ({})).client).getGitServingCapability(request)).toMatchObject({ status: 'unknown', retryable: true });
    expect(await makeHandle(makeClient(() => { throw new Error('owner down'); }).client).getGitServingCapability(request)).toMatchObject({ status: 'unknown', retryable: true });
  });
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

  it('ownLog.get(index) routes to substrate:getOwnLogOp + refreshes tracked length', async () => {
    const peerOp: PeerLogOp = {
      type: 'put',
      table: 'coord_event_log',
      hbKey: '1007851',
      value: { id: '1007851' },
      ts: 5,
      schema_version: 1,
      author_pubkey: 'dev',
      epoch: 84,
    };
    const { client, calls } = makeClient((m) =>
      m === 'substrate:getOwnLogOp'
        ? { index: 62714, length: 63212, keyHex: KEY, op: peerOp }
        : undefined,
    );
    const h = makeHandle(client, 7);
    await expect(h.ownLog.get(62714)).resolves.toEqual(peerOp);
    expect(calls[0]).toEqual({
      method: 'substrate:getOwnLogOp',
      params: { storeId: 'store-1', index: 62714 },
    });
    expect(h.ownLog.length).toBe(63212);
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

  it('EI-20438405483051865: connects to the sidecar one-shot socket and returns a standard Duplex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'remote-hive-git-'));
    const socketPath = join(dir, 'stream.sock');
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      const { client, calls } = makeClient((method) =>
        method === 'substrate:openHiveGitDuplex'
          ? { socketPath, topicHex: 'deadbeef' }
          : undefined,
      );
      const h = makeHandle(client);
      const duplex = await h.openHiveGitDuplexToDevice('peer-device', {
        repoKey: 'gh-1296269',
        peerGithubUserId: 42,
      });

      expect(duplex.destroyed).toBe(false);
      expect(calls[0]).toEqual({
        method: 'substrate:openHiveGitDuplex',
        params: {
          storeId: 'store-1',
          devicePubkeyBase64: 'peer-device',
          repoKey: 'gh-1296269',
          peerGithubUserId: 42,
        },
      });
      const received = once(duplex, 'data');
      duplex.write(Buffer.from('ping'));
      expect(Buffer.from((await received)[0] as Buffer).toString()).toBe('ping');
      duplex.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
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

  /**
   * WI-2142873: this getter was a hardcoded `null` with a comment saying the
   * boot advertisement did not carry the identity. It does now, and that null
   * was load-bearing in the wrong direction — every git-sync hive leg holding a
   * relocated handle fell through to the gh-login actor and signed the pot's
   * ref-announces as a device that serves no topic, which no peer can dial.
   */
  it('reports the announce identity the sidecar returned at boot, not a hardcoded null', () => {
    const { client } = makeClient();
    const announceIdentity = {
      devicePubkeyBase64: 'XPAsvso1-aviynw-tower',
      githubUserId: 1567022,
      githubLogin: 'aviynw',
      keychainId: '1567022:tower',
    };
    const h = new RemoteBootedHarnessHandle({
      workspaceId: 'ws',
      harnessSlug: 'h-1',
      storeId: 'store-1',
      ownLogKey: KEY,
      announceIdentity,
      client,
    });

    expect(h.announceIdentity).toEqual(announceIdentity);
    // Data, not IPC — the identity came back with the boot response.
    expect(h.swarm).toBeNull();
  });

  it('still reports null against a sidecar that advertised no identity — absence is not invented', () => {
    // A pre-WI-2142873 sidecar. The honest answer is null; `pickHiveGitActor`
    // refuses on it rather than substituting a different device.
    const { client } = makeClient();
    expect(makeHandle(client).announceIdentity).toBeNull();
  });
});

describe('openHiveGitDuplexViaExistingSidecar (EI-20438405483051865)', () => {
  it('existing-only boots the exact handle before dialing with the returned store id', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'advertised-hive-git-'));
    const socketPath = join(dir, 'stream.sock');
    const server = createServer((socket) => socket.pipe(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolve);
    });

    try {
      const { client, calls } = makeClient((method) => {
        if (method === 'substrate:bootHarness') {
          return { storeId: 'existing-store', ownLogKey: KEY, ownLogLength: 9 };
        }
        if (method === 'substrate:openHiveGitDuplex') {
          return { socketPath, topicHex: 'deadbeef' };
        }
        return undefined;
      });
      const duplex = await openHiveGitDuplexViaExistingSidecar(
        {
          socketPath: '/tmp/advertised-substrate.sock',
          workspaceRoot: '/workspaces/ws',
          workspaceId: 'ws',
          harnessSlug: 'h-1',
          devicePubkeyBase64: 'peer-device',
          request: { repoKey: 'gh-1296269', peerGithubUserId: 42 },
        },
        { client },
      );

      expect(duplex.destroyed).toBe(false);
      expect(calls).toEqual([
        {
          method: 'substrate:bootHarness',
          params: {
            workspaceRoot: '/workspaces/ws',
            workspaceId: 'ws',
            harnessSlug: 'h-1',
            createIfMissing: false,
          },
        },
        {
          method: 'substrate:openHiveGitDuplex',
          params: {
            storeId: 'existing-store',
            devicePubkeyBase64: 'peer-device',
            repoKey: 'gh-1296269',
            peerGithubUserId: 42,
          },
        },
      ]);
      duplex.destroy();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed without dialing when the advertised socket has no existing exact handle', async () => {
    const { client, calls } = makeClient((method) => {
      if (method === 'substrate:bootHarness') throw new Error('store not booted');
      throw new Error(`unexpected RPC: ${method}`);
    });

    const duplex = await openHiveGitDuplexViaExistingSidecar(
      {
        socketPath: '/tmp/stale-substrate.sock',
        workspaceRoot: '/workspaces/ws',
        workspaceId: 'ws',
        harnessSlug: 'h-1',
        devicePubkeyBase64: 'peer-device',
        request: { repoKey: 'gh-1296269' },
      },
      { client },
    );

    expect(duplex.destroyed).toBe(true);
    expect(calls).toEqual([
      {
        method: 'substrate:bootHarness',
        params: {
          workspaceRoot: '/workspaces/ws',
          workspaceId: 'ws',
          harnessSlug: 'h-1',
          createIfMissing: false,
        },
      },
    ]);
  });
});
