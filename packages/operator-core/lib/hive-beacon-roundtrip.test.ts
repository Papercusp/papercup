/**
 * hive-beacon-roundtrip.test.ts — the beacon over the directory wire format
 * (P-005, brief B-06; the "fake-swarm two-peer" data path without a real swarm).
 *
 * Peer A signs an announce carrying a beacon with a real Ed25519 key; peer B's
 * HiveDirectory ingests it. Pins:
 *   - signature binding: a beaconful announce verifies; a beacon-less one signs
 *     byte-identical to the pre-beacon format (back-compat);
 *   - consume: B's DiscoveredHive carries the sanitized beacon;
 *   - clamp-not-reject: an OVERSIZE beacon is admitted + clamped, never rejected;
 *   - tamper: mutating a signed beacon field rejects the announce (bad-signature);
 *   - publish gate (announce-carries-beacon-IFF-consented): the enrich seam puts
 *     a beacon on the built announce only when buildBeacon yields one.
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { HiveDirectory, type HiveDirectoryDeps, type LocalHiveDescriptor } from './hive-directory';
import {
  buildHiveAnnounce,
  hiveAnnounceSigningBytes,
  verifyHiveAnnounce,
  type HiveAnnounceBody,
  type SignedHiveAnnounce,
} from './sync/hyperbee/hive-announce';
import { deriveDirectoryTopic, hiveTopicAsHex } from './sync/hyperbee/derive-hive-topic';
import { enrichLocalHiveDescriptor } from './hive-descriptor-enrich';
import { makeBeacon, type HiveStatusBeacon } from './hive-beacon';

const NOW = 1_700_000_000_000;
const BEACON: HiveStatusBeacon = makeBeacon({
  liveAgents: 5,
  queueDepth: 9,
  focus: 'wiring the cross-hive boundary',
  lastCompleted: 'landed the ask ledger',
  ts: new Date(NOW).toISOString(),
});

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

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

function consumerDir(): HiveDirectory {
  const deps: HiveDirectoryDeps = {
    sign: (b) => Promise.resolve(Buffer.from(b)),
    verifyAttestation: async () => true,
    broadcast: async () => {},
    now: () => NOW,
  };
  return new HiveDirectory(deps);
}

describe('beacon over the wire — signature binding', () => {
  it('an announce carrying a beacon verifies', async () => {
    const kp = keypair();
    const frame = await announce(kp, { beacon: BEACON });
    expect(verifyHiveAnnounce(frame, { nowMs: NOW })).toBe(true);
  });

  it('a beacon-less announce signs byte-identical to the pre-beacon format', async () => {
    const kp = keypair();
    const frame = await announce(kp); // no beacon
    const bytes = hiveAnnounceSigningBytes(frame).toString('utf8');
    expect(bytes).not.toContain('beacon');
    expect(verifyHiveAnnounce(frame, { nowMs: NOW })).toBe(true);
  });

  it('the beacon IS covered by the signature (signing bytes carry it canonically)', async () => {
    const kp = keypair();
    const frame = await announce(kp, { beacon: BEACON });
    const bytes = hiveAnnounceSigningBytes(frame).toString('utf8');
    expect(bytes).toContain('"beacon":{"v":1');
  });
});

describe('beacon over the wire — consume on peer B', () => {
  it('B ingests the announce and its DiscoveredHive carries the sanitized beacon', async () => {
    const kp = keypair();
    const dir = consumerDir();
    const res = await dir.ingestAnnounce(await announce(kp, { beacon: BEACON }));
    expect(res.accepted).toBe(true);
    expect(dir.listDiscoveredHives()[0].beacon).toEqual(BEACON);
  });

  it('an announce with no beacon lists with no beacon field', async () => {
    const kp = keypair();
    const dir = consumerDir();
    await dir.ingestAnnounce(await announce(kp));
    expect(dir.listDiscoveredHives()[0].beacon).toBeUndefined();
  });

  it('an OVERSIZE beacon is ADMITTED and CLAMPED, never rejected', async () => {
    const kp = keypair();
    const dir = consumerDir();
    // Bypass makeBeacon's clamp to forge an oversize-but-validly-signed beacon.
    const oversize = { ...BEACON, focus: 'q'.repeat(500) } as unknown as HiveStatusBeacon;
    const res = await dir.ingestAnnounce(await announce(kp, { beacon: oversize }));
    expect(res.accepted).toBe(true);
    expect(dir.listDiscoveredHives()[0].beacon!.focus.length).toBe(120);
  });

  it('a malformed beacon does not reject the announce (lists with no beacon)', async () => {
    const kp = keypair();
    const dir = consumerDir();
    const junk = { v: 2, nope: true } as unknown as HiveStatusBeacon;
    const res = await dir.ingestAnnounce(await announce(kp, { beacon: junk }));
    expect(res.accepted).toBe(true);
    expect(dir.listDiscoveredHives()[0].beacon).toBeUndefined();
  });

  it('TAMPERING a signed beacon field rejects the announce (bad-signature)', async () => {
    const kp = keypair();
    const dir = consumerDir();
    const frame = await announce(kp, { beacon: BEACON });
    const tampered: SignedHiveAnnounce = { ...frame, beacon: { ...BEACON, liveAgents: 9999 } };
    const res = await dir.ingestAnnounce(tampered);
    expect(res).toEqual({ accepted: false, reason: 'bad-signature-or-stale' });
  });
});

describe('publish gate — announce carries a beacon IFF the enrich seam yields one', () => {
  const base: LocalHiveDescriptor = {
    potId: 'hive-pub',
    title: 'Pub',
    description: 'd',
    workspaceId: 'ws-1',
    memberTopics: ['b'.repeat(64)],
    visibility: 'public',
    createdAt: NOW - 1000,
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 4242,
    ownerDevicePubkey: keypair().pubkey,
    attestationGistId: 'gist-1',
  };

  it('attaches the beacon when buildBeacon (consent ON) yields one', async () => {
    const enriched = await enrichLocalHiveDescriptor(base, {
      loadPubkey: async () => null,
      deriveMemberRepos: async () => [],
      loadRegistry: async () => ({ projects: [] }),
      buildBeacon: async () => BEACON,
    });
    expect(enriched.beacon).toEqual(BEACON);
  });

  it('omits the beacon when buildBeacon (consent OFF) yields undefined', async () => {
    const enriched = await enrichLocalHiveDescriptor(base, {
      loadPubkey: async () => null,
      deriveMemberRepos: async () => [],
      loadRegistry: async () => ({ projects: [] }),
      buildBeacon: async () => undefined,
    });
    expect(enriched.beacon).toBeUndefined();
  });

  it('the enriched descriptor’s beacon reaches the broadcast announce (full publish path)', async () => {
    const kp = keypair();
    const broadcasts: SignedHiveAnnounce[] = [];
    const dir = new HiveDirectory({
      sign: (b) => Promise.resolve(nodeSign(null, b, kp.privateKey)),
      verifyAttestation: async () => true,
      broadcast: async (_topic, frame) => { broadcasts.push(frame); },
      now: () => NOW,
      // the enrich seam the directory calls at build time — consent ON here.
      enrichDescriptor: async (d) => ({ ...d, beacon: BEACON }),
    });
    dir.registerLocalHive({ ...base, ownerDevicePubkey: kp.pubkey });
    await dir.announceLocalHive('hive-pub');
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0].beacon).toEqual(BEACON);
    // and it is on the right topic + verifies end-to-end.
    expect(verifyHiveAnnounce(broadcasts[0], { nowMs: NOW })).toBe(true);
    expect(hiveTopicAsHex(deriveDirectoryTopic())).toBeTruthy();
  });
});
