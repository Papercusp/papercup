/**
 * GET  /api/agent-mcp/delegate-inbox          → { pending }
 * GET  /api/agent-mcp/delegate-inbox?drain=1  → { items: [...] }
 * POST /api/agent-mcp/delegate-inbox          → push
 * Ported from app/api/agent-mcp/delegate-inbox/route.ts. `auth: 'public'`.
 */
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { drainDelegateInbox, peekDelegateInbox, pushDelegateInbox } from '@/lib/delegate-inbox';
import { defineTool } from '@papercusp/agent-mcp';

const get = defineTool({
  method: 'GET',
  path: '/agent-mcp/delegate-inbox',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const workspaceId = activeWorkspaceId();
    const drain = url.searchParams.get('drain') === '1';
    try {
      if (drain) {
        const items = await drainDelegateInbox({ workspaceId });
        return Response.json({ items });
      }
      const peek = await peekDelegateInbox({ workspaceId });
      return Response.json(peek);
    } catch (e: any) {
      if (/relation .*delegate_inbox.* does not exist/i.test(e?.message ?? '')) {
        return Response.json(drain ? { items: [] } : { pending: 0 });
      }
      throw e;
    }
  },
});

const post = defineTool({
  method: 'POST',
  path: '/agent-mcp/delegate-inbox',
  auth: 'public',
  async handler(req) {
    const workspaceId = activeWorkspaceId();
    const body = await req.json().catch(() => null) as
      | { headline?: string; kind?: string; agentSessionId?: string | null }
      | null;
    if (!body?.headline) {
      return Response.json({ error: 'headline required' }, { status: 400 });
    }
    const id = await pushDelegateInbox({
      workspaceId,
      headline: body.headline,
      kind: body.kind,
      agentSessionId: body.agentSessionId ?? null,
    });
    return Response.json({ id });
  },
});

export default [get, post];
