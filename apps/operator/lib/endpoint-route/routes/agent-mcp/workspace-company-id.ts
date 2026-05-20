/**
 * GET/PUT /api/agent-mcp/workspace/company-id — Paperclip companyId.
 * Ported from app/api/agent-mcp/workspace/company-id/route.ts. `auth: 'public'`.
 */
import {
  activeWorkspaceId,
  setCompanyId,
  companyIdFor,
} from '@/lib/workspace-registry';
import { defineRoute } from '../../define-route';

const get = defineRoute({
  method: 'GET',
  path: '/agent-mcp/workspace/company-id',
  auth: 'public',
  async handler() {
    const workspaceId = activeWorkspaceId();
    return Response.json({
      workspaceId,
      companyId: companyIdFor(workspaceId),
    });
  },
});

const put = defineRoute({
  method: 'PUT',
  path: '/agent-mcp/workspace/company-id',
  auth: 'public',
  async handler(req) {
    const { companyId } = (await req.json()) as { companyId: string | null };
    const workspaceId = activeWorkspaceId();
    setCompanyId(workspaceId, companyId);
    return Response.json({ workspaceId, companyId });
  },
});

export default [get, put];
