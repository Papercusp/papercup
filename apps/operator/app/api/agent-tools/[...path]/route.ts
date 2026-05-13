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
  lookupByHttpPath,
  resolveBearer,
  type HttpToolHostExtras,
  readReplayBuffer,
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@restart/sse';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';

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
    // Strict-streamable: only honor SSE when the resolved tool declares
    // typed events OR a state schema OR opts in via expose.mcp.streaming.
    // Prevents clients from opening an SSE connection against a tool that
    // will only emit a single 'done' event — wastes a TCP connection on
    // data the JSON path would have returned in one round-trip.
    //
    // State-shaped tools (`tool.state`) qualify because their handler
    // needs a runId-bearing ctx (installed by the SSE branch via
    // searchParams.set('run', runId) below) so `ctx.publishState` can
    // push snapshots to the state-channel side-channel.
    const tool = lookupByHttpPath(url.pathname);
    const streamable =
      !!tool &&
      ((tool.events && Object.keys(tool.events).length > 0) ||
        !!tool.state ||
        tool.expose.mcp?.streaming === true);
    if (!streamable) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'not_acceptable',
            message: 'tool does not stream; retry with Accept: application/json',
          },
        }),
        { status: 406, headers: { 'content-type': 'application/json' } },
      );
    }

    // Phase 4 T2.2 — runId + replay/Last-Event-ID resume.
    //
    // runId provenance: client either echoes a prior runId via
    // X-Papercusp-Run-Id (for resume) OR we generate a fresh UUID.
    // The chosen runId is surfaced back on X-Papercusp-Run-Id so
    // consumers retain it for any future reconnect.
    //
    // Resume logic: when both Last-Event-ID and X-Papercusp-Run-Id
    // are sent AND the tool has a replay buffer hit, sseResponse's
    // replay() callback re-emits the buffered tail. Per the locked-in
    // (b) semantics, the original call already aborted on disconnect
    // (today's behavior); we serve only the pre-disconnect buffer.
    // The cold sink will close after replay (no more events coming).
    const clientRunId = (headerMap['x-papercusp-run-id'] ?? '').trim();
    const runId = clientRunId.length > 0
      ? clientRunId
      : (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // Propagate runId via the searchParams (the spawn-context reader
    // already understands `run` as a synonym). Avoids mutating headers
    // (which Next's Headers may be immutable on some runtimes).
    url.searchParams.set('run', runId);
    transportReq.searchParams = url.searchParams;

    const leiRaw = (headerMap['last-event-id'] ?? '').trim();
    const lei = Number.parseInt(leiRaw, 10);
    const hasResumeRequest = Number.isFinite(lei) && lei > 0 && clientRunId.length > 0;

    let replayCb: undefined | (() => Iterable<{ id: number; name: string; data: unknown }>);
    if (hasResumeRequest && tool && (tool.replayBufferSize ?? 0) > 0) {
      // Look up the buffer. activeWorkspaceId() matches what the
      // dispatcher used as ctx.workspaceId (operator-scope tools).
      // The buffer name matches tool.expose.mcp?.name OR the
      // tool's url-derived display name; we use mcp name to align
      // with what dispatchProjectedTool sees.
      const ws = activeWorkspaceId();
      const toolName = tool.expose.mcp?.name ?? '';
      const buffered = readReplayBuffer({
        workspaceId: ws,
        toolName,
        runId: clientRunId,
        sinceId: lei,
      });
      if (buffered && buffered.length > 0) {
        replayCb = () => buffered;
      }
    }

    return sseResponse({
      signal: req.signal,
      headers: { 'X-Papercusp-Run-Id': runId },
      lastEventId: hasResumeRequest ? lei : null,
      replay: replayCb,
      setup: (sink) => handleHttpToolRequestStreaming(transportReq, HOST_EXTRAS, sink),
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
