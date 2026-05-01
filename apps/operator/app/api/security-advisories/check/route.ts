/**
 * POST /api/security-advisories/check
 *
 * Body: { plugin, version, minSeverity? }
 *
 * Returns the result of consulting the marketplace catalog for known
 * advisories on the pinned version of `plugin`. Used by the
 * fork-completion UI to surface a loud prompt when a snapshot pins a
 * vulnerable version.
 *
 * V1: catalog client hits the marketplace HTTP API. If unreachable,
 * returns `state: 'unknown'` and the UI treats it as a soft-flag.
 *
 * Spec: /docs/snapshots/share-semantics#pinning-and-security-advisories.
 */

import { NextResponse } from 'next/server';
import {
  checkPinnedVersionAdvisories,
  type AdvisorySeverity,
  type CatalogClient,
  type MarketplaceCatalogEntry,
} from '@/lib/security-advisories';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MARKETPLACE_URL =
  process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';

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
    const j = (await res.json()) as MarketplaceCatalogEntry;
    return j ?? null;
  },
  async getLatestSafe(pluginSlug, minSeverity) {
    const url = `${MARKETPLACE_URL}/api/catalog/${encodeURIComponent(pluginSlug)}/latest-safe?minSeverity=${minSeverity}`;
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return null;
      const j = (await res.json()) as { version?: string };
      return j.version ?? null;
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

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 });
  }
  if (!body.plugin || !body.version) {
    return NextResponse.json(
      { ok: false, error: 'plugin + version required' },
      { status: 400 },
    );
  }
  const result = await checkPinnedVersionAdvisories(
    httpCatalogClient,
    body.plugin,
    body.version,
    body.minSeverity ?? 'moderate',
  );
  return NextResponse.json({ ok: true, result });
}
