import type { Sql } from 'postgres';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationSqlRunner,
} from '../workspace-host/hosted-provider-delegation';

/** Persist the active phase before starting work that may never settle. */
export function publicManualHostedPhaseRecorder(persist: (phase: {
  stage: string; state: 'running' | 'complete' | 'failed'; startedAt: string; errorCode?: string;
}) => void) {
  return async <T>(stage: string, operation: () => Promise<T>): Promise<T> => {
    const startedAt = new Date().toISOString();
    persist({ stage, state: 'running', startedAt });
    try {
      const result = await operation();
      persist({ stage, state: 'complete', startedAt });
      return result;
    } catch (error) {
      persist({ stage, state: 'failed', startedAt, errorCode: 'hosted_fixture_phase_failed' });
      throw error;
    }
  };
}

export interface PublicManualHostedFixtureBinding {
  controlPlaneWorkspaceId: string;
  organizationId: string;
  customerWorkspaceId: string;
  hostId: string;
  connectionId: string;
}

/** A private test host is verified by its own HTTP response, never by a cloud claim. */
export async function preparePublicManualHostedDelegation(
  binding: PublicManualHostedFixtureBinding,
  run: HostedProviderDelegationSqlRunner,
  operatorOrigin: string,
  expectedSha: string,
) {
  const origin = new URL(operatorOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.username || origin.password) throw new Error('hosted_fixture_operator_not_loopback');
  if (!/^[a-f0-9]{10,40}$/.test(expectedSha)) throw new Error('hosted_fixture_operator_sha_required');
  const unsupported = async (): Promise<never> => { throw new Error('hosted_fixture_cloud_provider_not_permitted'); };
  const organization: HostedDelegationOrganization = {
    organizationId: binding.organizationId,
    gcpTrustedPrincipal: unsupported,
    awsTrustedPrincipal: unsupported,
    awsPapercuspHosting: unsupported,
    gcpPapercuspHosting: async hostId => {
      if (hostId !== binding.hostId) throw new Error('hosted_fixture_reserved_host_mismatch');
      return { projectId: 'public-manual-private-fixture',
        serviceAccountEmail: 'private-fixture@public-manual-private-fixture.iam.gserviceaccount.com' };
    },
  };
  const adapter: HostedProviderDelegationAdapter = {
    verify: async record => {
      if (record.workspaceId !== binding.customerWorkspaceId || record.connectionId !== binding.connectionId
        || record.organizationId !== binding.organizationId || record.configuration.provider !== 'gcp'
        || record.configuration.source.method !== 'papercusp-hosted'
        || record.configuration.source.hostId !== binding.hostId) throw new Error('hosted_fixture_delegation_binding_mismatch');
      const response = await fetch(new URL('/api/health', origin), {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      const health = await response.json();
      if (!response.ok || typeof health.sha !== 'string'
        || !expectedSha.startsWith(health.sha) || health.sha.length < 10)
        throw new Error('hosted_fixture_operator_health_mismatch');
      return { identity: `private-loopback:${binding.hostId}`,
        evidenceRef: `fixture://loopback-health/${binding.hostId}/${health.sha}` };
    },
    revoke: async () => ({ evidenceRef: `fixture://delegation-revoked/${binding.hostId}` }),
  };
  const manager = new HostedProviderDelegationManager(
    new PostgresHostedProviderDelegationStore(run, binding.controlPlaneWorkspaceId),
    { gcp: adapter, aws: adapter, azure: adapter }, organization,
  );
  await manager.onboardPapercuspHosted({ workspaceId: binding.customerWorkspaceId,
    connectionId: binding.connectionId, label: 'Disposable private manual operator',
    credentialRef: `delegation://private-fixture/${binding.hostId}` }, binding.hostId);
  const record = await manager.verify(binding.customerWorkspaceId, binding.connectionId);
  return { record, close: () => manager.revoke(binding.customerWorkspaceId, binding.connectionId) };
}

/** Production keeps revoked audit records; a disposable TEST workspace must remove its own. */
export async function purgePublicManualHostedConnector(
  run: <T>(fn: (sql: Sql) => Promise<T>) => Promise<T>,
  binding: Omit<PublicManualHostedFixtureBinding, 'connectionId'> & { routeLabel: string },
) {
  return run(sql => sql`
    DELETE FROM papercusp_auth.hosted_workspace_connectors
    WHERE control_workspace_id=${binding.controlPlaneWorkspaceId} AND organization_id=${binding.organizationId}
      AND customer_workspace_id=${binding.customerWorkspaceId} AND host_id=${binding.hostId}
      AND route_label=${binding.routeLabel}
  `);
}
