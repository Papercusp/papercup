/**
 * staging-advance.test.ts — G-5d epoch fencing, the PURE core (P-038).
 * Acceptance pinned here: a lower/equal (epoch, seq) is rejected, a valid
 * strictly-higher one is accepted, a bad signature is rejected. No git needed.
 *
 * Run: cd packages/operator-core && npx vitest run lib/sync/pot-git/staging-advance.test.ts
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
import { makeSignedProtocolContext } from './signed-context';

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
    expect(acceptStagingAdvance(await advance(kp, 2, 6), prior, { allowLegacy: true })).toEqual({ ok: true });
    // Higher epoch, seq resets.
    expect(acceptStagingAdvance(await advance(kp, 3, 0), prior, { allowLegacy: true })).toEqual({ ok: true });
    // Equal → replay, rejected.
    expect(acceptStagingAdvance(await advance(kp, 2, 5), prior, { allowLegacy: true })).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // Lower seq, same epoch → stale.
    expect(acceptStagingAdvance(await advance(kp, 2, 4), prior, { allowLegacy: true })).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // Lower epoch with a huge seq → STILL stale (epoch dominates — this is the
    // late advance from a fenced ex-authority).
    expect(acceptStagingAdvance(await advance(kp, 1, 999), prior, { allowLegacy: true })).toEqual({ ok: false, reason: 'stale-epoch-seq' });
    // No prior → anything valid is accepted.
    expect(acceptStagingAdvance(await advance(kp, 0, 0), null, { allowLegacy: true })).toEqual({ ok: true });
  });

  it('rejects a bad signature and a forged device', async () => {
    const kp = keypair();
    const forger = keypair();
    const adv = await advance(kp, 3, 1);
    // Corrupt the sig.
    expect(acceptStagingAdvance({ ...adv, sig: Buffer.alloc(64).toString('base64') }, null, { allowLegacy: true })).toEqual({
      ok: false,
      reason: 'bad-signature',
    });
    // Forger signs a payload claiming the integrator's device.
    const forged = await signStagingAdvance(
      { devicePubkeyBase64: kp.pubkeyBase64, epoch: 9, seq: 0, stagingSha: SHA_A, nowMs: 1 },
      forger.sign,
    );
    expect(acceptStagingAdvance(forged, null, { allowLegacy: true })).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('gates the embedded device via expectedDevice / allowedDevices', async () => {
    const kp = keypair();
    const other = keypair();
    const adv = await advance(kp, 1, 1);
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true, expectedDevice: kp.pubkeyBase64 })).toEqual({ ok: true });
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true, expectedDevice: other.pubkeyBase64 })).toEqual({
      ok: false,
      reason: 'wrong-device',
    });
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true, allowedDevices: [other.pubkeyBase64, kp.pubkeyBase64] })).toEqual({
      ok: true,
    });
    expect(acceptStagingAdvance(adv, null, { allowLegacy: true, allowedDevices: [other.pubkeyBase64] })).toEqual({
      ok: false,
      reason: 'wrong-device',
    });
  });

  it('rejects malformed envelopes (negative/non-integer epoch or seq, bad sha)', async () => {
    const kp = keypair();
    const adv = await advance(kp, 1, 1);
    expect(acceptStagingAdvance({ ...adv, epoch: -1 }, null, { allowLegacy: true })).toEqual({ ok: false, reason: 'malformed' });
    expect(acceptStagingAdvance({ ...adv, seq: 1.5 }, null, { allowLegacy: true })).toEqual({ ok: false, reason: 'malformed' });
    expect(acceptStagingAdvance({ ...adv, staging_sha: 'not-a-sha' }, null, { allowLegacy: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
    expect(acceptStagingAdvance(null as unknown as SignedStagingAdvance, null, { allowLegacy: true })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('binds context in v2 and rejects a valid signature from another repository or legacy peer', async () => {
    const kp = keypair();
    const context = makeSignedProtocolContext('hive-a', 'gh-1', 'sg2-1-' + 'a'.repeat(40));
    const adv = await signStagingAdvance(
      { devicePubkeyBase64: kp.pubkeyBase64, epoch: 1, seq: 1, stagingSha: SHA_A, nowMs: 1_000, context },
      kp.sign,
    );
    expect(verifyStagingAdvance(adv)).toBe(true);
    expect(acceptStagingAdvance(adv, null, { expectedContext: context, allowLegacy: false })).toEqual({ ok: true });
    expect(acceptStagingAdvance(adv, null, { expectedContext: { ...context, hive_id: 'hive-b' } })).toEqual({
      ok: false,
      reason: 'context-mismatch',
    });
    const legacy = await advance(kp, 1, 1);
    expect(acceptStagingAdvance(legacy, null, { expectedContext: context, allowLegacy: false })).toEqual({
      ok: false,
      reason: 'legacy-version',
    });
  });

  describe('WI-1560 — maxGrantedEpoch caps insider watermark poisoning', () => {
    it('REGRESSION: an ADMITTED member claiming a max epoch is rejected ungranted-epoch', async () => {
      const authority = keypair();
      const insider = keypair();
      const members = [authority.pubkeyBase64, insider.pubkeyBase64];
      const prior = { epoch: 2, seq: 5 };

      // The insider self-signs an absurd epoch over the current sha. Without
      // the cap this was ACCEPTED (member set passes, sig is self-consistent,
      // (1e9, 0) > (2, 5)) — poisoning the watermark unrecoverably.
      const poison = await advance(insider, 1_000_000_000, 0);
      expect(acceptStagingAdvance(poison, prior, { allowLegacy: true, allowedDevices: members })).toEqual({ ok: true }); // the documented hole
      expect(
        acceptStagingAdvance(poison, prior, { allowLegacy: true, allowedDevices: members, maxGrantedEpoch: 2 }),
      ).toEqual({ ok: false, reason: 'ungranted-epoch' });

      // Legitimate advances at/below the granted epoch still pass.
      expect(
        acceptStagingAdvance(await advance(authority, 2, 6), prior, { allowLegacy: true,
          allowedDevices: members,
          maxGrantedEpoch: 2,
        }),
      ).toEqual({ ok: true });
    });

    it('an epoch BUMP passes only once the receiver has raised the grant (handoff adopted)', async () => {
      const authority = keypair();
      const prior = { epoch: 2, seq: 5 };
      const bumped = await advance(authority, 3, 0);
      // Before the receiver verifies the G-0 handoff, epoch 3 is ungranted…
      expect(
        acceptStagingAdvance(bumped, prior, { allowLegacy: true, allowedDevices: [authority.pubkeyBase64], maxGrantedEpoch: 2 }),
      ).toEqual({ ok: false, reason: 'ungranted-epoch' });
      // …after adopting the token (nextEpoch = 3) it is granted and accepted.
      expect(
        acceptStagingAdvance(bumped, prior, { allowLegacy: true, allowedDevices: [authority.pubkeyBase64], maxGrantedEpoch: 3 }),
      ).toEqual({ ok: true });
    });

    it('within-epoch seq poisoning stays RECOVERABLE: the next granted epoch beats any seq', async () => {
      const authority = keypair();
      const insider = keypair();
      const members = [authority.pubkeyBase64, insider.pubkeyBase64];

      // The worst an insider can do under the cap: burn the seq space of the
      // CURRENT epoch.
      const seqPoison = await advance(insider, 2, 1_000_000_000);
      expect(
        acceptStagingAdvance(seqPoison, { epoch: 2, seq: 5 }, { allowLegacy: true, allowedDevices: members, maxGrantedEpoch: 2 }),
      ).toEqual({ ok: true });

      // The real authority recovers at the NEXT epoch grant: (3, 0) > (2, 1e9).
      const recovered = await advance(authority, 3, 0);
      expect(
        acceptStagingAdvance(recovered, { epoch: 2, seq: 1_000_000_000 }, { allowLegacy: true,
          allowedDevices: members,
          maxGrantedEpoch: 3,
        }),
      ).toEqual({ ok: true });
    });

    it('expectedDevice mode composes with the cap (rejects even the pinned authority past the grant)', async () => {
      const authority = keypair();
      const over = await advance(authority, 9, 0);
      expect(
        acceptStagingAdvance(over, null, { allowLegacy: true, expectedDevice: authority.pubkeyBase64, maxGrantedEpoch: 8 }),
      ).toEqual({ ok: false, reason: 'ungranted-epoch' });
      expect(
        acceptStagingAdvance(over, null, { allowLegacy: true, expectedDevice: authority.pubkeyBase64, maxGrantedEpoch: 9 }),
      ).toEqual({ ok: true });
    });
  });
});
