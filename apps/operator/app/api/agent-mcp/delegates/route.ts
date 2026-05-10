/**
 * GET /api/agent-mcp/delegates
 *   ?id=<session-id>           → return single session
 *   ?status=<open|archived|all>&limit=<n>  → list
 *
 * Used by the browser-side delegates.list / delegates.get
 * registry queries so the browser bundle doesn't need to pull PG.
 */

import { NextRequest } from 'next/server';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { archiveDelegate, getDelegate, listDelegates, searchDelegates } from '@/lib/delegates';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
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
    // Table missing — degraded mode.
    if (/relation .*(claude_sessions|delegates).* does not exist/i.test(e?.message ?? '')) {
      return Response.json({ sessions: [] });
    }
    throw e;
  }
}

export async function DELETE(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const workspace = activeWorkspaceId();
  const id = url.searchParams.get('id');
  if (!id) return Response.json({ error: 'missing id' }, { status: 400 });
  await archiveDelegate(workspace, id);
  return Response.json({ ok: true });
}
