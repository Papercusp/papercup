/**
 * hive-directory-live-two-peer.test.ts — the LIVE two-peer E2E for the P2P hive
 * directory (p2p-hive-directory-2026-06-06, the D-006(a) "live multi-peer
 * verification" that was deferred): two REAL Hyperswarm peers on a loopback
 * testnet DHT, each wired through the PRODUCTION boot composition
 * (`wireHiveDirectoryAtBoot` — the same function boot-all.ts calls), exchanging
 * signed hive announces over the real Protomux gossip channel.
 *
 * This is the local-parity sibling of hive-two-peer-federation.test.ts for the
 * DIRECTORY plane. What it proves that the existing unit tests (fake swarm, fake
 * Protomux) cannot:
 *
 *  1. PUBLIC discovery — peer A's owned public hive reaches peer B's browse list
 *     (and B's reaches A: the pair-time getOwnAnnounces exchange) over a real
 *     socket, surviving the wire encoding + signature verify, with member_links
 *     intact for one-click join.
 *  2. EDIT convergence — A re-publishes with a new title (the discovery:set_hive
 *     edit path → publishHiveToDirectory → announceLocalHive → the wiring's
 *     transport broadcast) and B's record converges by LWW.
 *  3. INVITE scoping — A also owns an invite hive: B's global-topic directory
 *     never sees it (no leak), but after B joins the invite topic with the
 *     shared secret (`wiring.joinInviteTopic` — the "follow invite link" path)
 *     the invite hive lists on B. This is the path the (protocol, id) Protomux
 *     channel keying carries: per-topic channel pairing on a SHARED swarm
 *     connection. (Pre-fix, the second topic's channel collided with the global
 *     one and invite announces were silently dropped — this test pins the fix.)
 *
 * Trust boundary stays real: each peer signs with its own in-test Ed25519
 * device key and verifies the other's signature for real; only the channel-2
 * GitHub-attestation lookup is injected (it pins the OTHER peer's device pubkey,
 * so an unknown device still fails attestation).
 */

import { afterEach, describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import createTestnet from 'hyperdht/testnet.js';
import Hyperswarm from 'hyperswarm';
import type { HyperswarmLike } from '../swarm';
import { HiveDirectory, type HiveDirectoryDeps } from '../../../hive-directory';
import {
  wireHiveDirectoryAtBoot,
  type HiveDirectoryWiring,
} from '../../../hive-directory-boot';
import type { HiveDirectoryMeta, HiveOwnerIdentity } from '../../../hive-publish';
import { publishHiveToDirectory } from '../../../hive-publish';
import type { SignedHiveAnnounce } from '../hive-announce';

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
  owner: HiveOwnerIdentity;
  devicePubkey: string;
}

/**
 * Boot one live directory peer over the PRODUCTION wiring: a real Hyperswarm on
 * the testnet bootstrap, a HiveDirectory whose only injected seams are the
 * device signer (a real in-test Ed25519 key) and the channel-2 attestation
 * check (pins `trustedPubkeys`). The dir's broadcast routes through the
 * wiring's own transport — the same closure production hands
 * setHiveDirectoryTransport.
 */
async function bootLivePeer(opts: {
  bootstrap: unknown;
  login: string;
  userId: number;
  trustedPubkeys: () => string[];
  ownedHives?: HiveDirectoryMeta[];
}): Promise<LivePeer> {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const devicePubkey = rawPubkeyBase64(publicKey);
  const owner: HiveOwnerIdentity = {
    githubLogin: opts.login,
    githubUserId: opts.userId,
    devicePubkey,
    attestationGistId: `gist-${opts.login}`,
  };

  // The wiring's transport closure isn't built yet when the dir needs its
  // broadcast seam — route through a late-bound ref (production solves the same
  // ordering with the module-global setHiveDirectoryTransport).
  const transportRef: { fn: ((topicHex: string, frame: SignedHiveAnnounce) => Promise<void>) | null } = {
    fn: null,
  };
  const deps: HiveDirectoryDeps = {
    sign: (bytes) => Promise.resolve(nodeSign(null, bytes, privateKey)),
    verifyAttestation: async ({ devicePubkey: claimed }) => opts.trustedPubkeys().includes(claimed),
    broadcast: async (topicHex, frame) => {
      if (transportRef.fn) await transportRef.fn(topicHex, frame);
    },
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
    // The re-announce timer is not under test (pair-time getOwnAnnounces + the
    // explicit broadcast path are); keep it out of the way.
    reannounceMs: 60 * 60 * 1000,
  });
  cleanups.push(() => wiring.stop());
  transportRef.fn = wiring.transport;

  return { dir, wiring, owner, devicePubkey };
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
    description: `${title} — live two-peer E2E`,
    visibility: 'public',
    memberTopics: ['a'.repeat(64)],
    memberLinks: [`papercusp://harness?topic=${'a'.repeat(64)}&repo=1234`],
    createdAt: Date.now() - 60_000,
  };
}

describe('P2P hive directory — LIVE two-peer E2E over real Hyperswarm (production wiring)', () => {
  it(
    'A and B discover each other’s PUBLIC hives, with member links intact; an edit converges by LWW',
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      // Each peer trusts exactly the other's device attestation (set after both boot).
      const pubkeys: { a?: string; b?: string } = {};
      const a = await bootLivePeer({
        bootstrap: testnet.bootstrap,
        login: 'alice',
        userId: 4242,
        trustedPubkeys: () => (pubkeys.b ? [pubkeys.b] : []),
        ownedHives: [publicHive('hive-a', 'Alpha Hive')],
      });
      const b = await bootLivePeer({
        bootstrap: testnet.bootstrap,
        login: 'bob',
        userId: 7,
        trustedPubkeys: () => (pubkeys.a ? [pubkeys.a] : []),
        ownedHives: [publicHive('hive-b', 'Beta Hive')],
      });
      pubkeys.a = a.devicePubkey;
      pubkeys.b = b.devicePubkey;

      // THE PROOF (discovery): A's public hive crosses to B over the real wire —
      // the pair-time getOwnAnnounces exchange on the global directory topic —
      // and vice versa.
      const onB = await pollUntil(
        () => b.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-a'),
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onB, "peer B never discovered peer A's public hive over the live directory topic").toBeTruthy();
      expect(onB).toMatchObject({
        hiveId: 'hive-a',
        title: 'Alpha Hive',
        ownerGithubLogin: 'alice',
        ownerDevicePubkey: a.devicePubkey,
        visibility: 'public',
        attested: true,
      });
      // One-click-join payload survives the wire.
      expect(onB!.memberLinks).toEqual([`papercusp://harness?topic=${'a'.repeat(64)}&repo=1234`]);

      const onA = await pollUntil(
        () => a.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-b'),
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(onA, "peer A never discovered peer B's public hive (reverse direction)").toBeTruthy();
      expect(onA).toMatchObject({ hiveId: 'hive-b', title: 'Beta Hive', ownerGithubLogin: 'bob' });

      // Owned ≠ discovered: a peer's own hive is not in its browse list.
      expect(a.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-a')).toBeUndefined();

      // THE PROOF (edit convergence): A re-publishes hive-a with a new title —
      // the discovery:set_hive edit path — and B's record converges by LWW over
      // the live broadcast transport.
      await new Promise((r) => setTimeout(r, 5)); // strictly-newer announce ts
      await publishHiveToDirectory(a.dir, { ...publicHive('hive-a', 'Alpha Hive (renamed)') }, a.owner);
      const renamed = await pollUntil(
        () => {
          const h = b.dir.listDiscoveredHives().find((x) => x.hiveId === 'hive-a');
          return h && h.title === 'Alpha Hive (renamed)' ? h : undefined;
        },
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(renamed, "peer B never converged on peer A's edited hive title (live re-announce broadcast)").toBeTruthy();
    },
    60_000,
  );

  it(
    'an INVITE hive never leaks onto the global topic, but lists for a peer that joins the invite topic with the secret',
    async () => {
      const testnet = await createTestnet(3);
      cleanups.push(async () => {
        try {
          await testnet.destroy();
        } catch {
          /* ignore */
        }
      });

      const INVITE_SECRET = 'tearoom-invite-secret';
      const pubkeys: { a?: string; b?: string } = {};
      // A owns a PUBLIC hive AND an INVITE hive — its swarm joins both topics,
      // sharing ONE connection to B (the per-topic channel-pairing case).
      const a = await bootLivePeer({
        bootstrap: testnet.bootstrap,
        login: 'alice',
        userId: 4242,
        trustedPubkeys: () => (pubkeys.b ? [pubkeys.b] : []),
        ownedHives: [
          publicHive('hive-pub', 'Public Hive'),
          {
            hiveId: 'hive-inv',
            title: 'Tearoom (invite only)',
            description: 'invite-scoped hive — live two-peer E2E',
            visibility: 'invite',
            inviteSecret: INVITE_SECRET,
            memberTopics: ['b'.repeat(64)],
            createdAt: Date.now() - 60_000,
          },
        ],
      });
      const b = await bootLivePeer({
        bootstrap: testnet.bootstrap,
        login: 'bob',
        userId: 7,
        trustedPubkeys: () => (pubkeys.a ? [pubkeys.a] : []),
      });
      pubkeys.a = a.devicePubkey;
      pubkeys.b = b.devicePubkey;

      // B (global topic only) discovers the public hive…
      const pub = await pollUntil(
        () => b.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-pub'),
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(pub, 'peer B never discovered the public hive').toBeTruthy();
      // …and the invite hive has NOT leaked onto the global topic.
      expect(b.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-inv')).toBeUndefined();

      // B receives the invite secret out-of-band and joins the invite topic —
      // the "follow invite link" path. The invite hive must now list on B.
      await b.wiring.joinInviteTopic(INVITE_SECRET);
      const inv = await pollUntil(
        () => b.dir.listDiscoveredHives().find((h) => h.hiveId === 'hive-inv'),
        { timeoutMs: 20_000, intervalMs: 250 },
      );
      expect(
        inv,
        'peer B never received the INVITE hive after joining the invite topic — per-topic channel pairing broken',
      ).toBeTruthy();
      expect(inv).toMatchObject({
        hiveId: 'hive-inv',
        title: 'Tearoom (invite only)',
        visibility: 'invite',
        ownerGithubLogin: 'alice',
      });
      // The public list is still scoped right (no duplicate/cross-topic bleed).
      expect(b.dir.listDiscoveredHives().filter((h) => h.hiveId === 'hive-inv')).toHaveLength(1);
    },
    60_000,
  );
});
