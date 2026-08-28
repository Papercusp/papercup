import { describe, expect, it, vi } from 'vitest';
import {
  HostedProviderDelegationManager,
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationRecord,
  type HostedProviderDelegationStore,
} from './hosted-provider-delegation';

const NOW = '2026-08-27T12:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

const common = {
  workspaceId: 'workspace-1',
  connectionId: 'connection-1',
  label: 'Production delegation',
  credentialRef: 'encrypted://workspace-1/cloud/connection-1',
  now: NOW,
};

describe('hosted provider delegation onboarding', () => {
  it('generates deterministic least-privilege templates for GCP, AWS, and Azure', () => {
    const gcp = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'workload-identity',
          projectId: 'papercusp-hosted-123',
          projectNumber: '123456789012',
          poolId: 'papercusp-hosted',
          providerId: 'papercusp-oidc',
          serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
          issuer: 'https://app.papercusp.com/oidc',
          audience: 'papercusp-workspace-hosts',
          subject: 'workspace:workspace-1',
        },
      },
    });
    expect(gcp.template.format).toBe('gcp-iam-json');
    expect(JSON.stringify(gcp.template.document)).toContain('compute.instances.create');
    expect(JSON.stringify(gcp.template.document)).toContain('roles/iam.workloadIdentityUser');

    const aws = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
          trustedPrincipalArn: 'arn:aws:iam::999999999999:role/PapercuspControlPlane',
          externalIdRef: 'encrypted://workspace-1/aws/external-id',
        },
      },
    });
    expect(aws.template.format).toBe('aws-cloudformation-json');
    expect(JSON.stringify(aws.template.document)).toContain('sts:ExternalId');
    expect(JSON.stringify(aws.template.document)).toContain('ec2:RunInstances');
    expect(JSON.stringify(aws.template.document)).not.toContain('encrypted://workspace-1/aws/external-id');

    const azure = buildHostedProviderDelegationOnboarding({
      ...common,
      configuration: {
        provider: 'azure',
        source: {
          environment: 'hosted',
          method: 'federated-service-principal',
          tenantId: TENANT,
          clientId: CLIENT,
          issuer: 'https://app.papercusp.com/oidc',
          audience: 'api://AzureADTokenExchange',
          subject: 'workspace:workspace-1',
          assertionRef: 'resolver://azure/assertions/workspace-1',
        },
      },
    });
    expect(azure.template.format).toBe('azure-arm-json');
    expect(JSON.stringify(azure.template.document)).toContain('Microsoft.Compute/virtualMachines/write');
    expect(JSON.stringify(azure.template.document)).not.toContain('assertionRef');
  });

  it('rejects uploaded/static key material and non-resolver credential references', () => {
    expect(() =>
      buildHostedProviderDelegationOnboarding({
        ...common,
        credentialRef: 'uploaded://service-account.json',
        configuration: {
          provider: 'gcp',
          source: {
            method: 'service-account-impersonation',
            projectId: 'papercusp-hosted-123',
            serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
            trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
          },
        },
      }),
    ).toThrow(/credentialRef is invalid/);

    expect(() =>
      buildHostedProviderDelegationOnboarding({
        ...common,
        configuration: {
          provider: 'azure',
          source: {
            environment: 'hosted',
            method: 'federated-service-principal',
            tenantId: TENANT,
            clientId: CLIENT,
            issuer: 'https://app.papercusp.com/oidc',
            audience: 'api://AzureADTokenExchange',
            subject: 'workspace:workspace-1',
            assertionRef: 'resolver://azure/assertions/workspace-1',
            clientSecret: 'never-emit-me',
          } as never,
        },
      }),
    ).toThrow(/Secret-shaped field/);
  });

  it('verifies, rotates, and revokes through generation-checked persistence', async () => {
    let record: HostedProviderDelegationRecord | null = null;
    const store: HostedProviderDelegationStore = {
      async read() {
        return record;
      },
      async save(next, expectedGeneration) {
        if (expectedGeneration !== undefined && record?.generation !== expectedGeneration) {
          throw new Error('generation-conflict');
        }
        record = next;
      },
    };
    const verify = vi.fn(async (value: HostedProviderDelegationRecord) => ({
      identity: `${value.provider}:delegated-identity`,
      evidenceRef: `audit://${value.provider}/${value.generation}`,
      checkedAt: NOW,
    }));
    const revoke = vi.fn(async (value: HostedProviderDelegationRecord) => ({
      evidenceRef: `audit://${value.provider}/${value.generation}/revoked`,
      revokedAt: NOW,
    }));
    const adapter: HostedProviderDelegationAdapter = { verify, revoke };
    const manager = new HostedProviderDelegationManager(
      store,
      { gcp: adapter, aws: adapter, azure: adapter },
      () => new Date(NOW),
    );

    const initial = await manager.onboard({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'service-account-impersonation',
          projectId: 'papercusp-hosted-123',
          serviceAccountEmail: 'workspace-host@papercusp-hosted-123.iam.gserviceaccount.com',
          trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane',
        },
      },
    });
    expect(initial.record.status).toBe('pending');
    await expect(manager.verify('workspace-1', 'connection-1')).resolves.toMatchObject({
      status: 'verified',
      generation: 1,
      identity: 'gcp:delegated-identity',
    });

    await expect(
      manager.rotate('workspace-1', 'connection-1', {
        label: common.label,
        credentialRef: 'encrypted://workspace-1/cloud/connection-1-generation-2',
        now: NOW,
        configuration: {
          provider: 'gcp',
          source: {
            method: 'service-account-impersonation',
            projectId: 'papercusp-hosted-123',
            serviceAccountEmail: 'workspace-host-v2@papercusp-hosted-123.iam.gserviceaccount.com',
            trustedPrincipal: 'principal://iam.googleapis.com/subject/control-plane-v2',
          },
        },
      }),
    ).resolves.toMatchObject({ status: 'verified', generation: 2, supersedesGeneration: 1 });
    expect(revoke).toHaveBeenCalledWith(expect.objectContaining({ generation: 1 }));

    await expect(manager.revoke('workspace-1', 'connection-1')).resolves.toMatchObject({
      status: 'revoked',
      generation: 2,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(revoke).toHaveBeenCalledTimes(2);
  });
});
