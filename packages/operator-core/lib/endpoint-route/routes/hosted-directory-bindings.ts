/** Organization-scoped administration of immutable WorkOS directory references. */
import { defineTool } from '@papercusp/agent-mcp';
import { isHostedPrincipal } from '../../auth/hosted-principal';
import type { HostedDirectoryBindingManager, DirectoryBindingInput } from '../../auth/hosted/governance';

export const HOSTED_DIRECTORY_BINDING_ROUTES = [
  { method: 'PUT', path: '/hosted/organizations/:organizationId/members/:userId/directory-binding', access: 'authenticated' },
  { method: 'DELETE', path: '/hosted/organizations/:organizationId/members/:userId/directory-binding', access: 'authenticated' },
] as const;

export function createHostedDirectoryBindingRoutes(manager: HostedDirectoryBindingManager) {
  return HOSTED_DIRECTORY_BINDING_ROUTES.map((route) => defineTool({
    method: route.method, path: route.path,
    auth: { capabilities: ['members:manage'], kind: ['user'], trust: ['verified'] },
    async handler(request, ctx) {
      const principal = ctx.principal;
      if (!principal || !isHostedPrincipal(principal)) return Response.json({ error: { code: 'hosted_principal_required' } }, { status: 401 });
      const organizationId = String(ctx.params.organizationId ?? '');
      if (principal.activeOrganizationId !== organizationId || !principal.permissions.has('members:manage')) {
        return Response.json({ error: { code: 'directory_binding_forbidden' } }, { status: 403 });
      }
      let body: Record<string, unknown>;
      try {
        const value = await request.json();
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
        body = value;
      } catch { return Response.json({ error: { code: 'invalid_json' } }, { status: 400 }); }
      const input = {
        organizationId, userId: String(ctx.params.userId ?? ''), externalOrganizationId: body.externalOrganizationId,
        directoryId: body.directoryId, directoryUserId: body.directoryUserId, authorizedGroupIds: body.authorizedGroupIds,
        purpose: body.purpose,
      } as DirectoryBindingInput;
      try {
        const binding = route.method === 'DELETE' ? await manager.remove(principal, input) : await manager.set(principal, input);
        return Response.json({ ok: true, binding });
      } catch (cause) {
        const code = cause instanceof Error ? cause.message : 'directory_binding_failed';
        const status = /forbidden|organization_mismatch/.test(code) ? 403 : /not_found/.test(code) ? 404
          : /subject_conflict|inactive/.test(code) ? 409 : cause instanceof TypeError || /hosted-governance/.test(code) ? 400 : 503;
        return Response.json({ error: { code: status === 503 ? 'directory_binding_unavailable' : code } }, { status });
      }
    },
  }));
}
