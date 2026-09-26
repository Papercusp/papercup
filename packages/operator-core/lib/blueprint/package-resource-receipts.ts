/**
 * Resource journal for the existing blueprint package lifecycle (portable D-007).
 * Not an executor: install/activation/DBOS callers invoke these replayable steps.
 * Persist intent BEFORE external I/O. A transaction lock serializes dependents and
 * cleanup; external writes survive a rolled-back receipt and are rediscovered by
 * their persisted write key. No assertion of atomicity between PG and a backend.
 */
import { createHash } from 'node:crypto';
import type { Sql, TransactionSql } from 'postgres';

export interface PackageResourceAddress {
  workspaceId: string;
  memoryScope: string;
  packageKind: string;
  packageRef: string;
  packageVersion: string;
  packageHash: string;
  resourceKind: string;
  itemKey: string;
  installedHash: string;
}

export interface PackageExternalResource {
  /** Exact backend row identifier, never a package-wide deletion selector. */
  id: string;
  /** Backend snapshot fingerprint checked atomically by removeIfUnchanged. */
  fingerprint: string;
  disposition?: 'removed' | 'absent' | 'changed';
  error?: string;
}

export interface PackageResourceDriver {
  /** Only rows with this exact persisted operation key; no semantic matching.
   * Recover the ORIGINAL write fingerprint, not a fingerprint of a later user edit. */
  recover(writeKey: string): Promise<PackageExternalResource[]>;
  /** Must stamp writeKey atomically with the external write, including on errors. */
  create(writeKey: string): Promise<PackageExternalResource[]>;
  /** Must compare AND remove atomically; a get-then-forget adapter is unsafe. */
  removeIfUnchanged(resource: PackageExternalResource): Promise<'removed' | 'absent' | 'changed'>;
}

export interface PackageResourceReceipt {
  resource_key: string;
  write_key: string;
  installed_hash: string;
  phase: 'intent' | 'ready' | 'cleanup_failed' | 'deleted' | 'detached';
  external_refs: PackageExternalResource[];
  error: string | null;
}

type Db = Sql | TransactionSql;

export function packageResourceKey(address: PackageResourceAddress): string {
  for (const [key, value] of Object.entries(address)) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`package resource requires ${key}`);
  }
  for (const value of [address.packageHash, address.installedHash]) {
    if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('package resource requires exact SHA-256 hashes');
  }
  return createHash('sha256').update(JSON.stringify([
    address.workspaceId, address.memoryScope, address.packageKind, address.packageRef,
    address.packageVersion, address.packageHash, address.resourceKind, address.itemKey,
  ])).digest('hex');
}

async function lock(sql: TransactionSql, workspaceId: string, key: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['blueprint-package-resource', workspaceId, key])}, 0))`;
}

export async function readPackageResourceReceipt(sql: Db, workspaceId: string, key: string): Promise<PackageResourceReceipt | null> {
  const rows = await sql<PackageResourceReceipt[]>`
    SELECT resource_key, write_key, installed_hash, phase, external_refs, error
      FROM harness_shared.blueprint_package_resources
     WHERE workspace_id = ${workspaceId} AND resource_key = ${key}`;
  return rows[0] ?? null;
}

function validateRefs(refs: PackageExternalResource[]): PackageExternalResource[] {
  if (!Array.isArray(refs) || refs.length === 0 || refs.some((ref) =>
    !ref.id?.trim() || !ref.fingerprint?.trim() || ref.disposition || ref.error) ||
    new Set(refs.map((ref) => ref.id)).size !== refs.length) {
    throw new Error('package resource write did not return unique exact resource receipts');
  }
  return refs.map(({ id, fingerprint }) => ({ id, fingerprint }));
}

/** Shared same-version resources have one write and a separate ref for each install. */
export async function preparePackageResource(
  sql: Sql, address: PackageResourceAddress, dependentId: string, driver: PackageResourceDriver,
): Promise<PackageResourceReceipt> {
  if (!dependentId.trim()) throw new Error('package resource requires an identity-install dependent');
  const key = packageResourceKey(address);
  // This commit survives process death during the external write below.
  await sql.begin(async (tx) => {
    await lock(tx, address.workspaceId, 'dependent:' + dependentId);
    await lock(tx, address.workspaceId, key);
    await tx`INSERT INTO harness_shared.blueprint_package_resources
      (workspace_id, resource_key, memory_scope, package_kind, package_ref, package_version,
       package_hash, resource_kind, item_key, installed_hash)
      VALUES (${address.workspaceId}, ${key}, ${address.memoryScope}, ${address.packageKind},
        ${address.packageRef}, ${address.packageVersion}, ${address.packageHash},
        ${address.resourceKind}, ${address.itemKey}, ${address.installedHash})
      ON CONFLICT (workspace_id, resource_key) DO NOTHING`;
    const receipt = (await readPackageResourceReceipt(tx, address.workspaceId, key))!;
    if (receipt.installed_hash !== address.installedHash) throw new Error('package resource content changed under an exact pin');
    if (receipt.phase === 'detached') throw new Error('package resource was edited; explicit review is required');
    if (receipt.phase === 'deleted') {
      // A fresh install starts a new operation; deleted history cannot be replayed as ready.
      await tx`UPDATE harness_shared.blueprint_package_resources
        SET write_key = gen_random_uuid(), phase = 'intent', external_refs = '[]'::jsonb, error = NULL, updated_at = now()
        WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
    }
    await tx`INSERT INTO harness_shared.blueprint_package_dependents (workspace_id, dependent_id, resource_key)
      VALUES (${address.workspaceId}, ${dependentId}, ${key})
      ON CONFLICT (workspace_id, dependent_id, resource_key) DO NOTHING`;
    const [dependent] = await tx<{ phase: string }[]>`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}`;
    if (dependent.phase === 'released') throw new Error('released installation cannot be replayed; use a new dependent id');
  });

  try {
    return await sql.begin(async (tx) => {
    await lock(tx, address.workspaceId, key);
    const [dependent] = await tx<{ phase: string }[]>`SELECT phase FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}`;
    if (dependent.phase === 'released') throw new Error('installation was released before preparation finished');
    const receipt = (await readPackageResourceReceipt(tx, address.workspaceId, key))!;
    if (receipt.phase === 'ready') return receipt;
    if (receipt.phase !== 'intent') throw new Error('package resource needs cleanup recovery before installation');
    // A failed/ambiguous external response can have committed rows. Recover them
    // before calling create, including after a lost PG commit acknowledgement.
    const recovered = await driver.recover(receipt.write_key);
    const refs = validateRefs(recovered.length ? recovered : await driver.create(receipt.write_key));
    await tx`UPDATE harness_shared.blueprint_package_resources
      SET phase = 'ready', external_refs = ${tx.json(refs)}, error = NULL, updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
    return { ...receipt, phase: 'ready' as const, external_refs: refs, error: null };
    });
  } catch (error) {
    // Preserve ambiguous-outcome diagnostics without overwriting a peer's later
    // successful recovery. The committed intent/write key is still the retry key.
    await sql`UPDATE harness_shared.blueprint_package_resources
      SET error = ${error instanceof Error ? error.message : String(error)}, updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key} AND phase = 'intent'`;
    throw error;
  }
}

/** Invoke in the SAME transaction that promotes the existing applied activation. */
export async function applyPackageResourceDependent(tx: TransactionSql, workspaceId: string, dependentId: string): Promise<void> {
  await lock(tx, workspaceId, 'dependent:' + dependentId);
  const resources = await tx<{ resource_key: string }[]>`SELECT resource_key FROM harness_shared.blueprint_package_dependents
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId} ORDER BY resource_key`;
  if (!resources.length) throw new Error('package resource dependent has not been prepared');
  for (const { resource_key: key } of resources) await lock(tx, workspaceId, key);
  const [invalid] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents d
    JOIN harness_shared.blueprint_package_resources r USING (workspace_id, resource_key)
    WHERE d.workspace_id = ${workspaceId} AND d.dependent_id = ${dependentId}
      AND (d.phase = 'released' OR r.phase <> 'ready') LIMIT 1`;
  if (invalid) throw new Error('package resources are not prepared for activation');
  await tx`UPDATE harness_shared.blueprint_package_dependents SET phase = 'applied', updated_at = now()
    WHERE workspace_id = ${workspaceId} AND dependent_id = ${dependentId}`;
}

/** Release one reference; retry the same call to converge after any interrupted cleanup. */
export async function releasePackageResource(
  sql: Sql, address: PackageResourceAddress, dependentId: string, driver: PackageResourceDriver,
): Promise<PackageResourceReceipt | null> {
  const key = packageResourceKey(address);
  return sql.begin(async (tx) => {
    await lock(tx, address.workspaceId, 'dependent:' + dependentId);
    await lock(tx, address.workspaceId, key);
    const receipt = await readPackageResourceReceipt(tx, address.workspaceId, key);
    if (!receipt) return null;
    const released = await tx`UPDATE harness_shared.blueprint_package_dependents
      SET phase = 'released', updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND dependent_id = ${dependentId} AND resource_key = ${key}
      RETURNING dependent_id`;
    if (!released.length) throw new Error('installation does not own this package resource');
    const [held] = await tx`SELECT 1 FROM harness_shared.blueprint_package_dependents
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key} AND phase <> 'released' LIMIT 1`;
    if (held || receipt.phase === 'deleted' || receipt.phase === 'detached') return receipt;
    // intent can mean process death after an external commit, before the receipt.
    let refs: PackageExternalResource[];
    try {
      refs = receipt.phase === 'intent' || !receipt.external_refs.length
        ? await driver.recover(receipt.write_key) : receipt.external_refs;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await tx`UPDATE harness_shared.blueprint_package_resources
        SET phase = 'cleanup_failed', error = ${message}, updated_at = now()
        WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
      return { ...receipt, phase: 'cleanup_failed' as const, error: message };
    }
    const settled: PackageExternalResource[] = [];
    for (const ref of refs) {
      if (ref.disposition) { settled.push(ref); continue; }
      try {
        settled.push({ id: ref.id, fingerprint: ref.fingerprint, disposition: await driver.removeIfUnchanged(ref) });
      } catch (error) {
        settled.push({ id: ref.id, fingerprint: ref.fingerprint, error: error instanceof Error ? error.message : String(error) });
      }
    }
    const errors = settled.filter((ref) => ref.error).map((ref) => `${ref.id}: ${ref.error}`);
    const phase = errors.length ? 'cleanup_failed' : settled.some((ref) => ref.disposition === 'changed') ? 'detached' : 'deleted';
    const error = errors.length ? errors.join('; ') : null;
    await tx`UPDATE harness_shared.blueprint_package_resources
      SET phase = ${phase}, external_refs = ${tx.json(settled)}, error = ${error}, updated_at = now()
      WHERE workspace_id = ${address.workspaceId} AND resource_key = ${key}`;
    return { ...receipt, phase, external_refs: settled, error };
  });
}
