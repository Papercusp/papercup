/**
 * POST /api/operator/conversations/:id/turns
 *   { role, text, source?, elConvId? } → appends a turn, returns the row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { appendTurn, type TurnRole, type TurnSource } from '@/lib/operator-conversations';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface Body {
  role: TurnRole;
  text: string;
  source?: TurnSource;
  elConvId?: string | null;
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
  });
  void notifySyncInvalidate('operatorTurns.byConversation', { conversationId: id })
    .catch(() => { /* sync push best-effort; PG truth is authoritative */ });
  return NextResponse.json({ turn });
}
