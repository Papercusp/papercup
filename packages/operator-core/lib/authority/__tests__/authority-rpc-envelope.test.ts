/**
 * Unit tests for the EI-322 authenticated authority-RPC envelope: the Ed25519
 * signature roundtrip, freshness window, canonical-form determinism, and the
 * tamper/replay rejections.
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import {
  signAuthorityRpc,
  verifyAuthorityRpc,
  signAuthorityRpcWithPrivateKeyDer,
  canonicalJson,
  authorityRpcSigningBytes,
  DEFAULT_AUTHORITY_RPC_WINDOW_MS,
} from '../authority-rpc-envelope';

const NOW = 1_700_000_000_000;

function makeSigner() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return {
    pubkeyBase64,
    sign: async (bytes: Buffer) => signAuthorityRpcWithPrivateKeyDer(privateKeyDer, bytes),
  };
}

const op = { harnessSlug: 'papercup', kind: 'work-item.claim.acquire', payload: { workItemId: 'WI-1', holderPubkey: 'h', n: 3 } };

describe('authority-rpc-envelope — sign/verify roundtrip', () => {
  it('a freshly signed envelope verifies against its own pubkey + op fields', async () => {
    const s = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    expect(auth.device_pubkey).toBe(s.pubkeyBase64);
    expect(typeof auth.nonce).toBe('string');
    expect(verifyAuthorityRpc(op, auth, { nowMs: NOW })).toBe(true);
  });

  it('rejects a tampered PAYLOAD (sig covers the op fields)', async () => {
    const s = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    const tampered = { ...op, payload: { ...op.payload, n: 4 } };
    expect(verifyAuthorityRpc(tampered, auth, { nowMs: NOW })).toBe(false);
  });

  it('rejects a tampered KIND and a tampered harnessSlug', async () => {
    const s = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    expect(verifyAuthorityRpc({ ...op, kind: 'work-item.claim.release' }, auth, { nowMs: NOW })).toBe(false);
    expect(verifyAuthorityRpc({ ...op, harnessSlug: 'evil' }, auth, { nowMs: NOW })).toBe(false);
  });

  it('rejects a swapped device_pubkey (sig no longer matches the asserted key)', async () => {
    const s = makeSigner();
    const other = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    expect(verifyAuthorityRpc(op, { ...auth, device_pubkey: other.pubkeyBase64 }, { nowMs: NOW })).toBe(false);
  });

  it('rejects a stale ts (past the freshness window) and a future ts', async () => {
    const s = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    expect(verifyAuthorityRpc(op, auth, { nowMs: NOW + DEFAULT_AUTHORITY_RPC_WINDOW_MS + 1 })).toBe(false);
    expect(verifyAuthorityRpc(op, auth, { nowMs: NOW - DEFAULT_AUTHORITY_RPC_WINDOW_MS - 1 })).toBe(false);
    // within window still verifies
    expect(verifyAuthorityRpc(op, auth, { nowMs: NOW + DEFAULT_AUTHORITY_RPC_WINDOW_MS - 1 })).toBe(true);
  });

  it('rejects a tampered ts even inside the window (ts is signed)', async () => {
    const s = makeSigner();
    const auth = await signAuthorityRpc({ ...op, device_pubkey: s.pubkeyBase64 }, s.sign, { nowMs: NOW });
    const bumped = { ...auth, ts: auth.ts + 1 };
    expect(verifyAuthorityRpc(op, bumped, { nowMs: NOW })).toBe(false);
  });

  it('rejects undefined / malformed auth without throwing', () => {
    expect(verifyAuthorityRpc(op, undefined, { nowMs: NOW })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyAuthorityRpc(op, { device_pubkey: 'x', ts: NOW, nonce: 'n', sig: 'not-b64!!' } as any, { nowMs: NOW })).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(verifyAuthorityRpc(op, { device_pubkey: 'short', ts: NOW, nonce: 'n', sig: '' } as any, { nowMs: NOW })).toBe(false);
  });
});

describe('authority-rpc-envelope — canonicalJson determinism', () => {
  it('is independent of object key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2, c: { y: 1, x: 2 } })).toBe(canonicalJson({ c: { x: 2, y: 1 }, a: 2, b: 1 }));
  });

  it('preserves array order and drops undefined object values (JSON parity)', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson(null)).toBe('null');
  });

  it('signing bytes equal across a JSON round-trip of the payload (wire-parity)', () => {
    const a = authorityRpcSigningBytes({ ...op, device_pubkey: 'k', ts: NOW, nonce: 'n' });
    const roundTripped = JSON.parse(JSON.stringify(op.payload));
    const b = authorityRpcSigningBytes({ ...op, payload: roundTripped, device_pubkey: 'k', ts: NOW, nonce: 'n' });
    expect(a.equals(b)).toBe(true);
  });
});
