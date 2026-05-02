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
  return { projects: loadHarnessRegistry().projects as RegisteredProject[] };
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
 * The manifest read does a `tar -xzOf` per snapshot — fine for ~100s but
 * slow at thousands. Caching is a v1.1 concern.
 */
export async function listAllSnapshots(): Promise<SnapshotListing[]> {
  const reg = await readRegistry();
  const out: SnapshotListing[] = [];
  for (const project of reg.projects) {
    const dir = snapshotsDir(project.path);
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      if (!e.name.startsWith('snap_') || !e.name.endsWith('.tar.gz')) continue;
      const tarballPath = join(dir, e.name);
      const id = e.name.replace(/\.tar\.gz$/, '');
      let stat: import('node:fs').Stats;
      try {
        stat = await fs.stat(tarballPath);
      } catch {
        continue;
      }
      let manifest: SnapshotManifest;
      try {
        manifest = await readManifestFromTarball(tarballPath);
      } catch {
        continue;
      }
      const publishes = await readPublishes(tarballPath);
      out.push({
        id,
        harnessSlug: project.slug,
        tarballPath,
        bytes: stat.size,
        createdAtMs: manifest.createdAt ?? stat.mtimeMs,
        manifest,
        publishes,
      });
    }
  }
  out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return out;
}

export async function findSnapshot(id: string): Promise<SnapshotListing | null> {
  const all = await listAllSnapshots();
  return all.find((s) => s.id === id) ?? null;
}
