/**
 * GET /api/plugins/updates
 *   → { updates: { slug, name, installed, available, capChange }[] }
 *
 * Cross-references installed plugins (~/.papercusp/global-plugins/*) with
 * the catalog at PAPERCUSP_MARKETPLACE_URL. An entry is returned only when
 * the catalog version is strictly greater than the installed version (per
 * naive lexical compare with prerelease tail trim — semver-correct enough
 * for now; full semver pulled in later if the false-negative rate matters).
 *
 * `capChange` summarises what would change in the manifest's declared
 * capabilities — the install-plugin endpoint reuses this to know whether
 * to re-prompt for grants.
 */

import { NextResponse } from 'next/server';
import { promises as fs, existsSync } from 'node:fs';
import { join } from 'node:path';

import { papercuspRoot } from '@/lib/papercusp-root';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface InstalledManifest {
  name: string;
  version: string;
  capabilities?: string[];
  source?: string;
  path?: string;
}

interface CatalogEntry {
  kind?: string;
  name?: string;
  version?: string;
  capabilities?: string[];
  /** Marketplace retraction status — 'active' is the healthy state. */
  retracted?: string | boolean;
}

interface CapChange {
  added: string[];
  removed: string[];
  unchanged: string[];
}

interface UpdateRow {
  slug: string;
  name: string;
  installed: string;
  available: string;
  capChange: CapChange;
}

async function readJson<T>(p: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(p, 'utf8')) as T; } catch { return null; }
}

async function listInstalled(): Promise<InstalledManifest[]> {
  const root = join(papercuspRoot(), 'global-plugins');
  if (!existsSync(root)) return [];
  const out: InstalledManifest[] = [];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const dir = join(root, e.name);
    const m = await readJson<InstalledManifest>(join(dir, 'papercusp.json'));
    if (m?.name && m?.version) {
      out.push({ ...m, path: dir });
      continue;
    }
    if (!e.name.startsWith('@')) continue;
    const inner = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const sub of inner) {
      if (sub.name.startsWith('.')) continue;
      const subDir = join(dir, sub.name);
      const sm = await readJson<InstalledManifest>(join(subDir, 'papercusp.json'));
      if (sm?.name && sm?.version) out.push({ ...sm, path: subDir });
    }
  }
  // Dedup by name
  const seen = new Set<string>();
  return out.filter((p) => {
    if (seen.has(p.name)) return false;
    seen.add(p.name);
    return true;
  });
}

export function isNewerVersion(available: string, installed: string): boolean {
  if (available === installed) return false;
  const norm = (v: string) => v.replace(/^v/, '');
  const a = norm(available).split(/[.+-]/);
  const b = norm(installed).split(/[.+-]/);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? '0';
    const bi = b[i] ?? '0';
    const an = Number(ai);
    const bn = Number(bi);
    if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an > bn;
    if (ai !== bi) return ai > bi;
  }
  return false;
}

export function computeCapChange(from: string[] = [], to: string[] = []): CapChange {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const c of toSet) {
    if (fromSet.has(c)) unchanged.push(c);
    else added.push(c);
  }
  for (const c of fromSet) {
    if (!toSet.has(c)) removed.push(c);
  }
  return { added: added.sort(), removed: removed.sort(), unchanged: unchanged.sort() };
}

export async function GET() {
  const marketplaceUrl = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  let catalog: CatalogEntry[] = [];
  try {
    const r = await fetch(`${marketplaceUrl}/v1/catalog`, { cache: 'no-store' });
    if (!r.ok) return NextResponse.json({ updates: [], error: `catalog ${r.status}` });
    const d = await r.json();
    catalog = Array.isArray(d?.catalog) ? d.catalog : [];
  } catch (e: unknown) {
    return NextResponse.json({ updates: [], error: `catalog unreachable: ${(e as Error).message}` });
  }

  const installed = await listInstalled();
  const catBySlug = new Map<string, CatalogEntry>();
  for (const c of catalog) {
    if (c.kind && c.kind !== 'plugin') continue;
    // Retraction is a string status: 'active' / 'deprecated' / 'withdrawn'
    // / 'quarantined'. Anything except 'active' (or unset) means don't
    // surface as an upgrade target.
    if (typeof c.retracted === 'string' && c.retracted !== 'active') continue;
    if (c.retracted === true) continue;
    if (c.name && c.version) {
      const existing = catBySlug.get(c.name);
      if (!existing || isNewerVersion(c.version, existing.version!)) {
        catBySlug.set(c.name, c);
      }
    }
  }

  const updates: UpdateRow[] = [];
  for (const i of installed) {
    const c = catBySlug.get(i.name);
    if (!c?.version) continue;
    if (!isNewerVersion(c.version, i.version)) continue;
    updates.push({
      slug: i.name,
      name: i.name,
      installed: i.version,
      available: c.version,
      capChange: computeCapChange(i.capabilities, c.capabilities),
    });
  }
  return NextResponse.json({ updates });
}
