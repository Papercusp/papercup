/**
 * verdicts.test.ts — DG-1 (P-044) pure verdict-fact tests: sign/verify
 * roundtrip, tamper detection, content-address behavior. Real ed25519 keys
 * (generateEd25519KeypairDer), no PG/git/network.
 */
import { describe, expect, it } from 'vitest';
import {
  generateEd25519KeypairDer,
  signWithPrivateKeyDer,
} from '../../../identity/ed25519';
import {
  GATE_VERDICT_SCHEMA_VERSION,
  gateVerdictId,
  gateVerdictSigningBytes,
  isGateVerdict,
  signGateVerdict,
  verifyGateVerdict,
  verifyGateVerdictWithId,
  type GateVerdict,
} from './verdicts';

const dev = generateEd25519KeypairDer();
const sign = async (bytes: Buffer) => signWithPrivateKeyDer(dev.privateKeyDer, bytes);

const FIELDS = {
  repoKey: 'repo-42',
  stagingSha: 'a'.repeat(40),
  shardId: '@t/a::unit',
  inputsHash: 'b'.repeat(64),
  verdict: 'pass' as const,
  durationMs: 12_345,
  devicePubkeyBase64: dev.pubkeyBase64,
  nowMs: 1_700_000_000_000,
};

describe('gate verdict facts (DG-1)', () => {
  it('sign → verify roundtrip; shape guard accepts', async () => {
    const v = await signGateVerdict(FIELDS, sign);
    expect(v.v).toBe(GATE_VERDICT_SCHEMA_VERSION);
    expect(isGateVerdict(v)).toBe(true);
    expect(verifyGateVerdict(v)).toBe(true);
    expect(verifyGateVerdictWithId(v, gateVerdictId(v))).toBe(true);
  });

  it('any tampered signed field breaks verification', async () => {
    const v = await signGateVerdict(FIELDS, sign);
    const tampered: GateVerdict[] = [
      { ...v, verdict: 'fail' }, // the classic forgery: flip the outcome
      { ...v, staging_sha: 'c'.repeat(40) },
      { ...v, shard_id: '@t/b::unit' },
      { ...v, inputs_hash: 'd'.repeat(64) },
      { ...v, repo_key: 'other-repo' },
      { ...v, duration_ms: 1 },
      { ...v, ts: v.ts + 1 },
      { ...v, device_pubkey: generateEd25519KeypairDer().pubkeyBase64 }, // re-attributed
    ];
    for (const t of tampered) expect(verifyGateVerdict(t), JSON.stringify(t)).toBe(false);
    // garbled signature
    expect(verifyGateVerdict({ ...v, sig: Buffer.from('nope').toString('base64') })).toBe(false);
  });

  it('content address covers every signed field and excludes the sig', async () => {
    const v = await signGateVerdict(FIELDS, sign);
    const id = gateVerdictId(v);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    // same payload → same id, regardless of sig bytes
    expect(gateVerdictId({ ...v, sig: 'ignored' } as GateVerdict)).toBe(id);
    // every field change re-addresses
    expect(gateVerdictId({ ...v, verdict: 'fail' })).not.toBe(id);
    expect(gateVerdictId({ ...v, shard_id: 'x::unit' })).not.toBe(id);
    expect(gateVerdictId({ ...v, inputs_hash: 'e'.repeat(64) })).not.toBe(id);
    expect(gateVerdictId({ ...v, ts: v.ts + 1 })).not.toBe(id);
    // a tampered row can never pass under the HONEST row's id
    expect(verifyGateVerdictWithId({ ...v, verdict: 'fail' }, id)).toBe(false);
  });

  it('signing bytes are domain-tagged and field-order-stable', async () => {
    const v = await signGateVerdict(FIELDS, sign);
    const bytes = gateVerdictSigningBytes(v).toString('utf8');
    expect(bytes.startsWith('papercusp-hive-git-gate-verdict-v1\n')).toBe(true);
    // key order is FIXED by the composer, not the input object
    const reordered = { ts: v.ts, sig: v.sig, ...v };
    expect(gateVerdictSigningBytes(reordered).equals(gateVerdictSigningBytes(v))).toBe(true);
  });

  it('shape guard rejects malformed inputs', async () => {
    const v = await signGateVerdict(FIELDS, sign);
    expect(isGateVerdict(null)).toBe(false);
    expect(isGateVerdict({})).toBe(false);
    expect(isGateVerdict({ ...v, verdict: 'maybe' })).toBe(false);
    expect(isGateVerdict({ ...v, staging_sha: 'not-a-sha' })).toBe(false);
    expect(isGateVerdict({ ...v, inputs_hash: 'short' })).toBe(false);
    expect(isGateVerdict({ ...v, repo_key: '' })).toBe(false);
    expect(isGateVerdict({ ...v, duration_ms: Number.NaN })).toBe(false);
  });
});
