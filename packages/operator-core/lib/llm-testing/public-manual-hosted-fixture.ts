import type { Sql } from 'postgres';
import type { IncomingMessage } from 'node:http';
import { withTimeout } from '../../../../libs/testing-shell/src/llm/runner';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedDelegationOrganization,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationSqlRunner,
} from '../workspace-host/hosted-provider-delegation';

/** Mirror the hosted socket authority at an explicitly private fixture ingress. */
export function publicManualHostedUpgradeHeaders(
  request: Pick<IncomingMessage, 'url' | 'headers'>, publicOrigin: string,
): IncomingMessage['headers'] {
  const origin = new URL(publicOrigin);
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['localhost', '127.0.0.1'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash)
    throw new Error('hosted_fixture_upgrade_origin_not_loopback');
  // This is only the fixture's connector ingress. HTTP cookie/origin checks,
  // foreign authorities and every other upgrade retain their original headers.
  if (request.url?.split('?')[0] !== '/api/hosted/connectors/socket'
    || request.headers.host !== origin.host) return request.headers;
  return { ...request.headers, host: 'app.papercusp.com' };
}

/** Persist the active phase before starting work that may never settle. */
export function publicManualHostedPhaseRecorder(persist: (phase: {
  stage: string; state: 'running' | 'complete' | 'failed'; startedAt: string; errorCode?: string;
}) => void) {
  return async <T>(stage: string, operation: () => Promise<T>, readOnlyTimeoutMs?: number): Promise<T> => {
    const startedAt = new Date().toISOString();
    persist({ stage, state: 'running', startedAt });
    try {
      // Only read-only work may race a timer. Admission and cleanup must settle
      // so their resource owner cannot disappear behind a rejected promise.
      const pending = operation();
      const result = readOnlyTimeoutMs === undefined ? await pending
        : await withTimeout(pending, readOnlyTimeoutMs, `hosted_fixture_phase:${stage}`);
      persist({ stage, state: 'complete', startedAt });
      return result;
    } catch (error) {
      persist({ stage, state: 'failed', startedAt, errorCode: 'hosted_fixture_phase_failed' });
      throw error;
    }
  };
}

/** Refuse fixture creation when its serving runtime cannot cover work AND cleanup. */
export function assertPublicManualHostedRuntimeBudget(
  deadlines: Array<string | undefined>, now = Date.now(), workMs = 90_000, cleanupMs = 20_000,
) {
  const values = deadlines.filter((value): value is string => value !== undefined);
  if (!values.length || values.length !== deadlines.length || values.some(value => !/^\d+$/.test(value)
    || !Number.isSafeInteger(Number(value)))) throw new Error('hosted_fixture_runtime_deadline_required');
  const remainingMs = Math.min(...values.map(Number)) - now;
  if (remainingMs < workMs + cleanupMs) throw new Error('hosted_fixture_runtime_budget_insufficient');
  return { remainingMs, workMs, cleanupMs };
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
