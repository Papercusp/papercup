/**
 * hive-directory-meta.ts — persistence for a workspace's OWNED hive directory
 * metadata (p2p-hive-directory-2026-06-06 P-004).
 *
 * The hive create/edit surface carries title + description + visibility; this is
 * where those land. Stored in the `harness_registry` blob (workspace PG, no
 * migration) keyed by hiveId, alongside the deployment frames. The boot-join
 * (hive-directory-boot.ts) reads `listOwnedHiveMeta()` to register + announce a
 * workspace's public/invite hives; `saveOwnedHiveMeta` is the create/edit write.
 *
 * Pure persistence — the directory register/announce is done by
 * `publishHiveToDirectory` (hive-publish.ts), which the create/edit TOOL calls
 * after saving so a metadata change converges promptly.
 */

import { loadHarnessRegistry, mutateHarnessRegistry } from './harness-registry';
import type { HiveDirectoryMeta } from './hive-publish';

/** All owned hive metadata for a workspace, newest-created first. */
export async function listOwnedHiveMeta(workspaceId?: string): Promise<HiveDirectoryMeta[]> {
  const reg = await loadHarnessRegistry(workspaceId);
  return Object.values(reg.hiveDirectoryMeta ?? {}).sort((a, b) => b.createdAt - a.createdAt);
}

/** One hive's metadata, or null. */
export async function getOwnedHiveMeta(hiveId: string, workspaceId?: string): Promise<HiveDirectoryMeta | null> {
  const reg = await loadHarnessRegistry(workspaceId);
  return reg.hiveDirectoryMeta?.[hiveId] ?? null;
}

/** Create or update a hive's directory metadata (the create/edit write). */
export async function saveOwnedHiveMeta(meta: HiveDirectoryMeta, workspaceId?: string): Promise<void> {
  if (meta.visibility === 'invite' && !meta.inviteSecret) {
    throw new Error(`saveOwnedHiveMeta: hive ${meta.hiveId} is invite-visibility but has no inviteSecret`);
  }
  const reg = await loadHarnessRegistry(workspaceId);
  reg.hiveDirectoryMeta = { ...(reg.hiveDirectoryMeta ?? {}), [meta.hiveId]: meta };
  await saveHarnessRegistry(reg, workspaceId);
}

/** Remove a hive's directory metadata (delete / stop publishing). */
export async function deleteOwnedHiveMeta(hiveId: string, workspaceId?: string): Promise<void> {
  const reg = await loadHarnessRegistry(workspaceId);
  if (reg.hiveDirectoryMeta?.[hiveId]) {
    delete reg.hiveDirectoryMeta[hiveId];
    await saveHarnessRegistry(reg, workspaceId);
  }
}
