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
    expect(listed[0]).toMatchObject({ hiveId: 'hive-1', title: 'Hive One', attested: true });
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
    hiveId: 'my-hive',
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
    dir.registerLocalHive({ ...localBase, hiveId: 'pub', visibility: 'public', ownerDevicePubkey: kp.pubkey });
    dir.registerLocalHive({ ...localBase, hiveId: 'priv', visibility: 'private' });
    const n = await dir.reannounceAll();
    expect(n).toBe(1); // only the public one
    expect(deps.broadcasts).toHaveLength(1);
  });
});

describe('HiveDirectory — PG cache seam + TTL GC', () => {
  it('hydrates the in-memory set from the cache (offline listing)', async () => {
    const cached: DiscoveredHive[] = [
      {
        hiveId: 'cached-1',
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
    expect(dir.listDiscoveredHives()[0].hiveId).toBe('cached-1');
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

describe('hiveDirectoryReady — the capability probe', () => {
  it('is true now that the directory substrate exists', () => {
    expect(hiveDirectoryReady()).toBe(true);
  });
});
