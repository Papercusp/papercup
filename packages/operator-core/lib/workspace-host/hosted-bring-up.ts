/**
 * D-401: what a Papercusp-hosted workspace runs right after its machine is built.
 *
 * Provisioning alone leaves a machine with the runtime installed at first boot and nothing else:
 * no workspace, no agent, no desktop, and a `customer_workspaces` row that stays `provisioning`
 * forever because nothing ever wrote `active` (measured 2026-09-23 on
 * host-3b44551202aa97c3c3048660). The owner ruled the hosted path must reach a usable workspace
 * with no manual step, while the customer still connects their OWN agent accounts afterwards
 * (D-250 holds). So the chain is: initialize (local-inference agent only) -> desktop pack ->
 * mark the customer workspace `active`.
 *
 * WHO MAY ASK FOR IT. Only the Papercusp-hosted first-workspace door sets a bring-up. It is an
 * explicit field on the provisioning input, never inferred from the spec, so an ordinary
 * provision (BYOC, the loopback route, the canary) still ends at the machine exactly as before.
 *
 * EVERY FIELD IS DERIVED ON THE SERVER. The initialization request below is built from the
 * host's own desired spec; nothing a browser sent reaches it.
 */
import { withHostedServiceContext, withWorkspace } from '@papercusp/db-org';
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import {
  HostedWorkspaceConnectorGateway,
  PostgresHostedWorkspaceConnectorStore,
} from '../endpoint-route/hosted-workspace-connector';
import { enrollGcpIapWorkspaceHostConnector } from './gcp-iap-connector-enrollment';
import type { WorkspaceHostInitializationAdmission } from './initialization-admission';
import {
  resolveWorkspaceHostInitializationControllerProfile,
  resolveWorkspaceHostInitializationOperationsForHost,
} from './initialization-operations-resolver';
import {
  appendWorkspaceHostEvent,
  beginWorkspaceHostOperation,
  updateWorkspaceHostOperation,
} from './observability-store';

/**
 * `omp` only. It verifies against inference running on the customer's own machine, so it needs
 * no Papercusp or customer account. Omitting the list means claude+codex+omp, and those two need
 * accounts the customer has not connected yet: measured, initialization then fails agent
 * readiness (op d401-probe-init-2) and the workspace never becomes usable.
 */
export const PAPERCUSP_HOSTED_BRING_UP_AGENTS: readonly WorkspaceHostCanaryAgent[] = ['omp'];

export interface WorkspaceHostBringUp {
  /** The customer workspace bound to this host; it becomes `active` when the chain completes. */
  customerWorkspaceId: string;
  requestedAgents: readonly WorkspaceHostCanaryAgent[];
}

/** One operation per stage, derived from the provision so a replay reuses the same records. */
export function workspaceHostBringUpOperationIds(provisionOperationId: string): {
  initialize: string;
  desktopPack: string;
  connector: string;
} {
  return {
    initialize: `${provisionOperationId}.initialize`,
    desktopPack: `${provisionOperationId}.desktop-pack`,
    connector: `${provisionOperationId}.connector`,
  };
}

/**
 * The initialization request for a freshly built hosted machine: an empty workspace and the
 * machine's own cloud identity (the instance metadata server answers it; nothing is delivered
 * to disk). A first build is the first binding, so the generation is 1.
 */
export function hostedBringUpInitialization(input: {
  workspaceId: string;
  operationId: string;
  requestedAt: string;
  desired: WorkspaceHostDesiredSpec;
  requestedAgents: readonly WorkspaceHostCanaryAgent[];
}): WorkspaceHostInitializationAdmission {
  const { desired } = input;
  if (desired.target !== 'gcp' || desired.scope.kind !== 'project') {
    throw new Error(`hosted bring-up supports GCP project hosts only (host ${desired.hostId})`);
  }
  const workload = { provider: 'gcp', scopeId: desired.scope.id, workloadId: desired.hostId };
  const generation = 1;
  return {
    contractVersion: WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
    workspaceId: input.workspaceId,
    hostId: desired.hostId,
    operationId: input.operationId,
    requestedAt: input.requestedAt,
    source: { kind: 'empty' },
    credentialRefs: {
      cloudCredentialRef: {
        kind: 'cloud',
        ref: buildWorkspaceHostCredentialReference('cloud-workload-identity', workload),
      },
    },
    credentialDelivery: {
      cloud: {
        kind: 'provider-identity',
        generation,
        audience: desired.hostId,
        revocationRef: buildWorkspaceHostCredentialRevocationReference('cloud-workload-identity', workload, generation),
      },
    },
    requestedAgents: [...input.requestedAgents],
  };
}

/**
 * Mark the customer workspace usable. Only `provisioning` moves; a workspace that was suspended,
 * offboarded or deleted while its machine was being set up keeps that state, and one already
 * `active` (a replay) is left alone. Returns the state the row ends in.
 */
export async function activateHostedCustomerWorkspace(input: {
  controlPlaneWorkspaceId: string;
  customerWorkspaceId: string;
  hostId: string;
}): Promise<{ state: string }> {
  return withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
    await query`
      UPDATE harness_shared.customer_workspaces
         SET state = 'active', updated_at = now()
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
         AND workspace_host_id = ${input.hostId}
         AND state = 'provisioning'
    `;
    const rows = await query<Array<{ state: string; workspace_host_id: string }>>`
      SELECT state, workspace_host_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
    `;
    const row = rows[0];
    if (!row || row.workspace_host_id !== input.hostId) {
      throw new Error(
        `customer workspace ${input.customerWorkspaceId} is not bound to host ${input.hostId}`,
      );
    }
    return { state: row.state };
  });
}

/**
 * The connector's route label: the host id, which is unique and already a DNS label. A name the
 * customer typed would collide across organizations and change when renamed.
 */
export function hostedConnectorRouteLabel(hostId: string): string {
  const label = hostId.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new Error(`host id ${hostId} is not usable as a connector route label`);
  }
  return label;
}

export interface HostedConnectorEnrollmentDependencies {
  readOrganizationId(input: { controlPlaneWorkspaceId: string; customerWorkspaceId: string; hostId: string }): Promise<string>;
  gateway: Pick<HostedWorkspaceConnectorGateway, 'enroll'>;
  /** Deliver the ticket to the host's enrollment conduit; resolves with the generation it registered. */
  deliverTicket(input: { workspaceId: string; hostId: string; ticket: string }): Promise<{ generation: number }>;
  beginOperation: typeof beginWorkspaceHostOperation;
  updateOperation: typeof updateWorkspaceHostOperation;
  appendEvent: typeof appendWorkspaceHostEvent;
}

async function readBoundOrganizationId(input: {
  controlPlaneWorkspaceId: string;
  customerWorkspaceId: string;
  hostId: string;
}): Promise<string> {
  return withWorkspace(input.controlPlaneWorkspaceId, async (query) => {
    const rows = await query<Array<{ organization_id: string }>>`
      SELECT organization_id
        FROM harness_shared.customer_workspaces
       WHERE workspace_id = ${input.controlPlaneWorkspaceId}
         AND id = ${input.customerWorkspaceId}
         AND workspace_host_id = ${input.hostId}
    `;
    const organizationId = rows[0]?.organization_id;
    if (!organizationId) {
      throw new Error(`customer workspace ${input.customerWorkspaceId} is not bound to host ${input.hostId}`);
    }
    return organizationId;
  });
}

function defaultConnectorEnrollmentDependencies(): HostedConnectorEnrollmentDependencies {
  return {
    readOrganizationId: readBoundOrganizationId,
    gateway: new HostedWorkspaceConnectorGateway(new PostgresHostedWorkspaceConnectorStore(withHostedServiceContext)),
    async deliverTicket({ workspaceId, hostId, ticket }) {
      const { transport } = await resolveWorkspaceHostInitializationOperationsForHost({
        workspaceId,
        hostId,
        controller: resolveWorkspaceHostInitializationControllerProfile(),
      });
      return enrollGcpIapWorkspaceHostConnector(transport, ticket);
    },
    beginOperation: beginWorkspaceHostOperation,
    updateOperation: updateWorkspaceHostOperation,
    appendEvent: appendWorkspaceHostEvent,
  };
}

/**
 * D-403: connect the machine's desktop to Papercusp. Enroll a connector for (organization,
 * customer workspace, host), hand the single-use ticket to the host, and require the host to
 * report registering the SAME generation.
 *
 * Returns only public facts. It runs as one durable step, and a step's return value is persisted,
 * so the ticket must never be part of it. A retry enrolls again: the store bumps the generation,
 * which invalidates any ticket or bearer from the failed attempt.
 */
export async function enrollHostedWorkspaceConnector(
  input: { controlPlaneWorkspaceId: string; customerWorkspaceId: string; hostId: string; operationId: string },
  dependencies: HostedConnectorEnrollmentDependencies = defaultConnectorEnrollmentDependencies(),
): Promise<{ generation: number; routeLabel: string }> {
  const { controlPlaneWorkspaceId: workspaceId, hostId, operationId } = input;
  await dependencies.beginOperation({
    workspaceId,
    hostId,
    operationId,
    action: 'initialize',
    status: 'running',
    message: 'Connecting the workspace desktop to Papercusp',
    request: { hostId, customerWorkspaceId: input.customerWorkspaceId, stage: 'connector' },
  });
  try {
    const routeLabel = hostedConnectorRouteLabel(hostId);
    const organizationId = await dependencies.readOrganizationId(input);
    const enrollment = await dependencies.gateway.enroll({
      controlPlaneWorkspaceId: workspaceId,
      organizationId,
      customerWorkspaceId: input.customerWorkspaceId,
      hostId,
      routeLabel,
      transport: 'websocket',
    });
    const registered = await dependencies.deliverTicket({ workspaceId, hostId, ticket: enrollment.ticket });
    if (registered.generation !== enrollment.binding.generation) {
      throw new Error(
        `host ${hostId} registered connector generation ${registered.generation}, but generation ` +
          `${enrollment.binding.generation} was enrolled`,
      );
    }
    await dependencies.appendEvent({
      workspaceId,
      hostId,
      operationId,
      phase: 'connector:registered',
      status: 'succeeded',
      level: 'info',
      source: 'controller',
      message: 'Workspace desktop connected to Papercusp',
      details: { generation: registered.generation, routeLabel },
    });
    await dependencies.updateOperation({
      workspaceId,
      operationId,
      status: 'succeeded',
      percent: 100,
      message: 'Workspace desktop connected to Papercusp',
    });
    return { generation: registered.generation, routeLabel };
  } catch (error) {
    await dependencies
      .updateOperation({
        workspaceId,
        operationId,
        status: 'failed',
        percent: 100,
        message: 'Could not connect the workspace desktop to Papercusp',
        error: error instanceof Error ? error.message : String(error),
      })
      .catch(() => undefined);
    throw error;
  }
}
