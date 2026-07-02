/**
 * staging-advance.test.ts — G-5d epoch fencing, the PURE core (P-038).
 * Acceptance pinned here: a lower/equal (epoch, seq) is rejected, a valid
 * strictly-higher one is accepted, a bad signature is rejected. No git needed.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/hive-git/staging-advance.test.ts
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  type SignedStagingAdvance,
  acceptStagingAdvance,
  compareEpochSeq,
  signStagingAdvance,
  verifyStagingAdvance,
} from './staging-advance';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function keypair() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (bytes: Buffer) => signWithPrivateKeyDer(privateKeyDer, bytes) };
}

async function advance(
  kp: ReturnType<typeof keypair>,
  epoch: number,
  seq: number,
  sha = SHA_A,
): Promise<SignedStagingAdvance> {
  return signStagingAdvance({ devicePubkeyBase64: kp.pubkeyBase64, epoch, seq, stagingSha: sha, nowMs: 1_000 }, kp.sign);
}

describe('staging-advance (G-5d epoch fencing, pure)', () => {
  it('signs and verifies round-trip; tampering breaks the signature', async () => {
    const kp = keypair();
    const adv = await advance(kp, 1, 1);
    expect(verifyStagingAdvance(adv)).toBe(true);
    expect(verifyStagingAdvance(adv, kp.pubkeyBase64)).toBe(true);
    // Any field tamper invalidates.
    expect(verifyStagingAdvance({ ...adv, staging_sha: SHA_B })).toBe(false);
    expect(verifyStagingAdvance({ ...adv, epoch: 2 })).toBe(false);
    expect(verifyStagingAdvance({ ...adv, seq: 2 })).toBe(false);
    // Wrong expected device.
    const other = keypair();
    expect(verifyStagingAdvance(adv, other.pubkeyBase64)).toBe(false);
  });

  it('orders (epoch, seq) epoch-first', () => {
    expect(compareEpochSeq({ epoch: 1, seq: 9 }, { epoch: 2, seq: 0 })).toBe(-1);
    expect(compareEpochSeq({ epoch: 2, seq: 0 }, { epoch: 1, seq: 9 })).toBe(1);
    expect(compareEpochSeq({ epoch: 1, seq: 1 }, { epoch: 1, seq: 2 })).toBe(-1);
    expect(compareEpochSeq({ epoch: 1, seq: 2 }, { epoch: 1, seq: 2 })).toBe(0);
  });

  it('accepts a strictly higher (epoch, seq); rejects equal and lower (the stale ex-authority fence)', async () => {
    const kp = keypair();
    const prior = { epoch: 2, seq: 5 };
    // Higher seq, same epoch.
    expect(acceptStagingAdvance(await advance(kp, 2, 6), prior)).toEqual({ ok: true });
    // Higher epoch, seq resets.
    expect(acceptStagingAdvance(await advance(kp, 3, 0), prior)).toEqual({ ok: true });
    // Equal → replay, rejected.
    expect(acceptStagingAdvance(await advance(kp, 2, 5), prior)).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // Lower seq, same epoch → stale.
    expect(acceptStagingAdvance(await advance(kp, 2, 4), prior)).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // Lower epoch with a huge seq → STILL stale (epoch dominates — this is the
    // late advance from a fenced ex-authority).
    expect(acceptStagingAdvance(await advance(kp, 1, 999), prior)).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // No prior → anything valid is accepted.
    expect(acceptStagingAdvance(await advance(kp, 0, 0), null)).toEqual({ ok: true });
  });

  it('rejects a bad signature and a forged device', async () => {
    const kp = keypair();
    const forger = keypair();
    const adv = await advance(kp, 3, 1);
    // Corrupt the sig.
    expect(acceptStagingAdvance({ ...adv, sig: Buffer.alloc(64).toString('base64') }, null)).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    // Forger signs a payload claiming the integrator's device.
    const forged = await signStagingAdvance(
      { devicePubkeyBase64: kp.pubkeyBase64, epoch: 9, seq: 0, stagingSha: SHA_A, nowMs: 1 },
      forger.sign,
    );
    expect(acceptStagingAdvance(forged, null)).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('gates the embedded device via expectedDevice / allowedDevices', async () => {
    const kp = keypair();
    const other = keypair();
    const adv = await advance(kp, 1, 1);
    expect(acceptStagingAdvance(adv, null, { expectedDevice: kp.pubkeyBase64 })).toEqual({ ok: true });
    expect(acceptStagingAdvance(adv, null, { expectedDevice: other.pubkeyBase64 })).toEqual({
      ok: false,
      reason: 'wrong-device',
    });
    expect(acceptStagingAdvance(adv, null, { allowedDevices: [other.pubkeyBase64, kp.pubkeyBase64] })).toEqual({
      ok: true,
    });
    expect(acceptStagingAdvance(adv, null, { allowedDevices: [other.pubkeyBase64] })).toEqual({
      ok: false,
      reason: 'wrong-device',
    });
  });

  it('rejects malformed envelopes (negative/non-integer epoch or seq, bad sha)', async () => {
    const kp = keypair();
    const adv = await advance(kp, 1, 1);
    expect(acceptStagingAdvance({ ...adv, epoch: -1 }, null)).toEqual({ ok: false, reason: 'malformed' });
    expect(acceptStagingAdvance({ ...adv, seq: 1.5 }, null)).toEqual({ ok: false, reason: 'malformed' });
    expect(acceptStagingAdvance({ ...adv, staging_sha: 'not-a-sha' }, null)).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(acceptStagingAdvance(null as unknown as SignedStagingAdvance, null)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});
