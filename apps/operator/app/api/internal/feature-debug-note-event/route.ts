/**
 * POST /api/internal/feature-debug-note-event
 *
 * bash run.sh's debug-note hook POSTs the note content here. Replaces
 * the chokidar mirror that read .harness/debug/<featureId>.md on every
 * fs event.
 *
 * Auth: Authorization: Bearer <harness_token>.
 *
 * Body: { featureId, content, mtimeMs? }
 *   - content === '' → DELETE the row (file was unlinked)
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.tokenIndexInHarnessShared;
const fdn = generated.harnessFeatureDebugNotesInHarnessShared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  featureId: z.string().min(1),
  content: z.string().optional().default(''),
  mtimeMs: z.number().int().nonnegative().optional().default(() => Date.now()),
});

export async function POST(req: Request): Promise<Response> {
  const authHeader = req.headers.get('authorization') ?? '';
  const m = authHeader.match(/^Bearer\s+(\S+)$/i);
  if (!m) return NextResponse.json({ error: 'missing bearer' }, { status: 401 });
  const token = m[1];

  const { db } = getOrgPg();
  const rows = await db
    .select({ harness_slug: ti.harnessSlug })
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
  const { featureId, content, mtimeMs } = parsed.data;

  const ws = activeWorkspaceId();
  if (content === '') {
    await db
      .delete(fdn)
      .where(and(eq(fdn.workspaceId, ws), eq(fdn.harnessSlug, slug), eq(fdn.featureId, featureId)));
  } else {
    await db
      .insert(fdn)
      .values({ workspaceId: ws, harnessSlug: slug, featureId: featureId, content, mtimeMs: mtimeMs })
      .onConflictDoUpdate({
        target: [fdn.workspaceId, fdn.harnessSlug, fdn.featureId],
        set: { content: dsql`EXCLUDED.content`, mtimeMs: dsql`EXCLUDED.mtime_ms` },
      });
  }
  void notifySyncInvalidate('featureDebugNotes.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
