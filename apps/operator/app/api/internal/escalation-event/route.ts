/**
 * POST /api/internal/escalation-event
 *
 * bash run.sh's plan-reviewer rejection path AND bin/supervisor.sh
 * POST escalation/supervisor-notes content here. Replaces the
 * chokidar mirror that re-read both sibling files on every fs event.
 *
 * Body: { escalation?: string|null, supervisorNotes?: string|null,
 *         phase?: 'staging'|'testing'|'production' }
 *   - phase defaults to 'staging' (matches today's bash producers)
 *   - null values mean "this side not changed"; the row UPDATE skips
 *     them via COALESCE so partial POSTs don't clobber the other side
 *
 * Auth: Authorization: Bearer <harness_token>.
 */
import { NextResponse } from 'next/server';
import { getOrgPg, generated } from '@restart/db-org';
import { eq, sql as dsql } from 'drizzle-orm';
import { activeWorkspaceId } from '@/lib/workspace-registry';
import { notifySyncInvalidate } from '@/lib/sync-sse';

const ti = generated.token_indexInHarness_shared;
const he = generated.harness_escalationsInHarness_shared;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RequestBody {
  escalation?: string | null;
  supervisorNotes?: string | null;
  phase?: string;
}

const VALID_PHASES = new Set(['staging', 'testing', 'production']);
const MAX_BODY = 256 * 1024;

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

  const phase = typeof body.phase === 'string' && VALID_PHASES.has(body.phase) ? body.phase : 'staging';
  let escalation: string | null = body.escalation === null ? null
    : (typeof body.escalation === 'string' ? body.escalation : null);
  let supervisorNotes: string | null = body.supervisorNotes === null ? null
    : (typeof body.supervisorNotes === 'string' ? body.supervisorNotes : null);
  if (escalation === null && supervisorNotes === null) {
    return NextResponse.json({ error: 'escalation or supervisorNotes required' }, { status: 400 });
  }
  if (escalation && Buffer.byteLength(escalation) > MAX_BODY) {
    escalation = escalation.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  if (supervisorNotes && Buffer.byteLength(supervisorNotes) > MAX_BODY) {
    supervisorNotes = supervisorNotes.slice(0, MAX_BODY) + '\n...[truncated]\n';
  }
  const mtimeMs = Date.now();
  const ws = activeWorkspaceId();

  // INSERT or partial UPDATE — null values keep the existing column via COALESCE.
  await db
    .insert(he)
    .values({
      harness_slug: slug,
      phase,
      escalation,
      supervisor_notes: supervisorNotes,
      mtime_ms: mtimeMs,
      workspace_id: ws,
    })
    .onConflictDoUpdate({
      target: [he.harness_slug, he.phase],
      set: {
        escalation: dsql`COALESCE(${escalation}, ${he.escalation})`,
        supervisor_notes: dsql`COALESCE(${supervisorNotes}, ${he.supervisor_notes})`,
        mtime_ms: dsql`EXCLUDED.mtime_ms`,
        workspace_id: dsql`EXCLUDED.workspace_id`,
      },
    });
  void notifySyncInvalidate('harnessEscalations.byHarness', { harnessSlug: slug, phase }).catch(() => {});
  return NextResponse.json({ ok: true });
}
