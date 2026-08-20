import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { bootHarnessSubstrate } from '../boot';
import { buildAnnounce } from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';
import { _clearRegistryForTests } from '../projection';
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

describe('boot peer lifecycle persistence', () => {
  it('marks a verified admission active and an explicit revoke retired', async () => {
    const lifecycle = makeLifecycleStore();
    const handle = await bootHarnessSubstrate({
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

  it('persists published-list revoke and explicit un-revoke transitions', async () => {
    const lifecycle = makeLifecycleStore();
    const published = new Set<string>();
    const handle = await bootHarnessSubstrate({
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

  it('marks a conclusive channel-2 reverify drop retired', async () => {
    const lifecycle = makeLifecycleStore();
    let binding: 'verified' | 'fail' = 'verified';
    const handle = await bootHarnessSubstrate({
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

  it('isolates lifecycle-store failures as merge_error without breaking admission or revoke', async () => {
    const lifecycle = makeLifecycleStore({ failUpsert: true });
    const handle = await bootHarnessSubstrate({
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
