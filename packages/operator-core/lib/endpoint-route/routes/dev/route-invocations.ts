/**
 * GET /api/dev/route-invocations?limit=N
 *
 * Recent `route_invocations` rows for the active workspace — the
 * route-traffic counterpart to the tool-invocation telemetry the /dev
 * Sessions panel already shows. R2 of the endpoint route migration.
 *
 * This route is itself a `defineTool` — dogfooding the primitive. The
 * /dev React panel that consumes this is a follow-up (see the R2-R6
 * report); the data + this read endpoint are what R2 commits to.
 */
import { z } from 'zod';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

export default defineTool({
  method: 'GET',
  path: '/dev/route-invocations',
  auth: { trust: ['verified', 'trusted'] }, // /dev surface — loopback-gated by the operator bind host
  input: z.object({ limit: z.coerce.number().int().positive().max(500).default(100) }),
  async handler(_req, ctx) {
    const workspaceId = activeWorkspaceId();
    const { sql } = getOrgPg();
    try {
      const rows = await sql<
        Array<{
          method: string;
          path: string;
          status: string;
          duration_ms: number | null;
          principal_kind: string | null;
          principal_trust: string | null;
          invoked_at: Date;
        }>
      >`
        SELECT method, path, status, duration_ms,
               principal_kind, principal_trust, invoked_at
          FROM harness_shared.route_invocations
         WHERE workspace_id = ${workspaceId}
         ORDER BY invoked_at DESC
         LIMIT ${ctx.input.limit}
      `;
      return Response.json({ rows });
    } catch (err) {
      // Table may not exist on a dev DB that hasn't applied migration 077.
      ctx.log('warn', 'route-invocations read failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return Response.json({ rows: [], degraded: true });
    }
  },
});
