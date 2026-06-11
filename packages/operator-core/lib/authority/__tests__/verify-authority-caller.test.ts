/**
 * Unit tests for the EI-322 receiving-side caller verifier: the three gates
 * (signature+freshness, holderPubkey binding, revocation) and the fail-open
 * posture on an unreadable revocation store.
 */
import { describe, expect, it } from 'vitest';
import { generateEd25519KeypairDer } from '../../identity/ed25519';
import { signAuthorityRpc, signAuthorityRpcWithPrivateKeyDer } from '../authority-rpc-envelope';
import { buildAuthorityCallerVerifier } from '../verify-authority-caller';
import type { AuthorityRpcEnvelope } from '../authority-op-registry';

const NOW = 1_700_000_000_000;

function makeSigner() {
  const { privateKeyDer, pubkeyBase64 } = generateEd25519KeypairDer();
  return { pubkeyBase64, sign: async (b: Buffer) => signAuthorityRpcWithPrivateKeyDer(privateKeyDer, b) };
}

async function signedEnv(
  signer: { pubkeyBase64: string; sign: (b: Buffer) => Promise<Buffer> },
  payload: unknown,
  opts?: { kind?: string },
): Promise<AuthorityRpcEnvelope> {
  const base = { harnessSlug: 'papercup', kind: opts?.kind ?? 'work-item.claim.acquire', payload };
  const auth = await signAuthorityRpc({ ...base, device_pubkey: signer.pubkeyBase64 }, signer.sign, { nowMs: NOW });
  return { ...base, auth };
}

describe('buildAuthorityCallerVerifier', () => {
  it('accepts a valid signed envelope whose holderPubkey matches the signer, returns the proven pubkey', async () => {
    const s = makeSigner();
    const env = await signedEnv(s, { workspaceId: 'ws', holderPubkey: s.pubkeyBase64, workItemId: 'WI-1' });
    const verify = buildAuthorityCallerVerifier({ nowMs: NOW, isRevoked: async () => false });
    const r = await verify(env);
    expect(r).toEqual({ ok: true, devicePubkey: s.pubkeyBase64 });
  });

  it('rejects a missing auth envelope', async () => {
    const verify = buildAuthorityCallerVerifier({ nowMs: NOW });
    const r = await verify({ harnessSlug: 'papercup', kind: 'work-item.claim.acquire', payload: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing/i);
  });

  it('rejects a tampered payload (signature no longer verifies)', async () => {
    const s = makeSigner();
    const env = await signedEnv(s, { workspaceId: 'ws', holderPubkey: s.pubkeyBase64, n: 1 });
    const tampered: AuthorityRpcEnvelope = { ...env, payload: { ...(env.payload as object), n: 2 } };
    const verify = buildAuthorityCallerVerifier({ nowMs: NOW, isRevoked: async () => false });
    const r = await verify(tampered);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/signature/i);
  });

  it('rejects when the op holderPubkey does NOT match the signed device (impersonation)', async () => {
    const s = makeSigner();
    // Caller signs as themselves but claims to hold a lease for a DIFFERENT device.
    const env = await signedEnv(s, { workspaceId: 'ws', holderPubkey: 'someone-elses-pubkey', workItemId: 'WI-1' });
    const verify = buildAuthorityCallerVerifier({ nowMs: NOW, isRevoked: async () => false });
    const r = await verify(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/does not match/i);
  });

  it('refuses a proven-but-revoked device', async () => {
    const s = makeSigner();
    const env = await signedEnv(s, { workspaceId: 'ws', holderPubkey: s.pubkeyBase64 });
    const verify = buildAuthorityCallerVerifier({ nowMs: NOW, isRevoked: async (pk) => pk === s.pubkeyBase64 });
    const r = await verify(env);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/revoked/i);
  });

  it('fails OPEN when the revocation store throws (D-004: unknowable ≠ revoked)', async () => {
    const s = makeSigner();
    const env = await signedEnv(s, { workspaceId: 'ws', holderPubkey: s.pubkeyBase64 });
    const verify = buildAuthorityCallerVerifier({
      nowMs: NOW,
      isRevoked: async () => {
        throw new Error('pg down');
      },
    });
    // A revocation-store error must not reject a validly-signed caller — the
    // verifier owns the fail-open guarantee.
    const r = await verify(env);
    expect(r).toEqual({ ok: true, devicePubkey: s.pubkeyBase64 });
  });

  it('skips the revocation gate when the payload carries no workspaceId (file-lock ops)', async () => {
    const s = makeSigner();
    // A file-lock-shaped payload: no workspaceId, no holderPubkey.
    const env = await signedEnv(s, { path: 'apps/x.ts', mode: 'exclusive' }, { kind: 'lock.acquire' });
    let revCalls = 0;
    const verify = buildAuthorityCallerVerifier({
      nowMs: NOW,
      isRevoked: async () => {
        revCalls++;
        return true;
      },
    });
    const r = await verify(env);
    expect(r).toEqual({ ok: true, devicePubkey: s.pubkeyBase64 });
    expect(revCalls).toBe(0); // never consulted without a scope
  });
});
