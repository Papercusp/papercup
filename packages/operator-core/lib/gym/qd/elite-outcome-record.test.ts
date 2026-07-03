/**
 * elite-outcome-record (F1-6 / P-014, federated-scout-gym, D-005 hole 3) —
 * hermetic tests for the device-signed elite outcome record: sign/verify
 * roundtrip, tamper-evidence (any signed field flips verification + re-addresses),
 * the D-002 eligibility re-check on the SIGNED outcome, and the receive-side
 * elite-binding + anti-spoof (signer must equal the receiver-stamped source; a
 * valid record cannot be replayed onto a different elite).
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer, signWithPrivateKeyDer } from '../../identity/ed25519';
import {
  ELITE_OUTCOME_SCHEMA_VERSION,
  eliteOutcomeRecordId,
  federatableOutcome,
  isEliteOutcomeRecord,
  signEliteOutcome,
  verifyEliteOutcome,
  verifyEliteOutcomeForElite,
  type EliteOutcomeBasis,
  type EliteOutcomeRecord,
} from './elite-outcome-record';

const kp = generateEd25519KeypairDer();
const signWith = (der: Buffer) => async (bytes: Buffer) => signWithPrivateKeyDer(der, bytes);

const baseFields = {
  nicheKey: 'v1:loop/guard/r2/size-m',
  candidateId: 'cand-42',
  sourceHive: 'papercusp',
  outcome: 'won' as const,
  grade: 0,
  fitness: 0.87,
  devicePubkeyBase64: kp.pubkeyBase64,
  nowMs: 1_700_000_000_000,
};

async function mkRecord(over: Partial<typeof baseFields> = {}): Promise<EliteOutcomeRecord> {
  return signEliteOutcome({ ...baseFields, ...over }, signWith(kp.privateKeyDer));
}

describe('signEliteOutcome / verifyEliteOutcome — roundtrip + tamper-evidence', () => {
  it('a freshly signed record verifies against its embedded signer', async () => {
    const rec = await mkRecord();
    expect(rec.v).toBe(ELITE_OUTCOME_SCHEMA_VERSION);
    expect(rec.device_pubkey).toBe(kp.pubkeyBase64);
    expect(verifyEliteOutcome(rec)).toBe(true);
  });

  it('tampering ANY signed field breaks the signature', async () => {
    const rec = await mkRecord();
    expect(verifyEliteOutcome({ ...rec, fitness: 0.99 })).toBe(false);
    expect(verifyEliteOutcome({ ...rec, grade: 5 })).toBe(false);
    expect(verifyEliteOutcome({ ...rec, niche_key: 'v1:loop/guard/r2/size-l' })).toBe(false);
    expect(verifyEliteOutcome({ ...rec, candidate_id: 'cand-99' })).toBe(false);
    expect(verifyEliteOutcome({ ...rec, outcome: 'graded' })).toBe(false);
    expect(verifyEliteOutcome({ ...rec, ts: rec.ts + 1 })).toBe(false);
  });

  it('a record whose device_pubkey is swapped to another key does not verify', async () => {
    const other = generateEd25519KeypairDer();
    // Signed by kp, but claims to be from `other` — sig cannot verify.
    const rec = await mkRecord();
    expect(verifyEliteOutcome({ ...rec, device_pubkey: other.pubkeyBase64 })).toBe(false);
  });

  it('is content-addressed: identical payload → identical id; a tampered field re-addresses', async () => {
    const rec = await mkRecord();
    const { sig, ...payload } = rec;
    void sig;
    const id1 = eliteOutcomeRecordId(payload);
    const id2 = eliteOutcomeRecordId({ ...payload });
    expect(id1).toBe(id2);
    expect(eliteOutcomeRecordId({ ...payload, fitness: 0.88 })).not.toBe(id1);
  });
});

describe('isEliteOutcomeRecord — shape guard', () => {
  it('accepts a well-formed record', async () => {
    expect(isEliteOutcomeRecord(await mkRecord())).toBe(true);
  });
  it('rejects malformed records', async () => {
    const rec = await mkRecord();
    expect(isEliteOutcomeRecord(null)).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, niche_key: '' })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, candidate_id: '' })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, outcome: 'lost' })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, grade: Number.NaN })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, fitness: Number.NaN })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, device_pubkey: '' })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, sig: '' })).toBe(false);
    expect(isEliteOutcomeRecord({ ...rec, niche_key: 'x'.repeat(201) })).toBe(false);
  });
});

describe('federatableOutcome — D-002 rule on the SIGNED outcome', () => {
  it('won ⇒ eligible regardless of grade', () => {
    expect(federatableOutcome({ outcome: 'won', grade: 0 })).toBe(true);
    expect(federatableOutcome({ outcome: 'won', grade: 1 })).toBe(true);
  });
  it('graded ⇒ eligible only at grade>=4', () => {
    expect(federatableOutcome({ outcome: 'graded', grade: 4 })).toBe(true);
    expect(federatableOutcome({ outcome: 'graded', grade: 5 })).toBe(true);
    expect(federatableOutcome({ outcome: 'graded', grade: 3 })).toBe(false);
    expect(federatableOutcome({ outcome: 'graded', grade: 0 })).toBe(false);
  });
});

describe('verifyEliteOutcomeForElite — receive-side binding + anti-spoof', () => {
  const bind = { nicheKey: baseFields.nicheKey, candidateId: baseFields.candidateId };

  it('a valid record bound to its elite + signed by the source device is verified', async () => {
    const rec = await mkRecord();
    expect(verifyEliteOutcomeForElite(rec, { ...bind, expectedDevicePubkey: kp.pubkeyBase64 })).toBe(true);
  });

  it('rejects a record whose niche/candidate does not match the elite (replay guard)', async () => {
    const rec = await mkRecord();
    expect(verifyEliteOutcomeForElite(rec, { nicheKey: 'v1:other/niche/r1/size-s', candidateId: bind.candidateId })).toBe(false);
    expect(verifyEliteOutcomeForElite(rec, { nicheKey: bind.nicheKey, candidateId: 'cand-other' })).toBe(false);
  });

  it('ANTI-SPOOF: rejects when the signer device != the receiver-stamped source', async () => {
    const rec = await mkRecord();
    expect(verifyEliteOutcomeForElite(rec, { ...bind, expectedDevicePubkey: 'some-other-source-device' })).toBe(false);
  });

  it('skips the anti-spoof check only when no source device is supplied', async () => {
    const rec = await mkRecord();
    expect(verifyEliteOutcomeForElite(rec, bind)).toBe(true);
  });

  it('rejects a signed-but-INELIGIBLE outcome (device signed graded:2)', async () => {
    const rec = await mkRecord({ outcome: 'graded', grade: 2 });
    expect(verifyEliteOutcome(rec)).toBe(true); // the signature itself is valid
    expect(verifyEliteOutcomeForElite(rec, { ...bind, expectedDevicePubkey: kp.pubkeyBase64 })).toBe(false); // but not eligible
  });

  it('rejects a non-record / bad signature', async () => {
    expect(verifyEliteOutcomeForElite({ garbage: true }, bind)).toBe(false);
    const rec = await mkRecord();
    expect(verifyEliteOutcomeForElite({ ...rec, sig: Buffer.from('nope').toString('base64') }, bind)).toBe(false);
  });
});
