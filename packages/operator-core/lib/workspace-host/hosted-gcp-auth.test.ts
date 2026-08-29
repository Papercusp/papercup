import { describe, expect, it, vi } from 'vitest';
import { resolveHostedGcpAuth } from './hosted-gcp-auth';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

function record(method: 'service-account-impersonation' | 'workload-identity' = 'service-account-impersonation'):
  HostedProviderDelegationRecord {
  const source = method === 'service-account-impersonation'
    ? {
        method,
        projectId: 'papercusp-hosted-123',
        serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
        trustedPrincipal: 'principal://control-plane',
      } as const
    : {
        method,
        projectId: 'papercusp-hosted-123', projectNumber: '123456789012', poolId: 'papercusp-hosted',
        providerId: 'papercusp-oidc', serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
        issuer: 'https://app.papercusp.com/oidc', audience: '//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/papercusp-hosted/providers/papercusp-oidc',
        subject: 'workspace:workspace-1',
      } as const;
  return {
    schemaVersion: 'hosted-provider-delegation-v1', workspaceId: 'workspace-1', connectionId: 'connection-1',
    label: 'Hosted GCP', provider: 'gcp', credentialRef: 'delegation://workspace-1/gcp/connection-1/1',
    generation: 1, status: 'verified', configuration: { provider: 'gcp', source }, templateDigest: 'digest',
    createdAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z',
  };
}

/**
 * Credential STAND-INS for the token fixtures below.
 *
 * ⚠ Keep these short and low-entropy, and refer to them by identifier — never
 * inline a descriptive multi-word literal like 'metadata-source-token'. The
 * git-sync commit-time secrets detector's `secret-assignment` rule fires on a
 * credential-named key (`access_token` / `accessToken`) assigned a >=20-char
 * value whose Shannon entropy clears 3.2 bits/char, and ordinary hyphenated
 * English of that length clears it easily. Descriptive literals here quarantined
 * this file out of every commit for ~41h / 149+ ticks (WI-784913).
 *
 * NEVER_EMIT_MARKER is the in-tree convention (six adapter suites use it) for a
 * value asserted NEVER to leak; the conformance check is a plain substring
 * search, so a realistic-looking value buys nothing.
 */
const NEVER_EMIT_MARKER = 'never-emit-me';
const MINTED_TOKEN = 'customer-token';

describe('hosted GCP auth resolver', () => {
  it('mints a short-lived impersonated token from the controller metadata identity without static keys', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith('/token')) return Response.json({ access_token: NEVER_EMIT_MARKER });
      if (url.includes(':generateAccessToken')) return Response.json({ accessToken: MINTED_TOKEN });
      return new Response('unexpected', { status: 500 });
    });
    const delegation = record();
    await expect(resolveHostedGcpAuth({
      credentialRef: delegation.credentialRef,
      provider: { hostedDelegation: delegation },
    }, { fetch: fetchImpl })).resolves.toEqual({
      accessToken: MINTED_TOKEN,
      identity: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
      projectId: 'papercusp-hosted-123',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]![0])).toContain('iamcredentials.googleapis.com');
    expect(String(fetchImpl.mock.calls[1]![1]?.body)).toContain('3600s');
    expect(JSON.stringify(delegation)).not.toContain(NEVER_EMIT_MARKER);
  });

  it('exchanges a metadata identity token through STS before impersonation for workload identity', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.includes('/identity?')) return new Response('metadata-id-token');
      if (url === 'https://sts.googleapis.com/v1/token') return Response.json({ access_token: 'sts-token' });
      if (url.includes(':generateAccessToken')) return Response.json({ accessToken: 'customer-token' });
      return new Response('unexpected', { status: 500 });
    });
    const delegation = record('workload-identity');
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl })).resolves.toMatchObject({ accessToken: 'customer-token' });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('fails closed before network access for a revoked or cross-reference record', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const delegation = { ...record(), status: 'revoked' as const };
    await expect(resolveHostedGcpAuth({ credentialRef: delegation.credentialRef, provider: { hostedDelegation: delegation } },
      { fetch: fetchImpl })).rejects.toThrow('not_verified');
    await expect(resolveHostedGcpAuth({ credentialRef: 'delegation://foreign', provider: { hostedDelegation: record() } },
      { fetch: fetchImpl })).rejects.toThrow('reference_mismatch');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
