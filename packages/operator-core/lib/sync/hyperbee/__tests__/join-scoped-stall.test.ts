/**
 * join-scoped-stall.test.ts — WI-1910 hardening regression gate: the P-006
 * scoped-log federation init must NEVER wedge or fail the swarm join.
 *
 * ## The bug class this pins down
 * The scoped-init block in `joinForBinding` holds awaits against best-effort
 * deps (scoped corestore open, PG fleet-directory read, ensureOwnScopes). It
 * used to run INLINE before `swarm.join` — a non-settling dep silently wedged
 * the entire join (no joined-topic log, no join-FAILED, zero dials: the
 * WI-1910 rig signature). The hardening deferred it off the join critical
 * path (un-awaited closure + bounded post-join wait) and added the
 * `join_started` / `join_succeeded` lifecycle witnesses.
 *
 * ## What this proves (single real peer over a local testnet swarm)
 * Case 1 — scoped init STALLS FOREVER: boot still resolves, the swarm join
 *   still succeeds (`join_started` + `join_succeeded` recorded), the bounded
 *   wait times out LOUDLY (`announce_error` "still pending"), and
 *   `handle.scopeFederation` stays null (scoped layer absent, not wedged).
 * Case 2 — scoped init REJECTS: join unaffected, failure recorded LOUDLY
 *   (`announce_error` "scoped-log layer unavailable"), scopeFederation null.
 *
 * Identity/admission/PG are stood in for with the same offline seams as
 * `two-peer-swarm-bidi.test.ts` (announceIdentityOverride /
 * verifyBindingOverride / loadRevokedOverride); the swarm + DHT are real.
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';

// ── Async resource teardown (newest-first, mirrors two-peer-swarm-bidi). ──
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      // best-effort — a thrown assertion must not leak a swarm/dir
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

/** A fresh tmp workspace root, registered for teardown. */
function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  return dir;
}

/** Raw 32-byte Ed25519 pubkey, base64 — the binding's `device_pubkey` convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

/** Offline announce identity — self-generated keypair, no OS keychain / gh. */
function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
    userId,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => nodeSign(null, bytes, privateKey),
    },
  };
}

/** A real `hyperswarm` bootstrapped to the local testnet DHT (offline). */
function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

/** Boot one real peer on a fresh local testnet with the given scoped-init seam. */
async function bootWithScopedSeam(opts: {
  workspaceId: string;
  harnessSlug: string;
  scopedStoreOverride: () => Promise<unknown>;
}): Promise<BootedHarnessHandle> {
  const testnet = await createTestnet(3);
  cleanups.push(async () => {
    try {
      await testnet.destroy();
    } catch {
      /* ignore */
    }
  });

  const { workspaceId, harnessSlug } = opts;
  const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };
  const identity = makeIdentityOverride('stall-peer', 4242, 'kc-stall');
  const swarm = makeSwarm(testnet.bootstrap);
  const root = makeWorkspaceRoot('mb-scoped-stall-');

  const handle = await bootHarnessSubstrate({
    workspaceRoot: root,
    workspaceId,
    harnessSlug,
    swarmBinding: binding,
    swarmOverride: swarm,
    verifyBindingOverride: async () => 'fail', // no admission under test
    mergePollMs: 0, // no leaked merge timer
    pendingRetryMs: 0, // no retry timer
    loadRevokedOverride: async () => new Set(), // avoid real PG in tests
    announceIdentityOverride: identity.override,
    scopedStoreOverride: opts.scopedStoreOverride,
    // Short bound so the stall case exercises the timeout without a 10s wait.
    scopedInitWaitMs: 250,
  });
  cleanups.push(async () => {
    await handle.close();
    await closeHarnessStore({ workspaceRoot: root, harnessSlug });
  });
  return handle;
}

describe('WI-1910 hardening — scoped-log init is off the join critical path', () => {
  it(
    'a never-settling scoped init cannot wedge the join: boot resolves, join_started+join_succeeded recorded, timeout is LOUD, scopeFederation stays null',
    async () => {
      const workspaceId = 'ws-scoped-stall';
      const harnessSlug = 'sheets';

      const handle = await bootWithScopedSeam({
        workspaceId,
        harnessSlug,
        // The WI-1910 signature: a scoped-init dep that never settles.
        scopedStoreOverride: () => new Promise<unknown>(() => {}),
      });

      // Boot resolved AND the swarm join genuinely happened (not local-only).
      expect(handle.swarm).not.toBeNull();

      // Join-lifecycle witnesses: started AND succeeded (no silent wedge).
      const started = listBootHistory({ workspaceId, harnessSlug, kinds: ['join_started'] });
      expect(started.length, 'expected a join_started witness').toBeGreaterThan(0);
      const succeeded = listBootHistory({ workspaceId, harnessSlug, kinds: ['join_succeeded'] });
      expect(succeeded.length, 'expected a join_succeeded witness').toBeGreaterThan(0);

      // The bounded wait timed out LOUDLY instead of hanging boot.
      const errors = listBootHistory({ workspaceId, harnessSlug, kinds: ['announce_error'] });
      const pending = errors.find((e) => e.message?.includes('still pending'));
      expect(
        pending,
        'expected a LOUD announce_error recording the scoped-init timeout',
      ).toBeTruthy();
      expect(pending!.message).toContain('250ms');

      // Scoped layer absent — not wedged, not half-wired.
      expect(handle.scopeFederation).toBeNull();
    },
    30_000,
  );

  it(
    'a REJECTING scoped init cannot fail the join: boot resolves, failure is LOUD, scopeFederation stays null',
    async () => {
      const workspaceId = 'ws-scoped-reject';
      const harnessSlug = 'sheets';

      const handle = await bootWithScopedSeam({
        workspaceId,
        harnessSlug,
        scopedStoreOverride: () => Promise.reject(new Error('scoped store exploded')),
      });

      // Join unaffected by the scoped-layer failure.
      expect(handle.swarm).not.toBeNull();
      const succeeded = listBootHistory({ workspaceId, harnessSlug, kinds: ['join_succeeded'] });
      expect(succeeded.length, 'expected a join_succeeded witness').toBeGreaterThan(0);

      // The failure is recorded LOUDLY (the catch path, not the timeout path).
      const errors = listBootHistory({ workspaceId, harnessSlug, kinds: ['announce_error'] });
      const unavailable = errors.find((e) =>
        e.message?.includes('scoped-log layer unavailable'),
      );
      expect(
        unavailable,
        'expected a LOUD announce_error recording the scoped-init failure',
      ).toBeTruthy();
      expect(unavailable!.message).toContain('scoped store exploded');

      expect(handle.scopeFederation).toBeNull();
    },
    30_000,
  );
});
