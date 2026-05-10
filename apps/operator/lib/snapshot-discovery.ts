import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { snapshotsDir, readManifestFromTarball, type SnapshotManifest } from '@papercusp/export-state';

import { loadHarnessRegistry } from '@/lib/harness-registry';

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
  /** Publish history loaded from `<id>.published.json`. Empty when never published. */
  publishes: PublishRecord[];
}

async function readPublishes(tarballPath: string): Promise<PublishRecord[]> {
  const sidecar = tarballPath.replace(/\.tar\.gz$/, '.published.json');
  try {
    const raw = await fs.readFile(sidecar, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is PublishRecord =>
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

/**
 * Walk every registered project's `.harness/snapshots/` and return the
 * union, with manifests parsed (from the tarball) for each entry.
 *
 * The manifest read does a `tar -xzOf` per snapshot — measured 2026-05-05
 * at ~50 ms per call × 50 snapshots = 2.1 s p50 under c=10 contention.
 * Two optimisations:
 *
 *   1. Per-tarball manifest cache keyed on path + mtime + size. Snapshots
 *      are immutable once written, so once we've parsed a manifest we never
 *      need to re-tar it. The cache survives between calls in the same
 *      process. Bypassed automatically if the file is rewritten.
 *
 *   2. Whole-result TTL cache (5 s) so concurrent /api/snapshots callers
 *      under load share one walk via an in-flight promise. The /api/
 *      snapshots endpoint is read-only; staleness is measured in seconds.
 *
 * `findSnapshot` calls `listAllSnapshots` and inherits both caches.
 */
const __manifestCacheKey = Symbol.for('papercusp.snapshotManifestCache');
type ManifestCacheGlobals = typeof globalThis & {
  [__manifestCacheKey]?: Map<string, { sig: string; manifest: SnapshotManifest }>;
};
const __manifestCache: Map<string, { sig: string; manifest: SnapshotManifest }> = (() => {
  const g = globalThis as ManifestCacheGlobals;
  if (!g[__manifestCacheKey]) g[__manifestCacheKey] = new Map();
  return g[__manifestCacheKey]!;
})();

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

async function readManifestCached(tarballPath: string, sig: string): Promise<SnapshotManifest> {
  const cached = __manifestCache.get(tarballPath);
  if (cached && cached.sig === sig) return cached.manifest;
  const manifest = await readManifestFromTarball(tarballPath);
  __manifestCache.set(tarballPath, { sig, manifest });
  return manifest;
}

async function listAllSnapshotsUncached(): Promise<SnapshotListing[]> {
  const reg = await readRegistry();
  // Parallelise both axes: project loop and per-file manifest reads.
  // Was a serial nested for-loop; on this machine that meant ~50 ms × 50
  // tarballs = 2.5 s wall-clock. Parallel collapses to a few hundred ms.
  const perProject = await Promise.all(reg.projects.map(async (project) => {
    const dir = snapshotsDir(project.path);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [] as SnapshotListing[];
    }
    const candidates = entries.filter((e) => e.isFile() && e.name.startsWith('snap_') && e.name.endsWith('.tar.gz'));
    return await Promise.all(candidates.map(async (e): Promise<SnapshotListing | null> => {
      const tarballPath = join(dir, e.name);
      const id = e.name.replace(/\.tar\.gz$/, '');
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(tarballPath);
      } catch {
        return null;
      }
      const sig = `${stat.mtimeMs}:${stat.size}`;
      let manifest: SnapshotManifest;
      try {
        manifest = await readManifestCached(tarballPath, sig);
      } catch {
        return null;
      }
      const publishes = await readPublishes(tarballPath);
      return {
        id,
        harnessSlug: project.slug,
        tarballPath,
        bytes: stat.size,
        createdAtMs: manifest.createdAt ?? stat.mtimeMs,
        manifest,
        publishes,
      };
    })).then((results) => results.filter((r): r is SnapshotListing => r != null));
  }));
  const out = perProject.flat();
  out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return out;
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
