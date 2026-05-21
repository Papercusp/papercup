/**
 * GET /api/marketplace/:slug
 *
 * Returns the latest manifest + readme + SBOM + reviews for a published
 * slug. 404 if marketplace doesn't have it, 503 if unreachable.
 *
 * Ported from app/api/marketplace/[slug]/route.ts. `auth: 'public'`.
 */
import { FLAGS } from '@papercusp/flags';
import { gateApiRoute } from '@/lib/require-flag';
import { defineTool } from '@papercusp/agent-mcp';

const SLUG_RE = /^@?[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})?$/i;

export default defineTool({
  method: 'GET',
  path: '/marketplace/:slug',
  auth: 'public',
  async handler(req, ctx) {
    const blocked = await gateApiRoute(req, FLAGS.MARKETPLACE);
    if (blocked) return blocked;
    const raw = ctx.params.slug;
    const slug = (() => { try { return decodeURIComponent(raw); } catch { return raw; } })();
    const base = process.env.PAPERCUSP_MARKETPLACE_URL ?? 'http://localhost:3057';
    if (!SLUG_RE.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const slugPath = encodeURIComponent(slug);
    try {
      const r = await fetch(`${base}/catalog/${slugPath}`, { cache: 'no-store', signal: AbortSignal.timeout(2000) });
      if (!r.ok) return Response.json({ error: 'not found' }, { status: 404 });
      const detail = await r.json();
      const latestVersion = detail.versions?.[0];
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
      return Response.json({ ...detail, manifest, readme, sbom, reviews });
    } catch {
      return Response.json({ error: 'marketplace unreachable' }, { status: 503 });
    }
  },
});
