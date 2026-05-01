import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Marketplace harness detail proxy.
 *
 * Returns the latest manifest + readme for a published slug. Falls back
 * to a 404 if the marketplace is unreachable or the slug isn't published.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const raw = (await ctx.params).slug;
  // Next.js routes preserve URL-encoded path params; decode for downstream
  // use so `@papercupai/fumadocs` (encoded `%40papercupai%2Ffumadocs`) is
  // recognized as a valid scoped slug.
  const slug = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
  const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
  // Slug shape: bare `name` or scoped `@owner/name` (npm-style).
  const SLUG_RE = /^@?[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/i;
  if (!SLUG_RE.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  // Re-encode for upstream — `/` in scoped slug must stay a single path
  // segment and `@` must be percent-encoded.
  const slugPath = encodeURIComponent(slug);
  try {
    const r = await fetch(`${base}/catalog/${slugPath}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
    if (!r.ok) return NextResponse.json({ error: 'not found' }, { status: 404 });
    const detail = await r.json();
    const latestVersion = detail.versions?.[0];
    // Fan out to /catalog/:slug/:version, /v1/packages/:slug/:version/sbom,
    // and /v1/packages/:slug/reviews in parallel. None are critical;
    // failures (404 sbom = no SBOM uploaded yet) silently degrade.
    const [manifestRes, sbomRes, reviewsRes] = await Promise.all([
      latestVersion
        ? fetch(`${base}/catalog/${slugPath}/${encodeURIComponent(latestVersion)}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).catch(() => null)
        : Promise.resolve(null),
      latestVersion
        ? fetch(`${base}/v1/packages/${slugPath}/${encodeURIComponent(latestVersion)}/sbom`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).catch(() => null)
        : Promise.resolve(null),
      fetch(`${base}/v1/packages/${slugPath}/reviews`, { cache: 'no-store', signal: AbortSignal.timeout(2000) }).catch(() => null),
    ]);
    let manifest: unknown = undefined;
    let readme: string | null | undefined = undefined;
    if (manifestRes?.ok) {
      const full = await manifestRes.json();
      manifest = full.manifest;
      readme = full.readme;
    }
    let sbom: { format?: string; vulnerabilities?: { total: number; high: number; critical: number; medium: number; low: number } } | null = null;
    if (sbomRes?.ok) sbom = await sbomRes.json();
    let reviews: { summary?: { reviewCount: number; averageRating: number; histogram: Record<string, number> } | null } | null = null;
    if (reviewsRes?.ok) reviews = await reviewsRes.json();
    return NextResponse.json({ ...detail, manifest, readme, sbom, reviews });
  } catch (e: any) {
    return NextResponse.json({ error: 'marketplace unreachable' }, { status: 503 });
  }
}
