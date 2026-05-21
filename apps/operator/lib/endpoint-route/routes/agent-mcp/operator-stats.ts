/**
 * GET /api/agent-mcp/operator-stats — 7-day operator KPIs.
 * Ported from app/api/agent-mcp/operator-stats/route.ts. `auth: 'public'`.
 */
import { readOperatorStats } from '@/lib/operator-stats';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-stats',
  auth: 'public',
  async handler() {
    const stats = await readOperatorStats();
    return Response.json(stats);
  },
});
