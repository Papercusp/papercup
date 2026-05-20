/**
 * GET /api/plugins/tools — list registered projected tools.
 * Ported from app/api/plugins/tools/route.ts. `auth: 'public'`.
 */
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { getPluginHost } from '@/lib/plugin-host-runtime';
import { getOrgPg } from '@restart/db-org';
import { defineRoute } from '../../define-route';

interface SerializedTool {
  name: string;
  pluginName: string;
  description: string;
  capabilities: string[];
  roles?: string[];
  rolesQuota?: Record<string, { perChunk?: number; perRun?: number; perDay?: number }>;
  timeoutSec?: number;
  inputSchema: Record<string, unknown>;
  expose: {
    http?: { path: string; methods?: string[] };
    mcp?: { name: string; streaming?: boolean; largeOutput?: boolean };
  };
  recentInvocations?: number;
  recentErrors?: number;
}

export default defineRoute({
  method: 'GET',
  path: '/plugins/tools',
  auth: 'public',
  async handler(request) {
    await getPluginHost().catch(() => null);

    const url = new URL(request.url);
    const includeStats = url.searchParams.get('stats') !== 'false';

    const tools = listAllProjectedTools();
    const serialized: SerializedTool[] = tools.map((t) => ({
      name: t.expose.mcp?.name ?? (t.expose.http?.path ?? '?').split('/').slice(-2).join('/'),
      pluginName: t.pluginName,
      description: t.description,
      capabilities: t.capabilities,
      roles: t.roles,
      rolesQuota: t.rolesQuota,
      timeoutSec: t.timeoutSec,
      inputSchema: t.inputSchema,
      expose: {
        http: t.expose.http ? {
          path: t.expose.http.path,
          methods: t.expose.http.methods ? [...t.expose.http.methods] : undefined,
        } : undefined,
        mcp: t.expose.mcp ? {
          name: t.expose.mcp.name,
          streaming: t.expose.mcp.streaming,
          largeOutput: t.expose.mcp.largeOutput,
        } : undefined,
      },
    }));

    if (includeStats) {
      try {
        const { sql } = getOrgPg();
        const rows = await sql.unsafe(
          `SELECT tool_name,
                  count(*) FILTER (WHERE status = 'ok')::int AS ok_count,
                  count(*) FILTER (WHERE status != 'ok')::int AS err_count
             FROM harness_shared.tool_invocations
            WHERE invoked_at > now() - interval '24 hours'
            GROUP BY tool_name`,
        );
        const byName = new Map<string, { ok: number; err: number }>();
        for (const row of rows as Array<{ tool_name: string; ok_count: number; err_count: number }>) {
          byName.set(row.tool_name, { ok: row.ok_count, err: row.err_count });
        }
        for (const t of serialized) {
          const stats = byName.get(t.name);
          if (stats) {
            t.recentInvocations = stats.ok;
            t.recentErrors = stats.err;
          }
        }
      } catch { /* PG unavailable */ }
    }

    serialized.sort((a, b) => {
      const aBuiltIn = a.pluginName === 'agent-mcp' ? 0 : 1;
      const bBuiltIn = b.pluginName === 'agent-mcp' ? 0 : 1;
      if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
      return a.name.localeCompare(b.name);
    });

    return Response.json({ tools: serialized });
  },
});
