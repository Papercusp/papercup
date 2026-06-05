/**
 * GET /api/harness/:slug/intel/spawn-tree — spawn-tree rows for the Intel panel.
 *
 * Ported from app/api/harness/[slug]/intel/spawn-tree/route.ts. `auth: 'public'`.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const ALLOWED_STATUS = new Set(['ok', 'error', 'timeout', 'quota-exceeded', 'role-not-allowed']);

export default defineTool({
  method: 'GET',
  path: '/harness/:slug/intel/spawn-tree',
  auth: 'public',
  async handler(req, ctx) {
    const slug = ctx.params.slug as string;
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
      return Response.json({ error: 'invalid slug' }, { status: 400 });
    }
    const url = new URL(req.url);
    const sinceMs = Number(url.searchParams.get('sinceMs') ?? Date.now() - 24 * 60 * 60 * 1000);
    const limitRaw = Number(url.searchParams.get('limit') ?? 200);
    const limit = Math.min(2000, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 200));
    const statusParam = url.searchParams.get('status');
    const status = statusParam && ALLOWED_STATUS.has(statusParam) ? statusParam : null;
    const ws = activeWorkspaceId();

    try {
      const { sql } = getOrgPg();
      // P-041: the view exposes workspace_id, so scope it EXPLICITLY. getOrgPg
      // uses the admin role (bypasses RLS) and tool_invocations_spawn_tree is
      // not a security_invoker view, so the prior set_config('app.workspace_id')
      // in a tx was a dead no-op — the query returned every workspace's
      // spawn-tree rows for a colliding harness_slug.
      const rows = await sql<Array<{
        id: number;
        tool_name: string;
        plugin_name: string;
        role: string;
        feature_id: string | null;
        chunk_id: string | null;
        run_id: string | null;
        spawn_id: string;
        parent_spawn_id: string | null;
        window_key: string;
        invoked_at: Date;
        duration_ms: number | null;
        status: string;
        output_ref: string | null;
        output_size: number | null;
        error_message: string | null;
        depth: number;
        root_spawn_id: string;
      }>>`
        SELECT id, tool_name, plugin_name, role,
               feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
               window_key, invoked_at, duration_ms, status,
               output_ref, output_size, error_message,
               depth, root_spawn_id
          FROM harness_shared.tool_invocations_spawn_tree
         WHERE workspace_id = ${ws}
           AND harness_slug = ${slug}
           AND invoked_at >= to_timestamp(${sinceMs}::double precision / 1000.0)
           AND (${status}::text IS NULL OR status = ${status})
         ORDER BY invoked_at DESC
         LIMIT ${limit}
      `;
      return Response.json({
        rows: rows.map((r) => ({
          id: r.id,
          toolName: r.tool_name,
          pluginName: r.plugin_name,
          role: r.role,
          featureId: r.feature_id,
          chunkId: r.chunk_id,
          runId: r.run_id,
          spawnId: r.spawn_id,
          parentSpawnId: r.parent_spawn_id,
          windowKey: r.window_key,
          invokedAtMs: new Date(r.invoked_at).getTime(),
          durationMs: r.duration_ms,
          status: r.status,
          outputRef: r.output_ref,
          outputSize: r.output_size,
          errorMessage: r.error_message,
          depth: r.depth,
          rootSpawnId: r.root_spawn_id,
        })),
      });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  },
});
