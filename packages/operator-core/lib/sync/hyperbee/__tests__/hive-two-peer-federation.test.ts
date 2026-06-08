/**
 * hive-two-peer-federation.test.ts — shared-hive-federation-2026-06-08 P-011
 * Track A (the LOCAL-PARITY 2-peer proof): a Hive's content federates across two
 * Swarms of the SAME Hive over the **Hive pubkey topic** (the P-004 re-key),
 * with no central coordinator.
 *
 * This is the Hive-scoped sibling of `two-peer-swarm.test.ts`: it boots two REAL
 * `bootHarnessSubstrate` peers on a local testnet DHT and proves a write on peer
 * A reaches peer B over the actual Hyperswarm replication path. The ONLY
 * difference is the swarm binding — `{ kind: 'hive', hive_pubkey }` instead of
 * `{ kind: 'local', … }` — so both peers join `deriveHiveFederationTopic(pubkey)`
 * (D-001/D-003/P-004) rather than a per-harness topic. That is the Track A claim:
 * **a shared Hive's work + coord content federates over the Hive topic** (harness
 * sync is a within-Hive component, not the top unit — D-010).
 *
 * Proof boundary (same as two-peer-swarm.test.ts): TRANSPORT only. The channel-2
 * GitHub-binding admission gate is bypassed (`verifyBindingOverride`); the
 * announce SIGNATURE check is NOT (each peer signs with a real in-test Ed25519
 * key). `applyOverride` captures merged ops, so the projection→PG hop is not
 * touched — no Docker/PG, loopback-UDP testnet DHT only.
 *
 * NOT proven here (gated on su-02ae39's P-008 presence-announce PUBLISHER): the
 * LIVE Track B path — a Swarm announces presence carrying `hive_slug`, the Hive
 * lock authority elects across the live Swarm roster, and a file claim on A
 * routes to the authority on B. That is the `describe.skip` placeholder below;
 * su-73a60 fills it in (its authority LOGIC is already proven in
 * `authority/__tests__/two-instance-hive-authority.integration.test.ts`).
 *
 * Resource hygiene: both handles closed, both swarms destroyed, the testnet
 * destroyed, the corestore cache reset, every temp dir removed in afterEach.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import { bootHarnessSubstrate, type BootedHarnessHandle } from '../boot';
import { type HyperswarmLike } from '../swarm';
import type { OpEnvelope } from '../op-envelope-types';
import { deriveHiveFederationTopic } from '../derive-swarm-topic';
import { _resetCacheForTests, closeHarnessStore } from '../corestore';
import { _resetBootHistoryForTests } from '../boot-history';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
  _resetCacheForTests();
  _resetBootHistoryForTests();
});

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

/** Raw 32-byte Ed25519 pubkey, base64 — the device/hive pubkey convention. */
function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' }) as Buffer;
  return spkiDer.subarray(-32).toString('base64');
}

function makeIdentityOverride(login: string, userId: number, keychainId: string) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  return {
    devicePubkey,
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

describe('Shared Hive federation — two Swarms of one Hive over REAL Hyperswarm (Track A content, P-011)', () => {
  it(
    "federates a Hive's content across two Swarms over the HIVE pubkey topic (P-004 re-key)",
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      // The Hive identity: a self-generated raw-32-byte Ed25519 pubkey stands in
      // for a real Hive entity's keypair (hive-keypair.ts). The topic only hashes
      // the pubkey string, so any valid pubkey proves the join; both Swarms use
      // the SAME one → the SAME Hive topic.
      const hivePubkey = rawPubkeyBase64(generateKeyPairSync('ed25519').publicKey);
      const binding = { kind: 'hive' as const, hive_pubkey: hivePubkey };

      const workspaceId = 'ws-hive-fed-test';
      // Two Swarms of one Hive can host DIFFERENT member harnesses; harness_slug
      // is the within-Hive component demux (D-003), NOT the federation key — so
      // the peers federate over the Hive topic regardless of their local slug.
      const harnessSlug = 'acme-rd';

      const idA = makeIdentityOverride('alice', 4242, 'test-keychain-alice');
      const idB = makeIdentityOverride('bob', 7, 'test-keychain-bob');

      const swarmA = makeSwarm(testnet.bootstrap);
      const swarmB = makeSwarm(testnet.bootstrap);

      const applyA = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);
      const applyB = vi.fn<(op: OpEnvelope) => Promise<boolean>>(async () => true);

      const rootA = makeWorkspaceRoot('hivefed-A-');
      const rootB = makeWorkspaceRoot('hivefed-B-');

      let handleA: BootedHarnessHandle | undefined;
      let handleB: BootedHarnessHandle | undefined;

      handleA = await bootHarnessSubstrate({
        workspaceRoot: rootA,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmA,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyA,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idA.override,
      });
      cleanups.push(async () => {
        await handleA?.close();
        await closeHarnessStore({ workspaceRoot: rootA, harnessSlug });
      });

      handleB = await bootHarnessSubstrate({
        workspaceRoot: rootB,
        workspaceId,
        harnessSlug,
        swarmBinding: binding,
        swarmOverride: swarmB,
        verifyBindingOverride: async () => 'verified',
        applyOverride: applyB,
        mergePollMs: 0,
        pendingRetryMs: 0,
        loadRevokedOverride: async () => new Set(),
        announceIdentityOverride: idB.override,
      });
      cleanups.push(async () => {
        await handleB?.close();
        await closeHarnessStore({ workspaceRoot: rootB, harnessSlug });
      });

      // Both joined a swarm, on the SAME topic, and that topic IS the Hive
      // federation topic (not a per-harness/local topic) — the P-004 re-key.
      expect(handleA.swarm).not.toBeNull();
      expect(handleB.swarm).not.toBeNull();
      expect(handleA.swarm!.topicHex).toBe(handleB.swarm!.topicHex);
      expect(handleA.swarm!.topicHex).toBe(deriveHiveFederationTopic(hivePubkey).toString('hex'));

      // Peer A writes a Hive WORK record + a Hive COORD-content record to its own
      // log (Track A = the Hive's work + coord content). harness_slug stays the
      // within-Hive component demux on each row; the topic routes it Hive-wide.
      await handleA.append({
        type: 'put',
        table: 'features_consolidated',
        hbKey: 'F-hive-fed-1',
        value: { status: 'todo' },
        ts: 1000,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });
      await handleA.append({
        type: 'put',
        table: 'messages',
        hbKey: 'msg-hive-fed-1',
        value: { body: 'hello from Swarm A' },
        ts: 1001,
        schema_version: 1,
        writerPubkey: idA.devicePubkey,
      });

      // THE PROOF: both records cross to peer B over the real Hyperswarm transport
      // on the Hive topic — no central coordinator, no hand-piping. Poll B's
      // mergeNow() until both ops land in its apply sink.
      const gotWork = await pollUntil(
        async () => {
          await handleB!.mergeNow();
          return applyB.mock.calls.find((c) => c[0].hbKey === 'F-hive-fed-1')?.[0];
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      const gotCoord = applyB.mock.calls.find((c) => c[0].hbKey === 'msg-hive-fed-1')?.[0];

      expect(gotWork, "peer B never received peer A's WORK record over the Hive topic").toBeTruthy();
      expect(gotWork).toMatchObject({
        table: 'features_consolidated',
        hbKey: 'F-hive-fed-1',
        value: { status: 'todo' },
        writerPubkey: idA.devicePubkey,
      });
      expect(gotCoord, "peer B never received peer A's COORD-content record over the Hive topic").toBeTruthy();
      expect(gotCoord).toMatchObject({ table: 'messages', hbKey: 'msg-hive-fed-1' });

      // B admitted A's log over the real wire (announce exchanged + admission passed).
      expect(handleB.admitted.size).toBeGreaterThanOrEqual(2); // own + A's remote
    },
    35_000,
  );
});

/**
 * Track B (file-lock authority federation) — GATED on su-02ae39's P-008
 * presence-announce PUBLISHER. The authority LOGIC is already proven over
 * loopback HTTP in
 * `authority/__tests__/two-instance-hive-authority.integration.test.ts`
 * (su-73a60, 7 cases). This placeholder is the LIVE-presence layer on THIS
 * 2-peer substrate harness: each peer announces presence carrying `hive_slug`
 * (the data-carry landed by su-14214), the Hive lock authority elects across the
 * live Swarm roster, and a file claim on A routes to the authority on B. su-73a60
 * fills this in once the publisher lands (events:await presence-publisher).
 */
describe.skip('Shared Hive federation — Track B file-lock authority over live presence (P-011, gated on P-008 publisher)', () => {
  it.skip('elects the Hive authority across live Swarms + serializes a cross-Swarm file claim', () => {
    // Pending su-02ae39's presence-announce publisher (P-008): boot both peers as
    // above, drive each peer's presence-announce loop (buildPresenceAnnounceOp with
    // hive_slug = the Hive home slug), federate presence over the Hive topic, then
    // assert lockAuthorityForHive(hiveSlug) on A sees B's Swarm + a file claim
    // routes to the single Hive authority. See su-73a60's authority-logic E2E.
  });
});
