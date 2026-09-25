/**
 * WI-10002600 — a device that re-keys its own log (own-log fork recovery,
 * own-log-fork-recovery.ts) must be able to retire the OLD log on every peer.
 *
 * Before this fix every drop path in boot.ts was DEVICE-level (explicit revoke,
 * published revoke, channel-2 reverify fail). A re-keyed device keeps a valid
 * binding, so a receiver admitted the new key BESIDE the old one and the old key
 * sat admitted with no replicator for the rest of the process lifetime — the
 * harness liveness verdict stayed unhealthy (endgame D-049).
 */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootHarnessSubstrate } from '../boot';
import {
  announceSigningBytes,
  buildAnnounce,
  buildLogSupersession,
  verifyAnnounce,
  verifyLogSupersession,
} from '../announce';
import { _resetCacheForTests } from '../corestore';
import { _resetBootHistoryForTests, listBootHistory } from '../boot-history';
import {
  forkedStoreAsidePath,
  parseSupersededOwnLogKeys,
  readSupersededOwnLogKeys,
} from '../own-log-supersession';
import { _clearRegistryForTests } from '../projection';
import { _resetReplicationLivenessForTests, getReplicationLiveness } from '../replication-liveness';
import type { RemoteLog } from '../peer-log';
import type { MergeCursorPeerLifecycle, MergeCursorStore } from '../read-merge';

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
  _resetReplicationLivenessForTests();
});

function tmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  return {
    devicePubkey,
    sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
  };
}

type Device = ReturnType<typeof makeDevice>;

async function announceLog(
  device: Device,
  logCoreKey: string,
  logLength?: number,
  supersedes: readonly string[] = [],
) {
  return buildAnnounce(
    {
      device_pubkey: device.devicePubkey,
      github_user_id: 4242,
      github_login: 'peer-vm',
      attestation_gist_id: 'gist-test',
      log_core_key: logCoreKey,
      ...(logLength !== undefined ? { log_length: logLength } : {}),
      ...(await buildLogSupersession(
        { device_pubkey: device.devicePubkey, log_core_key: logCoreKey },
        supersedes,
        device.sign,
      )),
    },
    device.sign,
  );
}

/** A remote log with NO live replicator: its writer's store was moved aside. */
function makeDeadRemoteLog(logKeyHex: string, closes: Map<string, ReturnType<typeof vi.fn>>): RemoteLog {
  const close = vi.fn(async () => undefined);
  closes.set(logKeyHex, close);
  const log = {
    keyHex: logKeyHex,
    length: 0,
    contiguousLength: 0,
    get: async () => null,
    update: async () => undefined,
    prefetch: () => undefined,
    has: async () => false,
    close,
    peersCount: () => 0,
  };
  return log as RemoteLog;
}

function makeLifecycleStore() {
  const rows = new Map<string, MergeCursorPeerLifecycle>();
  const store: MergeCursorStore = {
    load: async () => new Map(),
    save: async () => undefined,
    peerLifecycle: {
      load: async () => new Map(rows),
      upsert: async (updates) => {
        for (const update of updates) rows.set(update.logKeyHex, { ...update, updatedAt: new Date() });
      },
    },
  };
  return { store, rows };
}

async function bootReceiver(slug: string) {
  const lifecycle = makeLifecycleStore();
  const closes = new Map<string, ReturnType<typeof vi.fn>>();
  const workspaceId = `ws-${slug}`;
  const handle = await bootHarnessSubstrate({
    rekeyDepsOverride: null, // unit boot must not auto-build re-key deps through real PG
    workspaceRoot: tmpDir(`${slug}-`),
    workspaceId,
    harnessSlug: slug,
    mergePollMs: 0,
    pendingRetryMs: 0,
    reverifyIntervalMs: 0,
    loadRevokedOverride: async () => new Set(),
    verifyBindingOverride: async () => 'verified',
    openRemoteLogOverride: async (_store, logKeyHex) => makeDeadRemoteLog(logKeyHex, closes),
    mergeCursorStore: lifecycle.store,
  });
  cleanups.push(() => handle.close());
  const livenessKeys = () =>
    (getReplicationLiveness({ workspaceId, harnessSlug: slug })[0]?.logs ?? []).map((l) => l.keyHex);
  return { handle, lifecycle, closes, livenessKeys };
}

// The Mac VM's forked own log (EI-21150671414510762) and the key it re-keys to.
const OLD_KEY = 'f417b935852af51e7bdf676effa8a29f59e7db23413690521c5d39810e8c087a';
const NEW_KEY = '0b'.repeat(32);

describe('WI-10002600 premise: a re-keyed device leaves its old log admitted', () => {
  it('a legacy re-key announce (no supersession) keeps the dead key admitted and tracked', async () => {
    const r = await bootReceiver('supersede-premise');
    const vm = makeDevice();

    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 24_275));
    await r.handle.mergeNow();
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);
    expect(r.livenessKeys()).toContain(OLD_KEY);

    // The device re-keys: its fresh own log announces under the SAME device identity.
    await r.handle.onAnnounce(await announceLog(vm, NEW_KEY, 0));
    await r.handle.mergeNow();

    expect(r.handle.admitted.has(NEW_KEY)).toBe(true);
    // The premise: nothing retires the old key — it stays admitted and keeps
    // feeding the harness liveness verdict with a log nobody will ever serve.
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);
    expect(r.livenessKeys()).toContain(OLD_KEY);
    expect(r.lifecycle.rows.get(OLD_KEY)?.state).toBe('active');
  });
});

describe('WI-10002600 fix: a signed own-log supersession retires the dead key', () => {
  it('the re-keyed announce retires, closes, and stops tracking the old log; the new log stays', async () => {
    const r = await bootReceiver('supersede-retire');
    const vm = makeDevice();

    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 24_275));
    await r.handle.mergeNow();
    expect(r.livenessKeys()).toContain(OLD_KEY);

    await expect(r.handle.onAnnounce(await announceLog(vm, NEW_KEY, 0, [OLD_KEY]))).resolves.toMatchObject({
      admit: true,
    });
    await r.handle.mergeNow();

    expect(r.handle.admitted.has(NEW_KEY)).toBe(true);
    expect(r.handle.admitted.has(OLD_KEY)).toBe(false);
    expect(r.closes.get(OLD_KEY)).toHaveBeenCalledTimes(1);
    expect(r.livenessKeys()).not.toContain(OLD_KEY);
    expect(r.livenessKeys()).toContain(NEW_KEY);
    expect(r.lifecycle.rows.get(OLD_KEY)).toMatchObject({ devicePubkey: vm.devicePubkey, state: 'retired' });
    expect(r.lifecycle.rows.get(NEW_KEY)?.state).toBe('active');
    const events = listBootHistory({
      workspaceId: 'ws-supersede-retire',
      harnessSlug: 'supersede-retire',
      kinds: ['peer_log_superseded'],
      limit: 10,
    });
    expect(events.some((e) => e.message?.includes('superseded by'))).toBe(true);
  });

  it('refuses a supersession naming ANOTHER device’s log (only the owning device may retire it)', async () => {
    const r = await bootReceiver('supersede-cross-device');
    const owner = makeDevice();
    const attacker = makeDevice();

    await r.handle.onAnnounce(await announceLog(owner, OLD_KEY, 10));
    await r.handle.onAnnounce(await announceLog(attacker, NEW_KEY, 0, [OLD_KEY]));
    await r.handle.mergeNow();

    // The attacker's own log is admitted normally; the owner's log is untouched.
    expect(r.handle.admitted.has(NEW_KEY)).toBe(true);
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);
    expect(r.closes.get(OLD_KEY)).not.toHaveBeenCalled();
    expect(r.lifecycle.rows.get(OLD_KEY)?.state).toBe('active');
    const refusals = listBootHistory({
      workspaceId: 'ws-supersede-cross-device',
      harnessSlug: 'supersede-cross-device',
      kinds: ['peer_log_superseded'],
      limit: 10,
    });
    expect(refusals.some((e) => e.message?.includes('owned by another device'))).toBe(true);

    // …and the refused claim does not block the owner from re-announcing its log.
    await r.handle.onAnnounce(await announceLog(owner, OLD_KEY, 11));
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);
  });

  it('a late or out-of-order announce of the superseded key cannot resurrect it', async () => {
    const r = await bootReceiver('supersede-late');
    const vm = makeDevice();

    // The receiver learns the supersession BEFORE it ever sees the old key.
    await r.handle.onAnnounce(await announceLog(vm, NEW_KEY, 0, [OLD_KEY]));
    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 24_275));
    await r.handle.mergeNow();

    expect(r.handle.admitted.has(NEW_KEY)).toBe(true);
    expect(r.handle.admitted.has(OLD_KEY)).toBe(false);
    expect(r.livenessKeys()).not.toContain(OLD_KEY);
  });

  it('ignores a supersession whose signature does not verify (the announce itself still admits)', async () => {
    const r = await bootReceiver('supersede-bad-sig');
    const vm = makeDevice();

    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 10));
    const frame = await announceLog(vm, NEW_KEY, 0, [OLD_KEY]);
    // A relay grafts a different key list onto the frame: the list is not covered by
    // the announce signature, but it IS covered by supersedes_sig.
    const tampered = { ...frame, supersedes_log_keys: ['0c'.repeat(32)] };
    expect(verifyAnnounce(tampered)).toBe(true);
    expect(verifyLogSupersession(tampered)).toEqual({ status: 'invalid', reason: 'bad_sig' });

    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 10));
    await r.handle.onAnnounce(tampered);
    await r.handle.mergeNow();
    expect(r.handle.admitted.has(NEW_KEY)).toBe(true);
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);
  });

  it('applies a supersession that arrives on a re-announce of an already-admitted key', async () => {
    const r = await bootReceiver('supersede-reannounce');
    const vm = makeDevice();

    // Order on the wire is not guaranteed: the new key can be admitted from a frame
    // that raced ahead of the old key's admission, then re-announced.
    await r.handle.onAnnounce(await announceLog(vm, NEW_KEY, 0));
    await r.handle.onAnnounce(await announceLog(vm, OLD_KEY, 24_275));
    expect(r.handle.admitted.has(OLD_KEY)).toBe(true);

    await r.handle.onAnnounce(await announceLog(vm, NEW_KEY, 1, [OLD_KEY]));
    await r.handle.mergeNow();
    expect(r.handle.admitted.has(OLD_KEY)).toBe(false);
  });
});

describe('WI-10002600 wire compatibility of the supersession fields', () => {
  it('leaves the legacy announce signing bytes unchanged, so an older peer still verifies the frame', async () => {
    const vm = makeDevice();
    const plain = await announceLog(vm, NEW_KEY, 3);
    const withSupersession = { ...plain, ...(await buildLogSupersession(plain, [OLD_KEY], vm.sign)) };

    expect(withSupersession.supersedes_log_keys).toEqual([OLD_KEY]);
    expect(announceSigningBytes(withSupersession).equals(announceSigningBytes(plain))).toBe(true);
    // The original announce signature still verifies with the fields attached.
    expect(verifyAnnounce(withSupersession)).toBe(true);
    expect(verifyLogSupersession(withSupersession)).toEqual({ status: 'valid', keys: [OLD_KEY] });
  });

  it('a device that never re-keyed sends exactly the frame it always did', async () => {
    const vm = makeDevice();
    expect(await buildLogSupersession({ device_pubkey: vm.devicePubkey, log_core_key: NEW_KEY }, [], vm.sign)).toEqual(
      {},
    );
    const frame = await announceLog(vm, NEW_KEY, 3);
    expect('supersedes_log_keys' in frame).toBe(false);
    expect(verifyLogSupersession(frame)).toEqual({ status: 'absent' });
  });

  it('never lists the replacement key itself, de-duplicates, and rejects a statement lifted onto another log', async () => {
    const vm = makeDevice();
    const s = await buildLogSupersession(
      { device_pubkey: vm.devicePubkey, log_core_key: NEW_KEY },
      [OLD_KEY, OLD_KEY.toUpperCase(), NEW_KEY, 'not-a-key'],
      vm.sign,
    );
    expect(s.supersedes_log_keys).toEqual([OLD_KEY]);

    // The same statement grafted onto a frame for a DIFFERENT log of the device fails:
    // the replacement key is part of what was signed.
    const other = await announceLog(vm, '0d'.repeat(32), 1);
    expect(verifyLogSupersession({ ...other, ...s })).toEqual({ status: 'invalid', reason: 'bad_sig' });
  });
});

describe('WI-10002600 sender: the retired keys are derived from the aside directories', () => {
  const STORE = '/ws/.papercusp/hello-world-3-pot/hyperbee';

  it('reads back the full key recovery wrote into the aside name, newest first', () => {
    const older = forkedStoreAsidePath(STORE, 'AA'.repeat(32), '2026-09-01T00-00-00-000Z');
    const newer = forkedStoreAsidePath(STORE, OLD_KEY, '2026-09-23T05-00-00-000Z');
    expect(newer).toBe(`${STORE}.forked-${OLD_KEY}-2026-09-23T05-00-00-000Z`);
    const names = [
      'hyperbee',
      'hyperbee.single-instance.lock',
      // a pre-WI-10002600 aside carries only 12 hex chars: not enough to supersede
      'hyperbee.forked-f417b935852a-2026-09-20T00-00-00-000Z',
      'other.forked-' + 'bb'.repeat(32) + '-2026-09-23T06-00-00-000Z',
      older.split('/').pop()!,
      newer.split('/').pop()!,
    ];
    expect(parseSupersededOwnLogKeys(STORE, names)).toEqual([OLD_KEY, 'aa'.repeat(32)]);
  });

  it('a harness with no parent directory yet has nothing to supersede', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'ENOENT' });
    await expect(readSupersededOwnLogKeys(STORE, async () => Promise.reject(missing))).resolves.toEqual([]);
    await expect(
      readSupersededOwnLogKeys(STORE, async () => Promise.reject(new Error('EACCES'))),
    ).rejects.toThrow('EACCES');
  });
});
