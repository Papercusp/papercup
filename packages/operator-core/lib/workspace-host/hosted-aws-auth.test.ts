/**
 * aws-byoc-gcp-parity-2026-10-01 P-008 (D-001, D-007): the AWS hosted delegation identity and
 * adapter.
 *
 * The adapter test simulates IAM trust ACROSS THE REAL CHAIN: the credential-provider factories
 * the adapter (and aws-sdk-client) use are replaced by ones that evaluate a trust policy for every
 * hop and record it, and the STS fake resolves its credentials the way the SDK does before each
 * call. So a hop that skips the per-org role, omits the ExternalId, or presents the wrong one is
 * observable — and refusable — exactly where AWS would refuse it.
 */
import { CreateRoleCommand, PutRolePolicyCommand, UpdateAssumeRolePolicyCommand } from '@aws-sdk/client-iam';
import { AssumeRoleCommand, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  awsDelegationOrganization,
  awsProviderDelegationAdapter,
  ensureOrganizationDelegationRole,
  type HostedAwsSender,
} from './hosted-aws-auth';
import {
  HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ENV,
  HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ENV,
  externalIdRefOrganization,
  hostedAwsControlPlaneAccount,
  hostedAwsControlPlanePrincipal,
  organizationDelegationRoleArn,
  organizationDelegationRoleName,
  organizationExternalId,
  organizationExternalIdRef,
  resolveOrganizationExternalIdRef,
} from './hosted-aws-identity';
import type { HostedProviderDelegationRecord } from './hosted-provider-delegation';

type Hop = { roleArn: string; externalId?: string; as: string };
type Creds = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

/** Shared with the hoisted mock: every AssumeRole hop, and the trust policy that judges it. */
const sim = vi.hoisted(() => ({
  hops: [] as Array<{ roleArn: string; externalId?: string; as: string }>,
  trust: (_roleArn: string, _caller: string, _externalId: string | undefined): boolean => true,
}));

function accessDenied(): Error {
  return Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
}

// A test credential's accessKeyId carries the ARN it acts as, so the next hop knows its caller.
vi.mock('@aws-sdk/credential-providers', () => {
  const unused = () => async () => { throw new Error('only the injected control-plane credentials may start a chain'); };
  return {
    fromNodeProviderChain: vi.fn(unused),
    fromIni: vi.fn(unused),
    fromWebToken: vi.fn(unused),
    fromTemporaryCredentials: vi.fn((options: {
      params: { RoleArn: string; ExternalId?: string };
      masterCredentials: () => Promise<{ accessKeyId: string }>;
    }) => async () => {
      const caller = (await options.masterCredentials()).accessKeyId;
      sim.hops.push({ roleArn: options.params.RoleArn, externalId: options.params.ExternalId, as: caller });
      if (!sim.trust(options.params.RoleArn, caller, options.params.ExternalId)) {
        throw Object.assign(new Error('AccessDenied'), { name: 'AccessDenied' });
      }
      return { accessKeyId: options.params.RoleArn, secretAccessKey: 'session-secret', sessionToken: 'session-token' };
    }),
  };
});

const CONTROL_ACCOUNT = '999999999999';
const CONTROL_PRINCIPAL = 'arn:aws:iam::999999999999:role/PapercuspControlPlane';
const CUSTOMER_ACCOUNT = '123456789012';
const CUSTOMER_ROLE = `arn:aws:iam::${CUSTOMER_ACCOUNT}:role/PapercuspWorkspaceHost-ws1`;
const ORG_ROLE = organizationDelegationRoleArn('org-a', CONTROL_ACCOUNT);
const ORG_EXTERNAL_ID = organizationExternalId('org-a');
const ENV = {
  [HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ENV]: CONTROL_ACCOUNT,
  [HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ENV]: CONTROL_PRINCIPAL,
};
const ROOT = async (): Promise<Creds> => ({ accessKeyId: CONTROL_PRINCIPAL, secretAccessKey: 'control-plane-secret' });

/**
 * The trust policies as deployed: the org role trusts only the control plane; the customer role
 * (from the onboarding template) trusts only the org role, with the org's ExternalId.
 */
function deployedTrust(options: {
  customerExternalId?: string;
  enforceExternalId?: boolean;
  orgRoleTrustsControlPlane?: boolean;
} = {}) {
  return (roleArn: string, caller: string, externalId: string | undefined): boolean => {
    if (roleArn === ORG_ROLE) return caller === CONTROL_PRINCIPAL && (options.orgRoleTrustsControlPlane ?? true);
    if (roleArn === CUSTOMER_ROLE) {
      if (caller !== ORG_ROLE) return false;
      return options.enforceExternalId === false || externalId === (options.customerExternalId ?? ORG_EXTERNAL_ID);
    }
    return false;
  };
}

/** STS as the SDK drives it: resolve the client's credentials, then serve the command. */
function stsFake(options: { identity?: { Account: string; Arn: string }; probeError?: Error } = {}) {
  return (credentials: unknown): HostedAwsSender => ({
    async send(command) {
      const caller = (await (credentials as () => Promise<Creds>)()).accessKeyId;
      if (command instanceof GetCallerIdentityCommand) {
        const account = caller.split(':')[4];
        return {
          ...(options.identity ?? {
            Account: account,
            Arn: `arn:aws:sts::${account}:assumed-role/${caller.split('/').pop()}/papercusp-workspace-host`,
          }),
          $metadata: { requestId: 'req-123' },
        };
      }
      if (command instanceof AssumeRoleCommand) {
        const input = command.input;
        sim.hops.push({ roleArn: input.RoleArn ?? '', externalId: input.ExternalId, as: caller });
        if (options.probeError) throw options.probeError;
        if (!sim.trust(input.RoleArn ?? '', caller, input.ExternalId)) throw accessDenied();
        return { Credentials: { AccessKeyId: 'ASIA-PROBE' } };
      }
      throw new Error('unexpected STS command');
    },
  });
}

function recorder(respond: (command: unknown) => unknown = () => ({})): HostedAwsSender & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    async send(command) {
      sent.push(command);
      return respond(command);
    },
  };
}

function awsError(name: string): Error {
  return Object.assign(new Error(name), { name });
}

function record(overrides: {
  trustedPrincipalArn?: string;
  externalIdRef?: string;
  method?: 'customer-role' | 'oidc';
} = {}): HostedProviderDelegationRecord {
  const source = overrides.method === 'oidc'
    ? {
      environment: 'hosted' as const,
      method: 'oidc' as const,
      roleArn: CUSTOMER_ROLE,
      issuer: 'https://app.papercusp.com/oidc',
      audience: 'sts.amazonaws.com',
      subject: 'workspace:workspace-1',
    }
    : {
      environment: 'hosted' as const,
      method: 'customer-role' as const,
      roleArn: CUSTOMER_ROLE,
      trustedPrincipalArn: overrides.trustedPrincipalArn ?? ORG_ROLE,
      externalIdRef: overrides.externalIdRef ?? organizationExternalIdRef('org-a'),
    };
  return {
    schemaVersion: 'hosted-provider-delegation-v1',
    organizationId: 'org-a',
    workspaceId: 'workspace-1',
    connectionId: 'connection-1',
    label: 'AWS production',
    provider: 'aws',
    credentialRef: 'encrypted://workspace-1/cloud/connection-1',
    generation: 3,
    status: 'pending',
    configuration: { provider: 'aws', accountId: CUSTOMER_ACCOUNT, source } as HostedProviderDelegationRecord['configuration'],
    templateDigest: 'sha256:test',
    createdAt: '2026-10-02T00:00:00.000Z',
    updatedAt: '2026-10-02T00:00:00.000Z',
  };
}

const adapter = (options: Parameters<typeof stsFake>[0] = {}) =>
  awsProviderDelegationAdapter({ env: ENV, controlPlaneCredentials: ROOT as never, sts: stsFake(options) as never });

beforeEach(() => {
  sim.hops.length = 0;
  sim.trust = deployedTrust();
});

describe('hosted AWS identity (D-001, D-007)', () => {
  it('derives a stable, per-organization role name and ARN under the organization path', () => {
    const name = organizationDelegationRoleName('org-a');
    expect(name).toMatch(/^pco-[0-9a-f]{24}$/);
    expect(organizationDelegationRoleName('org-a')).toBe(name);
    expect(organizationDelegationRoleName('org-b')).not.toBe(name);
    expect(ORG_ROLE).toBe(`arn:aws:iam::${CONTROL_ACCOUNT}:role/papercusp/orgs/${name}`);
    expect(organizationDelegationRoleArn('org-a', CONTROL_ACCOUNT, 'aws-us-gov')).toMatch(/^arn:aws-us-gov:iam::/);
    expect(() => organizationDelegationRoleArn('org-a', '12345')).toThrow('aws_workspace_host_control_plane_account_invalid');
    expect(() => organizationDelegationRoleName('bad org id')).toThrow('aws_workspace_host_organization_invalid');
  });

  it('derives the ExternalId from the organization alone, and resolves only our own references', async () => {
    expect(ORG_EXTERNAL_ID).toMatch(/^pcx-[0-9a-f]{40}$/);
    expect(organizationExternalId('org-a')).toBe(ORG_EXTERNAL_ID);
    expect(organizationExternalId('org-b')).not.toBe(ORG_EXTERNAL_ID);
    // Not the role digest: a customer who can see the role ARN learns nothing about the ExternalId.
    expect(ORG_EXTERNAL_ID.slice(4, 28)).not.toBe(organizationDelegationRoleName('org-a').slice(4));

    const ref = organizationExternalIdRef('org-a');
    expect(ref).toBe('resolver://aws-external-id/org-a');
    expect(externalIdRefOrganization(ref)).toBe('org-a');
    await expect(resolveOrganizationExternalIdRef(ref)).resolves.toBe(ORG_EXTERNAL_ID);
    expect(externalIdRefOrganization('encrypted://workspace-1/aws/external-id')).toBeNull();
    await expect(resolveOrganizationExternalIdRef('encrypted://workspace-1/aws/external-id'))
      .rejects.toThrow('aws_workspace_host_external_id_ref_unrecognized');
  });

  it('refuses an unconfigured or malformed control plane', () => {
    expect(() => hostedAwsControlPlaneAccount({})).toThrow('aws_workspace_host_control_plane_account_unconfigured');
    expect(() => hostedAwsControlPlaneAccount({ [HOSTED_AWS_CONTROL_PLANE_ACCOUNT_ENV]: 'abc' }))
      .toThrow('aws_workspace_host_control_plane_account_invalid');
    expect(hostedAwsControlPlaneAccount(ENV)).toBe(CONTROL_ACCOUNT);
    expect(() => hostedAwsControlPlanePrincipal({})).toThrow('aws_workspace_host_control_plane_principal_unconfigured');
    expect(() => hostedAwsControlPlanePrincipal({ [HOSTED_AWS_CONTROL_PLANE_PRINCIPAL_ENV]: 'arn:aws:s3:::bucket' }))
      .toThrow('aws_workspace_host_control_plane_principal_invalid');
    expect(hostedAwsControlPlanePrincipal(ENV)).toBe(CONTROL_PRINCIPAL);
  });
});

describe('ensureOrganizationDelegationRole', () => {
  const input = (iam: HostedAwsSender) => ({
    organizationId: 'org-a',
    accountId: CONTROL_ACCOUNT,
    controlPlanePrincipalArn: CONTROL_PRINCIPAL,
    iam,
  });

  it('creates the role trusting only the control plane, then attaches the customer-role chain policy', async () => {
    const iam = recorder();
    await expect(ensureOrganizationDelegationRole(input(iam))).resolves.toBe(ORG_ROLE);
    expect(iam.sent.map((command) => (command as object).constructor.name)).toEqual(['CreateRoleCommand', 'PutRolePolicyCommand']);
    const create = (iam.sent[0] as CreateRoleCommand).input;
    expect(create.RoleName).toBe(organizationDelegationRoleName('org-a'));
    expect(create.Path).toBe('/papercusp/orgs/');
    expect(JSON.parse(create.AssumeRolePolicyDocument ?? '{}').Statement).toEqual([
      { Effect: 'Allow', Principal: { AWS: CONTROL_PRINCIPAL }, Action: 'sts:AssumeRole' },
    ]);
    const chain = (iam.sent[1] as PutRolePolicyCommand).input;
    expect(JSON.parse(chain.PolicyDocument ?? '{}').Statement).toEqual([
      { Effect: 'Allow', Action: 'sts:AssumeRole', Resource: 'arn:aws:iam::*:role/PapercuspWorkspaceHost-*' },
    ]);
  });

  it('re-asserts the trust policy of an existing role instead of trusting whatever is there', async () => {
    const iam = recorder((command) => {
      if (command instanceof CreateRoleCommand) throw awsError('EntityAlreadyExistsException');
      return {};
    });
    await ensureOrganizationDelegationRole(input(iam));
    expect(iam.sent.map((command) => (command as object).constructor.name))
      .toEqual(['CreateRoleCommand', 'UpdateAssumeRolePolicyCommand', 'PutRolePolicyCommand']);
    const update = (iam.sent[1] as UpdateAssumeRolePolicyCommand).input;
    expect(JSON.parse(update.PolicyDocument ?? '{}').Statement[0].Principal).toEqual({ AWS: CONTROL_PRINCIPAL });
  });

  it('fails without attaching anything when IAM refuses for another reason', async () => {
    const iam = recorder((command) => {
      if (command instanceof CreateRoleCommand) throw awsError('AccessDenied');
      return {};
    });
    await expect(ensureOrganizationDelegationRole(input(iam))).rejects.toThrow('AccessDenied');
    expect(iam.sent).toHaveLength(1);
  });
});

describe('awsDelegationOrganization', () => {
  it("returns the organization's own role and ExternalId reference, creating the role on first use", async () => {
    const iam = recorder();
    const binding = await awsDelegationOrganization('org-a', { env: ENV, iam }).awsTrustedPrincipal();
    expect(binding).toEqual({ principalArn: ORG_ROLE, externalIdRef: 'resolver://aws-external-id/org-a' });
    expect(iam.sent[0]).toBeInstanceOf(CreateRoleCommand);
  });

  it('fails closed when the control-plane account is not configured', async () => {
    await expect(awsDelegationOrganization('org-a', { env: {}, iam: recorder() }).awsTrustedPrincipal())
      .rejects.toThrow('aws_workspace_host_control_plane_account_unconfigured');
  });
});

describe('awsProviderDelegationAdapter.verify — the real role chain', () => {
  it("AWSP-P-008-role-chain / AUTO-BAR-R-5-P-008: succeeds only through control plane -> the org's own role -> the customer role with the org's ExternalId", async () => {
    const result = await adapter().verify(record());
    expect(result.identity).toBe(`arn:aws:sts::${CUSTOMER_ACCOUNT}:assumed-role/PapercuspWorkspaceHost-ws1/papercusp-workspace-host`);
    expect(result.evidenceRef).toBe(`aws://accounts/${CUSTOMER_ACCOUNT}/delegations/connection-1/3/sts/req-123`);
    expect(sim.hops).toEqual([
      // The chain the connection will use: two hops, the second carrying the org's ExternalId.
      { roleArn: ORG_ROLE, externalId: undefined, as: CONTROL_PRINCIPAL },
      { roleArn: CUSTOMER_ROLE, externalId: ORG_EXTERNAL_ID, as: ORG_ROLE },
      // The enforcement probe: the same org role, the same customer role, NO ExternalId — refused.
      { roleArn: ORG_ROLE, externalId: undefined, as: CONTROL_PRINCIPAL },
      { roleArn: CUSTOMER_ROLE, externalId: undefined, as: ORG_ROLE },
    ]);
  });

  it("AWSP-P-008-externalid-mismatch: is refused when the customer role rejects the organization's ExternalId", async () => {
    sim.trust = deployedTrust({ customerExternalId: organizationExternalId('org-b') });
    await expect(adapter().verify(record())).rejects.toThrow('AccessDenied');
    expect(sim.hops).toEqual([
      { roleArn: ORG_ROLE, externalId: undefined, as: CONTROL_PRINCIPAL },
      { roleArn: CUSTOMER_ROLE, externalId: ORG_EXTERNAL_ID, as: ORG_ROLE },
    ]);
  });

  it('AUTO-BAR-R-5-P-008: is refused when the first hop (control plane -> org role) is denied, and never reaches the customer', async () => {
    sim.trust = deployedTrust({ orgRoleTrustsControlPlane: false });
    await expect(adapter().verify(record())).rejects.toThrow('AccessDenied');
    expect(sim.hops).toEqual([{ roleArn: ORG_ROLE, externalId: undefined, as: CONTROL_PRINCIPAL }]);
  });

  it('marks the delegation invalid when the customer role does NOT enforce the ExternalId', async () => {
    sim.trust = deployedTrust({ enforceExternalId: false });
    await expect(adapter().verify(record())).rejects.toThrow('hosted_provider_delegation_aws_external_id_not_enforced');
  });

  it('does not read an unrelated probe failure as enforcement', async () => {
    await expect(adapter({ probeError: awsError('ThrottlingException') }).verify(record())).rejects.toThrow('ThrottlingException');
  });

  it('refuses a chain that lands in another account or as another role', async () => {
    await expect(adapter({ identity: { Account: '210987654321', Arn: 'arn:aws:sts::210987654321:assumed-role/PapercuspWorkspaceHost-ws1/s' } })
      .verify(record())).rejects.toThrow('hosted_provider_delegation_aws_account_mismatch');
    await expect(adapter({ identity: { Account: CUSTOMER_ACCOUNT, Arn: `arn:aws:sts::${CUSTOMER_ACCOUNT}:assumed-role/SomeOtherRole/s` } })
      .verify(record())).rejects.toThrow('hosted_provider_delegation_aws_role_mismatch');
  });

  it("refuses, before calling AWS, a record bound to another organization's principal or ExternalId, or to OIDC", async () => {
    await expect(adapter().verify(record({ trustedPrincipalArn: organizationDelegationRoleArn('org-b', CONTROL_ACCOUNT) })))
      .rejects.toThrow('hosted_provider_delegation_aws_principal_not_organization');
    await expect(adapter().verify(record({ externalIdRef: organizationExternalIdRef('org-b') })))
      .rejects.toThrow('hosted_provider_delegation_aws_external_id_not_organization');
    await expect(adapter().verify(record({ method: 'oidc' })))
      .rejects.toThrow('hosted_provider_delegation_aws_method_not_organization_bound');
    expect(sim.hops).toEqual([]);
  });

  it('records a revocation as delegation evidence', async () => {
    await expect(adapter().revoke(record())).resolves.toEqual({ evidenceRef: 'delegation://workspace-1/connection-1/3/revoked' });
  });
});
