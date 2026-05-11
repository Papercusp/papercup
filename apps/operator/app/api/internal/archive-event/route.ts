/**
 * POST /api/internal/archive-event
 *
 * bash run.sh's archiveOnDone hook POSTs the metadata of each .tar.gz
 * it creates. Replaces the chokidar mirror that re-scanned the archives
 * directory on every fs.watch event.
 *
 * Body: { id: string, sizeBytes: number, ts: number, phase?: 'staging'|'testing'|'production' }
 *   - id is the archive filename (e.g. "1762613000-done.tar.gz")
 *   - phase defaults to 'staging' (matches today's bash producer)
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const ha = generated.harness_archivesInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  id?: string;
  sizeBytes?: number;
  ts?: number;
  phase?: string;
}

const VALID_PHASES = new Set(['staging', 'testing', 'production']);

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

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id || !id.endsWith('.tar.gz')) {
    return NextResponse.json({ error: 'id required (must end in .tar.gz)' }, { status: 400 });
  }
  const sizeBytes = typeof body.sizeBytes === 'number' ? Math.floor(body.sizeBytes) : 0;
  const ts = typeof body.ts === 'number' ? Math.floor(body.ts) : Date.now();
  const phase = typeof body.phase === 'string' && VALID_PHASES.has(body.phase) ? body.phase : 'staging';

  const ws = activeWorkspaceId();
  await db
    .insert(ha)
    .values({
      harness_slug: slug,
      phase,
      id,
      size_bytes: sizeBytes,
      ts,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [ha.harness_slug, ha.phase, ha.id],
      set: {
        size_bytes: dsql`EXCLUDED.size_bytes`,
        ts: dsql`EXCLUDED.ts`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessArchives.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true });
}
