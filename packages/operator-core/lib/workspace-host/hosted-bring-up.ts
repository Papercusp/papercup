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
import { withWorkspace } from '@papercusp/db-org';
import {
  buildWorkspaceHostCredentialReference,
  buildWorkspaceHostCredentialRevocationReference,
  WORKSPACE_HOST_INITIALIZATION_CONTRACT_VERSION,
  type WorkspaceHostCanaryAgent,
  type WorkspaceHostDesiredSpec,
} from '@papercusp/deployment-driver';
import type { WorkspaceHostInitializationAdmission } from './initialization-admission';

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
} {
  return {
    initialize: `${provisionOperationId}.initialize`,
    desktopPack: `${provisionOperationId}.desktop-pack`,
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
