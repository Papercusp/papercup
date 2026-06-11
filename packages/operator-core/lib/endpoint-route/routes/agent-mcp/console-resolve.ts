/**
 * POST /api/agent-mcp/console/resolve — returns ConsoleEnvelope for native term.
 * Ported from app/api/agent-mcp/console/resolve/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { activeWorkspaceId } from '../../../workspace-registry';
import { buildConsoleEnvelope } from '../../../console-launcher';
import { PrincipalCheckError, requirePrincipal } from '../../../auth/require-principal';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'POST',
  path: '/agent-mcp/console/resolve',
  auth: 'loopback',
  async handler(req) {
    try {
      await requirePrincipal(req.headers);
    } catch (err) {
      if (err instanceof PrincipalCheckError) {
        return Response.json({ error: err.reason }, { status: err.status });
      }
      throw err;
    }
    const body = (await req.json().catch(() => ({}))) as { slug?: string | null };
    const workspaceId = activeWorkspaceId();
    try {
      const envelope = await buildConsoleEnvelope({
        workspaceId,
        slug: body.slug ?? null,
        operatorBaseUrl: new URL(req.url).origin,
      });
      return Response.json(envelope);
    } catch (e: any) {
      return Response.json({ error: e?.message ?? 'console-resolve failed' }, { status: 400 });
    }
  },
});
