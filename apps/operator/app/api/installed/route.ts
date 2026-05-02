import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspPath } from '@/lib/papercusp-root';
import { loadHarnessRegistry } from '@/lib/harness-registry';
export const dynamic = 'force-dynamic';

interface RegistryShape {
  projects: Array<{ slug: string; path: string; harnessKind?: string; addedAt?: string }>;
}

interface AnnotatedProject {
  slug: string;
  path: string;
  harnessKind?: string;
  addedAt?: string;
  /** True when `path` exists on disk; false when the registry entry is stale.
   *  Stale entries accumulate when an operator deletes a forked project dir
   *  (e.g. cleanup after instantiating a snapshot) without also pruning the
   *  registry. The UI can hide or visually demote `exists: false` rows. */
  exists: boolean;
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function listInstalledHarnesses(): Promise<Array<{ slug: string; version: string | null; description: string | null }>> {
  const harnessesDir = papercuspPath('harnesses');
  try {
    const dirs = await fs.readdir(harnessesDir, { withFileTypes: true });
    const out: Array<{ slug: string; version: string | null; description: string | null }> = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const manifest = await readJson<{ name: string; version: string; description?: string }>(
        join(harnessesDir, d.name, 'papercusp.json'),
      );
      out.push({
        slug: d.name,
        version: manifest?.version ?? null,
        description: manifest?.description ?? null,
      });
    }
    return out.sort((a, b) => a.slug.localeCompare(b.slug));
  } catch {
    return [];
  }
}

export function annotateProjectExistence(
  projects: RegistryShape['projects'],
): { annotated: AnnotatedProject[]; staleCount: number } {
  let staleCount = 0;
  const annotated = projects.map((p) => {
    const exists = existsSync(p.path);
    if (!exists) staleCount++;
    return { ...p, exists };
  });
  return { annotated, staleCount };
}

export async function GET() {
  const reg = loadHarnessRegistry();
  const { annotated, staleCount } = annotateProjectExistence(reg.projects);
  const harnesses = await listInstalledHarnesses();
  return NextResponse.json({
    projects: annotated,
    staleCount,
    harnesses,
  });
}
