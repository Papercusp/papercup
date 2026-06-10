/**
 * GET /api/admin/inference-gateway/stats — the live rate-headroom + queue view of the hive
 * inference gateway (hive-inference-gateway-2026-06-09 P-014). The gateway runs as its own
 * localhost service; this reads its `/stats` over the loopback hop and returns the normalized
 * read-model the `/admin` surface renders. `reachable:false` (never an error) when it's offline.
 */
import { fetchGatewayHeadroom } from '../../../inference-gateway/observability';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/admin/inference-gateway/stats',
  auth: { trust: ['verified', 'trusted'] },
  async handler() {
    const headroom = await fetchGatewayHeadroom();
    return Response.json({ ok: true, gateway: headroom });
  },
});
