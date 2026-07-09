/**
 * hive-directory.test.ts — the P2P hive-directory service (p2p-hive-directory P-003).
 *
 * Drives HiveDirectory over injected fake seams + REAL Ed25519 announces (built
 * with generated keypairs via buildHiveAnnounce), pinning:
 *   - verified-only render: a bad-sig / stale / UNATTESTED announce is dropped (D-001);
 *   - LWW: an older announce never clobbers a newer record;
 *   - local mute (no global moderation, D-001);
 *   - announceLocalHive routes by visibility (public→global, invite→invite topic, private→no-op);
 *   - re-announce broadcasts every owned non-private hive;
 *   - PG cache hydrate + persist seams;
 *   - TTL GC.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
  HiveDirectory,
  hiveDirectoryReady,
  type DiscoveredHive,
  type HiveDirectoryDeps,
  type LocalHiveDescriptor,
} from './hive-directory';
import { buildHiveAnnounce, type HiveAnnounceBody, type SignedHiveAnnounce } from './sync/hyperbee/hive-announce';
import { deriveDirectoryTopic, deriveInviteTopic, hiveTopicAsHex } from './sync/hyperbee/derive-hive-topic';

const NOW = 1_700_000_000_000;

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

/** A keypair + its raw-base64 pubkey, for building announces in-test. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, pubkey: rawPubkeyBase64(publicKey) };
}

async function announce(
  kp: { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; pubkey: string },
  over: Partial<HiveAnnounceBody> = {},
): Promise<SignedHiveAnnounce> {
  const body: HiveAnnounceBody = {
    hive_id: 'hive-1',
    title: 'Hive One',
    description: 'desc',
    owner_github_login: 'alice',
    owner_github_user_id: 4242,
    owner_device_pubkey: kp.pubkey,
    attestation_gist_id: 'gist-1',
    member_topics: ['a'.repeat(64)],
    visibility: 'public',
    created_at: NOW - 86_400_000,
    ts: NOW,
    ...over,
  };
  return buildHiveAnnounce(body, (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)));
}

function makeDeps(over: Partial<HiveDirectoryDeps> = {}): HiveDirectoryDeps & {
  broadcasts: Array<{ topic: string; frame: SignedHiveAnnounce }>;
} {
  const broadcasts: Array<{ topic: string; frame: SignedHiveAnnounce }> = [];
  return {
    broadcasts,
    sign: (b) => Promise.resolve(Buffer.from(b)), // unused for ingest tests
    verifyAttestation: async () => true,
    broadcast: async (topic, frame) => {
      broadcasts.push({ topic, frame });
    },
    now: () => NOW,
    ...over,
  };
}

describe('HiveDirectory.ingestAnnounce — verified-only render (D-001)', () => {
  it('accepts a valid, attested announce and lists it', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    const res = await dir.ingestAnnounce(await announce(kp));
    expect(res.accepted).toBe(true);
    const listed = dir.listDiscoveredHives();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ potId: 'hive-1', title: 'Hive One', attested: true });
  });

  it('DROPS an announce that fails attestation (channel-2 spam floor)', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps({ verifyAttestation: async () => false }));
    const res = await dir.ingestAnnounce(await announce(kp));
    expect(res).toEqual({ accepted: false, reason: 'unattested' });
    expect(dir.listDiscoveredHives()).toHaveLength(0);
  });

  it('DROPS a tampered (bad-signature) announce before even checking attestation', async () => {
    const kp = keypair();
    const attest = vi.fn(async () => true);
    const dir = new HiveDirectory(makeDeps({ verifyAttestation: attest }));
    const frame = await announce(kp);
    const res = await dir.ingestAnnounce({ ...frame, title: 'Spoofed' });
    expect(res).toEqual({ accepted: false, reason: 'bad-signature-or-stale' });
    expect(attest).not.toHaveBeenCalled(); // sig gate is first
  });

  it('DROPS a stale announce (outside the freshness window)', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps({ now: () => NOW + 10 * 60 * 1000 }));
    const res = await dir.ingestAnnounce(await announce(kp));
    expect(res.reason).toBe('bad-signature-or-stale');
  });
});

describe('HiveDirectory.ingestAnnounce — LWW dedupe', () => {
  it('a NEWER announce updates the record; an OLDER one is superseded', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    await dir.ingestAnnounce(await announce(kp, { ts: NOW, title: 'v1' }));
    // Newer ts wins.
    const newer = await dir.ingestAnnounce(await announce(kp, { ts: NOW + 1000, title: 'v2', nonce: 'n2' }));
    expect(newer.accepted).toBe(true);
    expect(dir.listDiscoveredHives()[0].title).toBe('v2');
    // Older ts is rejected, record unchanged.
    const older = await dir.ingestAnnounce(await announce(kp, { ts: NOW - 1000, title: 'v0', nonce: 'n0' }));
    expect(older).toEqual({ accepted: false, reason: 'superseded' });
    expect(dir.listDiscoveredHives()[0].title).toBe('v2');
  });
});

describe('HiveDirectory — local mute (no global moderation, D-001)', () => {
  it('a muted hive is dropped on ingest and hidden from the list', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    dir.mute('hive-1');
    const res = await dir.ingestAnnounce(await announce(kp));
    expect(res).toEqual({ accepted: false, reason: 'muted' });
    expect(dir.listDiscoveredHives()).toHaveLength(0);
  });

  it('unmute lets a subsequently-ingested announce list again', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    dir.mute('hive-1');
    await dir.ingestAnnounce(await announce(kp, { ts: NOW }));
    dir.unmute('hive-1');
    const res = await dir.ingestAnnounce(await announce(kp, { ts: NOW + 1 }));
    expect(res.accepted).toBe(true);
    expect(dir.listDiscoveredHives()).toHaveLength(1);
  });
});

describe('HiveDirectory.announceLocalHive — routes by visibility (D-004)', () => {
  const localBase: Omit<LocalHiveDescriptor, 'visibility'> = {
    potId: 'my-hive',
    title: 'My Hive',
    description: 'mine',
    memberTopics: ['f'.repeat(64)],
    createdAt: NOW - 1000,
    ownerGithubLogin: 'me',
    ownerGithubUserId: 99,
    ownerDevicePubkey: keypair().pubkey,
    attestationGistId: 'g',
  };

  it('public → broadcasts on the GLOBAL directory topic', async () => {
    const kp = keypair();
    const deps = makeDeps({ sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)) });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({ ...localBase, visibility: 'public', ownerDevicePubkey: kp.pubkey });
    const frame = await dir.announceLocalHive('my-hive');
    expect(frame).not.toBeNull();
    expect(deps.broadcasts).toHaveLength(1);
    expect(deps.broadcasts[0].topic).toBe(hiveTopicAsHex(deriveDirectoryTopic()));
  });

  it('invite → broadcasts on the INVITE topic, never the global one', async () => {
    const kp = keypair();
    const deps = makeDeps({ sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)) });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({
      ...localBase,
      visibility: 'invite',
      inviteSecret: 'sekret',
      ownerDevicePubkey: kp.pubkey,
    });
    await dir.announceLocalHive('my-hive');
    expect(deps.broadcasts[0].topic).toBe(hiveTopicAsHex(deriveInviteTopic('sekret')));
    expect(deps.broadcasts[0].topic).not.toBe(hiveTopicAsHex(deriveDirectoryTopic()));
  });

  it('private → NEVER announces (no broadcast, returns null)', async () => {
    const deps = makeDeps();
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({ ...localBase, visibility: 'private' });
    const frame = await dir.announceLocalHive('my-hive');
    expect(frame).toBeNull();
    expect(deps.broadcasts).toHaveLength(0);
  });

  it('invite without a secret throws (an invite needs a topic)', async () => {
    const dir = new HiveDirectory(makeDeps());
    dir.registerLocalHive({ ...localBase, visibility: 'invite' });
    await expect(dir.announceLocalHive('my-hive')).rejects.toThrow(/inviteSecret/);
  });

  it('reannounceAll broadcasts every owned non-private hive', async () => {
    const kp = keypair();
    const deps = makeDeps({ sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)) });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({ ...localBase, potId: 'pub', visibility: 'public', ownerDevicePubkey: kp.pubkey });
    dir.registerLocalHive({ ...localBase, potId: 'priv', visibility: 'private' });
    const n = await dir.reannounceAll();
    expect(n).toBe(1); // only the public one
    expect(deps.broadcasts).toHaveLength(1);
  });

  it('announce-build enrichment makes every reannounce FRESH (hardening P-004/D-004)', async () => {
    const kp = keypair();
    let memberSet = ['acme/shop#100'];
    const deps = makeDeps({
      sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)),
      enrichDescriptor: async (d) => ({ ...d, memberRepos: [...memberSet] }),
    });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({ ...localBase, visibility: 'public', ownerDevicePubkey: kp.pubkey });
    const first = await dir.announceLocalHive('my-hive');
    expect(first?.member_repos).toEqual(['acme/shop#100']);
    // A member added BETWEEN announces (no re-register) appears on the next tick.
    memberSet = ['acme/shop#100', 'acme/added-later#200'];
    const second = await dir.announceLocalHive('my-hive');
    expect(second?.member_repos).toEqual(['acme/shop#100', 'acme/added-later#200']);
  });

  it('a failing enricher falls back to the registered descriptor (best-effort)', async () => {
    const kp = keypair();
    const deps = makeDeps({
      sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)),
      enrichDescriptor: async () => {
        throw new Error('pg down');
      },
    });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({ ...localBase, visibility: 'public', ownerDevicePubkey: kp.pubkey, memberRepos: ['registered/ref#1'] });
    const frame = await dir.announceLocalHive('my-hive');
    expect(frame?.member_repos).toEqual(['registered/ref#1']);
  });
});

describe('HiveDirectory — withdrawal tombstones (hardening P-005 / D-005)', () => {
  async function listedHive(dir: HiveDirectory, kp: ReturnType<typeof keypair>, ts = NOW) {
    const res = await dir.ingestAnnounce(await announce(kp, { ts }));
    expect(res.accepted).toBe(true);
  }
  async function unlistFrame(kp: ReturnType<typeof keypair>, over: Record<string, unknown> = {}) {
    const { buildHiveUnlist, HIVE_UNLIST_KIND } = await import('./sync/hyperbee/hive-unlist');
    return buildHiveUnlist(
      {
        kind: HIVE_UNLIST_KIND,
        hive_id: 'hive-1',
        owner_device_pubkey: kp.pubkey,
        ts: NOW + 10,
        ...over,
      } as never,
      (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)),
    );
  }

  it('owner unlist drops the listing immediately; replayed older announces stay dropped; a newer announce relists', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    await listedHive(dir, kp);
    const res = await dir.ingestUnlist(await unlistFrame(kp));
    expect(res).toEqual({ accepted: true });
    expect(dir.listDiscoveredHives()).toHaveLength(0);
    // Replay of an announce at/before the watermark → tombstoned.
    const replay = await dir.ingestAnnounce(await announce(kp, { ts: NOW + 5, nonce: 'r' }));
    expect(replay).toEqual({ accepted: false, reason: 'tombstoned' });
    // A genuinely newer announce (re-publish) relists + clears the tombstone.
    const relist = await dir.ingestAnnounce(await announce(kp, { ts: NOW + 20, nonce: 'n' }));
    expect(relist.accepted).toBe(true);
    expect(dir.listDiscoveredHives()).toHaveLength(1);
  });

  it("a non-owner's unlist is rejected (sig valid but pubkey ≠ the listing's)", async () => {
    const owner = keypair();
    const attacker = keypair();
    const dir = new HiveDirectory(makeDeps());
    await listedHive(dir, owner);
    const res = await dir.ingestUnlist(await unlistFrame(attacker));
    expect(res).toEqual({ accepted: false, reason: 'not-owner' });
    expect(dir.listDiscoveredHives()).toHaveLength(1);
  });

  it('an unlist for an unknown hive is rejected (nothing to authenticate against)', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    const res = await dir.ingestUnlist(await unlistFrame(kp));
    expect(res).toEqual({ accepted: false, reason: 'unknown-hive' });
  });

  it('tombstones persist via the seams and survive a "reboot" (cache cannot resurrect)', async () => {
    const kp = keypair();
    let savedTombstones: Record<string, number> = {};
    let savedHives: DiscoveredHive[] = [];
    const deps = makeDeps({
      saveTombstones: async (t) => {
        savedTombstones = t;
      },
      saveCache: async (h) => {
        savedHives = h;
      },
    });
    const dir = new HiveDirectory(deps);
    await listedHive(dir, kp);
    const cachedBeforeUnlist = [...savedHives];
    await dir.ingestUnlist(await unlistFrame(kp));
    expect(savedTombstones['hive-1']).toBe(NOW + 10);

    // "Reboot": a fresh directory hydrating from a STALE cache (still carries
    // the hive) + the persisted tombstones — the withdrawn hive must not list.
    const dir2 = new HiveDirectory(
      makeDeps({
        loadCache: async () => cachedBeforeUnlist,
        loadTombstones: async () => savedTombstones,
      }),
    );
    await dir2.hydrateFromCache();
    expect(dir2.listDiscoveredHives()).toHaveLength(0);
  });

  it('owner side: unlistLocalHive broadcasts the signed tombstone + unregisters; private hives broadcast nothing', async () => {
    const kp = keypair();
    const deps = makeDeps({ sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)) });
    const dir = new HiveDirectory(deps);
    dir.registerLocalHive({
      potId: 'mine',
      title: 't',
      description: '',
      memberTopics: [],
      visibility: 'public',
      createdAt: NOW,
      ownerGithubLogin: 'me',
      ownerGithubUserId: 1,
      ownerDevicePubkey: kp.pubkey,
      attestationGistId: 'g',
    });
    const frame = await dir.unlistLocalHive('mine');
    expect(frame?.kind).toBe('hive-unlist');
    expect(deps.broadcasts).toHaveLength(1);
    expect(await dir.announceLocalHive('mine')).toBeNull(); // unregistered

    dir.registerLocalHive({
      potId: 'priv',
      title: 't',
      description: '',
      memberTopics: [],
      visibility: 'private',
      createdAt: NOW,
      ownerGithubLogin: 'me',
      ownerGithubUserId: 1,
      ownerDevicePubkey: kp.pubkey,
      attestationGistId: 'g',
    });
    const none = await dir.unlistLocalHive('priv');
    expect(none).toBeNull();
    expect(deps.broadcasts).toHaveLength(1); // unchanged — nothing was on the wire
  });
});

describe('HiveDirectory — PG cache seam + TTL GC', () => {
  it('hydrates the in-memory set from the cache (offline listing)', async () => {
    const cached: DiscoveredHive[] = [
      {
        potId: 'cached-1',
        title: 'Cached',
        description: 'd',
        ownerGithubLogin: 'x',
        ownerGithubUserId: 1,
        ownerDevicePubkey: 'pk',
        memberTopics: [],
        visibility: 'public',
        createdAt: NOW - 5000,
        announcedTs: NOW - 5000,
        lastSeenMs: NOW - 5000,
        attested: true,
      },
    ];
    const dir = new HiveDirectory(makeDeps({ loadCache: async () => cached }));
    const n = await dir.hydrateFromCache();
    expect(n).toBe(1);
    expect(dir.listDiscoveredHives()[0].potId).toBe('cached-1');
  });

  it('persists the discovered set on accept (saveCache called with the full set)', async () => {
    const kp = keypair();
    const saveCache = vi.fn(async (_hives: DiscoveredHive[]) => {});
    const dir = new HiveDirectory(makeDeps({ saveCache }));
    await dir.ingestAnnounce(await announce(kp));
    expect(saveCache).toHaveBeenCalledTimes(1);
    expect(saveCache.mock.calls[0][0]).toHaveLength(1);
  });

  it('GC evicts a discovered hive older than the TTL; the list hides it before GC too', async () => {
    const kp = keypair();
    let clock = NOW;
    const dir = new HiveDirectory(makeDeps({ now: () => clock }));
    await dir.ingestAnnounce(await announce(kp));
    // Advance the clock 8 days — past the 7d TTL.
    clock = NOW + 8 * 24 * 60 * 60 * 1000;
    expect(dir.listDiscoveredHives()).toHaveLength(0); // hidden from the list
    expect(dir.listDiscoveredHives({ includeExpired: true })).toHaveLength(1); // still in memory
    expect(dir.gcExpired()).toBe(1); // now evicted
    expect(dir.listDiscoveredHives({ includeExpired: true })).toHaveLength(0);
  });
});

describe('cross-Hive addressability — hive_pubkey flows announce→DiscoveredHive (P-006)', () => {
  it('ingest populates DiscoveredHive.hivePubkey when the announce carries it', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    await dir.ingestAnnounce(await announce(kp, { hive_pubkey: 'aGl2ZS1wdWJrZXk=' }));
    expect(dir.listDiscoveredHives()[0].hivePubkey).toBe('aGl2ZS1wdWJrZXk=');
  });

  it('a hive_pubkey-less announce yields no hivePubkey (browseable, not addressable)', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps());
    await dir.ingestAnnounce(await announce(kp));
    expect(dir.listDiscoveredHives()[0].hivePubkey).toBeUndefined();
  });

  it('an owned descriptor carrying hivePubkey announces it + a peer ingests the dial address', async () => {
    const kp = keypair();
    const dir = new HiveDirectory(makeDeps({ sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)) }));
    const desc: LocalHiveDescriptor = {
      potId: 'owned-1',
      title: 'Owned',
      description: 'd',
      memberTopics: [],
      visibility: 'public',
      createdAt: NOW - 1000,
      ownerGithubLogin: 'alice',
      ownerGithubUserId: 4242,
      ownerDevicePubkey: kp.pubkey,
      hivePubkey: 'b3duZWQtaGl2ZS1waw==',
      attestationGistId: 'gist-1',
    };
    dir.registerLocalHive(desc);
    const frame = await dir.announceLocalHive('owned-1');
    expect(frame?.hive_pubkey).toBe('b3duZWQtaGl2ZS1waw==');
    // a fresh peer ingesting the same frame surfaces the dial address (round-trip)
    const peer = new HiveDirectory(makeDeps());
    await peer.ingestAnnounce(frame!);
    expect(peer.listDiscoveredHives()[0].hivePubkey).toBe('b3duZWQtaGl2ZS1waw==');
  });
});

describe('hiveDirectoryReady — the capability probe', () => {
  it('is true now that the directory substrate exists', () => {
    expect(hiveDirectoryReady()).toBe(true);
  });
});
