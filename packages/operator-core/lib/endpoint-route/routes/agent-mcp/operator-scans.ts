/**
 * GET /api/agent-mcp/operator-scans — recent / single / search scan history.
 * Ported from app/api/agent-mcp/operator-scans/route.ts. `auth: 'public'`.
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { getOperatorScan, listOperatorScans, searchOperatorScans } from '../../../operator-scans';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/agent-mcp/operator-scans',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const workspaceId = activeWorkspaceId();
    const idParam = url.searchParams.get('id');
    if (idParam) {
      const id = Number(idParam);
      if (!Number.isFinite(id)) {
        return Response.json({ error: 'id must be an integer' }, { status: 400 });
      }
      const scan = await getOperatorScan({ workspaceId, id });
      return Response.json({ scan });
    }
    const limit = url.searchParams.get('limit')
      ? Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit')!, 10) || 20))
      : 20;
    const q = url.searchParams.get('q');
    try {
      const scans = q
        ? await searchOperatorScans({ workspaceId, query: q, limit })
        : await listOperatorScans({ workspaceId, limit });
      return Response.json({ scans });
    } catch (e: any) {
      if (/relation .*operator_scans.* does not exist/i.test(e?.message ?? '')) {
        return Response.json({ scans: [] });
      }
      throw e;
    }
  },
});
