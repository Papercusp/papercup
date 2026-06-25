/**
 * bootHarnessSubstrate — composer tests (Model B, Stage 4a).
 *
 * Covers:
 *   - Argument validation (workspaceRoot / workspaceId / harnessSlug).
 *   - Schema-version alert event subscription / unsubscription.
 *   - The Model B handle shape: `ownLog.keyHex` + `mergeNow` + `admitted`
 *     (NOT the retired Autobase `base`).
 *   - The single-peer path: own writes → mergeNow → PG projection.
 *
 * The single-peer test uses a real Corestore over a tmp dir (mirrors
 * peer-log.test.ts) + a capturing projection sink (no real PG), with the
 * merge poll-timer disabled so the test drives `mergeNow()` by hand.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { bootHarnessSubstrate, onSchemaVersionAlert } from '../boot';
import { schemaVersionEvents, type SchemaVersionAlert, CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { openOwnLog } from '../peer-log';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import type { HyperswarmLike } from '../swarm';
import { _clearRegistryForTests } from '../projection';
import { listBootHistory } from '../boot-history';

/** Build a VALID signed announce with a freshly-generated Ed25519 keypair —
 *  `verifyAnnounce(frame)` (real crypto, runs inside boot's onAnnounce) returns
 *  true for this frame. log_core_key is a real 64-hex key boot can openRemoteLog. */
async function validAnnounce(over: Partial<SignedAnnounce> = {}): Promise<SignedAnnounce> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const rawPub = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
  const body = {
    device_pubkey: rawPub,
    github_user_id: 4242,
    github_login: 'alice',
    attestation_gist_id: 'gist-test',
    log_core_key: 'cc'.repeat(32),
    ...over,
  };
  return buildAnnounce(body, async (bytes) => nodeSign(null, bytes, privateKey));
}

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
    .subarray(-32)
    .toString('base64');
}

function makeFakeSwarm(): HyperswarmLike {
  return {
    join: () => ({ flushed: async () => {}, refresh: () => {} }),
    leave: () => {},
    on: () => {},
    off: () => {},
    connections: [],
  };
}

function makeAnnounceIdentityOverride(githubLogin: string, githubUserId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId: githubUserId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: githubUserId, login: githubLogin }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${githubLogin}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  schemaVersionEvents.removeAllListeners();
  _clearRegistryForTests();
  while (cleanups.length) {
    try { await cleanups.pop()!(); } catch {}
  }
  _resetCacheForTests();
});

describe('bootHarnessSubstrate — validation', () => {
  it('rejects missing workspaceRoot', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '', workspaceId: 'w', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceRoot/);
  });

  it('rejects missing workspaceId', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: '', harnessSlug: 's' }),
    ).rejects.toThrow(/workspaceId/);
  });

  it('rejects missing harnessSlug', async () => {
    await expect(
      bootHarnessSubstrate({ workspaceRoot: '/tmp', workspaceId: 'w', harnessSlug: '' }),
    ).rejects.toThrow(/harnessSlug/);
  });
});

describe('bootHarnessSubstrate — Model B handle shape + single-peer merge', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('exposes ownLog.keyHex + mergeNow + admitted, NOT base', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's1',
      mergePollMs: 0, // disable the poll timer; drive mergeNow by hand
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
    });
    cleanups.push(() => handle.close());

    expect(handle.ownLog.keyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof handle.mergeNow).toBe('function');
    expect(handle.admitted.get(handle.ownLog.keyHex)).toBe(handle.ownLog);
    // The retired Autobase `base` is gone.
    expect((handle as unknown as { base?: unknown }).base).toBeUndefined();
    expect(handle.swarm).toBeNull();
  });

  it('single-peer: own writes flow through mergeNow into the projection sink', async () => {
    // Capture applied ops via the applyOverride seam. The scoped per-harness
    // apply (buildHarnessProjectionApply) deliberately does NOT consult the
    // global registry (D-021 collision fix), so tests inject their own sink.
    const writes: unknown[] = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's2',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      applyOverride: async (op) => {
        if (op.table === 'mb_test_table') writes.push(op.value);
        return true;
      },
    });
    cleanups.push(() => handle.close());

    await handle.append({
      type: 'put',
      table: 'mb_test_table',
      hbKey: 'F-1',
      value: { id: 'F-1' },
      ts: 1000,
      schema_version: CURRENT_SCHEMA_VERSION,
    });
    expect(handle.ownLog.length).toBe(1);

    const applied = await handle.mergeNow();
    expect(applied).toBe(1);
    expect(writes).toEqual([{ id: 'F-1' }]);
  });

  // ── registerCloseHook (Stage 5 outbox-drain teardown seam) ──────────────────
  it('registerCloseHook: close() runs the hook once, before store teardown; unregister cancels it', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 's-hook',
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
    });

    let ran = 0;
    handle.registerCloseHook(() => {
      ran += 1;
    });
    // A second, unregistered hook must NOT run.
    let cancelled = 0;
    const off = handle.registerCloseHook(() => {
      cancelled += 1;
    });
    off();

    await handle.close();
    expect(ran).toBe(1); // registered hook ran exactly once
    expect(cancelled).toBe(0); // unregistered hook never ran

    // close() is idempotent — a second close does not re-run the hook.
    await handle.close();
    expect(ran).toBe(1);
  });

  it('registerCloseHook: a throwing hook is swallowed (teardown still completes)', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handle = await bootHarnessSubstrate({
        workspaceRoot: tmpWorkspaceRoot(),
        workspaceId: 'ws-1',
        harnessSlug: 's-hook-throw',
        mergePollMs: 0,
        loadRevokedOverride: async () => new Set(),
      });
      handle.registerCloseHook(() => {
        throw new Error('hook boom');
      });
      // close() must resolve despite the throwing hook.
      await expect(handle.close()).resolves.toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining('close-hook failed'),
        expect.anything(),
      );
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('bootHarnessSubstrate — onAnnounce admit/reject (Stage 4b/4c, Fix 6)', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-ann-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  it('a VALID + admitted announce → remote log lands in admitted + mergeNow runs', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-1',
      mergePollMs: 0, // disable the poll so the only merge is onAnnounce's
      pendingRetryMs: 0, // disable the retry timer too
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      // binding check returns 'verified' → a valid-sig announce is admitted.
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const beforeKeys = [...handle.admitted.keys()];
    expect(beforeKeys).toEqual([handle.ownLog.keyHex]); // only the own log

    const frame = await validAnnounce({ log_core_key: 'cc'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(true);
    // The peer's remote log is now in the admitted set, keyed by its log_core_key.
    expect(handle.admitted.has('cc'.repeat(32))).toBe(true);
    const remote = handle.admitted.get('cc'.repeat(32))!;
    expect(remote.keyHex).toBe('cc'.repeat(32));
    expect(remote).not.toBe(handle.ownLog);
  });

  it('a REJECTED announce (binding fails) → not added, admit:false', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      // binding check returns 'fail' → not admitted (reason binding_invalid).
      verifyBindingOverride: async () => 'fail',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'dd'.repeat(32) });
    const decision = await handle.onAnnounce(frame);

    expect(decision.admit).toBe(false);
    expect(handle.admitted.has('dd'.repeat(32))).toBe(false);
    // Only the own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
  });

  it('a FORGED announce (bad sig) → reason bad_sig, binding never consulted', async () => {
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-3',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: verifyBinding,
    });
    cleanups.push(() => handle.close());

    // Tamper the sig so verifyAnnounce (real crypto) fails.
    const frame = await validAnnounce({ log_core_key: 'ee'.repeat(32) });
    const forged: SignedAnnounce = { ...frame, sig: Buffer.from('tampered').toString('base64') };
    const decision = await handle.onAnnounce(forged);

    expect(decision).toMatchObject({ admit: false, reason: 'bad_sig' });
    // The sig check short-circuits before the binding check.
    expect(verifyBinding).not.toHaveBeenCalled();
    expect(handle.admitted.has('ee'.repeat(32))).toBe(false);
  });

  it('admitting the same announce twice is idempotent (one remote log)', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-1',
      harnessSlug: 'ann-4',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({ log_core_key: 'ab'.repeat(32) });
    await handle.onAnnounce(frame);
    const first = handle.admitted.get('ab'.repeat(32));
    await handle.onAnnounce(frame);
    const second = handle.admitted.get('ab'.repeat(32));
    expect(second).toBe(first); // same handle, not re-opened
    expect(handle.admitted.size).toBe(2); // own + the one peer
  });
});

describe('bootHarnessSubstrate — WI-789 owner bootstrap admission', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-wi789-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  const WORKSPACE_ID = 'ws-wi789';
  const JOINER_MEMBER_SLUG = 'joined-owner-repo';
  const OWNER_MEMBER_SLUG = 'owner-repo';
  const HIVE_HOME_SLUG = 'owner-repo-home';
  const HIVE_PUBKEY = Buffer.alloc(32, 7).toString('base64');

  it('repro: gh-attested out-of-scope owner/member announce buffers when the joiner roster is empty', async () => {
    const ownerUserId = 9401;
    const joiner = makeAnnounceIdentityOverride('joiner', 9402, 'kc-wi789-joiner');
    const verifyBinding = vi.fn(async () => 'verified' as const);
    const loadHiveMembers = vi.fn(async () => [] as string[]);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: verifyBinding,
      loadHiveMembersOverride: loadHiveMembers,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner',
      attestation_gist_id: 'gist-owner',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f1'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    expect(verifyBinding).toHaveBeenCalledWith(
      frame.device_pubkey,
      'owner',
      ownerUserId,
      'gist-owner',
    );
    expect(loadHiveMembers).toHaveBeenCalledWith(HIVE_HOME_SLUG, ownerUserId);
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  it('control: the same production path admits once the owner/member device is in hive_members', async () => {
    const ownerUserId = 9501;
    const joiner = makeAnnounceIdentityOverride('joiner-control', 9502, 'kc-wi789-joiner-control');
    let ownerDevicePubkey = '';
    const loadHiveMembers = vi.fn(async (_hiveHome: string, _githubUserId: number) =>
      ownerDevicePubkey ? [ownerDevicePubkey] : [],
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: loadHiveMembers,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-control',
      attestation_gist_id: 'gist-owner-control',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f2'.repeat(32),
    });
    ownerDevicePubkey = frame.device_pubkey;

    const decision = await handle.onAnnounce(frame);

    expect(loadHiveMembers).toHaveBeenCalledWith(HIVE_HOME_SLUG, ownerUserId);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // WI-787 — the FIX. The owner-log bootstrap admit (boot.ts resolveSameHiveMember) trusts
  // the ONE device the signed, gh-verified hive-announce binds to the joined hive_pubkey
  // (`ownerDeviceForHiveOverride`; prod reads the verified hive_directory_cache binding), so
  // the owner's own log is admitted BEFORE the empty roster can deadlock — breaking WI-780.
  it('FIX: a gh-attested owner bootstrap announce admits on an empty roster via the signed owner-device binding (WI-787/WI-780)', async () => {
    const ownerUserId = 9601;
    const joiner = makeAnnounceIdentityOverride('joiner-desired', 9602, 'kc-wi789-joiner-desired');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async (_hivePubkey: string) => ownerDevice || null);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // roster still empty — the WI-780 condition
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-desired',
      attestation_gist_id: 'gist-owner-desired',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f3'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the signed owner_device_pubkey for this hive

    const decision = await handle.onAnnounce(frame);

    // Admitted via the owner-device binding, gated on THIS joined hive's pubkey.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // ADVERSARIAL 1 — the bootstrap admit is scoped to the EXACT bound device. A DIFFERENT
  // device (even one carrying the owner's github_user_id) must NOT ride the owner binding in;
  // with an empty roster it buffers (pending). Guards the WI-259 membership boundary against
  // admitting on github_user_id alone.
  it('ADVERSARIAL: a non-owner device with the owner github_user_id does NOT bootstrap-admit (still pending)', async () => {
    const ownerUserId = 9701;
    const joiner = makeAnnounceIdentityOverride('joiner-adv1', 9702, 'kc-wi789-joiner-adv1');
    // The binding resolves the REAL owner device — a fixed value unrelated to the spoofer's frame.
    const boundOwnerDevice = Buffer.alloc(32, 0x5a).toString('base64');
    const ownerDeviceForHive = vi.fn(async () => boundOwnerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // empty roster
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId, // claims the owner's gh id …
      github_login: 'owner-spoof',
      attestation_gist_id: 'gist-owner-spoof',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f4'.repeat(32),
    });
    // … but frame.device_pubkey !== boundOwnerDevice (different keypair), so the exact-device
    // gate refuses the bootstrap and the empty roster leaves it pending.
    expect(frame.device_pubkey).not.toBe(boundOwnerDevice);

    const decision = await handle.onAnnounce(frame);

    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 2 — fail-closed when there is NO verified owner-device binding for the hive
  // (e.g. no verified directory descriptor cached). Even the real owner device must buffer,
  // never admit on an unverified/absent binding.
  it('ADVERSARIAL: no verified owner-device binding ⇒ even the owner device buffers (fail-closed)', async () => {
    const ownerUserId = 9801;
    const joiner = makeAnnounceIdentityOverride('joiner-adv2', 9802, 'kc-wi789-joiner-adv2');
    const ownerDeviceForHive = vi.fn(async () => null); // no verified descriptor for this hive

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-noband',
      attestation_gist_id: 'gist-owner-noband',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f5'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    expect(ownerDeviceForHive).toHaveBeenCalled();
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });
});

describe('bootHarnessSubstrate — revocation drops the admitted log end-to-end (D-004, Fix 1)', () => {
  function tmpDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** A real device identity + an injectable Ed25519 signer (stable across calls,
   *  so a re-announce uses the SAME device_pubkey that was revoked). */
  function makeDevice(githubLogin: string, githubUserId: number) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const devicePubkey = (publicKey.export({ type: 'spki', format: 'der' }) as Buffer)
      .subarray(-32)
      .toString('base64');
    return {
      devicePubkey,
      githubUserId,
      githubLogin,
      sign: async (bytes: Buffer) => nodeSign(null, bytes, privateKey),
    };
  }

  /** Pipe two Corestores' replication streams both ways (Stage-0 verified). */
  function replicate(s1: Corestore, s2: Corestore): void {
    type Pipeable = { pipe<T extends Pipeable>(dest: T): T };
    const a = s1.replicate(true) as unknown as Pipeable;
    const b = s2.replicate(false) as unknown as Pipeable;
    a.pipe(b).pipe(a);
  }

  it('admit a remote peer (its op merges) → revoke → its NEW ops stop merging + a re-announce is refused', async () => {
    // Capture applied ops via the applyOverride seam (the scoped per-harness
    // apply doesn't consult the global registry — D-021), so we see exactly
    // which of the peer's ops merge before vs. after revocation.
    const writes: Array<{ id: string }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-1',
      mergePollMs: 0,                       // drive mergeNow by hand
      pendingRetryMs: 0,                    // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
      applyOverride: async (op) => {
        if (op.table === 'mb_revoke_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // ── A real remote peer P: its own store + writable log, replicated into the
    // host's store so P's ops actually cross to the host and merge. ──
    const peerDir = tmpDir('mb-revoke-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-alice', 4242);

    // P writes its FIRST op, then we replicate P's store into the host's store.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-1',
      value: { id: 'P-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

    // P announces (valid sig + binding-true) → admitted; merge applies P's op #0.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const admitDecision = await handle.onAnnounce(announce);
    expect(admitDecision.admit).toBe(true);
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(true);

    // onAnnounce already merged; P's first op is in PG.
    expect(writes).toEqual([{ id: 'P-1' }]);

    // ── REVOKE P. ── Drops its log from the admitted set + re-merges.
    await handle.revoke(P.devicePubkey);
    // The peer's log is no longer in the admitted set.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    // Only the host's own log remains admitted.
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);

    // ── P writes a NEW op after revocation. ── It must NOT merge: the log is
    // out of the admitted set, so mergeNow never reads it.
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_table', hbKey: 'P-2',
      value: { id: 'P-2' }, ts: 200, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    const appliedAfter = await handle.mergeNow();
    expect(appliedAfter).toBe(0);                       // nothing in the admitted set newly applied
    expect(writes).toEqual([{ id: 'P-1' }]);            // P-2 never reached PG

    // ── A re-announce from the revoked pubkey is refused with reason 'revoked'. ──
    const reAnnounce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: peerOwn.keyHex,
      },
      P.sign,
    );
    const reDecision = await handle.onAnnounce(reAnnounce);
    expect(reDecision).toMatchObject({ admit: false, reason: 'revoked' });
    // Still not re-admitted.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
  });

  it('revoking an unknown pubkey is a no-op (idempotent) but still blocks a future announce', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-unknown-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-2',
      mergePollMs: 0,
      pendingRetryMs: 0, // disable the retry timer
      loadRevokedOverride: async () => new Set(), // avoid real PG in tests
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const P = makeDevice('never-admitted', 7);
    // Revoke a pubkey we never admitted → no throw, admitted set unchanged.
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();
    expect([...handle.admitted.keys()]).toEqual([handle.ownLog.keyHex]);
    // Revoking again is still a no-op (idempotent).
    await expect(handle.revoke(P.devicePubkey)).resolves.toBeUndefined();

    // A subsequent (valid-sig) announce from that revoked pubkey is refused.
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: 'fe'.repeat(32),
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision).toMatchObject({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has('fe'.repeat(32))).toBe(false);
  });

  it('admission is THE boundary (P-003/D-004): a rejected peer\'s replicated ops never reach PG; an admitted peer\'s do', async () => {
    // The end-to-end statement of the trust boundary the D-004 re-grounding
    // rests on: BOTH peers announce AND replicate real ops into the host store
    // (so a rejected peer's ops are physically present locally) — yet ONLY the
    // admitted peer's ops project. Admission — not per-op signing — is what
    // keeps forged advisory rows out of local state. If this regresses (e.g. the
    // merge ever reads a non-admitted log), the rejected peer's op appears in PG.
    const writes: Array<{ id: string }> = [];
    const A = makeDevice('peer-admitted', 100);
    const B = makeDevice('peer-rejected', 200);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-admit-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'admit-boundary-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      // A's channel-2 binding verifies; B's conclusively fails → B is never admitted.
      verifyBindingOverride: async (devicePubkey: string) =>
        devicePubkey === A.devicePubkey ? 'verified' : 'fail',
      applyOverride: async (op) => {
        if (op.table === 'mb_admit_table') writes.push(op.value as { id: string });
        return true;
      },
    });
    cleanups.push(() => handle.close());

    // Two real peers, each with an own log carrying one op, BOTH replicated into
    // the host store — so both peers' ops are physically present locally.
    async function makePeer(prefix: string, dev: ReturnType<typeof makeDevice>, opId: string) {
      const store = new Corestore(tmpDir(prefix));
      cleanups.push(() => { void store.close(); });
      await store.ready();
      const own = await openOwnLog(store);
      await own.append({
        type: 'put', table: 'mb_admit_table', hbKey: opId,
        value: { id: opId }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
        author_pubkey: dev.devicePubkey,
      });
      replicate(store, handle.store);
      return own;
    }
    const aOwn = await makePeer('mb-admit-A-', A, 'A-1');
    const bOwn = await makePeer('mb-admit-B-', B, 'B-1');

    const mkAnnounce = (dev: ReturnType<typeof makeDevice>, logKey: string) =>
      buildAnnounce(
        {
          device_pubkey: dev.devicePubkey,
          github_user_id: dev.githubUserId,
          github_login: dev.githubLogin,
          attestation_gist_id: 'gist-test',
          log_core_key: logKey,
        },
        dev.sign,
      );

    const aDecision = await handle.onAnnounce(await mkAnnounce(A, aOwn.keyHex));
    const bDecision = await handle.onAnnounce(await mkAnnounce(B, bOwn.keyHex));
    expect(aDecision).toMatchObject({ admit: true });
    expect(bDecision).toMatchObject({ admit: false, reason: 'binding_invalid' });

    // Only A's log is admitted; B's is not.
    expect(handle.admitted.has(aOwn.keyHex)).toBe(true);
    expect(handle.admitted.has(bOwn.keyHex)).toBe(false);

    // Observability (P-003): the rejection is surfaced on the existing
    // boot-history channel — the purpose-built, queryable, local observability
    // surface — carrying the reason so a fleet operator can see admission
    // rejections. (A server-side PostHog path would be redundant with this and
    // doesn't exist; boot-history is the right home.)
    const rejected = listBootHistory({ workspaceId: 'ws-1', harnessSlug: 'admit-boundary-1' })
      .filter((e) => e.kind === 'announce_rejected');
    expect(rejected.some((e) => e.message?.includes('binding_invalid'))).toBe(true);

    // A merge pass reads ONLY the admitted set → A's op projected; B's op never
    // did, despite being replicated + physically available in the store.
    await handle.mergeNow();
    expect(writes.some((w) => w.id === 'A-1')).toBe(true);
    expect(writes.some((w) => w.id === 'B-1')).toBe(false);
  });

  it('a conclusive admission rejection emits substrate_admission_rejected telemetry (P-004)', async () => {
    // The rejection is forwarded to the diagnostic-telemetry pipeline (which
    // flushTelemetry sends to PostHog when opted in) via an injectable sink —
    // captured here so the assertion needs no PG/PostHog.
    const telemetry: Array<{ kind: string; payload: Record<string, unknown> }> = [];
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-tel-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'tel-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // every peer conclusively rejected
      recordTelemetryOverride: (kind, payload) => { telemetry.push({ kind, payload }); },
    });
    cleanups.push(() => handle.close());

    const P = makeDevice('rejected-peer', 9);
    const announce = await buildAnnounce(
      {
        device_pubkey: P.devicePubkey,
        github_user_id: P.githubUserId,
        github_login: P.githubLogin,
        attestation_gist_id: 'gist-test',
        log_core_key: 'ab'.repeat(32),
      },
      P.sign,
    );
    const decision = await handle.onAnnounce(announce);
    expect(decision).toMatchObject({ admit: false, reason: 'binding_invalid' });

    const ev = telemetry.find((t) => t.kind === 'substrate_admission_rejected');
    expect(ev).toBeDefined();
    expect(ev!.payload).toMatchObject({ harness_slug: 'tel-1', reason: 'binding_invalid' });
  });
});

describe('onSchemaVersionAlert', () => {
  it('subscribes to alerts emitted by the substrate', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(1);
    expect(received[0].observed_version).toBe(99);
    unsub();
  });

  it('unsub stops further deliveries', () => {
    const received: SchemaVersionAlert[] = [];
    const unsub = onSchemaVersionAlert((a) => received.push(a));
    unsub();
    schemaVersionEvents.emit('alert', {
      harnessSlug: 's',
      observed_version: 99,
      known_version: 1,
    });
    expect(received).toHaveLength(0);
  });

  it('multiple subscribers receive the alert independently', () => {
    const a: SchemaVersionAlert[] = [];
    const b: SchemaVersionAlert[] = [];
    const unsub1 = onSchemaVersionAlert((x) => a.push(x));
    const unsub2 = onSchemaVersionAlert((x) => b.push(x));
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 5, known_version: 1 });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    unsub1();
    schemaVersionEvents.emit('alert', { harnessSlug: 's', observed_version: 6, known_version: 1 });
    expect(a).toHaveLength(1);    // unsubbed
    expect(b).toHaveLength(2);    // still active
    unsub2();
  });
});
