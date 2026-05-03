/**
 * GET /api/agent-mcp/operator-multi-workspace
 *
 * Returns a read-only aggregation of every OTHER workspace's last-scan
 * snapshot (the active workspace is omitted — it lives in the main
 * panel view). Cards arrive with `workspaceId` + `workspaceName` so the
 * panel can route a click into the correct workspace switch.
 */

import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readMultiWorkspaceSnapshot } from '@/lib/operator-multi-workspace';

export const dynamic = 'force-dynamic';

export async function GET() {
  const snap = readMultiWorkspaceSnapshot(activeWorkspaceId());
  return Response.json(snap);
}
