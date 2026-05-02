/**
 * Prune stale registry entries — remove projects whose `path` no longer
 * exists on disk. Caused most often by an operator deleting a forked
 * project dir (e.g. cleaning up after instantiating a snapshot) without
 * also editing `~/.papercusp/registry.json`.
 *
 * Body (all optional):
 *   - `dryRun`: when true, returns the list of would-be-removed slugs
 *     without writing the registry.
 *   - `slugs`: when provided, restrict pruning to that explicit set
 *     (still subject to the "path must not exist" check). Useful for
 *     UI flows that prompt "remove these N stale entries?" with the
 *     specific slugs the user agreed to.
 *
 * Returns: `{ ok, removed: string[], remaining: number }`. `removed`
 * lists the slugs that were dropped from the registry. The migration
 * is atomic — the new file is written via fs.writeFile, no in-place
 * mutation. Crashes mid-write leave the original registry intact
 * (writeFile's POSIX semantics on the same volume; cross-volume is
 * already not the deployment topology).
 */
import { NextResponse } from 'next/server';
import { existsSync } from 'node:fs';

import { loadHarnessRegistry, saveHarnessRegistry } from '@/lib/harness-registry';
export const dynamic = 'force-dynamic';

interface RegistryShape {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

interface PruneOptions {
  dryRun?: boolean;
  slugs?: string[];
}

interface PruneResult {
  removed: string[];
  kept: RegistryShape['projects'];
}

/**
 * Pure prune logic — drops entries whose `path` does not exist on disk.
 * `existsCheck` is injectable for tests; defaults to fs.existsSync.
 *
 * If `slugs[]` is provided and non-empty, only those slugs are eligible
 * for pruning (still subject to the existence check). Useful for UI
 * flows that prompt "remove these N stale entries?" with a specific set.
 */
export function pruneRegistry(
  reg: RegistryShape,
  opts: PruneOptions = {},
  existsCheck: (path: string) => boolean = existsSync,
): PruneResult {
  const restrictTo = Array.isArray(opts.slugs) && opts.slugs.length > 0
    ? new Set(opts.slugs)
    : null;
  const kept: RegistryShape['projects'] = [];
  const removed: string[] = [];
  for (const p of reg.projects) {
    const isStale = !existsCheck(p.path);
    const inScope = restrictTo === null || restrictTo.has(p.slug);
    if (isStale && inScope) {
      removed.push(p.slug);
    } else {
      kept.push(p);
    }
  }
  return { removed, kept };
}

export async function POST(req: Request) {
  let body: PruneOptions = {};
  try {
    body = await req.json();
  } catch { /* empty body is fine */ }

  const reg = loadHarnessRegistry();
  const { removed, kept } = pruneRegistry(reg, body);

  if (!body.dryRun && removed.length > 0) {
    await saveHarnessRegistry({ projects: kept });
  }

  return NextResponse.json({
    ok: true,
    removed,
    remaining: kept.length,
    dryRun: !!body.dryRun,
  });
}
