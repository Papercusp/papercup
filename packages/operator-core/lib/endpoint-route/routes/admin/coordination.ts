/**
 * /api/admin/coordination/:group/:verb — the coordination admin UI's data + write
 * surface (integration-adoption-2026-06-03, Capstone P2).
 *
 * The admin shell carries no bearer token, so — exactly like /api/admin/coord +
 * /api/admin/plans — these routes re-dispatch into the same defineTool MCP
 * handlers in-process via handleHttpToolRequest with a synthesized superuser ctx.
 * This powers the Topics / Conversations / Issues admin views over the SAME tools
 * the agents use: issues:* (su-a5a32), topics:* (su-30a41), conversations:* +
 * coord:ask (su-9fd2d). One generic proxy — no duplicated read handlers, no
 * second data path to drift.
 *
 * The UI POSTs the tool args as the JSON body, e.g.
 *   POST /api/admin/coordination/issues/list      { state: 'open' }
 *   POST /api/admin/coordination/topics/feed       { topic: 'zero-cache' }
 *   POST /api/admin/coordination/conversations/list {}
 */
import {
  handleHttpToolRequest,
  type HttpToolHostExtras,
  defineTool,
  type RouteContext,
} from '@papercusp/agent-mcp';
// Side-effect: register the operator-side first-party tools (issues:* / topics:* /
// conversations:* included). Same import admin/coord + admin/plans use.
import '../../../agent-tools/index';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
};

// The coordination tool surface the admin UI may proxy. Allowlisted so the admin
// mount can't be used to reach arbitrary tools.
const ALLOWED: Record<string, ReadonlySet<string>> = {
  issues: new Set(['list', 'get', 'search', 'create', 'update', 'comment', 'claim', 'release', 'close', 'tag', 'subscribe', 'link', 'promote']),
  topics: new Set(['list', 'feed', 'create', 'subscribe', 'unsubscribe', 'merge', 'tag']),
  conversations: new Set(['list', 'get', 'post', 'answer', 'resolve', 'join', 'promote']),
  coord: new Set(['ask']),
  // D-027 follow-on (1): the Queue's inline improvement Dismiss → improvements:triage
  // (triage-one reject). Only triage is exposed — capture/resolve are agent-loop verbs.
  improvements: new Set(['triage']),
};

function unwrap(toolResult: { status: number; body: unknown }): Response {
  if (toolResult.status === 200) {
    const body = toolResult.body as { content?: Array<{ type: string; text?: string }> };
    const text = body.content?.find((c) => c.type === 'text')?.text;
    if (text !== undefined) {
      try {
        return Response.json(JSON.parse(text));
      } catch {
        return new Response(text, { headers: { 'content-type': 'text/plain' } });
      }
    }
    return Response.json({});
  }
  return Response.json(toolResult.body, { status: toolResult.status });
}

function collectHeaders(req: Request): Record<string, string | undefined> {
  const m: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    m[k.toLowerCase()] = v;
  });
  return m;
}

function adminSearchParams(inbound: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(inbound);
  sp.set('superuser', '1');
  if (!sp.has('client')) sp.set('client', ADMIN_COORD_UI_OWNER);
  return sp;
}

async function dispatch(req: Request, ctx: RouteContext): Promise<Response> {
  const group = String(ctx.params.group);
  const verb = String(ctx.params.verb);
  if (!ALLOWED[group]?.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `coordination verb '${group}:${verb}' is not allowed here` } },
      { status: 404 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json({ error: { code: 'invalid_json', message: 'request body must be JSON' } }, { status: 400 });
  }
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/${group}/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const route = defineTool({
  method: 'POST',
  path: '/admin/coordination/:group/:verb',
  // The admin coordination UI runs as a verified loopback session.
  auth: { trust: ['verified', 'trusted'] },
  handler: dispatch,
});

export default [route];
