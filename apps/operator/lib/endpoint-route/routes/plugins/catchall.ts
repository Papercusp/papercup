/**
 * GET/POST/PUT/PATCH/DELETE /api/plugins/* — two-step catch-all.
 *
 * 1. First try the in-memory plugin-`apiRoutes` registry: if the first
 *    path segment after `/plugins/` is a registered plugin's safe-name,
 *    forward the request to that plugin's handler (relocated from the
 *    Hono-sub-app `installPluginApiDispatcher`, endpoint-hono-elimination
 *    -2026-05-21 A3).
 * 2. Otherwise, fall through to projected-tool dispatch — every plugin
 *    tool with `expose.http.path` starting with `/api/plugins/` is served
 *    here.
 *
 * `auth: 'public'` — gates live inside the tool definition / plugin
 * handler, not at the route level.
 */
import {
  handleHttpToolRequest,
  handleHttpToolRequestStreaming,
  lookupByHttpPath,
  type HttpToolHostExtras,
} from '@papercusp/agent-mcp';
import { sseResponse } from '@restart/sse';
import { dispatchPluginApiRoute } from '@/lib/plugin-api-mount';
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
  // Step 1: plugin-`apiRoutes` registry. Returns the plugin's Response,
  // or null on registry miss — fall through to projected-tool dispatch.
  const pluginResponse = await dispatchPluginApiRoute(req);
  if (pluginResponse) return pluginResponse;

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
