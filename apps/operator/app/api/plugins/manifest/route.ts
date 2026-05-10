/**
 * GET /api/plugins/manifest?slug=<plugin-name>
 *   → { name, version, capabilities: string[], description?, icon? }
 *
 * Reads the on-disk manifest for an installed plugin. Used by the
 * permissions UI (/installed/plugins/<slug>/permissions) to know which
 * capabilities to surface for grant/revoke.
 */

import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  icon?: string;
  capabilities?: string[];
  [k: string]: unknown;
}

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')) as T; } catch { return null; }
}

async function findManifest(slug: string): Promise<{ manifest: PluginManifest; path: string } | null> {
  const root = join(papercuspRoot(), 'global-plugins');
  if (!existsSync(root)) return null;
  const direct = join(root, slug);
  const directManifest = await readJson<PluginManifest>(join(direct, 'papercusp.json'));
  if (directManifest?.name) return { manifest: directManifest, path: direct };

  // Scoped: walk @scope/<slug>
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.name.startsWith('@')) continue;
    const inner = join(root, e.name, slug);
    const m = await readJson<PluginManifest>(join(inner, 'papercusp.json'));
    if (m?.name) return { manifest: m, path: inner };
  }

  // Last resort: any dir whose manifest.name matches slug
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const m = await readJson<PluginManifest>(join(dir, 'papercusp.json'));
    if (m?.name === slug) return { manifest: m, path: dir };
  }
  return null;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const slug = url.searchParams.get('slug') ?? '';
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });
  const found = await findManifest(slug);
  if (!found) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { manifest } = found;
  return NextResponse.json({
    name: manifest.name,
    version: manifest.version,
    description: manifest.description ?? null,
    icon: manifest.icon ?? null,
    capabilities: Array.isArray(manifest.capabilities) ? manifest.capabilities : [],
  });
}
