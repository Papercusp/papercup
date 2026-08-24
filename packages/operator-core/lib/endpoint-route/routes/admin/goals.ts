/**
 * POST /api/admin/goals/:verb — the desktop-callable WRITE half of the Goals tab
 * (goals-tab-improvement-2026-08-09 P-016).
 *
 * WHY A PROXY AND NOT A HAND-WRITTEN HANDLER. The goal status write is not a column
 * update: `goals:update` merges partial fields so reporting spend cannot clear a kill
 * criterion, and it fires the transition fan-out that actually gates or re-opens
 * placement on the goal's owned projects (EI-20013729460455061 stop, WI-37615 resume).
 * Re-implementing any of that here would be a SECOND write path for the one row whose
 * state decides whether a fleet runs — the exact fork the repo's reuse-first rule names
 * as the top review smell. So this dispatches the real tool in-process via
 * `handleHttpToolRequest`, byte-identical to what an agent calling `goals:update` gets,
 * and the UI inherits every future fix to it for free.
 *
 * Ported wholesale from admin/mode.ts, including its AUTH reasoning: the packaged Tauri
 * webview fetches the operator /api directly with no cookie or bearer, so it resolves
 * `unverified-loopback`. Gating on VT alone would 403 the one surface the owner asked
 * for (EI-338), so the trust set is widened and `requireAllowedOriginOr403` is the CSRF
 * backstop that buys the safety back — a cross-origin browser POST is refused.
 *
 * ⚠ The reply is the tool's result VERBATIM, `degraded` / `degradedReasons` included.
 * That is load-bearing, not incidental: a paused goal can come back reporting loops it
 * could not attribute and did not stop, and a resumed one can come back reporting
 * sessions it deliberately did not re-arm. A route that flattened those into `{ok:true}`
 * would recreate the precise bug this whole seam exists to prevent — a steering surface
 * reporting a state that is not the state of the system (EI-19995648221353323).
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Registers the tool surface (and, as a side effect of the barrel, installs the goal
// transition executor). Same import admin/mode.ts and the agent-tools catch-all use.
import '../../../agent-tools/index';
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { requireAllowedOriginOr403 } from '../../cors';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';
import { notifySyncInvalidate } from '../../../sync-sse';

const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;

/**
 * `update`, plus `create` RESTRICTED TO SUBDIRECTIVES (P-017).
 *
 * `goals:propose` still stays out, and so does creating a TOP-LEVEL goal: P-022's
 * kickoff is a CONVERSATIONAL flow the owner finishes in the composer, not a form
 * this route posts. A top-level goal must also arrive via `goals:start`, which
 * spawns the agent that owns it in the same transaction — `goals:create` alone
 * would leave "a goal that is never spawned … on the board as an outcome nobody
 * owns" (start.ts's own docblock), which is why the create verb was excluded here
 * in the first place.
 *
 * A SUBDIRECTIVE breaks that reasoning cleanly rather than bending it, and the
 * difference is D-006's ruling, not a convenience: a child steers its PARENT's
 * agent and must NOT get one of its own ("an implementation that gives a child its
 * own agent … breaks this decision"). So there is no spawn to pair the row with and
 * no kickoff conversation to have — the row IS the whole object. That also makes
 * `goals:start` the WRONG tool for a child even though it accepts `parentId`:
 * calling it would spawn the second agent D-006 forbids.
 *
 * The `parentId` guard in `dispatchWrite` is what keeps this narrow: without it,
 * widening to `create` would quietly re-open the agentless top-level goal.
 */
const WRITE_VERBS = new Set(['update', 'create', 'start-from-package']);

/* `start-from-package` (P-009, work-on-everything-goal-2026-08-23): the packages
   rail's one-click start. It does NOT reopen the agentless-top-level-goal hole the
   comment above closes: `goals:start-from-package` (P-017) converges on
   `startGoalById`, which spawns the owning agent in the same act — it is the
   composer's guarantee arriving through a different door, not a bypass of it. The
   proxy also inherits this route's `goals.list`/`goals.detail` invalidations, so
   the rail repaints from the store, never optimistically. */

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
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;

  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `goals write verb '${verb}' not found` } },
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

  /* THE SUBDIRECTIVE GUARD (P-017 / D-006). `create` is reachable here ONLY for a
     child, because only a child legitimately has no agent — see WRITE_VERBS above.
     A parentless create would file a top-level goal that nothing spawns, i.e. an
     outcome on the board that no agent owns, which is the failure `goals:start`
     exists to make impossible.

     Refused with the fix named, not a bare 403: the caller that trips this wants the
     composer, and a refusal that does not say so reads as the feature being broken. */
  if (verb === 'create') {
    const parentId = body.parentId;
    if (typeof parentId !== 'string' || parentId.trim() === '') {
      return Response.json(
        {
          error: {
            code: 'parent_required',
            message:
              'goals:create is reachable from the UI only for a SUBDIRECTIVE (D-006), which needs parentId. ' +
              'A top-level goal must be started through the composer so its agent is spawned with it.',
          },
        },
        { status: 400 },
      );
    }
  }

  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/goals/${verb}`,
      searchParams: adminSearchParams(url.searchParams),
      headers: collectHeaders(req),
      body,
    },
    HOST_EXTRAS,
  );

  // Both goal reads must re-pull, and BOTH are needed: the board reads `goals.list`
  // while the open detail popup reads `goals.detail`, so invalidating only one leaves
  // whichever surface the owner is looking at showing the pre-write status until the
  // next poll — long enough to click again.
  //
  // Fire-and-forget AFTER the write has committed, never gated on it: a failed
  // invalidate must not turn a successful status change into an error reply.
  if (result.status === 200) {
    void notifySyncInvalidate('goals.list', {}).catch(() => {});
    void notifySyncInvalidate('goals.detail', {}).catch(() => {});
  }

  return unwrap(result);
}

const writeRoute = defineTool({
  method: 'POST',
  path: '/admin/goals/:verb',
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
