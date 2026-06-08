/**
 * hive-directory-two-peer.test.ts — the cross-peer announce→verify→ingest→list
 * flow (p2p-hive-directory P-003), simulated IN-PROCESS with two independent
 * HiveDirectory instances.
 *
 * The real multi-machine verification (a 2nd physical peer) is hardware-gated;
 * this is its single-process proxy — the part that does NOT need a 2nd machine:
 * peer A builds a REAL Ed25519-signed announce for its hive, and peer B (a
 * SEPARATE directory with its own deps + its own attestation check) verifies +
 * ingests it and surfaces it in listDiscoveredHives. It pins the trust boundary
 * between two independent peers: B trusts NOTHING about A except a valid
 * signature + a passing GitHub attestation, so a tampered or unattested announce
 * from A is dropped. (The transport hop itself is covered by directory-swarm.test.ts.)
 */
import { describe, it, expect } from 'vitest';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { HiveDirectory, type HiveDirectoryDeps, type LocalHiveDescriptor } from './hive-directory';

const NOW = 1_700_000_000_000;

function rawPubkeyBase64(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return (publicKey.export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('base64');
}

/** Peer A — owns + signs a hive announce with a real device keypair. */
function peerA() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubkey = rawPubkeyBase64(publicKey);
  const deps: HiveDirectoryDeps = {
    sign: (b) => Promise.resolve(nodeSign(null, b, privateKey)),
    verifyAttestation: async () => true,
    broadcast: async () => {},
    now: () => NOW,
  };
  const dir = new HiveDirectory(deps);
  const desc: LocalHiveDescriptor = {
    hiveId: 'ash',
    title: 'Ash Hive',
    description: 'the shop migration hive',
    memberTopics: ['a'.repeat(64)],
    visibility: 'public',
    createdAt: NOW - 86_400_000,
    ownerGithubLogin: 'alice',
    ownerGithubUserId: 4242,
    ownerDevicePubkey: pubkey,
    attestationGistId: 'gist-alice',
  };
  dir.registerLocalHive(desc);
  return { dir, pubkey };
}

/** Peer B — an INDEPENDENT directory. `trustPubkey` is the only device whose
 *  attestation B accepts (its GitHub-attestation check); everyone else fails. */
function peerB(trustPubkey: string | null) {
  const deps: HiveDirectoryDeps = {
    sign: async (b) => Buffer.from(b), // B doesn't announce in these tests
    verifyAttestation: async ({ devicePubkey }) => devicePubkey === trustPubkey,
    broadcast: async () => {},
    now: () => NOW,
  };
  return new HiveDirectory(deps);
}

describe('two-peer directory flow (single-process proxy for the multi-peer gate)', () => {
  it('A announces → B verifies + ingests + lists the hive', async () => {
    const a = peerA();
    const b = peerB(a.pubkey); // B trusts A's device attestation
    const [frame] = await a.dir.buildOwnedAnnounces(); // A's real signed announce
    expect(frame).toBeTruthy();

    const res = await b.ingestAnnounce(frame);
    expect(res.accepted).toBe(true);

    const listed = b.listDiscoveredHives();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      hiveId: 'ash',
      title: 'Ash Hive',
      ownerGithubLogin: 'alice',
      ownerDevicePubkey: a.pubkey,
      attested: true,
    });
  });

  it('B DROPS an announce whose owner it has not attested (independent trust)', async () => {
    const a = peerA();
    const b = peerB(null); // B trusts no one → attestation fails for A
    const [frame] = await a.dir.buildOwnedAnnounces();
    const res = await b.ingestAnnounce(frame);
    expect(res).toEqual({ accepted: false, reason: 'unattested' });
    expect(b.listDiscoveredHives()).toHaveLength(0);
  });

  it('B DROPS a tampered announce (A’s signature no longer covers the bytes)', async () => {
    const a = peerA();
    const b = peerB(a.pubkey);
    const [frame] = await a.dir.buildOwnedAnnounces();
    // A man-in-the-middle rewrites the title after A signed it.
    const tampered = { ...frame, title: 'Evil Hive' };
    const res = await b.ingestAnnounce(tampered);
    expect(res.reason).toBe('bad-signature-or-stale');
    expect(b.listDiscoveredHives()).toHaveLength(0);
  });

  it('B DROPS a spoofed announce signed by a DIFFERENT key than its claimed owner', async () => {
    const a = peerA();
    const attacker = generateKeyPairSync('ed25519');
    const b = peerB(a.pubkey);
    const [frame] = await a.dir.buildOwnedAnnounces();
    // Re-sign A's body with the attacker's key but keep A's claimed pubkey.
    const { sig: _drop, ...body } = frame;
    const { hiveAnnounceSigningBytes } = await import('./sync/hyperbee/hive-announce');
    const forged = {
      ...body,
      sig: nodeSign(null, hiveAnnounceSigningBytes(body), attacker.privateKey).toString('base64'),
    };
    const res = await b.ingestAnnounce(forged);
    expect(res.reason).toBe('bad-signature-or-stale');
  });

  it('B applies LWW across re-announces — a same/older-ts re-feed is superseded, not re-applied', async () => {
    const a = peerA();
    const b = peerB(a.pubkey);
    const [v1] = await a.dir.buildOwnedAnnounces();
    expect((await b.ingestAnnounce(v1)).accepted).toBe(true);
    // The same frame arriving again (gossip duplicate / a stale re-broadcast) is
    // dropped by the ts guard — B's record is not churned.
    expect(await b.ingestAnnounce(v1)).toEqual({ accepted: false, reason: 'superseded' });
    expect(b.listDiscoveredHives()).toHaveLength(1);
    expect(b.listDiscoveredHives()[0].title).toBe('Ash Hive');
  });
});
