/**
 * GET /api/agent-mcp/claude-sessions
 *   ?id=<session-id>           → return single session
 *   ?status=<open|archived|all>&limit=<n>  → list
 *
 * Used by the browser-side claude-sessions.list / claude-sessions.get
 * registry queries so the browser bundle doesn't need to pull PG.
 */

import { NextRequest } from 'next/server';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { getClaudeSession, listClaudeSessions } from '@/lib/claude-sessions';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const url = new URL(req.url);
  const workspace = activeWorkspaceId();
  const id = url.searchParams.get('id');
  if (id) {
    const row = await getClaudeSession(workspace, id);
    return Response.json({ session: row });
  }
  const status = (url.searchParams.get('status') as 'open' | 'archived' | 'all' | null) ?? 'open';
  const limit = url.searchParams.get('limit')
    ? Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit')!, 10) || 20))
    : 20;
  try {
    const rows = await listClaudeSessions({ workspace, status, limit });
    return Response.json({ sessions: rows });
  } catch (e: any) {
    // Table missing — degraded mode.
    if (/relation .*claude_sessions.* does not exist/i.test(e?.message ?? '')) {
      return Response.json({ sessions: [] });
    }
    throw e;
  }
}
