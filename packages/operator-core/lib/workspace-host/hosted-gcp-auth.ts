/**
 * Short-lived GCP auth for hosted workspace-provider delegations.
 *
 * THE DELEGATION SOURCE (D-386). A `service-account-impersonation` delegation is the customer
 * granting `roles/iam.serviceAccountTokenCreator` on THEIR service account to ONE Papercusp
 * identity — the source. On GCE the source is the metadata service account. Off GCE there is
 * no metadata server (measured: `metadata.google.internal` does not resolve on the box that
 * runs the hosted control plane and the bg-host), so the source is the service-account key
 * file named by {@link HOSTED_GCP_DELEGATION_SOURCE_ENV}, set on every process that verifies
 * or provisions. It is deliberately NOT the ambient GOOGLE_APPLICATION_CREDENTIALS and never
 * a user login: every customer's grant trusts this identity, so it is chosen explicitly.
 */
import { readFile } from 'node:fs/promises';
import { GoogleAuth, type JWTInput } from 'google-auth-library';
import type { GcpResolvedAuth } from '../cloud-workspaces/gcp-preflight';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default';
const IAM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Path to the delegation source's service-account key file. Unset = the GCE metadata identity. */
export const HOSTED_GCP_DELEGATION_SOURCE_ENV = 'PAPERCUSP_HOSTED_GCP_DELEGATION_SOURCE_CREDENTIALS';

/** The Papercusp identity that impersonates customer service accounts. */
export interface HostedGcpDelegationSource {
  /** IAM member form, e.g. `serviceAccount:papercusp-delegation@p.iam.gserviceaccount.com`. */
  principal(): Promise<string>;
  accessToken(): Promise<string>;
}

export interface HostedGcpAuthResolverInput {
  credentialRef: string;
  provider: Readonly<Record<string, unknown>>;
}

export interface HostedGcpAuthResolverDependencies {
  fetch?: typeof fetch;
  source?: HostedGcpDelegationSource;
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

/** The GCE metadata service account as the delegation source. */
export function metadataDelegationSource(fetchImpl: typeof fetch = fetch): HostedGcpDelegationSource {
  return {
    async principal() {
      const response = await fetchImpl(`${METADATA_ROOT}/email`, { headers: { 'metadata-flavor': 'Google' } });
      if (!response.ok) throw new Error(`gcp_workspace_host_metadata_email_failed:${response.status}`);
      const email = (await response.text()).trim();
      if (!email) throw new Error('gcp_workspace_host_metadata_email_missing');
      return `serviceAccount:${email}`;
    },
    accessToken: () => metadataToken(fetchImpl),
  };
}

/**
 * A service-account key file as the delegation source. The file is read lazily, once; a key
 * of any other type (an `authorized_user` gcloud login above all) refuses, because every
 * customer grant would otherwise trust a person's account.
 */
export function keyFileDelegationSource(keyFile: string): HostedGcpDelegationSource {
  let loaded: Promise<{ email: string; auth: GoogleAuth }> | null = null;
  const load = () => {
    loaded ??= readFile(keyFile, 'utf8')
      .catch(() => {
        throw new Error('gcp_workspace_host_delegation_source_unreadable');
      })
      .then((text) => {
        const key = JSON.parse(text) as JWTInput;
        if (key.type !== 'service_account' || typeof key.client_email !== 'string' || !key.client_email) {
          throw new Error('gcp_workspace_host_delegation_source_not_service_account');
        }
        return { email: key.client_email, auth: new GoogleAuth({ credentials: key, scopes: [IAM_SCOPE] }) };
      })
      .catch((error: unknown) => {
        loaded = null;
        throw error;
      });
    return loaded;
  };
  return {
    async principal() {
      return `serviceAccount:${(await load()).email}`;
    },
    async accessToken() {
      const token = await (await load()).auth.getAccessToken();
      if (!token) throw new Error('gcp_workspace_host_delegation_source_access_token_missing');
      return token;
    },
  };
}

let configuredSource: { keyFile: string; source: HostedGcpDelegationSource } | null = null;

/** The configured delegation source: the key file in {@link HOSTED_GCP_DELEGATION_SOURCE_ENV}, else metadata. */
export function hostedGcpDelegationSource(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): HostedGcpDelegationSource {
  const keyFile = env[HOSTED_GCP_DELEGATION_SOURCE_ENV]?.trim();
  if (!keyFile) return metadataDelegationSource(fetchImpl);
  // One client per key file, so its token cache survives across resolutions.
  if (configuredSource?.keyFile !== keyFile) configuredSource = { keyFile, source: keyFileDelegationSource(keyFile) };
  return configuredSource.source;
}

async function workloadAccessToken(
  fetchImpl: typeof fetch,
  source: Extract<HostedProviderDelegationRecord['configuration'], { provider: 'gcp' }>['source'],
  delegationSource: HostedGcpDelegationSource,
): Promise<string> {
  if (source.method !== 'workload-identity') {
    // The customer granted the principal recorded in the delegation. Authenticating as any
    // other identity can only fail at IAM with an opaque 403, so name the mismatch instead.
    const principal = await delegationSource.principal();
    if (principal !== source.trustedPrincipal) {
      throw new Error('gcp_workspace_host_delegation_trusted_principal_mismatch');
    }
    return delegationSource.accessToken();
  }
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
  const sourceToken = await workloadAccessToken(
    fetchImpl,
    source,
    dependencies.source ?? hostedGcpDelegationSource(process.env, fetchImpl),
  );
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
