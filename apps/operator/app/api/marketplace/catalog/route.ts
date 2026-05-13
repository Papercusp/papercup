import { NextResponse } from 'next/server';
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import FALLBACK_CATALOG from './fallback-catalog.json';
import { getOrgPg, generated } from '@restart/db-org';

const hp = generated.hiddenPluginsInHarnessShared;

export const dynamic = 'force-dynamic';

/**
 * Plugins hidden from marketplace UIs. Source: harness_shared.hidden_plugins
 * (Migration 036). workspace_id='' rows are global defaults; per-workspace
 * rows can override. Cached for 30s — list changes very infrequently and a
 * brief cache lets the catalog endpoint return without per-request PG round-trips.
 */
let _hiddenCache: { value: Set<string>; expires: number } | null = null;
const HIDDEN_TTL_MS = 30_000;

async function getHiddenBasenames(): Promise<Set<string>> {
  const now = Date.now();
  if (_hiddenCache && _hiddenCache.expires > now) return _hiddenCache.value;
  try {
    const { db, sql } = getOrgPg();
    // Idempotent ensure — keeps the route working even if the migration
    // hasn't been applied to a particular environment yet.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS harness_shared.hidden_plugins (
        basename TEXT NOT NULL,
        reason TEXT,
        hidden_at BIGINT NOT NULL DEFAULT 0,
        hidden_by TEXT,
        workspace_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (workspace_id, basename)
      )
    `);
    const rows = await db.select({ basename: hp.basename }).from(hp);
    const set = new Set(rows.map((r) => r.basename));
    _hiddenCache = { value: set, expires: now + HIDDEN_TTL_MS };
    return set;
  } catch {
    return new Set();
  }
}

/**
 * Marketplace catalog API.
 *
 * Proxies to the marketplace server at PAPERCUSP_MARKETPLACE_URL (default
 * http://localhost:3057). If the marketplace is unreachable, returns a
 * curated fallback list so the UI still renders something useful.
 */
// Plugins that aren't ready for users yet — hidden from every catalog
// surface (AddPluginButton, /marketplace/plugins, /installed/plugins).
// Match by the unscoped basename so `@papercupai/<x>` and a future
// rename don't slip through.
function makeIsHidden(hidden: Set<string>) {
  return function isHidden(slugOrName: string | undefined | null): boolean {
    if (!slugOrName) return false;
    const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
    return hidden.has(base);
  };
}
// Fallback catalog (loaded from ./fallback-catalog.json at module
// import) used when the marketplace server is unreachable.

async function fetchPopularity(base: string): Promise<Map<string, number>> {
  try {
    const r = await fetch(`${base}/v1/popular?limit=100`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!r.ok) return new Map();
    const d = await r.json();
    const map = new Map<string, number>();
    for (const p of (d.packages ?? []) as Array<{ slug: string; downloads: number }>) {
      map.set(p.slug, Number(p.downloads) || 0);
    }
    return map;
  } catch {
    return new Map();
  }
}

export async function GET(req: Request) {
  const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
  if (blocked) return blocked;
  const isHidden = makeIsHidden(await getHiddenBasenames());
  const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  // Try DB-backed `/v1/catalog` first (sees R2-only publishes). Fall back to
  // the filesystem-backed `/catalog` if v1 isn't available (e.g. older
  // marketplace-api), then to the hardcoded list below.
  for (const path of ['/v1/catalog', '/catalog']) {
    try {
      const r = await fetch(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (!r.ok) continue;
      const d = await r.json();
      const upstream = (d.catalog ?? []) as any[];
      // Fetch popularity in parallel so the catalog can sort by it without
      // an N+1 round-trip per row. Missing data → 0 (graceful degradation).
      const popularity = path === '/v1/catalog' ? await fetchPopularity(base) : new Map<string, number>();
      // Reshape from marketplace's `{name, version, ...}` to UI's `{slug, name, install, ...}`.
      const items = upstream
        .filter((m: any) => !isHidden(m.slug ?? m.name))
        .map((m: any) => {
          const slug = m.slug ?? m.name;
          return {
            slug,
            name: m.name ?? m.slug,
            version: m.version,
            description: m.description ?? '',
            author: m.author ?? 'unknown',
            license: m.license ?? 'unspecified',
            plugins: m.plugins ?? [],
            homepage: m.homepage ?? null,
            topology: m.topology ?? 'single',
            subprojects: Array.isArray(m.subprojects) ? m.subprojects : [],
            kind: m.kind ?? 'template',
            icon: m.icon ?? null,
            requiresTemplateKinds: Array.isArray(m.requiresTemplateKinds) ? m.requiresTemplateKinds : [],
            retracted: m.retracted,
            install: `papercusp install ${slug}`,
            source: 'live',
            publishedAt: m.publishedAt ?? null,
            publishedBy: m.publishedBy ?? null,
            popularity30d: popularity.get(slug) ?? 0,
          };
        });
      return NextResponse.json({ catalog: items, source: path === '/v1/catalog' ? 'marketplace-db' : 'marketplace-fs' });
    } catch {
      continue;
    }
  }
  // Fallback when marketplace isn't reachable.
  const items = FALLBACK_CATALOG.map((m) => ({
    slug: m.name,
    name: m.name,
    version: m.version,
    description: m.description,
    author: m.author,
    license: m.license,
    plugins: m.plugins,
    homepage: m.homepage ?? null,
    install: `papercusp install ${m.name}`,
    source: 'fallback',
  }));
  return NextResponse.json({ catalog: items, source: 'fallback' });
}
