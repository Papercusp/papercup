/**
 * hive-epoch-read-cut-witness — the CONTENT-ENCRYPTION read-cut witness that gates the
 * PROD `papercusp-hive-rekey` flip (B10 / WI-560, shared-hive-rekey-2026-06-19).
 *
 * WHY THIS TEST EXISTS (the gap it closes). Three layers were already proven separately:
 *   - the CRYPTO PRIMITIVE (hive-epoch-crypto-impl.test) — AEAD round-trip + a removed
 *     device's seal_open fails;
 *   - the OP GATE (hive-epoch-op-gate.test) — defer/drop/passthrough, but with a FAKE
 *     crypto and a KEY_MISSING resolver (pure key-DENIAL);
 *   - the BOUNDARY (hive-epoch-boundary-wiring.test) — advance-and-wrap-to-remaining.
 *
 * None of them drove the REAL XChaCha20-Poly1305 + sealed-box crypto THROUGH the
 * production op-path (encrypt-on-write capability → the federated op a peer replicates →
 * decrypt-on-read gate + the member EpochKeyProvider) across the full re-key lifecycle.
 * That composition is exactly what the live 2-machine witness (WI-560, blocked on the
 * fed-a→fed-b federation fix WI-559) would prove on the binary — and it is what the owner
 * named as the missing release gate (WI-560 post 47255): today's key-layer K-CUT proves a
 * revoked device is DENIED THE KEY, but the prod flip also needs proof that a revoked
 * member "reads CIPHERTEXT it cannot decrypt (not just lacks the key)". This is the
 * hermetic, test-context witness of that end-to-end content read-cut.
 *
 * TEST-CONTEXT FLAG FLIP (no global flip; no exclusive window consumed). The prod
 * `papercusp-hive-rekey` flag is GLOBAL — flipping it is owner-gated + serialized against
 * B2–B9. This witness instead flips the flag AT THE CALL SITE: `resolveHiveEpochCrypto(true)`
 * is the exact code path the prod flip enables (the real crypto), and `(false)` is the
 * fail-closed stub the dark default ships. We never touch the PostHog flag, so this runs
 * green without the global exclusive window — it is the EVIDENCE the owner ratifies the
 * flip against, not the flip itself.
 *
 * THE WITNESSED SEQUENCE (K0 → K1 → K-revoke → K-CUT), all on the REAL crypto + the REAL
 * op-path:
 *   K0       owner admits members B (later revoked) + C (remains); wraps epoch-1 key to
 *            both; writes content-0. Both B and C replicate the ciphertext op and decrypt.
 *            (The ladder starts at epoch 1 — epoch 0 is the plaintext BASELINE and is
 *            never encrypted, per the WI-2102 BASELINE_EPOCH model.)
 *   K1       owner re-keys to epoch 2 (benign), wraps to both; writes content-1. Both read.
 *   K-revoke owner revokes B → advances to epoch 3, wraps to C ONLY (B excluded); writes
 *            content-2.
 *   K-CUT    C decrypts content-2. B REPLICATES the identical ciphertext op but (a) the
 *            decrypt gate defers it forever (no epoch-3 key row will ever arrive), AND
 *            (b) the bytes are cryptographically unreadable — B's only held key (epoch 2)
 *            fails the real AEAD against the epoch-3 ciphertext. B still reads the OLD
 *            epoch-2 content it legitimately holds (forward-cut, not retroactive).
 *
 * Hermetic: REAL sodium-native crypto + REAL Ed25519 device keys; only the keychain
 * (OS-secret/file I/O) is mocked in-memory, and the federated `hive_epoch_keys` table is
 * an in-memory map. No PG, no Docker, no boot.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

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

import {
  buildEpochEncryptCapability,
  buildEpochDecryptGate,
  buildEpochKeyResolver,
} from './hive-epoch-op-gate';
import { resolveHiveEpochCrypto, decryptOpPayload, type OpIdentity } from './hive-epoch-serving';
import { createEpochKeyProvider, type WrappedKeyLoader } from './hive-epoch-key-provider';
import { PendingEpochContent } from './pending-epoch-content';
import type { HiveEpochCrypto } from './hive-epoch-crypto';
import type { OpEnvelope } from './op-envelope-types';
import type { LocalWriteOp } from './boot';

const { keychainStore } = await import('../../identity/keychain');
const { generateEd25519KeypairDer } = await import('../../identity/ed25519');

const HIVE = 'fixawitness-hive'; // potId = the hive HOME slug (deriveEpochKey + OpAAD id).
const TABLE = 'harness-features';

interface Device {
  keychainId: string;
  pubkeyBase64: string;
}

/** Register a device: fresh Ed25519 keypair, private key in the (mock) keychain. */
async function makeDevice(keychainId: string): Promise<Device> {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  await keychainStore(keychainId, privateKeyDer);
  return { keychainId, pubkeyBase64 };
}

/** In-memory `hive_epoch_keys` (the P-005 federated wrapped-key table), hermetic. */
function makeWrappedStore() {
  const rows = new Map<string, Uint8Array>(); // `${epoch}|${pubkey}` -> sealed blob
  const k = (epoch: number, pubkey: string) => `${epoch}|${pubkey}`;
  return {
    put: (epoch: number, pubkey: string, blob: Uint8Array) => rows.set(k(epoch, pubkey), blob),
    has: (epoch: number, pubkey: string) => rows.has(k(epoch, pubkey)),
    loader: (): WrappedKeyLoader => ({
      load: async (_hiveId, epoch, pubkey) => rows.get(k(epoch, pubkey)) ?? null,
    }),
  };
}

/** Decode the base64 ciphertext carried in an encrypted op's `value.__rekey`. */
function ciphertextOf(enc: { value: unknown }): Uint8Array {
  const wrapper = enc.value as { __rekey?: string };
  expect(typeof wrapper?.__rekey, 'an encrypted op carries a base64 ciphertext wrapper').toBe('string');
  return new Uint8Array(Buffer.from(wrapper.__rekey as string, 'base64'));
}

/** The op identity the encrypt capability seals into the AAD (op.table/hbKey/writerPubkey). */
const opIdentity = (hbKey: string, writerPubkey: string): OpIdentity => ({
  tableTag: TABLE,
  rowKey: hbKey,
  authorPubkey: writerPubkey,
});

beforeEach(() => {
  mem.clear();
});

describe('hive-epoch read-cut witness — K0→K1→K-revoke→K-CUT on the REAL crypto + op-path (B10/WI-560)', () => {
  it('a revoked member replicates ciphertext it CANNOT decrypt (content read-cut, not just key-denial)', async () => {
    // ── flag-ON path: resolveHiveEpochCrypto(true) is exactly what the prod flip enables.
    const crypto: HiveEpochCrypto = await resolveHiveEpochCrypto(true);
    const store = makeWrappedStore();

    const owner = await makeDevice('device-owner');
    const memberB = await makeDevice('device-B-revoked'); // cut off at K-revoke
    const memberC = await makeDevice('device-C-remaining'); // keeps access throughout
    const writerPubkey = owner.pubkeyBase64;

    // OWNER side: derives the epoch key (holds the hive key) and never unwraps.
    const ownerResolveKey = buildEpochKeyResolver({
      crypto,
      provider: { keyForEpoch: async () => { throw new Error('owner never unwraps'); } },
      isOwner: async () => true,
    });

    /** OWNER boundary: advance to `epoch`, wrap the fresh key to the REMAINING members
     *  only (this is the body of advanceEpochAndWrap; the cut comes from who is wrapped to). */
    async function ownerRekeyTo(epoch: number, remaining: Device[]): Promise<void> {
      const key = await crypto.deriveEpochKey(HIVE, epoch);
      for (const m of remaining) {
        store.put(epoch, m.pubkeyBase64, await crypto.wrapKeyToMember(key, m.pubkeyBase64));
      }
    }

    /** OWNER write: encrypt-on-write via the production op-path capability. Returns the
     *  federated op (`{ epoch, value: { __rekey } }`) every peer then replicates. */
    async function ownerWrite(epoch: number, hbKey: string, value: unknown) {
      const cap = buildEpochEncryptCapability({
        crypto,
        resolveKey: ownerResolveKey,
        potId: HIVE,
        getCurrentEpoch: async () => epoch,
      });
      const op: LocalWriteOp = { type: 'put', table: TABLE, hbKey, value, ts: 0, schema_version: 1, writerPubkey };
      const enc = await cap.encryptOp(op);
      expect(enc, 'a content op is selected for encryption').not.toBeNull();
      expect(enc!.epoch).toBe(epoch);
      // It is genuinely encrypted — the federated bytes are NOT the plaintext.
      const ct = ciphertextOf(enc!);
      expect(Buffer.from(ct).toString('utf8')).not.toContain('content-');
      return enc!;
    }

    /** A MEMBER's apply path: the production decrypt gate over the member EpochKeyProvider
     *  (re-unwraps its own wrapped row), plus the pending-epoch-content defer buffer. */
    function memberApplier(dev: Device) {
      const provider = createEpochKeyProvider(crypto, store.loader(), {
        keychainId: dev.keychainId,
        pubkeyBase64: dev.pubkeyBase64,
      });
      const resolveKey = buildEpochKeyResolver({ crypto, provider, isOwner: async () => false });
      const pending = new PendingEpochContent();
      const gate = buildEpochDecryptGate({ crypto, resolveKey, potId: HIVE, pending });
      return {
        provider,
        pending,
        /** Replicate + try to apply a federated op. Returns whether it applied + the
         *  decrypted plaintext (undefined when deferred/dropped). */
        async apply(enc: { epoch: number; value: unknown }, hbKey: string) {
          let plaintext: unknown;
          const env = {
            type: 'put',
            table: TABLE,
            hbKey,
            writerPubkey,
            value: enc.value,
            epoch: enc.epoch,
          } as OpEnvelope;
          const applied = await gate(async (o) => {
            plaintext = o.value;
            return true;
          })(env);
          return { applied, plaintext, pendingSize: pending.size() };
        },
      };
    }

    const beeB = memberApplier(memberB);
    const beeC = memberApplier(memberC);

    // ── K0: both members admitted; epoch-1 key wrapped to both; owner writes content-0.
    // (Ladder starts at epoch 1: epoch 0 is the plaintext BASELINE — buildEpochEncryptCapability
    // returns null there per the WI-2102 BASELINE_EPOCH model, so encryption begins at e1.)
    await ownerRekeyTo(1, [memberB, memberC]);
    const enc0 = await ownerWrite(1, 'F-0', { note: 'content-0' });
    const b0 = await beeB.apply(enc0, 'F-0');
    const c0 = await beeC.apply(enc0, 'F-0');
    expect(b0).toMatchObject({ applied: true, plaintext: { note: 'content-0' }, pendingSize: 0 });
    expect(c0).toMatchObject({ applied: true, plaintext: { note: 'content-0' }, pendingSize: 0 });

    // ── K1: benign re-key to epoch 2, wrapped to both; both still read the new content.
    await ownerRekeyTo(2, [memberB, memberC]);
    const enc1 = await ownerWrite(2, 'F-1', { note: 'content-1' });
    const b1 = await beeB.apply(enc1, 'F-1');
    const c1 = await beeC.apply(enc1, 'F-1');
    expect(b1).toMatchObject({ applied: true, plaintext: { note: 'content-1' } });
    expect(c1).toMatchObject({ applied: true, plaintext: { note: 'content-1' } });

    // ── K-revoke: owner revokes B → advance to epoch 3, wrap to C ONLY (B excluded).
    await ownerRekeyTo(3, [memberC]);
    expect(store.has(3, memberC.pubkeyBase64), 'remaining member C has the epoch-3 key row').toBe(true);
    expect(store.has(3, memberB.pubkeyBase64), 'revoked member B has NO epoch-3 key row — structural forever-cut').toBe(false);
    const enc2 = await ownerWrite(3, 'F-2', { note: 'content-2-secret' });

    // ── K-CUT (remaining): C unwraps epoch-3 + decrypts the post-boundary content.
    const c2 = await beeC.apply(enc2, 'F-2');
    expect(c2).toMatchObject({ applied: true, plaintext: { note: 'content-2-secret' }, pendingSize: 0 });

    // ── K-CUT (revoked): B REPLICATES the identical ciphertext op (it holds the bytes) …
    const ct2 = ciphertextOf(enc2);
    expect(ct2.byteLength, 'B holds the replicated epoch-3 ciphertext bytes').toBeGreaterThan(0);

    // … but the decrypt gate defers it FOREVER — its epoch-3 key row never arrives.
    const b2 = await beeB.apply(enc2, 'F-2');
    expect(b2.applied, 'revoked B cannot apply the epoch-3 op').toBe(false);
    expect(b2.plaintext, 'revoked B never sees plaintext').toBeUndefined();
    expect(b2.pendingSize, 'the op is buffered (deferred forever = the C-001 read cut)').toBe(1);

    // … and the cut is CONTENT-ENCRYPTION, not merely access-denial: B still holds its
    // epoch-2 key, yet that key cannot decrypt the epoch-3 ciphertext under the REAL AEAD.
    const bEpoch1Key = await beeB.provider.keyForEpoch(HIVE, 2); // B legitimately holds this
    await expect(
      decryptOpPayload(crypto, ct2, { potId: HIVE, epoch: 3, id: opIdentity('F-2', writerPubkey) }, bEpoch1Key),
      'B replicates the ciphertext but its only held key (epoch 2) cannot decrypt epoch-3 content',
    ).rejects.toThrow();

    // … and B is NOT retroactively cut — it can still read the OLD epoch-2 content it holds.
    const ct1 = ciphertextOf(enc1);
    const oldPlaintext = await decryptOpPayload(
      crypto,
      ct1,
      { potId: HIVE, epoch: 2, id: opIdentity('F-1', writerPubkey) },
      bEpoch1Key,
    );
    expect(JSON.parse(new TextDecoder().decode(oldPlaintext))).toEqual({ note: 'content-1' });
  });

  it('flag OFF ⇒ resolveHiveEpochCrypto returns the fail-closed stub (no plaintext, no silent no-op)', async () => {
    // The dark default: the op path resolves the notImplemented stub, which REJECTS rather
    // than ever shipping plaintext while claiming a cut. This is what runs until the owner flips.
    const stub: HiveEpochCrypto = await resolveHiveEpochCrypto(false);
    await expect(stub.deriveEpochKey(HIVE, 0)).rejects.toThrow(/not implemented/i);
    await expect(
      stub.encryptOp(new Uint8Array([1, 2, 3]), new Uint8Array(32) as never, { potId: HIVE, epoch: 0, opId: 'x' }),
    ).rejects.toThrow(/not implemented/i);
  });
});
