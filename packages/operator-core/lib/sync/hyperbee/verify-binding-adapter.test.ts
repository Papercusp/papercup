/**
 * verify-binding-adapter.test.ts — the read-admission binding gate.
 *
 * Write-free join (`non-collaborator-join-fork-pr-2026-06-02`): admission proves
 * a peer's binding from the attestation GIST carried on the signed announce —
 * `verifyAttestation(attestationGistId, devicePubkey, githubUserId)` — with NO
 * shared-repo contributor-file read and NO repo write at join. The gist is
 * public, so the adapter needs no repo/owner/token context.
 *
 * These tests stub `verifyAttestation` and assert ONLY the mapping:
 *   valid → 'verified'
 *   github_api_unavailable (our transient network) → 'pending' (retryable)
 *   everything else conclusive (gist gone / owner mismatch / pubkey mismatch /
 *     bad sig / body invalid) → 'fail'
 *   missing gist id on the announce → 'fail' without calling verifyAttestation
 *   a thrown verifyAttestation → 'pending' (fail-open, transient)
 * plus: (gistId, devicePubkey, githubUserId) are threaded into verifyAttestation.
 */

import { describe, it, expect, vi } from 'vitest';
import { buildVerifyBindingAdapter } from './verify-binding-adapter';
import type { AttestationVerificationResult } from '../../identity/attestation-types';

function adapterWith(result: AttestationVerificationResult) {
  const verifyAttestationImpl = vi.fn(async () => result);
  const verifyBinding = buildVerifyBindingAdapter({ verifyAttestationImpl });
  return { verifyBinding, verifyAttestationImpl };
}

describe('buildVerifyBindingAdapter (gist-based admission)', () => {
  it("valid attestation → 'verified'", async () => {
    const { verifyBinding } = adapterWith({ valid: true, verifiedAt: 0, resolvedGithubUserId: 42 });
    expect(await verifyBinding('pk', 'alice', 42, 'gist-1')).toBe('verified');
  });

  it("github_api_unavailable → 'pending' (retryable, fail-open)", async () => {
    const { verifyBinding } = adapterWith({ valid: false, reason: 'github_api_unavailable', verifiedAt: 0 });
    expect(await verifyBinding('pk', 'alice', 42, 'gist-1')).toBe('pending');
  });

  it("gist_not_found → 'fail' (revocation signal)", async () => {
    const { verifyBinding } = adapterWith({ valid: false, reason: 'gist_not_found', verifiedAt: 0 });
    expect(await verifyBinding('pk', 'alice', 42, 'gist-1')).toBe('fail');
  });

  it("github_user_id_mismatch (forgery) → 'fail'", async () => {
    const { verifyBinding } = adapterWith({ valid: false, reason: 'github_user_id_mismatch', verifiedAt: 0 });
    expect(await verifyBinding('pk', 'mallory', 42, 'gist-1')).toBe('fail');
  });

  it("pubkey_mismatch → 'fail'", async () => {
    const { verifyBinding } = adapterWith({ valid: false, reason: 'pubkey_mismatch', verifiedAt: 0 });
    expect(await verifyBinding('pk', 'alice', 42, 'gist-1')).toBe('fail');
  });

  it("missing gist id on the announce → 'fail' without calling verifyAttestation", async () => {
    const { verifyBinding, verifyAttestationImpl } = adapterWith({ valid: true, verifiedAt: 0 });
    expect(await verifyBinding('pk', 'alice', 42, '')).toBe('fail');
    expect(verifyAttestationImpl).not.toHaveBeenCalled();
  });

  it('threads (gistId, devicePubkey, githubUserId) into verifyAttestation', async () => {
    let captured: { gistId: string; pk: string; uid: number } | null = null;
    const verifyAttestationImpl = vi.fn(
      async (gistId: string, pk: string, uid: number): Promise<AttestationVerificationResult> => {
        captured = { gistId, pk, uid };
        return { valid: true, verifiedAt: 0 };
      },
    );
    const verifyBinding = buildVerifyBindingAdapter({ verifyAttestationImpl });
    await verifyBinding('devpk-b64', 'bob', 99, 'gist-xyz');
    expect(captured).toEqual({ gistId: 'gist-xyz', pk: 'devpk-b64', uid: 99 });
  });

  it("a thrown verifyAttestation → 'pending' (fail-open, transient)", async () => {
    const verifyAttestationImpl = vi.fn(async () => {
      throw new Error('network down');
    });
    const verifyBinding = buildVerifyBindingAdapter({ verifyAttestationImpl });
    expect(await verifyBinding('pk', 'alice', 42, 'gist-1')).toBe('pending');
  });
});
