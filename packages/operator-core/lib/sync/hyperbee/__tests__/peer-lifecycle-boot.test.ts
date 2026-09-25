import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootHarnessSubstrate } from '../boot';
import { buildAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';
import { _clearRegistryForTests } from '../projection';
import type { RemoteLog } from '../peer-log';
import type { MergeCursorPeerLifecycle, MergeCursorPeerLifecycleUpdate, MergeCursorStore } from '../read-merge';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort teardown
    }
  }
  _resetCacheForTests();
  _clearRegistryForTests();
  _resetBootHistoryForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
  return {
    devicePubkey,
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

async function makeAnnounce(device: ReturnType<typeof makeDevice>, logCoreKey: string) {
  return buildAnnounce(
    {
      device_pubkey: device.devicePubkey,
      github_user_id: 4242,
      github_login: 'peer-alice',
      attestation_gist_id: 'gist-test',
      log_core_key: logCoreKey,
    },
    device.sign,
  );
}

function makeLifecycleStore(opts: { failUpsert?: boolean } = {}): {
  store: MergeCursorStore;
  rows: Map<string, MergeCursorPeerLifecycle>;
  attempts: MergeCursorPeerLifecycleUpdate[];
} {
  const rows = new Map<string, MergeCursorPeerLifecycle>();
  const attempts: MergeCursorPeerLifecycleUpdate[] = [];
  const store: MergeCursorStore = {
    load: async () => new Map(),
    save: async () => undefined,
    peerLifecycle: {
      load: async () => new Map(rows),
      upsert: async (updates) => {
        attempts.push(...updates);
        if (opts.failUpsert) throw new Error('lifecycle store unavailable');
        for (const update of updates) {
          rows.set(update.logKeyHex, {
            ...update,
            updatedAt: new Date(),
          });
        }
      },
    },
  };
  return { store, rows, attempts };
}

function makeClosableRemoteLog(logKeyHex: string, closes: Map<string, () => Promise<void>>): RemoteLog {
  const close = vi.fn(async () => undefined);
  closes.set(logKeyHex, close);
  return {
    keyHex: logKeyHex,
    length: 0,
    contiguousLength: 0,
    get: async () => null,
    update: async () => undefined,
    prefetch: () => undefined,
    has: async () => false,
    close,
  };
}

describe('boot peer lifecycle persistence', () => {
  it('marks a verified admission active and an explicit revoke retired', async () => {
    const lifecycle = makeLifecycleStore();
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-admit-'),
      workspaceId: 'ws-peer-lifecycle-admit',
      harnessSlug: 'peer-lifecycle-admit',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'aa'.repeat(32);
    await handle.onAnnounce(await makeAnnounce(device, logCoreKey));

    expect(lifecycle.rows.get(logCoreKey)).toMatchObject({
      logKeyHex: logCoreKey,
      devicePubkey: device.devicePubkey,
      state: 'active',
    });

    await handle.revoke(device.devicePubkey);

    expect(lifecycle.rows.get(logCoreKey)).toMatchObject({
      logKeyHex: logCoreKey,
      devicePubkey: device.devicePubkey,
      state: 'retired',
    });
  });

  it('explicit revoke retires, removes, and closes every log announced by one device', async () => {
    const lifecycle = makeLifecycleStore();
    const closes = new Map<string, () => Promise<void>>();
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-multi-log-revoke-'),
      workspaceId: 'ws-peer-lifecycle-multi-log-revoke',
      harnessSlug: 'peer-lifecycle-multi-log-revoke',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      openRemoteLogOverride: async (_store, logKeyHex) => makeClosableRemoteLog(logKeyHex, closes),
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logKeys = ['a1'.repeat(32), 'a2'.repeat(32)];
    for (const logKey of logKeys) {
      await handle.onAnnounce(await makeAnnounce(device, logKey));
      expect(handle.admitted.has(logKey)).toBe(true);
    }

    await handle.revoke(device.devicePubkey);

    for (const logKey of logKeys) {
      expect(handle.admitted.has(logKey)).toBe(false);
      expect(lifecycle.rows.get(logKey)).toMatchObject({
        logKeyHex: logKey,
        devicePubkey: device.devicePubkey,
        state: 'retired',
      });
      expect(closes.get(logKey)).toHaveBeenCalledTimes(1);
    }
  });

  it('persists published-list revoke and explicit un-revoke transitions', async () => {
    const lifecycle = makeLifecycleStore();
    const published = new Set<string>();
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-refresh-'),
      workspaceId: 'ws-peer-lifecycle-refresh',
      harnessSlug: 'peer-lifecycle-refresh',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(published),
      verifyBindingOverride: async () => 'verified',
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'bb'.repeat(32);
    await handle.onAnnounce(await makeAnnounce(device, logCoreKey));

    published.add(device.devicePubkey);
    await handle.mergeNow();
    expect(lifecycle.rows.get(logCoreKey)?.state).toBe('retired');

    published.delete(device.devicePubkey);
    await handle.mergeNow();
    expect(lifecycle.rows.get(logCoreKey)).toMatchObject({
      devicePubkey: device.devicePubkey,
      state: 'active',
    });
  });

  it('published-list refresh retires, removes, and closes every log announced by one device', async () => {
    const lifecycle = makeLifecycleStore();
    const published = new Set<string>();
    const closes = new Map<string, () => Promise<void>>();
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-multi-log-refresh-'),
      workspaceId: 'ws-peer-lifecycle-multi-log-refresh',
      harnessSlug: 'peer-lifecycle-multi-log-refresh',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(published),
      verifyBindingOverride: async () => 'verified',
      openRemoteLogOverride: async (_store, logKeyHex) => makeClosableRemoteLog(logKeyHex, closes),
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logKeys = ['b1'.repeat(32), 'b2'.repeat(32)];
    for (const logKey of logKeys) {
      await handle.onAnnounce(await makeAnnounce(device, logKey));
    }

    published.add(device.devicePubkey);
    await handle.mergeNow();

    for (const logKey of logKeys) {
      expect(handle.admitted.has(logKey)).toBe(false);
      expect(lifecycle.rows.get(logKey)).toMatchObject({
        devicePubkey: device.devicePubkey,
        state: 'retired',
      });
      expect(closes.get(logKey)).toHaveBeenCalledTimes(1);
    }
  });

  it('marks a conclusive channel-2 reverify drop retired', async () => {
    const lifecycle = makeLifecycleStore();
    let binding: 'verified' | 'fail' = 'verified';
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-reverify-'),
      workspaceId: 'ws-peer-lifecycle-reverify',
      harnessSlug: 'peer-lifecycle-reverify',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => binding,
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'cc'.repeat(32);
    await handle.onAnnounce(await makeAnnounce(device, logCoreKey));

    binding = 'fail';
    await handle.reverifyAdmitted();
    await handle.mergeNow();

    expect(lifecycle.rows.get(logCoreKey)).toMatchObject({
      devicePubkey: device.devicePubkey,
      state: 'retired',
    });
  });

  it('a one-log reverify drop preserves the sibling mapping for a later device revoke', async () => {
    const lifecycle = makeLifecycleStore();
    const closes = new Map<string, () => Promise<void>>();
    let binding: 'verified' | 'fail' = 'verified';
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-multi-log-reverify-'),
      workspaceId: 'ws-peer-lifecycle-multi-log-reverify',
      harnessSlug: 'peer-lifecycle-multi-log-reverify',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      reverifyBatchSize: 1,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => binding,
      openRemoteLogOverride: async (_store, logKeyHex) => makeClosableRemoteLog(logKeyHex, closes),
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const firstLogKey = 'c1'.repeat(32);
    const siblingLogKey = 'c2'.repeat(32);
    await handle.onAnnounce(await makeAnnounce(device, firstLogKey));
    await handle.onAnnounce(await makeAnnounce(device, siblingLogKey));

    binding = 'fail';
    await handle.reverifyAdmitted();
    await handle.mergeNow();

    expect(handle.admitted.has(firstLogKey)).toBe(false);
    expect(handle.admitted.has(siblingLogKey)).toBe(true);
    expect(closes.get(firstLogKey)).toHaveBeenCalledTimes(1);

    await handle.revoke(device.devicePubkey);

    expect(handle.admitted.has(siblingLogKey)).toBe(false);
    expect(lifecycle.rows.get(firstLogKey)?.state).toBe('retired');
    expect(lifecycle.rows.get(siblingLogKey)?.state).toBe('retired');
    expect(closes.get(siblingLogKey)).toHaveBeenCalledTimes(1);
  });

  it('serializes a channel-2 retire before a rapid active re-admission', async () => {
    const rows = new Map<string, MergeCursorPeerLifecycle>();
    const attempts: MergeCursorPeerLifecycleUpdate[] = [];
    let releaseRetired!: () => void;
    const retiredGate = new Promise<void>((resolve) => {
      releaseRetired = resolve;
    });
    let retiredStarted!: () => void;
    const retiredStartedGate = new Promise<void>((resolve) => {
      retiredStarted = resolve;
    });
    const store: MergeCursorStore = {
      load: async () => new Map(),
      save: async () => undefined,
      peerLifecycle: {
        load: async () => new Map(rows),
        upsert: async (updates) => {
          attempts.push(...updates);
          if (updates.some((update) => update.state === 'retired')) {
            retiredStarted();
            await retiredGate;
          }
          for (const update of updates) {
            rows.set(update.logKeyHex, { ...update, updatedAt: new Date() });
          }
        },
      },
    };
    let binding: 'verified' | 'fail' = 'verified';
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-order-'),
      workspaceId: 'ws-peer-lifecycle-order',
      harnessSlug: 'peer-lifecycle-order',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => binding,
      mergeCursorStore: store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'ce'.repeat(32);
    const frame = await makeAnnounce(device, logCoreKey);
    await handle.onAnnounce(frame);

    binding = 'fail';
    await handle.reverifyAdmitted();
    await handle.mergeNow();
    await retiredStartedGate;
    expect(handle.admitted.has(logCoreKey)).toBe(false);

    binding = 'verified';
    const readmit = handle.onAnnounce(frame);
    await vi.waitFor(() => expect(handle.admitted.has(logCoreKey)).toBe(true));
    releaseRetired();
    await readmit;

    expect(attempts.map((attempt) => attempt.state)).toEqual(['active', 'retired', 'active']);
    expect(rows.get(logCoreKey)?.state).toBe('active');
  });

  it('isolates lifecycle-store failures as merge_error without breaking admission or revoke', async () => {
    const lifecycle = makeLifecycleStore({ failUpsert: true });
    const handle = await bootHarnessSubstrate({
      rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
      workspaceRoot: tmpDir('peer-lifecycle-failure-'),
      workspaceId: 'ws-peer-lifecycle-failure',
      harnessSlug: 'peer-lifecycle-failure',
      mergePollMs: 0,
      pendingRetryMs: 0,
      reverifyIntervalMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      mergeCursorStore: lifecycle.store,
    });
    cleanups.push(() => handle.close());

    const device = makeDevice();
    const logCoreKey = 'dd'.repeat(32);
    await expect(handle.onAnnounce(await makeAnnounce(device, logCoreKey))).resolves.toMatchObject({
      admit: true,
    });
    expect(handle.admitted.has(logCoreKey)).toBe(true);

    await expect(handle.revoke(device.devicePubkey)).resolves.toBeUndefined();
    expect(handle.admitted.has(logCoreKey)).toBe(false);
    expect(lifecycle.attempts).toEqual([
      { logKeyHex: logCoreKey, devicePubkey: device.devicePubkey, state: 'active' },
      { logKeyHex: logCoreKey, devicePubkey: device.devicePubkey, state: 'retired' },
    ]);
    expect(
      listBootHistory({
        workspaceId: 'ws-peer-lifecycle-failure',
        harnessSlug: 'peer-lifecycle-failure',
        kinds: ['merge_error'],
        limit: 10,
      }).filter((event) => event.message?.includes('peer-lifecycle')),
    ).toHaveLength(2);
  });
});
