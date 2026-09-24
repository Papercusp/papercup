/** Resolve a worker's authority from the accepted operation, never launch args. */
import type { Sql } from 'postgres';
import { getWorkItem } from '../work-items';
import { runWithWorkspace } from '../workspace-als';
import { getIdentitySource } from '../agent-identities/source';
import { readAcceptedBlueprintDirectWorkItem } from './operation-admission';

export interface AcceptedOperationWorkerBinding {
  workItemId: string;
  operationId: string;
  specificationRevision: string;
  identity: { ref: string; revision: string; contentHash: string };
  stack: string[];
  requiredTools: string[];
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
