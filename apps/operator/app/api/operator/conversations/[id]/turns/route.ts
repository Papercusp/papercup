/**
 * GET  /api/operator/conversations/:id/turns?beforeSeq=N&limit=M
 *   Returns the newest M turns whose seq < beforeSeq, in seq ASC order
 *   (oldest first within the page). Used by the chat sidebar's infinite
 *   scroll to fetch older history when the user scrolls past the top.
 *   `limit` defaults to 50, capped at 500.
 *
 * POST /api/operator/conversations/:id/turns
 *   { role, text, source?, elConvId? } → appends a turn, returns the row.
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  appendTurn,
  listTurnsRecent,
  type TurnRole,
  type TurnSource,
} from '@/lib/operator-conversations';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
  /**
   * Optional tool-call array. Persisted into operator_turns.tools jsonb
   * (migration 015). Used by chat:ask_choice to record the question +
   * options + later (via PATCH .../turn-answer) the user's pick.
   */
  tools?: Array<{ name: string; input?: unknown; answered?: unknown }>;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const beforeRaw = req.nextUrl.searchParams.get('beforeSeq');
  const limitRaw = req.nextUrl.searchParams.get('limit');
  const beforeSeq = beforeRaw === null || beforeRaw === '' ? null : Number(beforeRaw);
  if (beforeSeq !== null && (!Number.isFinite(beforeSeq) || beforeSeq < 0)) {
    return NextResponse.json({ error: 'beforeSeq must be a non-negative integer' }, { status: 400 });
  }
  const limit = Math.max(1, Math.min(Number(limitRaw) || 50, 500));
  const page = await listTurnsRecent({ conversationId: id, beforeSeq, limit });
  return NextResponse.json(page);
}

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const body = (await req.json()) as Body;
  if (!body || typeof body.text !== 'string' || !body.role) {
    return NextResponse.json({ error: 'role and text required' }, { status: 400 });
  }
  const turn = await appendTurn({
    conversationId: id,
    role: body.role,
    text: body.text,
    source: body.source,
    elConvId: body.elConvId ?? null,
    tools: Array.isArray(body.tools) && body.tools.length > 0 ? (body.tools as any) : null,
  });
  void notifySyncInvalidate('operatorTurns.byConversation', { conversationId: id })
    .catch(() => { /* sync push best-effort; PG truth is authoritative */ });
  return NextResponse.json({ turn });
}
