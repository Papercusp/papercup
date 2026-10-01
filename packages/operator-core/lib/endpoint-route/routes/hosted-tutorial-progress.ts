import { defineTool } from '@papercusp/agent-mcp';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, tenantContext, workspaceHeaderMismatch } from '../hosted-browser-context';
import { readTutorialProgress, updateTutorialProgress, tutorialProgressUpdateSchema, TutorialProgressConflict } from '../../onboarding/cloud-tutorial-progress';
export const HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH = '/hosted/browser/onboarding/tutorial-progress' as const;
export function createHostedTutorialProgressRoutes({ origin, controlPlaneWorkspaceId, runTenant }: {
  origin: string; controlPlaneWorkspaceId: string;
  runTenant: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  return (['GET', 'POST'] as const).map(method => defineTool({
    method, path: HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH,
    auth: { capabilities: ['workspace:view'], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const selection = selectedHostedPrincipal(ctx, controlPlaneWorkspaceId);
      if (!selection.ok) return selection.response;
      const { principal } = selection;
      if (!principal.capabilities.has('workspace:view')) return jsonError('permission_missing', 403);
      const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
      if (headerError) return headerError;
      if (method === 'POST') {
        const csrf = exactOriginOr403(request, origin);
        if (csrf) return csrf;
      }
      const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId, workspaceId: principal.selectedWorkspaceId! };
      const parsed = method === 'POST' ? tutorialProgressUpdateSchema.safeParse(await request.json().catch(() => null)) : null;
      if (parsed && !parsed.success) return jsonError('invalid_tutorial_progress', 400);
      try {
        const record = await runTenant(tenantContext(principal), tx => parsed?.success
          ? updateTutorialProgress(tx, scope, parsed.data) : readTutorialProgress(tx, scope));
        return Response.json({ record }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof TutorialProgressConflict) return Response.json({ error: 'tutorial_progress_conflict', record: error.current }, { status: 409, headers: { 'cache-control': 'no-store' } });
        return jsonError('tutorial_progress_unavailable', 503);
      }
    },
  }));
}
