/**
 * hive-beacon-live-two-peer.test.ts — the LIVE proof that a status beacon
 * (hive-network-surface-2026-06-11 P-005, brief B-06 / C-2) survives the real
 * Hyperswarm directory wire end-to-end.
 *
 * Mirrors hive-directory-live-two-peer.test.ts (two REAL Hyperswarm peers on a
 * loopback testnet DHT, each wired through the PRODUCTION boot composition
 * `wireHiveDirectoryAtBoot`), but pins the beacon path the unit tests cannot:
 * peer A owns a public hive whose enrich seam attaches a beacon (consent ON), and
 * peer B's browse record carries the SANITIZED beacon after the real wire encode +
 * signature verify. Proves the announce signature covers the beacon over the wire.
 *
 * OPT-IN like cross-hive-two-hive.test.ts: runs ONLY when `RUN_LIVE_HYPERSWARM` is
 * set, so it never gates CI on a real DHT bootstrap. Run with:
 *   RUN_LIVE_HYPERSWARM=1 npm run test --workspace @papercusp/operator-core
 */
import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import type { HyperswarmLike } from '../swarm';
import { HiveDirectory, type HiveDirectoryDeps, type LocalHiveDescriptor } from '../../../hive-directory';
import { wireHiveDirectoryAtBoot, type HiveDirectoryWiring } from '../../../hive-directory-boot';
import type { HiveDirectoryMeta, HiveOwnerIdentity } from '../../../hive-publish';
import type { SignedHiveAnnounce } from '../hive-announce';
import { makeBeacon, type HiveStatusBeacon } from '../../../hive-beacon';

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    try {
      await cleanups.pop()!();
    } catch {
      /* best-effort teardown */
    }
  }
});

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

interface LivePeer {
  dir: HiveDirectory;
  wiring: HiveDirectoryWiring;
  devicePubkey: string;
}

async function bootLivePeer(opts: {
  bootstrap: unknown;
  login: string;
  userId: number;
  trustedPubkeys: () => string[];
  ownedHives?: HiveDirectoryMeta[];
  /** Optional build-time enrich (consent-ON beacon attach for peer A). */
  enrichDescriptor?: (d: LocalHiveDescriptor) => Promise<LocalHiveDescriptor>;
}): Promise<LivePeer> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  const owner: HiveOwnerIdentity = {
    githubLogin: opts.login,
    githubUserId: opts.userId,
    devicePubkey,
    attestationGistId: `gist-${opts.login}`,
  };

  const transportRef: { fn: ((topicHex: string, frame: SignedHiveAnnounce) => Promise<void>) | null } = {
    fn: null,
  };
  const deps: HiveDirectoryDeps = {
    sign: (bytes) => Promise.resolve(nodeSign(null, bytes, privateKey)),
    verifyAttestation: async ({ devicePubkey: claimed }) => opts.trustedPubkeys().includes(claimed),
    broadcast: async (topicHex, frame) => {
      if (transportRef.fn) await transportRef.fn(topicHex, frame);
    },
    ...(opts.enrichDescriptor ? { enrichDescriptor: opts.enrichDescriptor } : {}),
  };
  const dir = new HiveDirectory(deps);

  const swarm = new Hyperswarm({ bootstrap: opts.bootstrap }) as unknown as HyperswarmLike & {
    destroy(): Promise<void>;
  };
  cleanups.push(async () => {
    try {
      await swarm.destroy();
    } catch {
      /* ignore */
    }
  });

  const wiring = await wireHiveDirectoryAtBoot({
    swarm,
    keychainId: `keychain-${opts.login}`,
    owner,
    ownedHives: opts.ownedHives ?? [],
    dir,
    reannounceMs: 60 * 60 * 1000,
  });
  cleanups.push(() => wiring.stop());
  transportRef.fn = wiring.transport;

  return { dir, wiring, devicePubkey };
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

function publicHive(hiveId: string, title: string): HiveDirectoryMeta {
  return {
    hiveId,
    title,
    description: `${title} — live beacon E2E`,
    visibility: 'public',
    memberTopics: ['a'.repeat(64)],
    createdAt: Date.now() - 60_000,
  };
}

const BEACON: HiveStatusBeacon = makeBeacon({
  liveAgents: 4,
  queueDepth: 11,
  focus: 'lighting up the cross-hive boundary',
  lastCompleted: 'landed the directory beacon',
  ts: new Date().toISOString(),
});

describe.skipIf(!process.env.RUN_LIVE_HYPERSWARM)(
  'status beacon — LIVE two-peer over real Hyperswarm (production wiring)',
  () => {
    it(
      'A publishes a consented beacon; B’s browse record carries the sanitized beacon over the real wire',
      async () => {
        const testnet = await createTestnet(3);
        cleanups.push(() => testnet.destroy());
        const bootstrap = testnet.bootstrap;

        // Each peer trusts the other's device pubkey (channel-2 attestation pin).
        let aPub = '';
        let bPub = '';

        const a = await bootLivePeer({
          bootstrap,
          login: 'alice',
          userId: 1,
          trustedPubkeys: () => [aPub, bPub],
          ownedHives: [publicHive('hive-a', 'Alpha Hive')],
          // consent ON: attach the beacon at announce-build time.
          enrichDescriptor: async (d) => (d.hiveId === 'hive-a' ? { ...d, beacon: BEACON } : d),
        });
        aPub = a.devicePubkey;

        const b = await bootLivePeer({
          bootstrap,
          login: 'bob',
          userId: 2,
          trustedPubkeys: () => [aPub, bPub],
          ownedHives: [publicHive('hive-b', 'Beta Hive')],
        });
        bPub = b.devicePubkey;

        // B discovers A's hive over the pair-time getOwnAnnounces exchange...
        const seen = await pollUntil(() => b.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-a'), {
          timeoutMs: 15_000,
          intervalMs: 200,
        });
        expect(seen).toBeDefined();
        // ...and the beacon survived the wire encode + signature verify, sanitized.
        expect(seen!.beacon).toEqual(BEACON);

        // B's own hive (no enrich beacon) carries none — the field is per-publisher.
        const ownB = await pollUntil(() => a.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-b'), {
          timeoutMs: 15_000,
          intervalMs: 200,
        });
        expect(ownB).toBeDefined();
        expect(ownB!.beacon).toBeUndefined();
      },
      30_000,
    );
  },
);
