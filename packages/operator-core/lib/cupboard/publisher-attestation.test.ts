/**
 * Channel-2 publisher attestation (relocated with the module from the retired
 * per-harness publish route — comb-retire-per-harness-sharing-2026-06-11 P-006).
 * Best-effort contract: success returns gist id + pubkey; ANY failure → null.
 */

import { describe, expect, it } from 'vitest';
import { resolvePublisherAttestation, type AttestationDeps } from './publisher-attestation';

describe('resolvePublisherAttestation (item 1)', () => {
  function deps(over: Partial<AttestationDeps> = {}): Partial<AttestationDeps> {
    return {
      resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice', token: 'tok' }),
      keychainIdFor: () => 'kc-1',
      loadKeypair: async () => ({ pubkeyBase64: 'PK' }),
      ensureGist: async () => 'gist123',
      ...over,
    };
  }

  it('returns gist id + pubkey on success', async () => {
    const r = await resolvePublisherAttestation(deps());
    expect(r).toEqual({ attestation_gist_id: 'gist123', publisher_device_pubkey: 'PK' });
  });

  it('returns null when gh auth is required (best-effort skip)', async () => {
    const r = await resolvePublisherAttestation(deps({ resolveIdentity: async () => ({ kind: 'gh_auth_required' }) }));
    expect(r).toBeNull();
  });

  it('returns null when the identity lacks a token', async () => {
    const r = await resolvePublisherAttestation(
      deps({ resolveIdentity: async () => ({ kind: 'ok', githubUserId: 1, githubLogin: 'alice' }) }),
    );
    expect(r).toBeNull();
  });

  it('never throws — returns null when gist resolution fails', async () => {
    const r = await resolvePublisherAttestation(
      deps({ ensureGist: async () => { throw new Error('gist api down'); } }),
    );
    expect(r).toBeNull();
  });
});
