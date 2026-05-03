/**
 * GET /api/user-actions/[slug]
 *
 * Lists long-running user-initiated actions for a harness, newest first.
 * Backs the OperatorActionLog UI panel until the Zero schema gains a
 * user_actions table (then this endpoint becomes a fallback for clients
 * that don't have a Zero subscription).
 *
 * Query params:
 *   limit  — max rows to return (default 50, max 500)
 *   since  — only rows with started_at >= since (ms epoch)
 */
import { NextRequest, NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { ensureUserActionsTable } from '../../../../lib/ensure-schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await ctx.params;
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(slug)) {
    return NextResponse.json({ error: 'invalid slug' }, { status: 400 });
  }
  const url = new URL(req.url);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? '50') || 50));
  const since = Number(url.searchParams.get('since') ?? '0') || 0;

  await ensureUserActionsTable();
  const { sql } = getOrgPg();
  const rows = (await sql`
    SELECT id, harness_slug, kind, status, summary, detail_url,
           error_text, invocation_id, started_at, finished_at, actor
    FROM harness_shared.user_actions
    WHERE harness_slug = ${slug}
      AND started_at >= ${since}
    ORDER BY started_at DESC
    LIMIT ${limit}
  `) as Array<{
    id: string;
    harness_slug: string;
    kind: string;
    status: string;
    summary: string | null;
    detail_url: string | null;
    error_text: string | null;
    invocation_id: string | null;
    started_at: string;
    finished_at: string | null;
    actor: string | null;
  }>;

  return NextResponse.json({
    actions: rows.map((r) => ({
      id: Number(r.id),
      kind: r.kind,
      status: r.status,
      summary: r.summary,
      detailUrl: r.detail_url,
      errorText: r.error_text,
      invocationId: r.invocation_id,
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
      actor: r.actor,
    })),
  });
}
