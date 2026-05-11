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
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { and, desc, eq, notInArray, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hl = generated.harness_hook_logsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_CONTENT_BYTES = 280 * 1024; // 256KB cap + slack for the truncation marker
const HOOK_KEEP = 50;

const BodySchema = z.object({
  name: z.string().min(1),
  ts: z.number().int().positive(),
  sizeBytes: z.number().int().nonnegative().optional().default(0),
  content: z.string().optional().default(''),
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
  const { name, sizeBytes } = parsed.data;
  const tsSec = Math.floor(parsed.data.ts);
  let content = parsed.data.content;
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
  const keepers = await db
    .select({ log_id: hl.log_id })
    .from(hl)
    .where(eq(hl.harness_slug, slug))
    .orderBy(desc(hl.ts))
    .limit(HOOK_KEEP);
  if (keepers.length > 0) {
    await db
      .delete(hl)
      .where(and(eq(hl.harness_slug, slug), notInArray(hl.log_id, keepers.map((k) => k.log_id))));
  }
  void notifySyncInvalidate('harnessHookLogs.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
