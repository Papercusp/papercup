/**
 * POST /api/security-advisories/check
 *
 * Consults the marketplace catalog for known advisories on a pinned
 * plugin version. Ported from app/api/security-advisories/check/route.ts.
 * `auth: 'public'`.
 */
import {
  checkPinnedVersionAdvisories,
  type AdvisorySeverity,
  type CatalogClient,
  type MarketplaceCatalogEntry,
} from '@/lib/security-advisories';
import { defineTool } from '@papercusp/agent-mcp';

const MARKETPLACE_URL = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

const httpCatalogClient: CatalogClient = {
  async getEntry(pluginSlug, version): Promise<MarketplaceCatalogEntry | null> {
    const url = `${MARKETPLACE_URL}/api/catalog/${encodeURIComponent(pluginSlug)}/${encodeURIComponent(version)}`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: 'application/json' } });
    } catch (e: unknown) {
      throw new Error(`marketplace fetch failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`marketplace returned HTTP ${res.status}`);
    return ((await res.json()) as MarketplaceCatalogEntry) ?? null;
  },
  async getLatestSafe(pluginSlug, minSeverity) {
    const url = `${MARKETPLACE_URL}/api/catalog/${encodeURIComponent(pluginSlug)}/latest-safe?minSeverity=${minSeverity}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      return ((await res.json()) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  },
};

interface Body {
  plugin?: string;
  version?: string;
  minSeverity?: AdvisorySeverity;
}

export default defineTool({
  method: 'POST',
  path: '/security-advisories/check',
  auth: 'public',
  async handler(req) {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return Response.json({ ok: false, error: 'invalid json' }, { status: 400 });
    }
    if (!body.plugin || !body.version) {
      return Response.json({ ok: false, error: 'plugin + version required' }, { status: 400 });
    }
    const result = await checkPinnedVersionAdvisories(
      httpCatalogClient,
      body.plugin,
      body.version,
      body.minSeverity ?? 'moderate',
    );
    return Response.json({ ok: true, result });
  },
});
