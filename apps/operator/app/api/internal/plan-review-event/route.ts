/**
 * POST /api/internal/plan-review-event
 *
 * bash run.sh's plan-review block POSTs the plan-review.md content
 * after the reviewer LLM finishes. Replaces the chokidar mirror.
 *
 * Body: { content: string }
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  content?: string;
}

const MAX_BODY = 256 * 1024;

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { sql } = getOrgPg();
  const rows = await sql<{ harness_slug: string }[]>`
    SELECT harness_slug FROM harness_shared.token_index WHERE token = ${token} LIMIT 1
  `;
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  let content = typeof body.content === 'string' ? body.content : '';
  if (!content) return NextResponse.json({ error: 'content required' }, { status: 400 });
  if (Buffer.byteLength(content) > MAX_BODY) {
    content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  const mtimeMs = Date.now();
  const ws = activeWorkspaceId();

  await sql`
    INSERT INTO harness_shared.harness_plan_review
      (harness_slug, content, mtime_ms, workspace_id)
    VALUES (${slug}, ${content}, ${mtimeMs}, ${ws})
    ON CONFLICT (harness_slug) DO UPDATE
      SET content = EXCLUDED.content,
          mtime_ms = EXCLUDED.mtime_ms,
          workspace_id = EXCLUDED.workspace_id
  `;
  void notifySyncInvalidate('harnessPlanReview.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
