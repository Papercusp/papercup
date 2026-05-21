/**
 * POST /api/internal/plan-review-event — plan-review.md persist.
 * Ported from app/api/internal/plan-review-event/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';
import { defineRoute } from '../../define-route';

const ti = generated.tokenIndexInHarnessShared;
const pr = generated.harnessPlanReviewInHarnessShared;

const BodySchema = z.object({ content: z.string().min(1) });
const MAX_BODY = 256 * 1024;

export default defineRoute({
  method: 'POST',
  path: '/internal/plan-review-event',
  auth: {},
  async handler(req) {
    const authHeader = req.headers.get('authorization') ?? '';
    const m = authHeader.match(/^Bearer\s+(\S+)$/i);
    if (!m) return Response.json({ error: 'missing bearer' }, { status: 401 });
    const token = m[1];
    const { db } = getOrgPg();
    const rows = await db.select({ harness_slug: ti.harnessSlug }).from(ti).where(eq(ti.token, token)).limit(1);
    if (rows.length === 0) return Response.json({ error: 'invalid bearer' }, { status: 401 });
    const slug = rows[0].harness_slug;

    let raw: unknown;
    try { raw = await req.json(); } catch { return Response.json({ error: 'invalid json' }, { status: 400 }); }
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return Response.json({ error: 'validation failed', issues: parsed.error.issues }, { status: 400 });
    }
    let content = parsed.data.content;
    if (Buffer.byteLength(content) > MAX_BODY) {
      content = content.slice(0, MAX_BODY) + '\n...[truncated]\n';
    }
    const mtimeMs = Date.now();
    const ws = activeWorkspaceId();
    await db.insert(pr).values({ harnessSlug: slug, content, mtimeMs, workspaceId: ws }).onConflictDoUpdate({
      target: pr.harnessSlug,
      set: {
        content: dsql`EXCLUDED.content`, mtimeMs: dsql`EXCLUDED.mtime_ms`,
        workspaceId: dsql`EXCLUDED.workspace_id`,
      },
    });
    void notifySyncInvalidate('harnessPlanReview.byHarness', { harnessSlug: slug }).catch(() => {});
    return Response.json({ ok: true });
  },
});
