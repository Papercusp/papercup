import { describe, expect, it, vi } from 'vitest';
import {
  bindPapercuspHostedDelegation,
  buildHostedProviderDelegationOnboarding,
  type HostedProviderDelegationConfiguration,
  type HostedProviderDelegationRecord,
} from '../../workspace-host/hosted-provider-delegation';
import {
  createHostedFirstWorkspace,
  firstWorkspaceIdentity,
  gcpFirstWorkspaceDesiredSpec,
  type HostedFirstWorkspaceDependencies,
  type HostedFirstWorkspaceRequest,
} from './first-workspace';
import { HostedGcpNotReadyError } from '../../workspace-host/hosted-gcp-hosting';
import { HostedWorkspaceAdmissionError } from './workspace-admission';

const GCP: HostedProviderDelegationConfiguration = {
  provider: 'gcp',
  source: {
    method: 'service-account-impersonation',
    projectId: 'customer-project-1',
    serviceAccountEmail: 'papercusp-host@customer-project-1.iam.gserviceaccount.com',
    trustedPrincipal: 'serviceAccount:control-plane@papercusp.iam.gserviceaccount.com',
  },
};

/** Each organization's own Papercusp account (D-397) — deliberately NOT the GCP fixture's value. */
const orgPrincipal = (organizationId: string) =>
  `serviceAccount:pco-${organizationId}@papercusp-identity.iam.gserviceaccount.com`;
const SERVER_PRINCIPAL = orgPrincipal('org-a');
const HOSTING_PROJECT = 'papercusp-hosted-workspaces';

const REQUEST: HostedFirstWorkspaceRequest = {
  organizationId: 'org-a',
  userId: 'user-a',
  sessionId: 'session-a',
  sessionVersion: 3,
  attemptKey: 'attempt-0123456789abcdef',
  displayName: 'My workspace',
  label: 'My GCP project',
  hosting: 'byoc',
  configuration: GCP,
};

const PAPERCUSP_REQUEST: HostedFirstWorkspaceRequest = { ...REQUEST, hosting: 'papercusp', configuration: undefined };

function harness(overrides: Partial<HostedFirstWorkspaceDependencies> = {}) {
  const records = new Map<string, HostedProviderDelegationRecord>();
  const ensureProvisioned = vi.fn(async (input: { requestedWorkspaceId?: string }) => ({
    workspaceId: input.requestedWorkspaceId as string,
    provisionOperationId: 'prov-op',
  }));
  const resolvedSpecs: unknown[] = [];
  const reserved: string[] = [];
  const deps: HostedFirstWorkspaceDependencies = {
    isEnabledFor: (organizationId) => organizationId === 'org-a',
    provisioningAvailable: () => true,
    delegationOrganization: (organizationId) => ({
      organizationId,
      gcpTrustedPrincipal: async () => orgPrincipal(organizationId),
      gcpPapercuspHosting: async (hostId) => {
        reserved.push(hostId);
        return {
          projectId: HOSTING_PROJECT,
          serviceAccountEmail: orgPrincipal(organizationId).slice('serviceAccount:'.length),
        };
      },
    }),
    organizationWorkspaceIds: async () => [],
    readDelegation: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
    onboardDelegation: vi.fn(async (input) => {
      const onboarding = buildHostedProviderDelegationOnboarding(input);
      records.set(`${input.workspaceId}/${input.connectionId}`, onboarding.record);
      return onboarding;
    }),
    onboardPapercuspHostedDelegation: vi.fn(async (organizationId, input, hostId) => {
      const onboarding = buildHostedProviderDelegationOnboarding(
        await bindPapercuspHostedDelegation(input, deps.delegationOrganization(organizationId), hostId),
      );
      records.set(`${input.workspaceId}/${input.connectionId}`, onboarding.record);
      return onboarding;
    }),
    verifyDelegation: vi.fn(async (organizationId: string, workspaceId: string, connectionId: string) => {
      const record = records.get(`${workspaceId}/${connectionId}`);
      if (!record || record.organizationId !== organizationId) throw new Error('missing');
      return { ...record, status: 'verified' as const };
    }),
    createAdmission: (resolveDesiredSpec) => ({
      async ensureProvisioned(input) {
        resolvedSpecs.push(
          await resolveDesiredSpec({
            organizationId: input.organizationId,
            provider: input.provider,
            connectionId: input.connectionId,
            hostId: firstWorkspaceIdentity(input.organizationId, REQUEST.attemptKey).hostId,
            displayName: input.displayName,
          }),
        );
        return ensureProvisioned(input);
      },
      resolveSelectable: async () => true,
    }),
    selectWorkspace: vi.fn(async () => ({ sessionId: 'session-rotated', expiresAt: new Date('2030-01-01T00:00:00Z') })),
    ...overrides,
  };
  return { deps, records, ensureProvisioned, resolvedSpecs, reserved };
}

describe('hosted first-workspace bootstrap (D-384)', () => {
  it('derives every identifier from the organization, so two organizations never collide', () => {
    const a = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    const b = firstWorkspaceIdentity('org-b', REQUEST.attemptKey);
    expect(a.workspaceId).not.toBe(b.workspaceId);
    expect(a.connectionId).not.toBe(b.connectionId);
    expect(a.credentialRef).toBe(`delegation://${a.workspaceId}/${a.connectionId}`);
    expect(firstWorkspaceIdentity('org-a', REQUEST.attemptKey)).toEqual(a);
  });

  it('records the delegation, admits the workspace, and selects it on the session', async () => {
    const { deps, ensureProvisioned, resolvedSpecs } = harness();
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result).toMatchObject({
      ok: true,
      workspaceId: identity.workspaceId,
      connectionId: identity.connectionId,
      sessionId: 'session-rotated',
    });
    expect(ensureProvisioned).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-a', connectionId: identity.connectionId }),
    );
    expect(deps.selectWorkspace).toHaveBeenCalledWith({
      sessionId: 'session-a',
      workspaceId: identity.workspaceId,
      expectedPermissionVersion: 3,
    });
    // The provisioned host runs in the CUSTOMER's project under the derived delegation ref.
    expect(resolvedSpecs[0]).toMatchObject({
      hostId: identity.hostId,
      scope: { kind: 'project', id: 'customer-project-1' },
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
    });
  });

  it('refuses an organization that is not enabled, before any write', async () => {
    const { deps } = harness();
    const result = await createHostedFirstWorkspace(deps).run({ ...REQUEST, organizationId: 'org-z' });
    expect(result).toMatchObject({ ok: false, code: 'first_workspace_not_enabled', status: 403 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it('returns the grant template while the delegation is not yet verifiable', async () => {
    const { deps, ensureProvisioned } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_pending', status: 409, retryable: true });
    expect(result.ok === false && result.template?.document).toBeTruthy();
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it('re-uses the recorded delegation on replay and refuses a replay that changes the grant', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    await bootstrap.run(REQUEST);
    await bootstrap.run(REQUEST);
    expect(deps.onboardDelegation).toHaveBeenCalledTimes(1);

    const changed = await bootstrap.run({
      ...REQUEST,
      configuration: { ...GCP, source: { ...GCP.source, projectId: 'someone-elses-project' } } as never,
    });
    expect(changed).toMatchObject({ ok: false, code: 'delegation_conflict', status: 409 });
  });

  it('refuses a second workspace but lets a replay finish selecting its own', async () => {
    const own = firstWorkspaceIdentity('org-a', REQUEST.attemptKey).workspaceId;
    const replay = await createHostedFirstWorkspace(harness({ organizationWorkspaceIds: async () => [own] }).deps)
      .run(REQUEST);
    expect(replay.ok).toBe(true);

    const other = await createHostedFirstWorkspace(harness({ organizationWorkspaceIds: async () => ['ws-other'] }).deps)
      .run(REQUEST);
    expect(other).toMatchObject({ ok: false, code: 'organization_already_has_workspace', status: 409 });
  });

  it('refuses, not fails, when a concurrent attempt took the organization\'s one slot (D-397)', async () => {
    const { deps } = harness({
      createAdmission: () => ({
        ensureProvisioned: async () => {
          throw new HostedWorkspaceAdmissionError('organization already has a live workspace', 'organization_has_live_workspace');
        },
        resolveSelectable: async () => true,
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'organization_already_has_workspace', status: 409, retryable: false });
    expect(deps.selectWorkspace).not.toHaveBeenCalled();
  });

  it('does not admit a workspace that cannot be provisioned', async () => {
    const { deps, ensureProvisioned } = harness({ provisioningAvailable: () => false });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'provisioning_unavailable', status: 503 });
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("grants to the ORGANIZATION's own principal, whatever trustedPrincipal the browser sent (D-397)", async () => {
    const { deps, records } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    const recorded = records.get(`${identity.workspaceId}/${identity.connectionId}`);
    expect(recorded?.organizationId).toBe('org-a');
    expect(recorded?.configuration.source).toMatchObject({ trustedPrincipal: SERVER_PRINCIPAL });
    expect(JSON.stringify(result.ok === false && result.template)).toContain(SERVER_PRINCIPAL);
    // The browser-sent principal (the GCP fixture's) never reaches the grant.
    expect(JSON.stringify(result)).not.toContain('control-plane@papercusp');
  });

  it('gives two organizations naming the SAME customer account two different grants', async () => {
    const both = harness({
      isEnabledFor: () => true,
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const bootstrap = createHostedFirstWorkspace(both.deps);
    const a = await bootstrap.run(REQUEST);
    const b = await bootstrap.run({ ...REQUEST, organizationId: 'org-b' });
    const grantA = JSON.stringify(a.ok === false && a.template);
    const grantB = JSON.stringify(b.ok === false && b.template);
    expect(grantA).toContain(orgPrincipal('org-a'));
    expect(grantB).toContain(orgPrincipal('org-b'));
    expect(grantB).not.toContain(orgPrincipal('org-a'));
  });

  it('refuses workload identity, which every organization would share (D-397)', async () => {
    const { deps } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...REQUEST,
      configuration: { provider: 'gcp', source: { ...GCP.source, method: 'workload-identity' } } as never,
    });
    expect(result).toMatchObject({ ok: false, code: 'provider_not_supported', status: 422 });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });

  it("fails closed, before recording anything, when the organization's account cannot be prepared", async () => {
    const { deps } = harness({
      delegationOrganization: (organizationId) => ({
        organizationId,
        gcpTrustedPrincipal: async () => {
          throw new Error('gcp_workspace_host_organization_identity_project_unconfigured');
        },
        gcpPapercuspHosting: async () => {
          throw new Error('gcp_workspace_host_organization_identity_project_unconfigured');
        },
      }),
    });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'delegation_source_unavailable', status: 503, retryable: true });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
    // The response carries no cause, so the log is the only place an operator can find it.
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('delegation bind failed'), expect.any(Error));
    logged.mockRestore();
  });

  it('rejects a malformed attempt key and non-GCP providers', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(await bootstrap.run({ ...REQUEST, attemptKey: 'short' })).toMatchObject({ code: 'invalid_request' });
    expect(
      await bootstrap.run({ ...REQUEST, configuration: { provider: 'aws' } as never }),
    ).toMatchObject({ code: 'provider_not_supported' });
  });

  it('builds a GCP spec only from a GCP delegation', () => {
    const record = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
      configuration: GCP,
    }).record;
    expect(gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record })).toMatchObject({ target: 'gcp', hostId: 'host-1' });
  });

  it('rejects a missing or unknown hosting choice, and bring-your-own-cloud without a configuration', async () => {
    const { deps } = harness();
    const bootstrap = createHostedFirstWorkspace(deps);
    expect(await bootstrap.run({ ...REQUEST, hosting: undefined as never })).toMatchObject({ code: 'invalid_request' });
    expect(await bootstrap.run({ ...REQUEST, hosting: 'someone-else' as never })).toMatchObject({ code: 'invalid_request' });
    expect(await bootstrap.run({ ...REQUEST, configuration: undefined })).toMatchObject({ code: 'invalid_request' });
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
  });
});

describe("hosted first-workspace in Papercusp's cloud (D-399)", () => {
  it('reserves the derived host, provisions it in the hosting project with no machine identity, and selects it', async () => {
    const { deps, records, resolvedSpecs, reserved } = harness();
    const result = await createHostedFirstWorkspace(deps).run(PAPERCUSP_REQUEST);
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result).toMatchObject({ ok: true, workspaceId: identity.workspaceId, sessionId: 'session-rotated' });
    // Reserved to plan the grant, again by the manager that records it (it never takes the
    // configuration from its caller), and re-asserted once the workspace is admitted.
    expect(reserved).toEqual([identity.hostId, identity.hostId, identity.hostId]);
    expect(deps.onboardPapercuspHostedDelegation).toHaveBeenCalledWith('org-a', expect.anything(), identity.hostId);
    // The general entry refuses this method by design (the D-399 binder guard); it must not be used.
    expect(deps.onboardDelegation).not.toHaveBeenCalled();
    expect(records.get(`${identity.workspaceId}/${identity.connectionId}`)?.configuration).toEqual({
      provider: 'gcp',
      source: {
        method: 'papercusp-hosted',
        projectId: HOSTING_PROJECT,
        serviceAccountEmail: SERVER_PRINCIPAL.slice('serviceAccount:'.length),
        hostId: identity.hostId,
      },
    });
    expect(resolvedSpecs[0]).toMatchObject({
      hostId: identity.hostId,
      scope: { kind: 'project', id: HOSTING_PROJECT },
      region: 'us-central1',
      zone: 'us-central1-c',
      credentials: { cloudCredentialRef: { kind: 'cloud', ref: identity.credentialRef } },
      provider: { projectId: HOSTING_PROJECT, network: { mode: 'managed' } },
    });
    expect((resolvedSpecs[0] as { provider: Record<string, unknown> }).provider).not.toHaveProperty('serviceAccountEmail');
  });

  it("ignores any configuration the browser sends: no request can steer Papercusp's cloud", async () => {
    const { deps, records, reserved } = harness();
    const result = await createHostedFirstWorkspace(deps).run({
      ...PAPERCUSP_REQUEST,
      configuration: {
        provider: 'gcp',
        source: {
          method: 'papercusp-hosted',
          projectId: 'attacker-project',
          serviceAccountEmail: 'pco-org-b@papercusp-identity.iam.gserviceaccount.com',
          hostId: 'host-of-org-b',
        },
      },
    });
    const identity = firstWorkspaceIdentity('org-a', REQUEST.attemptKey);
    expect(result.ok).toBe(true);
    expect(reserved).not.toContain('host-of-org-b');
    expect(JSON.stringify(records.get(`${identity.workspaceId}/${identity.connectionId}`))).not.toMatch(
      /attacker-project|org-b/,
    );
  });

  it('asks the browser to retry, with nothing to apply, while the reservation propagates', async () => {
    const { deps, ensureProvisioned } = harness({
      verifyDelegation: vi.fn(async () => {
        throw new Error('hosted_provider_delegation_verification_failed');
      }),
    });
    const result = await createHostedFirstWorkspace(deps).run(PAPERCUSP_REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', status: 409, retryable: true });
    expect(result.ok === false && result.template).toBeUndefined();
    expect(ensureProvisioned).not.toHaveBeenCalled();
  });

  it("waits out GCP catching up with a brand-new organization's account, and still fails on a real refusal", async () => {
    const organization = (error: Error) => (organizationId: string) => ({
      organizationId,
      gcpTrustedPrincipal: async () => 'serviceAccount:unused@x.iam.gserviceaccount.com',
      gcpPapercuspHosting: async () => {
        throw error;
      },
    });
    const lagging = harness({
      delegationOrganization: organization(new HostedGcpNotReadyError('policy_write_failed:400:Service account pco-x does not exist.')),
    });
    const waiting = await createHostedFirstWorkspace(lagging.deps).run(PAPERCUSP_REQUEST);
    expect(waiting).toMatchObject({ ok: false, code: 'papercusp_cloud_preparing', status: 409, retryable: true });
    expect(lagging.deps.onboardDelegation).not.toHaveBeenCalled();

    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = harness({ delegationOrganization: organization(new Error('policy_write_failed:403:denied')) });
    const failed = await createHostedFirstWorkspace(refused.deps).run(PAPERCUSP_REQUEST);
    expect(failed).toMatchObject({ ok: false, code: 'delegation_source_unavailable', status: 503, retryable: true });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockRestore();
  });

  it('refuses a spec for a host other than the one the delegation reserves', () => {
    const record = buildHostedProviderDelegationOnboarding({
      organizationId: 'org-a',
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
      configuration: {
        provider: 'gcp',
        source: {
          method: 'papercusp-hosted',
          projectId: HOSTING_PROJECT,
          serviceAccountEmail: 'pco-a@papercusp-identity.iam.gserviceaccount.com',
          hostId: 'host-1',
        },
      },
    }).record;
    expect(() => gcpFirstWorkspaceDesiredSpec({ hostId: 'host-2', record })).toThrow(HostedWorkspaceAdmissionError);
    expect(gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record })).toMatchObject({ hostId: 'host-1' });
  });
});
