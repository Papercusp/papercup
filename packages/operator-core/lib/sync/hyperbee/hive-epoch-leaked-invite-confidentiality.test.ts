/**
 * hive-epoch-leaked-invite-confidentiality.test — the GA confidentiality guarantee
 * for the OUTER gate (shared-hive public-release readiness, security-review note #1:
 * "a leaked invite is contained by the epoch-key layer").
 *
 * This is the STRANGER case, and it is DISTINCT from the removed-member cut-off that
 * `hive-epoch-crypto-impl.test.ts` already locks:
 *
 *   - Removed member (already tested): WAS a member, held a wrapped key for a PRIOR
 *     epoch, then a boundary advances and they are not wrapped to the NEW epoch.
 *   - Leaked invite / stranger (THIS file): was NEVER a member. The invite link / hive
 *     topic leaked, so they can join the Hyperswarm and replicate the ENTIRE ciphertext
 *     log across ALL epochs, plus every publicly-distributed wrapped-key blob
 *     (`hive_epoch_keys` rows are not secret) — and still decrypt NOTHING, because no
 *     epoch key was ever wrapped to their device and the content key is fresh-random,
 *     independent of the (public) topic/hive id.
 *
 * The security model: the hive topic / invite is a swarm-RENDEZVOUS capability, NOT key
 * material. Confidentiality does not rest on topic secrecy; it rests on per-device
 * sealed-box epoch-key distribution. These tests prove the topic gives replication and
 * nothing more.
 *
 * Harness mirrors hive-epoch-crypto-impl.test.ts exactly: REAL sodium-native crypto with
 * REAL Ed25519 device keys; only the keychain (OS-secret / file I/O) is mocked in-memory
 * so the test is hermetic.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHash } from 'node:crypto';

// Hoisted in-memory keychain backing the mock (vi.mock factories are hoisted).
const { mem } = vi.hoisted(() => ({ mem: new Map<string, Buffer>() }));
const DEVICE_SVC = 'papercusp-device-keypair';

vi.mock('../../identity/keychain', () => ({
  keychainStore: async (id: string, der: Buffer, serviceName: string = DEVICE_SVC) => {
    mem.set(serviceName + ':' + id, Buffer.from(der));
  },
  keychainLoad: async (id: string, serviceName: string = DEVICE_SVC) => {
    const v = mem.get(serviceName + ':' + id);
    return v ? { kind: 'ok', value: v } : { kind: 'error', error: { kind: 'not_found' } };
  },
  keychainDelete: async (id: string, serviceName: string = DEVICE_SVC) => {
    mem.delete(serviceName + ':' + id);
  },
}));

const { createHiveEpochCrypto } = await import('./hive-epoch-crypto-impl');
const { generateEd25519KeypairDer } = await import('../../identity/ed25519');
const { keychainStore } = await import('../../identity/keychain');
import type { EpochKey, OpAAD } from './hive-epoch-crypto';

/** Register a device: fresh Ed25519 keypair, private key in the (mock) keychain. */
async function makeDevice(keychainId: string): Promise<{ keychainId: string; pubkeyBase64: string }> {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer);
  return { keychainId, pubkeyBase64 };
}

const HIVE = 'hive-public-1';
const AD = (epoch: number, opId: string): OpAAD => ({ hiveId: HIVE, epoch, opId });

beforeEach(() => {
  mem.clear();
});

describe('leaked-invite containment — a stranger who learns the topic cannot read content', () => {
  it('a never-member stranger cannot unwrap ANY member wrapped-key blob, across all epochs', async () => {
    const c = createHiveEpochCrypto();
    const alice = await makeDevice('device-alice');
    const bob = await makeDevice('device-bob');
    // The stranger leaked the invite and joined the swarm — a real, registered device,
    // just never a member of THIS hive (never wrapped to).
    const stranger = await makeDevice('device-stranger');

    // Owner mints two epochs of keys and distributes (publicly, via hive_epoch_keys) a
    // wrapped blob to each member for each epoch. The stranger replicates ALL of them.
    const publiclyDistributedBlobs: Uint8Array[] = [];
    for (const epoch of [1, 2]) {
      const key = await c.deriveEpochKey(HIVE, epoch);
      for (const member of [alice, bob]) {
        publiclyDistributedBlobs.push(await c.wrapKeyToMember(key, member.pubkeyBase64));
      }
    }

    // Every wrapped blob is a sealed box addressed to a member's device key. The stranger
    // holds all four but can open none — fail-closed seal_open.
    for (const blob of publiclyDistributedBlobs) {
      await expect(c.unwrapEpochKey(blob, stranger.keychainId)).rejects.toThrow();
    }
    // Sanity: the blobs are NOT garbage — a real member opens its own.
    const aliceKey = await c.unwrapEpochKey(publiclyDistributedBlobs[0], alice.keychainId);
    expect(aliceKey.length).toBe(32);
  });

  it('end-to-end: a stranger replicates the full multi-epoch ciphertext log but decrypts nothing; an invited member reads it', async () => {
    const c = createHiveEpochCrypto();
    const member = await makeDevice('device-member');
    const stranger = await makeDevice('device-stranger');

    // Two epochs of real content the owner published, each AEAD-bound to (hive, epoch, op).
    const log: Array<{ ad: OpAAD; ciphertext: Uint8Array; wrappedForMember: Uint8Array }> = [];
    for (const [epoch, secret] of [[1, 'epoch-1 secret plan'], [2, 'epoch-2 secret plan']] as const) {
      const key = await c.deriveEpochKey(HIVE, epoch);
      const ad = AD(epoch, `plans:p${epoch}:owner`);
      log.push({
        ad,
        ciphertext: await c.encryptOp(Buffer.from(secret), key, ad),
        wrappedForMember: await c.wrapKeyToMember(key, member.pubkeyBase64),
      });
    }

    // Invited member: unwrap → decrypt → reads BOTH epochs (proves content is genuinely
    // readable by a wrapped device, so a stranger's failure below is not vacuous).
    for (const [i, secret] of ['epoch-1 secret plan', 'epoch-2 secret plan'].entries()) {
      const key = await c.unwrapEpochKey(log[i].wrappedForMember, member.keychainId);
      expect(Buffer.from(await c.decryptOp(log[i].ciphertext, key, log[i].ad)).toString()).toBe(secret);
    }

    // Stranger: holds the entire replicated log (ciphertext + the member's wrapped blobs)
    // but cannot obtain any epoch key, so cannot decrypt any entry.
    for (const entry of log) {
      await expect(c.unwrapEpochKey(entry.wrappedForMember, stranger.keychainId)).rejects.toThrow();
    }
  });

  it('knowing the public topic/hive id yields no usable key: a topic-derived guess cannot decrypt', async () => {
    const c = createHiveEpochCrypto();
    const epoch = 1;
    const key = await c.deriveEpochKey(HIVE, epoch);
    const ad = AD(epoch, 'plans:p1:owner');
    const ciphertext = await c.encryptOp(Buffer.from('topic is not key material'), key, ad);

    // The attacker knows everything PUBLIC about the hive — its id/topic and the epoch —
    // and tries the obvious naive derivation a weaker design might have used (a KDF from
    // the public hive id). Because the real key is fresh-random and independent of the
    // topic, the guess is just a wrong 32-byte key → fail-closed.
    const topicDerivedGuess = createHash('sha256')
      .update(`${HIVE}:${epoch}`)
      .digest() as unknown as EpochKey;
    await expect(c.decryptOp(ciphertext, topicDerivedGuess, ad)).rejects.toThrow();
  });

  it('the content key is NOT a deterministic function of the public (hive id, epoch): an independent mint of the SAME inputs differs', async () => {
    // Mint a key for (hive, epoch) with ONE storage backing, record it, then simulate a
    // second independent owner with NO shared storage (clear the keychain) and mint again
    // for the IDENTICAL public inputs. If the key were derived from the public topic/epoch
    // the two would match — and a stranger who knows the topic could recompute it. Because
    // each mint is fresh-random, they differ: the public (hive id, epoch) carries zero key
    // entropy.
    const c = createHiveEpochCrypto();
    const first = Buffer.from(await c.deriveEpochKey(HIVE, 7));
    mem.clear(); // independent owner: no access to the first owner's stored key
    const second = Buffer.from(await c.deriveEpochKey(HIVE, 7));
    expect(first.length).toBe(32);
    expect(first.equals(second)).toBe(false);
  });
});
