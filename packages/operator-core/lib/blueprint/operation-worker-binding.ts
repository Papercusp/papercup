/** Resolve a worker's authority from the accepted operation, never launch args. */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { getWorkItem } from '../work-items';
import { runWithWorkspace } from '../workspace-als';
import { getIdentitySource } from '../agent-identities/source';
import { normalizeSessionActivation } from '../session-activation';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';

export interface AcceptedOperationWorkerBinding {
  workItemId: string;
  operationId: string;
  specificationRevision: string;
  identity: { ref: string; revision: string; contentHash: string };
  stack: string[];
  requiredTools: string[];
}

export type ActiveOperationWorkerClaimRead =
  | { status: 'bound'; binding: AcceptedOperationWorkerBinding }
  | { status: 'none' }
  | { status: 'unavailable'; reason: string };

/** Read the current, applied operation identity for a claim target. A launch
 * request is only a desired identity; it cannot authorize a claim until the
 * host has applied it. Read a small role header first so ordinary SU pulls do
 * not detoast their large launch_spec on every scheduler call. */
export async function readActiveOperationWorkerClaimBinding(
  workspaceId: string,
  ownerId: string,
): Promise<ActiveOperationWorkerClaimRead> {
  if (!workspaceId.trim() || !ownerId.trim()) return { status: 'unavailable', reason: 'claim target scope is missing' };
  try {
    const { sql } = getOrgPg();
    const [session] = await sql<Array<{ id: number; role: string | null }>>`
      SELECT id, role FROM harness_shared.adv_sessions
       WHERE workspace_id = ${workspaceId} AND coord_owner_id = ${ownerId}
         AND ended_at IS NULL AND ended_by IS NULL
       ORDER BY started_at DESC, id DESC LIMIT 1
    `;
    if (!session || !session.role || session.role === 'su') return { status: 'none' };
    const [row] = await sql<Array<{
      accepted_operation: unknown;
      launch_workspace_id: string | null;
      launch_harness_slug: string | null;
      launch_role: string | null;
      specification_revision: string | null;
      state_revision: string | null;
      grants_kind: string | null;
      activation: unknown;
    }>>`
      SELECT s.launch_spec->'acceptedOperation' AS accepted_operation,
             s.launch_spec->>'workspaceId' AS launch_workspace_id,
             s.launch_spec->>'harnessSlug' AS launch_harness_slug,
             s.launch_spec->>'role' AS launch_role,
             s.launch_spec->>'specificationRevision' AS specification_revision,
             s.launch_spec->>'stateRevision' AS state_revision,
             jsonb_typeof(s.launch_spec->'specificationArtifact'->'configuration'->'grants') AS grants_kind,
             b.control_state->'activation' AS activation
        FROM harness_shared.adv_sessions s
        LEFT JOIN harness_shared.session_briefs b
          ON b.workspace_id = s.workspace_id AND b.owner_id = s.coord_owner_id
       WHERE s.id = ${session.id} AND s.workspace_id = ${workspaceId}
         AND s.coord_owner_id = ${ownerId} AND s.ended_at IS NULL AND s.ended_by IS NULL
    `;
    if (!row) return { status: 'unavailable', reason: 'role session ended during claim admission' };
    if (row.accepted_operation == null) return { status: 'none' };
    const accepted = row.accepted_operation && typeof row.accepted_operation === 'object' &&
      !Array.isArray(row.accepted_operation) ? row.accepted_operation as Record<string, unknown> : null;
    const identity = accepted?.identity && typeof accepted.identity === 'object' &&
      !Array.isArray(accepted.identity) ? accepted.identity as Record<string, unknown> : null;
    const requiredTools = accepted?.requiredTools;
    if (row.launch_workspace_id !== workspaceId || !row.launch_harness_slug ||
        row.launch_role !== session.role || row.grants_kind !== 'object' ||
        !/^[0-9a-f]{64}$/.test(row.specification_revision ?? '') || !row.state_revision ||
        accepted?.kind !== 'blueprint-operation-worker' ||
        typeof accepted.workItemId !== 'string' || !accepted.workItemId ||
        typeof accepted.operationId !== 'string' || !accepted.operationId ||
        !/^[0-9a-f]{64}$/.test(String(accepted.specificationRevision ?? '')) ||
        typeof identity?.ref !== 'string' || !identity.ref ||
        typeof identity.revision !== 'string' || !identity.revision ||
        !/^[0-9a-f]{64}$/.test(String(identity.contentHash ?? '')) ||
        !Array.isArray(requiredTools) ||
        !requiredTools.every((name) => typeof name === 'string' && name.length > 0)) {
      return { status: 'unavailable', reason: 'active operation worker receipt is malformed' };
    }
    let activation;
    try {
      activation = normalizeSessionActivation(row.activation);
    } catch {
      return { status: 'unavailable', reason: 'active operation worker activation is malformed' };
    }
    if (activation?.status !== 'applied' ||
        activation.applied?.specificationRevision !== row.specification_revision ||
        activation.applied.stateRevision !== row.state_revision ||
        activation.attribution.sessionId !== ownerId) {
      return { status: 'unavailable', reason: 'active operation worker identity is not applied' };
    }
    return {
      status: 'bound',
      binding: {
        workItemId: accepted.workItemId,
        operationId: accepted.operationId,
        specificationRevision: accepted.specificationRevision as string,
        identity: { ref: identity.ref, revision: identity.revision, contentHash: identity.contentHash as string },
        stack: [`domain:${identity.ref}`],
        requiredTools: [...new Set(requiredTools as string[])].sort(),
      },
    };
  } catch {
    return { status: 'unavailable', reason: 'active operation worker receipt could not be read' };
  }
}

export async function resolveAcceptedOperationWorkerBinding(input: {
  sql: Sql;
  workspaceId: string;
  harnessSlug: string;
  workItemId: string;
  role: string;
  repoDir: string;
}): Promise<AcceptedOperationWorkerBinding | null> {
  return runWithWorkspace(input.workspaceId, async () => {
    const item = await getWorkItem(input.workItemId, input.harnessSlug);
    if (!item || item.harness !== input.harnessSlug) {
      throw new Error('operation worker launch requires a work item in its harness');
    }
    const payload = item.payload && typeof item.payload === 'object' && !Array.isArray(item.payload)
      ? item.payload as Record<string, unknown> : null;
    if (!payload?.blueprintOperation) return null;

    const { pin, operation } = await readAcceptedBlueprintDirectWorkItem(input.sql, input.workspaceId, item);
    if (operation.execution?.kind !== 'agent' || operation.execution.role !== input.role) {
      throw new Error('accepted blueprint operation does not authorize this worker role');
    }
    const ref = operation.policy.identity;
    if (!ref) throw new Error('accepted blueprint agent operation has no pinned worker identity');
    const source = await getIdentitySource(ref.ref, { repoDir: input.repoDir });
    if (!source.ok || !source.sourcePath || source.identity.id !== ref.ref ||
        source.identity.version !== ref.revision || source.contentHash !== ref.contentHash) {
      throw new Error('accepted blueprint worker identity is missing or differs from its pinned revision');
    }
    if (source.identity.grants == null) {
      throw new Error('accepted blueprint worker identity must declare grants explicitly');
    }
    if (source.identity.slots.length !== 1 || source.identity.slots[0]?.slot !== 'domain') {
      throw new Error('accepted blueprint worker identity must fill exactly the domain slot');
    }
    const requiredTools = [...new Set(operation.policy.requiredTools)].sort();
    return {
      workItemId: item.id,
      operationId: pin.operationId,
      specificationRevision: pin.specificationRevision,
      identity: { ref: ref.ref, revision: ref.revision, contentHash: ref.contentHash },
      stack: [`domain:${ref.ref}`],
      requiredTools,
    };
  });
}
