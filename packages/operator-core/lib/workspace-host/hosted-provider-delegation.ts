import { createHash } from 'node:crypto';
import { assertWorkspaceHostSecretIsolation } from '@papercusp/deployment-driver';
import type { Sql } from 'postgres';
import { GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS } from '../cloud-workspaces/gcp-preflight';
import {
  AWS_WORKSPACE_HOST_PERMISSION_ACTIONS,
  planAwsSdkCredentialProvider,
  type AwsWorkspaceHostCredentialSource,
} from './aws-connection';
import {
  AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS,
  planAzureCredentialProvider,
  type AzureCloudEnvironment,
  type AzureWorkspaceHostCredentialSource,
} from './azure-connection';

export const HOSTED_PROVIDER_DELEGATION_VERSION = 'hosted-provider-delegation-v1';

export type HostedProviderDelegationStatus =
  | 'pending'
  | 'verified'
  | 'invalid'
  | 'rotation-pending-revocation'
  | 'revoked';

type HostedAwsCredentialSource = Extract<AwsWorkspaceHostCredentialSource, { environment: 'hosted' }>;
type HostedAzureCredentialSource = Extract<AzureWorkspaceHostCredentialSource, { environment: 'hosted' }>;

export type GcpHostedCredentialSource =
  | {
      method: 'workload-identity';
      projectId: string;
      projectNumber: string;
      poolId: string;
      providerId: string;
      serviceAccountEmail: string;
      issuer: string;
      audience: string;
      subject: string;
    }
  | {
      method: 'service-account-impersonation';
      projectId: string;
      serviceAccountEmail: string;
      trustedPrincipal: string;
    };

export type HostedProviderDelegationConfiguration =
  | { provider: 'gcp'; source: GcpHostedCredentialSource }
  | { provider: 'aws'; accountId: string; source: HostedAwsCredentialSource }
  | { provider: 'azure'; cloud?: AzureCloudEnvironment; source: HostedAzureCredentialSource };

export interface HostedProviderDelegationOnboardingInput {
  workspaceId: string;
  connectionId: string;
  label: string;
  credentialRef: string;
  generation?: number;
  configuration: HostedProviderDelegationConfiguration;
  now?: string;
}

export interface HostedProviderDelegationTemplate {
  format: 'gcp-iam-json' | 'aws-cloudformation-json' | 'azure-arm-json';
  document: Readonly<Record<string, unknown>>;
}

export interface HostedProviderDelegationRecord {
  schemaVersion: typeof HOSTED_PROVIDER_DELEGATION_VERSION;
  workspaceId: string;
  connectionId: string;
  label: string;
  provider: HostedProviderDelegationConfiguration['provider'];
  credentialRef: string;
  generation: number;
  status: HostedProviderDelegationStatus;
  configuration: HostedProviderDelegationConfiguration;
  templateDigest: string;
  createdAt: string;
  updatedAt: string;
  verifiedAt?: string;
  revokedAt?: string;
  identity?: string;
  evidenceRef?: string;
  supersedesGeneration?: number;
}

export interface HostedProviderDelegationOnboarding {
  record: HostedProviderDelegationRecord;
  template: HostedProviderDelegationTemplate;
}

export interface HostedProviderDelegationVerification {
  identity: string;
  evidenceRef: string;
  checkedAt?: string;
}

export interface HostedProviderDelegationRevocation {
  evidenceRef: string;
  revokedAt?: string;
}

export interface HostedProviderDelegationAdapter {
  verify(record: HostedProviderDelegationRecord): Promise<HostedProviderDelegationVerification>;
  revoke(record: HostedProviderDelegationRecord): Promise<HostedProviderDelegationRevocation>;
}

export interface HostedProviderDelegationStore {
  read(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord | null>;
  save(record: HostedProviderDelegationRecord, expectedGeneration?: number): Promise<void>;
}

export type HostedProviderDelegationSqlRunner = <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>;

type DelegationRow = { provider_config: Record<string, unknown> };

function storedDelegation(value: unknown): HostedProviderDelegationRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Partial<HostedProviderDelegationRecord>;
  return record.schemaVersion === HOSTED_PROVIDER_DELEGATION_VERSION &&
    typeof record.workspaceId === 'string' &&
    typeof record.connectionId === 'string' &&
    typeof record.generation === 'number'
    ? record as HostedProviderDelegationRecord
    : null;
}

function connectionStatus(record: HostedProviderDelegationRecord): 'connected' | 'degraded' | 'invalid' {
  if (record.status === 'verified') return 'connected';
  if (record.status === 'revoked') return 'invalid';
  return 'degraded';
}

function connectionProviderConfig(record: HostedProviderDelegationRecord): Record<string, unknown> {
  const gcp = record.configuration.provider === 'gcp' ? record.configuration.source : undefined;
  const config = {
    hostedDelegation: record,
    ...(gcp ? { projectId: gcp.projectId, serviceAccountEmail: gcp.serviceAccountEmail } : {}),
  };
  assertWorkspaceHostSecretIsolation(config, 'hostedProviderDelegation.providerConfig');
  return config;
}

/** Tenant-context Postgres store over the existing workspace-host connection root. */
export class PostgresHostedProviderDelegationStore implements HostedProviderDelegationStore {
  private readonly controlPlaneWorkspaceId: string;

  constructor(
    private readonly run: HostedProviderDelegationSqlRunner,
    controlPlaneWorkspaceId: string,
  ) {
    this.controlPlaneWorkspaceId = requireString(controlPlaneWorkspaceId, 'controlPlaneWorkspaceId');
  }

  read(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord | null> {
    return this.run(async (sql) => {
      const rows = await sql<DelegationRow[]>`
        SELECT provider_config
        FROM harness_shared.workspace_host_connections
        WHERE workspace_id = ${this.controlPlaneWorkspaceId} AND id = ${connectionId}
        LIMIT 1
      `;
      const record = storedDelegation(rows[0]?.provider_config?.hostedDelegation);
      if (!record) return null;
      if (record.workspaceId !== workspaceId || record.connectionId !== connectionId) {
        throw new Error('hosted_provider_delegation_storage_binding_mismatch');
      }
      return record;
    });
  }

  save(record: HostedProviderDelegationRecord, expectedGeneration?: number): Promise<void> {
    assertWorkspaceHostSecretIsolation(record, 'hostedProviderDelegation.record');
    const providerConfig = connectionProviderConfig(record);
    const expected = expectedGeneration ?? null;
    return this.run(async (sql) => {
      const rows = await sql<Array<{ id: string }>>`
        INSERT INTO harness_shared.workspace_host_connections
          (workspace_id, id, target, label, credential_ref, provider_config, status, status_detail,
           last_validated_at, updated_at)
        VALUES
          (${this.controlPlaneWorkspaceId}, ${record.connectionId}, ${record.provider}, ${record.label},
           ${record.credentialRef}, ${sql.json(providerConfig as never)}, ${connectionStatus(record)},
           ${record.status}, ${record.verifiedAt ?? null}, now())
        ON CONFLICT (workspace_id, id) DO UPDATE SET
          target = EXCLUDED.target,
          label = EXCLUDED.label,
          credential_ref = EXCLUDED.credential_ref,
          provider_config = EXCLUDED.provider_config,
          status = EXCLUDED.status,
          status_detail = EXCLUDED.status_detail,
          last_validated_at = EXCLUDED.last_validated_at,
          updated_at = now()
        WHERE
          (${expected}::integer IS NULL AND
             harness_shared.workspace_host_connections.provider_config->'hostedDelegation' IS NULL)
          OR
          (NULLIF(harness_shared.workspace_host_connections.provider_config->'hostedDelegation'->>'generation', '')::integer = ${expected})
        RETURNING id
      `;
      if (!rows[0]) throw new Error('hosted_provider_delegation_generation_conflict');
    });
  }
}

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/i;
const GCP_PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_NUMBER = /^\d{6,20}$/;
const GCP_COMPONENT = /^[a-z][a-z0-9-]{3,31}$/;
const GCP_SERVICE_ACCOUNT = /^[^@\s]+@[^@\s]+\.iam\.gserviceaccount\.com$/;
const AWS_ACCOUNT = /^\d{12}$/;
const REFERENCE = /^(?:encrypted|resolver|delegation):\/\/[A-Za-z0-9][A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]*$/;

function requireString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

function requirePattern(value: string, pattern: RegExp, label: string): string {
  const normalized = requireString(value, label);
  if (!pattern.test(normalized)) throw new Error(`${label} is invalid`);
  return normalized;
}

function requireHttps(value: string, label: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error(`${label} must use HTTPS`);
  return parsed.toString();
}

function now(value?: string): string {
  const parsed = value ? new Date(value) : new Date();
  if (!Number.isFinite(parsed.getTime())) throw new Error('now must be an ISO timestamp');
  return parsed.toISOString();
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateGcp(source: GcpHostedCredentialSource): GcpHostedCredentialSource {
  const projectId = requirePattern(source.projectId, GCP_PROJECT, 'projectId');
  const serviceAccountEmail = requirePattern(
    source.serviceAccountEmail,
    GCP_SERVICE_ACCOUNT,
    'serviceAccountEmail',
  );
  if (source.method === 'service-account-impersonation') {
    return {
      method: source.method,
      projectId,
      serviceAccountEmail,
      trustedPrincipal: requireString(source.trustedPrincipal, 'trustedPrincipal'),
    };
  }
  return {
    method: source.method,
    projectId,
    projectNumber: requirePattern(source.projectNumber, GCP_NUMBER, 'projectNumber'),
    poolId: requirePattern(source.poolId, GCP_COMPONENT, 'poolId'),
    providerId: requirePattern(source.providerId, GCP_COMPONENT, 'providerId'),
    serviceAccountEmail,
    issuer: requireHttps(source.issuer, 'issuer'),
    audience: requireString(source.audience, 'audience'),
    subject: requireString(source.subject, 'subject'),
  };
}

function normalizeConfiguration(
  value: HostedProviderDelegationConfiguration,
): HostedProviderDelegationConfiguration {
  assertWorkspaceHostSecretIsolation(value, 'hostedProviderDelegation.configuration');
  switch (value.provider) {
    case 'gcp':
      return { provider: value.provider, source: validateGcp(value.source) };
    case 'aws': {
      if (value.source.environment !== 'hosted') throw new Error('AWS hosted onboarding requires a hosted source');
      const accountId = requirePattern(value.accountId, AWS_ACCOUNT, 'accountId');
      const plan = planAwsSdkCredentialProvider(value.source);
      const roleAccount = plan.roleArn?.split(':')[4];
      if (roleAccount !== accountId) throw new Error('AWS role account must match accountId');
      return { provider: value.provider, accountId, source: value.source };
    }
    case 'azure':
      if (value.source.environment !== 'hosted') throw new Error('Azure hosted onboarding requires a hosted source');
      planAzureCredentialProvider(value.source, value.cloud);
      return { provider: value.provider, ...(value.cloud ? { cloud: value.cloud } : {}), source: value.source };
  }
}

function gcpTemplate(source: GcpHostedCredentialSource): HostedProviderDelegationTemplate {
  const customRole = {
    roleId: 'papercuspWorkspaceHostOperator',
    title: 'Papercusp Workspace Host Operator',
    stage: 'GA',
    includedPermissions: [...GCP_WORKSPACE_HOST_REQUIRED_PERMISSIONS],
  };
  const workloadPrincipal = source.method === 'workload-identity'
    ? `principal://iam.googleapis.com/projects/${source.projectNumber}/locations/global/` +
      `workloadIdentityPools/${source.poolId}/subject/${source.subject}`
    : undefined;
  const bindings = source.method === 'workload-identity'
    ? [
        { role: 'roles/iam.workloadIdentityUser', member: workloadPrincipal },
        { role: 'roles/iam.serviceAccountTokenCreator', member: workloadPrincipal },
      ]
    : [
        { role: 'roles/iam.serviceAccountTokenCreator', member: source.trustedPrincipal },
      ];
  return {
    format: 'gcp-iam-json',
    document: {
      projectId: source.projectId,
      serviceAccountEmail: source.serviceAccountEmail,
      customRole,
      bindings,
      ...(source.method === 'workload-identity'
        ? {
            workloadIdentityProvider: {
              poolId: source.poolId,
              providerId: source.providerId,
              issuer: source.issuer,
              audience: source.audience,
              subject: source.subject,
            },
          }
        : {}),
    },
  };
}

function awsTemplate(
  accountId: string,
  source: HostedAwsCredentialSource,
): HostedProviderDelegationTemplate {
  const trust = source.method === 'customer-role'
    ? {
        Effect: 'Allow',
        Principal: { AWS: source.trustedPrincipalArn },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': { Ref: 'ExternalId' } } },
      }
    : {
        Effect: 'Allow',
        Principal: { Federated: source.providerArn },
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            [`${new URL(source.issuer).host}:aud`]: source.audience,
            [`${new URL(source.issuer).host}:sub`]: source.subject,
          },
        },
      };
  return {
    format: 'aws-cloudformation-json',
    document: {
      AWSTemplateFormatVersion: '2010-09-09',
      Description: 'Papercusp workspace-host least-privilege delegated role',
      ...(source.method === 'customer-role'
        ? { Parameters: { ExternalId: { Type: 'String', NoEcho: true } } }
        : {}),
      Resources: {
        WorkspaceHostRole: {
          Type: 'AWS::IAM::Role',
          Properties: {
            RoleName: `PapercuspWorkspaceHost-${accountId}`,
            AssumeRolePolicyDocument: { Version: '2012-10-17', Statement: [trust] },
            Policies: [
              {
                PolicyName: 'PapercuspWorkspaceHostLifecycle',
                PolicyDocument: {
                  Version: '2012-10-17',
                  Statement: [{ Effect: 'Allow', Action: [...AWS_WORKSPACE_HOST_PERMISSION_ACTIONS], Resource: '*' }],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function azureTemplate(
  source: HostedAzureCredentialSource,
): HostedProviderDelegationTemplate {
  return {
    format: 'azure-arm-json',
    document: {
      $schema: 'https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#',
      contentVersion: '1.0.0.0',
      roleDefinition: {
        roleName: 'Papercusp Workspace Host Operator',
        permissions: [{ actions: [...AZURE_WORKSPACE_HOST_PERMISSION_ACTIONS], notActions: [] }],
        assignableScopes: ['/subscriptions/{subscriptionId}'],
      },
      delegation: source.method === 'federated-service-principal'
        ? {
            type: 'Microsoft.Graph/applications/federatedIdentityCredentials',
            tenantId: source.tenantId,
            clientId: source.clientId,
            issuer: source.issuer,
            audiences: [source.audience],
            subject: source.subject,
          }
        : {
            type: 'Microsoft.Solutions/applications/authorizations',
            tenantId: source.tenantId,
            applicationId: source.applicationId,
            managedApplicationResourceId: source.managedApplicationResourceId,
            managedIdentityResourceId: source.managedIdentityResourceId,
          },
    },
  };
}

export function buildHostedProviderDelegationOnboarding(
  input: HostedProviderDelegationOnboardingInput,
): HostedProviderDelegationOnboarding {
  assertWorkspaceHostSecretIsolation(input, 'hostedProviderDelegation.onboarding');
  const workspaceId = requirePattern(input.workspaceId, SAFE_ID, 'workspaceId');
  const connectionId = requirePattern(input.connectionId, SAFE_ID, 'connectionId');
  const label = requireString(input.label, 'label');
  const credentialRef = requirePattern(input.credentialRef, REFERENCE, 'credentialRef');
  const generation = input.generation ?? 1;
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('generation must be a positive integer');
  const configuration = normalizeConfiguration(input.configuration);
  const template = configuration.provider === 'gcp'
    ? gcpTemplate(configuration.source)
    : configuration.provider === 'aws'
      ? awsTemplate(configuration.accountId, configuration.source)
      : azureTemplate(configuration.source);
  assertWorkspaceHostSecretIsolation(template, 'hostedProviderDelegation.template');
  const timestamp = now(input.now);
  return {
    template,
    record: {
      schemaVersion: HOSTED_PROVIDER_DELEGATION_VERSION,
      workspaceId,
      connectionId,
      label,
      provider: configuration.provider,
      credentialRef,
      generation,
      status: 'pending',
      configuration,
      templateDigest: digest(template.document),
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

function safeVerification(value: HostedProviderDelegationVerification): HostedProviderDelegationVerification {
  assertWorkspaceHostSecretIsolation(value, 'hostedProviderDelegation.verification');
  return {
    identity: requireString(value.identity, 'verification.identity'),
    evidenceRef: requireString(value.evidenceRef, 'verification.evidenceRef'),
    ...(value.checkedAt ? { checkedAt: now(value.checkedAt) } : {}),
  };
}

function safeRevocation(value: HostedProviderDelegationRevocation): HostedProviderDelegationRevocation {
  assertWorkspaceHostSecretIsolation(value, 'hostedProviderDelegation.revocation');
  return {
    evidenceRef: requireString(value.evidenceRef, 'revocation.evidenceRef'),
    ...(value.revokedAt ? { revokedAt: now(value.revokedAt) } : {}),
  };
}

export class HostedProviderDelegationManager {
  constructor(
    private readonly store: HostedProviderDelegationStore,
    private readonly adapters: Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async onboard(input: HostedProviderDelegationOnboardingInput): Promise<HostedProviderDelegationOnboarding> {
    const onboarding = buildHostedProviderDelegationOnboarding(input);
    await this.store.save(onboarding.record);
    return onboarding;
  }

  async verify(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord> {
    const current = await this.requireRecord(workspaceId, connectionId);
    if (current.status === 'revoked') throw new Error('hosted_provider_delegation_is_revoked');
    let verification: HostedProviderDelegationVerification;
    try {
      verification = safeVerification(await this.adapters[current.provider].verify(current));
    } catch {
      const invalid = { ...current, status: 'invalid' as const, updatedAt: this.clock().toISOString() };
      await this.store.save(invalid, current.generation);
      throw new Error('hosted_provider_delegation_verification_failed');
    }
    const verifiedAt = verification.checkedAt ?? this.clock().toISOString();
    const verified = {
      ...current,
      status: 'verified' as const,
      identity: verification.identity,
      evidenceRef: verification.evidenceRef,
      verifiedAt,
      updatedAt: verifiedAt,
    };
    await this.store.save(verified, current.generation);
    return verified;
  }

  async revoke(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord> {
    const current = await this.requireRecord(workspaceId, connectionId);
    if (current.status === 'revoked') return current;
    let receipt: HostedProviderDelegationRevocation;
    try {
      receipt = safeRevocation(await this.adapters[current.provider].revoke(current));
    } catch {
      throw new Error('hosted_provider_delegation_revocation_failed');
    }
    const revokedAt = receipt.revokedAt ?? this.clock().toISOString();
    const revoked = {
      ...current,
      status: 'revoked' as const,
      evidenceRef: receipt.evidenceRef,
      revokedAt,
      updatedAt: revokedAt,
    };
    await this.store.save(revoked, current.generation);
    return revoked;
  }

  async rotate(
    workspaceId: string,
    connectionId: string,
    next: Omit<HostedProviderDelegationOnboardingInput, 'workspaceId' | 'connectionId' | 'generation'>,
  ): Promise<HostedProviderDelegationRecord> {
    const current = await this.requireRecord(workspaceId, connectionId);
    if (current.status !== 'verified') throw new Error('hosted_provider_delegation_rotation_requires_verified_current');
    const onboarding = buildHostedProviderDelegationOnboarding({
      ...next,
      workspaceId,
      connectionId,
      generation: current.generation + 1,
    });
    const pending = { ...onboarding.record, supersedesGeneration: current.generation };
    await this.store.save(pending, current.generation);

    let verification: HostedProviderDelegationVerification;
    try {
      verification = safeVerification(await this.adapters[pending.provider].verify(pending));
    } catch {
      await this.store.save(
        { ...pending, status: 'invalid', updatedAt: this.clock().toISOString() },
        pending.generation,
      );
      throw new Error('hosted_provider_delegation_rotation_verification_failed');
    }

    const verifiedAt = verification.checkedAt ?? this.clock().toISOString();
    const verified = {
      ...pending,
      status: 'verified' as const,
      identity: verification.identity,
      evidenceRef: verification.evidenceRef,
      verifiedAt,
      updatedAt: verifiedAt,
    };
    await this.store.save(verified, pending.generation);

    try {
      await this.adapters[current.provider].revoke(current);
    } catch {
      const incomplete = {
        ...verified,
        status: 'rotation-pending-revocation' as const,
        updatedAt: this.clock().toISOString(),
      };
      await this.store.save(incomplete, verified.generation);
      throw new Error('hosted_provider_delegation_rotation_old_generation_not_revoked');
    }
    return verified;
  }

  private async requireRecord(workspaceId: string, connectionId: string): Promise<HostedProviderDelegationRecord> {
    const record = await this.store.read(workspaceId, connectionId);
    if (!record) throw new Error('hosted_provider_delegation_not_found');
    return record;
  }
}
