/**
 * /api/admin/inbox/:verb — admin surface for the inbox:* WRITE tools.
 *
 * The Planning-tab attention feed lets the human Resolve an operator-report
 * item (report-cards-inbox-reconciliation-2026-06-05 P-007) — that resolve IS
 * the triage state machine (inbox-tiering-and-message-agent D-006:
 * resolve → handled tier, auditable, never a silent vanish). Exactly like
 * /api/admin/coord/:verb, this re-dispatches into the same defineTool handler
 * in-process via handleHttpToolRequest with a synthesized superuser ctx;
 * authorization = the admin mount is loopback-bound.
 *
 * POST /api/admin/inbox/triage { itemId, action, note? } → inbox:triage
 * POST /api/admin/inbox/execute { expected:{id,kind,ref}, actionId, confirmed:true }
 *   → the shared terminal-action dispatcher, after re-reading the selected item.
 */

import { handleHttpToolRequest } from '@papercusp/agent-mcp';
// Side-effect: register operator-side first-party tools (the inbox:* tools
// included). Same import the agent-tools catch-all + admin/plans use.
import '../../../agent-tools/index';
// WI-5364: shared extras carry the runScoped seam so proxied handlers that use
// ctx.tx get a real DB handle instead of 500ing "ctx.tx is not a function".
import { ADMIN_PROXY_HOST_EXTRAS as HOST_EXTRAS } from './proxy-host-extras';
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { ADMIN_COORD_UI_OWNER } from '../../../agent-tools/coordination/identity';
import { requireAllowedOriginOr403 } from '../../cors';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { TerminalAttentionItem } from '../../../attention/terminal-action-dispatch';

// The human triages AS the admin UI owner — same identity the coord proxy
// uses, so triage audit rows (`triaged_by`) attribute consistently.
const ADMIN_UI_CLIENT_ID = ADMIN_COORD_UI_OWNER;
const WRITE_VERBS = new Set(['triage', 'automation-policy', 'execute']);

const executeRequest = z.object({
  expected: z.object({ id: z.string().min(1), kind: z.string().min(1), ref: z.record(z.string(), z.unknown()) }).strict(),
  actionId: z.string().min(1),
  confirmed: z.literal(true),
  rationale: z.string().max(2000).optional(),
}).strict();

// Native clients cannot import the TypeScript dispatcher. Extend this existing
// owner-only surface instead of copying its kind/action switch into each OS.
// This endpoint executes only the live item's offered terminal; it never records
// a bulk acceptance. The client records that only AFTER resolved:true returns.
async function executeAction(ctx: RouteContext, body: unknown): Promise<Response> {
  const parsed = executeRequest.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: 'invalid_inbox_action' }, { status: 400 });
  const { expected, actionId, rationale } = parsed.data;
  try {
    const [{ callPlansReadRaw }, { runWithWorkspace }, { activeWorkspaceId }] = await Promise.all([
      import('../../../agent-tools/plans/read-dispatch'),
      import('../../../workspace-als'),
      import('../../../workspace-registry'),
    ]);
    const workspaceId = ctx.principal?.workspaceId ?? activeWorkspaceId();
    return await runWithWorkspace(workspaceId, async () => {
      const read = await callPlansReadRaw('attention', {}, { uiProjection: false });
      const feed = read.data as { ok?: boolean; error?: unknown; degraded?: boolean; _partial?: boolean; groups?: Array<{ items?: TerminalAttentionItem[] }> } | null;
      if (read.status !== 200 || !feed || feed.ok === false || feed.error || feed.degraded || feed._partial || !Array.isArray(feed.groups)) {
        return Response.json({ ok: false, error: 'attention_unavailable' }, { status: 503 });
      }
      const matches = feed.groups.flatMap(group => group.items ?? []).filter(item => item.id === expected.id);
      const item = matches[0];
      if (!item || matches.some(row => !isDeepStrictEqual(row, item)) || item.kind !== expected.kind || !isDeepStrictEqual(item.ref, expected.ref)) {
        return Response.json({ ok: false, error: 'attention_changed' }, { status: 409 });
      }
      const live = item as TerminalAttentionItem & { actions?: Array<{ id: string }> };
      const named = item.ref.kind === 'coord-escalation' && Array.isArray(item.ref.options) &&
        item.ref.options.some(option => option && typeof option === 'object' && (option as { id?: unknown }).id === actionId &&
          typeof (option as { label?: unknown }).label === 'string');
      if (!live.actions?.some(action => action.id === actionId || (named && ['resolve', 'mark-done'].includes(action.id)))) {
        return Response.json({ ok: false, error: 'action_not_offered' }, { status: 409 });
      }
      const [{ dispatchAttentionTerminalAction }, { terminalDependencies }, { dispatchToolAsAdminUi, adminToolResultJson }] = await Promise.all([
        import('../../../attention/terminal-action-dispatch'),
        import('../../../agent-tools/inbox/bulk-run'),
        import('../../../owner-sessions/actions'),
      ]);
      const deps = terminalDependencies({ workspaceId, call: async (name, args) => {
        const colon = name.indexOf(':');
        const result = await dispatchToolAsAdminUi({
          group: name.slice(0, colon), verb: name.slice(colon + 1),
          body: { ...(args as Record<string, unknown>), ...(name.startsWith('plans:') && item.harnessSlug ? { harness: item.harnessSlug } : {}) },
          workspaceId,
        });
        const value = adminToolResultJson(result);
        if (result.status !== 200 || (result.body as { isError?: boolean } | null)?.isError || value === undefined) {
          throw new Error(`${name} refused the Inbox action`);
        }
        if (value && typeof value === 'object' && (value as { error?: unknown }).error) {
          throw new Error(`${name} refused the Inbox action: ${JSON.stringify((value as { error: unknown }).error)}`);
        }
        return value;
      } });
      const outcome = await dispatchAttentionTerminalAction({ item, actionId, deps, rationale });
      if (!outcome.resolved) return Response.json({ ok: false, error: 'action_not_terminal' }, { status: 409 });
      return Response.json({ ok: true, ...outcome, itemId: item.id });
    });
  } catch (error) {
    return Response.json({ ok: false, error: 'inbox_action_failed', message: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

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
  // CSRF backstop for the VTL tier below: a foreign page's cross-origin POST is
  // refused before any verb is proxied; Origin-less server callers still pass.
  const csrf = requireAllowedOriginOr403(req);
  if (csrf) return csrf;
  const verb = ctx.params.verb;
  if (!WRITE_VERBS.has(verb)) {
    return Response.json(
      { error: { code: 'unknown_verb', message: `inbox write verb '${verb}' not found` } },
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
  if (verb === 'execute') return executeAction(ctx, body);
  const url = new URL(req.url);
  const result = await handleHttpToolRequest(
    {
      method: 'POST',
      pathname: `/api/agent-tools/inbox/${verb}`,
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
  path: '/admin/inbox/:verb',
  // Mutating triage ops + the standing bulk automation policy. Same posture as
  // admin/coord (VTL): Settings > Autonomy and the Plans pane post here from the
  // cookie-less desktop webview, which resolves 'unverified-loopback' and was
  // 403'd under VT (webview-fetch-auth.test.ts). CSRF-gated in dispatchWrite.
  auth: { trust: ['verified', 'trusted', 'unverified-loopback'] },
  handler: dispatchWrite,
});

export default [writeRoute];
