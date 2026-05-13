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
  lookupByHttpPath,
  type HttpToolHostExtras,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@restart/sse';
import { pluginSpawnImpl, secretImpl } from '@/lib/plugin-spawn-impl';
import { resolveHarnessPaths } from '@/lib/resolve-harness-paths';
import { isLoopbackRequest, isValidSuperuserBearer } from '@/lib/superuser-token';
import { PROJECTED_DEPS } from '@/lib/projected-tool-deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* ─── Host extras (PG-backed quota + invocation persistence) ────────── */

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: (line, ctx) => {
    // eslint-disable-next-line no-console
    console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);
  },
  // progress wired below at request time when streaming is requested.
  spawn: pluginSpawnImpl,
  secret: secretImpl,
  resolveHarnessPaths,
  validateSuperuser: (req) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') h.set(k, v);
    }
    if (!isLoopbackRequest(h)) return false;
    const auth = req.headers['authorization'] ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : auth;
    return isValidSuperuserBearer(bearer);
  },
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
    // Strict-streamable: see agent-tools/[...path]/route.ts for rationale.
    const tool = lookupByHttpPath(url.pathname);
    const streamable =
      !!tool &&
      ((tool.events && Object.keys(tool.events).length > 0) ||
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
    return sseResponse({
      signal: req.signal,
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
