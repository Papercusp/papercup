import { defineTool } from '@papercusp/tooldef/define-tool';
import type { VerifiedTenantServerContext } from '@papercusp/db-org';
import type { Sql } from 'postgres';
import { exactOriginOr403, jsonError, selectedHostedPrincipal, tenantContext, workspaceHeaderMismatch } from '../hosted-browser-context';
import { readTutorialProgress, updateTutorialProgress, tutorialProgressUpdateSchema, TutorialProgressConflict,
  readAccountTutorialProgress, updateAccountTutorialProgress, accountTutorialProgressUpdateSchema, AccountTutorialProgressConflict } from '../../onboarding/cloud-tutorial-progress';
import { isHostedPrincipal } from '../../auth/hosted-principal';
import { sameTutorialScope } from '../../onboarding/cloud-tutorial-lesson';

// Kept separate from paid assistance so the Portal auth prebundle does not
// import the agent/voice graph merely to persist a user's guide preferences.
export const HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH = '/hosted/browser/onboarding/tutorial-progress' as const;

export function createHostedTutorialProgressRoutes({ origin, controlPlaneWorkspaceId, runTenant }: {
  origin: string; controlPlaneWorkspaceId: string;
  runTenant: <T>(context: VerifiedTenantServerContext, fn: (tx: Sql) => Promise<T>) => Promise<T>;
}) {
  return (['GET', 'POST'] as const).map(method => defineTool({
    method, path: HOSTED_BROWSER_TUTORIAL_PROGRESS_PATH,
    auth: { capabilities: [], kind: ['user'], trust: ['verified'] },
    cors: { origins: [origin] }, sampleRate: 0,
    async handler(request, ctx) {
      const url = new URL(request.url);
      if (url.searchParams.get('scope') === 'account') {
        const principal = ctx.principal;
        if (!principal || !isHostedPrincipal(principal)) return jsonError('hosted_principal_required', 401);
        if (principal.workspaceId !== controlPlaneWorkspaceId) return jsonError('control_plane_binding_mismatch', 403);
        const headerError = workspaceHeaderMismatch(request, principal, controlPlaneWorkspaceId);
        if (headerError) return headerError;
        if (method === 'POST') {
          const csrf = exactOriginOr403(request, origin);
          if (csrf) return csrf;
        }
        if (url.searchParams.get('version') !== '3') return jsonError('invalid_tutorial_version', 400);
        const scope = { tenantId: principal.activeOrganizationId, userId: principal.userId };
        const parsed = method === 'POST' ? accountTutorialProgressUpdateSchema.safeParse(await request.json().catch(() => null)) : null;
        if (parsed && !parsed.success) return jsonError('invalid_tutorial_progress', 400);
        if (parsed?.success && (parsed.data.expectedScope.tenantId !== scope.tenantId || parsed.data.expectedScope.userId !== scope.userId)) return jsonError('tutorial_scope_changed', 403);
        const accountContext: VerifiedTenantServerContext = { principal: {
          kind: 'user', profile: 'hosted', authMethod: 'cookie-session', trust: 'verified', slug: principal.userId,
          workspaceId: principal.workspaceId, userId: principal.userId, activeOrganizationId: principal.activeOrganizationId,
          sessionId: principal.sessionId, sessionVersion: principal.sessionVersion,
        } };
        try {
          const record = await runTenant(accountContext, tx => parsed?.success
            ? updateAccountTutorialProgress(tx, scope, parsed.data) : readAccountTutorialProgress(tx, scope));
          return Response.json({ record }, { headers: { 'cache-control': 'no-store' } });
        } catch (error) {
          if (error instanceof AccountTutorialProgressConflict) return Response.json({ error: 'tutorial_progress_conflict', record: error.current }, { status: 409, headers: { 'cache-control': 'no-store' } });
          return jsonError('tutorial_progress_unavailable', 503);
        }
      }
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
      const requestedVersion = new URL(request.url).searchParams.get('version');
      if (requestedVersion !== null && requestedVersion !== '1' && requestedVersion !== '2') return jsonError('invalid_tutorial_version', 400);
      const version = requestedVersion === '2' ? 2 : 1;
      const parsed = method === 'POST' ? tutorialProgressUpdateSchema.safeParse(await request.json().catch(() => null)) : null;
      if (parsed && !parsed.success) return jsonError('invalid_tutorial_progress', 400);
      if (parsed?.success && !sameTutorialScope(scope, parsed.data.expectedScope)) return jsonError('tutorial_scope_changed', 403);
      try {
        const record = await runTenant(tenantContext(principal), tx => parsed?.success
          ? updateTutorialProgress(tx, scope, parsed.data) : readTutorialProgress(tx, scope, version));
        return Response.json({ record }, { headers: { 'cache-control': 'no-store' } });
      } catch (error) {
        if (error instanceof TutorialProgressConflict) return Response.json({ error: 'tutorial_progress_conflict', record: error.current }, { status: 409, headers: { 'cache-control': 'no-store' } });
        return jsonError('tutorial_progress_unavailable', 503);
      }
    },
  }));
}
