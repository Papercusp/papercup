/**
 * Catch-all HTTP route for projected tools mounted under /api/plugins/.
 *
 * Every plugin tool with `expose.http.path` starting with /api/plugins/
 * is served by this single route. Lookup is by full pathname against the
 * agent-mcp tool-projection registry; the pure routing logic lives in
 * `@papercusp/agent-mcp`'s http-projection module so the operator route
 * is a thin shell.
 *
 * Spec: apps/operator/docs/plugin-mcp-host-design.md.
 */

import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  type HttpToolHostExtras,
} from '@papercusp/agent-mcp';
import { getOrgPg } from '@restart/db-org';
import { pluginSpawnImpl, secretImpl } from '@/lib/plugin-spawn-impl';
import { resolveHarnessPaths } from '@/lib/resolve-harness-paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ─── Host extras (PG-backed quota + invocation persistence) ────────── */

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: {
    readQuotaState: async (toolName, ctx, windowKey) => {
      try {
        const { sql } = getOrgPg();
        const rows = await sql.begin(async (tx) => {
          if (ctx.workspaceId) {
            await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [ctx.workspaceId]);
          }
          return await tx.unsafe(
            `SELECT count(*)::int AS n FROM harness_shared.tool_invocations
              WHERE workspace_id = $1
                AND tool_name = $2
                AND role = $3
                AND window_key = $4
                AND status = 'ok'`,
            [ctx.workspaceId ?? '', toolName, ctx.role ?? '', windowKey],
          );
        });
        const n = (rows as Array<{ n: number }>)[0]?.n ?? 0;
        return { count: n };
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[plugin-tool/http] readQuotaState failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    },
    recordInvocation: async (input) => {
      try {
        const { sql } = getOrgPg();
        await sql.begin(async (tx) => {
          if (input.ctx.workspaceId) {
            await tx.unsafe(`SELECT set_config('app.workspace_id', $1, true)`, [input.ctx.workspaceId]);
          }
          await tx.unsafe(
            `INSERT INTO harness_shared.tool_invocations
               (workspace_id, harness_slug, plugin_name, tool_name, role,
                feature_id, chunk_id, run_id, spawn_id, parent_spawn_id,
                window_key, duration_ms, status, output_ref, output_size, error_message)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
            [
              input.ctx.workspaceId ?? '',
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
            ],
          );
        });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[plugin-tool/http] recordInvocation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  },
  log: (line, ctx) => {
    // eslint-disable-next-line no-console
    console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);
  },
  // progress wired below at request time when streaming is requested.
  spawn: pluginSpawnImpl,
  secret: secretImpl,
  resolveHarnessPaths,
};

/* ─── Request → response ─────────────────────────────────────────────── */

async function dispatchHttp(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // Read body. Tolerant: empty body → {}.
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

  // Streaming opt-in: client sends `Accept: text/event-stream`.
  // The same projected-tool dispatch runs underneath; only the response
  // shape differs (SSE event stream vs single JSON body).
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
