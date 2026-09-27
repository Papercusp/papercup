import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';
import { replayAgentSpecification, type SessionActivation, type CompiledAgentSpecification } from '@papercusp/orchestrator/blueprint';
import { applyPackageResourceDependent, beginPackageInstallation } from './package-resource-receipts';
import { blueprintPackageProvisioners, provisionBlueprintPackages } from './compile-packages';
import { planKnowledgePackageResources, releaseKnowledgePackageResources } from './package-knowledge-resources';

/** The host persists attemptId with its launch/activation receipt BEFORE external
 * preparation, and reuses it on recovery. A compensated attempt is terminal; an
 * intentional retry gets a new token. Omission preserves pre-attempt receipt IDs. */
export function sessionPackageDependentId(ownerId: string, revision: SessionActivation['desired'], attemptId?: string): string {
  if (!ownerId.trim() || !revision.specificationRevision?.trim() || !revision.stateRevision?.trim()) {
    throw new Error('package installation requires wearer and exact activation revision');
  }
  if (attemptId !== undefined && (!attemptId.trim() || attemptId.length > 200)) {
    throw new Error('package installation requires a non-empty attempt token of at most 200 characters');
  }
  return 'session-package:' + createHash('sha256').update(JSON.stringify([
    ownerId, revision.specificationRevision, revision.stateRevision,
    ...(attemptId === undefined ? [] : [attemptId]),
  ])).digest('hex');
}

async function expectedKnowledgeResources(artifact: CompiledAgentSpecification, workspaceId?: string) {
  const byWorkspace = new Map<string, Map<string, string>>();
  await provisionBlueprintPackages(artifact, {
    recipe: async () => {}, rubric: async () => {},
    knowledge: async (pin, scope) => {
      if (workspaceId !== undefined && scope.workspaceId !== workspaceId) throw new Error('package activation workspace mismatch');
      const expected = byWorkspace.get(scope.workspaceId) ?? new Map<string, string>();
      byWorkspace.set(scope.workspaceId, expected); // keep explicit empty selection
      for (const write of planKnowledgePackageResources({ pin, workspaceId: scope.workspaceId,
        harnessSlug: scope.harnessSlug, memoryTarget: scope.memoryTarget!,
        shapes: scope.knowledgeSelection!.shapes, domains: scope.knowledgeSelection!.domains })) {
        const prior = expected.get(write.resourceKey);
        if (prior && prior !== write.address.installedHash) throw new Error('conflicting resource content in installation');
        expected.set(write.resourceKey, write.address.installedHash);
      }
    },
  });
  return byWorkspace;
}

/** Existing host launch/identity-mutation callers use this before publishing a
 * desired revision. Persist every manifest first; any partial preparation has a
 * durable release fence and exact-address compensation on error or replay. */
export async function provisionSessionPackageResources(sql: Sql, input: {
  ownerId: string; revision: SessionActivation['desired']; artifacts: readonly CompiledAgentSpecification[];
  attemptId?: string;
}): Promise<void> {
  const dependentId = sessionPackageDependentId(input.ownerId, input.revision, input.attemptId);
  const manifests = new Map<string, Map<string, string>>();
  for (const artifact of input.artifacts) {
    if (artifact.specificationRevision !== input.revision.specificationRevision) throw new Error('package preparation artifact revision mismatch');
    for (const [workspaceId, expected] of await expectedKnowledgeResources(artifact)) {
      const previous = manifests.get(workspaceId) ?? new Map<string, string>();
      for (const [key, hash] of expected) {
        if (previous.has(key) && previous.get(key) !== hash) throw new Error('conflicting resource content in installation');
        previous.set(key, hash);
      }
      manifests.set(workspaceId, previous);
    }
  }
  // A refusal here must never compensate an existing, differently authored
  // installation that merely reused its id. Only enroll successful manifests.
  const enrolled: string[] = [];
  try {
    for (const [workspaceId, expectedResources] of manifests) {
      await beginPackageInstallation(sql, { workspaceId, dependentId, ownerId: input.ownerId,
        ...input.revision, expectedResources });
      enrolled.push(workspaceId);
    }
    const provisioners = blueprintPackageProvisioners(sql, { dependentId });
    for (const artifact of input.artifacts) await provisionBlueprintPackages(artifact, provisioners);
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const workspaceId of enrolled) {
      try {
        const receipts = await releaseKnowledgePackageResources(sql, workspaceId, dependentId, undefined, { onlyUnapplied: true });
        for (const receipt of receipts) if (receipt.phase === 'cleanup_failed') cleanupErrors.push(new Error(receipt.error ?? 'cleanup failed'));
      } catch (cleanupError) { cleanupErrors.push(cleanupError); }
    }
    if (cleanupErrors.length) throw new AggregateError([error, ...cleanupErrors],
      'package preparation failed; compensation remains retryable in the resource journal', { cause: error });
    throw error;
  }
}

/** Run inside the existing activation transaction. Never opens visibility by
 * updating memories independently of that authoritative applied revision. */
export async function applySessionPackageResources(tx: TransactionSql, input: {
  ownerId: string;
  workspaceId: string;
  revision: SessionActivation['desired'];
  artifact: CompiledAgentSpecification | null;
  attemptId?: string;
}): Promise<void> {
  if (input.attemptId !== undefined && !input.artifact) {
    throw new Error('package activation attempt requires a verified artifact');
  }
  const artifact = input.artifact ? replayAgentSpecification(input.artifact) : null;
  if (artifact && artifact.specificationRevision !== input.revision.specificationRevision) {
    throw new Error('package activation artifact revision mismatch');
  }
  if (!artifact?.inputs.some((entry) => entry.kind === 'package' && entry.packageKind === 'knowledge-pack')) return;
  const dependentId = sessionPackageDependentId(input.ownerId, input.revision, input.attemptId);
  const expected = (await expectedKnowledgeResources(artifact, input.workspaceId)).get(input.workspaceId) ?? new Map<string, string>();
  // Only a truly pre-manifest installation may omit preparation. A new empty
  // install has an explicit manifest and is still validated under the lock.
  await applyPackageResourceDependent(tx, input.workspaceId, dependentId, expected, {
    allowLegacyUnprepared: input.attemptId === undefined,
  });
}
