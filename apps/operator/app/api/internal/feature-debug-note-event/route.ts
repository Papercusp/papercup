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
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  featureId?: string;
  content?: string;
  mtimeMs?: number;
}

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

  const featureId = typeof body.featureId === 'string' ? body.featureId : '';
  if (!featureId) return NextResponse.json({ error: 'featureId required' }, { status: 400 });
  const content = typeof body.content === 'string' ? body.content : '';
  const mtimeMs = typeof body.mtimeMs === 'number' ? Math.floor(body.mtimeMs) : Date.now();

  const ws = activeWorkspaceId();
  if (content === '') {
    await sql`
      DELETE FROM harness_shared.harness_feature_debug_notes
       WHERE workspace_id = ${ws} AND harness_slug = ${slug} AND feature_id = ${featureId}
    `;
  } else {
    await sql`
      INSERT INTO harness_shared.harness_feature_debug_notes
        (workspace_id, harness_slug, feature_id, content, mtime_ms)
      VALUES (${ws}, ${slug}, ${featureId}, ${content}, ${mtimeMs})
      ON CONFLICT (workspace_id, harness_slug, feature_id) DO UPDATE
        SET content = EXCLUDED.content, mtime_ms = EXCLUDED.mtime_ms
    `;
  }
  void notifySyncInvalidate('featureDebugNotes.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
