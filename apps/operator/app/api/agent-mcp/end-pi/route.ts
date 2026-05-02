/**
 * POST /api/agent-mcp/end-pi
 *
 * Ends a pi session. Bearer ceases to authenticate; pi_sessions.ended_at
 * is set; token_index row is deleted.
 */

import { NextRequest, NextResponse } from 'next/server';
import { endPiSession } from '@papercusp/agent-mcp/provisioning';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export async function POST(req: NextRequest) {
  const { sessionId } = (await req.json()) as { sessionId: string };
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  }
  await endPiSession(activeWorkspaceId(), sessionId);
  return NextResponse.json({ ok: true });
}
