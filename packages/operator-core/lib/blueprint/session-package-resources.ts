import { createHash } from 'node:crypto';
import type { TransactionSql } from 'postgres';
import { replayAgentSpecification, type SessionActivation, type CompiledAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { applyPackageResourceDependent } from './package-resource-receipts';
import { provisionBlueprintPackages } from './compile-packages';
import { planKnowledgePackageResources } from './package-knowledge-resources';

/** One exact installation per wearer + immutable specification/state pair. */
export function sessionPackageDependentId(ownerId: string, revision: SessionActivation['desired']): string {
  if (!ownerId.trim() || !revision.specificationRevision?.trim() || !revision.stateRevision?.trim()) {
    throw new Error('package installation requires wearer and exact activation revision');
  }
  return 'session-package:' + createHash('sha256').update(JSON.stringify([
    ownerId, revision.specificationRevision, revision.stateRevision,
  ])).digest('hex');
}

/** Run inside the existing activation transaction. Never opens visibility by
 * updating memories independently of that authoritative applied revision. */
export async function applySessionPackageResources(tx: TransactionSql, input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  artifact: CompiledAgentSpecification | null;
}): Promise<void> {
  const artifact = input.artifact ? replayAgentSpecification(input.artifact) : null;
  if (artifact && artifact.specificationRevision !== input.revision.specificationRevision) {
    throw new Error('package activation artifact revision mismatch');
  }
  if (!artifact?.inputs.some((entry) => entry.kind === 'package' && entry.packageKind === 'knowledge-pack')) return;
  const dependentId = sessionPackageDependentId(input.ownerId, input.revision);
  const prepared = await tx<Array<{ resource_key: string; installed_hash: string }>>`
    SELECT d.resource_key, r.installed_hash FROM harness_shared.blueprint_package_dependents d
    JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
    WHERE d.workspace_id = ${input.workspaceId} AND d.dependent_id = ${dependentId}`;
  // Existing activation receipts predate managed installations. They keep their
  // existing behavior; this helper must not adopt their ordinary memory rows.
  // A managed installation is created before its launch/desired receipt lands.
  if (!prepared.length) return;
  const expected = new Map<string, string>();
  await provisionBlueprintPackages(artifact, {
    recipe: async () => {}, rubric: async () => {},
    knowledge: async (pin, scope) => {
      if (scope.workspaceId !== input.workspaceId) throw new Error('package activation workspace mismatch');
      for (const write of planKnowledgePackageResources({ pin, workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug, memoryTarget: scope.memoryTarget!,
        shapes: scope.knowledgeSelection!.shapes, domains: scope.knowledgeSelection!.domains })) {
        expected.set(write.resourceKey, write.address.installedHash);
      }
    },
  });
  if (prepared.length !== expected.size || prepared.some((row) => expected.get(row.resource_key) !== row.installed_hash)) {
    throw new Error('identity package preparation does not match the complete applied pin set');
  }
  await applyPackageResourceDependent(tx, input.workspaceId, dependentId);
}
