/** Production composition for the app.papercusp.com hosted control plane. */

import {
  HOSTED_SERVICE_ROLE,
  withHostedServiceContext,
  withTenantContext,
  type VerifiedTenantServerContext,
} from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { PostgresHostedIdentityDirectory, type HostedIdentityDirectory } from '../auth/hosted-identity-binding';
import {
  PostgresHostedMembershipAuthority,
  type HostedMembershipAuthority,
  type HostedMembershipAuthorityReader,
} from '../auth/hosted-membership-authority';
import {
  HostedSessionStore,
  type CreateHostedSessionInput,
  type HostedSession,
  type ResolveHostedSessionOptions,
} from '../auth/hosted-session';
import {
  PostgresWorkosAccessClosureSink,
  PostgresWorkosLifecycleProjectionStore,
  workosLifecycleEventFromReceipt,
  type HostedServiceContextRunner,
} from '../auth/hosted/workos-lifecycle-postgres';
import { WorkosLifecycleWorker } from '../auth/hosted/workos-lifecycle-worker';
import { createWorkOSHostedIdentityProvider } from '../auth/hosted/workos-provider';
import { PostgresWorkOSSealedSessionVault } from '../auth/hosted/workos-session-vault';
import {
  intakeWorkOsWebhook,
  WorkOsWebhookReceiptStore,
  type WorkOsWebhookReceiptSink,
} from '../auth/hosted/workos-webhook-intake';
import { resolveSecretRef } from '../inference-gateway/egress-providers/secret-ref';
import {
  assembleHostedControlPlane,
  type AssembledHostedControlPlane,
  type HostedControlPlaneSessionStore,
} from './hosted-control-plane';
import { HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST, type HostedRouteAllowlistEntry } from './hosted-profile';
import { ALL_ROUTES } from './routes';
import { createWorkOsWebhookRoute } from './routes/auth/workos-webhook';
import { HostedWorkspaceConnectorGateway, PostgresHostedWorkspaceConnectorStore } from './hosted-workspace-connector';
import type { HostedPrincipal } from '../auth/hosted-principal';
import {
  HostedProviderDelegationManager,
  PostgresHostedProviderDelegationStore,
  type HostedProviderDelegationAdapter,
  type HostedProviderDelegationRecord,
} from '../workspace-host/hosted-provider-delegation';
import { resolveHostedGcpAuth } from '../workspace-host/hosted-gcp-auth';

export const HOSTED_CONTROL_PLANE_DISTRIBUTION_PROFILE = 'hosted-control-plane';

export const HOSTED_WORKOS_WEBHOOK_ALLOWLIST_ENTRY = {
  method: 'POST',
  path: '/auth/workos/webhook',
  access: 'public',
} as const satisfies HostedRouteAllowlistEntry;

export const HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS = [
  'GET /health',
  'GET /health/ready',
  'POST /auth/workos/webhook',
  'POST /hosted/workspaces/:workspaceId/connectors/enroll',
  'POST /hosted/workspaces/:workspaceId/connectors/rotate',
  'POST /hosted/workspaces/:workspaceId/connectors/revoke',
  'POST /hosted/workspaces/:workspaceId/connectors/session-ticket',
  'POST /hosted/connectors/register',
  'POST /hosted/connectors/heartbeat',
  'GET /hosted/connectors/events',
  'GET /hosted/connectors/socket',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/onboard',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/verify',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/rotate',
  'POST /hosted/workspaces/:workspaceId/provider-delegations/revoke',
  'GET /hosted/auth/sign-in',
  'GET /hosted/auth/callback',
  'POST /hosted/auth/logout',
  'GET /hosted/auth/session',
] as const;

export interface HostedRuntimeConfiguration {
  readonly publicOrigin: string;
  readonly controlPlaneWorkspaceId: string;
  readonly hostedSessionCookieSecretRef: string;
  readonly workosClientId: string;
  readonly workosApiKeyRef: string;
  readonly workosCookiePasswordRef: string;
  readonly workosWebhookSecretRef: string;
  readonly workosWebhookSignatureKeyRef?: string;
}

export type HostedRuntimeSecretResolver = (reference: string) => Promise<string>;
export type HostedTenantContextRunner = <T>(
  context: VerifiedTenantServerContext,
  fn: (sql: Sql) => Promise<T>,
) => Promise<T>;

export interface HostedRuntimeDependencies {
  readonly resolveSecret?: HostedRuntimeSecretResolver;
  readonly runService?: HostedServiceContextRunner;
  readonly runTenant?: HostedTenantContextRunner;
  readonly providerDelegationAdapters?: Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>>;
}

interface HostedServiceRoleRow {
  readonly current_user: string;
}

function requiredConfiguration(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 1_024) {
    throw new TypeError(`hosted_runtime_configuration_missing:${name}`);
  }
  return value.trim();
}

export function readHostedRuntimeConfiguration(env: NodeJS.ProcessEnv = process.env): HostedRuntimeConfiguration {
  return {
    publicOrigin: requiredConfiguration(env.PAPERCUSP_HOSTED_PUBLIC_ORIGIN, 'PAPERCUSP_HOSTED_PUBLIC_ORIGIN'),
    controlPlaneWorkspaceId: requiredConfiguration(
      env.PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID,
      'PAPERCUSP_HOSTED_CONTROL_PLANE_WORKSPACE_ID',
    ),
    hostedSessionCookieSecretRef: requiredConfiguration(
      env.PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF,
      'PAPERCUSP_HOSTED_SESSION_COOKIE_SECRET_REF',
    ),
    workosClientId: requiredConfiguration(env.WORKOS_CLIENT_ID, 'WORKOS_CLIENT_ID'),
    workosApiKeyRef: requiredConfiguration(env.WORKOS_API_KEY_REF, 'WORKOS_API_KEY_REF'),
    workosCookiePasswordRef: requiredConfiguration(env.WORKOS_COOKIE_PASSWORD_REF, 'WORKOS_COOKIE_PASSWORD_REF'),
    workosWebhookSecretRef: requiredConfiguration(env.WORKOS_WEBHOOK_SECRET_REF, 'WORKOS_WEBHOOK_SECRET_REF'),
    ...(env.WORKOS_WEBHOOK_SECRET_KEY_REF?.trim()
      ? { workosWebhookSignatureKeyRef: env.WORKOS_WEBHOOK_SECRET_KEY_REF.trim() }
      : {}),
  };
}

export function isHostedControlPlaneDistributionProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PAPERCUSP_DISTRIBUTION_PROFILE === HOSTED_CONTROL_PLANE_DISTRIBUTION_PROFILE;
}

class HostedServiceSessionStore implements HostedControlPlaneSessionStore {
  constructor(private readonly run: HostedServiceContextRunner) {}

  create(input: CreateHostedSessionInput): Promise<HostedSession> {
    return this.run((sql) => new HostedSessionStore(sql as never).create(input));
  }

  resolve(id: string, options?: ResolveHostedSessionOptions): Promise<HostedSession | null> {
    return this.run((sql) => new HostedSessionStore(sql as never).resolve(id, options));
  }

  revoke(id: string, reason?: string, at?: Date): Promise<boolean> {
    return this.run((sql) => new HostedSessionStore(sql as never).revoke(id, reason, at));
  }
}

class HostedServiceIdentityDirectory implements HostedIdentityDirectory {
  constructor(private readonly run: HostedServiceContextRunner) {}

  resolveLinkedUser(input: { providerId: string; subject: string }): Promise<{ userId: string } | null> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).resolveLinkedUser(input));
  }

  resolveOrganization(input: {
    providerId: string;
    externalOrganizationId: string;
  }): Promise<{ organizationId: string } | null> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).resolveOrganization(input));
  }

  listActiveOrganizationIds(input: { userId: string }): Promise<readonly string[]> {
    return this.run((sql) => new PostgresHostedIdentityDirectory(sql as never).listActiveOrganizationIds(input));
  }
}

class HostedRuntimeMembershipAuthority implements HostedMembershipAuthorityReader {
  constructor(
    private readonly runService: HostedServiceContextRunner,
    private readonly runTenant: HostedTenantContextRunner,
  ) {}

  resolveActive(input: { userId: string; organizationId: string }): Promise<HostedMembershipAuthority | null> {
    return this.runService((sql) => new PostgresHostedMembershipAuthority(sql as never).resolveActive(input));
  }

  workspaceBelongsToOrganization(
    input: Parameters<HostedMembershipAuthorityReader['workspaceBelongsToOrganization']>[0],
  ): Promise<boolean> {
    const context: VerifiedTenantServerContext = {
      principal: {
        kind: 'user',
        profile: 'hosted',
        authMethod: 'cookie-session',
        trust: 'verified',
        slug: input.userId,
        workspaceId: input.controlPlaneWorkspaceId,
        userId: input.userId,
        activeOrganizationId: input.organizationId,
        selectedWorkspaceId: input.customerWorkspaceId,
        sessionId: input.sessionId,
        sessionVersion: input.sessionVersion,
      },
      selectedWorkspace: {
        id: input.customerWorkspaceId,
        organizationId: input.organizationId,
      },
    };
    return this.runTenant(context, (sql) =>
      new PostgresHostedMembershipAuthority(sql as never).workspaceBelongsToOrganization(input),
    );
  }
}

function serviceVault(run: HostedServiceContextRunner) {
  return {
    get: (externalSessionId: string) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).get(externalSessionId)),
    put: (record: Parameters<PostgresWorkOSSealedSessionVault['put']>[0]) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).put(record)),
    delete: (externalSessionId: string) =>
      run((sql) => new PostgresWorkOSSealedSessionVault(sql as never).delete(externalSessionId)),
  };
}

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}

function productionProviderDelegationAdapters(): Readonly<Record<'gcp' | 'aws' | 'azure', HostedProviderDelegationAdapter>> {
  const unavailable = (provider: 'aws' | 'azure'): HostedProviderDelegationAdapter => ({
    async verify() { throw new Error(`hosted_provider_delegation_${provider}_adapter_unavailable`); },
    async revoke(record) {
      return { evidenceRef: `delegation://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked` };
    },
  });
  const gcp: HostedProviderDelegationAdapter = {
    async verify(record: HostedProviderDelegationRecord) {
      const auth = await resolveHostedGcpAuth({
        credentialRef: record.credentialRef,
        provider: { hostedDelegation: { ...record, status: 'verified' } },
      });
      return {
        identity: auth.identity ?? (record.configuration.provider === 'gcp'
          ? record.configuration.source.serviceAccountEmail
          : 'gcp:delegated'),
        evidenceRef: `gcp://projects/${auth.projectId ?? 'unknown'}/delegations/${record.connectionId}/${record.generation}`,
      };
    },
    async revoke(record) {
      return { evidenceRef: `delegation://${record.workspaceId}/${record.connectionId}/${record.generation}/revoked` };
    },
  };
  return { gcp, aws: unavailable('aws'), azure: unavailable('azure') };
}

function tenantServerContext(principal: HostedPrincipal): VerifiedTenantServerContext {
  const selectedWorkspaceId = principal.selectedWorkspaceId;
  if (!selectedWorkspaceId) throw new Error('hosted_provider_delegation_workspace_required');
  return {
    principal: {
      kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified',
      slug: principal.userId, workspaceId: principal.workspaceId, userId: principal.userId,
      activeOrganizationId: principal.activeOrganizationId, selectedWorkspaceId,
      sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
    },
    selectedWorkspace: { id: selectedWorkspaceId, organizationId: principal.activeOrganizationId },
  };
}

export function assertHostedRuntimeMounted(plane: AssembledHostedControlPlane): void {
  const mounted = plane.mounted.map(routeKey);
  if (
    mounted.length !== HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS.length ||
    mounted.some((key, index) => key !== HOSTED_RUNTIME_MOUNTED_ROUTE_KEYS[index])
  ) {
    throw new Error(`hosted_runtime_mounted_surface_mismatch:${JSON.stringify(mounted)}`);
  }
}

async function assertHostedServicePosture(runService: HostedServiceContextRunner): Promise<void> {
  await runService(async (sql) => {
    const rows = await sql<HostedServiceRoleRow[]>`
      SELECT current_user::text AS current_user
    `;
    const currentUser = rows.length === 1 ? rows[0]?.current_user : undefined;
    if (currentUser !== HOSTED_SERVICE_ROLE) {
      throw new Error(`hosted_runtime_service_role_mismatch:${currentUser ?? 'missing'}`);
    }
  });
}

/**
 * Resolve only secret references, construct the service/tenant-scoped adapters,
 * inject the signed webhook route, and assert the exact internet surface.
 */
export async function createHostedRuntime(
  configuration: HostedRuntimeConfiguration,
  dependencies: HostedRuntimeDependencies = {},
): Promise<AssembledHostedControlPlane> {
  const runService = dependencies.runService ?? withHostedServiceContext;
  await assertHostedServicePosture(runService);

  const resolveSecret = dependencies.resolveSecret ?? resolveSecretRef;
  const runTenant = dependencies.runTenant ?? withTenantContext;
  const sessionCookieSecret = await resolveSecret(configuration.hostedSessionCookieSecretRef);

  const sessionStore = new HostedServiceSessionStore(runService);
  const membershipAuthority = new HostedRuntimeMembershipAuthority(runService, runTenant);
  const identityDirectory = new HostedServiceIdentityDirectory(runService);
  const lifecycleStore = new PostgresWorkosLifecycleProjectionStore(runService);
  const lifecycleWorker = new WorkosLifecycleWorker(lifecycleStore, new PostgresWorkosAccessClosureSink(runService));
  const receiptSink: WorkOsWebhookReceiptSink = {
    enqueue: (event, options) =>
      runService((sql) => new WorkOsWebhookReceiptStore(sql as never).enqueue(event, options)),
  };
  const connectorGateway = new HostedWorkspaceConnectorGateway(new PostgresHostedWorkspaceConnectorStore(runService));
  const delegationAdapters = dependencies.providerDelegationAdapters ?? productionProviderDelegationAdapters();
  const providerDelegationManager = (principal: HostedPrincipal) =>
    new HostedProviderDelegationManager(
      new PostgresHostedProviderDelegationStore((fn) => runTenant(tenantServerContext(principal), fn)),
      delegationAdapters,
    );

  const provider = createWorkOSHostedIdentityProvider({
    configuration: {
      clientId: configuration.workosClientId,
      apiKeyRef: configuration.workosApiKeyRef,
      cookiePasswordRef: configuration.workosCookiePasswordRef,
    },
    resolveSecret: (reference) => resolveSecret(reference),
    sessionVault: serviceVault(runService),
  });

  const webhookRoute = createWorkOsWebhookRoute({
    secret: () => resolveSecret(configuration.workosWebhookSecretRef),
    signatureKeyRef: () => configuration.workosWebhookSignatureKeyRef,
    intake: async (input) => {
      const receipt = await intakeWorkOsWebhook({ ...input, receiptSink });
      const event = workosLifecycleEventFromReceipt(receipt);
      if (event) await lifecycleWorker.apply(event);
      else await lifecycleStore.markIgnored(receipt.eventId);
      return receipt;
    },
  });

  const plane = assembleHostedControlPlane({
    provider,
    publicOrigin: configuration.publicOrigin,
    sessionCookieSecret,
    controlPlaneWorkspaceId: configuration.controlPlaneWorkspaceId,
    sessionStore,
    membershipAuthority,
    identityDirectory,
    connectorGateway,
    providerDelegationManager,
    routes: [...ALL_ROUTES, webhookRoute],
    staticAllowlist: [...HOSTED_CONTROL_PLANE_ROUTE_ALLOWLIST, HOSTED_WORKOS_WEBHOOK_ALLOWLIST_ENTRY],
  });
  assertHostedRuntimeMounted(plane);
  return plane;
}
