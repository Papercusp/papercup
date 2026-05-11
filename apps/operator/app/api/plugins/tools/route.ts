/**
 * GET /api/plugins/tools — list every tool currently registered in the
 * projected-tool registry (agent-mcp).
 *
 * Reflects runtime state, not just manifest declarations: tools register
 * here only after the plugin loader successfully wires them via
 * registerPluginTools (and built-in tools register via defineTool).
 *
 * Used by /settings/plugins/tools to surface what each plugin contributes
 * + recent invocation telemetry from harness_shared.tool_invocations.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */
import { NextResponse } from 'next/server';
import { listAllProjectedTools } from '@papercusp/agent-mcp';
import { getPluginHost } from '@/lib/plugin-host-runtime';
import { getOrgPg } from '@restart/db-org';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface SerializedTool {
  name: string;
  pluginName: string;
  description: string;
  capabilities: string[];
  roles?: string[];
  rolesQuota?: Record<string, { perChunk?: number; perRun?: number; perDay?: number }>;
  timeoutSec?: number;
  /** JSON Schema for `arguments` — drives the /dev API-tab form builder. */
  inputSchema: Record<string, unknown>;
  expose: {
    http?: { path: string; methods?: string[] };
    mcp?: { name: string; streaming?: boolean; largeOutput?: boolean };
  };
  recentInvocations?: number;
  recentErrors?: number;
}

export async function GET(request: Request) {
  // Ensure plugin discovery has run; the projection registry is populated
  // as a side effect of plugin-host startup. Built-in tools auto-register
  // when packages/agent-mcp is imported (already happened transitively via
  // listAllProjectedTools → tool-projection module load).
  await getPluginHost().catch(() => null);

  const url = new URL(request.url);
  const includeStats = url.searchParams.get('stats') !== 'false';

  const tools = listAllProjectedTools();
  const serialized: SerializedTool[] = tools.map((t) => ({
    // Prefer mcp name (dotted convention) for display; fall back to http path tail.
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

  // Optionally enrich with last-24h invocation stats per tool. Best-effort —
  // PG unavailable just means we omit the counts.
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
    } catch {
      // PG unavailable; counts simply absent.
    }
  }

  // Sort: built-ins first (pluginName === 'agent-mcp'), then alphabetical.
  serialized.sort((a, b) => {
    const aBuiltIn = a.pluginName === 'agent-mcp' ? 0 : 1;
    const bBuiltIn = b.pluginName === 'agent-mcp' ? 0 : 1;
    if (aBuiltIn !== bBuiltIn) return aBuiltIn - bBuiltIn;
    return a.name.localeCompare(b.name);
  });

  return NextResponse.json({ tools: serialized });
}
