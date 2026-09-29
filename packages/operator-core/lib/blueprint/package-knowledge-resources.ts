/** Resource preparation/compensation for the existing blueprint provisioner.
 * This is not an activation host: callers promote in their existing transaction. */
import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { packageContentHash, type ResolvedPackageInput } from '@papercusp/orchestrator/blueprint';
import { getMemoryBackend, type MemoryBackend } from '../memory/backend';
import { filterByDomains, filterByShapes, type AppliesTo, type KnowledgePack } from '../knowledge-packs/pack-format';
import { packItemMemoryWrite, knowledgePackMemoryScope, type KnowledgePackMemoryTarget } from '../knowledge-packs/seed';
import { packageMemoryDriver } from './package-memory-driver';
import { packageRecipeDriver } from './package-recipe-resources';
import { packageResourceKey, preparePackageResource, releasePackageResource,
  beginPackageInstallationRelease, finishPackageInstallationRelease,
  recordPackageInstallationReleaseFailure, type PackageInstallationReleaseOptions,
  type PackageResourceAddress, type PackageResourceReceipt } from './package-resource-receipts';

export interface KnowledgePackageResourceInput {
  pin: ResolvedPackageInput;
  workspaceId: string;
  harnessSlug: string;
  memoryTarget: KnowledgePackMemoryTarget;
  shapes: readonly AppliesTo[];
  domains: readonly string[];
}

/** Pure expected write set, reused at the atomic activation boundary. */
export function planKnowledgePackageResources(input: KnowledgePackageResourceInput) {
  const { contentHash, ...content } = input.pin;
  if (input.pin.packageKind !== 'knowledge-pack' || packageContentHash(content) !== contentHash) {
    throw new Error('package-hash-mismatch: knowledge resource pin is not intact');
  }
  const pack = input.pin.value as KnowledgePack;
  if (!pack?.manifest || pack.manifest.id !== input.pin.ref || pack.manifest.version !== input.pin.revision ||
      !Array.isArray(pack.items) || new Set(pack.items.map((item) => item.id)).size !== pack.items.length) {
    throw new Error('knowledge resource requires an exact pack id/version and unique items');
  }
  const scope = knowledgePackMemoryScope(input.memoryTarget);
  const selected = filterByDomains(filterByShapes(pack.items, input.shapes), input.domains);
  return selected.map((item) => {
    const write = packItemMemoryWrite({ workspaceId: input.workspaceId, potSlug: input.harnessSlug,
      memoryTarget: input.memoryTarget, pack, item, createdBy: 'blueprint-package:' + contentHash });
    const address: PackageResourceAddress = { workspaceId: input.workspaceId, memoryScope: scope,
      packageKind: input.pin.packageKind, packageRef: input.pin.ref, packageVersion: input.pin.revision,
      packageHash: contentHash, resourceKind: 'memory', itemKey: item.id,
      installedHash: createHash('sha256').update(write.text).digest('hex') };
    const resourceKey = packageResourceKey(address);
    return { address, resourceKey, text: write.text, options: { ...write.options,
      metadata: { ...write.options.metadata, identity_package_resource: resourceKey,
        identity_package_hash: contentHash } } };
  });
}

export async function prepareKnowledgePackageResources(sql: Sql, input: KnowledgePackageResourceInput & {
  dependentId: string;
}, backend: MemoryBackend = getMemoryBackend()): Promise<PackageResourceReceipt[]> {
  const writes = planKnowledgePackageResources(input);
  // Refuse an unsupported backend before writing even the first ownership row.
  if (!backend.managedWrites) throw new Error(`memory backend ${backend.name} does not support fenced package resources`);
  const receipts: PackageResourceReceipt[] = [];
  // Bounded sequential preparation; every completed or uncertain step is already
  // journaled. On a failure the lifecycle caller compensates the whole dependent.
  for (const { address, text, options } of writes) {
    receipts.push(await preparePackageResource(sql, address, input.dependentId, packageMemoryDriver(backend, text, options)));
  }
  return receipts;
}

/** Replays from durable addresses, not today's pack contents or the current
 * filesystem release. Cleanup can therefore resume after upgrade/restart.
 * Covers every journaled kind (memory and code-recipe); a member of any other
 * kind stays held, and the installation records it as cleanup residue. */
export async function releasePackageInstallation(
  sql: Sql, workspaceId: string, dependentId: string, backend?: MemoryBackend,
  options: PackageInstallationReleaseOptions = {},
): Promise<PackageResourceReceipt[]> {
  if (!await beginPackageInstallationRelease(sql, workspaceId, dependentId, options)) return [];
  try {
    const rows = await sql<Array<{
      memory_scope: string; package_kind: string; package_ref: string; package_version: string;
      package_hash: string; resource_kind: string; item_key: string; installed_hash: string;
    }>>`SELECT r.memory_scope, r.package_kind, r.package_ref, r.package_version,
        r.package_hash, r.resource_kind, r.item_key, r.installed_hash
      FROM harness_shared.blueprint_package_resources r
      JOIN harness_shared.blueprint_package_dependents d USING (workspace_id, resource_key)
      WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}
        AND r.resource_kind IN ('memory', 'code-recipe') ORDER BY r.resource_key`;
    const receipts: PackageResourceReceipt[] = [];
    for (const row of rows) {
      const address: PackageResourceAddress = { workspaceId, memoryScope: row.memory_scope,
        packageKind: row.package_kind, packageRef: row.package_ref, packageVersion: row.package_version,
        packageHash: row.package_hash, resourceKind: row.resource_kind, itemKey: row.item_key,
        installedHash: row.installed_hash };
      if (row.resource_kind === 'code-recipe') {
        const receipt = await releasePackageResource(sql, address, dependentId, packageRecipeDriver(sql, address, null));
        if (receipt) receipts.push(receipt);
        continue;
      }
      // Backend initialization can throw too. Keep it after the release fence
      // and inside the durable error boundary; empty installs need no backend.
      backend ??= getMemoryBackend();
      const receipt = await releasePackageResource(sql, address, dependentId,
        packageMemoryDriver(backend, '', { scope: row.memory_scope }));
      if (receipt) receipts.push(receipt);
    }
    await finishPackageInstallationRelease(sql, workspaceId, dependentId);
    return receipts;
  } catch (error) {
    try { await recordPackageInstallationReleaseFailure(sql, workspaceId, dependentId, error); }
    catch (recordError) {
      throw new AggregateError([error, recordError], 'package cleanup failed and its diagnostic could not be persisted', { cause: error });
    }
    throw error;
  }
}
