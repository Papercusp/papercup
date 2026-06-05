import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';
import { snapshotsDir, type SnapshotManifest, type SnapshotIndexRow } from '@papercusp/export-state';

import { loadHarnessRegistry } from './harness-registry';
import {
  listIndexedSnapshots,
  reconcileTarballIntoIndex,
  removeIndexedSnapshot,
} from './snapshot-index';

export interface RegisteredProject {
  slug: string;
  path: string;
  harness_kind?: string;
}

export async function readRegistry(): Promise<{ projects: RegisteredProject[] }> {
  return { projects: (await loadHarnessRegistry()).projects as RegisteredProject[] };
}

export async function findProject(slug: string): Promise<RegisteredProject | null> {
  const reg = await readRegistry();
  return reg.projects.find((p) => p.slug === slug) ?? null;
}

export interface PublishRecord {
  slug: string;
  version: string;
  browseUrl: string;
  publishedAtMs: number;
}

export interface SnapshotListing {
  id: string;
  harnessSlug: string;
  tarballPath: string;
  bytes: number;
  createdAtMs: number;
  manifest: SnapshotManifest;
  /** Publish history (from the snapshot_index row, mirrored from `<id>.published.json`). */
  publishes: PublishRecord[];
}

/**
 * Snapshot discovery is **PG-indexed** (hybrid FS+PG home, D-010): the
 * `harness_shared.snapshot_index` table is the source of truth, so a listing is
 * a single query instead of the old FS-walk that `tar -xzO`'d every manifest.
 *
 * An **FS-reconcile sweep** keeps the index honest + self-healing:
 *   - tarballs on disk with no index row (pre-index captures, snapshots that
 *     migrated in via the `.harness`→`.papercusp` rename, or a row that never
 *     got written) are read once and back-filled into the index;
 *   - index rows whose tarball is gone are pruned.
 * The sweep is a cheap `readdir` per project (no per-tarball tar read unless a
 * tarball is actually un-indexed), throttled by the 5 s whole-result TTL cache
 * below, so concurrent `/api/snapshots` callers share one pass.
 *
 * `findSnapshot` calls `listAllSnapshots` and inherits the cache.
 */
const __listCacheKey = Symbol.for('papercusp.snapshotListCache');
interface ListCacheEntry {
  expires: number;
  inflight: Promise<SnapshotListing[]> | null;
  value: SnapshotListing[] | null;
}
type ListCacheGlobals = typeof globalThis & { [__listCacheKey]?: ListCacheEntry };
const __listCache: ListCacheEntry = (() => {
  const g = globalThis as ListCacheGlobals;
  if (!g[__listCacheKey]) g[__listCacheKey] = { expires: 0, inflight: null, value: null };
  return g[__listCacheKey]!;
})();

function rowToListing(r: SnapshotIndexRow): SnapshotListing {
  return {
    id: r.snapshotId,
    harnessSlug: r.harnessSlug,
    tarballPath: r.tarballPath,
    bytes: r.bytes,
    createdAtMs: r.createdAtMs,
    manifest: r.manifest as SnapshotManifest,
    publishes: r.published,
  };
}

/** Every snapshot tarball currently on disk across registered projects. */
async function collectTarballsOnDisk(
  projects: RegisteredProject[],
): Promise<{ id: string; tarballPath: string }[]> {
  const perProject = await Promise.all(
    projects.map(async (project) => {
      const dir = snapshotsDir(project.path);
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [] as { id: string; tarballPath: string }[];
      }
      return entries
        .filter((e) => e.isFile() && e.name.startsWith('snap_') && e.name.endsWith('.tar.gz'))
        .map((e) => ({ id: e.name.replace(/\.tar\.gz$/, ''), tarballPath: join(dir, e.name) }));
    }),
  );
  return perProject.flat();
}

async function listAllSnapshotsUncached(): Promise<SnapshotListing[]> {
  const reg = await readRegistry();
  // PG index — the discovery source of truth.
  const indexRows = await listIndexedSnapshots();
  const byId = new Map(indexRows.map((r) => [r.snapshotId, r]));

  // FS sweep — reconcile orphan tarballs in, detect gone ones.
  const onDisk = await collectTarballsOnDisk(reg.projects);
  const onDiskIds = new Set(onDisk.map((t) => t.id));

  const orphans = onDisk.filter((t) => !byId.has(t.id));
  if (orphans.length > 0) {
    const reconciled = await Promise.all(orphans.map((t) => reconcileTarballIntoIndex(t.tarballPath)));
    for (const r of reconciled) if (r) byId.set(r.snapshotId, r);
  }

  // Prune index rows whose tarball no longer exists (not on disk + file missing).
  const prunable = indexRows.filter((r) => !onDiskIds.has(r.snapshotId) && !existsSync(r.tarballPath));
  if (prunable.length > 0) {
    await Promise.all(
      prunable.map((r) => removeIndexedSnapshot(r.harnessSlug, r.snapshotId).catch(() => {})),
    );
    for (const r of prunable) byId.delete(r.snapshotId);
  }

  return [...byId.values()].map(rowToListing).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

export async function listAllSnapshots(): Promise<SnapshotListing[]> {
  const now = Date.now();
  const TTL_MS = 5_000;
  if (__listCache.value && __listCache.expires > now) return __listCache.value;
  if (!__listCache.inflight) {
    __listCache.inflight = (async () => {
      const result = await listAllSnapshotsUncached();
      __listCache.value = result;
      __listCache.expires = Date.now() + TTL_MS;
      __listCache.inflight = null;
      return result;
    })();
  }
  return __listCache.inflight;
}

export async function findSnapshot(id: string): Promise<SnapshotListing | null> {
  const all = await listAllSnapshots();
  return all.find((s) => s.id === id) ?? null;
}
