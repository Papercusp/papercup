/**
 * /api/admin/coord/:verb — admin surface for the coord:* WRITE tools.
 *
 * The Planning-tab attention feed lets the human Resolve an escalation or
 * Ack a coord message — actions that until now only agents could do (via
 * the coord:resolve / coord:ack MCP tools; coord has only GET HTTP routes).
 * The admin shell carries no bearer token, so — exactly like
 * /api/admin/plans/:verb (plans-admin-ui D-009) — these routes re-dispatch
 * into the same defineTool handlers in-process via handleHttpToolRequest
 * with a synthesized superuser ctx. Authorization = the admin mount is
 * loopback-bound; `validateSuperuser` accepts the synthesized URL because
 * this route is its only caller.
 *
 * POST /api/admin/coord/resolve  { msg_id, choice, note? }  → coord:resolve
 * POST /api/admin/coord/ack      { msg_id }                 → coord:ack
 * POST /api/admin/coord/message-agent { to?, body, harness?, plan_slug?,
 *        item_ref?, title?, topics? }                        → coord:message-agent
 *   The inbox "Message owner" action — opens a work-item-scoped conversation
 *   with the owning agent (inbox-tiering-and-message-agent-2026-06-05, D-004).
 *   The inline thread is then read/posted via /api/admin/coordination/
 *   conversations/{get,post} (admin/coordination.ts allowlist).
 */

import { handleHttpToolRequest, type HttpToolHostExtras } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the coord:* tools
// included). Same import the agent-tools catch-all + admin/plans use.
import '../../../agent-tools/index';
import { PROJECTED_DEPS } from '../../../projected-tool-deps';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';

// Shared with the Planning inbox's ack-dismiss filter (plans/attention.ts) so
// "Acknowledge" actually dismisses: the human acks AS this owner here, and the
// reader drops messages acked BY this owner.
const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['resolve', 'ack', 'message-agent']);

const HOST_EXTRAS: HttpToolHostExtras = {
  deps: PROJECTED_DEPS,
  log: () => {},
  validateSuperuser: () => true,
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
  if (!sp.has('client')) sp.set('client', ADMIN_UI_CLIENT_ID);
  return sp;
}

async function dispatchWrite(req: Request, ctx: RouteContext): Promise<Response> {
  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `coord write verb '${verb}' not found` } },
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
      pathname: `/api/agent-tools/coord/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/coord/:verb',
  // Mutating coord ops — gate to the admin tier (the admin coord UI runs as a
  // verified session). Was 'public', which the D3 auth-posture guard flags.
  auth: { trust: ['verified', 'trusted'] },
  handler: dispatchWrite,
});

export default [writeRoute];
