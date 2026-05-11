/**
 * GET  /api/operator/conversations?limit=N
 *   Returns the workspace's active operator conversation with the most
 *   recent N turns inlined (default 50, max 500; pass `limit=all` for
 *   the full history shape used by snapshot/export). The chat is
 *   workspace-scoped — switching harnesses does NOT change which
 *   conversation surfaces.
 *
 * POST /api/operator/conversations
 *   Force-create a fresh active conversation for the workspace (marks
 *   any existing active row as 'done' first). Used by a future "new
 *   chat" button.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq } from 'drizzle-orm';
import {
  getOrCreateActiveConversation,
  listTurns,
  listTurnsRecent,
} from '@/lib/operator-conversations';
import { ensureOperatorConversationsTable } from '@/lib/ensure-schema';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const oc = generated.operator_conversationsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const limitParam = req.nextUrl.searchParams.get('limit');
  const conv = await getOrCreateActiveConversation();

  // Default to a windowed initial load so a long conversation doesn't
  // hammer the chat sidebar with thousands of turns. Callers that need
  // the full history can pass `limit=all` (back-compat for any callers
  // that still expect the old shape — primarily snapshot/export jobs).
  if (limitParam === 'all') {
    const turns = await listTurns(conv.id);
    return NextResponse.json({ conversation: conv, turns, hasMoreEarlier: false });
  }
  const limit = Math.max(1, Math.min(Number(limitParam) || 50, 500));
  const page = await listTurnsRecent({ conversationId: conv.id, limit });
  return NextResponse.json({
    conversation: conv,
    turns: page.turns,
    hasMoreEarlier: page.hasMoreEarlier,
  });
}

export async function POST(_req: NextRequest): Promise<Response> {
  await ensureOperatorConversationsTable();
  const ws = activeWorkspaceId();
  const { db } = getOrgPg();

  // Close any existing active conversation for this workspace.
  // Workspace-scoped: harness slug is intentionally ignored.
  await db
    .update(oc)
    .set({ status: 'done', ended_at: Date.now() })
    .where(and(eq(oc.workspace_id, ws), eq(oc.status, 'active')));

  const created = await db
    .insert(oc)
    .values({ workspace_id: ws, harness_slug: null, started_at: Date.now() })
    .returning({ id: oc.id });
  const id = created[0].id;
  return NextResponse.json({ conversation: { id }, turns: [] });
}
