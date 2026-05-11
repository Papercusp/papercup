/**
 * Catch-all HTTP route for the 27+ built-in agent-mcp tools, auto-mounted
 * via defineTool (PR 0c.D) at /api/agent-tools/<group>/<verb>.
 *
 * Sister of /api/plugins/[...path]/route.ts. Same handler logic; this
 * route attaches the `principal` + `tx` context that built-in tools
 * require, by resolving the bearer token via @papercusp/agent-mcp's
 * `resolveBearer` and wrapping each tool call in a workspace-bound
 * Postgres transaction.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  resolveBearer,
  type HttpToolHostExtras,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@restart/db-org';

// Register operator-side first-party tools (D1a, role-gated). Module
// import is side-effect: each tool calls defineTool() which auto-
// registers into the unified projection registry consumed below.
import '@/lib/agent-tools/index';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ─── Host extras ────────────────────────────────────────────────────── */

const HOST_EXTRAS: HttpToolHostExtras = {
  resolvePrincipalAndTx: async (bearer) => {
    const principal = await resolveBearer(bearer);
    if (!principal) return null;
    // We don't open a long-lived tx here — the tool function gets a
    // fresh sql client; transaction-bound use is handled by the bridge
    // pattern at the server.dispatch() level. v1: surface the global
    // sql client; tools that need a tx wrap their own queries.
    const { sql } = getOrgPg();
    return {
      principal: {
        slug: principal.slug,
        workspaceId: principal.workspaceId,
        capabilities: principal.capabilities,
      },
      tx: sql,
    };
  },
  deps: {
    readQuotaState: async (toolName, ctx, windowKey) => {
      if (!ctx.workspaceId) return null;
      try {
        const { sql } = getOrgPg();
        const rows = await sql.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
          return await tx.unsafe(
            `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
              WHERE workspace_id = $1
                AND tool_name = $2
                AND role = $3
                AND window_key = $4
                AND status = 'ok'`,
            [ctx.workspaceId, toolName, ctx.role ?? '', windowKey],
          );
        });
        const n = (rows as Array<{ n: number }>)[0]?.n ?? 0;
        return { count: n };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[agent-tool/http] readQuotaState failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    recordInvocation: async (input) => {
      if (!input.ctx.workspaceId) return;
      try {
        const { sql } = getOrgPg();
        await sql.begin(async (tx) => {
          await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [input.ctx.workspaceId]);
          await tx.unsafe(
            `INSERT INTO harness_shared.tool_invocations
               (workspace_id, harness_slug, plugin_name, tool_name, role,
                feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
                window_key, duration_ms, status, output_ref, output_size, error_message, args_json)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb)`,
            [
              input.ctx.workspaceId,
              input.ctx.harnessSlug ?? '',
              input.pluginName,
              input.toolName,
              input.ctx.role ?? '',
              input.ctx.featureId ?? null,
              input.ctx.chunkId ?? null,
              input.ctx.runId ?? null,
              input.ctx.spawnId ?? '',
              input.ctx.parentSpawnId ?? null,
              input.windowKey,
              input.durationMs,
              input.status,
              input.outputRef ?? null,
              input.outputSize ?? null,
              input.errorMessage ?? null,
              (() => {
                if (input.args === undefined || input.args === null) return null;
                try {
                  const s = JSON.stringify(input.args);
                  if (s.length > 32768) {
                    return JSON.stringify({ _truncated: true, _size: s.length });
                  }
                  return s;
                } catch {
                  return null;
                }
              })(),
            ],
          );
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[agent-tool/http] recordInvocation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  log: (line, ctx: UnifiedToolContext) => {
    // eslint-disable-next-line no-console
    console.log(`[agent-tool/http][${ctx.principal?.slug ?? '-'}/${ctx.role ?? '-'}] ${line}`);
  },
};

/* ─── Request → response ─────────────────────────────────────────────── */

async function dispatchHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);

  let body: unknown = {};
  if (req.method !== 'GET') {
    try {
      const text = await req.text();
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }

  const headerMap: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => { headerMap[k.toLowerCase()] = v; });

  const transportReq = {
    method: req.method,
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers: headerMap,
    body,
  };

  const wantsStream = (headerMap['accept'] ?? '').includes('text/event-stream');

  if (wantsStream) {
    const stringStream = handleHttpToolRequestStreaming(transportReq, HOST_EXTRAS);
    const encoder = new TextEncoder();
    const reader = stringStream.getReader();
    const byteStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { value, done } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(encoder.encode(value));
      },
      cancel(reason) { reader.cancel(reason).catch(() => {}); },
    });
    return new Response(byteStream, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      },
    });
  }

  const result = await handleHttpToolRequest(transportReq, HOST_EXTRAS);
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'content-type': 'application/json' },
  });
}

export const GET = dispatchHttp;
export const POST = dispatchHttp;
export const PUT = dispatchHttp;
export const PATCH = dispatchHttp;
export const DELETE = dispatchHttp;
