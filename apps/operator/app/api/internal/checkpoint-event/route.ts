/**
 * POST /api/internal/checkpoint-event
 *
 * bash run.sh's checkpoint emitter (auto-fired post-planner OR
 * CHECKPOINT decision from the orchestrator) POSTs a structured event
 * after writing checkpoint-<name>.md. Replaces the chokidar mirror
 * that re-scanned .harness/ for checkpoint-*.md files.
 *
 * Body: { name: string, content: string }
 *   - name: stable id, e.g. "post-planner" or "unnamed"
 *   - content: full markdown body of the checkpoint file
 *
 * The grant path (`.granted` sibling file → granted=true) is already
 * operator-side in app/api/_hono/harness.ts; this endpoint only
 * handles the CREATE side that bash owns.
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const hc = generated.harness_checkpointsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_CONTENT = 64 * 1024;

const BodySchema = z.object({
  name: z.string().regex(NAME_RE),
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
  const { name } = parsed.data;
  let content = parsed.data.content;
  if (Buffer.byteLength(content) > MAX_CONTENT) {
    content = content.slice(0, MAX_CONTENT) + '\n...[truncated]\n';
  }
  const waitingSinceMs = Date.now();

  const ws = activeWorkspaceId();
  await db
    .insert(hc)
    .values({
      harness_slug: slug,
      name,
      content,
      waiting_since_ms: waitingSinceMs,
      granted: false,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [hc.harness_slug, hc.name],
      set: {
        content: dsql`EXCLUDED.content`,
        waiting_since_ms: dsql`EXCLUDED.waiting_since_ms`,
        granted: dsql`EXCLUDED.granted`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessCheckpoints.byHarness', { harnessSlug: slug }).catch(() => {});
  return NextResponse.json({ ok: true });
}
