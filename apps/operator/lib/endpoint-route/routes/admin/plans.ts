/**
 * /api/admin/plans/:verb — admin surface for the plans:* tools.
 *
 * Per D-009 of plans-admin-ui-2026-05-20.md, the Plans admin tab cannot
 * present an agent bearer token, so it gets its own admin-namespaced
 * routes that re-dispatch into the same defineTool handlers in-process
 * via `handleHttpToolRequest` — the exact mechanism the public
 * /api/agent-tools/* catch-all already uses in production.
 *
 * GET — the four read verbs (list / get / items / search / lint). Pure
 * filesystem reads; no principal needed.
 *
 * POST — the four assisted-write verbs (set-status / set-now /
 * add-decision / add-item) plus `new`. The body is a JSON envelope
 * passed as the tool's args. The tools themselves are
 * `requirePrincipal: false` and each owns its `locks:acquire`
 * internally (see with-plan-lock.ts), so no admin principal injection
 * is required at this layer — the admin gate on /api/admin/* is the
 * authorization story (loopback + admin-shell mount). The MCP
 * tool-result envelope ({ content: [{ type:'text', text }] }) is
 * unwrapped so client code gets clean shapes.
 */

import { handleHttpToolRequest, type HttpToolHostExtras } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (defineTool
// calls), including all plans:* tools. Same import the agent-tools
// catch-all uses.
import '@/lib/agent-tools/index';
import { PROJECTED_DEPS } from '@/lib/projected-tool-deps';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { bodyFromSearchParams } from './_plans-args';

const READ_VERBS = new Set([
  'list',
  'get',
  'items',
  'search',
  'lint',
  // plan-agent-launch P-017: the Revisions panel reads through here.
  'revisions',
  // plan-agent-launch P-018: the per-revision diff modal.
  'revision-diff',
  // plan-agent-launch P-019: the per-revision conversation drill-down.
  'revision-transcript',
]);
// `set-content` and `set-frontmatter` land in agent-plan-tracking
// Phase 5 (D-011 of plans-admin-ui-2026-05-20). Listing them now means
// the route is ready the instant the tools register — until then a
// call dispatches to handleHttpToolRequest and returns a clean 404
// `unknown_tool`, which the UI surfaces as a normal save error.
//
// NOTE: the frontmatter writer is `set-frontmatter`, NOT `promote` —
// `plans:promote` is already a different, unrelated tool
// (coordination/tools/promote.ts: promote a plan into a harness).
// Exposing `promote` here would route the triage screen to the wrong
// tool, so it is deliberately absent from this set.
const WRITE_VERBS = new Set([
  'set-status', 'set-now', 'add-decision', 'add-item', 'new',
  'set-content', 'set-frontmatter',
]);

// Admin proxy identity: the writes (set-status/set-now/add-decision/
// add-item) flow through with-plan-lock → readIdentity, which requires
// power-user / superuser / principal attribution. The admin shell
// isn't bearer-auth'd, so we synthesize a superuser ctx (gated by the
// fact that /admin/* is loopback-bound — the same security model the
// rest of /admin/* uses). The synthesized `?superuser=1` triggers the
// http-projection branch that sets isSuperuser=true; the in-process
// `validateSuperuser` accepts it because this route is the only caller
// that ever synthesizes that URL.
const ADMIN_UI_CLIENT_ID = 'pc-admin-plans-ui';

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

/* `bodyFromSearchParams` — plans:* tools register `methods: ['POST']`
 * (defineTool default) and read args from `req.body`, so the route
 * dispatches internally as POST and projects the query string into a
 * body. The pure coercion logic lives in ./_plans-args.ts so it can
 * be unit-tested without importing the tool registry. */

/** Build the synthetic searchParams every internal dispatch uses.
 *  `?superuser=1` triggers the isSuperuser=true branch; `?client=...`
 *  supplies the stable uiClientId readIdentity() requires for writes
 *  (with-plan-lock attribution) and locks:queue. Reads don't depend on
 *  either, but keeping a single shape across verbs simplifies the
 *  dispatch. */
function adminSearchParams(inbound: URLSearchParams): URLSearchParams {
  const sp = new URLSearchParams(inbound);
  sp.set('superuser', '1');
  if (!sp.has('client')) sp.set('client', ADMIN_UI_CLIENT_ID);
  return sp;
}

async function dispatchRead(req: Request, ctx: RouteContext): Promise<Response> {
  const verb = ctx.params.verb;
  if (!READ_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `plans read verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body: bodyFromSearchParams(url.searchParams),
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

async function dispatchWrite(req: Request, ctx: RouteContext): Promise<Response> {
  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `plans write verb '${verb}' not found` } },
      { status: 404 },
    );
  }
  let body: Record<string, unknown> = {};
  try {
    const txt = await req.text();
    if (txt) body = JSON.parse(txt) as Record<string, unknown>;
  } catch {
    return Response.json(
      { error: { code: 'invalid_json', message: 'request body must be JSON' } },
      { status: 400 },
    );
  }
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/plans/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );
  return unwrap(result);
}

const readRoute = defineTool({
  method: 'GET',
  path: '/admin/plans/:verb',
  auth: 'public',
  handler: dispatchRead,
});

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/plans/:verb',
  auth: 'public',
  handler: dispatchWrite,
});

export default [readRoute, writeRoute];
