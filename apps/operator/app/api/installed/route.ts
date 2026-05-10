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

// 2-second TTL cache. The data sources here (registry JSON, fs.readdir over
// the harnesses dir, existsSync on each project path) are cheap on a clean
// machine but expensive on a dev box where paperclip is concurrently
// rewriting `~/.papercusp-workspaces/<id>/.papercusp/harnesses`: fs cache
// thrash + Turbopack route module re-evaluation pushed steady-state
// /api/installed to 2.3-4.4s in diagnostic 2026-05-06. Pin to globalThis so
// dev's per-request module re-eval doesn't reset it.
type Payload = { projects: AnnotatedProject[]; staleCount: number; harnesses: Awaited<ReturnType<typeof listInstalledHarnesses>> };
const CACHE_TTL_MS = 2000;
type _G = {
  __installedCache?: { ts: number; payload: Payload };
  __installedInflight?: Promise<Payload>;
};
const _g = globalThis as unknown as _G;

async function compute(): Promise<Payload> {
  const reg = await loadHarnessRegistry();
  const { annotated, staleCount } = annotateProjectExistence(reg.projects);
  const harnesses = await listInstalledHarnesses();
  return { projects: annotated, staleCount, harnesses };
}

export async function GET() {
  const now = Date.now();
  const hit = _g.__installedCache;
  if (hit && now - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json(hit.payload, {
      headers: { 'X-Cache': 'HIT', 'X-Cache-Age': String(now - hit.ts) },
    });
  }
  // Single-flight: collapse concurrent burst (dashboard mount fires this
  // from multiple effects on the same tick) into one fs walk.
  if (_g.__installedInflight) {
    const payload = await _g.__installedInflight;
    return NextResponse.json(payload, { headers: { 'X-Cache': 'COALESCED' } });
  }
  _g.__installedInflight = compute();
  try {
    const payload = await _g.__installedInflight;
    _g.__installedCache = { ts: Date.now(), payload };
    return NextResponse.json(payload, { headers: { 'X-Cache': 'MISS' } });
  } finally {
    _g.__installedInflight = undefined;
  }
}
