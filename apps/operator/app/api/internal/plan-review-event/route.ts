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
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const pr = generated.harness_plan_reviewInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  content: z.string().min(1),
});

const MAX_BODY = 256 * 1024;

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: ti.harness_slug })
    .from(ti)
    .where(eq(ti.token, token))
    .limit(1);
  if (rows.length === 0) {
    return NextResponse.json({ error: 'invalid bearer' }, { status: 401 });
  }
  const slug = rows[0].harness_slug;

  let raw: unknown;
  try { raw = await req.json(); }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'validation failed', issues: parsed.error.issues },
      { status: 400 },
    );
  }
  let content = parsed.data.content;
  if (Buffer.byteLength(content) > MAX_BODY) {
    content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  const mtimeMs = Date.now();
  const ws = activeWorkspaceId();

  await db
    .insert(pr)
    .values({ harness_slug: slug, content, mtime_ms: mtimeMs, workspace_id: ws })
    .onConflictDoUpdate({
      target: pr.harness_slug,
      set: {
        content: dsql`EXCLUDED.content`,
        mtime_ms: dsql`EXCLUDED.mtime_ms`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessPlanReview.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
