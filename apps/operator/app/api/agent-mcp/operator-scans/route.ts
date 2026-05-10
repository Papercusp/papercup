/**
 * GET /api/agent-mcp/operator-scans?limit=20         → recent scans for the active workspace
 * GET /api/agent-mcp/operator-scans?id=123           → single scan with full suggestions
 * GET /api/agent-mcp/operator-scans?q=harness&limit=10 → ILIKE-search summary/request/suggestions
 *
 * Read endpoint for the Scan History tab in the operator panel.
 */
import { NextRequest } from 'next/server';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { getOperatorScan, listOperatorScans, searchOperatorScans } from '@/lib/operator-scans';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
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
      // Table not yet ensured (first call before any scan ran). Empty
      // is the right answer; the next scan will create + populate.
      return Response.json({ scans: [] });
    }
    throw e;
  }
}
