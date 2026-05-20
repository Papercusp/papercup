/**
 * GET/POST/PUT/PATCH/DELETE /api/agent-tools/<group>/<verb>
 *
 * Catch-all HTTP route for the 27+ built-in agent-mcp tools via
 * defineTool's auto-mounted projection. Resolves principal+tx via
 * resolveBearer + the workspace pg pool. Honors SSE for streamable tools.
 *
 * Ported from app/api/agent-tools/[...path]/route.ts. `auth: 'public'`.
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

// Side-effect: register operator-side first-party tools (defineTool calls).
import '@/lib/agent-tools/index';
import { PROJECTED_DEPS } from '@/lib/projected-tool-deps';
import { defineRoute } from '../../define-route';

const HOST_EXTRAS: HttpToolHostExtras = {
  resolvePrincipalAndTx: async (bearer) => {
    const principal = await resolveBearer(bearer);
    if (!principal) return null;
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

    const clientRunId = (headerMap['x-papercusp-run-id'] ?? '').trim();
    const runId = clientRunId.length > 0
      ? clientRunId
      : (globalThis.crypto?.randomUUID?.() ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);
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

const PATH = '/agent-tools/*';
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export default methods.map((method) =>
  defineRoute({
    method,
    path: PATH,
    auth: 'public',
    handler: dispatchHttp,
  }),
);
