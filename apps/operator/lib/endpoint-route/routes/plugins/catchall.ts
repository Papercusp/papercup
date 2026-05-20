/**
 * GET/POST/PUT/PATCH/DELETE /api/plugins/* — projected-tool catch-all.
 * Every plugin tool with expose.http.path starting with /api/plugins/
 * is served by this single route.
 * Ported from app/api/plugins/[...path]/route.ts. `auth: 'public'`.
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
import { defineRoute } from '../../define-route';

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: (line, ctx) => {
    // eslint-disable-next-line no-console
    console.log(`[plugin-tool/http][${ctx.harnessSlug ?? '-'}/${ctx.role ?? '-'}/${ctx.spawnId ?? '-'}] ${line}`);
  },
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

const PATH = '/plugins/*';
const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

export default methods.map((method) =>
  defineRoute({
    method,
    path: PATH,
    auth: 'public',
    handler: dispatchHttp,
  }),
);
