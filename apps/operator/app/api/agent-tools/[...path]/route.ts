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
  type UnifiedToolContext,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@restart/sse';
import { getOrgPg } from '@restart/db-org';

// Register operator-side first-party tools (D1a, role-gated). Module
// import is side-effect: each tool calls defineTool() which auto-
// registers into the unified projection registry consumed below.
import '@/lib/agent-tools/index';
import { PROJECTED_DEPS } from '@/lib/projected-tool-deps';

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
  deps: PROJECTED_DEPS,
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

    // Phase 4 T2.2 — runId surface.
    //
    // runId provenance: client either echoes a prior runId via
    // X-Papercusp-Run-Id (for resume) OR we generate a fresh UUID.
    // The chosen runId is surfaced back on X-Papercusp-Run-Id so
    // consumers retain it for any future reconnect.
    //
    // Resume logic lives ONE layer down in handleHttpToolRequestStreaming
    // (packages/agent-mcp/src/http-projection.ts). Pass-9 audit caught
    // that the route used to also run an sseResponse.replay() over the
    // same buffer — the two replay paths fired in sequence, duplicating
    // every resumed event on the wire. Route now only assigns the runId;
    // the http-projection layer owns replay/done/close.
    const clientRunId = (headerMap['x-papercusp-run-id'] ?? '').trim();
    const runId = clientRunId.length > 0
      ? clientRunId
      : (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
    // Propagate runId via the searchParams (the spawn-context reader
    // already understands `run` as a synonym). Avoids mutating headers
    // (which Next's Headers may be immutable on some runtimes).
    url.searchParams.set('run', runId);
    transportReq.searchParams = url.searchParams;

    return sseResponse({
      signal: req.signal,
      headers: { 'X-Papercusp-Run-Id': runId },
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
