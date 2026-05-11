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
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hl = generated.harness_hook_logsInHarness_shared;

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

  const { db, sql } = getOrgPg();
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
  await db
    .insert(hl)
    .values({
      harness_slug: slug,
      log_id: logId,
      name,
      ts: tsMs,
      size_bytes: sizeBytes,
      content,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [hl.harness_slug, hl.log_id],
      set: {
        name: dsql`EXCLUDED.name`,
        ts: dsql`EXCLUDED.ts`,
        size_bytes: dsql`EXCLUDED.size_bytes`,
        content: dsql`EXCLUDED.content`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
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
