/**
 * POST /api/internal/hook-log-event
 *
 * bash run.sh's run_hook() POSTs the per-hook execution log here.
 * Replaces the chokidar mirror that re-scanned .harness/logs/hooks/ on
 * every fs event and capped at 50 most-recent.
 *
 * Body: { name: string, ts: number, sizeBytes: number, content: string }
 *   - ts is epoch seconds (matches the legacy filename format)
 *   - content is truncated to 256KB by the producer to keep row size bounded
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_CONTENT_BYTES = 280 * 1024; // 256KB cap + slack for the truncation marker
const HOOK_KEEP = 50;

interface RequestBody {
  name?: string;
  ts?: number;
  sizeBytes?: number;
  content?: string;
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

  const name = typeof body.name === 'string' ? body.name : '';
  const tsSec = typeof body.ts === 'number' ? Math.floor(body.ts) : 0;
  if (!name || tsSec <= 0) {
    return NextResponse.json({ error: 'name + ts required' }, { status: 400 });
  }
  const sizeBytes = typeof body.sizeBytes === 'number' ? Math.floor(body.sizeBytes) : 0;
  let content = typeof body.content === 'string' ? body.content : '';
  if (Buffer.byteLength(content) > MAX_CONTENT_BYTES) {
    content = content.slice(0, MAX_CONTENT_BYTES) + '\n...[truncated]\n';
  }
  const logId = `${tsSec}-${name}`;
  const tsMs = tsSec * 1000;

  const ws = activeWorkspaceId();
  await sql`
    INSERT INTO harness_shared.harness_hook_logs
      (harness_slug, log_id, name, ts, size_bytes, content, workspace_id)
    VALUES (${slug}, ${logId}, ${name}, ${tsMs}, ${sizeBytes}, ${content}, ${ws})
    ON CONFLICT (harness_slug, log_id) DO UPDATE
      SET name = EXCLUDED.name,
          ts = EXCLUDED.ts,
          size_bytes = EXCLUDED.size_bytes,
          content = EXCLUDED.content,
          workspace_id = EXCLUDED.workspace_id
  `;
  // Trim to most-recent HOOK_KEEP rows per harness — same cap the
  // chokidar mirror enforced.
  await sql`
    DELETE FROM harness_shared.harness_hook_logs
     WHERE harness_slug = ${slug}
       AND log_id NOT IN (
         SELECT log_id FROM harness_shared.harness_hook_logs
          WHERE harness_slug = ${slug}
          ORDER BY ts DESC
          LIMIT ${HOOK_KEEP}
       )
  `;
  void notifySyncInvalidate('harnessHookLogs.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
