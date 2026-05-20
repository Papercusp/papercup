/**
 * GET /api/agent-mcp/operator-multi-workspace — other workspaces' last-scan aggregation.
 * Ported from app/api/agent-mcp/operator-multi-workspace/route.ts. `auth: 'public'`.
 */
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { readMultiWorkspaceSnapshot } from '@/lib/operator-multi-workspace';
import { defineRoute } from '../../define-route';

export default defineRoute({
  method: 'GET',
  path: '/agent-mcp/operator-multi-workspace',
  auth: 'public',
  async handler() {
    const snap = await readMultiWorkspaceSnapshot(activeWorkspaceId());
    return Response.json(snap);
  },
});
