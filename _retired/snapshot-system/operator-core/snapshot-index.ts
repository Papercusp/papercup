/**
 * Operator-side wrapper over the export-state snapshot index — the PG half of
 * the hybrid FS+PG snapshot home (harness-blueprint-distribution-2026-06-03
 * E3 / P-006 / D-010).
 *
 * The reusable, DB-handle-agnostic mechanics live in
 * `@papercusp/export-state` (`buildSnapshotIndexRow` + `upsert/list/get/delete`,
 * each taking a postgres-js `Sql`). This module is the thin operator concern:
 * it supplies the operator's admin `Sql` (`getOrgPg().sql`) + the active
 * workspace id, and folds in the FS-side facts (tarball sha256 sidecar, publish
 * sidecar) so the route + discovery layers stay terse.
 *
 *   - `indexSnapshot`            — write a row from a fresh capture result.
 *   - `reconcileTarballIntoIndex`— derive a row from a tarball already on disk
 *     (manifest + sha + publishes) and upsert it. Used by the discovery
 *     FS-reconcile sweep (backfills pre-index / migrated tarballs) and by
 *     publish (re-reads the updated publish sidecar into the row).
 *   - `listIndexedSnapshots` / `getIndexedSnapshot` / `removeIndexedSnapshot`
 *     — workspace-scoped reads/delete.
 */
import { promises as fs } from 'node:fs';
import { getOrgPg } from '@papercusp/db-org';
import {
  buildSnapshotIndexRow,
  upsertSnapshotIndexRow,
  listSnapshotIndex,
  getSnapshotIndexRow,
  deleteSnapshotIndexRow,
  readManifestFromTarball,
  type SnapshotIndexRow,
  type SnapshotManifest,
  type SnapshotPublishRecord,
} from '@papercusp/export-state';
import { activeWorkspaceId } from './workspace-registry';

/**
 * Read the tarball's sha256 from its `<tarball>.sha256` sidecar (written by
 * export-state `capture()` as `"<sha>  <id>.tar.gz"`). Returns null if absent
 * (e.g. a tarball that predates the sidecar) — content_hash is nullable.
 */
export async function readTarballSha(tarballPath: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(`${tarballPath}.sha256`, 'utf8');
    const tok = raw.trim().split(/\s+/)[0];
    return tok ? tok : null;
  } catch {
    return null;
  }
}

/** Read the `<id>.published.json` publish-history sidecar (empty when never published). */
export async function readPublishesSidecar(tarballPath: string): Promise<SnapshotPublishRecord[]> {
  const sidecar = tarballPath.replace(/\.tar\.gz$/, '.published.json');
  try {
    const parsed = JSON.parse(await fs.readFile(sidecar, 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is SnapshotPublishRecord =>
        x && typeof x === 'object'
        && typeof x.slug === 'string'
        && typeof x.version === 'string'
        && typeof x.browseUrl === 'string'
        && typeof x.publishedAtMs === 'number',
    );
  } catch {
    return [];
  }
}

/** Upsert the index row for a freshly captured snapshot. */
export async function indexSnapshot(
  manifest: SnapshotManifest,
  opts: { tarballPath: string; bytes: number; contentHash?: string | null; published?: SnapshotPublishRecord[] },
): Promise<SnapshotIndexRow> {
  const { sql } = getOrgPg();
  const row = buildSnapshotIndexRow(manifest, {
    workspaceId: activeWorkspaceId(),
    tarballPath: opts.tarballPath,
    bytes: opts.bytes,
    contentHash: opts.contentHash ?? null,
    published: opts.published,
  });
  await upsertSnapshotIndexRow(sql, row);
  return row;
}

/**
 * Build + upsert an index row from a tarball already on disk: reads its
 * manifest (one `tar -xzO`), sha256 sidecar, publish sidecar, and stat. Returns
 * the row, or null if the tarball can't be read (best-effort — a bad tarball
 * must not break the caller's listing/publish flow).
 */
export async function reconcileTarballIntoIndex(tarballPath: string): Promise<SnapshotIndexRow | null> {
  try {
    const [stat, manifest, contentHash, published] = await Promise.all([
      fs.stat(tarballPath),
      readManifestFromTarball(tarballPath),
      readTarballSha(tarballPath),
      readPublishesSidecar(tarballPath),
    ]);
    return await indexSnapshot(manifest, { tarballPath, bytes: stat.size, contentHash, published });
  } catch {
    return null;
  }
}

/** List the active workspace's indexed snapshots (optionally one harness), newest first. */
export async function listIndexedSnapshots(harnessSlug?: string): Promise<SnapshotIndexRow[]> {
  const { sql } = getOrgPg();
  return listSnapshotIndex(sql, { workspaceId: activeWorkspaceId(), harnessSlug });
}

/** Fetch one indexed snapshot row, or null. */
export async function getIndexedSnapshot(harnessSlug: string, snapshotId: string): Promise<SnapshotIndexRow | null> {
  const { sql } = getOrgPg();
  return getSnapshotIndexRow(sql, { workspaceId: activeWorkspaceId(), harnessSlug, snapshotId });
}

/** Remove an indexed snapshot row (on tarball delete / retract / prune). */
export async function removeIndexedSnapshot(harnessSlug: string, snapshotId: string): Promise<void> {
  const { sql } = getOrgPg();
  await deleteSnapshotIndexRow(sql, { workspaceId: activeWorkspaceId(), harnessSlug, snapshotId });
}
