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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Corestore from 'corestore';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { bootHarnessSubstrate, onSchemaVersionAlert } from '../boot';
import { schemaVersionEvents, type SchemaVersionAlert, CURRENT_SCHEMA_VERSION } from '../schema-version';
import { _resetCacheForTests } from '../corestore';
import { openOwnLog, type RemoteLog } from '../peer-log';
import { buildAnnounce, type SignedAnnounce } from '../announce';
import type { HyperswarmLike } from '../swarm';
import { _clearRegistryForTests } from '../projection';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import type { AdmittedLog } from '../read-merge';
import {
  setReplicationStallEpisodeReporterForTests,
  setReplicationStallRecoveryReporterForTests,
} from '../replication-liveness';

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
  // WI-183 flaky-test fix: boot-history is a module-level append-only buffer
  // (cap 200, no per-test scoping beyond the workspaceId/harnessSlug filter
  // callers apply on read) — every other piece of cross-test module state in
  // this file gets an explicit reset above, but boot-history did not, so any
  // event recorded during a test (including from a prior FAILED/aborted run
  // sharing this worker process, e.g. under `vitest --retry` or watch-mode
  // re-execution) could persist into a later test's `listBootHistory()` read.
  // Resetting it here closes that isolation gap for every describe block in
  // this file, not just the WI-183 one that surfaced it.
  _resetBootHistoryForTests();
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
    expect(loadHiveMembers).toHaveBeenCalledWith(HIVE_HOME_SLUG);
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  it('control: the same production path admits once the owner/member device is in hive_members', async () => {
    const ownerUserId = 9501;
    const joiner = makeAnnounceIdentityOverride('joiner-control', 9502, 'kc-wi789-joiner-control');
    let ownerDevicePubkey = '';
    const loadHiveMembers = vi.fn(async (_hiveHome: string) =>
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

    expect(loadHiveMembers).toHaveBeenCalledWith(HIVE_HOME_SLUG);
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

  // WI-797 — the SECOND half of the keystone (the FIX above only worked when the gist gate
  // PASSED). The owner-bootstrap used to run only AFTER the identity decider's gist gate, so
  // when the owner's OWN announce fails that gate (verifyBinding → 'fail' / binding_invalid —
  // the routine fresh-join window where the owner's live attestation gist is not yet resolvable)
  // the frame was CONCLUSIVELY rejected before the bootstrap could rescue it, and content never
  // crossed (witnessed live on the fed-a/fed-b rig: every owner HOME announce → binding_invalid).
  // The fix hoists the owner-device bootstrap into the IDENTITY stage (admitsAsKnownHiveMember),
  // so it admits BEFORE — and independently of — the gist gate.
  it('FIX (WI-797): owner bootstrap admits even when the gist gate REJECTS (binding_invalid), via the signed owner-device binding', async () => {
    const ownerUserId = 9611;
    const joiner = makeAnnounceIdentityOverride('joiner-797', 9612, 'kc-wi797-joiner');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async (_hivePubkey: string) => ownerDevice || null);
    // The gist gate CONCLUSIVELY fails (gist unresolvable in the fresh-join window) — pre-fix
    // this rejected the owner's own log before the bootstrap could run.
    const verifyBinding = vi.fn(async () => 'fail' as const);

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
      loadHiveMembersOverride: async () => [], // empty roster — the WI-780/797 condition
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-797',
      attestation_gist_id: 'gist-owner-797',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'a7'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the signed owner_device_pubkey bound to this hive

    const decision = await handle.onAnnounce(frame);

    // Admitted at the IDENTITY stage via the owner-device binding — the failing gist gate is
    // bypassed for the bound owner device. Pre-fix this returned { admit:false, binding_invalid }.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY);
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
  });

  // ADVERSARIAL (WI-797) — the gist-gate bypass is strictly scoped to the bound owner device.
  // A NON-owner device whose gist gate ALSO fails must still be conclusively rejected
  // (binding_invalid), never admitted — the hoist must not widen the gate to any failing frame.
  it('ADVERSARIAL (WI-797): a non-owner device whose gist gate fails stays rejected binding_invalid', async () => {
    const ownerUserId = 9711;
    const joiner = makeAnnounceIdentityOverride('joiner-797-adv', 9712, 'kc-wi797-joiner-adv');
    const boundOwnerDevice = Buffer.alloc(32, 0x4b).toString('base64');
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
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId, // claims the owner's gh id …
      github_login: 'spoof-797',
      attestation_gist_id: 'gist-spoof-797',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'b7'.repeat(32),
    });
    // … but is NOT the bound owner device, so the bypass refuses it and the failing gist
    // gate's conclusive verdict stands.
    expect(frame.device_pubkey).not.toBe(boundOwnerDevice);

    const decision = await handle.onAnnounce(frame);

    expect(decision).toEqual({ admit: false, reason: 'binding_invalid' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // D-053 — the owner-device bootstrap is NOT gated on a kind:'hive' swarmBinding. A real
  // invite/link joiner boots on a kind:'topic' binding (a /api/harness/join-link carries the
  // Hive's TOPIC HASH, not its pubkey, so it cannot rebuild a `hive:` binding) and MUST still
  // bootstrap-admit the owner — recovering the owner device from the VERIFIED hive-directory
  // cache by deriving each cached hive's topic and matching `topic_hex` (ownerDeviceForTopic).
  // This was the live cross-machine RECEIVE-side blocker (D-052): a topic-bound empty-roster
  // joiner admitted NOTHING (0 roster/epoch/content) because the bypass only read
  // `swarmBinding.hive_pubkey`. STILL fail-closed: no verified directory binding ⇒ no bypass.
  it('FIX (D-053): a topic-kind binding bootstrap-admits the owner via the verified directory owner-device-for-topic binding (fail-closed without one)', async () => {
    const ownerUserId = 9721;
    const joiner = makeAnnounceIdentityOverride('joiner-053-topic', 9722, 'kc-053-joiner-topic');
    let ownerDevice = '';
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice || null);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'a'.repeat(64) }, // invite/link joiner — no hive_pubkey
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate REJECTS — only the bootstrap can admit
      loadHiveMembersOverride: async () => [], // EMPTY roster (fresh join)
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-053-topic',
      attestation_gist_id: 'gist-053-topic',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'c7'.repeat(32),
    });

    // FAIL-CLOSED: no verified directory owner-device-for-topic binding ⇒ no bypass ⇒ rejected.
    ownerDevice = '';
    const rejected = await handle.onAnnounce(frame);
    expect(rejected.admit).toBe(false);
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    // FIX: once the verified directory binding resolves the owner device for THIS topic, the
    // topic-bound joiner bootstrap-admits the owner — gist gate failing + empty roster and all.
    ownerDevice = frame.device_pubkey;
    const admitted = await handle.onAnnounce(frame);
    expect(admitted.admit).toBe(true);
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
    expect(ownerDeviceForTopic).toHaveBeenCalled();
  });

  // WI-1544 (round-1 live REJECT) — an identity-stage `binding_invalid` inside the join-
  // bootstrap window (a hive/topic-bound JOINER whose hive-home has not resolved yet) must
  // BUFFER, not conclusively reject. Live-pinned on the WI-1544 Docker-frames rig: the owner's
  // log announces raced the hive-directory descriptor by milliseconds → ownerDeviceForTopic
  // resolved <null> → gist gate 'fail' → binding_invalid → PERMANENT drop (announces are never
  // re-delivered); the rekey resolved the home two log-lines later with nothing left to replay.
  // Reverting the onAnnounce reclassify branch flips this RED (reason binding_invalid, no
  // binding_unverified_window buffer event).
  it('FIX (WI-1544): binding_invalid during the join-bootstrap window BUFFERS (pending), never conclusive', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-buf', 9742, 'kc-1544-joiner-buf');

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'b'.repeat(64) }, // invite/link joiner mid-bootstrap
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0, // assert the BUFFER decision in isolation
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate conclusively rejects (rig: unattested device)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => null, // directory descriptor NOT yet arrived (the race)
      joinerHiveHomeSlugOverride: async () => null, // hive-home UNRESOLVED — the pre-rekey window
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9741,
      github_login: 'owner-1544',
      attestation_gist_id: 'gist-1544',
      harness_slug: OWNER_MEMBER_SLUG, // the owner's hive-home-candidate log
      log_core_key: 'e4'.repeat(32),
    });

    const decision = await handle.onAnnounce(frame);

    // THE FIX: retryable, buffered — pre-fix this was { admit:false, reason:'binding_invalid' }.
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    const pending = listBootHistory({
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_pending'],
    });
    expect(pending.some((e) => (e.message ?? '').includes('binding_unverified_window'))).toBe(true);
    const rejected = listBootHistory({
      workspaceId: 'ws-wi1544-buf',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_rejected'],
    });
    expect(rejected.filter((e) => (e.message ?? '').includes('binding_invalid'))).toEqual([]);
  });

  // WI-1544 recovery half — the buffered frame is ADMITTED by the retry tick once the verified
  // directory owner-device binding resolves (the descriptor that lost the race arrives moments
  // later), while the window is still open. Uses a same-slug frame (the owner's log for the
  // SHARED harness — the content log that was probe=0 on the rig) so scope resolves without the
  // rekey; the buffer→rekey-replay leg for a hive-home-slug frame is exercised live by the
  // WI-1544 matrix (same scoping rationale as a003-scope-buffer-replay.test.ts).
  it('FIX (WI-1544): a window-buffered frame is admitted by the retry tick once the owner-device binding resolves', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-retry', 9752, 'kc-1544-joiner-retry');
    let ownerDevice: string | null = null;
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-retry',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'c'.repeat(64) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20, // fast retry — the recovery path under test
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate keeps failing (rig: device never attested)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerHiveHomeSlugOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9751,
      github_login: 'owner-1544-r',
      attestation_gist_id: 'gist-1544-r',
      harness_slug: JOINER_MEMBER_SLUG, // the owner's log for the SHARED harness (in-scope once identity passes)
      log_core_key: 'f5'.repeat(32),
    });

    // Directory not yet populated → buffered, not rejected.
    expect(await handle.onAnnounce(frame)).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);

    // The descriptor arrives (the verified directory binding now resolves the owner device) —
    // the next retry tick owner-bootstraps the buffered frame despite the failing gist gate.
    ownerDevice = frame.device_pubkey;
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(ownerDeviceForTopic).toHaveBeenCalled();
  });

  // WI-1544 ROOT CAUSE #2 (round-1 live, the SECOND stall) — the pending buffer was keyed by
  // device_pubkey, but ONE device announces MULTIPLE logs on the same topic (A-003: the owner's
  // member log + the hive-home log share a device). Every buffer site guarded
  // `if (!pendingPeers.has(device_pubkey))`, so the SECOND log of the pair was silently never
  // stored (its reclassify still returned 'pending' — misleadingly), the retry tick could only
  // ever admit ONE log per device, and the content log stayed probe=0 on the rig. The buffer is
  // now keyed by log_core_key. Reverting flips this RED: the second waitFor times out because
  // its frame was never buffered.
  it('FIX (WI-1544 #2): TWO logs announced by ONE device both buffer in the window and both admit on retry', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-two', 9762, 'kc-1544-joiner-two');
    let ownerDevice: string | null = null;
    const ownerDeviceForTopic = vi.fn(async () => ownerDevice);

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-two',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'd'.repeat(64) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // gist gate keeps failing (rig: device never attested)
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerHiveHomeSlugOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // ONE device keypair, TWO signed announces with distinct log_core_keys (the rig pair: the
    // owner's member log + the hive-home log, broadcast on the one shared topic).
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const devicePubkey = rawPubkeyBase64(publicKey);
    const signer = async (bytes: Buffer) => nodeSign(null, bytes, privateKey);
    const shared = {
      device_pubkey: devicePubkey,
      github_user_id: 9761,
      github_login: 'owner-1544-two',
      attestation_gist_id: 'gist-1544-two',
      harness_slug: JOINER_MEMBER_SLUG, // both in-scope once identity resolves (same rationale as the retry test above)
    };
    const frameA = await buildAnnounce({ ...shared, log_core_key: 'a6'.repeat(32) }, signer);
    const frameB = await buildAnnounce({ ...shared, log_core_key: 'b7'.repeat(32) }, signer);

    // Window open, directory unresolved → BOTH frames report pending (pre-fix the second ALSO
    // said 'pending' but was never actually stored — the misleading half of the bug).
    expect(await handle.onAnnounce(frameA)).toEqual({ admit: false, reason: 'pending' });
    expect(await handle.onAnnounce(frameB)).toEqual({ admit: false, reason: 'pending' });

    // The descriptor arrives → the retry tick must admit BOTH logs, not just the first.
    ownerDevice = devicePubkey;
    await vi.waitFor(
      () => {
        expect(handle.admitted.has(frameA.log_core_key)).toBe(true);
        expect(handle.admitted.has(frameB.log_core_key)).toBe(true);
      },
      { timeout: 4000, interval: 25 },
    );
  });

  /** Minimal in-range-empty RemoteLog replica — the drain only needs the handle to exist
   *  (admitted.set); a length-0 replica makes every subsequent merge pass a no-op. */
  function fakeRemoteLog(keyHex: string): RemoteLog {
    return {
      keyHex,
      length: 0,
      contiguousLength: 0,
      get: async () => null,
      update: async () => {},
      prefetch: () => {},
      has: () => false,
    };
  }

  // WI-1544 ROOT CAUSE #3 (the nondeterministic one-shot silent loss) — a throw inside the
  // merge-gated admission drain (e.g. openRemoteLog racing a rekey) happened AFTER the frame
  // was shift()'d off the admission queue, and the catch was ring-only: announces are never
  // re-delivered (sender-side sentKeys dedup), so a single throw permanently stalled every
  // A→B surface until a restart. The drain catch now RE-BUFFERS the frame into the D-006
  // pending set so the retry tick re-runs the full admission. Reverting the re-buffer flips
  // this RED: the waitFor times out because the frame is gone from every buffer.
  it('FIX (WI-1544 #3): a drain-time openRemoteLog throw re-buffers the frame; the retry tick admits it', async () => {
    // The fix is deliberately LOUD on stderr (the boot-history ring is in-memory only) —
    // capture + assert the line instead of letting fail-on-console treat it as a defect.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => consoleError.mockRestore());
    const joiner = makeAnnounceIdentityOverride('joiner-1544-drain', 9772, 'kc-1544-joiner-drain');
    let ownerDevice: string | null = null;
    const openRemoteLogOverride = vi.fn(async (_store: unknown, logKeyHex: string) => {
      if (openRemoteLogOverride.mock.calls.length === 1) {
        throw new Error('boom-drain-1544'); // the rekey race, deterministically
      }
      return fakeRemoteLog(logKeyHex);
    });

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-drain',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'e6'.repeat(32) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20, // the recovery path under test
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // owner bootstrap is the admitting gate
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => ownerDevice,
      joinerHiveHomeSlugOverride: async () => null,
      announceIdentityOverride: joiner.override,
      openRemoteLogOverride,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9771,
      github_login: 'owner-1544-drain',
      attestation_gist_id: 'gist-1544-drain',
      harness_slug: JOINER_MEMBER_SLUG, // in-scope (same rationale as the retry test above)
      log_core_key: 'c8'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // owner bootstrap admits on FIRST announce

    // The admission decision is 'admit' (the decider passed) but the merge-gated drain threw —
    // the log must NOT be in `admitted`, and the frame must NOT be lost.
    await handle.onAnnounce(frame);
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
    const errors = listBootHistory({
      workspaceId: 'ws-wi1544-drain',
      harnessSlug: JOINER_MEMBER_SLUG,
      kinds: ['announce_error'],
    });
    expect(errors.some((e) => (e.message ?? '').includes('boom-drain-1544'))).toBe(true);

    // THE FIX: the re-buffered frame is re-admitted by the retry tick (pre-fix: lost forever).
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(openRemoteLogOverride.mock.calls.length).toBeGreaterThanOrEqual(2);
    // The loss is loud on stderr, not ring-only (the other half of the #3 fix).
    expect(
      consoleError.mock.calls.some((args) =>
        String(args[0]).includes('re-buffered for retry: boom-drain-1544'),
      ),
    ).toBe(true);
  });

  // WI-1544 ROOT CAUSE #3, retry-tick half — the retry tick used to delete the pending entry
  // BEFORE the awaited admit, so a throw inside the drain during a RETRY lost the frame from
  // every buffer (the drain re-buffer guard sees the entry still present during a retry and
  // preserves it — so the tick's delete must be admit-FIRST and GATED on `admitted.has`).
  // Reverting either half (delete-before-admit, or an unconditional delete after) flips this
  // RED: the entry is erased on the first failed tick and the waitFor times out.
  it('FIX (WI-1544 #3): a pending entry survives drain failures across retry ticks until the admit lands', async () => {
    // Same rationale as above: the drain failure line on stderr is the fix's intended
    // behavior — capture it so fail-on-console doesn't misread it as a test defect.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanups.push(() => consoleError.mockRestore());
    const joiner = makeAnnounceIdentityOverride('joiner-1544-gate', 9782, 'kc-1544-joiner-gate');
    let ownerDevice: string | null = null;
    const openRemoteLogOverride = vi.fn(async (_store: unknown, logKeyHex: string) => {
      if (openRemoteLogOverride.mock.calls.length <= 2) {
        throw new Error('boom-retry-1544'); // fail the drain on the first TWO retry ticks
      }
      return fakeRemoteLog(logKeyHex);
    });

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-gate',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: 'f7'.repeat(32) },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 20,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: async () => ownerDevice,
      joinerHiveHomeSlugOverride: async () => null,
      announceIdentityOverride: joiner.override,
      openRemoteLogOverride,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: 9781,
      github_login: 'owner-1544-gate',
      attestation_gist_id: 'gist-1544-gate',
      harness_slug: JOINER_MEMBER_SLUG,
      log_core_key: 'd9'.repeat(32),
    });

    // Directory unresolved → buffered pending (the WI-1544 window buffer).
    expect(await handle.onAnnounce(frame)).toEqual({ admit: false, reason: 'pending' });

    // The directory resolves → each retry tick re-runs the admission; the first two drains
    // throw. The entry must SURVIVE both failed ticks and admit on the third.
    ownerDevice = frame.device_pubkey;
    await vi.waitFor(
      () => { expect(handle.admitted.has(frame.log_core_key)).toBe(true); },
      { timeout: 4000, interval: 25 },
    );
    expect(openRemoteLogOverride.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  // WI-1544 DEFECT D — the owner-device resolve read the BOOT-TIME `opts.swarmBinding`
  // snapshot, not the current binding: after a rekey() onto a new topic (every real joiner
  // rekeys — join-hive 2c), the bootstrap-admit consulted the directory for the OLD topic,
  // so the owner of the NEW hive never bootstrap-admitted. The resolve now reads the live
  // `currentBinding` that rekey() publishes FIRST. Reverting flips this RED: the directory
  // is consulted with the boot topic and the announce is never admitted.
  it('FIX (WI-1544 defect D): after rekey() the owner bootstrap consults the NEW topic, not the boot-time binding', async () => {
    const joiner = makeAnnounceIdentityOverride('joiner-1544-rekey', 9792, 'kc-1544-joiner-rekey');
    const BOOT_TOPIC = 'a1'.repeat(32);
    const REKEY_TOPIC = 'b2'.repeat(32);
    let ownerDevice: string | null = null;
    // The verified directory binding exists ONLY for the rekey target topic.
    const ownerDeviceForTopic = vi.fn(async (topicHex: string) =>
      topicHex === REKEY_TOPIC ? ownerDevice : null,
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: 'ws-wi1544-rekey',
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'topic', topic_hex: BOOT_TOPIC },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0, // assert the onAnnounce decision in isolation
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail', // only the bootstrap can admit
      loadHiveMembersOverride: async () => [],
      ownerDeviceForTopicOverride: ownerDeviceForTopic,
      joinerHiveHomeSlugOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // The join-hive 2c rekey onto the hive's real topic.
    await handle.rekey({ kind: 'topic', topic_hex: REKEY_TOPIC });

    const frame = await validAnnounce({
      github_user_id: 9791,
      github_login: 'owner-1544-rekey',
      attestation_gist_id: 'gist-1544-rekey',
      harness_slug: JOINER_MEMBER_SLUG,
      log_core_key: 'e0'.repeat(32),
    });
    ownerDevice = frame.device_pubkey;

    const decision = await handle.onAnnounce(frame);

    // THE FIX: the resolve keys off the CURRENT (rekeyed) topic → owner bootstrap admits.
    // Pre-fix it consulted BOOT_TOPIC → null → the announce buffered/rejected instead.
    expect(decision).toEqual({ admit: true });
    expect(handle.admitted.has(frame.log_core_key)).toBe(true);
    expect(ownerDeviceForTopic).toHaveBeenCalledWith(REKEY_TOPIC);
    expect(ownerDeviceForTopic).not.toHaveBeenCalledWith(BOOT_TOPIC);
  });

  // ADVERSARIAL (WI-797) — a FORGED owner announce (bad sig) is refused at the sig check that
  // PRECEDES the bypass (admitsAsKnownHiveMember line 1: `if (!sigValid …) return false`). A
  // forger cannot produce a valid signature for the owner's pubkey without its private key, so
  // even a frame claiming the exact owner device never bootstraps; ownerDeviceForHive is never
  // consulted.
  it('ADVERSARIAL (WI-797): a forged (bad-sig) owner announce is refused bad_sig, bypass never reached', async () => {
    const ownerUserId = 9731;
    const joiner = makeAnnounceIdentityOverride('joiner-797-forge', 9732, 'kc-wi797-joiner-forge');
    let ownerDevice = '';
    const ownerDeviceForHive = vi.fn(async () => ownerDevice || null);

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
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-797-forge',
      attestation_gist_id: 'gist-797-forge',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd7'.repeat(32),
    });
    ownerDevice = frame.device_pubkey; // the real owner device …
    const forged: SignedAnnounce = { ...frame, sig: Buffer.from('tampered').toString('base64') };

    const decision = await handle.onAnnounce(forged);

    // … but the signature is forged ⇒ refused before the bypass; ownerDeviceForHive untouched.
    expect(decision).toMatchObject({ admit: false, reason: 'bad_sig' });
    expect(ownerDeviceForHive).not.toHaveBeenCalled();
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
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

  // ADVERSARIAL 3 (WI-788 A2) — cross-hive binding attack: a frame arriving on hive Y's
  // substrate must NOT be admitted using hive X's owner-device binding. The lookup key is
  // opts.swarmBinding.hive_pubkey (server-local config, NOT attacker-controlled — a
  // SignedAnnounce carries no hive_pubkey), so a frame from hive X's owner resolves
  // ownerDeviceForHive(Y) → null → no bootstrap → pending (empty roster). Locks the scoping
  // invariant against a future refactor that might thread a frame-supplied hive_pubkey in.
  it('ADVERSARIAL: owner device of hive X cannot bootstrap-admit onto a substrate joined to hive Y', async () => {
    const ownerUserId = 9901;
    const joiner = makeAnnounceIdentityOverride('joiner-adv3', 9902, 'kc-wi789-joiner-adv3');

    const HIVE_PUBKEY_X = Buffer.alloc(32, 0x0a).toString('base64'); // the attacker's hive
    const HIVE_PUBKEY_Y = Buffer.alloc(32, 0x0b).toString('base64'); // THIS substrate's hive

    let ownerDeviceOfHiveX = '';
    // The cache has a binding ONLY for hive X; hive Y has none.
    const ownerDeviceForHive = vi.fn(async (hivePubkey: string) =>
      hivePubkey === HIVE_PUBKEY_X ? ownerDeviceOfHiveX || null : null,
    );

    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY_Y }, // joined to hive Y
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [], // empty roster on hive Y
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await validAnnounce({
      github_user_id: ownerUserId,
      github_login: 'owner-hivex',
      attestation_gist_id: 'gist-owner-hivex',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'f6'.repeat(32),
    });
    ownerDeviceOfHiveX = frame.device_pubkey; // this device legitimately owns hive X

    const decision = await handle.onAnnounce(frame);

    // The lookup is keyed on the SERVER-LOCAL joined hive (Y), never the frame.
    expect(ownerDeviceForHive).toHaveBeenCalledWith(HIVE_PUBKEY_Y);
    // No binding for Y ⇒ no bootstrap; empty roster ⇒ pending, never admitted.
    expect(decision).toEqual({ admit: false, reason: 'pending' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
  });

  // ADVERSARIAL 4 (WI-788 A2) — revoked owner device: even when the owner-device binding
  // MATCHES, a revoked device is refused before resolveSameHiveMember (and thus the
  // bootstrap pre-check) is ever reached. The admission decider checks `revoked` first
  // (precedence: revoked → bad_sig → binding), so onAnnounce short-circuits with
  // reason:'revoked' and ownerDeviceForHive is never consulted.
  it('ADVERSARIAL: a revoked owner device is refused before the bootstrap pre-check fires', async () => {
    const ownerUserId = 9910;
    const joiner = makeAnnounceIdentityOverride('joiner-adv4', 9911, 'kc-wi789-joiner-adv4');

    // Generate the owner keypair up front so it can be in the revoked set at boot.
    const { publicKey: ownerPub, privateKey: ownerPriv } = generateKeyPairSync('ed25519');
    const ownerDevicePubkey = rawPubkeyBase64(ownerPub);

    // The binding WOULD match — but the device is revoked, so admission must still fail.
    const ownerDeviceForHive = vi.fn(async () => ownerDevicePubkey);

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
      loadRevokedOverride: async () => new Set([ownerDevicePubkey]), // revoked at boot
      verifyBindingOverride: async () => 'verified',
      loadHiveMembersOverride: async () => [],
      ownerDeviceForHiveOverride: ownerDeviceForHive,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const frame = await buildAnnounce(
      {
        device_pubkey: ownerDevicePubkey,
        github_user_id: ownerUserId,
        github_login: 'owner-revoked',
        attestation_gist_id: 'gist-owner-revoked',
        log_core_key: 'f7'.repeat(32),
        harness_slug: OWNER_MEMBER_SLUG,
      },
      async (bytes) => nodeSign(null, bytes, ownerPriv),
    );

    const decision = await handle.onAnnounce(frame);

    // Revocation wins, before the bootstrap pre-check can ever run.
    expect(decision).toEqual({ admit: false, reason: 'revoked' });
    expect(handle.admitted.has(frame.log_core_key)).toBe(false);
    expect(ownerDeviceForHive).not.toHaveBeenCalled();
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

  // WI-1856 (G9): revoke() must not just drop the map entry — it must CLOSE
  // the underlying Hypercore session `openRemoteLog` opened for the peer, or
  // that session (replicator state + file handles) leaks for the rest of the
  // process's life on a long-lived owner node (revokes are rare but the leak
  // is unbounded/cumulative). Uses the REAL openRemoteLog (no override) so
  // this exercises the actual production close-wiring, not a fake's spy.
  it('revoke() closes the revoked peer\'s Hypercore session (WI-1856)', async () => {
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpDir('mb-revoke-close-host-'),
      workspaceId: 'ws-1',
      harnessSlug: 'revoke-close-1',
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'verified',
    });
    cleanups.push(() => handle.close());

    const peerDir = tmpDir('mb-revoke-close-peer-');
    const peerStore = new Corestore(peerDir);
    cleanups.push(() => { void peerStore.close(); });
    await peerStore.ready();
    const peerOwn = await openOwnLog(peerStore);
    const P = makeDevice('peer-close', 4243);
    await peerOwn.append({
      type: 'put', table: 'mb_revoke_close_table', hbKey: 'C-1',
      value: { id: 'C-1' }, ts: 100, schema_version: CURRENT_SCHEMA_VERSION,
      author_pubkey: P.devicePubkey,
    });
    replicate(peerStore, handle.store);

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

    // Capture the admitted RemoteLog + the underlying core's session count
    // BEFORE revoke — asserting the count drops by exactly one is what proves
    // close() released THIS session (not a no-op, not the whole core).
    const admittedLog = handle.admitted.get(peerOwn.keyHex)!;
    expect(admittedLog).toBeDefined();
    expect(typeof admittedLog.close).toBe('function');
    type CoreWithSessions = { sessions?: { length: number } };
    const core = (handle.store as unknown as {
      get(o: Record<string, unknown>): CoreWithSessions;
    }).get({ key: Buffer.from(peerOwn.keyHex, 'hex') });
    const sessionsBefore = core.sessions?.length ?? -1;
    expect(sessionsBefore).toBeGreaterThan(0);

    await handle.revoke(P.devicePubkey);

    // revoke() returns as soon as the peer is fully refused (revoked/admitted/
    // pubkeyToLogKey updated); the session close itself is fire-and-forget (a
    // live-replicator teardown can take a few seconds — see the comment at the
    // revoke() call site), so poll for it rather than asserting synchronously.
    expect(handle.admitted.has(peerOwn.keyHex)).toBe(false);
    await vi.waitFor(
      () => { expect(core.sessions?.length).toBe(sessionsBefore - 1); },
      { timeout: 10_000, interval: 50 },
    );
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

// ── WI-183 — replication-stall detector ─────────────────────────────────────
// Repro: a hive peer restarts, the swarm re-peers (peer_connected fires), but
// this specific admitted log's replication never resumes — SILENTLY, with no
// error. `checkReplicationStall` (boot.ts) samples `RemoteLog.peersCount()`
// each merge pass and records a `replication_stalled` boot-history event once
// a log that WAS replicating has held zero live replicator peers for
// `replicationStallGraceMs`. These tests inject a minimal fake `AdmittedLog`
// directly into `handle.admitted` (bypassing swarm/announce entirely — the
// detector only cares about the shape's `peersCount()`), and drive the merge
// pass by hand via `mergeNow()` with the poll timer disabled.
describe('bootHarnessSubstrate — WI-183 replication-stall detector', () => {
  // These tests deliberately construct stall episodes; the default episode
  // reporter's Leg-0 `console.error` line (the rig's grep-able serve.log token,
  // added 2026-07-03) would trip vitest-fail-on-console. Install a silent
  // reporter for THIS describe only — the bootHistory entries these tests
  // assert come from the LEGACY checkReplicationStall path (no_replicator
  // kind), not from the reporter, so silencing it changes nothing they read.
  //
  // EI-7788 also added a drop-time RECOVERY report: `handle.close()` (fired
  // by each test's `cleanups.push(() => handle.close())`, which runs in the
  // outer `afterEach` — AFTER this describe's own `afterEach` above already
  // ran) calls `dropReplicationLiveness`, which fires the default recovery
  // reporter's `console.error('[replication-liveness] recovered ...')` for
  // any log this suite left latched-alarmed. Silence that reporter here too
  // (same rationale as the episode reporter above) so teardown doesn't trip
  // vitest-fail-on-console.
  beforeEach(() => {
    setReplicationStallEpisodeReporterForTests(() => {});
    setReplicationStallRecoveryReporterForTests(() => {});
  });
  afterEach(() => {
    setReplicationStallEpisodeReporterForTests(null);
    setReplicationStallRecoveryReporterForTests(null);
  });

  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-stall-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  /** A minimal AdmittedLog with a controllable `peersCount()` — no real
   *  hypercore, no ops (length 0), never actually read by the merge pass. */
  function fakeAdmittedRemoteLog(
    keyHex: string,
    peersCount: () => number | undefined,
  ): AdmittedLog & { peersCount(): number | undefined } {
    return {
      keyHex,
      length: 0,
      async get(): Promise<null> {
        return null;
      },
      peersCount,
    };
  }

  // WI-183 flaky-test fix (su-47533f4b found these wall-clock-timing flaky
  // under fleet CPU load: a real setTimeout(60ms) sleep raced against a
  // tight replicationStallGraceMs:30 window — under heavy scheduling
  // pressure the interval BETWEEN two synchronous `await handle.mergeNow()`
  // calls with no sleep at all could itself drift past the 30ms grace
  // window, tripping (or narrowly missing) the alarm non-deterministically.
  // `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync()` makes the elapsed
  // time between passes EXACT and deterministic (Date.now(), which
  // `checkReplicationStall` reads directly, is one of the mocks fake timers
  // install by default) instead of "however long the real clock/scheduler
  // happened to take". Installed only AFTER the handle is booted (so the
  // real async corestore/fs boot work is unaffected) and always torn down
  // in a `finally` so a failing assertion can't leak fake timers into a
  // later test.
  const sleep = (ms: number) => vi.advanceTimersByTimeAsync(ms);

  it('fires replication_stalled once a previously-replicating log holds zero peers past the grace window, then stays silent while still stalled', async () => {
    const workspaceId = 'ws-stall-1';
    const harnessSlug = 's-stall-1';
    let peers = 1; // starts "replicating"
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    try {
      const keyHex = 'aa'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => peers));

      // First pass observes peers=1 → seeds lastNonZeroPeersAtMs; no alarm.
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);

      // Drops to zero — still inside the (shrunk) grace window → no alarm yet.
      peers = 0;
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);

      // Past the grace window → alarms exactly once.
      await sleep(60);
      await handle.mergeNow();
      const events = listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] });
      expect(events).toHaveLength(1);
      expect(events[0]!.message).toContain(keyHex.slice(0, 12));

      // Still stalled on a later pass — edge-triggered, so no re-fire.
      await sleep(60);
      await handle.mergeNow();
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('never fires for a log that has NEVER shown a live replicator peer (ordinarily offline is not a bug)', async () => {
    const workspaceId = 'ws-stall-2';
    const harnessSlug = 's-stall-2';
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    try {
      const keyHex = 'bb'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => 0)); // never replicated

      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow();

      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-arms after peers recover, so a later stall episode fires again', async () => {
    const workspaceId = 'ws-stall-3';
    const harnessSlug = 's-stall-3';
    let peers = 1;
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug,
      mergePollMs: 0,
      loadRevokedOverride: async () => new Set(),
      replicationStallGraceMs: 30,
    });
    cleanups.push(() => handle.close());

    vi.useFakeTimers();
    // EI-7110's defaultRecoveryReporter deliberately logs a LOUD, grep-able
    // `console.error('[replication-liveness] recovered ...')` line on a genuine
    // alarm→recovered transition (same rationale as defaultEpisodeReporter's own
    // stall line) — this test exercises the real default reporter path (no
    // onRecovery override, unlike the pure-unit replication-liveness.test.ts
    // suite), so the expected recovery log must be mocked rather than left to
    // trip vitest-fail-on-console.
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const keyHex = 'cc'.repeat(32);
      handle.admitted.set(keyHex, fakeAdmittedRemoteLog(keyHex, () => peers));

      await handle.mergeNow(); // seed lastNonZeroPeersAtMs
      peers = 0;
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow(); // first alarm
      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(1);

      // Recovers, then stalls again.
      peers = 1;
      await handle.mergeNow();
      peers = 0;
      await handle.mergeNow();
      await sleep(60);
      await handle.mergeNow(); // second alarm

      expect(listBootHistory({ workspaceId, harnessSlug, kinds: ['replication_stalled'] })).toHaveLength(2);
    } finally {
      vi.useRealTimers();
      errorSpy.mockRestore();
    }
  });
});

describe('bootHarnessSubstrate — P-006 scoped-log wiring (P-108)', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-p006-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  const WORKSPACE_ID = 'ws-p006';
  const JOINER_MEMBER_SLUG = 'p006-joiner-repo';
  const OWNER_MEMBER_SLUG = 'p006-owner-repo';
  const HIVE_HOME_SLUG = 'p006-owner-repo-home';
  const HIVE_PUBKEY = Buffer.alloc(32, 9).toString('base64');

  async function bootP006(root: string, opts: {
    userId: number; keychainId: string;
    loadHiveMembers: (hiveHome: string) => Promise<string[]>;
    verifyBinding?: () => Promise<'verified' | 'pending' | 'fail'>;
  }) {
    const joiner = makeAnnounceIdentityOverride('p006-joiner', opts.userId, opts.keychainId);
    const handle = await bootHarnessSubstrate({
      workspaceRoot: root,
      workspaceId: WORKSPACE_ID,
      harnessSlug: JOINER_MEMBER_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: opts.verifyBinding ?? (async () => 'fail' as const),
      loadHiveMembersOverride: opts.loadHiveMembers,
      joinerHiveHomeSlugOverride: async () => HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());
    return handle;
  }

  it('creates the coordinator on join, routes an ADMITTED announce (with ctx) into it, and never routes a non-admitted one', async () => {
    let ownerDevicePubkey = '';
    const handle = await bootP006(tmpWorkspaceRoot(), {
      userId: 9602,
      keychainId: 'kc-p006-a',
      loadHiveMembers: async () => (ownerDevicePubkey ? [ownerDevicePubkey] : []),
    });

    // The scoped-log coordinator exists after a (fake-)swarm join.
    const fed = handle.scopeFederation;
    expect(fed).not.toBeNull();
    const spy = vi.spyOn(fed!, 'onPeerAnnounce').mockResolvedValue(undefined);

    // A NON-admitted frame (unknown device, binding fail ⇒ pending) must never
    // reach the scoped layer — frame.github_user_id is untrustworthy pre-admit.
    const strangerFrame = await validAnnounce({
      github_user_id: 9701,
      github_login: 'p006-stranger',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd1'.repeat(32),
    });
    const ctx = { muxer: { stream: { destroyed: false } }, send: vi.fn() };
    const rejected = await handle.onAnnounce(strangerFrame, ctx);
    expect(rejected.admit).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    // The SAME production path with the device in hive_members admits — and the
    // admitted frame + per-connection ctx flow into the coordinator.
    const ownerFrame = await validAnnounce({
      github_user_id: 9702,
      github_login: 'p006-owner',
      harness_slug: OWNER_MEMBER_SLUG,
      log_core_key: 'd2'.repeat(32),
    });
    ownerDevicePubkey = ownerFrame.device_pubkey;
    const admitted = await handle.onAnnounce(ownerFrame, ctx);
    expect(admitted).toEqual({ admit: true });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ownerFrame, ctx);

    // Without ctx (direct handle.onAnnounce callers, retry paths) the scoped
    // layer is skipped — no crash, no phantom connection record.
    await handle.onAnnounce(ownerFrame);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ensureScopeParticipation mints an own core in the SEPARATE scoped store; rediscloseScopes resolves', async () => {
    const root = tmpWorkspaceRoot();
    const handle = await bootP006(root, {
      userId: 9603,
      keychainId: 'kc-p006-b',
      loadHiveMembers: async () => [],
    });
    expect(handle.scopeFederation).not.toBeNull();

    // No scopes declared (tier-1 default): redisclose is a safe no-op.
    await expect(handle.rediscloseScopes()).resolves.toBeUndefined();

    await handle.ensureScopeParticipation([
      { kind: 'fleet', ownerGithubUserId: 9603, slug: 'p006-rig-fleet' },
    ]);
    // The scoped store is a sibling `hyperbee-scoped/` corestore — minting the
    // own scope core materializes it on disk, OUTSIDE the main `hyperbee/`
    // store (the never-replicated §5.3 premise).
    const scopedDir = join(root, '.papercusp', JOINER_MEMBER_SLUG, 'hyperbee-scoped');
    expect(existsSync(scopedDir)).toBe(true);
    expect(readdirSync(scopedDir).length).toBeGreaterThan(0);
  });
});

// ── WI-2105 REV (no-hiveHome) regression ─────────────────────────────────────
// An OWNED-hive member harness — home ≠ own slug, hive owned-not-remote (the live
// tower's `hive-canary` folding the `papercusp` hive it LOCALLY OWNS) — must resolve
// the member-content-guard home so cross-member REV content APPLIES instead of
// dropping with 'no-hiveHome'. Pre-fix the guard home was `hiveHomeProjectionSlug ??
// ownHiveHomeSlug`, and for an owned-hive member BOTH are null/undefined (the joiner
// rebind is null because the hive is owned-not-remote; ownHiveHomeSlug is undefined
// because home ≠ own slug) → the boot-time `hiveHome-resolve NONE→drop-all-cross-member`
// diagnostic fires and EVERY cross-member op drops (this is the WI-559/FED-1 gap — its
// ownHiveHomeSlug fix only covered home===own-slug). The DECOUPLED fix threads
// `contentGuardHiveHome` (= hiveHomeSlugForHarness, independent of the home===own-slug
// rebind gate) as the guard home, so the diagnostic no longer fires — while the
// projection REBIND (hiveScoped) still keys off ownHiveHomeSlug, so an owned-hive member
// does NOT double-apply the owner's own rows as origin='remote'. Observed through the
// durable boot-history diagnostic (`kind:'merge_error'`), the same seam a live restart
// surfaces via getBootHistory. `hiveHomeSlugForHarnessOverride` is the new test seam
// (closes the pre-existing WI-559 untestable owner-home path — a dynamic import, no seam).
describe('bootHarnessSubstrate — WI-2105 owned-hive member content-guard home', () => {
  function tmpWorkspaceRoot(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mb-boot-wi2105-'));
    cleanups.push(() => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
    return dir;
  }

  // Mirrors the live tower: a member harness whose hive-home is a DIFFERENT, LOCALLY-OWNED hive.
  const MEMBER_HARNESS_SLUG = 'hive-canary';
  const OWNED_HIVE_HOME_SLUG = 'papercusp';
  const HIVE_PUBKEY = Buffer.alloc(32, 11).toString('base64');

  function dropAllDiag(workspaceId: string) {
    return listBootHistory({
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      kinds: ['merge_error'],
    }).filter((e) => (e.message ?? '').includes('hiveHome-resolve'));
  }

  it('FIX: an owned-hive member harness resolves the content-guard home (no drop-all-cross-member)', async () => {
    const workspaceId = 'ws-wi2105-fix';
    const joiner = makeAnnounceIdentityOverride('wi2105-owner', 9801, 'kc-wi2105-owner');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      // The hive is OWNED, not remote-joined → the joiner rebind resolves NULL (as in prod).
      joinerHiveHomeSlugOverride: async () => null,
      // The owned hive's home slug ≠ this member harness's own slug → ownHiveHomeSlug is
      // undefined, but the DECOUPLED content-guard home resolves it (the WI-2105 fix).
      hiveHomeSlugForHarnessOverride: async () => OWNED_HIVE_HOME_SLUG,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    // contentGuardHiveHome resolved ('papercusp') → the guard home is set → no drop-all diagnostic.
    expect(dropAllDiag(workspaceId)).toEqual([]);
  });

  it('NEGATIVE CONTROL: a genuinely-unresolvable hive-home still trips the drop-all diagnostic', async () => {
    const workspaceId = 'ws-wi2105-neg';
    const joiner = makeAnnounceIdentityOverride('wi2105-neg', 9802, 'kc-wi2105-neg');
    const handle = await bootHarnessSubstrate({
      workspaceRoot: tmpWorkspaceRoot(),
      workspaceId,
      harnessSlug: MEMBER_HARNESS_SLUG,
      swarmBinding: { kind: 'hive', hive_pubkey: HIVE_PUBKEY },
      swarmOverride: makeFakeSwarm(),
      swarmRefreshMs: 0,
      swarmJoinRetryMs: 0,
      mergePollMs: 0,
      pendingRetryMs: 0,
      loadRevokedOverride: async () => new Set(),
      verifyBindingOverride: async () => 'fail',
      loadHiveMembersOverride: async () => [],
      joinerHiveHomeSlugOverride: async () => null,
      // BOTH homes unresolvable → contentGuardHiveHome undefined → the diagnostic MUST fire,
      // proving the resolution (not a dead diagnostic) is what silences the positive case.
      hiveHomeSlugForHarnessOverride: async () => null,
      announceIdentityOverride: joiner.override,
    });
    cleanups.push(() => handle.close());

    const fired = dropAllDiag(workspaceId);
    expect(fired).toHaveLength(1);
    const msg = fired[0]?.message ?? '';
    expect(msg).toContain('hiveHome-resolve NONE→drop-all-cross-member');
    expect(msg).toContain('guardHome=<none>');
  });
});
