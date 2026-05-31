/**
 * GET /api/agent-mcp/capabilities — the palette-eligible server tool catalog
 * for the calling principal (plan capability-metadata-contract-2026-05-31, P-004).
 *
 * Read-only: lists the §3-eligible, principal-gated server capabilities so the
 * command palette can surface the agent tool catalog. Returns the unified
 * `Capability` shape (with an `eligibility` discriminator). Execution authority
 * is re-checked at dispatch by the invoke route — this is a UX projection.
 *
 * `auth: 'public'` follows the sibling agent-mcp routes; the handler resolves
 * the request principal via the standard resolver chain (loopback on desktop)
 * and gates the catalog by its capabilities. A non-resolvable caller gets an
 * empty list, never the catalog.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { tryResolvePrincipal } from '@/lib/auth/require-principal';
import { getServerCapabilities } from '@/lib/capabilities/server-catalog';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/capabilities',
  auth: 'public',
  async handler(req) {
    // Ensure the tool catalog is registered (idempotent; ESM-cached).
    await import('@/lib/agent-tools');

    const principal = await tryResolvePrincipal(req.headers);
    if (!principal) return Response.json({ capabilities: [] });

    const capabilities = getServerCapabilities({ principal });
    return Response.json({ capabilities });
  },
});
