/**
 * GET    /api/agent-mcp/delegates — list / get / search delegates.
 * DELETE /api/agent-mcp/delegates?id= — archive.
 * Ported from app/api/agent-mcp/delegates/route.ts. `auth: 'public'`.
 */
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { archiveDelegate, getDelegate, listDelegates, searchDelegates } from '@/lib/delegates';
import { defineRoute } from '../../define-route';

const get = defineRoute({
  method: 'GET',
  path: '/agent-mcp/delegates',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const workspace = activeWorkspaceId();
    const id = url.searchParams.get('id');
    if (id) {
      const row = await getDelegate(workspace, id);
      return Response.json({ session: row });
    }
    const status = (url.searchParams.get('status') as 'open' | 'archived' | 'all' | null) ?? 'open';
    const limit = url.searchParams.get('limit')
      ? Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit')!, 10) || 20))
      : 20;
    const q = url.searchParams.get('q');
    try {
      const rows = q
        ? await searchDelegates({ workspace, query: q, limit })
        : await listDelegates({ workspace, status, limit });
      return Response.json({ sessions: rows });
    } catch (e: any) {
      if (/relation .*(claude_sessions|delegates).* does not exist/i.test(e?.message ?? '')) {
        return Response.json({ sessions: [] });
      }
      throw e;
    }
  },
});

const del = defineRoute({
  method: 'DELETE',
  path: '/agent-mcp/delegates',
  auth: 'public',
  async handler(req) {
    const url = new URL(req.url);
    const workspace = activeWorkspaceId();
    const id = url.searchParams.get('id');
    if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
    await archiveDelegate(workspace, id);
    return Response.json({ ok: true });
  },
});

export default [get, del];
