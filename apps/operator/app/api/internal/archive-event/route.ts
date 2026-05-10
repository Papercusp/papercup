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
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

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

  const id = typeof body.id === 'string' ? body.id : '';
  if (!id || !id.endsWith('.tar.gz')) {
    return NextResponse.json({ error: 'id required (must end in .tar.gz)' }, { status: 400 });
  }
  const sizeBytes = typeof body.sizeBytes === 'number' ? Math.floor(body.sizeBytes) : 0;
  const ts = typeof body.ts === 'number' ? Math.floor(body.ts) : Date.now();
  const phase = typeof body.phase === 'string' && VALID_PHASES.has(body.phase) ? body.phase : 'staging';

  const ws = activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.harness_archives
      (harness_slug, phase, id, size_bytes, ts, workspace_id)
    VALUES (${slug}, ${phase}, ${id}, ${sizeBytes}, ${ts}, ${ws})
    ON CONFLICT (harness_slug, phase, id) DO UPDATE
      SET size_bytes = EXCLUDED.size_bytes,
          ts = EXCLUDED.ts,
          workspace_id = EXCLUDED.workspace_id
  `;
  void notifySyncInvalidate('harnessArchives.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true });
}
