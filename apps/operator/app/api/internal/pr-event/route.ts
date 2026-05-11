/**
 * POST /api/internal/pr-event
 *
 * bash run.sh's branch-isolation onPass=pr handler POSTs here after
 * `gh pr create` returns a URL. Replaces the chokidar mirror that
 * read .harness/prs.json on every fs event.
 *
 * Auth: Authorization: Bearer <harness_token>.
 *
 * Body: { featureId, url, state?, createdAt?, updatedAt? }
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const fp = generated.harness_feature_prsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const BodySchema = z.object({
  featureId: z.string().min(1),
  url: z.string().min(1),
  state: z.string().optional().default('unknown'),
  createdAt: z.number().int().nonnegative().optional(),
  updatedAt: z.number().int().nonnegative().optional(),
});

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
  const { featureId, url, state } = parsed.data;
  const createdAt = parsed.data.createdAt ?? Math.floor(Date.now() / 1000);
  const updatedAt = parsed.data.updatedAt ?? createdAt;

  const ws = activeWorkspaceId();
  await db
    .insert(fp)
    .values({
      workspace_id: ws,
      harness_slug: slug,
      feature_id: featureId,
      pr_url: url,
      pr_state: state,
      opened_ts: createdAt,
      updated_ts: updatedAt,
    })
    .onConflictDoUpdate({
      target: [fp.workspace_id, fp.harness_slug, fp.feature_id],
      set: {
        pr_url: dsql`EXCLUDED.pr_url`,
        pr_state: dsql`EXCLUDED.pr_state`,
        opened_ts: dsql`EXCLUDED.opened_ts`,
        updated_ts: dsql`EXCLUDED.updated_ts`,
      },
    });
  void notifySyncInvalidate('featurePrs.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
