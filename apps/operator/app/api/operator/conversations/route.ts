/**
 * GET  /api/operator/conversations?slug=<slug>
 *   Returns the active conversation for the current workspace + (optional)
 *   harness slug, with all turns inlined. The sidebar calls this on mount
 *   to hydrate from PG instead of sessionStorage.
 *
 * POST /api/operator/conversations  { harnessSlug?: string }
 *   Force-create a fresh active conversation (marks any existing active row
 *   as 'done' first). Used by a future "new chat" button. Not wired into
 *   the sidebar yet — included so step-2 (voice wiring) can use it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import {
  getOrCreateActiveConversation,
  listTurns,
} from '@/lib/operator-conversations';
import { ensureOperatorConversationsTable } from '@/lib/ensure-schema';
import { activeWorkspaceId } from '@/lib/workspace-registry';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(req: NextRequest): Promise<Response> {
  const slug = req.nextUrl.searchParams.get('slug');
  const conv = await getOrCreateActiveConversation(slug ?? null);
  const turns = await listTurns(conv.id);
  return NextResponse.json({ conversation: conv, turns });
}

export async function POST(req: NextRequest): Promise<Response> {
  await ensureOperatorConversationsTable();
  const body = (await req.json().catch(() => ({}))) as {
    harnessSlug?: string | null;
  };
  const slug = body.harnessSlug ?? null;
  const ws = activeWorkspaceId();
  const { sql } = getOrgPg();

  // Close any existing active conversation in the same scope.
  await sql`
    UPDATE harness_shared.operator_conversations
       SET status = 'done', ended_at = ${Date.now()}
     WHERE workspace_id = ${ws}
       AND COALESCE(harness_slug, '') = ${slug ?? ''}
       AND status = 'active'
  `;

  const created = (await sql`
    INSERT INTO harness_shared.operator_conversations
      (workspace_id, harness_slug, started_at)
    VALUES (${ws}, ${slug}, ${Date.now()})
    RETURNING id
  `) as Array<{ id: string }>;
  const id = created[0].id;
  return NextResponse.json({ conversation: { id }, turns: [] });
}
