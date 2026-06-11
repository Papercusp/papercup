/**
 * GET  /api/operator/conversations?limit=N
 * POST /api/operator/conversations  — force-create active conversation
 *
 * Ported from app/api/operator/conversations/route.ts. `auth: 'public'`.
 */
import { getOrgPg, generated } from '@papercusp/db-org';
import { and, eq } from 'drizzle-orm';
import {
  getOrCreateActiveConversation,
  listTurns,
  listTurnsRecent,
} from '../../../operator-conversations';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const oc = generated.operatorConversationsInHarnessShared;

const get = defineTool({
  method: 'GET',
  path: '/operator/conversations',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const limitParam = url.searchParams.get('limit');
    const conv = await getOrCreateActiveConversation();

    if (limitParam === 'all') {
      const turns = await listTurns(conv.id);
      return Response.json({ conversation: conv, turns, hasMoreEarlier: false });
    }
    const limit = Math.max(1, Math.min(Number(limitParam) || 50, 500));
    const page = await listTurnsRecent({ conversationId: conv.id, limit });
    return Response.json({
      conversation: conv,
      turns: page.turns,
      hasMoreEarlier: page.hasMoreEarlier,
    });
  },
});

const post = defineTool({
  method: 'POST',
  path: '/operator/conversations',
  auth: 'loopback',
  async handler() {
    const ws = activeWorkspaceId();
    const { db } = getOrgPg();

    await db
      .update(oc)
      .set({ status: 'done', endedAt: Date.now() })
      .where(and(eq(oc.workspaceId, ws), eq(oc.status, 'active')));

    const created = await db
      .insert(oc)
      .values({ workspaceId: ws, harnessSlug: null, startedAt: Date.now() })
      .returning({ id: oc.id });
    const id = created[0].id;
    return Response.json({ conversation: { id }, turns: [] });
  },
});

export default [get, post];
