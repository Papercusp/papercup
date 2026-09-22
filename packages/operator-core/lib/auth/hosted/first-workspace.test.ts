import { describe, expect, it, vi } from 'vitest';
import {
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

const GCP: HostedProviderDelegationConfiguration = {
  provider: 'gcp',
  source: {
    method: 'service-account-impersonation',
    projectId: 'customer-project-1',
    serviceAccountEmail: 'papercusp-host@customer-project-1.iam.gserviceaccount.com',
    trustedPrincipal: 'serviceAccount:control-plane@papercusp.iam.gserviceaccount.com',
  },
};

const REQUEST: HostedFirstWorkspaceRequest = {
  organizationId: 'org-a',
  userId: 'user-a',
  sessionId: 'session-a',
  sessionVersion: 3,
  attemptKey: 'attempt-0123456789abcdef',
  displayName: 'My workspace',
  label: 'My GCP project',
  configuration: GCP,
};

function harness(overrides: Partial<HostedFirstWorkspaceDependencies> = {}) {
  const records = new Map<string, HostedProviderDelegationRecord>();
  const ensureProvisioned = vi.fn(async (input: { requestedWorkspaceId?: string }) => ({
    workspaceId: input.requestedWorkspaceId as string,
    provisionOperationId: 'prov-op',
  }));
  const resolvedSpecs: unknown[] = [];
  const deps: HostedFirstWorkspaceDependencies = {
    isEnabledFor: (organizationId) => organizationId === 'org-a',
    provisioningAvailable: () => true,
    organizationWorkspaceIds: async () => [],
    readDelegation: async (workspaceId, connectionId) => records.get(`${workspaceId}/${connectionId}`) ?? null,
    onboardDelegation: vi.fn(async (input) => {
      const onboarding = buildHostedProviderDelegationOnboarding(input);
      records.set(`${input.workspaceId}/${input.connectionId}`, onboarding.record);
      return onboarding;
    }),
    verifyDelegation: vi.fn(async (workspaceId: string, connectionId: string) => {
      const record = records.get(`${workspaceId}/${connectionId}`);
      if (!record) throw new Error('missing');
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
  return { deps, records, ensureProvisioned, resolvedSpecs };
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

  it('does not admit a workspace that cannot be provisioned', async () => {
    const { deps, ensureProvisioned } = harness({ provisioningAvailable: () => false });
    const result = await createHostedFirstWorkspace(deps).run(REQUEST);
    expect(result).toMatchObject({ ok: false, code: 'provisioning_unavailable', status: 503 });
    expect(ensureProvisioned).not.toHaveBeenCalled();
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
      workspaceId: 'ws-1',
      connectionId: 'conn-1',
      label: 'x',
      credentialRef: 'delegation://ws-1/conn-1',
      configuration: GCP,
    }).record;
    expect(gcpFirstWorkspaceDesiredSpec({ hostId: 'host-1', record })).toMatchObject({ target: 'gcp', hostId: 'host-1' });
  });
});
