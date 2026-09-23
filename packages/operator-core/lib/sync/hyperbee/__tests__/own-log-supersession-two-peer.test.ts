/**
 * WI-10002600 over the REAL wire: a device that recovered from an own-log fork
 * boots with a fresh own log, and its announce — built by boot.ts, carried by
 * Hyperswarm + the c.json announce channel — retires the dead key on a peer that
 * still had it admitted. The unit suite (own-log-supersession.test.ts) proves
 * the receiver rules; this proves the sender actually puts the statement on the
 * wire and a real peer acts on it.
 */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { afterEach, describe, expect, it } from 'vitest';

import {
  bootHarnessSubstrate as bootHarnessSubstrateImpl,
  type BootedHarnessHandle,
  type BootHarnessOpts,
} from '../boot';
import { buildAnnounce } from '../announce';
import { type HyperswarmLike } from '../swarm';
import { listBootHistory, _resetBootHistoryForTests } from '../boot-history';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetReplicationLivenessForTests } from '../replication-liveness';

function bootHarnessSubstrate(opts: BootHarnessOpts) {
  return bootHarnessSubstrateImpl({ rekeyDepsOverride: null, ...opts });
}

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
  _resetReplicationLivenessForTests();
});

function makeWorkspaceRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function rawPubkey(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): Buffer {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32);
}

function makeIdentity(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkey(publicKey).toString('base64');
  const sign = async (bytes: Buffer) => nodeSign(null, bytes, privateKey);
  return {
    devicePubkey,
    userId,
    login,
    sign,
    override: {
      resolveOpts: {
        keychainId,
        resolveGithubUser: async () => ({ id: userId, login }),
        loadKeypair: async (id: string) => ({ keychainId: id, pubkeyBase64: devicePubkey }),
        resolveAttestationGistId: async () => `gist-${login}`,
      },
      sign: async (_keychainId: string, bytes: Buffer) => sign(bytes),
    },
  };
}

function makeSwarm(bootstrap: unknown): HyperswarmLike {
  const swarm = new Hyperswarm({ bootstrap }) as unknown as HyperswarmLike & { destroy(): Promise<void> };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });
  return swarm;
}

async function pollUntil<T>(
  fn: () => T | Promise<T>,
  { timeoutMs, intervalMs }: { timeoutMs: number; intervalMs: number },
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= deadline) return undefined;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('WI-10002600 real wire: a recovered device retires its dead own log on a live peer', () => {
  /** Tower admits the VM's dead key, then the VM boots on a fresh store. Returns
   *  once the tower has admitted the VM's new own log (or the bound expires). */
  async function runRecoveryScenario(slugSuffix: string, supersededOnVm: 'announce' | 'omit') {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const workspaceId = `ws-supersede-wire-${slugSuffix}`;
      const harnessSlug = 'hello-world-3-pot';
      const binding = { kind: 'local' as const, workspace_id: workspaceId, harness_slug: harnessSlug };
      const tower = makeIdentity('tower', 42, 'kc-tower');
      const vm = makeIdentity('vm', 7, 'kc-vm');

      // The VM's pre-recovery own log: a real (random) core key nobody serves any more.
      const deadKey = rawPubkey(generateKeyPairSync('ed25519').publicKey).toString('hex');

      const rootTower = makeWorkspaceRoot('supersede-wire-tower-');
      const towerHandle: BootedHarnessHandle = await bootHarnessSubstrate({
        workspaceRoot: rootTower,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: makeSwarm(testnet.bootstrap),
        verifyBindingOverride: async (_pk, _login, userId) => (userId === vm.userId ? 'verified' : 'fail'),
        mergePollMs: 0,
        pendingRetryMs: 0,
        reverifyIntervalMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: tower.override,
      });
      cleanups.push(async () => {
        await towerHandle.close();
        await closeHarnessStore({ workspaceRoot: rootTower, harnessSlug });
      });

      // Before the recovery the tower admitted the VM's (now forked) log.
      await towerHandle.onAnnounce(
        await buildAnnounce(
          {
            device_pubkey: vm.devicePubkey,
            github_user_id: vm.userId,
            github_login: vm.login,
            attestation_gist_id: `gist-${vm.login}`,
            log_core_key: deadKey,
            harness_slug: harnessSlug,
          },
          vm.sign,
        ),
      );
      expect(towerHandle.admitted.has(deadKey)).toBe(true);

      // The VM boots on its fresh store; recovery left the dead key beside it.
      const rootVm = makeWorkspaceRoot('supersede-wire-vm-');
      const vmHandle: BootedHarnessHandle = await bootHarnessSubstrate({
        workspaceRoot: rootVm,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: makeSwarm(testnet.bootstrap),
        verifyBindingOverride: async (_pk, _login, userId) => (userId === tower.userId ? 'verified' : 'fail'),
        mergePollMs: 0,
        pendingRetryMs: 0,
        reverifyIntervalMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: vm.override,
        supersededOwnLogKeysOverride: async () => (supersededOnVm === 'announce' ? [deadKey] : []),
      });
      cleanups.push(async () => {
        await vmHandle.close();
        await closeHarnessStore({ workspaceRoot: rootVm, harnessSlug });
      });
      const vmOwnKey = vmHandle.ownLog.keyHex;
      expect(vmOwnKey).not.toBe(deadKey);

      const newKeyAdmitted = await pollUntil(
        async () => {
          await towerHandle.mergeNow();
          return towerHandle.admitted.has(vmOwnKey) &&
            (supersededOnVm === 'omit' || !towerHandle.admitted.has(deadKey));
        },
        { timeoutMs: 45_000, intervalMs: 250 },
      );
      const towerEvents = listBootHistory({ workspaceId, harnessSlug, limit: 200 })
        .map((e) => `${e.kind}: ${e.message ?? ''}`)
        .join('\n');
      return { towerHandle, deadKey, newKeyAdmitted: newKeyAdmitted === true, towerEvents };
  }

  it(
    'the tower drops the VM’s old log once the VM re-announces under its new key',
    async () => {
      const r = await runRecoveryScenario('fix', 'announce');
      expect(r.newKeyAdmitted, `tower never retired the dead key. Tower boot history:\n${r.towerEvents}`).toBe(true);
      expect(r.towerHandle.admitted.has(r.deadKey)).toBe(false);
      expect(r.towerEvents).toMatch(/peer_log_superseded: .*superseded by/);
    },
    90_000,
  );

  it(
    'control: without the supersession the same recovery leaves the dead key admitted (the WI-10002600 bug)',
    async () => {
      const r = await runRecoveryScenario('control', 'omit');
      // The wire worked (the new key arrived), yet nothing retired the old one — so the
      // test above passes only because the sender put the statement on the wire.
      expect(r.newKeyAdmitted, `the VM's new key never reached the tower:\n${r.towerEvents}`).toBe(true);
      expect(r.towerHandle.admitted.has(r.deadKey)).toBe(true);
      expect(r.towerEvents).not.toMatch(/peer_log_superseded/);
    },
    90_000,
  );
});
