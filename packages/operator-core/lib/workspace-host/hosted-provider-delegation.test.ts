import { describe, expect, it, vi } from 'vitest';
import {
  HostedProviderDelegationManager,
  bindPapercuspHostedDelegation,
  buildHostedProviderDelegationOnboarding,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationRecord,
  type HostedProviderDelegationStore,
} from './hosted-provider-delegation';
import { organizationExternalId } from './hosted-aws-identity';

const NOW = '2026-08-27T12:00:00.000Z';
const TENANT = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';

const ORG_PRINCIPAL = 'serviceAccount:pco-org-a@papercusp-identity.iam.gserviceaccount.com';
const HOSTING_PROJECT = 'papercusp-hosted-workspaces';
function organization(organizationId: string, principal: string): HostedDelegationOrganization & {
  reserved: string[];
} {
  const reserved: string[] = [];
  return {
    organizationId,
    reserved,
    gcpTrustedPrincipal: async () => principal,
    gcpPapercuspHosting: async (hostId) => {
      reserved.push(hostId);
      return { projectId: HOSTING_PROJECT, serviceAccountEmail: principal.slice('serviceAccount:'.length) };
    },
    awsTrustedPrincipal: async () => ({
      principalArn: awsOrgPrincipal(organizationId),
      externalIdRef: `resolver://aws-external-id/${organizationId}`,
    }),
  };
}
function awsOrgPrincipal(organizationId: string): string {
  return `arn:aws:iam::999999999999:role/papercusp/orgs/pco-${organizationId}`;
}
const ORGANIZATION = organization('org-a', ORG_PRINCIPAL);

const common = {
  organizationId: 'org-a',
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
      ORGANIZATION,
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

describe('organization-bound delegations (D-397)', () => {
  function memoryStore() {
    const records = new Map<string, HostedProviderDelegationRecord>();
    const store: HostedProviderDelegationStore = {
      async read(workspaceId, connectionId) {
        return records.get(`${workspaceId}/${connectionId}`) ?? null;
      },
      async save(next) {
        records.set(`${next.workspaceId}/${next.connectionId}`, next);
      },
    };
    return { records, store };
  }
  const adapter: HostedProviderDelegationAdapter = {
    verify: async (value) => ({ identity: `${value.provider}:ok`, evidenceRef: 'audit://ok', checkedAt: NOW }),
    revoke: async () => ({ evidenceRef: 'audit://revoked', revokedAt: NOW }),
  };
  const adapters = { gcp: adapter, aws: adapter, azure: adapter };
  const impersonation = {
    provider: 'gcp' as const,
    source: {
      method: 'service-account-impersonation' as const,
      projectId: 'customer-project-1',
      serviceAccountEmail: 'victim-host@customer-project-1.iam.gserviceaccount.com',
      trustedPrincipal: 'serviceAccount:attacker-chosen@evil.iam.gserviceaccount.com',
    },
  };

  it('stamps the bound organization and its own principal over whatever the caller sent', async () => {
    const { store } = memoryStore();
    const manager = new HostedProviderDelegationManager(store, adapters, ORGANIZATION, () => new Date(NOW));
    const { record, template } = await manager.onboard({
      ...common,
      organizationId: 'org-victim',
      configuration: impersonation,
    });
    expect(record.organizationId).toBe('org-a');
    expect(record.configuration.source).toMatchObject({ trustedPrincipal: ORG_PRINCIPAL });
    expect(JSON.stringify(template.document)).toContain(ORG_PRINCIPAL);
    expect(JSON.stringify(template.document)).not.toContain('attacker-chosen');
  });

  it("P-008: binds an AWS customer role to the organization's own role and ExternalId over whatever the caller sent", async () => {
    const { store } = memoryStore();
    const manager = new HostedProviderDelegationManager(store, adapters, ORGANIZATION, () => new Date(NOW));
    const { record, template } = await manager.onboard({
      ...common,
      organizationId: 'org-victim',
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted',
          method: 'customer-role',
          roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost-123456789012',
          trustedPrincipalArn: 'arn:aws:iam::666666666666:role/attacker-chosen',
          externalIdRef: 'resolver://aws-external-id/org-victim',
        },
      },
    });
    expect(record.organizationId).toBe('org-a');
    expect(record.configuration.source).toMatchObject({
      trustedPrincipalArn: awsOrgPrincipal('org-a'),
      externalIdRef: 'resolver://aws-external-id/org-a',
    });
    const document = template.document as {
      Parameters: { ExternalId: Record<string, unknown> };
      Resources: Record<string, { Properties: { RoleName?: string } }>;
    };
    // The customer's stack is prefilled with the organization's ExternalId; it is not a secret (D-007).
    expect(document.Parameters.ExternalId.Default).toBe(organizationExternalId('org-a'));
    expect(document.Parameters.ExternalId).not.toHaveProperty('NoEcho');
    expect(JSON.stringify(document)).toContain(awsOrgPrincipal('org-a'));
    expect(JSON.stringify(document)).not.toContain('attacker-chosen');
    expect(JSON.stringify(document)).not.toContain(organizationExternalId('org-victim'));
    expect(Object.values(document.Resources).some((resource) => resource.Properties.RoleName === 'PapercuspWorkspaceHost-123456789012'))
      .toBe(true);
  });

  it('P-008: refuses an AWS method no organization owns (hosted OIDC), before recording anything', async () => {
    const { records, store } = memoryStore();
    await expect(new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({
      ...common,
      configuration: {
        provider: 'aws',
        accountId: '123456789012',
        source: {
          environment: 'hosted', method: 'oidc', roleArn: 'arn:aws:iam::123456789012:role/PapercuspWorkspaceHost',
          providerArn: 'arn:aws:iam::123456789012:oidc-provider/app.papercusp.com', issuer: 'https://app.papercusp.com/oidc',
          audience: 'sts.amazonaws.com', subject: 'workspace:workspace-1',
        },
      } as never,
    })).rejects.toThrow('hosted_provider_delegation_aws_method_not_organization_bound');
    expect(records.size).toBe(0);
  });

  it("treats another organization's delegation as not found for every lifecycle verb", async () => {
    const { store } = memoryStore();
    await new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({ ...common, configuration: impersonation });
    const other = new HostedProviderDelegationManager(
      store,
      adapters,
      organization('org-b', 'serviceAccount:pco-org-b@papercusp-identity.iam.gserviceaccount.com'),
    );
    await expect(other.verify('workspace-1', 'connection-1')).rejects.toThrow('not_found');
    await expect(other.revoke('workspace-1', 'connection-1')).rejects.toThrow('not_found');
    await expect(other.rotate('workspace-1', 'connection-1', {
      label: 'x', credentialRef: common.credentialRef, configuration: impersonation,
    })).rejects.toThrow('not_found');
  });

  it('refuses GCP workload identity, which no organization owns', async () => {
    const { records, store } = memoryStore();
    await expect(new HostedProviderDelegationManager(store, adapters, ORGANIZATION).onboard({
      ...common,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'workload-identity', projectId: 'customer-project-1', projectNumber: '123456789012',
          poolId: 'pool', providerId: 'provider', serviceAccountEmail: 'host@customer-project-1.iam.gserviceaccount.com',
          issuer: 'https://app.papercusp.com/oidc', audience: 'aud', subject: 'workspace:workspace-1',
        },
      },
    })).rejects.toThrow('method_not_organization_bound');
    expect(records.size).toBe(0);
  });
});

describe("Papercusp-hosted delegations (D-399)", () => {
  const papercuspHosted = {
    provider: 'gcp' as const,
    source: {
      method: 'papercusp-hosted' as const,
      projectId: HOSTING_PROJECT,
      serviceAccountEmail: 'pco-org-a@papercusp-identity.iam.gserviceaccount.com',
      hostId: 'host-of-another-organization',
    },
  };

  it('cannot be selected by a caller-supplied configuration, so no request can reserve a host it names', async () => {
    const records = new Map<string, HostedProviderDelegationRecord>();
    const store: HostedProviderDelegationStore = {
      read: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
      save: async (next) => void records.set(`${next.workspaceId}/${next.connectionId}`, next),
    };
    const org = organization('org-a', ORG_PRINCIPAL);
    const adapter: HostedProviderDelegationAdapter = {
      verify: async () => ({ identity: 'x', evidenceRef: 'audit://x', checkedAt: NOW }),
      revoke: async () => ({ evidenceRef: 'audit://x', revokedAt: NOW }),
    };
    const manager = new HostedProviderDelegationManager(store, { gcp: adapter, aws: adapter, azure: adapter }, org);
    await expect(manager.onboard({ ...common, configuration: papercuspHosted })).rejects.toThrow(
      'method_not_organization_bound',
    );
    expect(org.reserved).toEqual([]);
    expect(records.size).toBe(0);

    // Its own entry records a Papercusp-hosted delegation only for the host the server derived.
    const { organizationId: _ignored, ...base } = common;
    const { record } = await manager.onboardPapercuspHosted(base, 'host-derived-1');
    expect(org.reserved).toEqual(['host-derived-1']);
    expect(record).toMatchObject({ organizationId: 'org-a', configuration: { source: { hostId: 'host-derived-1' } } });
    expect(records.get(`${common.workspaceId}/${common.connectionId}`)).toEqual(record);
  });

  it('reserves exactly the server-given host and records it with nothing for the customer to apply', async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const { organizationId: _ignored, ...base } = common;
    const input = await bindPapercuspHostedDelegation(base, org, 'host-derived-1');
    expect(org.reserved).toEqual(['host-derived-1']);
    expect(input.organizationId).toBe('org-a');
    const { record, template } = buildHostedProviderDelegationOnboarding(input);
    expect(record.configuration).toEqual({
      provider: 'gcp',
      source: {
        method: 'papercusp-hosted',
        projectId: HOSTING_PROJECT,
        serviceAccountEmail: 'pco-org-a@papercusp-identity.iam.gserviceaccount.com',
        hostId: 'host-derived-1',
      },
    });
    expect(template.document).toMatchObject({ managedBy: 'papercusp', hostId: 'host-derived-1' });
    // A different reservation is a different grant.
    const other = buildHostedProviderDelegationOnboarding(await bindPapercuspHostedDelegation(base, org, 'host-derived-2'));
    expect(other.record.templateDigest).not.toBe(record.templateDigest);
  });

  it('refuses an unsafe host id before reserving anything', async () => {
    const org = organization('org-a', ORG_PRINCIPAL);
    const { organizationId: _ignored, ...base } = common;
    await expect(bindPapercuspHostedDelegation(base, org, "x' || true || '")).rejects.toThrow();
    expect(org.reserved).toEqual([]);
  });
});
