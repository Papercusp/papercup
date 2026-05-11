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
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const fp = generated.harness_feature_prsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  featureId?: string;
  url?: string;
  state?: string;
  createdAt?: number;
  updatedAt?: number;
}

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

  let body: RequestBody;
  try { body = (await req.json()) as RequestBody; }
  catch { return NextResponse.json({ error: 'invalid json' }, { status: 400 }); }

  const featureId = typeof body.featureId === 'string' ? body.featureId : '';
  const url = typeof body.url === 'string' ? body.url : '';
  if (!featureId || !url) {
    return NextResponse.json({ error: 'featureId + url required' }, { status: 400 });
  }
  const state = typeof body.state === 'string' ? body.state : 'unknown';
  const createdAt = typeof body.createdAt === 'number' ? Math.floor(body.createdAt) : Math.floor(Date.now() / 1000);
  const updatedAt = typeof body.updatedAt === 'number' ? Math.floor(body.updatedAt) : createdAt;

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
