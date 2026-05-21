/**
 * GET /api/marketplace/catalog
 *
 * Proxies to the marketplace server at PAPERCUSP_MARKETPLACE_URL (default
 * http://localhost:3057). Tries /v1/catalog (DB-backed, sees R2-only
 * publishes) → /catalog (filesystem) → bundled fallback list. Filters
 * out hidden plugins from harness_shared.hidden_plugins (cached 30s).
 *
 * Ported from app/api/marketplace/catalog/route.ts. `auth: 'public'`.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { getOrgPg, generated } from '@restart/db-org';
import FALLBACK_CATALOG from './fallback-catalog.json';
import { defineTool } from '@papercusp/agent-mcp';

const hp = generated.hiddenPluginsInHarnessShared;

let _hiddenCache: { value: Set<string>; expires: number } | null = null;
const HIDDEN_TTL_MS = 30_000;

async function getHiddenBasenames(): Promise<Set<string>> {
  const now = Date.now();
  if (_hiddenCache && _hiddenCache.expires > now) return _hiddenCache.value;
  try {
    const { db, sql } = getOrgPg();
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

function makeIsHidden(hidden: Set<string>) {
  return function isHidden(slugOrName: string | undefined | null): boolean {
    if (!slugOrName) return false;
    const base = slugOrName.includes('/') ? slugOrName.split('/').pop()! : slugOrName;
    return hidden.has(base);
  };
}

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

export default defineTool({
  method: 'GET',
  path: '/marketplace/catalog',
  auth: 'public',
  async handler(req) {
    const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
    if (blocked) return blocked;
    const isHidden = makeIsHidden(await getHiddenBasenames());
    const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
    for (const path of ['/v1/catalog', '/catalog']) {
      try {
        const r = await fetch(`${base}${path}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
        if (!r.ok) continue;
        const d = await r.json();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const upstream = (d.catalog ?? []) as any[];
        const popularity = path === '/v1/catalog' ? await fetchPopularity(base) : new Map<string, number>();
        const items = upstream
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((m: any) => !isHidden(m.slug ?? m.name))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((m: any) => {
            const slug = m.slug ?? m.name;
            return {
              slug, name: m.name ?? m.slug, version: m.version,
              description: m.description ?? '',
              author: m.author ?? 'unknown', license: m.license ?? 'unspecified',
              plugins: m.plugins ?? [], homepage: m.homepage ?? null,
              topology: m.topology ?? 'single',
              subprojects: Array.isArray(m.subprojects) ? m.subprojects : [],
              kind: m.kind ?? 'template', icon: m.icon ?? null,
              requiresTemplateKinds: Array.isArray(m.requiresTemplateKinds) ? m.requiresTemplateKinds : [],
              retracted: m.retracted,
              install: `papercusp install ${slug}`,
              source: 'live',
              publishedAt: m.publishedAt ?? null,
              publishedBy: m.publishedBy ?? null,
              popularity30d: popularity.get(slug) ?? 0,
            };
          });
        return Response.json({ catalog: items, source: path === '/v1/catalog' ? 'marketplace-db' : 'marketplace-fs' });
      } catch {
        continue;
      }
    }
    const items = FALLBACK_CATALOG.map((m) => ({
      slug: m.name, name: m.name, version: m.version,
      description: m.description, author: m.author, license: m.license,
      plugins: m.plugins, homepage: m.homepage ?? null,
      install: `papercusp install ${m.name}`,
      source: 'fallback',
    }));
    return Response.json({ catalog: items, source: 'fallback' });
  },
});
