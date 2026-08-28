/** Short-lived, keyless GCP auth for hosted workspace-provider delegations. */
import type { GcpResolvedAuth } from '../cloud-workspaces/gcp-preflight';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

export interface HostedGcpAuthResolverInput {
  credentialRef: string;
  provider: Readonly<Record<string, unknown>>;
}

export interface HostedGcpAuthResolverDependencies {
  fetch?: typeof fetch;
}

type GcpDelegationRecord = HostedProviderDelegationRecord & {
  configuration: Extract<HostedProviderDelegationRecord['configuration'], { provider: 'gcp' }>;
};

function delegation(input: HostedGcpAuthResolverInput): GcpDelegationRecord {
  const value = input.provider.hostedDelegation as HostedProviderDelegationRecord | undefined;
  if (!value || value.schemaVersion !== 'hosted-provider-delegation-v1') {
    throw new Error('gcp_workspace_host_hosted_delegation_metadata_missing');
  }
  if (value.provider !== 'gcp' || value.configuration.provider !== 'gcp') {
    throw new Error('gcp_workspace_host_hosted_delegation_provider_mismatch');
  }
  if (value.credentialRef !== input.credentialRef.trim()) {
    throw new Error('gcp_workspace_host_hosted_delegation_reference_mismatch');
  }
  if (value.status !== 'verified') {
    throw new Error('gcp_workspace_host_hosted_delegation_not_verified');
  }
  return value as GcpDelegationRecord;
}

async function json<T>(fetchImpl: typeof fetch, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) throw new Error(`gcp_workspace_host_hosted_auth_exchange_failed:${response.status}`);
  return (await response.json()) as T;
}

async function metadataToken(fetchImpl: typeof fetch): Promise<string> {
  const response = await json<{ access_token?: string }>(fetchImpl, `${METADATA_ROOT}/token`, {
    headers: { 'metadata-flavor': 'Google' },
  });
  if (!response.access_token) throw new Error('gcp_workspace_host_metadata_access_token_missing');
  return response.access_token;
}

async function metadataIdentity(fetchImpl: typeof fetch, audience: string): Promise<string> {
  const response = await fetchImpl(
    `${METADATA_ROOT}/identity?audience=${encodeURIComponent(audience)}&format=full`,
    { headers: { 'metadata-flavor': 'Google' } },
  );
  if (!response.ok) throw new Error(`gcp_workspace_host_metadata_identity_failed:${response.status}`);
  const token = (await response.text()).trim();
  if (!token) throw new Error('gcp_workspace_host_metadata_identity_missing');
  return token;
}

async function workloadAccessToken(
  fetchImpl: typeof fetch,
  source: Extract<HostedProviderDelegationRecord['configuration'], { provider: 'gcp' }>['source'],
): Promise<string> {
  if (source.method !== 'workload-identity') return metadataToken(fetchImpl);
  const subjectToken = await metadataIdentity(fetchImpl, source.audience);
  const exchanged = await json<{ access_token?: string }>(fetchImpl, 'https://sts.googleapis.com/v1/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      audience: source.audience,
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      scope: IAM_SCOPE,
      subject_token: subjectToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token',
    }),
  });
  if (!exchanged.access_token) throw new Error('gcp_workspace_host_sts_access_token_missing');
  return exchanged.access_token;
}

/**
 * Resolve a verified delegation to a one-hour IAM Credentials token. The
 * persisted record contains metadata and an opaque reference only; both the
 * metadata identity token and returned access token exist in memory for this
 * call and are never written to the connection store.
 */
export async function resolveHostedGcpAuth(
  input: HostedGcpAuthResolverInput,
  dependencies: HostedGcpAuthResolverDependencies = {},
): Promise<GcpResolvedAuth> {
  const record = delegation(input);
  const source = record.configuration.source;
  const fetchImpl = dependencies.fetch ?? fetch;
  const sourceToken = await workloadAccessToken(fetchImpl, source);
  const serviceAccount = encodeURIComponent(source.serviceAccountEmail);
  const minted = await json<{ accessToken?: string }>(
    fetchImpl,
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${serviceAccount}:generateAccessToken`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${sourceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ delegates: [], scope: [IAM_SCOPE], lifetime: '3600s' }),
    },
  );
  if (!minted.accessToken) throw new Error('gcp_workspace_host_impersonated_access_token_missing');
  return {
    accessToken: minted.accessToken,
    identity: source.serviceAccountEmail,
    projectId: source.projectId,
  };
}

export function isHostedProviderCredentialRef(value: string): boolean {
  return /^(?:encrypted|resolver|delegation):\/\//.test(value.trim());
}
