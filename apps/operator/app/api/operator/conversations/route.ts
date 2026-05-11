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
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import {
  getOrCreateActiveConversation,
  listTurns,
} from '@/lib/operator-conversations';
import { ensureOperatorConversationsTable } from '@/lib/ensure-schema';
import { activeWorkspaceId } from '@/lib/workspace-registry';

const oc = generated.operator_conversationsInHarness_shared;

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
  const { db } = getOrgPg();

  // Close any existing active conversation in the same scope.
  await db
    .update(oc)
    .set({ status: 'done', ended_at: Date.now() })
    .where(
      and(
        eq(oc.workspace_id, ws),
        dsql`COALESCE(${oc.harness_slug}, '') = ${slug ?? ''}`,
        eq(oc.status, 'active'),
      ),
    );

  const created = await db
    .insert(oc)
    .values({ workspace_id: ws, harness_slug: slug, started_at: Date.now() })
    .returning({ id: oc.id });
  const id = created[0].id;
  return NextResponse.json({ conversation: { id }, turns: [] });
}
