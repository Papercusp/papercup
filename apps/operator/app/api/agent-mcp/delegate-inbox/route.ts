/**
 * GET  /api/agent-mcp/delegate-inbox          → { pending } (count of undelivered)
 * GET  /api/agent-mcp/delegate-inbox?drain=1  → { items: [...] } (drain + mark delivered)
 * POST /api/agent-mcp/delegate-inbox          → push one row
 *   body: { headline: string, kind?: string, claudeSessionId?: string }
 *
 * The Hindsight inbox for the EL agent: notifications that arrive when
 * no live EL session is connected get stashed here so the next session
 * can deliver them.
 */
import { NextRequest } from 'next/server';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { drainDelegateInbox, peekDelegateInbox, pushDelegateInbox } from '@/lib/delegate-inbox';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
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
}

export async function POST(req: NextRequest): Promise<Response> {
  const workspaceId = activeWorkspaceId();
  const body = await req.json().catch(() => null) as
    | { headline?: string; kind?: string; claudeSessionId?: string | null }
    | null;
  if (!body?.headline) {
    return Response.json({ error: 'headline required' }, { status: 400 });
  }
  const id = await pushDelegateInbox({
    workspaceId,
    headline: body.headline,
    kind: body.kind,
    claudeSessionId: body.claudeSessionId ?? null,
  });
  return Response.json({ id });
}
